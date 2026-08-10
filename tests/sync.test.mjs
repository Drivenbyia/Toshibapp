// Tests d'enchaînement de la synchronisation, avec un FAUX transport et le VRAI magasin :
// c'est la jonction entre les deux qui est risquée, pas chacun pris isolément. Aucun backend
// n'est requis — c'est précisément ce que permet l'injection du transport dans createSync().
//
// L'invariant vérifié en priorité : une panne ne doit jamais corrompre l'état. Une poussée
// qui échoue laisse la file intacte, un tirage qui échoue laisse le curseur immobile.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../js/store.js';
import { createSync, PAGE_SIZE } from '../js/sync.js';
import { toRemoteRow } from '../js/reconcile.js';

const DATA_KEY = 'klimo:v2:local:data';

function fauxKv(seed = {}) {
    const map = new Map(Object.entries(seed));
    return {
        _map: map,
        get(key) {
            if (!map.has(key)) return { ok: false, reason: 'absent' };
            return { ok: true, value: structuredClone(map.get(key)) };
        },
        set(key, value) { map.set(key, structuredClone(value)); return { ok: true }; }
    };
}

// Transport programmable : enregistre ce qu'on lui donne, rend ce qu'on lui a préparé.
function fauxTransport() {
    return {
        poussees: [],
        pages: [],            // files de réponses successives pour pull()
        echecPush: null,
        echecPull: null,
        serverDateMs: null,
        async push(rows) {
            this.poussees.push(rows);
            if (this.echecPush) return { ok: false, error: this.echecPush, serverDateMs: this.serverDateMs };
            return { ok: true, serverDateMs: this.serverDateMs };
        },
        async pull(sinceSeq, limit) {
            if (this.echecPull) return { ok: false, error: this.echecPull, serverDateMs: this.serverDateMs };
            const page = this.pages.shift() || [];
            return { ok: true, rows: page, serverDateMs: this.serverDateMs };
        }
    };
}

const corps = (z) => ({
    mode: 'mono', brand: 'toshiba', usage: 'reversible', resultStr: `1x ${z}`,
    equipments: [], roomDetails: [], params: {}, rooms: [{ id: 1, surface: 20 }], selection: {}
});

function monter(seed) {
    const kv = fauxKv(seed);
    const store = createStore(kv);
    store.init();
    const transport = fauxTransport();
    const sync = createSync({ store, transport });
    return { kv, store, transport, sync };
}

describe('poussée', () => {
    test('envoie les enregistrements en attente et les marque synchronisés', async () => {
        const { store, transport, sync } = monter();
        const id = store.saveConfig({ clientName: 'Dupont', zone: 'Salon', body: corps('Salon') });
        assert.equal(store.getPending().length, 1);

        const res = await sync.run();
        assert.equal(res.ok, true);
        assert.equal(transport.poussees[0].length, 1);
        assert.equal(transport.poussees[0][0].id, id);
        assert.equal(store.getPending().length, 0, 'la file doit être vidée après une poussée réussie');
    });

    test('coalesce : trois modifications hors-ligne ne poussent qu\'une fois, l\'état final', async () => {
        const { store, transport, sync } = monter();
        const id = store.saveConfig({ clientName: 'Dupont', zone: 'v1', body: corps('v1') });
        store.updateConfig(id, { clientName: 'Dupont', zone: 'v2', body: corps('v2') });
        store.updateConfig(id, { clientName: 'Dupont', zone: 'v3', body: corps('v3') });

        await sync.run();
        assert.equal(transport.poussees[0].length, 1, 'un seul enregistrement poussé');
        assert.equal(transport.poussees[0][0].zone, 'v3', 'et c\'est bien l\'état final');
    });

    test('n\'envoie jamais owner ni seq — imposés par le trigger serveur', async () => {
        const { store, transport, sync } = monter();
        store.saveConfig({ clientName: 'Dupont', zone: 'Salon', body: corps('Salon') });
        await sync.run();

        const ligne = transport.poussees[0][0];
        assert.equal('owner' in ligne, false);
        assert.equal('seq' in ligne, false);
    });

    // L'invariant qui rend une coupure réseau inoffensive.
    test('une poussée en échec laisse la file INTACTE', async () => {
        const { store, transport, sync } = monter();
        store.saveConfig({ clientName: 'Dupont', zone: 'Salon', body: corps('Salon') });
        transport.echecPush = { message: 'réseau coupé' };

        const res = await sync.run();
        assert.equal(res.ok, false);
        assert.equal(store.getPending().length, 1, 'on repoussera au prochain passage');
    });

    test('un tirage en échec n\'enchaîne pas sur la poussée', async () => {
        // Le tirage vient en premier (voir le commentaire de run() dans js/sync.js) : s'il
        // échoue, on ne pousse pas — nos modifications n'ont pas encore été confrontées au
        // distant, les envoyer à l'aveugle écraserait potentiellement plus récent.
        const { store, transport, sync } = monter();
        store.saveConfig({ clientName: 'Dupont', zone: 'Salon', body: corps('Salon') });
        transport.echecPull = { message: 'réseau coupé' };

        await sync.run();
        assert.equal(transport.poussees.length, 0, 'aucune poussée à l\'aveugle');
        assert.equal(store.getPending().length, 1, 'et la file reste intacte');
    });

    // La course la plus subtile du lot : l'utilisateur modifie pendant l'aller-retour réseau.
    test('une modification survenue PENDANT la poussée reste en attente', async () => {
        const { store, sync } = monter();
        const id = store.saveConfig({ clientName: 'Dupont', zone: 'v1', body: corps('v1') });

        const transportLent = {
            async push() {
                // Simule l'utilisateur qui modifie alors que la requête est en vol.
                store.updateConfig(id, { clientName: 'Dupont', zone: 'v2', body: corps('v2') });
                return { ok: true };
            },
            async pull() { return { ok: true, rows: [] }; }
        };
        const sync2 = createSync({ store, transport: transportLent });
        await sync2.run();

        assert.equal(store.getPending().length, 1,
            'la modification concurrente ne doit pas être marquée synchronisée par erreur');
        assert.equal(store.getConfig(id).zone, 'v2');
    });
});

