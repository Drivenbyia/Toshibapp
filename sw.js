// Service worker réel de ProSizer B2B, servi en same-origin (contrairement à l'ancienne
// version enregistrée depuis une blob: URL, que les navigateurs refusent silencieusement).
const CACHE_VERSION = 'v1';
const CACHE_NAME = `prosizer-${CACHE_VERSION}`;
const PRECACHE_URLS = [
    './',
    './index.html',
    './manifest.json',
    './assets/tailwind.css',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(PRECACHE_URLS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    // Document HTML : réseau d'abord, cache en secours hors-ligne. Évite de rester bloqué
    // sur une version périmée de l'app tant que la connexion fonctionne (le service worker
    // ignore sinon le Cache-Control: must-revalidate défini par netlify.toml).
    if (req.mode === 'navigate') {
        event.respondWith(
            fetch(req)
                .then((res) => {
                    const copy = res.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
                    return res;
                })
                .catch(() => caches.match(req).then((res) => res || caches.match('./index.html')))
        );
        return;
    }

    // Assets statiques same-origin : cache d'abord (rapidité hors-ligne), rafraîchis en tâche de fond.
    event.respondWith(
        caches.match(req).then((cached) => {
            const network = fetch(req).then((res) => {
                if (res.ok) caches.open(CACHE_NAME).then((cache) => cache.put(req, res.clone()));
                return res;
            }).catch(() => cached);
            return cached || network;
        })
    );
});
