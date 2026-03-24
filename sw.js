const CACHE_NAME = 'offlinegdz-v12';
const ASSETS = [
    './',
    './index.html',
    './css/app.css',
    './js/db.js',
    './js/parser.js',
    './js/app.js',
    './manifest.json',
    './data/biology-gdz-import.json',
    './data/chemistry-8-gabrielyan-euroki.json',
    './data/geography-euroki-import.json',
    './data/geometry-reshak-import.json'
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);

    // Don't cache external image requests — serve network-first
    if (url.origin !== location.origin) {
        e.respondWith(
            fetch(e.request).catch(() => new Response('', { status: 404 }))
        );
        return;
    }

    // Solution media images: cache on demand for offline
    if (url.pathname.includes('/solution-media/')) {
        e.respondWith(
            caches.match(e.request).then(cached => {
                if (cached) return cached;
                return fetch(e.request).then(resp => {
                    if (resp.ok) {
                        const clone = resp.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
                    }
                    return resp;
                }).catch(() => new Response('', { status: 404, statusText: 'Offline' }));
            })
        );
        return;
    }

    // App shell: cache-first
    e.respondWith(
        caches.match(e.request).then(cached => cached || fetch(e.request).then(resp => {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
            return resp;
        }).catch(() => new Response('Offline', { status: 503 })))
    );
});
