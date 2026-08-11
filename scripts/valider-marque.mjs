#!/usr/bin/env node
// Valide les données d'une marque ajoutée à js/data.js, AVANT de la proposer à un client.
//
// Usage : node scripts/valider-marque.mjs <clé-marque>
// Exemple, une fois les entrées "daikin" ajoutées à data.js : node scripts/valider-marque.mjs daikin
//
// Ne remplace pas une relecture humaine du catalogue face à la documentation constructeur —
// vérifie uniquement que la FORME des données est celle que le moteur de calcul attend, et que
// rien n'y manque au point de faire planter l'application ou de dégrader silencieusement vers
// « à vérifier ». Voir docs/ajouter-une-marque.md pour le schéma complet et le contexte.
//
// Aucune dépendance : lit directement js/data.js et js/calcul.js (modules ES natifs), comme le
// reste du projet.

import { CATALOGS, UI_SIZE_TABLES, BRAND_LABELS, GAMMES_INFO, TVA_RULES, SUFFIXES_MILLESIME_GROUPE }
    from '../js/data.js';
import { getUiSizeForKw } from '../js/calcul.js';

const brand = process.argv[2];
const erreurs = [];
const avertissements = [];

function erreur(msg) { erreurs.push(msg); }
function avertir(msg) { avertissements.push(msg); }

if (!brand) {
    console.error('Usage : node scripts/valider-marque.mjs <clé-marque>');
    console.error('Exemple : node scripts/valider-marque.mjs daikin');
    process.exit(1);
}

if (brand !== brand.toLowerCase() || /\s/.test(brand)) {
    erreur(`la clé « ${brand} » doit être en minuscules et sans espace — c'est elle qui sert de `
        + `valeur dans entitlements.brands, dans state.brand, et dans les attributs data-brand du DOM.`);
}

// --- 1. CATALOGS[brand] ---------------------------------------------------------------

const catalogue = CATALOGS[brand];
if (!catalogue) {
    erreur(`CATALOGS.${brand} est absent. C'est le premier TypeError que rencontrera l'application `
        + `(findBestMonos, calcul.js) — rien d'autre ne peut être vérifié tant que ce bloc n'existe pas.`);
} else {
    if (!Array.isArray(catalogue.monosplits)) erreur(`CATALOGS.${brand}.monosplits doit être un tableau (même vide).`);
    if (!Array.isArray(catalogue.multisplits_groupes_exterieurs)) erreur(`CATALOGS.${brand}.multisplits_groupes_exterieurs doit être un tableau (même vide).`);
}

const monosplits = catalogue?.monosplits || [];
const groupes = catalogue?.multisplits_groupes_exterieurs || [];
const gammesConnues = new Set();
const referencesVues = new Set();

monosplits.forEach((m, i) => {
    const label = `CATALOGS.${brand}.monosplits[${i}]`;
    if (!m.gamme || typeof m.gamme !== 'string') erreur(`${label}.gamme manquant ou non-texte.`);
    else gammesConnues.add(m.gamme);
    if (!m.reference_ensemble || typeof m.reference_ensemble !== 'string') {
        erreur(`${label}.reference_ensemble manquant ou non-texte.`);
    } else if (referencesVues.has(m.reference_ensemble)) {
        erreur(`${label}.reference_ensemble « ${m.reference_ensemble} » est un doublon — deux entrées `
            + `avec la même référence rendent la recherche de taille (tailleDepuisReference, calcul.js) ambiguë.`);
    } else {
        referencesVues.add(m.reference_ensemble);
    }
    if (!Number.isFinite(m.puissance_froid_kw) || m.puissance_froid_kw <= 0) erreur(`${label}.puissance_froid_kw doit être un nombre positif.`);
    if (!Number.isFinite(m.puissance_chaud_kw) || m.puissance_chaud_kw <= 0) erreur(`${label}.puissance_chaud_kw doit être un nombre positif.`);
});

