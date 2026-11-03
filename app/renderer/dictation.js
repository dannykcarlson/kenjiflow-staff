// Voice dictation for the chat box. In the desktop app, audio is recorded here,
// turned into a 16 kHz WAV and transcribed on this PC by whisper.cpp (via the
// preload). In a plain browser it falls back to the browser's speech recognition.

export function dictationAvailable() {
  return !!(window.kf && window.kf.transcribe) || !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function createDictation({ onText, onLevel, onState }) {
  if (window.kf && window.kf.transcribe) return whisperDictation({ onText, onLevel, onState });
  return browserDictation({ onText, onState });
}

function whisperDictation({ onText, onLevel, onState }) {
  let stream; let ctx; let node; let chunks = []; let rate = 48000; let cancelled = false;

  async function start() {
    cancelled = false;
    chunks = [];
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    ctx = new AudioContext();
    rate = ctx.sampleRate;
    const src = ctx.createMediaStreamSource(stream);
    node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(data));
      let peak = 0;
      for (let i = 0; i < data.length; i += 32) peak = Math.max(peak, Math.abs(data[i]));
      onLevel?.(Math.min(1, peak * 3));
    };
    src.connect(node);
    node.connect(ctx.destination);
    onState?.('recording');
  }

  async function stop() {
    teardown();
    if (cancelled) return;
    onState?.('transcribing');
    try {
      const wav = encodeWav(downsample(flatten(chunks), rate, 16000), 16000);
      const text = await window.kf.transcribe(wav);
      if (text) onText(text.trim());
      onState?.('idle');
    } catch (err) {
      onState?.('error', err.message || String(err));
    }
  }

  function cancel() { cancelled = true; teardown(); onState?.('idle'); }

  function teardown() {
    node?.disconnect();
    stream?.getTracks().forEach((t) => t.stop());
    ctx?.close();
    node = null; stream = null; ctx = null;
  }

  return { start, stop, cancel };
}

function browserDictation({ onText, onState }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec;
  let finalText = '';
  return {
    async start() {
      if (!SR) throw new Error('Dictation is not available here');
      finalText = '';
      rec = new SR();
      rec.continuous = true;
      rec.interimResults = true;
      rec.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
          else interim += e.results[i][0].transcript;
        }
        onText((finalText + interim).trim(), { live: true });
      };
      rec.onerror = (e) => onState?.('error', e.error);
      rec.onend = () => onState?.('idle');
      rec.start();
      onState?.('recording');
    },
    stop() { rec?.stop(); },
    cancel() { rec?.abort(); onState?.('idle'); },
  };
}

function flatten(parts) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function downsample(data, from, to) {
  if (from === to) return data;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(data.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(data.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += data[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

export function encodeWav(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}
