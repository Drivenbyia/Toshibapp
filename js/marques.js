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

// Toutes les marques que le catalogue connaît, actives ou non — BRAND_LABELS liste déjà
// exactement une entrée par marque catalogue (data.js), c'est donc la source de vérité pour
// « quelles marques existent », indépendamment de celles autorisées pour un compte donné.
//
// Sert à générer le sélecteur de marque dans le DOM (voir genererBoutonsMarque, app.js) :
// un bouton par marque connue, que initSelecteurMarque masque ensuite selon les droits du
// compte. Sans ce registre, ajouter une marque exigeait d'écrire un <button data-brand="...">
// à la main dans index.html en plus de renseigner ses données dans data.js.
export const MARQUES_CONNUES = Object.keys(BRAND_LABELS);

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
