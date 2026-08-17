// Service worker réel de Klimo, servi en same-origin (contrairement à l'ancienne
// version enregistrée depuis une blob: URL, que les navigateurs refusent silencieusement).
const CACHE_VERSION = 'v16';
const CACHE_NAME = `klimo-${CACHE_VERSION}`;
const PRECACHE_URLS = [
    './',
    './index.html',
    './manifest.json',
    './assets/tailwind.css',
    // Police auto-hébergée. Sans cette entrée, un premier chargement hors ligne retombe sur
    // la pile système, puis bascule de rendu dès le retour du réseau.
    // NB : pas de guillemet simple dans les commentaires de ce tableau — readPrecacheUrls()
    // (tests/precache.test.mjs) extrait les chaînes par appariement de quotes, et une
    // apostrophe isolée décale tout le reste de la liste.
    './assets/archivo-variable-latin.woff2',
    './js/data.js',
    './js/calcul.js',
    './js/fiche.js',
    './js/sauvegarde.js',
    './js/marques.js',
    './js/kv.js',
    './js/migration.js',
    './js/reconcile.js',
    './js/store.js',
    './js/sync.js',
    './js/config.js',
    './js/account.js',
    './js/admin.js',
    './js/auth-ui.js',
    './js/supabase-client.js',
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

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    // Requêtes vers une autre origine (API de synchronisation) : on ne répond pas, le
    // navigateur les exécute normalement — ni lecture ni écriture de cache.
    //
    // Sans ce garde, la branche « assets statiques » plus bas s'appliquait à TOUTE requête
    // GET malgré son commentaire, avec deux conséquences : des données distantes servies
    // depuis le cache indéfiniment (`cached || network`), et surtout des réponses
    // authentifiées recopiées dans un Cache Storage partagé, où elles survivaient à la
    // déconnexion.
    if (new URL(req.url).origin !== self.location.origin) return;

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
                // `type === 'basic'` = same-origin non opaque. Redondant avec le garde
                // d'origine ci-dessus, et c'est voulu : si quelqu'un le supprime un jour,
                // rien d'authentifié n'atterrit pour autant dans le cache.
                if (res.ok && res.type === 'basic') {
                    caches.open(CACHE_NAME).then((cache) => cache.put(req, res.clone()));
                }
                return res;
            }).catch(() => cached || new Response('', { status: 504, statusText: 'Offline' }));
            return cached || network;
        })
    );
});
