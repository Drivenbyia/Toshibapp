// Marques proposées dans l'interface.
//
// Masquer une marque n'en supprime NI le catalogue, NI les gammes, NI les règles de TVA :
// tout reste intact dans data.js et calcul.js, qui ne contiennent aucun branchement par
// marque — la marque n'y est qu'une clé de lecture dans des tables. Réactiver une marque
// est donc une seule ligne ici.
//
// À l'étape « comptes », MARQUES_ACTIVES cessera d'être une constante pour venir du profil
// de l'utilisateur connecté ; toutes les fonctions ci-dessous acceptent déjà la liste en
// paramètre, et rien d'autre ne changera.

import { BRAND_LABELS } from './data.js';

export const MARQUES_ACTIVES = ['toshiba'];

export function marqueAutorisee(marque, actives = MARQUES_ACTIVES) {
    return actives.includes(marque);
}

export function marqueParDefaut(actives = MARQUES_ACTIVES) {
    return actives[0];
}

// Ramène toute marque inconnue ou désactivée sur la marque par défaut. C'est le garde
// unique des chemins de restauration : un chantier ou un brouillon enregistré du temps où
// une marque était active porte encore son nom, et le passait jusqu'ici sans validation.
export function resoudreMarque(marque, actives = MARQUES_ACTIVES) {
    return marqueAutorisee(marque, actives) ? marque : marqueParDefaut(actives);
}

export function libelleMarque(marque) {
    return BRAND_LABELS[marque] || marque;
}

// Le sélecteur de marque n'a pas lieu d'être quand une seule marque est proposée : il
// afficherait un choix unique, non actionnable.
export function selecteurMarqueVisible(actives = MARQUES_ACTIVES) {
    return actives.length > 1;
}
