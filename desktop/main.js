/**
 * Gitu Desktop — main process.
 *
 * Responsibilities:
 *  - Attach to a running Gitu backend (default http://127.0.0.1:3000) or spawn
 *    `node dist/index.js` from the repo root when none is reachable.
 *  - Show the existing Gitu web UI in a native window (no UI duplication).
 *  - Tray icon: show/hide, open in browser, restart/stop the owned backend,
 *    launch-at-login toggle, quit.
 *  - Native notifications when Gitu finishes a reply while the window is
 *    hidden or unfocused (DOM observer in preload.js -> IPC -> Notification).
 *  - Close button hides to tray; the app keeps running until "Quit".
 *
 * Environment overrides:
 *   GITU_DESKTOP_URL            Full URL to connect to (remote servers work).
 *   GITU_DESKTOP_PORT           Port to probe/spawn on (default 3000).
 *   GITU_DESKTOP_AUTOSTART=0    Never spawn the backend; only attach.
 */

'use strict';

const {
  app, BrowserWindow, Tray, Menu, Notification, shell, dialog, nativeImage, ipcMain
} = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const zlib = require('zlib');
const { spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const BACKEND_ENTRY = path.join(REPO_ROOT, 'dist', 'index.js');
const BACKEND_LOG = path.join(REPO_ROOT, 'logs', 'desktop-backend.log');

const IS_SMOKE = process.argv.includes('--smoke');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const config = {
  url: String(process.env.GITU_DESKTOP_URL || '').trim(),
  port: Number(process.env.GITU_DESKTOP_PORT) || 3000,
  autostart: !/^(0|false|no)$/i.test(process.env.GITU_DESKTOP_AUTOSTART || '')
};

if (!config.url) config.url = `http://127.0.0.1:${config.port}`;

const isLocalUrl = (() => {
  try {
    const host = new URL(config.url).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
})();

// Only spawn a local backend when we are actually connecting to a local one.
if (!isLocalUrl) config.autostart = false;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let mainWindow = null;
let tray = null;
let backend = null;       // child process we spawned
let backendOwned = false; // true when *we* spawned it (quit -> kill; else leave alone)
let quitting = false;
let waitingForBackend = false;

// ---------------------------------------------------------------------------
// Minimal PNG encoder (no binary assets in the repo). Draws a rounded purple
// tile with a white diamond — matches the Gitu web UI accent colors.
// ---------------------------------------------------------------------------

function encodePng(width, height, rgba) {
  const crcTable = (() => {
    const t = new Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
    return Buffer.concat([len, typeBuf, data, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function makeIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const radius = size / 2 - 0.5;
  const diamondHalf = Math.max(1, size * 0.16);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = x - cx;
      const dy = y - cy;
      // Rounded-square mask: corner cut by circle of radius r.
      const corner = Math.max(Math.abs(dx) - (radius - radius * 0.32), Math.abs(dy) - (radius - radius * 0.32), 0);
      if (corner * corner * 2 > radius * radius * 0.25 * 2) {
        buf[i + 3] = 0;
        continue;
      }
      // Purple gradient (#6d5efc -> #a855f7 -> #ec4899, vertical).
      const t = y / (size - 1);
      let R = Math.round(109 + t * 34);
      let G = Math.round(94 - t * 5);
      let B = Math.round(252 - t * 64);
      // White diamond.
      if (Math.abs(dx) + Math.abs(dy) <= diamondHalf) {
        R = 244; G = 247; B = 252;
      }
      buf[i] = R; buf[i + 1] = G; buf[i + 2] = B; buf[i + 3] = 255;
    }
  }
  return nativeImage.createFromBuffer(encodePng(size, size, buf));
}

// ---------------------------------------------------------------------------
// Backend lifecycle
// ---------------------------------------------------------------------------

function probeHealth(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve(false); }
    const req = http.get({ hostname: u.hostname, port: u.port, path: '/', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true); // any HTTP response means a server is listening
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnBackend() {
  if (backend) return;
  if (!fs.existsSync(BACKEND_ENTRY)) {
    console.error(`[desktop] Backend entry not found: ${BACKEND_ENTRY}`);
    return;
  }
  try { fs.mkdirSync(path.dirname(BACKEND_LOG), { recursive: true }); } catch { /* ignore */ }
  const logFd = fs.openSync(BACKEND_LOG, 'a');
  backend = spawn(process.execPath, [BACKEND_ENTRY], {
    cwd: REPO_ROOT,
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'production' },
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    detached: process.platform !== 'win32'
  });
  backendOwned = true;
  backend.on('exit', (code, signal) => {
    const owned = backendOwned;
    backend = null;
    backendOwned = false;
    try { fs.closeSync(logFd); } catch { /* ignore */ }
    if (quitting) return;
    console.error(`[desktop] Backend exited unexpectedly (code=${code}, signal=${signal})`);
    if (owned && !waitingForBackend) {
      dialog.showMessageBox({
        type: 'warning',
        title: 'Gitu backend stopped',
        message: 'The Gitu backend process exited unexpectedly.',
        detail: `It exited with code ${code ?? signal ?? 'unknown'}. Check the log for details.\n\n${BACKEND_LOG}`,
        buttons: ['Restart backend', 'Open log', 'Close']
      }).then(({ response }) => {
        if (response === 0) restartBackend();
        else if (response === 1) shell.openPath(BACKEND_LOG);
      }).catch(() => {});
    }
  });
  console.log(`[desktop] Spawned backend (pid ${backend.pid}) -> ${BACKEND_LOG}`);
}

function killBackendTree(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch { /* ignore */ }
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* ignore */ } }
  }
}

function stopOwnedBackend() {
  if (backend && backendOwned) killBackendTree(backend);
}

async function restartBackend() {
  stopOwnedBackend();
  if (backend) {
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        if (!backend) { clearInterval(timer); resolve(); }
      }, 200);
      setTimeout(() => { clearInterval(timer); resolve(); }, 8000);
    });
  }
  spawnBackend();
  await waitForBackend(60000);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(config.url).catch(() => {});
  }
}

