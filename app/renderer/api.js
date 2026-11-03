// Talks to the engine: REST for reads and actions, a websocket for live updates.
// In the desktop app the preload tells us the engine URL; in the browser it's this origin.
const BASE = (window.kf && window.kf.engineUrl) || location.origin;
const TOKEN_KEY = 'kf.token';

let token = null;
try { token = localStorage.getItem(TOKEN_KEY); } catch { /* storage blocked */ }

export function setToken(t) {
  token = t;
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}
export const hasToken = () => !!token;

export async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function uploadFile(file, taskId) {
  const res = await fetch(`${BASE}/api/files${taskId ? `?task=${encodeURIComponent(taskId)}` : ''}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data;
}

// Downloads through fetch so the session token never goes in a URL.
export async function downloadFile(file) {
  const res = await fetch(`${BASE}/api/files/${file.id}/download`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error('Download failed');
  saveBlob(await res.blob(), file.name);
}

export async function fileBlob(file) {
  const res = await fetch(`${BASE}/api/files/${file.id}/download`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error('Could not load file');
  return res.blob();
}

export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function connectLive(onEvent, onStatus) {
  let ws;
  let retry = 500;
  let stopped = false;
  const open = () => {
    ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`);
    ws.onopen = () => { retry = 500; onStatus?.(true); };
    ws.onmessage = (e) => { try { onEvent(JSON.parse(e.data)); } catch { /* ignore bad frames */ } };
    ws.onclose = () => {
      onStatus?.(false);
      if (!stopped) setTimeout(open, retry = Math.min(retry * 2, 10000));
    };
  };
  open();
  return () => { stopped = true; ws?.close(); };
}
