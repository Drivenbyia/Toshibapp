// La migration doit être sans perte par construction : chaque champ de l'ancien
// enregistrement doit se retrouver soit dans `body`, soit dans `legacy`. C'est le point le
// plus critique du lot — c'est l'unique copie des chantiers du client qui est en jeu.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrDate, formatDateDisplay, migrateV1ToV2 } from '../js/migration.js';

const NOW = '2026-08-10T12:00:00.000Z';
let compteur = 0;
const newId = () => `id-${++compteur}`;

const room = { id: 1, nom: '', surface: 25, height: 2.5, emplacement: 'plain_pied',
    orientation: 'sud', vitrage: 'moyen', protection: 'stores_int', occupants: 2, expositionMurs: 2 };

const cfg = (overrides = {}) => ({
    zone: 'Salon', mode: 'mono', brand: 'toshiba', usage: 'reversible',
    resultStr: '1x Mono Shorai Edge', equipments: ['RAS-B10'], roomDetails: ['Pièce 1'],
    params: { deptSelect: '69', altitude: '0 à 200m', isolationCoef: '0.8', customCoef: '', consigneInt: '26' },
    rooms: [room], selection: { mono: 0, dedicated: {}, group: {}, groupChoice: 0 },
    date: '10/08/2026 15:31',
    ...overrides
});

describe('parseFrDate', () => {
    test('reparse le format produit par toLocaleString fr-FR', () => {
        const iso = parseFrDate('10/08/2026 15:31', NOW);
        assert.notEqual(iso, NOW);
        const d = new Date(iso);
        assert.equal(d.getFullYear(), 2026);
        assert.equal(d.getMonth(), 7);   // août = index 7
        assert.equal(d.getDate(), 10);
        assert.equal(d.getHours(), 15);
        assert.equal(d.getMinutes(), 31);
    });

    test('tolère une virgule ou une espace insécable étroite comme séparateur', () => {
        assert.notEqual(parseFrDate('10/08/2026, 15:31', NOW), NOW);
        assert.notEqual(parseFrDate('10/08/2026 15:31', NOW), NOW);
    });

    test('replie sur nowIso pour toute entrée illisible', () => {
        for (const v of ['', 'pas une date', '2026-08-10', null, undefined, 42, '10/08/2026']) {
            assert.equal(parseFrDate(v, NOW), NOW, `devrait replier sur nowIso pour ${JSON.stringify(v)}`);
        }
    });

    test('rejette un débordement calendaire silencieux (ex. jour 32)', () => {
        // new Date(2026, 0, 32, ...) glisserait vers le 1er février sans lever — on refuse.
        assert.equal(parseFrDate('32/01/2026 10:00', NOW), NOW);
        assert.equal(parseFrDate('01/13/2026 10:00', NOW), NOW);
    });
});

describe('formatDateDisplay', () => {
    test('produit un format lisible fr-FR', () => {
        const s = formatDateDisplay('2026-08-10T13:31:00.000Z');
        assert.match(s, /\d{2}\/\d{2}\/\d{4}/);
    });
});