describe('tirage', () => {
    const ligneDistante = (id, zone, seq, extra = {}) => ({
        id, client_name: 'Dupont', zone, brand: 'toshiba', mode: 'mono', result_str: `1x ${zone}`,
        body: corps(zone), saved_at: '2026-08-10T10:00:00.000Z', created_at: '2026-08-10T10:00:00.000Z',
        updated_at: '2026-08-10T10:00:00.000Z', deleted_at: null, seq, ...extra
    });

    test('insère les enregistrements inconnus et avance le curseur', async () => {
        const { store, transport, sync } = monter();
        transport.pages = [[ligneDistante('a', 'Salon', 7), ligneDistante('b', 'Chambre', 9)]];

        const res = await sync.run();
        assert.equal(res.ok, true);
        assert.equal(store.listConfigs().length, 2);
        assert.equal(store.getCursor(), 9, 'le curseur prend le seq le plus haut de la page');
    });

    test('un tirage en échec laisse le curseur IMMOBILE', async () => {
        const { store, transport, sync } = monter();
        transport.echecPull = { message: 'réseau coupé' };

        const res = await sync.run();
        assert.equal(res.ok, false);
        assert.equal(store.getCursor(), 0);
    });

    test('adopte une pierre tombale distante : la fiche disparaît de la liste', async () => {
        const { store, transport, sync } = monter();
        transport.pages = [[ligneDistante('a', 'Salon', 7)]];
        await sync.run();
        assert.equal(store.listConfigs().length, 1);

        transport.pages = [[ligneDistante('a', 'Salon', 8, { deleted_at: '2026-08-10T11:00:00.000Z' })]];
        await sync.run();
        assert.equal(store.listConfigs().length, 0, 'la suppression distante doit se propager');
        assert.ok(store.getRaw('a'), 'mais la charge utile reste en base');
    });

    test('pagine tant que le serveur rend une page pleine', async () => {
        const { store, transport, sync } = monter();
        const pleine = Array.from({ length: PAGE_SIZE }, (_, i) => ligneDistante(`p${i}`, `Z${i}`, i + 1));
        transport.pages = [pleine, [ligneDistante('dernier', 'Fin', PAGE_SIZE + 1)]];

        await sync.run();
        assert.equal(store.listConfigs().length, PAGE_SIZE + 1);
        assert.equal(store.getCursor(), PAGE_SIZE + 1);
    });

    test('un enregistrement local propre est écrasé sans créer de conflit', async () => {
        const { store, transport, sync } = monter();
        const id = store.saveConfig({ clientName: 'Dupont', zone: 'local', body: corps('local') });
        await sync.run();                       // pousse : l'enregistrement devient propre

        transport.pages = [[ligneDistante(id, 'modifié ailleurs', 12, { updated_at: '2026-08-11T10:00:00.000Z' })]];
        await sync.run();

        assert.equal(store.getConfig(id).zone, 'modifié ailleurs');
        assert.equal(store.listConflicts().length, 0);
    });
});

