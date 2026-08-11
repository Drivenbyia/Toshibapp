// Test de non-régression du script scripts/valider-marque.mjs — pas de sa logique interne
// (déjà exercée à la main pendant son écriture), mais de son comportement observable en tant
// que script : bon code de sortie, bon message, pour les cas qui comptent le plus. Lancé en
// sous-processus (aucune dépendance ajoutée) : c'est un script autonome, pas un module à
// importer proprement (il exécute sa validation au chargement, à partir de process.argv).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'valider-marque.mjs');

function lancer(args) {
    try {
        const stdout = execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
        return { code: 0, stdout };
    } catch (e) {
        return { code: e.status, stdout: e.stdout || '' };
    }
}

describe('scripts/valider-marque.mjs', () => {
    test('marque réelle et complète (toshiba) : succès, code 0', () => {
        const { code, stdout } = lancer(['toshiba']);
        assert.equal(code, 0);
        assert.match(stdout, /Aucune erreur/);
    });

    test('marque connue mais sans base TVA (panasonic) : succès avec avertissement, pas une erreur', () => {
        const { code, stdout } = lancer(['panasonic']);
        assert.equal(code, 0);
        assert.match(stdout, /avertissement/);
        assert.match(stdout, /TVA_RULES\.panasonic est absent/);
    });

    test('marque absente du catalogue : échec, code 1, erreurs nommées', () => {
        const { code, stdout } = lancer(['daikin']);
        assert.equal(code, 1);
        assert.match(stdout, /CATALOGS\.daikin est absent/);
        assert.match(stdout, /UI_SIZE_TABLES\.daikin est absent/);
        assert.match(stdout, /BRAND_LABELS\.daikin est absent/);
    });

    test('aucun argument : usage affiché, code 1', () => {
        const { code } = lancer([]);
        assert.equal(code, 1);
    });

    test('clé mal formée (majuscule) : erreur explicite plutôt qu\'une validation silencieusement fausse', () => {
        const { code, stdout } = lancer(['Daikin']);
        assert.equal(code, 1);
        assert.match(stdout, /minuscules et sans espace/);
    });
});
