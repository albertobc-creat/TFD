const CACHE = 'tfd-v6-0';
const LOCAL = [
  './', './index.html', './manifest.json', './icon-192.png', './icon-180.png',
  './overview.html', './airport.html', './airport.js', './ofp.js', './pdftext.js',
  './vendor/leaflet.js', './vendor/leaflet.css', './vendor/pdf.min.js', './vendor/pdf.worker.min.js', './data/airports.json'
];
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-180.png',
  'https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@300;400;600;700;800&family=Barlow:wght@300;400;500&family=Share+Tech+Mono&display=swap'
];

// Install: cache all core assets
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      // Cache all local app shell files immediately
      // one by one: a missing file must not abort the whole install
      LOCAL.forEach(function(u) { cache.add(u).catch(function() {}); });
      // Cache fonts best-effort (needs internet on first load)
      fetch('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@300;400;600;700;800&family=Barlow:wght@300;400;500&family=Share+Tech+Mono&display=swap')
        .then(function(r) { cache.put('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@300;400;600;700;800&family=Barlow:wght@300;400;500&family=Share+Tech+Mono&display=swap', r.clone()); })
        .catch(function() {});
      return Promise.resolve();
    })
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) { return k !== CACHE; }).map(function(k) { return caches.delete(k); }));
    })
  );
  self.clients.claim();
});

// Fetch: cache-first for app shell, network-first for external
self.addEventListener('fetch', function(e) {
  const url = e.request.url;

  // For the app shell (index.html and sw.js): cache first
  if (url.includes('index.html') || url.endsWith('/') || url.includes('sw.js')) {
    e.respondWith(
      caches.match(e.request).then(function(cached) {
        const networkFetch = fetch(e.request).then(function(r) {
          caches.open(CACHE).then(function(c) { c.put(e.request, r.clone()); });
          return r;
        }).catch(function() { return cached; });
        return cached || networkFetch;
      })
    );
    return;
  }

  // For Google Fonts: cache first, network fallback
  if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com')) {
    e.respondWith(
      caches.match(e.request).then(function(cached) {
        if (cached) return cached;
        return fetch(e.request).then(function(r) {
          caches.open(CACHE).then(function(c) { c.put(e.request, r.clone()); });
          return r;
        }).catch(function() {
          return new Response('', { status: 408 });
        });
      })
    );
    return;
  }

  // Same-origin app files (briefing pages, scripts, vendor libs, airport table): cached copy first, refreshed in the background
  if (e.request.method === 'GET' && url.indexOf(self.location.origin) === 0) {
    e.respondWith(
      caches.match(e.request).then(function(cached) {
        const networkFetch = fetch(e.request).then(function(r) {
          if (r && r.ok) { const copy = r.clone(); caches.open(CACHE).then(function(c) { c.put(e.request, copy); }); }
          return r;
        }).catch(function() { return cached; });
        return cached || networkFetch;
      })
    );
    return;
  }

  // All other requests (external links, Drive PDFs): network only, no caching
  // These require internet and that is expected
});
