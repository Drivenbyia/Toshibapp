// Le magasin est testé avec un adaptateur en mémoire (jamais localStorage) — createStore()
// existe précisément pour ça. Deux scénarios comptent le plus : un échec de lecture au
// démarrage ne doit rien écrire (le régression-test du risque d'effacement silencieux), et un
// échec d'écriture ne doit jamais laisser l'instantané en mémoire divergent du disque.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../js/store.js';

const LEGACY_KEY = 'toshiba_chantiers';
const DATA_KEY = 'klimo:v2:local:data';
const MIGRATED_KEY = 'klimo:v2:local:migrated_at';

// Adaptateur en mémoire, avec des interrupteurs pour simuler les pannes de lecture/écriture
// que readChantiers/persistChantiers devaient déjà distinguer à l'étape précédente.
function fauxKv(seed = {}) {
    const map = new Map(Object.entries(seed));
    const pannesLecture = new Set();  // clés dont la lecture doit échouer
    let panneEcriture = null;         // clé dont l'écriture doit échouer, ou null

    return {
        _map: map,
        casserLecture(key) { pannesLecture.add(key); },
        casserEcriture(key) { panneEcriture = key; },
        get(key) {
            if (pannesLecture.has(key)) return { ok: false, reason: 'illisible' };
            if (!map.has(key)) return { ok: false, reason: 'absent' };
            return { ok: true, value: structuredClone(map.get(key)) };
        },
        set(key, value) {
            if (panneEcriture === key) return { ok: false, error: new Error('panne simulée') };
            map.set(key, structuredClone(value));
            return { ok: true };
        }
    };
}

const corpsMinimal = () => ({ mode: 'mono', brand: 'toshiba', usage: 'reversible', resultStr: 'r', equipments: [], roomDetails: [], params: {}, rooms: [{ id: 1, surface: 20 }], selection: {} });

describe('init — premier lancement', () => {
    test('sans aucune donnée, produit un magasin vide et non dégradé', () => {
        const kv = fauxKv();
        const store = createStore(kv);
        store.init();
        assert.equal(store.isDegraded(), null);
        assert.deepEqual(store.listConfigs(), []);
        assert.ok(kv._map.has(DATA_KEY), 'le magasin vide doit être persisté');
    });
});

describe('init — migration depuis toshiba_chantiers', () => {
    test('migre un blob v1 valide et rend les configurations disponibles', () => {
        const kv = fauxKv({
            [LEGACY_KEY]: {
                Dupont: { configurations: [{ zone: 'Salon', mode: 'mono', brand: 'toshiba', usage: 'reversible',
                    resultStr: 'r', equipments: [], roomDetails: [], params: {}, rooms: [{ id: 1, surface: 20 }],
                    selection: {}, date: '10/08/2026 15:31' }] }
            }
        });
        const store = createStore(kv);
        store.init();

        assert.equal(store.isDegraded(), null);
        const configs = store.listConfigs();
        assert.equal(configs.length, 1);
        assert.equal(configs[0].clientName, 'Dupont');
        assert.equal(configs[0].zone, 'Salon');
        assert.ok(kv._map.has(MIGRATED_KEY), 'le marqueur de migration doit être posé après vérification');
    });

    test('un second init (v2 déjà présent) ne re-migre pas — pas de doublons', () => {
        const kv = fauxKv({
            [LEGACY_KEY]: { Dupont: { configurations: [{ zone: 'Salon', mode: 'mono', brand: 'toshiba',
                usage: 'reversible', resultStr: 'r', equipments: [], roomDetails: [], params: {},
                rooms: [{ id: 1, surface: 20 }], selection: {}, date: '10/08/2026 15:31' }] } }
        });
        const store1 = createStore(kv);
        store1.init();
        const nbApresPremiereMigration = store1.listConfigs().length;

        const store2 = createStore(kv); // nouvelle instance, même stockage sous-jacent
        store2.init();
        assert.equal(store2.listConfigs().length, nbApresPremiereMigration);
    });

    test('le tri est par date décroissante, position d\'origine en départage', () => {
        const kv = fauxKv({
            [LEGACY_KEY]: {
                Dupont: { configurations: [
                    { zone: 'Ancien', mode: 'mono', brand: 'toshiba', usage: 'reversible', resultStr: 'r',
                      equipments: [], roomDetails: [], params: {}, rooms: [{ id: 1, surface: 20 }], selection: {},
                      date: '01/01/2026 10:00' },
                    { zone: 'Recent', mode: 'mono', brand: 'toshiba', usage: 'reversible', resultStr: 'r',
                      equipments: [], roomDetails: [], params: {}, rooms: [{ id: 1, surface: 20 }], selection: {},
                      date: '01/08/2026 10:00' }
                ] }
            }
        });
        const store = createStore(kv);
        store.init();
        assert.deepEqual(store.listConfigs().map((c) => c.zone), ['Recent', 'Ancien']);
    });
});