describe('conflits — le perdant est conservé', () => {
    test('une modification locale non poussée battue par le distant part en conflit', async () => {
        const { store, transport, sync } = monter();
        const id = store.saveConfig({ clientName: 'Dupont', zone: 'origine', body: corps('origine') });
        await sync.run();                       // synchronisé
        transport.echecPush = { message: 'coupure' };
        store.updateConfig(id, { clientName: 'Dupont', zone: 'ma version', body: corps('ma version') });
        await sync.run();                       // échoue : la modification reste en attente

        // La poussée reste en échec : la modification locale n'a donc PAS atteint le serveur,
        // c'est exactement le cas que la conservation du perdant doit couvrir.
        transport.pages = [[{
            id, client_name: 'Dupont', zone: 'version distante', body: corps('version distante'),
            saved_at: '2026-08-12T10:00:00.000Z', created_at: '2026-08-10T10:00:00.000Z',
            updated_at: '2099-01-01T00:00:00.000Z', deleted_at: null, seq: 20
        }]];
        await sync.run();

        const conflits = store.listConflicts();
        assert.equal(conflits.length, 1, 'la version locale ne doit jamais disparaître en silence');
        assert.equal(conflits[0].zone, 'ma version');
        assert.equal(store.getConfig(id).zone, 'version distante', 'le distant plus récent l\'emporte');
    });

    test('restoreConflict recrée une fiche distincte, sans écraser le gagnant', async () => {
        const { store, transport, sync } = monter();
        const id = store.saveConfig({ clientName: 'Dupont', zone: 'origine', body: corps('origine') });
        await sync.run();
        transport.echecPush = { message: 'coupure' };
        store.updateConfig(id, { clientName: 'Dupont', zone: 'ma version', body: corps('ma version') });
        await sync.run();
        // La poussée reste en échec : la modification locale n'a donc PAS atteint le serveur,
        // c'est exactement le cas que la conservation du perdant doit couvrir.
        transport.pages = [[{
            id, client_name: 'Dupont', zone: 'version distante', body: corps('version distante'),
            saved_at: '2026-08-12T10:00:00.000Z', created_at: '2026-08-10T10:00:00.000Z',
            updated_at: '2099-01-01T00:00:00.000Z', deleted_at: null, seq: 20
        }]];
        await sync.run();

        const nouvelId = store.restoreConflict(store.listConflicts()[0].id);
        assert.ok(nouvelId && nouvelId !== id, 'une fiche distincte, pas un écrasement');
        assert.equal(store.getConfig(id).zone, 'version distante', 'le gagnant reste intact');
        assert.match(store.getConfig(nouvelId).zone, /version de cet appareil/);
        assert.equal(store.listConflicts().length, 0);
    });
});

describe('dérive d\'horloge', () => {
    test('absorbe l\'en-tête Date du serveur, même quand l\'opération échoue', async () => {
        const { store, transport, sync } = monter();
        store.saveConfig({ clientName: 'D', zone: 'S', body: corps('S') });
        transport.echecPush = { message: 'refusé' };
        transport.serverDateMs = Date.now() + 3600_000;   // serveur « en avance » d'une heure

        await sync.run();
        assert.ok(Math.abs(store.getClockState().offsetMs) > 60_000,
            'le serveur a répondu : son heure est exploitable même sur un échec applicatif');
    });

    test('le curseur n\'est jamais dérivé d\'une heure client', async () => {
        const { store, transport, sync } = monter();
        transport.pages = [[{
            id: 'a', client_name: 'D', zone: 'S', body: corps('S'),
            saved_at: '2026-08-10T10:00:00.000Z', created_at: '2026-08-10T10:00:00.000Z',
            updated_at: '2099-01-01T00:00:00.000Z', deleted_at: null, seq: 42
        }]];
        await sync.run();
        assert.equal(store.getCursor(), 42, 'le curseur est le seq serveur, pas un horodatage');
    });
});

describe('robustesse', () => {
    test('deux run() concurrents : le second est refusé, pas exécuté en double', async () => {
        const { store, sync } = monter();
        store.saveConfig({ clientName: 'D', zone: 'S', body: corps('S') });

        const [a, b] = await Promise.all([sync.run(), sync.run()]);
        const refus = [a, b].filter((r) => r.error && r.error.dejaEnCours);
        assert.equal(refus.length, 1, 'exactement un des deux doit être refusé');
    });

    test('l\'état exposé passe par offline sur panne et revient à idle au succès', async () => {
        const { store, transport, sync } = monter();
        store.saveConfig({ clientName: 'D', zone: 'S', body: corps('S') });

        transport.echecPush = { message: 'coupure' };
        await sync.run();
        assert.equal(sync.getState().phase, 'offline');
        assert.equal(sync.getState().pending, 1);

        transport.echecPush = null;
        await sync.run();
        assert.equal(sync.getState().phase, 'idle');
        assert.equal(sync.getState().pending, 0);
    });

    test('en mode dégradé, rien n\'est poussé ni appliqué', async () => {
        // Stockage illisible au démarrage : le magasin refuse toute écriture, la
        // synchronisation ne doit pas contourner ce refus.
        const kv = {
            get(key) { return key === DATA_KEY ? { ok: false, reason: 'illisible' } : { ok: false, reason: 'absent' }; },
            set() { return { ok: true }; }
        };
        const store = createStore(kv);
        store.init();
        assert.equal(store.isDegraded(), 'illisible');

        const transport = fauxTransport();
        transport.pages = [[{
            id: 'a', client_name: 'D', zone: 'S', body: corps('S'),
            saved_at: '2026-08-10T10:00:00.000Z', created_at: '2026-08-10T10:00:00.000Z',
            updated_at: '2026-08-10T10:00:00.000Z', deleted_at: null, seq: 3
        }]];
        await createSync({ store, transport }).run();

        assert.equal(transport.poussees.length, 0, 'rien à pousser depuis un magasin dégradé');
        assert.equal(store.listConfigs().length, 0, 'et rien n\'est appliqué localement');
    });
});
