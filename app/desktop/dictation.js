// Local speech-to-text with whisper.cpp. Audio never leaves the PC.
// Setup: put whisper-cli.exe and a model (e.g. ggml-base.en.bin) in
// <userData>/whisper/, or point KF_WHISPER_BIN / KF_WHISPER_MODEL at them.
const { app } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function locate() {
  const dir = path.join(app.getPath('userData'), 'whisper');
  const bin = process.env.KF_WHISPER_BIN || path.join(dir, process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
  let model = process.env.KF_WHISPER_MODEL;
  if (!model && fs.existsSync(dir)) {
    const found = fs.readdirSync(dir).find((f) => /^ggml-.*\.bin$/.test(f));
    if (found) model = path.join(dir, found);
  }
  return { bin, model, dir };
}

function transcribe(wavBuffer) {
  const { bin, model, dir } = locate();
  if (!fs.existsSync(bin) || !model || !fs.existsSync(model)) {
    return Promise.reject(new Error(`Dictation isn't set up yet. Add whisper-cli and a ggml model to ${dir}`));
  }
  const file = path.join(os.tmpdir(), `kf-dictation-${Date.now()}.wav`);
  fs.writeFileSync(file, wavBuffer);
  return new Promise((resolve, reject) => {
    execFile(bin, ['-m', model, '-f', file, '-nt', '-np', '-l', 'auto'], { timeout: 60000, windowsHide: true }, (err, stdout) => {
      fs.rm(file, { force: true }, () => {});
      if (err) return reject(new Error(`Transcription failed: ${err.message}`));
      resolve(stdout.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim());
    });
  });
}

module.exports = { transcribe };
