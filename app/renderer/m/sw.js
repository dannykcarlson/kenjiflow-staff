// Service worker for the phone page: shows push notifications and opens the page when tapped.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(data.title || 'KenjiFlow Staff', {
    body: data.body || '',
    tag: data.tag,
    renotify: !!data.tag,
    icon: '/assets/kenjiflow-mark-color.svg',
    data: { url: data.url || '/m/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data && e.notification.data.url || '/m/', self.location.origin).href;
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const page = open.find((c) => c.url.startsWith(`${self.location.origin}/m/`));
    if (page) { await page.focus(); return page.navigate(url); }
    return self.clients.openWindow(url);
  })());
});
