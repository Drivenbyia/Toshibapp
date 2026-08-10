// Migration du stockage local historique (une carte { <nomClient>: { configurations: [...] } },
// adressée par nom de client + position dans le tableau) vers le schéma v2 (une collection à plat
// indexée par identifiant stable, avec horodatages et pierre tombale — voir js/store.js).
//
// Fonctions pures : aucun DOM, aucun accès à localStorage, aucune horloge lue directement — `now`
// et la génération d'identifiants sont injectés par l'appelant. C'est ce qui les rend testables
// avec le runner Node natif, sans dépendance, et déterministes dans les tests.

// Format produit par `saveChantier` (js/app.js) via
// `toLocaleString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' })` —
// p.ex. "10/08/2026 15:31". Le séparateur entre date et heure varie selon le moteur JS (espace,
// virgule, espace insécable étroite U+202F) : `\D+` l'absorbe sans le supposer fixe.
const FR_DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})\D+(\d{2}):(\d{2})$/;

// Reconstruit un horodatage ISO à partir de l'affichage fr-FR historique. Replie sur `nowIso`
// (fourni par l'appelant, jamais lu ici) si la chaîne est absente, mal formée, ou correspond au
// motif mais désigne une date calendaire invalide (JS normalise silencieusement un
// débordement — "32/13/2026" ne lève pas, il glisse vers une autre date qu'on refuse ici).
export function parseFrDate(str, nowIso) {
    if (typeof str !== 'string') return nowIso;
    const m = str.match(FR_DATE_RE);
    if (!m) return nowIso;

    const [, jourStr, moisStr, anneeStr, heureStr, minuteStr] = m;
    const jour = Number(jourStr), mois = Number(moisStr), annee = Number(anneeStr);
    const heure = Number(heureStr), minute = Number(minuteStr);

    const d = new Date(annee, mois - 1, jour, heure, minute);
    if (Number.isNaN(d.getTime())) return nowIso;
    // Garde contre le débordement silencieux de Date (ex. jour=32) : si la date reconstruite
    // ne correspond plus aux chiffres saisis, elle a roulé vers un autre jour — on la rejette
    // plutôt que de migrer une donnée fausse mais plausible.
    if (d.getFullYear() !== annee || d.getMonth() !== mois - 1 || d.getDate() !== jour) return nowIso;
    return d.toISOString();
}

// Inverse approximatif de parseFrDate, pour l'affichage des enregistrements créés après la
// migration (qui n'ont plus de `legacy.date` à montrer tel quel).
export function formatDateDisplay(iso) {
    return new Date(iso).toLocaleString('fr-FR', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
}

// legacyChantiers : { <nomClient>: { configurations: [ {...} ] } } — la forme déjà validée par
// formeChantiersValide() (js/sauvegarde.js) côté appelant. `{}` ou `undefined` sont acceptés et
// produisent un magasin vide.
//
// Sans perte par construction : chaque champ de l'enregistrement historique atterrit soit dans
// `body` (le contenu métier, inchangé), soit dans `legacy` (la chaîne de date d'origine et la
// position d'origine, conservées telles quelles même quand `date` n'a pas pu être reparsée).
export function migrateV1ToV2(legacyChantiers, { nowIso, newId }) {
    const configs = {};

    for (const [clientName, data] of Object.entries(legacyChantiers || {})) {
        const items = (data && Array.isArray(data.configurations)) ? data.configurations : [];

        items.forEach((cfg, index) => {
            const id = newId();
            const savedAt = parseFrDate(cfg.date, nowIso);
            const { zone, mode, brand, usage, resultStr, equipments, roomDetails, params, rooms, selection } = cfg;

            configs[id] = {
                id, clientName, zone,
                body: { mode, brand, usage, resultStr, equipments, roomDetails, params, rooms, selection },
                savedAt, createdAt: savedAt, updatedAt: savedAt, deletedAt: null,
                rev: 1, syncedRev: 0,
                legacy: { date: cfg.date ?? null, index },
                // Enregistrements antérieurs à l'ajout du champ `rooms` : gérés jusqu'ici par
                // reniflage de forme au moment du rechargement (js/app.js), désormais par ce
                // drapeau explicite, posé une fois pour toutes à la migration.
                legacyIncomplete: !rooms || !rooms.length
            };
        });
    }

    return {
        schema: 2,
        configs,
        outbox: [],
        cursor: { seq: 0 },
        device: { id: newId(), clockOffsetMs: 0 }
    };
}