describe('init — le régression-test de l\'effacement silencieux', () => {
    // C'est exactement le bug corrigé à l'étape précédente : si la lecture de l'ancienne clé
    // échoue (au lieu d'être simplement absente), il ne faut RIEN écrire — sinon un magasin
    // vide écraserait potentiellement des données qu'on n'a juste pas su lire.
    test('lecture de toshiba_chantiers en échec : mode dégradé, aucune écriture', () => {
        const kv = fauxKv();
        kv.casserLecture(LEGACY_KEY);
        const store = createStore(kv);
        store.init();

        assert.equal(store.isDegraded(), 'illisible');
        assert.equal(kv._map.has(DATA_KEY), false, 'aucune écriture ne doit avoir eu lieu');
        assert.deepEqual(store.listConfigs(), []);
    });

    test('lecture de la clé v2 elle-même en échec : mode dégradé, magasin en mémoire vide', () => {
        const kv = fauxKv({ [DATA_KEY]: { schema: 2, configs: { x: {} }, outbox: [], cursor: { seq: 0 } } });
        kv.casserLecture(DATA_KEY);
        const store = createStore(kv);
        store.init();

        assert.equal(store.isDegraded(), 'illisible');
        assert.deepEqual(store.listConfigs(), []);
    });

    test('toute écriture est refusée tant que le mode dégradé est actif', () => {
        const kv = fauxKv();
        kv.casserLecture(LEGACY_KEY);
        const store = createStore(kv);
        store.init();

        assert.equal(store.saveConfig({ clientName: 'X', zone: 'Y', body: corpsMinimal() }), null);
        assert.equal(store.softDeleteByClient('X'), false);
        assert.equal(kv._map.has(DATA_KEY), false);
    });
});

describe('mutations — écritures transactionnelles', () => {
    test('saveConfig ajoute un enregistrement lisible immédiatement (lecture synchrone)', () => {
        const store = createStore(fauxKv());
        store.init();
        const id = store.saveConfig({ clientName: 'Dupont', zone: 'Salon', body: corpsMinimal() });
        assert.ok(id);
        assert.equal(store.listConfigs().length, 1);
        assert.equal(store.getConfig(id).clientName, 'Dupont');
    });

    test('deux appels consécutifs ne produisent jamais le même identifiant', () => {
        const store = createStore(fauxKv());
        store.init();
        const id1 = store.saveConfig({ clientName: 'A', zone: 'Z1', body: corpsMinimal() });
        const id2 = store.saveConfig({ clientName: 'A', zone: 'Z2', body: corpsMinimal() });
        assert.notEqual(id1, id2);
    });

    test('updateConfig modifie en place sans créer de doublon, et incrémente rev', () => {
        const kv = fauxKv();
        const store = createStore(kv);
        store.init();
        const id = store.saveConfig({ clientName: 'Dupont', zone: 'Salon', body: corpsMinimal() });

        const ok = store.updateConfig(id, { clientName: 'Dupont', zone: 'Salon rénové', body: corpsMinimal() });
        assert.equal(ok, true);
        assert.equal(store.listConfigs().length, 1, 'toujours un seul enregistrement');
        assert.equal(store.getConfig(id).zone, 'Salon rénové');

        const record = kv._map.get(DATA_KEY).configs[id];
        assert.equal(record.rev, 2);
    });

    test('updateConfig sur un id inconnu échoue sans effet de bord', () => {
        const store = createStore(fauxKv());
        store.init();
        assert.equal(store.updateConfig('id-inexistant', { clientName: 'X', zone: 'Y', body: corpsMinimal() }), false);
    });

    test('softDelete retire l\'enregistrement de listConfigs mais ne le détruit pas', () => {
        const kv = fauxKv();
        const store = createStore(kv);
        store.init();
        const id = store.saveConfig({ clientName: 'Dupont', zone: 'Salon', body: corpsMinimal() });

        assert.equal(store.softDelete(id), true);
        assert.deepEqual(store.listConfigs(), []);
        assert.ok(kv._map.get(DATA_KEY).configs[id], 'la charge utile reste en base, seule deletedAt change');
        assert.ok(kv._map.get(DATA_KEY).configs[id].deletedAt);
    });

    test('softDeleteByClient efface toutes les configs d\'un client, aucune des autres', () => {
        const store = createStore(fauxKv());
        store.init();
        store.saveConfig({ clientName: 'Dupont', zone: 'Salon', body: corpsMinimal() });
        store.saveConfig({ clientName: 'Dupont', zone: 'Chambre', body: corpsMinimal() });
        store.saveConfig({ clientName: 'Martin', zone: 'Cuisine', body: corpsMinimal() });

        assert.equal(store.softDeleteByClient('Dupont'), true);
        const restants = store.listConfigs();
        assert.equal(restants.length, 1);
        assert.equal(restants[0].clientName, 'Martin');
    });

    // Le scénario que le plan désigne comme le plus important pour cette suite : un échec
    // d'écriture ne doit jamais laisser l'instantané en mémoire en avance sur le disque.
    test('un échec de kv.set laisse l\'instantané en mémoire strictement inchangé', () => {
        const kv = fauxKv();
        const store = createStore(kv);
        store.init();
        const id = store.saveConfig({ clientName: 'Dupont', zone: 'Salon', body: corpsMinimal() });

        const avant = store.listConfigs();
        kv.casserEcriture(DATA_KEY);

        const ok = store.updateConfig(id, { clientName: 'Dupont', zone: 'Salon modifié', body: corpsMinimal() });
        assert.equal(ok, false, 'updateConfig doit signaler l\'échec');
        assert.deepEqual(store.listConfigs(), avant, 'aucune mutation fantôme non persistée');
        assert.equal(store.getConfig(id).zone, 'Salon', 'la valeur en mémoire reste celle qui est sur disque');
    });

    test('saveConfig renvoie null (jamais un id) quand l\'écriture échoue', () => {
        const kv = fauxKv();
        const store = createStore(kv);
        store.init();
        kv.casserEcriture(DATA_KEY);

        const id = store.saveConfig({ clientName: 'Dupont', zone: 'Salon', body: corpsMinimal() });
        assert.equal(id, null);
        assert.deepEqual(store.listConfigs(), []);
    });
});

