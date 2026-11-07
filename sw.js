/* Swift English timetable: offline application shell, v1.
   The timetable data itself is stored by index.html in localStorage.
   Do not cache or intercept the Google Apps Script API. */
const SHELL_CACHE = 'swift-timetable-shell-2026-11';
const SHELL_FILES = [
  './index.html',
  './manifest.json',
  './favicon.png',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(key => key.startsWith('swift-timetable-shell-') && key !== SHELL_CACHE)
        .map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();
            event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.put('./index.html', copy)));
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match('./index.html');
          return cached || Response.error();
        })
    );
    return;
  }

  // Icons and the app manifest are safe to serve from the installed shell.
  event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
});
