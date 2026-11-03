// KenjiFlow Staff for Windows. Connects to the client's always-on engine
// (KF_ENGINE_URL). With no URL set, it runs a local engine inside the app,
// which is handy for demos and single-PC installs.
const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('path');
const { transcribe } = require('./dictation');

// KF_USER_DATA moves the app's data folder (handy for testing with throwaway data).
if (process.env.KF_USER_DATA) app.setPath('userData', process.env.KF_USER_DATA);

// One copy at a time: a second launch would fight the first over the local engine's
// port and database, so it just brings the open window forward instead.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

let engineUrl = process.env.KF_ENGINE_URL || '';
let localEngine = null;

async function ensureEngine() {
  if (engineUrl) return engineUrl;
  const { start } = require('../engine/server');
  localEngine = await start({ port: Number(process.env.KF_LOCAL_PORT) || 4310, dataDir: path.join(app.getPath('userData'), 'engine') });
  engineUrl = localEngine.url;
  return engineUrl;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    title: 'KenjiFlow Staff',
    backgroundColor: '#FFFFFF',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      additionalArguments: [`--kf-engine=${engineUrl}`],
    },
  });
  // Links open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) e.preventDefault(); });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  // Only the microphone (dictation) and notifications are ever granted.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(['media', 'notifications'].includes(permission)));
  ipcMain.handle('dictation:transcribe', (_e, wav) => transcribe(Buffer.from(wav)));
  await ensureEngine();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', async () => {
  if (localEngine) await localEngine.close().catch(() => {});
  app.quit();
});
