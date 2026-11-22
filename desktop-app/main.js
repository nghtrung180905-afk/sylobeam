'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  desktopCapturer,
  session,
  shell,
  dialog,
  Tray,
  Menu,
  nativeImage
} = require('electron');
const path = require('path');
const fs = require('fs');
const { createDesktopCore } = require('./core');

// Hardware GPU acceleration & zero background throttling for smooth 60Hz screen sharing
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('enable-features', 'WebRTCHardwareVideoEncoding,WebRTCHardwareVideoDecoding');

const WEB_ROOT = path.resolve(__dirname, '..');
const ICON_PATH = path.join(WEB_ROOT, 'assets', 'swiftdrop.ico');

let mainWindow = null;
let tray = null;
let isQuitting = false;

const core = createDesktopCore({
  webRoot: WEB_ROOT,
  desktopDir: __dirname,
  runtime: 'electron',
  downloadsDir: app.getPath('downloads'),
  onEmergencyStop: () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('rc:emergency-stop');
    }
  }
});

function loadAppIcon() {
  if (fs.existsSync(ICON_PATH)) {
    try {
      const img = nativeImage.createFromPath(ICON_PATH);
      if (img && !img.isEmpty()) return img;
    } catch {}
  }
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4] = 0x81;
    buf[i * 4 + 1] = 0xb9;
    buf[i * 4 + 2] = 0x10;
    buf[i * 4 + 3] = 0xff;
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function createTray() {
  tray = new Tray(loadAppIcon());
  tray.setToolTip('SyloBeam Desktop — P2P File & Remote Control');

  const menu = Menu.buildFromTemplate([
    {
      label: 'Mở SyloBeam Desktop',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    {
      label: 'Thu gọn xuống khay hệ thống',
      click: () => {
        if (mainWindow) mainWindow.hide();
      }
    },
    {
      label: 'Ngắt khẩn cấp điều khiển (Ctrl+Alt+Esc)',
      click: () => core.triggerEmergencyStop()
    },
    { type: 'separator' },
    {
      label: 'Thoát hoàn toàn',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(menu);
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

async function createMainWindow() {
  const port = await core.startEmbeddedServer({ openInBrowserMode: false });

  session.defaultSession.removeAllListeners('will-download');
  session.defaultSession.on('will-download', (_event, item) => {
    try {
      const { resolveUniqueDownloadPath } = require('./core');
      item.setSavePath(resolveUniqueDownloadPath(core.downloadsDir || app.getPath('downloads'), item.getFilename()));
    } catch {}
  });

  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      callback(sources && sources.length > 0 ? { video: sources[0] } : {});
    } catch {
      callback({});
    }
  });

  mainWindow = new BrowserWindow({
    width: 1140,
    height: 780,
    minWidth: 420,
    minHeight: 620,
    backgroundColor: '#030305',
    icon: loadAppIcon(),
    title: 'SyloBeam Desktop — P2P File & Remote Control',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });

  await mainWindow.loadURL(`http://127.0.0.1:${port}/?desktopToken=${encodeURIComponent(core.sessionToken)}`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

ipcMain.handle('rc:set-auth', (_event, enabled) => core.setRemoteControlAuth(enabled));
ipcMain.on('rc:input', (_event, cmd) => core.dispatchWin32Input(cmd));
ipcMain.handle('rc:screen-info', () => core.screenInfo);
ipcMain.handle('rc:hardware-info', () => core.hardwareInfo);
ipcMain.handle('rc:session-token', () => core.sessionToken);
ipcMain.handle('rc:screen-config', (_event, cfg) => {
  core.ensureScreenAgent(cfg || {});
  return { ok: true };
});
ipcMain.handle('rc:screen-stop', () => {
  core.stopScreenAgent();
  return { ok: true };
});
ipcMain.handle('rc:get-sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'] });
  return sources.map((s) => ({ id: s.id, name: s.name }));
});
ipcMain.handle('rc:save-file', async (_event, payload) => {
  if (!payload || !payload.data) return { ok: false, error: 'Dữ liệu file trống' };
  try {
    return await core.saveReceivedFile(payload.fileName, payload.data);
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'Không thể lưu file' };
  }
});
ipcMain.handle('rc:open-downloads', async (_event, filePath) => {
  try {
    if (filePath && fs.existsSync(filePath)) {
      shell.showItemInFolder(filePath);
    } else {
      await shell.openPath(core.downloadsDir || app.getPath('downloads'));
    }
    return { ok: true };
  } catch {
    return { ok: false };
  }
});
ipcMain.handle('rc:get-download-dir', () => core.getDownloadDirInfo());
ipcMain.handle('rc:set-download-dir', (_event, dirPath) => core.setDownloadDir(dirPath || ''));
ipcMain.handle('rc:choose-download-dir', async () => {
  try {
    const res = await dialog.showOpenDialog(mainWindow || undefined, {
      title: 'Chọn thư mục lưu file nhận qua SyloBeam',
      defaultPath: core.downloadsDir || app.getPath('downloads'),
      properties: ['openDirectory', 'createDirectory']
    });
    if (!res || res.canceled || !res.filePaths || res.filePaths.length === 0) {
      return { ok: true, downloadsDir: core.downloadsDir, cancelled: true };
    }
    const updated = core.setDownloadDir(res.filePaths[0]);
    return { ...updated, cancelled: false };
  } catch {
    return core.chooseDownloadDirNative();
  }
});

app.whenReady().then(async () => {
  try {
    core.startInputAgent();
    core.detectHardwareCapabilities().catch(() => {});
    try {
      createTray();
    } catch {}
    try {
      globalShortcut.register('CommandOrControl+Alt+Escape', () => core.triggerEmergencyStop());
    } catch {}
    await createMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  } catch (err) {
    console.error('FATAL_MAIN_INIT:', err);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    } else if (mainWindow) {
      mainWindow.show();
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  globalShortcut.unregisterAll();
  core.shutdown();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || isQuitting) {
    app.quit();
  }
});
