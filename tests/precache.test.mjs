// Garde-fou de déploiement : la liste PRECACHE_URLS de sw.js est maintenue à la main, et
// un module oublié ne casse rien en développement — il casse le hors-ligne, en production,
// silencieusement, plusieurs jours après le déploiement. Ce test rend l'oubli impossible.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Extrait le tableau PRECACHE_URLS de sw.js par lecture textuelle (pas d'import : le
// fichier référence `self`, absent de Node).
function readPrecacheUrls() {
    const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
    const match = sw.match(/const PRECACHE_URLS\s*=\s*\[([\s\S]*?)\]/);
    assert.ok(match, "PRECACHE_URLS introuvable dans sw.js — le test doit être mis à jour avec le fichier");
    return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

// Modules ES réellement chargés par le navigateur. `js/package.json` n'en est pas un, et
// un éventuel `js/vendor/` doit être listé comme le reste.
function listJsModules(dir = 'js') {
    const out = [];
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) out.push(...listJsModules(rel));
        else if (entry.name.endsWith('.js')) out.push(`./${rel}`);
    }
    return out;
}

describe('sw.js — exhaustivité du precache', () => {
    test('tout module de js/ est précaché', () => {
        const precached = new Set(readPrecacheUrls());
        const manquants = listJsModules().filter((f) => !precached.has(f));

        assert.deepEqual(
            manquants,
            [],
            `Module(s) absent(s) de PRECACHE_URLS dans sw.js : ${manquants.join(', ')}. ` +
            `Sans cette entrée, le fichier est indisponible hors-ligne.`
        );
    });

    test('aucune entrée de PRECACHE_URLS ne pointe vers un fichier absent', () => {
        const modulesExistants = new Set(listJsModules());
        const fantomes = readPrecacheUrls()
            .filter((u) => u.startsWith('./js/'))
            .filter((u) => !modulesExistants.has(u));

        assert.deepEqual(
            fantomes,
            [],
            `Entrée(s) de PRECACHE_URLS sans fichier correspondant : ${fantomes.join(', ')}. ` +
            `cache.addAll() rejette en bloc : l'installation du service worker échouerait entièrement.`
        );
    });

    test('aucune URL distante n\'est précachée', () => {
        const distantes = readPrecacheUrls().filter((u) => /^https?:\/\//.test(u));

        assert.deepEqual(
            distantes,
            [],
            `URL distante(s) dans PRECACHE_URLS : ${distantes.join(', ')}. ` +
            `Le hors-ligne des données distantes est le magasin local, jamais le cache HTTP.`
        );
    });
});
