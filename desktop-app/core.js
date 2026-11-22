'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const PUBLIC_SHARE_URL = 'https://sylobeam.pages.dev';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.zip': 'application/zip',
  '.exe': 'application/vnd.microsoft.portable-executable'
};

const ALLOWED_INPUT_ACTIONS = new Set([
  'mouse_move',
  'mouse_abs',
  'mouse_click',
  'mouse_down',
  'mouse_up',
  'mouse_scroll',
  'key_press',
  'key_combo',
  'key_text',
  'system_action'
]);

function getDownloadsDir() {
  const userProfile = process.env.USERPROFILE || process.env.HOME || osHomeFallback();
  return path.join(userProfile, 'Downloads');
}

function osHomeFallback() {
  try {
    return require('os').homedir();
  } catch {
    return process.cwd();
  }
}

function sanitizeDesktopFilename(rawName) {
  const base = String(rawName || 'swiftdrop_file')
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return base.slice(0, 180) || 'swiftdrop_file';
}

function resolveUniqueDownloadPath(downloadsDir, rawName) {
  fs.mkdirSync(downloadsDir, { recursive: true });
  const safeName = sanitizeDesktopFilename(rawName);
  const parsed = path.parse(safeName);
  let candidate = path.join(downloadsDir, safeName);
  let counter = 1;
  while (fs.existsSync(candidate) && counter < 9999) {
    candidate = path.join(downloadsDir, `${parsed.name} (${counter})${parsed.ext}`);
    counter += 1;
  }
  return candidate;
}

