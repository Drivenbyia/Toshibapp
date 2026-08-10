// Enveloppe fine autour du SDK Supabase — le SEUL module qui touche au réseau pour
// l'authentification. Chargé à la demande uniquement (import dynamique du SDK, jamais en
// haut de fichier) : un utilisateur qui ne touche jamais au bouton de connexion ne déclenche
// aucune requête réseau ni téléchargement du SDK, et l'application reste utilisable
// hors-ligne exactement comme avant ce lot. Aucune donnée de chantier ne transite ici — la
// synchronisation des chantiers est hors périmètre de ce lot (comptes et droits seulement).
//
// Aucun bundler dans ce projet : le SDK est chargé depuis un CDN ESM-natif, ce qu'un
// <script type="module"> sait faire directement, sans étape de build. Version figée pour la
// reproductibilité — à mettre à jour explicitement, jamais en suivant une plage flottante.
const SDK_URL = 'https://esm.sh/@supabase/supabase-js@2.45.4';

import { SUPABASE_URL, SUPABASE_ANON_KEY, supabaseConfigured } from './config.js';

let clientPromise = null;

function getClient() {
    if (!clientPromise) {
        clientPromise = import(SDK_URL).then(({ createClient }) => createClient(SUPABASE_URL, SUPABASE_ANON_KEY));
    }
    return clientPromise;
}

// Toutes les fonctions ci-dessous renvoient soit { ok:true, ... }, soit { ok:false, error }.
// `error` porte un `status` HTTP quand la réponse vient effectivement du serveur ; son
// absence signale un échec de transport (réseau coupé, CORS, délai dépassé). C'est
// délibérément CE module-ci qui ne classe rien : la classification transport/définitif est
// un point unique, pur et testé dans js/account.js (classifySessionCheckFailure) — la
// dupliquer ici créerait deux endroits à maintenir en cohérence.

export async function signIn(email, password) {
    if (!supabaseConfigured()) return { ok: false, error: { nonConfigure: true } };
    let client;
    try { client = await getClient(); }
    catch (e) { return { ok: false, error: e }; }

    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) return { ok: false, error };
    return { ok: true, session: data.session, user: data.user };
}

export async function signOut() {
    if (!supabaseConfigured()) return;
    try {
        const client = await getClient();
        await client.auth.signOut();
    } catch (e) {
        // La déconnexion locale a lieu malgré tout (voir account.js) : rien à faire ici.
    }
}

export async function checkSession() {
    if (!supabaseConfigured()) return { ok: false, error: { nonConfigure: true } };
    let client;
    try { client = await getClient(); }
    catch (e) { return { ok: false, error: e }; }

    const { data, error } = await client.auth.getSession();
    if (error) return { ok: false, error };
    // Pas d'erreur mais pas de session non plus (jeton expiré et non renouvelable, etc.) :
    // ni un échec réseau ni une révocation confirmée par le serveur — traité comme un
    // transport pour ne jamais verrouiller l'accès local sur cette seule absence.
    if (!data.session) return { ok: false, error: null };
    return { ok: true, session: data.session };
}

// Dégrade toujours vers l'abonnement Toshiba seul plutôt que d'échouer bruyamment : une
// ligne `entitlements` absente ou une panne réseau ne doit jamais empêcher l'usage local.
export async function fetchEntitlements(userId) {
    if (!supabaseConfigured()) return { brands: ['toshiba'] };
    try {
        const client = await getClient();
        const { data, error } = await client
            .from('entitlements')
            .select('brands, plan')
            .eq('user_id', userId)
            .maybeSingle();
        if (error || !data || !Array.isArray(data.brands) || !data.brands.length) {
            return { brands: ['toshiba'] };
        }
        return { brands: data.brands, plan: data.plan || 'trial' };
    } catch (e) {
        return { brands: ['toshiba'] };
    }
}
