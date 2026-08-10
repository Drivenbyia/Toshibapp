// Magasin des chantiers : identifiants stables, horodatages, pierres tombales, file d'attente
// de synchronisation (posée mais jamais vidée à ce stade — la synchro arrive à une étape
// ultérieure). Remplace la carte imbriquée { <nomClient>: { configurations: [...] } } adressée
// par nom + position, qui empêchait toute mise à jour en place et tout croisement fiable entre
// appareils.
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

const LEGACY_KEY = 'toshiba_chantiers';
const NAMESPACE = 'klimo:v2:local';
const DATA_KEY = `${NAMESPACE}:data`;
const MIGRATED_KEY = `${NAMESPACE}:migrated_at`;

function now() { return new Date().toISOString(); }
function newId() { return crypto.randomUUID(); }

function magasinVide() {
    return { schema: 2, configs: {}, outbox: [], cursor: { seq: 0 }, device: { id: newId(), clockOffsetMs: 0 } };
}

function formeV2Valide(v) {
    return Boolean(v) && typeof v === 'object' && v.configs !== null && typeof v.configs === 'object';
}

export function createStore(kv) {
    let data = null;
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
            data = nouveau.value;
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
        const t = now();
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
        c.updatedAt = now();
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
        c.deletedAt = now();
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
                c.deletedAt = now();
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
            sortie[c.clientName].configurations.push({
                zone: c.zone, mode: c.mode, brand: c.brand, usage: c.usage,
                resultStr: c.resultStr, equipments: c.equipments, roomDetails: c.roomDetails,
                params: c.params, rooms: c.rooms, selection: c.selection, date: c.date
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
                const { zone, mode, brand, usage, resultStr, equipments, roomDetails, params, rooms, selection } = cfg;
                saveConfig({ clientName, zone, body: { mode, brand, usage, resultStr, equipments, roomDetails, params, rooms, selection } });
            }
        }
        return { ajoutes, ignores };
    }

    function subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
    }

    return {
        init, isDegraded, listConfigs, getConfig, listClientNames,
        saveConfig, updateConfig, softDelete, softDeleteByClient,
        exportLegacyBlob, importLegacyBlob, subscribe
    };
}

// Instance par défaut, branchée sur le vrai localStorage — celle que l'application utilise.
export const store = createStore({ get: kvGet, set: kvSet });