async function waitForBackend(timeoutMs = 90000) {
  waitingForBackend = true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeHealth(config.url)) { waitingForBackend = false; return true; }
    await sleep(1000);
  }
  waitingForBackend = false;
  return false;
}

// Returns true when the backend is reachable. Spawns it when allowed.
async function ensureBackend() {
  if (await probeHealth(config.url)) return true;
  if (!config.autostart) return false;
  spawnBackend();
  return waitForBackend();
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function sendSplash(channel, text) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, text);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: '#0a0b10',
    title: 'Gitu',
    autoHideMenuBar: true,
    icon: makeIcon(256),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  });

  if (process.platform === 'win32' || process.platform === 'linux') {
    mainWindow.setIcon(makeIcon(256));
  }

  // Close hides to tray; the app keeps running in the background.
  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.on('page-title-updated', (e) => e.preventDefault());
  mainWindow.once('ready-to-show', () => {
    if (IS_SMOKE) {
      console.log('[smoke] window ready');
      setTimeout(() => { console.log('[smoke] OK'); app.quit(); }, 2500);
    } else {
      mainWindow.show();
    }
  });

  // Ctrl/Cmd+Q quits, Ctrl+R reloads, Ctrl+Shift+I opens devtools.
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    const mod = process.platform === 'darwin' ? input.meta : input.control;
    if (mod && input.key.toLowerCase() === 'q') { quitApp(); }
    else if (mod && input.key.toLowerCase() === 'r' && !input.shift) { mainWindow.webContents.reload(); }
    else if (mod && input.shift && input.key.toLowerCase() === 'i') { mainWindow.webContents.toggleDevTools(); }
  });

  mainWindow.loadFile(path.join(__dirname, 'splash.html')).catch(() => {});
  return mainWindow;
}

async function loadBackendIntoWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const ok = await ensureBackend();
  if (ok) {
    sendSplash('splash:status', 'Backend is up — loading Gitu');
    await mainWindow.loadURL(config.url).catch(() => {});
  } else {
    const hint = config.autostart
      ? `I tried to start it from ${BACKEND_ENTRY} but it never came up.\nCheck ${BACKEND_LOG} for errors.`
      : `Auto-start is disabled or this is a remote URL.\nStart the backend yourself (node dist/index.js) or fix GITU_DESKTOP_URL.`;
    sendSplash('splash:error', `Could not reach the Gitu server at ${config.url}.\n\n${hint}`);
    if (IS_SMOKE) {
      console.error('[smoke] FAILED: backend unreachable');
      app.exit(1);
    }
  }
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    loadBackendIntoWindow();
    return;
  }
  mainWindow.show();
  mainWindow.focus();
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

function createTray() {
  try {
    tray = new Tray(makeIcon(process.platform === 'darwin' ? 18 : 32));
  } catch (e) {
    console.error('[desktop] Tray unavailable:', e && e.message);
    return;
  }
  tray.setToolTip('Gitu — AI assistant');
  const menu = Menu.buildFromTemplate([
    { label: 'Open Gitu', click: showWindow },
    { label: 'Open in browser', click: () => shell.openExternal(config.url) },
    { type: 'separator' },
    {
      label: 'Restart backend',
      enabled: backendOwned || config.autostart,
      click: () => restartBackend()
    },
    { label: 'Open backend log', click: () => shell.openPath(BACKEND_LOG) },
    {
      label: 'Launch at login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked })
    },
    { type: 'separator' },
    { label: 'Quit Gitu', click: quitApp }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', showWindow); // Windows/Linux left-click toggles
}

// ---------------------------------------------------------------------------
// Notifications (triggered by preload DOM observer)
// ---------------------------------------------------------------------------

ipcMain.on('gitu:assistant-done', (_event, text) => {
  if (quitting || !Notification.isSupported()) return;
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused() && mainWindow.isVisible()) return;
  const body = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!body) return;
  const n = new Notification({
    title: 'Gitu replied',
    body,
    icon: makeIcon(64),
    silent: false
  });
  n.on('click', showWindow);
  n.show();
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function quitApp() {
  quitting = true;
  stopOwnedBackend();
  app.quit();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.on('window-all-closed', () => { /* keep running in tray */ });
  app.on('before-quit', () => { quitting = true; stopOwnedBackend(); });

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.gitu.desktop'); // Windows notification identity
    createWindow();
    await loadBackendIntoWindow();
    if (!IS_SMOKE) createTray();
  });
}