groupes.forEach((g, i) => {
    const label = `CATALOGS.${brand}.multisplits_groupes_exterieurs[${i}]`;
    if (!g.reference || typeof g.reference !== 'string') erreur(`${label}.reference manquant ou non-texte.`);
    if (!Number.isInteger(g.max_unites_interieures) || g.max_unites_interieures <= 0) erreur(`${label}.max_unites_interieures doit être un entier positif.`);
    if (!Number.isFinite(g.puissance_nominale_froid_kw) || g.puissance_nominale_froid_kw <= 0) erreur(`${label}.puissance_nominale_froid_kw doit être un nombre positif.`);
    if (!Number.isFinite(g.puissance_nominale_chaud_kw) || g.puissance_nominale_chaud_kw <= 0) erreur(`${label}.puissance_nominale_chaud_kw doit être un nombre positif.`);
    if (g.gammes_compatibles !== undefined) {
        if (!Array.isArray(g.gammes_compatibles)) {
            erreur(`${label}.gammes_compatibles doit être un tableau s'il est présent (absent = aucune restriction, [] = tout exclu).`);
        } else {
            for (const gamme of g.gammes_compatibles) {
                if (!gammesConnues.has(gamme)) {
                    erreur(`${label}.gammes_compatibles cite « ${gamme} », absente des gammes déclarées en monosplit.`);
                }
            }
            if (g.gammes_compatibles.length === 0) {
                avertir(`${label}.gammes_compatibles est un tableau VIDE : ceci exclut TOUTES les gammes `
                    + `du groupe (différent d'omettre le champ, qui n'exclut rien) — vérifier que c'est voulu.`);
            }
        }
    }
});

// --- 2. UI_SIZE_TABLES[brand] ----------------------------------------------------------

const table = UI_SIZE_TABLES[brand];
if (!table) {
    erreur(`UI_SIZE_TABLES.${brand} est absent. getUiSizeForKw (calcul.js) y renvoie déjà null `
        + `proprement (pas de plantage), mais aucune taille ne sera jamais affichée ni utilisable `
        + `pour le rattachement TVA en multisplit.`);
} else if (!Array.isArray(table) || table.length === 0) {
    erreur(`UI_SIZE_TABLES.${brand} doit être un tableau non vide de { code, froidMax, chaudMax }.`);
} else {
    const codesVus = new Set();
    table.forEach((row, i) => {
        const label = `UI_SIZE_TABLES.${brand}[${i}]`;
        if (!row.code || typeof row.code !== 'string') erreur(`${label}.code manquant ou non-texte.`);
        else if (codesVus.has(row.code)) erreur(`${label}.code « ${row.code} » est un doublon.`);
        else codesVus.add(row.code);
        if (!Number.isFinite(row.froidMax) || row.froidMax <= 0) erreur(`${label}.froidMax doit être un nombre positif.`);
        if (!Number.isFinite(row.chaudMax) || row.chaudMax <= 0) erreur(`${label}.chaudMax doit être un nombre positif.`);
        if (i > 0) {
            if (row.froidMax < table[i - 1].froidMax) erreur(`${label}.froidMax (${row.froidMax}) doit être ≥ au palier précédent (${table[i - 1].froidMax}) — la table doit être triée par puissance croissante.`);
            if (row.chaudMax < table[i - 1].chaudMax) erreur(`${label}.chaudMax (${row.chaudMax}) doit être ≥ au palier précédent (${table[i - 1].chaudMax}).`);
        }
    });

    // Chaque entrée monosplit doit obtenir une taille : sinon getUiSizeForKw renvoie null pour
    // une machine pourtant bien réelle du catalogue — signe que la table s'arrête trop bas.
    if (catalogue) {
        for (const m of monosplits) {
            const code = getUiSizeForKw(m.puissance_froid_kw, m.puissance_chaud_kw, brand);
            if (!code) {
                erreur(`Aucune taille de UI_SIZE_TABLES.${brand} ne couvre « ${m.reference_ensemble} » `
                    + `(${m.puissance_froid_kw} kW F / ${m.puissance_chaud_kw} kW C) — ajouter un palier `
                    + `au moins égal à cette puissance.`);
            }
        }
    }
}

