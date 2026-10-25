// Offline support: the app itself is cached so it opens with no signal. Videos are stored by
// the app in IndexedDB, and streams/archive requests always go to the network.
const VERSION = '202610250001';
const ASSETS = ["./","archive-core.js","config.js","db.js","effects.js","fonts/VT323-Regular.ttf","guide.js","icons/icon-180.png","icons/icon-192.png","icons/icon-512.png","index.html","manage.js","manifest.webmanifest","meta.js","phone-lib.js","phone.css","profiles.js","schedule.js","style.css","tv.js","update.js"];
const CACHE = 'retrotv-' + VERSION;

self.addEventListener('install', (e) => {
  // 'reload' skips the browser's own cache, so a new version never picks up files from the old one.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((a) => new Request(a, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('retrotv-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // A Retro TV PC's own API and videos (when the app is opened from the PC) go straight to it.
  if (/\/(api|media)\//.test(url.pathname)) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request))
  );
});