function createDesktopCore({
  webRoot,
  desktopDir,
  runtime = 'native-host',
  downloadsDir = getDownloadsDir(),
  onEmergencyStop = null,
  onQuit = null
} = {}) {
  const sessionToken = crypto.randomBytes(24).toString('hex');

  let inputAgent = null;
  let screenAgent = null;
  let isQuitting = false;
  let remoteControlAuthorized = true;
  let screenInfo = { width: 1920, height: 1080, refreshRate: 60 };
  const defaultDownloadsDir = downloadsDir || getDownloadsDir();
  const settingsFile = path.join(
    process.env.LOCALAPPDATA || osHomeFallback(),
    'SwiftDrop',
    'settings.json'
  );

  function loadDesktopSettings() {
    try {
      if (!fs.existsSync(settingsFile)) return {};
      const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveDesktopSettings(nextObj) {
    try {
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
      fs.writeFileSync(settingsFile, JSON.stringify(nextObj || {}, null, 2), 'utf8');
    } catch {}
  }

  let activeDownloadsDir = (() => {
    const saved = loadDesktopSettings();
    const cand = saved && typeof saved.downloadsDir === 'string' ? saved.downloadsDir.trim() : '';
    if (cand) {
      try {
        const resolved = path.resolve(cand);
        if (fs.existsSync(resolved) || fs.existsSync(path.dirname(resolved))) {
          return resolved;
        }
      } catch {}
    }
    return defaultDownloadsDir;
  })();

  let hardwareInfo = {
    os: process.platform,
    arch: process.arch,
    runtime,
    gpus: [],
    primaryGpu: 'Đang nhận diện GPU...',
    hardwareEncoder: 'Auto Multi-Hardware',
    display: screenInfo,
    downloadsDir: activeDownloadsDir
  };

  let localServer = null;
  let serverPort = 0;

  // Screen stream subscribers & latest binary frame buffer
  const streamClients = new Set();
  let screenReadBuffer = Buffer.alloc(0);
  let currentStreamCfg = { width: 1600, height: 900, fps: 60, quality: 78 };

  // Emergency pollers/SSE clients for Chrome/Edge App Mode
  const eventClients = new Set();
  let hadDesktopClient = false;
  let idleShutdownTimer = null;

  function scheduleIdleShutdownIfNoClients() {
    if (!hadDesktopClient || typeof onQuit !== 'function') return;
    if (idleShutdownTimer) clearTimeout(idleShutdownTimer);
    idleShutdownTimer = setTimeout(() => {
      if (eventClients.size === 0 && !isQuitting) {
        onQuit();
      }
    }, 4500);
  }

  function broadcastDesktopEvent(eventObj) {
    const line = `data: ${JSON.stringify(eventObj)}\n\n`;
    for (const res of eventClients) {
      try {
        res.write(line);
      } catch {
        eventClients.delete(res);
      }
    }
  }

  function triggerEmergencyStop() {
    remoteControlAuthorized = false;
    stopScreenAgent();
    if (typeof onEmergencyStop === 'function') {
      try {
        onEmergencyStop();
      } catch {}
    }
    broadcastDesktopEvent({ type: 'emergency-stop' });
  }

  // --------------------------------------------------------------------------
  // 1. MULTI-GPU & DISPLAY HARDWARE DETECTOR (NVIDIA / Intel / AMD / Fallback)
  // --------------------------------------------------------------------------
  function detectHardwareCapabilities() {
    if (process.platform !== 'win32') return Promise.resolve(hardwareInfo);

    const psCmd = [
      "$gpus = @(Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue | Where-Object { $_.DriverDesc } | Select-Object DriverDesc,DriverVersion);",
      "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class DpiScr { [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); [DllImport(\"user32.dll\")] public static extern int GetSystemMetrics(int n); }' -ErrorAction SilentlyContinue;",
      "[DpiScr]::SetProcessDPIAware() | Out-Null;",
      "@{ gpus=$gpus; w=[DpiScr]::GetSystemMetrics(0); h=[DpiScr]::GetSystemMetrics(1) } | ConvertTo-Json -Compress -Depth 3"
    ].join(' ');

    return new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd],
        { windowsHide: true, timeout: 5000 },
        (err, stdout) => {
          if (!err && stdout && stdout.trim()) {
            try {
              const parsed = JSON.parse(stdout.trim());
              const rawList = parsed && parsed.gpus ? (Array.isArray(parsed.gpus) ? parsed.gpus : [parsed.gpus]) : [];
              const gpus = rawList
                .filter((g) => g && g.DriverDesc)
                .map((g) => {
                  const name = String(g.DriverDesc).trim();
                  let vendor = 'Other';
                  let encoder = 'Universal Multi-Thread';
                  if (/nvidia|geforce|rtx|gtx|quadro/i.test(name)) {
                    vendor = 'NVIDIA';
                    encoder = 'NVIDIA NVENC';
                  } else if (/intel|uhd|iris|arc|hd graphics/i.test(name)) {
                    vendor = 'Intel';
                    encoder = 'Intel QuickSync';
                  } else if (/amd|radeon|ryzen|vega/i.test(name)) {
                    vendor = 'AMD';
                    encoder = 'AMD AMF';
                  }
                  return {
                    name,
                    vendor,
                    encoder,
                    driverVersion: g.DriverVersion || ''
                  };
                });

              if (Number(parsed.w) > 0 && Number(parsed.h) > 0) {
                screenInfo = {
                  width: Number(parsed.w),
                  height: Number(parsed.h),
                  refreshRate: screenInfo.refreshRate || 60
                };
              }

              const rank = { NVIDIA: 3, AMD: 2, Intel: 1, Other: 0 };
              const sorted = [...gpus].sort((a, b) => (rank[b.vendor] || 0) - (rank[a.vendor] || 0));
              const best = sorted[0];

              hardwareInfo = {
                ...hardwareInfo,
                gpus,
                primaryGpu: best ? best.name : 'Windows Display Adapter',
                hardwareEncoder: best ? best.encoder : 'Universal Fallback',
                display: screenInfo
              };
            } catch {
              // Keep safe default hardwareInfo
            }
          }
          resolve(hardwareInfo);
        }
      );
    });
  }

  // --------------------------------------------------------------------------
  // 2. RESIDENT WIN32 INPUT AGENT (< 0.08ms PURE C# LOOP)
  // --------------------------------------------------------------------------
  function startInputAgent() {
    if (process.platform !== 'win32') return;
    if (inputAgent && !inputAgent.killed) return;

    const agentScript = path.join(desktopDir, 'input-agent.ps1');
    if (!fs.existsSync(agentScript)) return;

    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', agentScript],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );

    inputAgent = ps;

    ps.stdout.on('data', (chunk) => {
      const lines = chunk.toString('utf8').split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg && msg.width && msg.height) {
            screenInfo = {
              width: Number(msg.width),
              height: Number(msg.height),
              refreshRate: screenInfo.refreshRate || 60
            };
            hardwareInfo.display = screenInfo;
          }
        } catch {
          // Ignore non-JSON output
        }
      }
    });

    ps.on('exit', () => {
      if (inputAgent === ps) inputAgent = null;
      if (!isQuitting) {
        setTimeout(startInputAgent, 1500);
      }
    });
  }

  function stopInputAgent() {
    if (inputAgent) {
      try {
        inputAgent.stdin.end();
        inputAgent.kill();
      } catch {}
      inputAgent = null;
    }
  }

  function dispatchWin32Input(cmd) {
    if (!remoteControlAuthorized) return false;
    if (!cmd || typeof cmd !== 'object') return false;
    if (!ALLOWED_INPUT_ACTIONS.has(cmd.action)) return false;
    if (!inputAgent || !inputAgent.stdin || inputAgent.killed) {
      startInputAgent();
      return false;
    }
    try {
      if (cmd.action === 'mouse_abs' && !cmd.click && !cmd.down && !cmd.up) {
        const nx = Number(cmd.nx);
        const ny = Number(cmd.ny);
        if (Number.isFinite(nx) && Number.isFinite(ny)) {
          inputAgent.stdin.write(`A|${nx.toFixed(5)}|${ny.toFixed(5)}\n`);
          return true;
        }
      } else if (cmd.action === 'mouse_move') {
        const dx = Math.round(Number(cmd.dx) || 0);
        const dy = Math.round(Number(cmd.dy) || 0);
        if (dx !== 0 || dy !== 0) {
          inputAgent.stdin.write(`M|${dx}|${dy}\n`);
        }
        return true;
      } else if (cmd.action === 'mouse_scroll') {
        const dy = Math.round(Number(cmd.dy) || 0);
        const dx = Math.round(Number(cmd.dx) || 0);
        if (dy !== 0 || dx !== 0) {
          inputAgent.stdin.write(`S|${dy}|${dx}\n`);
        }
        return true;
      }
      inputAgent.stdin.write(JSON.stringify(cmd) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // 3. UNATTENDED NATIVE C# SCREEN STREAMER (ZERO BLACK-SCREEN ON MULTI-GPU)
  // --------------------------------------------------------------------------
  function ensureScreenAgent(cfg = currentStreamCfg) {
    if (process.platform !== 'win32') return;
    currentStreamCfg = {
      width: Math.max(320, Math.min(3840, Number(cfg.width) || 1600)),
      height: Math.max(240, Math.min(2160, Number(cfg.height) || 900)),
      fps: Math.max(10, Math.min(60, Number(cfg.fps) || 60)),
      quality: Math.max(40, Math.min(95, Number(cfg.quality) || 78))
    };

    if (screenAgent && !screenAgent.killed) {
      try {
        screenAgent.stdin.write(
          `CFG|${currentStreamCfg.width}|${currentStreamCfg.height}|${currentStreamCfg.fps}|${currentStreamCfg.quality}\n`
        );
      } catch {}
      return;
    }

    const nativeCaptureExe = path.join(desktopDir, 'SwiftDropCapture.exe');
    const hasNativeCapture = fs.existsSync(nativeCaptureExe);
    const agentScript = path.join(desktopDir, 'screen-agent.ps1');
    if (!hasNativeCapture && !fs.existsSync(agentScript)) return;

    screenReadBuffer = Buffer.alloc(0);
    const spawnCmd = hasNativeCapture ? nativeCaptureExe : 'powershell.exe';
    const spawnArgs = hasNativeCapture
      ? [
          '--width',
          String(currentStreamCfg.width),
          '--height',
          String(currentStreamCfg.height),
          '--fps',
          String(currentStreamCfg.fps),
          '--quality',
          String(currentStreamCfg.quality)
        ]
      : [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          agentScript,
          '-Width',
          String(currentStreamCfg.width),
          '-Height',
          String(currentStreamCfg.height),
          '-Fps',
          String(currentStreamCfg.fps),
          '-Quality',
          String(currentStreamCfg.quality)
        ];

    const ps = spawn(spawnCmd, spawnArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    screenAgent = ps;

    ps.stderr.on('data', (chunk) => {
      if (screenAgent !== ps) return;
      const lines = chunk.toString('utf8').split(/\r?\n/);
      for (const line of lines) {
        if (line.startsWith('CAPTURE_ENGINE=')) {
          hardwareInfo.captureEngine = line.slice('CAPTURE_ENGINE='.length).trim();
        }
      }
    });

    ps.stdout.on('data', (chunk) => {
      if (screenAgent !== ps) return;
      screenReadBuffer = Buffer.concat([screenReadBuffer, chunk]);
      while (screenReadBuffer.length >= 4) {
        const frameLen = screenReadBuffer.readUInt32LE(0);
        if (frameLen <= 0 || frameLen > 12 * 1024 * 1024) {
          // Resync on corrupt framing
          screenReadBuffer = Buffer.alloc(0);
          break;
        }
        if (screenReadBuffer.length < 4 + frameLen) break;

        const packet = screenReadBuffer.subarray(0, 4 + frameLen);
        screenReadBuffer = screenReadBuffer.subarray(4 + frameLen);

        for (const clientRes of streamClients) {
          try {
            // Backpressure guard: drop frame for slow readers instead of queuing lag
            if (clientRes.writableNeedDrain) continue;
            clientRes.write(packet);
          } catch {
            streamClients.delete(clientRes);
          }
        }
      }
    });

    ps.on('exit', () => {
      if (screenAgent === ps) {
        screenAgent = null;
        screenReadBuffer = Buffer.alloc(0);
        if (!isQuitting && streamClients.size > 0) {
          setTimeout(() => {
            if (streamClients.size > 0) ensureScreenAgent(currentStreamCfg);
          }, 500);
        }
      }
    });
  }

  function stopScreenAgent() {
    for (const res of streamClients) {
      try {
        res.end();
      } catch {}
    }
    streamClients.clear();
    if (screenAgent) {
      const p = screenAgent;
      screenAgent = null;
      try {
        p.stdin.write('QUIT\n');
        p.stdin.end();
      } catch {}
      setTimeout(() => {
        try {
          if (!p.killed) p.kill();
        } catch {}
      }, 150);
    }
    screenReadBuffer = Buffer.alloc(0);
  }

  // --------------------------------------------------------------------------
  // 4. NATIVE FILE SAVE, CUSTOM FOLDER & EXPLORER HELPERS
  // --------------------------------------------------------------------------
  function getDownloadDirInfo() {
    return {
      ok: true,
      downloadsDir: activeDownloadsDir,
      defaultDir: defaultDownloadsDir
    };
  }

  function setDownloadDir(rawPath) {
    const cleaned = typeof rawPath === 'string' ? rawPath.trim() : '';
    if (!cleaned) {
      activeDownloadsDir = defaultDownloadsDir;
      hardwareInfo.downloadsDir = activeDownloadsDir;
      saveDesktopSettings({ downloadsDir: '' });
      return { ok: true, downloadsDir: activeDownloadsDir, defaultDir: defaultDownloadsDir };
    }
    try {
      const resolved = path.resolve(cleaned);
      fs.mkdirSync(resolved, { recursive: true });
      activeDownloadsDir = resolved;
      hardwareInfo.downloadsDir = activeDownloadsDir;
      saveDesktopSettings({ downloadsDir: resolved });
      return { ok: true, downloadsDir: activeDownloadsDir, defaultDir: defaultDownloadsDir };
    } catch (err) {
      return {
        ok: false,
        downloadsDir: activeDownloadsDir,
        error: (err && err.message) || 'Đường dẫn thư mục không hợp lệ'
      };
    }
  }

  function chooseDownloadDirNative() {
    if (process.platform !== 'win32') {
      return Promise.resolve({ ok: false, downloadsDir: activeDownloadsDir, cancelled: true });
    }
    const initialDirB64 = Buffer.from(activeDownloadsDir, 'utf8').toString('base64');
    const psScript = [
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "Add-Type -AssemblyName System.Windows.Forms",
      "Add-Type -AssemblyName System.Drawing",
      "$initDir = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + initialDirB64 + "'))",
      "$owner = New-Object System.Windows.Forms.Form",
      "$owner.TopMost = $true",
      "$owner.StartPosition = 'Manual'",
      "$owner.Location = New-Object System.Drawing.Point(-32000, -32000)",
      "$owner.Size = New-Object System.Drawing.Size(1, 1)",
      "$owner.ShowInTaskbar = $false",
      "$dlg = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dlg.Description = 'Chon thu muc luu file nhan qua SyloBeam'",
      "$dlg.ShowNewFolderButton = $true",
      "if (Test-Path $initDir) { $dlg.SelectedPath = $initDir }",
      "$owner.Show() | Out-Null",
      "$owner.Activate()",
      "$res = $dlg.ShowDialog($owner)",
      "$owner.Close(); $owner.Dispose()",
      "if ($res -eq [System.Windows.Forms.DialogResult]::OK -and $dlg.SelectedPath) { Write-Output $dlg.SelectedPath }"
    ].join("\r\n");
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');

    return new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-EncodedCommand', encoded],
        { windowsHide: true, timeout: 120000 },
        (err, stdout) => {
          const picked = !err && stdout ? String(stdout).trim() : '';
          if (!picked) {
            resolve({ ok: true, downloadsDir: activeDownloadsDir, cancelled: true });
            return;
          }
          const updated = setDownloadDir(picked);
          resolve({ ...updated, cancelled: false });
        }
      );
    });
  }

  async function saveReceivedFile(fileName, data) {
    if (!data) {
      return { ok: false, error: 'Dữ liệu file trống' };
    }
    const savePath = resolveUniqueDownloadPath(activeDownloadsDir, fileName || 'swiftdrop_file');
    const buf = Buffer.isBuffer(data)
      ? data
      : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
    await fs.promises.writeFile(savePath, buf);
    return { ok: true, savedPath: savePath, fileName: path.basename(savePath) };
  }

  function openDownloadsFolder(filePath = '') {
    return new Promise((resolve) => {
      if (process.platform !== 'win32') {
        resolve({ ok: false });
        return;
      }
      const target = filePath && fs.existsSync(filePath) ? filePath : activeDownloadsDir;
      const args = filePath && fs.existsSync(filePath) ? [`/select,${target}`] : [target];
      try {
        spawn('explorer.exe', args, { detached: true, stdio: 'ignore' }).unref();
        resolve({ ok: true });
      } catch {
        resolve({ ok: false });
      }
    });
  }

  function setRemoteControlAuth(enabled) {
    remoteControlAuthorized = Boolean(enabled);
    if (!remoteControlAuthorized) {
      stopScreenAgent();
    }
    return { authorized: remoteControlAuthorized };
  }

  // --------------------------------------------------------------------------
  // 5. EMBEDDED LOOPBACK SERVER + AUTHENTICATED DESKTOP BRIDGE API
  // --------------------------------------------------------------------------
  function isValidLoopbackOrigin(req) {
    const host = (req.headers.host || '').toLowerCase();
    const validHost =
      host === `127.0.0.1:${serverPort}` ||
      host === `localhost:${serverPort}`;
    if (!validHost) return false;

    const origin = (req.headers.origin || '').toLowerCase();
    if (origin && origin !== `http://127.0.0.1:${serverPort}` && origin !== `http://localhost:${serverPort}`) {
      return false;
    }
    return true;
  }

  function hasValidToken(req, urlObj) {
    const headerToken = req.headers['x-swiftdrop-token'];
    const queryToken = urlObj.searchParams.get('token');
    return headerToken === sessionToken || queryToken === sessionToken;
  }

  function readRequestBody(req, limitBytes = 256 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      req.on('data', (c) => {
        total += c.length;
        if (total > limitBytes) {
          reject(new Error('Payload too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  function sendJson(res, status, obj) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(obj));
  }

  function startEmbeddedServer({ openInBrowserMode = false } = {}) {
    if (localServer && serverPort) return Promise.resolve(serverPort);

    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        const urlObj = new URL(req.url || '/', `http://127.0.0.1:${serverPort || 80}`);
        const reqPath = decodeURIComponent(urlObj.pathname);

        // Public local metadata endpoint (never exposes secrets)
        if (reqPath === '/api/host-info' || reqPath === '/host-info.json') {
          sendJson(res, 200, {
            lanIp: '127.0.0.1',
            port: server.address().port,
            lanUrl: `http://127.0.0.1:${server.address().port}`,
            publicUrl: PUBLIC_SHARE_URL,
            isDesktopHost: true,
            hardware: hardwareInfo
          });
          return;
        }

        // Token-authenticated Hardware Info
        if (reqPath === '/api/hardware-info') {
          if (!isValidLoopbackOrigin(req) || !hasValidToken(req, urlObj)) {
            sendJson(res, 403, { ok: false, error: 'Unauthorized' });
            return;
          }
          sendJson(res, 200, hardwareInfo);
          return;
        }

        // Token-authenticated SSE stream for Emergency Kill Switch & Host events
        if (reqPath === '/api/desktop-events') {
          if (!isValidLoopbackOrigin(req) || !hasValidToken(req, urlObj)) {
            sendJson(res, 403, { ok: false, error: 'Unauthorized' });
            return;
          }
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-store',
            Connection: 'keep-alive'
          });
          res.write(`data: ${JSON.stringify({ type: 'connected', hardware: hardwareInfo })}\n\n`);
          hadDesktopClient = true;
          if (idleShutdownTimer) {
            clearTimeout(idleShutdownTimer);
            idleShutdownTimer = null;
          }
          eventClients.add(res);
          req.on('close', () => {
            eventClients.delete(res);
            if (openInBrowserMode && eventClients.size === 0) {
              scheduleIdleShutdownIfNoClients();
            }
          });
          return;
        }

        // Token-authenticated Live Native Binary Screen Frame Stream (4-byte len + JPEG)
        if (reqPath === '/api/screen-raw') {
          if (!isValidLoopbackOrigin(req) || !hasValidToken(req, urlObj)) {
            sendJson(res, 403, { ok: false, error: 'Unauthorized' });
            return;
          }
          if (req.socket && typeof req.socket.setNoDelay === 'function') {
            req.socket.setNoDelay(true);
          }
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Cache-Control': 'no-store, no-cache',
            'X-Content-Type-Options': 'nosniff'
          });
          streamClients.add(res);
          ensureScreenAgent({
            width: urlObj.searchParams.get('w') || 1600,
            height: urlObj.searchParams.get('h') || 900,
            fps: urlObj.searchParams.get('fps') || 60,
            quality: urlObj.searchParams.get('q') || 78
          });
          req.on('close', () => {
            streamClients.delete(res);
            if (streamClients.size === 0) {
              setTimeout(() => {
                if (streamClients.size === 0) stopScreenAgent();
              }, 800);
            }
          });
          return;
        }

        // Token-authenticated Control / File Save RPC
        if (reqPath.startsWith('/api/desktop-rpc/') && req.method === 'POST') {
          if (!isValidLoopbackOrigin(req) || !hasValidToken(req, urlObj)) {
            sendJson(res, 403, { ok: false, error: 'Unauthorized' });
            return;
          }
          const action = reqPath.slice('/api/desktop-rpc/'.length);

          try {
            if (action === 'save-file') {
              const rawName = decodeURIComponent(req.headers['x-file-name'] || 'swiftdrop_file');
              const buf = await readRequestBody(req);
              const result = await saveReceivedFile(rawName, buf);
              sendJson(res, result.ok ? 200 : 400, result);
              return;
            }

            const bodyBuf = await readRequestBody(req, 1024 * 1024);
            const payload = bodyBuf.length ? JSON.parse(bodyBuf.toString('utf8')) : {};

            if (action === 'set-auth') {
              sendJson(res, 200, setRemoteControlAuth(payload.enabled));
              return;
            }
            if (action === 'input') {
              dispatchWin32Input(payload);
              sendJson(res, 200, { ok: true });
              return;
            }
            if (action === 'screen-config') {
              if (screenAgent || streamClients.size > 0) {
                ensureScreenAgent(payload);
              }
              sendJson(res, 200, { ok: true });
              return;
            }
            if (action === 'screen-stop') {
              stopScreenAgent();
              sendJson(res, 200, { ok: true });
              return;
            }
            if (action === 'open-downloads') {
              const r = await openDownloadsFolder(payload.filePath || '');
              sendJson(res, 200, r);
              return;
            }
            if (action === 'get-download-dir') {
              sendJson(res, 200, getDownloadDirInfo());
              return;
            }
            if (action === 'set-download-dir') {
              const r = setDownloadDir(payload.downloadsDir || '');
              sendJson(res, r.ok ? 200 : 400, r);
              return;
            }
            if (action === 'choose-download-dir') {
              const r = await chooseDownloadDirNative();
              sendJson(res, 200, r);
              return;
            }
            if (action === 'quit' && openInBrowserMode) {
              sendJson(res, 200, { ok: true });
              if (typeof onQuit === 'function') setTimeout(onQuit, 120);
              return;
            }
            sendJson(res, 404, { ok: false, error: 'Unknown RPC' });
          } catch (err) {
            sendJson(res, 500, { ok: false, error: (err && err.message) || 'RPC Error' });
          }
          return;
        }

        // Static web root files (serve web assets cleanly)
        const rel = (reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '')).replace(/\//g, path.sep);
        const fullPath = path.resolve(webRoot, rel);
        if (!fullPath.startsWith(path.resolve(webRoot))) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }

        fs.readFile(fullPath, (err, data) => {
          if (err) {
            res.writeHead(404);
            res.end('Not Found');
            return;
          }
          const ext = path.extname(fullPath).toLowerCase();
          res.writeHead(200, {
            'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
            'Cache-Control': 'no-cache'
          });
          res.end(data);
        });
      });

      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        localServer = server;
        serverPort = server.address().port;
        resolve(serverPort);
      });
    });
  }

  function shutdown() {
    isQuitting = true;
    remoteControlAuthorized = false;
    stopScreenAgent();
    stopInputAgent();
    for (const res of eventClients) {
      try {
        res.end();
      } catch {}
    }
    eventClients.clear();
    if (localServer) {
      try {
        localServer.close();
      } catch {}
      localServer = null;
    }
  }

  return {
    get sessionToken() {
      return sessionToken;
    },
    get serverPort() {
      return serverPort;
    },
    get screenInfo() {
      return screenInfo;
    },
    get hardwareInfo() {
      return hardwareInfo;
    },
    get downloadsDir() {
      return activeDownloadsDir;
    },
    get activeClientCount() {
      return eventClients.size;
    },
    get hadDesktopClient() {
      return hadDesktopClient;
    },
    detectHardwareCapabilities,
    startInputAgent,
    stopInputAgent,
    dispatchWin32Input,
    ensureScreenAgent,
    stopScreenAgent,
    setRemoteControlAuth,
    triggerEmergencyStop,
    getDownloadDirInfo,
    setDownloadDir,
    chooseDownloadDirNative,
    saveReceivedFile,
    openDownloadsFolder,
    startEmbeddedServer,
    shutdown
  };
}

module.exports = {
  createDesktopCore,
  getDownloadsDir,
  sanitizeDesktopFilename,
  resolveUniqueDownloadPath
};
