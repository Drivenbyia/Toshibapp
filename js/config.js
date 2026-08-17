// Identité applicative et configuration de connexion aux comptes. Aucune étape de build ici :
// ce sont de vraies constantes JS, pas des variables d'environnement — la clé publique
// Supabase est conçue pour être embarquée côté client (elle n'autorise rien à elle seule,
// c'est la sécurité au niveau des lignes — RLS — posée côté serveur qui protège les données,
// voir le plan de mise sur le marché).
//
// ⚠️ Valeurs à remplacer avant d'activer les comptes en production : créer le projet
// Supabase, y appliquer le schéma (table `entitlements`, RLS), désactiver l'inscription
// publique, puis copier ici l'URL du projet et sa clé publique (« anon key »), visibles
// dans Project Settings → API de la console Supabase.
//
// Tant qu'elles gardent leur valeur de substitution, l'écran de connexion s'affiche
// normalement mais indique que la configuration est manquante plutôt que d'échouer en
// silence (voir js/supabase-client.js) — et surtout, aucun appel réseau n'est jamais
// déclenché pour un utilisateur qui ne touche pas au bouton de connexion : l'application
// reste intégralement utilisable hors-ligne, exactement comme avant ce lot.
export const SUPABASE_URL = 'https://VOTRE-PROJET.supabase.co';
export const SUPABASE_ANON_KEY = 'VOTRE_CLE_ANON_PUBLIQUE';

// Code du mode admin (voir js/admin.js) : ouvrir une fois `…/?admin=<ce code>` déverrouille le
// sélecteur de marque avec toutes les marques du catalogue, sur cet appareil et durablement.
//
// ⚠️ Ce n'est pas un secret et ne doit jamais être vendu comme une protection : ce fichier est
// servi en clair à tous les navigateurs, comme tout le JavaScript de l'application. Le code
// écarte la découverte accidentelle, pas quelqu'un qui cherche. Le changer se fait ici, en une
// ligne (tous les appareils déjà déverrouillés le restent — voir quitterModeAdmin).
export const ADMIN_CODE = 'klimo-atelier';

export function supabaseConfigured() {
    return !SUPABASE_URL.includes('VOTRE-PROJET') && !SUPABASE_ANON_KEY.includes('VOTRE_CLE');
}