describe('migrateV1ToV2 — sans perte', () => {
    test('un blob vide produit un magasin vide valide', () => {
        for (const blob of [{}, null, undefined]) {
            const m = migrateV1ToV2(blob, { nowIso: NOW, newId });
            assert.equal(m.schema, 2);
            assert.deepEqual(m.configs, {});
            assert.deepEqual(m.outbox, []);
            assert.equal(m.cursor.seq, 0);
        }
    });

    test('chaque champ métier atterrit dans body, inchangé', () => {
        const m = migrateV1ToV2({ Dupont: { configurations: [cfg()] } }, { nowIso: NOW, newId });
        const rec = Object.values(m.configs)[0];
        assert.equal(rec.clientName, 'Dupont');
        assert.equal(rec.zone, 'Salon');
        assert.equal(rec.body.mode, 'mono');
        assert.equal(rec.body.brand, 'toshiba');
        assert.equal(rec.body.resultStr, '1x Mono Shorai Edge');
        assert.deepEqual(rec.body.equipments, ['RAS-B10']);
        assert.deepEqual(rec.body.roomDetails, ['Pièce 1']);
        assert.deepEqual(rec.body.rooms, [room]);
        assert.deepEqual(rec.body.selection, cfg().selection);
        assert.deepEqual(rec.body.params, cfg().params);
    });

    test('conserve la chaîne de date d\'origine même quand elle est illisible', () => {
        const m = migrateV1ToV2({ Dupont: { configurations: [cfg({ date: 'texte incompréhensible' })] } },
            { nowIso: NOW, newId });
        const rec = Object.values(m.configs)[0];
        assert.equal(rec.legacy.date, 'texte incompréhensible');
        assert.equal(rec.savedAt, NOW); // repli, mais rien n'est perdu : legacy.date garde l'original
    });

    test('marque legacyIncomplete les enregistrements sans rooms (pré-migration app)', () => {
        const sansRooms = cfg({ rooms: [] });
        delete sansRooms.rooms;
        const m = migrateV1ToV2({ Dupont: { configurations: [sansRooms] } }, { nowIso: NOW, newId });
        const rec = Object.values(m.configs)[0];
        assert.equal(rec.legacyIncomplete, true);
    });

    test('ne marque pas legacyIncomplete un enregistrement normal', () => {
        const m = migrateV1ToV2({ Dupont: { configurations: [cfg()] } }, { nowIso: NOW, newId });
        assert.equal(Object.values(m.configs)[0].legacyIncomplete, false);
    });

    test('préserve l\'ordre d\'origine via legacy.index, par client', () => {
        const m = migrateV1ToV2({
            Dupont: { configurations: [cfg({ zone: 'Salon' }), cfg({ zone: 'Chambre' })] }
        }, { nowIso: NOW, newId });
        const recs = Object.values(m.configs).sort((a, b) => a.legacy.index - b.legacy.index);
        assert.deepEqual(recs.map((r) => r.zone), ['Salon', 'Chambre']);
        assert.deepEqual(recs.map((r) => r.legacy.index), [0, 1]);
    });

    test('deux orthographes de client restent deux chantiers distincts (aucun trim/normalisation)', () => {
        const m = migrateV1ToV2({
            'Dupont': { configurations: [cfg()] },
            ' Dupont ': { configurations: [cfg({ zone: 'Autre' })] },
            'DUPONT': { configurations: [cfg({ zone: 'Encore' })] }
        }, { nowIso: NOW, newId });
        const noms = new Set(Object.values(m.configs).map((r) => r.clientName));
        assert.deepEqual(noms, new Set(['Dupont', ' Dupont ', 'DUPONT']));
    });

    test('des identifiants stables et uniques sont générés pour chaque enregistrement', () => {
        const m = migrateV1ToV2({
            Dupont: { configurations: [cfg(), cfg({ zone: 'Chambre' })] },
            Martin: { configurations: [cfg({ zone: 'Cuisine' })] }
        }, { nowIso: NOW, newId });
        const ids = Object.keys(m.configs);
        assert.equal(ids.length, 3);
        assert.equal(new Set(ids).size, 3);
        // Chaque clé de la map correspond bien à l'id du record qu'elle contient.
        ids.forEach((id) => assert.equal(m.configs[id].id, id));
    });

    test('les métadonnées de synchro sont initialisées à un état "jamais synchronisé"', () => {
        const m = migrateV1ToV2({ Dupont: { configurations: [cfg()] } }, { nowIso: NOW, newId });
        const rec = Object.values(m.configs)[0];
        assert.equal(rec.rev, 1);
        assert.equal(rec.syncedRev, 0);
        assert.equal(rec.deletedAt, null);
        assert.equal(rec.createdAt, rec.savedAt);
        assert.equal(rec.updatedAt, rec.savedAt);
    });

    test('un client sans tableau configurations ne fait pas planter la migration', () => {
        const m = migrateV1ToV2({ Dupont: {} }, { nowIso: NOW, newId });
        assert.deepEqual(m.configs, {});
    });
});
