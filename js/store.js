// Magasin des chantiers : identifiants stables, horodatages, pierres tombales, file d'attente
// de synchronisation. Remplace la carte imbriquée { <nomClient>: { configurations: [...] } }
// adressée par nom + position, qui empêchait toute mise à jour en place et tout croisement
// fiable entre appareils.
//
// Ce module ignore totalement l'existence du réseau : il expose une file d'attente et un
// unique point d'entrée privilégié (applyRemote) ; c'est js/sync.js qui vide la file et
// réinjecte les changements distants. La synchronisation reste ainsi supprimable sans
// toucher au magasin, et le magasin testable sans backend.
//
// `createStore(kv)` prend un adaptateur de stockage en paramètre — jamais `localStorage`
// directement — précisément pour rester testable avec un faux magasin en mémoire (voir
// tests/store.test.mjs), sans jamais toucher au stockage réel du navigateur.
//
// Lectures synchrones sur un instantané en mémoire, écritures transactionnelles : toute
// mutation construit une copie complète, tente l'écriture dessus, et ne la promeut en
// instantané courant qu'en cas de succès. Un échec d'écriture laisse donc l'état en mémoire
// strictement inchangé — jamais de divergence entre ce que l'interface affiche et ce qui est
// réellement sur disque.

import { formeChantiersValide, fusionnerChantiers } from './sauvegarde.js';
import { migrateV1ToV2, formatDateDisplay } from './migration.js';
import { kvGet, kvSet } from './kv.js';
import { stampNow } from './reconcile.js';

const LEGACY_KEY = 'toshiba_chantiers';
const NAMESPACE = 'klimo:v2:local';
const DATA_KEY = `${NAMESPACE}:data`;
const MIGRATED_KEY = `${NAMESPACE}:migrated_at`;

function now() { return new Date().toISOString(); }
function newId() { return crypto.randomUUID(); }

function magasinVide() {
    return {
        schema: 2, configs: {}, outbox: [], cursor: { seq: 0 },
        device: { id: newId(), clockOffsetMs: 0, highestSeenMs: null },
        // Versions locales non poussées rétrogradées par la réconciliation (voir
        // js/reconcile.js) : jamais jetées, l'utilisateur arbitre à la main.
        conflicts: []
    };
}

function formeV2Valide(v) {
    return Boolean(v) && typeof v === 'object' && v.configs !== null && typeof v.configs === 'object';
}

// Les magasins v2 écrits avant l'arrivée de la synchronisation n'ont ni `conflicts` ni
// `device.highestSeenMs` : on complète à la lecture plutôt que d'imposer une migration de
// schéma pour deux champs additifs.
function normaliserV2(v) {
    return {
        ...v,
        outbox: Array.isArray(v.outbox) ? v.outbox : [],
        cursor: v.cursor || { seq: 0 },
        conflicts: Array.isArray(v.conflicts) ? v.conflicts : [],
        device: { id: newId(), clockOffsetMs: 0, highestSeenMs: null, ...(v.device || {}) }
    };
}

