// Première couverture de test du code de persistance : jusqu'ici seul le cœur de calcul
// était testé, alors que c'est la perte de chantiers qui coûte un client.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    FORMAT_SAUVEGARDE, formeChantiersValide, signatureConfig, sauvegardeValide,
    fusionnerChantiers, construireSauvegarde, compterChantiers
} from '../js/sauvegarde.js';

const cfg = (zone, date = '10/08/2026 15:31', resultStr = '1x Mono Shorai Edge') =>
    ({ zone, date, resultStr, mode: 'mono', brand: 'toshiba', rooms: [], selection: {} });

const chantiers = (obj) => Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k, { configurations: v }]));

describe('formeChantiersValide', () => {
    test('accepte la forme réelle du localStorage', () => {
        assert.equal(formeChantiersValide(chantiers({ Dupont: [cfg('Salon')] })), true);
    });

    test('accepte un objet vide (aucun chantier enregistré)', () => {
        assert.equal(formeChantiersValide({}), true);
    });

    // Ces valeurs sont analysables en JSON mais partaient droit dans Object.keys() /
    // .configurations et cassaient le rendu du dashboard.
    test('rejette les valeurs analysables mais corrompues', () => {
        for (const v of [null, [], 'texte', 42, { Dupont: null }, { Dupont: {} },
                         { Dupont: { configurations: 'pas un tableau' } }, { Dupont: [] }]) {
            assert.equal(formeChantiersValide(v), false, `devrait rejeter ${JSON.stringify(v)}`);
        }
    });
});

describe('sauvegardeValide', () => {
    test('accepte un fichier produit par construireSauvegarde', () => {
        const fichier = construireSauvegarde(chantiers({ Dupont: [cfg('Salon')] }), new Date());
        assert.equal(sauvegardeValide(fichier), true);
    });

    test('rejette un JSON quelconque qui n\'est pas une sauvegarde', () => {
        for (const v of [null, {}, { format: 'autre-chose', chantiers: {} },
                         { format: FORMAT_SAUVEGARDE }, { format: FORMAT_SAUVEGARDE, chantiers: [] }]) {
            assert.equal(sauvegardeValide(v), false, `devrait rejeter ${JSON.stringify(v)}`);
        }
    });
});

describe('fusionnerChantiers — la restauration ne doit jamais détruire', () => {
    test('ajoute un client absent', () => {
        const res = fusionnerChantiers(
            chantiers({ Dupont: [cfg('Salon')] }),
            chantiers({ Martin: [cfg('Cuisine')] }));

        assert.deepEqual(Object.keys(res.chantiers).sort(), ['Dupont', 'Martin']);
        assert.equal(res.ajoutes, 1);
        assert.equal(res.ignores, 0);
    });

    test('complète un client existant sans toucher à ses zones', () => {
        const res = fusionnerChantiers(
            chantiers({ Dupont: [cfg('Salon')] }),
            chantiers({ Dupont: [cfg('Chambre')] }));

        assert.deepEqual(res.chantiers.Dupont.configurations.map(c => c.zone), ['Salon', 'Chambre']);
        assert.equal(res.ajoutes, 1);
    });

    // Le scénario qui compte : restaurer deux fois le même fichier ne doit pas doubler
    // l'historique du client.
    test('est idempotente — réimporter le même fichier n\'ajoute rien', () => {
        const actuel = chantiers({ Dupont: [cfg('Salon'), cfg('Chambre')] });
        const premier = fusionnerChantiers(actuel, actuel);
        const second = fusionnerChantiers(premier.chantiers, actuel);

        assert.equal(premier.ajoutes, 0);
        assert.equal(premier.ignores, 2);
        assert.equal(second.ajoutes, 0);
        assert.deepEqual(second.chantiers, actuel);
    });

    // Le scénario redouté : restaurer une vieille sauvegarde par-dessus du travail récent.
    test('ne perd jamais une zone saisie depuis la sauvegarde', () => {
        const recent = chantiers({ Dupont: [cfg('Salon'), cfg('Véranda', '01/09/2026 09:00')] });
        const vieille = chantiers({ Dupont: [cfg('Salon')] });
        const res = fusionnerChantiers(recent, vieille);

        assert.ok(res.chantiers.Dupont.configurations.some(c => c.zone === 'Véranda'),
            'la zone récente doit survivre à la restauration d\'une sauvegarde antérieure');
        assert.equal(res.ajoutes, 0);
        assert.equal(res.ignores, 1);
    });

    test('deux relevés de même zone à des dates différentes sont conservés tous les deux', () => {
        const res = fusionnerChantiers(
            chantiers({ Dupont: [cfg('Salon', '10/08/2026 15:31')] }),
            chantiers({ Dupont: [cfg('Salon', '12/08/2026 09:00')] }));

        assert.equal(res.chantiers.Dupont.configurations.length, 2);
        assert.equal(res.ajoutes, 1);
    });

    test('ne mute pas l\'objet source', () => {
        const actuel = chantiers({ Dupont: [cfg('Salon')] });
        const copie = JSON.parse(JSON.stringify(actuel));
        fusionnerChantiers(actuel, chantiers({ Dupont: [cfg('Chambre')] }));

        assert.deepEqual(actuel, copie, 'fusionnerChantiers doit être sans effet de bord');
    });

    test('les noms de client à apostrophe restent des clés distinctes', () => {
        const res = fusionnerChantiers(
            chantiers({ "L'Atelier": [cfg('Salon')] }),
            chantiers({ "L'Atelier": [cfg('Bureau')] }));

        assert.equal(Object.keys(res.chantiers).length, 1);
        assert.equal(res.chantiers["L'Atelier"].configurations.length, 2);
    });
});

describe('construireSauvegarde / compterChantiers', () => {
    test('horodate en ISO, pas au format d\'affichage fr-FR', () => {
        const fichier = construireSauvegarde({}, new Date('2026-08-10T15:31:00Z'));
        assert.equal(fichier.exporteLe, '2026-08-10T15:31:00.000Z');
        assert.equal(fichier.format, FORMAT_SAUVEGARDE);
        assert.equal(fichier.version, 1);
    });

    test('compte les clients et les zones', () => {
        const { clients, configs } = compterChantiers(
            chantiers({ Dupont: [cfg('Salon'), cfg('Chambre')], Martin: [cfg('Cuisine')] }));

        assert.equal(clients, 2);
        assert.equal(configs, 3);
    });
});

describe('signatureConfig', () => {
    test('distingue deux relevés qui ne diffèrent que par le matériel proposé', () => {
        assert.notEqual(
            signatureConfig(cfg('Salon', '10/08/2026 15:31', '1x Mono Shorai Edge')),
            signatureConfig(cfg('Salon', '10/08/2026 15:31', '1x Mono Yukai')));
    });
});