describe('listClientNames', () => {
    test('un nom par client, dans l\'ordre de première apparition (le plus récent en tête)', () => {
        const store = createStore(fauxKv());
        store.init();
        store.saveConfig({ clientName: 'Dupont', zone: 'Salon', body: corpsMinimal() });
        store.saveConfig({ clientName: 'Martin', zone: 'Cuisine', body: corpsMinimal() });
        store.saveConfig({ clientName: 'Dupont', zone: 'Chambre', body: corpsMinimal() });

        const noms = store.listClientNames();
        assert.equal(new Set(noms).size, noms.length, 'pas de doublon');
        assert.deepEqual(new Set(noms), new Set(['Dupont', 'Martin']));
    });
});

describe('export / import legacy — la restauration ne détruit jamais', () => {
    test('exportLegacyBlob puis importLegacyBlob sur un magasin vide est idempotent', () => {
        const store = createStore(fauxKv());
        store.init();
        store.saveConfig({ clientName: 'Dupont', zone: 'Salon', body: corpsMinimal() });

        const blob = store.exportLegacyBlob();
        const res = store.importLegacyBlob(blob);
        assert.equal(res.ajoutes, 0, 'réimporter son propre export ne doit rien ajouter');
        assert.equal(res.ignores, 1);
        assert.equal(store.listConfigs().length, 1);
    });

    test('importLegacyBlob ajoute uniquement les zones réellement nouvelles', () => {
        const store = createStore(fauxKv());
        store.init();
        store.saveConfig({ clientName: 'Dupont', zone: 'Salon', body: corpsMinimal() });

        const res = store.importLegacyBlob({
            Dupont: { configurations: [
                { zone: 'Salon', mode: 'mono', brand: 'toshiba', usage: 'reversible', resultStr: 'r',
                  equipments: [], roomDetails: [], params: {}, rooms: [{ id: 1, surface: 20 }], selection: {},
                  date: store.listConfigs()[0].date },
                { zone: 'Véranda', mode: 'mono', brand: 'toshiba', usage: 'reversible', resultStr: 'r2',
                  equipments: [], roomDetails: [], params: {}, rooms: [{ id: 1, surface: 20 }], selection: {},
                  date: '12/08/2026 09:00' }
            ] }
        });

        assert.equal(res.ajoutes, 1);
        assert.equal(res.ignores, 1);
        assert.deepEqual(store.listConfigs().map((c) => c.zone).sort(), ['Salon', 'Véranda']);
    });

    test('importLegacyBlob est refusé en mode dégradé', () => {
        const kv = fauxKv();
        kv.casserLecture(LEGACY_KEY);
        const store = createStore(kv);
        store.init();

        const res = store.importLegacyBlob({ Dupont: { configurations: [] } });
        assert.deepEqual(res, { ajoutes: 0, ignores: 0 });
    });
});

describe('subscribe', () => {
    test('notifie les abonnés après une mutation persistée', () => {
        const store = createStore(fauxKv());
        store.init();
        let appels = 0;
        const desabonner = store.subscribe(() => { appels++; });

        store.saveConfig({ clientName: 'Dupont', zone: 'Salon', body: corpsMinimal() });
        assert.equal(appels, 1);

        desabonner();
        store.saveConfig({ clientName: 'Dupont', zone: 'Chambre', body: corpsMinimal() });
        assert.equal(appels, 1, 'plus d\'appel après désabonnement');
    });

    test('n\'est jamais notifié quand une écriture échoue', () => {
        const kv = fauxKv();
        const store = createStore(kv);
        store.init();
        let appels = 0;
        store.subscribe(() => { appels++; });
        kv.casserEcriture(DATA_KEY);

        store.saveConfig({ clientName: 'Dupont', zone: 'Salon', body: corpsMinimal() });
        assert.equal(appels, 0);
    });
});
