// Le mode admin déverrouille des marques que le client ne doit pas voir, et sa sortie fait
// retomber la marque courante sans que personne ne le demande explicitement. Deux endroits où
// une erreur ne se voit pas à l'écran : d'où ces tests sur la résolution, en amont du DOM.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { codeAdminDansUrl, codeAdminValide, resoudreMarquesActives } from '../js/admin.js';
import { ADMIN_CODE } from '../js/config.js';
import { MARQUES_ACTIVES, MARQUES_CONNUES, resoudreMarque, selecteurMarqueVisible } from '../js/marques.js';

describe('codeAdminDansUrl', () => {
    test('extrait le code du paramètre admin', () => {
        assert.equal(codeAdminDansUrl('?admin=secret'), 'secret');
        assert.equal(codeAdminDansUrl('admin=secret'), 'secret');
        assert.equal(codeAdminDansUrl('?dept=33&admin=secret#ancre'), 'secret');
    });

    test('rend null quand il n\'y a rien à lire', () => {
        for (const v of ['', '?', '?dept=33', null, undefined]) {
            assert.equal(codeAdminDansUrl(v), null, `devrait rendre null pour ${JSON.stringify(v)}`);
        }
    });

    // Sans ce cas, `?admin=` (ou `?admin=%20`) produisait une chaîne vide, comparée ensuite à
    // ADMIN_CODE — un déverrouillage général le jour où la constante serait laissée vide.
    test('un paramètre vide ou blanc ne produit pas de code', () => {
        assert.equal(codeAdminDansUrl('?admin='), null);
        assert.equal(codeAdminDansUrl('?admin=%20%20'), null);
    });
});

describe('codeAdminValide', () => {
    test('accepte le code configuré, exactement', () => {
        assert.equal(codeAdminValide(ADMIN_CODE), true);
        assert.equal(codeAdminValide(ADMIN_CODE.toUpperCase()), false);
        assert.equal(codeAdminValide(`${ADMIN_CODE} `), false);
    });

    test('refuse tout le reste', () => {
        for (const v of ['', null, undefined, 'admin', 'true', '1']) {
            assert.equal(codeAdminValide(v), false, `devrait refuser ${JSON.stringify(v)}`);
        }
    });
});

describe('resoudreMarquesActives — l\'ordre des trois couches', () => {
    // La règle décidée : un compte connecté prime sur le mode admin, pour que se connecter au
    // compte d'un client montre exactement ce que ce client voit.
    test('les droits du compte priment sur le mode admin', () => {
        const compte = ['toshiba'];
        const admin = ['toshiba', 'panasonic'];
        assert.deepEqual(resoudreMarquesActives(compte, admin, MARQUES_ACTIVES), compte);
    });

    test('le mode admin prend le relais hors compte', () => {
        const admin = ['toshiba', 'panasonic'];
        assert.deepEqual(resoudreMarquesActives(null, admin, MARQUES_ACTIVES), admin);
    });

    test('sans compte ni mode admin, la constante locale décide', () => {
        assert.deepEqual(resoudreMarquesActives(null, null, MARQUES_ACTIVES), MARQUES_ACTIVES);
    });
});

describe('effet du mode admin sur le sélecteur', () => {
    test('déverrouille toutes les marques connues du catalogue', () => {
        const actives = resoudreMarquesActives(null, [...MARQUES_CONNUES], MARQUES_ACTIVES);
        assert.ok(actives.includes('panasonic'), 'Panasonic doit redevenir sélectionnable');
        assert.equal(selecteurMarqueVisible(actives), true);
    });

    // Le piège de la sortie de mode : un calcul ou un chantier sur une marque désormais
    // interdite ne doit jamais rester affiché sous cette marque — resoudreMarque le ramène.
    test('quitter le mode ramène une marque devenue interdite sur la marque par défaut', () => {
        const apresSortie = resoudreMarquesActives(null, null, MARQUES_ACTIVES);
        assert.equal(resoudreMarque('panasonic', apresSortie), 'toshiba');
        assert.equal(selecteurMarqueVisible(apresSortie), false);
    });

    // Sur un compte, le mode admin n'ajoute ni ne retire rien : le quitter est sans effet, et
    // l'application ne doit donc pas prévenir d'une perte de marque qui n'aura pas lieu.
    test('sur un compte, entrer ou sortir du mode ne change pas la liste', () => {
        const compte = ['toshiba', 'panasonic'];
        const avec = resoudreMarquesActives(compte, [...MARQUES_CONNUES], MARQUES_ACTIVES);
        const sans = resoudreMarquesActives(compte, null, MARQUES_ACTIVES);
        assert.deepEqual(avec, sans);
    });
});
