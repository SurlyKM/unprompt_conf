/* Offline support.
 *
 * On the first visit (online) this stores the whole app. After that every file is served
 * from the phone instantly, and refreshed quietly in the background when there is a connection.
 * That means a schedule update shows up on the visit after the one that downloaded it.
 * Change CACHE below if you ever need to throw away everything stored on phones.
 */
const CACHE = 'upsf26-v2';
const CORE = [
  './', 'index.html', 'app.css', 'app.js', 'favicon.svg', 'data/agenda.json',
  'fonts/bricolage-grotesque-latin-wght-normal.woff2',
  'fonts/atkinson-hyperlegible-latin-400-normal.woff2',
  'fonts/atkinson-hyperlegible-latin-700-normal.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Stale-while-revalidate: answer from the cache if we can, and update the cache from the network.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(req, { ignoreSearch: true });   // ignoreSearch so ?now= still hits
    const network = fetch(req).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    if (cached) { e.waitUntil(network); return cached; }
    return (await network) || new Response('Offline and not cached yet.', { status: 503 });
  }));
});
