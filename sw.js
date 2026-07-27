// Service worker réel de ProSizer B2B, servi en same-origin (contrairement à l'ancienne
// version enregistrée depuis une blob: URL, que les navigateurs refusent silencieusement).
const CACHE_VERSION = 'v4';
const CACHE_NAME = `prosizer-${CACHE_VERSION}`;
const PRECACHE_URLS = [
    './',
    './index.html',
    './manifest.json',
    './assets/tailwind.css',
    './js/data.js',
    './js/calcul.js',
    './js/app.js',
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

// Réseau d'abord pour tout (document HTML comme assets JS/CSS), cache en secours uniquement
// hors-ligne. Un "cache d'abord, rafraîchi en tâche de fond" a déjà servi deux fois du code
// périmé sans prévenir juste après un déploiement (le rafraîchissement n'arrive qu'au
// rechargement suivant, ce qui ressemble à un bug pour l'utilisateur). Pour une appli de
// quelques dizaines de Ko, le coût réseau est négligeable en ligne ; la fraîcheur du code prime
// sur le gain de vitesse du cache-first.
self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    event.respondWith(
        fetch(req)
            .then((res) => {
                if (res.ok) {
                    const copy = res.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
                }
                return res;
            })
            .catch(() => caches.match(req).then((res) => res || (req.mode === 'navigate' ? caches.match('./index.html') : undefined)))
    );
});
