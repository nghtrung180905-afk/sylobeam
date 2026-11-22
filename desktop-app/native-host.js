'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { createDesktopCore } = require('./core');

const WEB_ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const HEADLESS_CHECK = args.includes('--check');

function findHardwareBrowserExecutable() {
  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

  const candidates = [
    { name: 'Microsoft Edge', path: path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    { name: 'Microsoft Edge', path: path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
    { name: 'Google Chrome', path: path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { name: 'Google Chrome', path: path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { name: 'Google Chrome', path: path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') },
    { name: 'Brave Browser', path: path.join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') }
  ];

  for (const item of candidates) {
    if (item.path && fs.existsSync(item.path)) {
      return item;
    }
  }
  return null;
}

async function main() {
  let browserChild = null;
  const core = createDesktopCore({
    webRoot: WEB_ROOT,
    desktopDir: __dirname,
    runtime: 'native-host',
    onQuit: () => {
      core.shutdown();
      process.exit(0);
    }
  });

  const cleanExit = () => {
    core.shutdown();
    if (browserChild && !browserChild.killed) {
      try {
        browserChild.kill();
      } catch {}
    }
    process.exit(0);
  };

  process.on('SIGINT', cleanExit);
  process.on('SIGTERM', cleanExit);

  core.startInputAgent();
  const [hw, port] = await Promise.all([
    core.detectHardwareCapabilities(),
    core.startEmbeddedServer({ openInBrowserMode: true })
  ]);

  const appUrl = `http://127.0.0.1:${port}/?desktopToken=${encodeURIComponent(core.sessionToken)}`;

  if (HEADLESS_CHECK) {
    console.log(JSON.stringify({ ok: true, port, hardware: hw, browser: findHardwareBrowserExecutable() }));
    cleanExit();
    return;
  }

  const browser = findHardwareBrowserExecutable();
  if (browser) {
    const profileDir = path.join(os.homedir(), 'AppData', 'Local', 'SwiftDrop', 'BrowserProfile');
    fs.mkdirSync(profileDir, { recursive: true });

    const launchArgs = [
      `--app=${appUrl}`,
      `--user-data-dir=${profileDir}`,
      '--window-size=1140,780',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-mode',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--enable-features=WebRTCHardwareVideoEncoding,WebRTCHardwareVideoDecoding'
    ];

    const launchedAt = Date.now();
    browserChild = spawn(browser.path, launchArgs, {
      stdio: 'ignore',
      detached: false,
      windowsHide: false
    });

    browserChild.on('exit', () => {
      // Edge/Chrome singleton handoff exits the launcher stub in <2s while the real App window opens!
      // Only exit immediately if the browser stayed open >5s AND no live SSE client is still attached.
      const livedMs = Date.now() - launchedAt;
      if (livedMs > 5000 && core.activeClientCount === 0) {
        core.shutdown();
        process.exit(0);
      }
      // Otherwise stay alive until the real App window connects & later closes (handled by SSE idle shutdown in core.js),
      // with a 60s safety timeout if the browser never connected at all.
      setTimeout(() => {
        if (!core.hadDesktopClient && core.activeClientCount === 0) {
          core.shutdown();
          process.exit(0);
        }
      }, 60000);
    });
  } else {
    // Universal fallback: open default system browser if neither Edge nor Chrome exists
    spawn('cmd.exe', ['/c', 'start', '', appUrl], { stdio: 'ignore', windowsHide: true });
    console.log(`SwiftDrop Desktop Native Host running at http://127.0.0.1:${port}`);
  }
}

main().catch((err) => {
  console.error('NATIVE_HOST_ERR:', err);
  process.exit(1);
});
