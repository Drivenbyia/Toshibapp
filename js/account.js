// Machine à états de session et droits (marques autorisées). Seul point d'accès à l'état
// d'authentification pour le reste de l'application. js/supabase-client.js n'est jamais
// importé statiquement ici — uniquement à la demande (login/logout/vérification) — pour
// qu'un utilisateur qui ne touche jamais à la connexion ne déclenche aucune requête réseau
// ni chargement du SDK : l'application reste utilisable hors-ligne, exactement comme avant
// ce lot. Aucune synchronisation de chantiers ici — hors périmètre (comptes et droits
// seulement, voir le plan de mise sur le marché).

import { MARQUES_CONNUES } from './marques.js';

const SESSION_HINT_KEY = 'klimo:v2:auth:session_hint';
const ENTITLEMENTS_KEY = 'klimo:v2:auth:entitlements';

// --- Fonctions pures — aucun DOM, aucun réseau, aucune horloge lue directement ---

// Règle non négociable : seule une réponse DÉFINITIVE du serveur (400/401) fait basculer en
// session révoquée. Toute absence de réponse concluante — panne réseau, CORS, 5xx, délai
// dépassé, ou même une session simplement absente sans erreur explicite — doit rester
// `stale`. C'est cette distinction, et elle seule, qui garantit qu'une coupure réseau ne
// bloque jamais l'accès aux données locales (le vide sanitaire sans barre de réseau).
export function classifySessionCheckFailure(error) {
    const status = error && error.status;
    if (status === 400 || status === 401) return 'definitive';
    return 'transport';
}

export function nextAuthState(current, event) {
    switch (event.type) {
        case 'login_success': return 'authenticated';
        case 'logout': return 'anonymous';
        case 'session_check_ok': return 'authenticated';
        case 'session_check_failed':
            return event.reason === 'definitive' ? 'revoked' : 'stale';
        default: return current;
    }
}

// `null` signale « pas de surcharge, laisser js/marques.js piloter seul » — le cas d'un
// appareil jamais connecté, pour ne rien changer au comportement du lot précédent. Une
// session avec des droits en cache renvoie ces droits même en `stale` : les droits déjà
// obtenus s'appliquent hors-ligne, ils n'attendent pas une reconfirmation réseau.
// Filtre les marques sur celles que le catalogue CONNAÎT réellement (MARQUES_CONNUES, dérivée
// de BRAND_LABELS dans data.js) avant de les renvoyer. Sans ce filtre, une faute de frappe en
// base ('Daikin' au lieu de 'daikin', ou une marque retirée du catalogue) traversait toute la
// chaîne sans le moindre diagnostic : marqueAutorisee la validait (elle est bien dans la liste
// reçue), setBrand l'acceptait, et le premier calcul plantait sur CATALOGS['Daikin'].monosplits
// — une TypeError, pour un client qui vient de payer, sans qu'aucun message n'explique pourquoi.
//
// Une cellule Postgres mal saisie doit dégrader le compte vers son repli sûr, pas le rendre
// inutilisable : si le filtrage ne laisse plus aucune marque valide, on retombe sur le même
// ['toshiba'] que pour des droits absents ou vides.
export function resolveBrands(status, cachedEntitlements) {
    if (status === 'anonymous') return null;
    if (!cachedEntitlements || !Array.isArray(cachedEntitlements.brands) || !cachedEntitlements.brands.length) {
        return ['toshiba'];
    }
    const connues = cachedEntitlements.brands.filter((m) => MARQUES_CONNUES.includes(m));
    return connues.length ? connues : ['toshiba'];
}

// --- État et orchestration ---

let status = 'anonymous';
let userEmail = null;
let entitlements = null;
const listeners = new Set();

function notify() { listeners.forEach((fn) => fn()); }

function lireJson(cle) {
    try { return JSON.parse(localStorage.getItem(cle) || 'null'); }
    catch (e) { return null; }
}
function ecrireJson(cle, valeur) {
    try { localStorage.setItem(cle, JSON.stringify(valeur)); } catch (e) { /* tant pis */ }
}
function effacer(cle) {
    try { localStorage.removeItem(cle); } catch (e) { /* ignoré */ }
}

// Restaure l'état depuis le cache local — jamais de réseau ici — puis, seulement si un
// indice de session existe, tente une vérification en arrière-plan sans jamais bloquer le
// premier rendu (voir verifySession, volontairement non attendu). Un appareil jamais
// connecté ne déclenche aucun appel : `status` reste `anonymous` et rien de plus ne se passe.
export function init() {
    entitlements = lireJson(ENTITLEMENTS_KEY);
    const indice = lireJson(SESSION_HINT_KEY);
    if (indice && indice.email) {
        userEmail = indice.email;
        // Session non encore reconfirmée pour cette ouverture : `stale` plutôt que
        // `authenticated`, avec les droits déjà en cache qui s'appliquent immédiatement.
        status = 'stale';
        verifySession();
    }
}

// js/supabase-client.js est précaché (voir sw.js) : ce chargement ne devrait normalement
// jamais échouer. Il reste protégé quand même — un échec ici (cache corrompu, fichier
// oublié du precache) doit dégrader comme n'importe quelle autre panne de transport, jamais
// planter avec une exception non rattrapée au milieu de login()/logout()/verifySession().
async function chargerSupabaseClient() {
    try { return await import('./supabase-client.js'); }
    catch (e) { return null; }
}

async function verifySession() {
    const supa = await chargerSupabaseClient();
    if (!supa) {
        status = nextAuthState(status, { type: 'session_check_failed', reason: 'transport' });
        notify();
        return;
    }
    const res = await supa.checkSession();
    if (res.ok) {
        status = nextAuthState(status, { type: 'session_check_ok' });
    } else {
        const raison = classifySessionCheckFailure(res.error);
        status = nextAuthState(status, { type: 'session_check_failed', reason: raison });
    }
    notify();
}

export async function login(email, password) {
    const supa = await chargerSupabaseClient();
    if (!supa) return { ok: false, error: null };
    const res = await supa.signIn(email, password);
    if (!res.ok) return { ok: false, error: res.error };

    userEmail = (res.user && res.user.email) || email;
    ecrireJson(SESSION_HINT_KEY, { email: userEmail, userId: res.user && res.user.id });
    status = nextAuthState(status, { type: 'login_success' });

    if (res.user && res.user.id) {
        entitlements = await supa.fetchEntitlements(res.user.id);
        ecrireJson(ENTITLEMENTS_KEY, entitlements);
    }
    notify();
    return { ok: true };
}

export async function logout() {
    // La déconnexion locale a lieu même si l'appel réseau échoue, ou si le module lui-même
    // n'a pas pu être chargé (hors-ligne notamment) : rester bloqué en "connecté" localement
    // parce que le serveur est injoignable serait pire que l'inverse.
    const supa = await chargerSupabaseClient();
    if (supa) await supa.signOut().catch(() => {});
    effacer(SESSION_HINT_KEY);
    effacer(ENTITLEMENTS_KEY);
    userEmail = null;
    entitlements = null;
    status = nextAuthState(status, { type: 'logout' });
    notify();
}

export function getStatus() { return status; }
export function getUserEmail() { return userEmail; }
export function getBrandsOverride() { return resolveBrands(status, entitlements); }
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
