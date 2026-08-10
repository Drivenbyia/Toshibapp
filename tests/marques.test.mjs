// Le masquage d'une marque touche des chemins où une erreur ne se voit pas : une marque
// enregistrée dans un ancien chantier qui repasse en douce, ou un dimensionnement recalculé
// contre le mauvais catalogue. D'où ces tests sur la résolution de marque.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    MARQUES_ACTIVES, marqueAutorisee, marqueParDefaut, resoudreMarque, libelleMarque,
    selecteurMarqueVisible
} from '../js/marques.js';
import { CATALOGS, GAMMES_INFO, BRAND_LABELS } from '../js/data.js';

describe('marqueAutorisee', () => {
    test('accepte une marque active, refuse une marque masquée', () => {
        assert.equal(marqueAutorisee('toshiba', ['toshiba']), true);
        assert.equal(marqueAutorisee('panasonic', ['toshiba']), false);
    });

    test('refuse une marque inconnue plutôt que de la laisser passer', () => {
        for (const v of ['daikin', '', null, undefined, 'TOSHIBA']) {
            assert.equal(marqueAutorisee(v, ['toshiba']), false, `devrait refuser ${JSON.stringify(v)}`);
        }
    });
});

describe('resoudreMarque — le garde des chemins de restauration', () => {
    // Le scénario réel : un chantier ou un brouillon enregistré du temps où Panasonic était
    // proposé porte encore `brand: 'panasonic'`, et passait sans validation.
    test('ramène une marque masquée sur la marque par défaut', () => {
        assert.equal(resoudreMarque('panasonic', ['toshiba']), 'toshiba');
    });

    test('laisse intacte une marque autorisée', () => {
        assert.equal(resoudreMarque('panasonic', ['toshiba', 'panasonic']), 'panasonic');
    });

    test('rattrape toute valeur aberrante', () => {
        for (const v of [null, undefined, '', 'daikin', 42, {}]) {
            assert.equal(resoudreMarque(v, ['toshiba']), 'toshiba');
        }
    });

    test('respecte l\'ordre : la première marque active est la marque par défaut', () => {
        assert.equal(marqueParDefaut(['panasonic', 'toshiba']), 'panasonic');
        assert.equal(resoudreMarque('daikin', ['panasonic', 'toshiba']), 'panasonic');
    });
});

describe('selecteurMarqueVisible', () => {
    test('masque le sélecteur quand une seule marque est proposée', () => {
        assert.equal(selecteurMarqueVisible(['toshiba']), false);
        assert.equal(selecteurMarqueVisible(['toshiba', 'panasonic']), true);
    });
});

describe('libelleMarque', () => {
    test('rend le libellé constructeur', () => {
        assert.equal(libelleMarque('toshiba'), 'Toshiba');
        assert.equal(libelleMarque('panasonic'), 'Panasonic');
    });

    // Remplace un ternaire binaire qui affichait « Panasonic » pour toute valeur inattendue.
    test('ne se rabat jamais sur un libellé constructeur arbitraire', () => {
        assert.equal(libelleMarque('daikin'), 'daikin');
        assert.notEqual(libelleMarque('daikin'), 'Panasonic');
    });
});

// Garde-fou du lot : on masque, on ne supprime pas. Si quelqu'un « nettoie » un jour les
// données Panasonic, ces tests tombent et rappellent que la marque doit rester réactivable
// en changeant une seule ligne de js/marques.js.
describe('la marque masquée reste entièrement présente dans les données', () => {
    test('Panasonic n\'est pas dans les marques actives', () => {
        assert.equal(MARQUES_ACTIVES.includes('panasonic'), false,
            'ce test documente la configuration courante — à mettre à jour si Panasonic est réactivé');
    });

    test('son catalogue est intact', () => {
        assert.ok(CATALOGS.panasonic, 'CATALOGS.panasonic doit rester présent');
        assert.ok(CATALOGS.panasonic.monosplits.length > 0);
        assert.ok(CATALOGS.panasonic.multisplits_groupes_exterieurs.length > 0);
    });

    test('ses gammes et son libellé sont intacts', () => {
        assert.ok(GAMMES_INFO.panasonic);
        assert.ok(Object.keys(GAMMES_INFO.panasonic).length > 0);
        assert.equal(BRAND_LABELS.panasonic, 'Panasonic');
    });

    test('la réactiver ne demande que d\'ajouter la marque à la liste', () => {
        const actives = ['toshiba', 'panasonic'];
        assert.equal(marqueAutorisee('panasonic', actives), true);
        assert.equal(resoudreMarque('panasonic', actives), 'panasonic');
        assert.equal(selecteurMarqueVisible(actives), true);
    });
});
