const { contextBridge, ipcRenderer } = require('electron');

const arg = process.argv.find((a) => a.startsWith('--kf-engine='));

contextBridge.exposeInMainWorld('kf', {
  engineUrl: arg ? arg.slice('--kf-engine='.length) : '',
  // 16 kHz mono WAV (ArrayBuffer) in, text out. Runs whisper.cpp on this PC.
  transcribe: (wav) => ipcRenderer.invoke('dictation:transcribe', wav),
  // Which company server the app uses; setServer checks it, saves it and restarts the app.
  server: () => ipcRenderer.invoke('config:server'),
  setServer: (url) => ipcRenderer.invoke('config:setServer', url),
});