export function createStore(kv) {
    let data = null;

    // Horodatage d'écriture corrigé du décalage serveur observé, puis bridé pour qu'une
    // horloge d'appareil aberrante ne puisse pas gagner tous les conflits (voir
    // js/reconcile.js). Sans aucune synchronisation encore effectuée, le décalage vaut 0 et
    // le comportement est strictement celui d'un `new Date().toISOString()`.
    function nowSync() {
        const d = (data && data.device) || {};
        return stampNow({
            localNowMs: Date.now(),
            clockOffsetMs: d.clockOffsetMs ?? 0,
            highestSeenMs: d.highestSeenMs ?? null
        });
    }

    // Renseigné dès que le chargement initial échoue ('illisible' : accès refusé ; 'corrompu' :
    // JSON invalide ou forme inattendue). Tant qu'il est actif, toute écriture est refusée — le
    // même principe que le filet de sécurité de l'étape précédente, désormais au bon niveau.
    let stockageDegrade = null;
    const listeners = new Set();

    function notify() { listeners.forEach((fn) => fn()); }

    // Toute mutation passe par ici : `next` est déjà la copie mutée. On ne l'adopte comme
    // instantané courant qu'après une écriture réussie — c'est ce qui garantit qu'un échec de
    // persistChantiers-like ne laisse jamais l'affichage en avance sur le disque.
    function commit(next) {
        const res = kv.set(DATA_KEY, next);
        if (!res.ok) {
            console.warn('Écriture refusée : le stockage local a rejeté la sauvegarde.', res.error || '');
            return false;
        }
        data = next;
        notify();
        return true;
    }

    function init() {
        const nouveau = kv.get(DATA_KEY);
        if (nouveau.ok) {
            if (!formeV2Valide(nouveau.value)) {
                stockageDegrade = 'corrompu';
                data = magasinVide();
                return;
            }
            data = normaliserV2(nouveau.value);
            return;
        }
        if (nouveau.reason === 'illisible') {
            stockageDegrade = 'illisible';
            data = magasinVide();
            return;
        }

        // Clé v2 absente : premier lancement sur cet appareil, ou appareil pas encore migré.
        const legacy = kv.get(LEGACY_KEY);

        if (legacy.reason === 'illisible') {
            // Impossible de savoir si un historique existe : on refuse d'écrire un magasin vide
            // par-dessus une donnée qu'on n'a simplement pas su lire.
            stockageDegrade = 'illisible';
            data = magasinVide();
            return;
        }
        if (legacy.reason === 'absent') {
            // Aucun historique à migrer : départ propre.
            data = magasinVide();
            kv.set(DATA_KEY, data);
            return;
        }
        if (legacy.reason === 'corrompu' || (legacy.ok && !formeChantiersValide(legacy.value))) {
            stockageDegrade = 'corrompu';
            data = magasinVide();
            return;
        }

        // legacy.ok && forme valide : migration réelle.
        const migre = migrateV1ToV2(legacy.value, { nowIso: now(), newId });
        const ecrit = kv.set(DATA_KEY, migre);
        if (ecrit.ok) {
            const relu = kv.get(DATA_KEY);
            const compteMigre = Object.keys(migre.configs).length;
            const compteRelu = relu.ok ? Object.keys(relu.value.configs || {}).length : -1;
            if (compteRelu === compteMigre) {
                kv.set(MIGRATED_KEY, now());
            } else {
                console.warn('Vérification de la migration : le nombre de configurations relu ne correspond pas à celui migré.');
            }
        } else {
            console.warn('Échec de l\'écriture de la migration.', ecrit.error || '');
        }
        // Le magasin migré est correct en mémoire même si sa persistance a échoué ou n'a pas pu
        // être vérifiée : l'utilisateur retrouve sa session, quitte à ce que la migration soit
        // retentée au prochain chargement si l'écriture a réellement échoué.
        data = migre;
    }

    function isDegraded() { return stockageDegrade; }

    // Vue de lecture : aplatit l'enregistrement interne (id/clientName/zone/body/…) vers la
    // forme que consomment le tableau de bord et le rechargement — proche de l'ancien
    // enregistrement legacy pour limiter le remaniement de app.js.
    function vueLisible(c) {
        return {
            id: c.id, clientName: c.clientName, zone: c.zone,
            ...c.body,
            date: (c.legacy && c.legacy.date) || formatDateDisplay(c.savedAt),
            savedAt: c.savedAt, updatedAt: c.updatedAt,
            legacyIncomplete: Boolean(c.legacyIncomplete)
        };
    }

    // Non supprimés, triés par date de sauvegarde décroissante puis par position d'origine —
    // c'est délibérément un changement par rapport à l'ordre d'insertion croissant d'avant.
    function listConfigs() {
        return Object.values(data.configs)
            .filter((c) => !c.deletedAt)
            .sort((a, b) => {
                if (a.savedAt !== b.savedAt) return a.savedAt < b.savedAt ? 1 : -1;
                const ia = (a.legacy && a.legacy.index) || 0;
                const ib = (b.legacy && b.legacy.index) || 0;
                return ia - ib;
            })
            .map(vueLisible);
    }

    function getConfig(id) {
        const c = data.configs[id];
        return (c && !c.deletedAt) ? vueLisible(c) : undefined;
    }

    // Ordre de première apparition dans listConfigs() — donc les clients les plus récemment
    // actifs en tête, sans logique de tri séparée à maintenir.
    function listClientNames() {
        const vus = new Set();
        const noms = [];
        listConfigs().forEach((c) => {
            if (!vus.has(c.clientName)) { vus.add(c.clientName); noms.push(c.clientName); }
        });
        return noms;
    }

    // Chemin par défaut : toujours un ajout, avec un identifiant généré côté client qui ne peut
    // structurellement pas entrer en conflit. Renvoie l'id créé, ou `null` si l'écriture a été
    // refusée (mode dégradé ou échec de persistance) — l'appelant doit traiter ce cas comme un
    // échec, pas comme un id valide.
    function saveConfig({ clientName, zone, body }) {
        if (stockageDegrade) return null;
        const id = newId();
        const t = nowSync();
        const next = structuredClone(data);
        next.configs[id] = {
            id, clientName, zone, body,
            savedAt: t, createdAt: t, updatedAt: t, deletedAt: null,
            rev: 1, syncedRev: 0, legacy: null, legacyIncomplete: false
        };
        next.outbox.push({ op: 'upsert', id, rev: 1 });
        return commit(next) ? id : null;
    }

    // Mise à jour en place — le geste explicite de l'utilisateur, distinct de saveConfig().
    function updateConfig(id, { clientName, zone, body }) {
        if (stockageDegrade) return false;
        const existant = data.configs[id];
        if (!existant || existant.deletedAt) return false;

        const next = structuredClone(data);
        const c = next.configs[id];
        c.clientName = clientName;
        c.zone = zone;
        c.body = body;
        c.updatedAt = nowSync();
        c.rev += 1;
        next.outbox.push({ op: 'upsert', id, rev: c.rev });
        return commit(next);
    }

    function softDelete(id) {
        if (stockageDegrade) return false;
        const existant = data.configs[id];
        if (!existant || existant.deletedAt) return false;

        const next = structuredClone(data);
        const c = next.configs[id];
        c.deletedAt = nowSync();
        c.rev += 1;
        next.outbox.push({ op: 'delete', id, rev: c.rev });
        return commit(next);
    }

    function softDeleteByClient(clientName) {
        if (stockageDegrade) return false;
        const next = structuredClone(data);
        let touche = false;
        Object.values(next.configs).forEach((c) => {
            if (c.clientName === clientName && !c.deletedAt) {
                c.deletedAt = nowSync();
                c.rev += 1;
                next.outbox.push({ op: 'delete', id: c.id, rev: c.rev });
                touche = true;
            }
        });
        if (!touche) return false;
        return commit(next);
    }

    // Reconstruit la forme legacy { <nomClient>: { configurations: [...] } } pour le fichier de
    // sauvegarde : le format du fichier téléchargé ne change pas, seule sa source change.
    function exportLegacyBlob() {
        const sortie = {};
        listConfigs().forEach((c) => {
            if (!sortie[c.clientName]) sortie[c.clientName] = { configurations: [] };
            // Cette liste est énumérée à la main, donc tout champ ajouté au corps doit y être
            // ajouté ici AUSSI : un champ oublié ne casse rien à l'écriture, il disparaît
            // silencieusement au premier aller-retour « Sauvegarder » → « Restaurer ».
            sortie[c.clientName].configurations.push({
                zone: c.zone, mode: c.mode, brand: c.brand, usage: c.usage,
                resultStr: c.resultStr, equipments: c.equipments, roomDetails: c.roomDetails,
                params: c.params, rooms: c.rooms, selection: c.selection,
                v: c.v, fiche: c.fiche, date: c.date
            });
        });
        return sortie;
    }

    // Réutilise fusionnerChantiers (js/sauvegarde.js) pour la déduplication : elle produit le
    // blob fusionné en forme legacy, dans lequel les entrées nouvellement ajoutées sont
    // exactement la queue de chaque tableau `configurations` au-delà de sa longueur d'origine
    // (fusionnerChantiers ne fait qu'empiler après avoir cloné l'existant). On insère donc
    // uniquement ces entrées-là comme de vrais enregistrements, avec de vrais identifiants.
    function importLegacyBlob(legacyImporte) {
        if (stockageDegrade) return { ajoutes: 0, ignores: 0 };
        const actuel = exportLegacyBlob();
        const { chantiers: fusionne, ajoutes, ignores } = fusionnerChantiers(actuel, legacyImporte);

        for (const [clientName, d] of Object.entries(fusionne)) {
            const departPreexistant = (actuel[clientName] && actuel[clientName].configurations.length) || 0;
            const nouvelles = d.configurations.slice(departPreexistant);
            for (const cfg of nouvelles) {
                const { zone, mode, brand, usage, resultStr, equipments, roomDetails, params, rooms, selection, v, fiche } = cfg;
                saveConfig({ clientName, zone, body: { v, fiche, mode, brand, usage, resultStr, equipments, roomDetails, params, rooms, selection } });
            }
        }
        return { ajoutes, ignores };
    }

    function subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
    }

    // --- Surface de synchronisation ---------------------------------------------------
    // Ces accesseurs existent pour js/sync.js seulement. store.js continue d'ignorer
    // totalement l'existence du réseau : il expose une file d'attente, sync.js la vide et
    // réinjecte les changements distants par le seul applyRemote(). C'est ce qui garde le
    // magasin testable sans backend — et la synchronisation supprimable sans y toucher.

    // Enregistrement interne brut (avec rev/syncedRev), y compris supprimé — la
    // réconciliation a besoin de voir les pierres tombales, contrairement à getConfig().
    function getRaw(id) { return data.configs[id]; }

    // File coalescée : une entrée par identifiant, portant l'état courant. Plusieurs
    // modifications successives hors-ligne ne poussent qu'une fois, l'état final.
    function getPending() {
        if (stockageDegrade) return [];
        const ids = new Set(data.outbox.map((e) => e.id));
        const sortie = [];
        ids.forEach((id) => {
            const c = data.configs[id];
            if (c) sortie.push({ id, rev: c.rev, record: c });
        });
        return sortie;
    }

    // `rev` est la révision RÉELLEMENT poussée, pas la révision courante : si l'utilisateur
    // a modifié l'enregistrement pendant l'aller-retour réseau, sa nouvelle modification
    // doit rester en attente plutôt que d'être marquée synchronisée par erreur.
    function markPushed(entrees) {
        if (stockageDegrade) return false;
        const next = structuredClone(data);
        entrees.forEach(({ id, rev }) => {
            const c = next.configs[id];
            if (c && c.syncedRev < rev) c.syncedRev = rev;
            next.outbox = next.outbox.filter((e) => !(e.id === id && e.rev <= rev));
        });
        return commit(next);
    }

    // Applique les décisions produites par reconcile(). Point d'entrée unique et privilégié
    // pour tout ce qui vient du serveur.
    function applyRemote(decisions) {
        if (stockageDegrade) return false;
        const next = structuredClone(data);

        decisions.forEach(({ remote, decision }) => {
            if (decision.action === 'keep_local') return;

            if (decision.conflict) {
                // Le perdant est conservé, jamais jeté : c'est ce qui rend le
                // dernier-écrit-gagne acceptable.
                next.conflicts.push({
                    id: newId(), originalId: decision.conflict.id,
                    clientName: decision.conflict.clientName, zone: decision.conflict.zone,
                    body: decision.conflict.body, updatedAt: decision.conflict.updatedAt,
                    detectedAt: now()
                });
            }

            const ancien = next.configs[remote.id];
            const revSuivante = (ancien ? ancien.rev : 0) + 1;
            next.configs[remote.id] = {
                id: remote.id, clientName: remote.clientName, zone: remote.zone,
                body: remote.body,
                savedAt: remote.savedAt, createdAt: remote.createdAt,
                updatedAt: remote.updatedAt, deletedAt: remote.deletedAt,
                // L'enregistrement devient propre : rev === syncedRev, donc plus rien à
                // pousser pour lui.
                rev: revSuivante, syncedRev: revSuivante,
                legacy: ancien ? ancien.legacy : null,
                legacyIncomplete: ancien ? ancien.legacyIncomplete : false
            };
            // Toute entrée de file résiduelle pour cet identifiant est caduque : ses
            // modifications viennent d'être soit adoptées, soit rétrogradées en conflit.
            next.outbox = next.outbox.filter((e) => e.id !== remote.id);

            if (Number.isFinite(Date.parse(remote.updatedAt))) {
                const vu = Date.parse(remote.updatedAt);
                if (!next.device.highestSeenMs || vu > next.device.highestSeenMs) {
                    next.device.highestSeenMs = vu;
                }
            }
        });

        return commit(next);
    }

    function getCursor() { return (data.cursor && data.cursor.seq) || 0; }
    function setCursor(seq) {
        if (stockageDegrade) return false;
        const next = structuredClone(data);
        next.cursor = { seq };
        return commit(next);
    }

    function getClockState() {
        const d = data.device || {};
        return { offsetMs: d.clockOffsetMs ?? 0, highestSeenMs: d.highestSeenMs ?? null };
    }
    function setClockState({ offsetMs, highestSeenMs }) {
        if (stockageDegrade) return false;
        const next = structuredClone(data);
        next.device = { ...next.device, clockOffsetMs: offsetMs, highestSeenMs };
        return commit(next);
    }

    function listConflicts() { return (data.conflicts || []).slice(); }
    function dismissConflict(conflictId) {
        if (stockageDegrade) return false;
        const next = structuredClone(data);
        next.conflicts = (next.conflicts || []).filter((c) => c.id !== conflictId);
        return commit(next);
    }
    // Restaure une version rétrogradée comme un nouvel enregistrement à part entière : la
    // récupération ne réécrit jamais par-dessus le gagnant, elle crée une fiche distincte
    // que l'utilisateur compare puis nettoie lui-même.
    function restoreConflict(conflictId) {
        const c = (data.conflicts || []).find((x) => x.id === conflictId);
        if (!c) return null;
        const id = saveConfig({ clientName: c.clientName, zone: `${c.zone} (version de cet appareil)`, body: c.body });
        if (id) dismissConflict(conflictId);
        return id;
    }

    return {
        init, isDegraded, listConfigs, getConfig, listClientNames,
        saveConfig, updateConfig, softDelete, softDeleteByClient,
        exportLegacyBlob, importLegacyBlob, subscribe,
        getRaw, getPending, markPushed, applyRemote,
        getCursor, setCursor, getClockState, setClockState,
        listConflicts, dismissConflict, restoreConflict
    };
}

// Instance par défaut, branchée sur le vrai localStorage — celle que l'application utilise.
export const store = createStore({ get: kvGet, set: kvSet });
