// ReelForge Remote service worker: notifications only. Nothing is cached here (the relay serves
// every file no-cache, and the app needs the Mac anyway). The Mac encrypts each notification for
// this browser, so the push service in between can't read it.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // not JSON: show the generic title
  }
  const url = typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/#/projects';
  event.waitUntil(
    self.registration.showNotification(typeof data.title === 'string' ? data.title : 'ReelForge', {
      body: typeof data.body === 'string' ? data.body : '',
      tag: typeof data.tag === 'string' ? data.tag : undefined,
      icon: '/icon-192.png',
      badge: '/icon-64.png',
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? '/#/projects';
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const client = open.find((c) => new URL(c.url).origin === self.location.origin);
      if (client) {
        await client.focus();
        client.postMessage({ open: url });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
