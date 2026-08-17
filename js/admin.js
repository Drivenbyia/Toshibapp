// Mode admin : déverrouille le sélecteur de marque avec TOUTES les marques du catalogue, sur
// un appareil précis, sans compte ni réseau.
//
// Le besoin : un client artisan paie pour une marque et n'en voit qu'une (MARQUES_ACTIVES,
// js/marques.js). Mais l'exploitant de Klimo, lui, pose plusieurs marques dans sa propre
// journée et doit pouvoir basculer de l'une à l'autre — y compris dans un vide sanitaire sans
// barre de réseau, ce qui exclut de faire dépendre ce basculement d'une session serveur.
//
// ⚠️ Ce n'est PAS un contrôle d'accès, et il ne faut jamais le présenter comme tel : ADMIN_CODE
// vit dans js/config.js, servi en clair à tout le monde comme le reste du JavaScript. Qui ouvre
// le fichier trouve le code. Ça écarte la découverte accidentelle par un client curieux, rien de
// plus. La seule barrière réelle qui existera un jour est la colonne `entitlements.brands` côté
// Postgres — et même elle ne masque que l'interface, les catalogues de data.js étant publics
// (voir docs/ajouter-une-marque.md §5).

import { MARQUES_CONNUES } from './marques.js';
import { ADMIN_CODE } from './config.js';
import { kvGet, kvSet, kvRemove } from './kv.js';

const CLE_ADMIN = 'klimo:v2:admin:mode';

// --- Fonctions pures — aucun DOM, aucun stockage ---

// Extrait le code du paramètre `?admin=`. Rend `null` pour un paramètre absent ou vide plutôt
// qu'une chaîne vide : sans ça, un `?admin=` seul serait comparé à ADMIN_CODE et déverrouillerait
// tout si quelqu'un laissait un jour la constante à '' dans config.js.
export function codeAdminDansUrl(search) {
    let params;
    try {
        // L'ancre est coupée d'abord : window.location.search n'en contient jamais, mais
        // URLSearchParams ne la retire pas non plus, et un appelant qui passerait une URL
        // entière récolterait un code « secret#ancre » qui ne correspondrait à rien.
        params = new URLSearchParams(String(search || '').split('#')[0]);
    } catch (e) {
        return null;
    }
    const brut = params.get('admin');
    if (typeof brut !== 'string') return null;
    const code = brut.trim();
    return code ? code : null;
}

export function codeAdminValide(code) {
    // Un ADMIN_CODE vide ou laissé à sa valeur de substitution ne déverrouille jamais rien,
    // quel que soit le paramètre passé dans l'URL.
    if (!ADMIN_CODE || ADMIN_CODE.includes('VOTRE_')) return false;
    return code === ADMIN_CODE;
}

// Ordre de priorité de la liste de marques effective, en un seul endroit testable.
//
// Le compte prime volontairement sur le mode admin : se connecter au compte d'un client doit
// montrer exactement ce que ce client a sous les yeux, sinon reproduire un problème qu'il
// signale devient impossible — on verrait toujours plus de marques que lui. Le mode admin
// reprend la main dès la déconnexion.
export function resoudreMarquesActives(marquesCompte, marquesAdminEventuelles, marquesLocales) {
    return marquesCompte || marquesAdminEventuelles || marquesLocales;
}

// --- État et orchestration ---

let actif = false;

function lireEtatPersiste() {
    const res = kvGet(CLE_ADMIN);
    // Une lecture qui échoue (navigation privée, quota) ou une valeur corrompue laisse le mode
    // désactivé : le repli sûr est toujours le comportement client normal.
    return res.ok && res.value === true;
}

// Retire `?admin=` de la barre d'adresse une fois le mode activé, en préservant les autres
// paramètres et l'ancre. Le code ne survit ainsi ni à une capture d'écran montrée sur chantier,
// ni à un lien partagé, ni à un favori — le mode, lui, reste dans localStorage. Un code ERRONÉ
// n'est pas nettoyé : la faute de frappe doit rester visible pour être corrigée.
function nettoyerUrl() {
    try {
        const url = new URL(window.location.href);
        url.searchParams.delete('admin');
        window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    } catch (e) {
        /* replaceState indisponible (file://, navigateur ancien) : sans effet, mode actif quand même */
    }
}

// À appeler une fois au démarrage, AVANT la construction du sélecteur de marque.
export function initAdmin(search) {
    actif = lireEtatPersiste();
    const code = codeAdminDansUrl(search);
    if (code && codeAdminValide(code)) {
        actif = true;
        kvSet(CLE_ADMIN, true);
        nettoyerUrl();
    }
    return actif;
}

export function estAdmin() { return actif; }

// `null` — et non un tableau vide — signale « pas de surcharge, laisser la couche suivante
// décider », exactement comme getBrandsOverride() dans js/account.js.
//
// Rend une copie de MARQUES_CONNUES, dérivée de BRAND_LABELS (js/data.js) : toute marque
// ajoutée au catalogue apparaît donc ici sans une ligne de code de plus.
export function marquesAdmin() {
    return actif ? [...MARQUES_CONNUES] : null;
}

export function quitterModeAdmin() {
    actif = false;
    kvRemove(CLE_ADMIN);
}