// --- 3. BRAND_LABELS[brand] -------------------------------------------------------------

if (!BRAND_LABELS[brand] || typeof BRAND_LABELS[brand] !== 'string') {
    erreur(`BRAND_LABELS.${brand} est absent. Sans lui, le libellé affiché (PDF, partage, bouton) `
        + `retombe sur la clé technique brute (ex. « ${brand} » au lieu d'un nom présentable).`);
}

// --- 4. GAMMES_INFO[brand] (informatif, n'entre jamais dans le calcul) ------------------

const gammesInfo = GAMMES_INFO[brand];
if (!gammesInfo) {
    avertir(`GAMMES_INFO.${brand} est absent : le « Guide de la gamme » restera vide pour cette `
        + `marque (dégradation propre, aucun plantage), mais c'est un vrai différenciateur commercial `
        + `de l'outil — à renseigner si le temps le permet.`);
} else {
    for (const gamme of gammesConnues) {
        if (!gammesInfo[gamme]) {
            avertir(`GAMMES_INFO.${brand}["${gamme}"] est absent : le guide de cette gamme sera vide.`);
        }
    }
}

// --- 5. TVA_RULES[brand] (entièrement optionnel) ----------------------------------------

const tva = TVA_RULES[brand];
if (!tva) {
    avertir(`TVA_RULES.${brand} est absent : l'application l'assume et affiche une pastille `
        + `« TVA non renseignée » explicite pour cette marque (jamais de silence, voir renderTvaBadge, `
        + `app.js) — mais si un tableau d'éligibilité constructeur existe, c'est ici qu'il faudrait `
        + `le transcrire.`);
} else {
    if (tva.mono) {
        for (const [gamme, regle] of Object.entries(tva.mono)) {
            if (!gammesConnues.has(gamme)) avertir(`TVA_RULES.${brand}.mono cite la gamme « ${gamme} », absente du catalogue monosplit.`);
            if (!Array.isArray(regle.taillesEligibles) || !Array.isArray(regle.taillesNonEligibles)) {
                erreur(`TVA_RULES.${brand}.mono["${gamme}"] doit avoir taillesEligibles ET taillesNonEligibles (tableaux, même vides).`);
            }
        }
    }
    if (tva.multi) {
        if (!Array.isArray(tva.multi.groupesEligibles)) erreur(`TVA_RULES.${brand}.multi.groupesEligibles doit être un tableau.`);
        if (!Array.isArray(tva.multi.gammesUi)) erreur(`TVA_RULES.${brand}.multi.gammesUi doit être un tableau.`);
        if (!SUFFIXES_MILLESIME_GROUPE[brand]) {
            avertir(`TVA_RULES.${brand}.multi existe mais SUFFIXES_MILLESIME_GROUPE.${brand} est absent : `
                + `si les références du catalogue portent un suffixe de millésime que le tableau `
                + `constructeur omet (comme "-E1" chez Toshiba), la comparaison échouera sans le dire — `
                + `vérifier si c'est le cas pour cette marque avant de considérer le multisplit fiable.`);
        }
    }
}

// --- Rapport -------------------------------------------------------------------------

console.log(`\nValidation de la marque « ${brand} »\n${'─'.repeat(40)}`);
if (avertissements.length) {
    console.log(`\n⚠️  ${avertissements.length} avertissement(s) — n'empêchent pas de vendre, à lire quand même :\n`);
    avertissements.forEach((a) => console.log(`  • ${a}`));
}
if (erreurs.length) {
    console.log(`\n❌ ${erreurs.length} erreur(s) — à corriger avant de proposer cette marque à un client :\n`);
    erreurs.forEach((e) => console.log(`  • ${e}`));
    console.log('');
    process.exit(1);
}
console.log(`\n✅ Aucune erreur. Le bouton de sélection se génère automatiquement (voir `
    + `genererBoutonsMarque, app.js) — aucun fichier HTML à toucher. Prochaine étape : le runbook `
    + `« ajouter un client » dans docs/ajouter-une-marque.md.\n`);
