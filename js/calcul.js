// Fonctions de calcul de Klimo — bilan thermique et sélection matériel.
// Module de fonctions PURES : aucun accès au DOM, aucune lecture/écriture d'état applicatif.
// Toutes les entrées (climat, coefficients, marque...) sont passées en paramètres explicites,
// ce qui les rend testables indépendamment de l'interface (voir tests/calcul.test.mjs).
import {
    CATALOGS, UI_SIZE_TABLES, TVA_RULES,
    APPORTS_INTERNES, CHARGE_TOITURE, RAYONNEMENT_VITRAGE, RATIO_VITRAGE, FC_PROTECTION,
    G_VITRAGE, COEF_INERTIE_SOLAIRE, OCCUPANT_W, COEF_RELANCE, COEF_G_DEFAUT,
    CONSIGNE_REFERENCE, ABATTEMENT_CANICULE_SEUIL_BAS, ABATTEMENT_CANICULE_SEUIL_HAUT,
    ABATTEMENT_CANICULE_MAX, DECLASSEMENT_CHAUD_PALIERS,
    TOLERANCE_EQUIVALENCE, SEUIL_DESEQUILIBRE_GROUPE, SEUIL_SOUS_CHARGE_ESCALADE
} from './data.js';

// Nombre d'occupants par défaut (≈ 1 pers. / 15 m²) tant que rien n'est saisi.
export function occupantsParDefaut(surface) {
    return surface ? Math.max(1, Math.round(surface / 15)) : '';
}

// Lecture d'un nombre saisi au clavier, en acceptant la virgule décimale.
//
// Indispensable ici : les champs sont saisis par des artisans français, qui tapent « 2,5 »
// pour une hauteur sous plafond. Les champs étaient en `type="number"`, dont la valeur est
// une chaîne VIDE dès que le contenu n'est pas un nombre au format anglo-saxon — la virgule
// n'atteignait donc même pas JavaScript. Une hauteur « 2,5 » devenait 0, le volume devenait 0,
// et le besoin chaud s'affichait à 0.00 kW sans le moindre avertissement. Les champs sont
// désormais en `type="text" inputmode="decimal"` (le pavé numérique reste proposé sur mobile)
// et la normalisation se fait ici.
//
// Renvoie NaN sur une saisie non numérique, à charge de l'appelant de décider quoi en faire :
// cette fonction ne choisit jamais de valeur de repli à la place du métier.
export function parseNombreSaisi(valeur) {
    if (typeof valeur === 'number') return valeur;
    if (valeur === null || valeur === undefined) return NaN;
    const normalise = String(valeur).trim().replace(',', '.');
    if (normalise === '') return NaN;
    return Number(normalise);
}

// Coefficient G résolu à partir de la sélection (valeur numérique ou "custom"), avec repli sur
// la valeur par défaut si la saisie personnalisée est vide ou invalide (évite la propagation de
// NaN dans tout le calcul).
export function resolveCoefG(selectVal, customVal) {
    const raw = selectVal === 'custom' ? parseNombreSaisi(customVal) : parseNombreSaisi(selectVal);
    return Number.isFinite(raw) && raw > 0 ? raw : COEF_G_DEFAUT;
}

// Marge canicule : la puissance froid catalogue (donnée à 35°C ext.) chute réellement au-delà
// (pointes 40-42°C). Interpolée sur la température de base été elle-même plutôt que sur une
// liste de zones — voir data.js pour la régression que ça corrige (zone F sans marge alors que
// plus chaude que la zone B, qui en avait une).
export function getFacteurCanicule(tBaseEte) {
    if (!Number.isFinite(tBaseEte) || tBaseEte <= ABATTEMENT_CANICULE_SEUIL_BAS) return 1.0;
    const t = Math.min(1, (tBaseEte - ABATTEMENT_CANICULE_SEUIL_BAS) / (ABATTEMENT_CANICULE_SEUIL_HAUT - ABATTEMENT_CANICULE_SEUIL_BAS));
    return 1 + t * (ABATTEMENT_CANICULE_MAX - 1);
}

// Interpolation du ratio de capacité chaud restant à une température de base donnée, à partir
// des paliers génériques DECLASSEMENT_CHAUD_PALIERS (voir data.js pour les réserves sur cette
// approximation).
export function ratioDeclassementChaud(tBaseHiver) {
    const p = DECLASSEMENT_CHAUD_PALIERS;
    if (tBaseHiver >= p[0].temp) return p[0].ratio;
    if (tBaseHiver <= p[p.length - 1].temp) return p[p.length - 1].ratio;
    for (let i = 0; i < p.length - 1; i++) {
        const a = p[i], b = p[i + 1];
        if (tBaseHiver <= a.temp && tBaseHiver >= b.temp) {
            const t = (tBaseHiver - a.temp) / (b.temp - a.temp);
            return a.ratio + t * (b.ratio - a.ratio);
        }
    }
    return 1;
}

// Multiplicateur à appliquer au besoin chaud réel pour obtenir la puissance nominale (+7°C)
// requise en catalogue — symétrique de getFacteurCanicule() côté froid.
export function getFacteurDeclassementChaud(tBaseHiver) {
    const ratio = ratioDeclassementChaud(tBaseHiver);
    return ratio > 0 ? 1 / ratio : 1;
}

// Estimation indicative de l'impact de la consigne sur le besoin froid, sur un profil de pièce
// type (20 m², vitrage moyen, protection stores, orientation mixte, plain-pied). Affichage
// informatif uniquement : le poids réel de la consigne dépend de l'exposition solaire propre à
// chaque pièce (voir getRequiredKw) et peut donc varier sensiblement.
export function estimerEcartConsigne(consigne, coefG, tBaseEte) {
    const surfaceRef = 20, heightRef = 2.5;
    function froidPour(c) {
        const volume = surfaceRef * heightRef;
        const deltaTEte = Math.max(0, tBaseEte - c);
        const bandeIso = coefG <= 0.35 ? 'bonne' : (coefG <= 0.8 ? 'moyenne' : 'faible');
        const qEnveloppe = coefG * volume * deltaTEte;
        const qToiture = CHARGE_TOITURE[bandeIso] * 0.5 * surfaceRef;
        const qSolaire = RAYONNEMENT_VITRAGE.mixte * G_VITRAGE * FC_PROTECTION.stores_int * COEF_INERTIE_SOLAIRE * surfaceRef * RATIO_VITRAGE.moyen;
        const qInternesBase = APPORTS_INTERNES * surfaceRef;
        const qOccupants = occupantsParDefaut(surfaceRef) * OCCUPANT_W;
        return qEnveloppe + qToiture + qSolaire + qInternesBase + qOccupants;
    }
    const ref = froidPour(CONSIGNE_REFERENCE);
    if (!ref) return 0;
    return ((froidPour(consigne) - ref) / ref) * 100;
}

// Bilan thermique froid/chaud d'une pièce. Entièrement pure : toutes les données climatiques et
// le coefficient d'isolation sont fournis en paramètres (ctx), rien n'est lu depuis le DOM.
// ctx attendu : { coefG, tBaseHiver, tBaseEte, consigne }
export function getRequiredKw(surface, height, room, ctx) {
    const { coefG, tBaseHiver, tBaseEte, consigne } = ctx;
    const volume = surface * height;

    // Ratio d'exposition : G·V·ΔT est une méthode de bilan bâtiment global (6 faces
    // déperditives) ; appliquée telle quelle pièce par pièce, elle surestime les pièces
    // intérieures entourées d'autres pièces chauffées. Approximation générique (pas de
    // géométrie de bâtiment réelle en entrée) : on réduit le G·V·ΔT au prorata du nombre
    // de murs donnant sur l'extérieur déclaré (4/4 = comportement identique à avant ce
    // correctif, valeur par défaut de toute pièce non renseignée).
    const expositionSaisie = parseFloat(room.expositionMurs);
    const nbMursExt = Number.isFinite(expositionSaisie) ? Math.min(4, Math.max(1, expositionSaisie)) : 4;
    const ratioExposition = nbMursExt / 4;

    // --- CHAUD : méthode déperditions (coefficient volumique G · V · ΔT) ---
    const deltaTChaud = 20 - tBaseHiver;
    const deperditionsSeches = (volume * coefG * deltaTChaud * ratioExposition) / 1000;
    const besoinChaud = deperditionsSeches * COEF_RELANCE;

    // --- FROID : bilan poste par poste (enveloppe + toiture + solaire + internes + occupants) ---
    // Le coefficient G (hivernal) capte la transmission des parois et le renouvellement d'air
    // mais ignore le rayonnement solaire estival ; on ajoute donc explicitement la surcharge
    // toiture et les apports solaires par les vitrages, postes dominants du froid en été.
    const deltaTEte = Math.max(0, tBaseEte - consigne);

    // Bande d'isolation dérivée du G (pour la surcharge toiture).
    const bandeIso = coefG <= 0.35 ? 'bonne' : (coefG <= 0.8 ? 'moyenne' : 'faible');

    // 1. Enveloppe : transmission des parois + air neuf (via G), pondérée par l'exposition.
    const qEnveloppe = coefG * volume * deltaTEte * ratioExposition;   // W

    // 2. Toiture : surcharge solaire si la pièce est sous la couverture. Approximation
    //    connue et non résolue : le G capte déjà la transmission de toute l'enveloppe,
    //    toiture comprise (voir plus haut), donc cette surcharge se cumule en partie avec
    //    une part déjà comptée dans qEnveloppe pour les pièces sous toiture — sans données
    //    de géométrie réelle (surface de toiture distincte des murs), on ne peut pas isoler
    //    proprement cette part pour la retrancher. Le double comptage biaise vers une
    //    surestimation (donc un sur-dimensionnement), jamais vers un déficit de puissance.
    //    plain_pied = combles perdus isolés (apport modéré) → demi-surcharge.
    const chargeToit = CHARGE_TOITURE[bandeIso];
    const qToiture = room.emplacement === 'sous_toiture' ? chargeToit * surface
                   : room.emplacement === 'plain_pied'   ? chargeToit * 0.5 * surface
                   : 0;                              // W

    // 3. Solaire : rayonnement × facteur g × protection × inertie × surface vitrée estimée.
    const rayon     = RAYONNEMENT_VITRAGE[room.orientation] ?? RAYONNEMENT_VITRAGE.mixte;
    const ratioVit  = RATIO_VITRAGE[room.vitrage] ?? RATIO_VITRAGE.moyen;
    const fc        = FC_PROTECTION[room.protection] ?? FC_PROTECTION.stores_int;
    const sVitree   = surface * ratioVit;
    const qSolaire  = rayon * G_VITRAGE * fc * COEF_INERTIE_SOLAIRE * sVitree; // W

    // 4. Apports internes de base : éclairage + équipements.
    const qInternesBase = APPORTS_INTERNES * surface; // W

    // 5. Occupants (sensible + latent). Si non saisi, on estime ≈ 1 pers. / 15 m².
    // Un 0 explicitement saisi (pièce inoccupée) doit rester 0, pas retomber sur l'estimation :
    // on ne bascule sur la valeur par défaut que si le champ est réellement vide.
    const occupantsSaisis = room.occupants === '' || room.occupants === null || room.occupants === undefined
        ? null : parseFloat(room.occupants);
    const nbOcc = Number.isFinite(occupantsSaisis) ? occupantsSaisis : (occupantsParDefaut(surface) || 0);
    const qOccupants = nbOcc * OCCUPANT_W;            // W

    const besoinFroid = (qEnveloppe + qToiture + qSolaire + qInternesBase + qOccupants) / 1000;

    return { froid: besoinFroid, chaud: besoinChaud };
}

// Code taille UI (ex: "10") pour un besoin donné, propre à la marque. Renvoie la plus petite
// taille qui couvre le besoin EN FROID ET EN CHAUD, ou null si aucune n'y suffit — ce null est
// ce qui déclenche le délestage d'une pièce vers un monosplit dédié en multisplit (voir app.js).
//
// Les deux plafonds sont confrontés séparément à leur besoin respectif. Comparer un unique
// `Math.max(reqFroid, reqChaud)` à un unique seuil, comme c'était le cas, revenait à traiter
// les deux puissances comme interchangeables : le besoin froid pouvait alors être validé contre
// une capacité chaud, systématiquement plus élevée sur une PAC air/air (voir UI_SIZE_TABLES).
export function getUiSizeForKw(reqFroid, reqChaud, brand) {
    const table = UI_SIZE_TABLES[brand];
    if (!table) return null;
    for (const row of table) {
        if (reqFroid <= row.froidMax && reqChaud <= row.chaudMax) return row.code;
    }
    return null;
}

// --- ALGORITHME DE SÉLECTION INTELLIGENTE ---
// Ne retourne QUE les gammes qui ont exactement la meilleure (plus petite) puissance requise,
// avec une tolérance de +15% pour regrouper les équivalents (ex: 4.6kW et 5.0kW).
export function findBestMonos(reqF, reqC, brand) {
    let allSols = CATALOGS[brand].monosplits.filter(p => p.puissance_froid_kw >= reqF && p.puissance_chaud_kw >= reqC)
                               .sort((a, b) => a.puissance_froid_kw - b.puissance_froid_kw);

    if (allSols.length === 0) return [];

    const minFroid = allSols[0].puissance_froid_kw;
    return allSols.filter(p => p.puissance_froid_kw <= minFroid * TOLERANCE_EQUIVALENCE);
}

// Classe des solutions techniquement équivalentes en mettant devant celles éligibles à la TVA 5,5%
// EN MONOSPLIT : sur des machines interchangeables, 14,5 points de TVA pèsent plus que l'écart
// matériel, et la première option de la liste est celle proposée par défaut. Aucune option n'est
// retirée : les machines en TVA 20% restent sélectionnables, avec leur pastille.
// Réservé au contexte monosplit (machine vendue en UE dédiée) : en multisplit l'éligibilité vient du
// groupe extérieur et ne départage plus les gammes, l'ordre par puissance doit y rester intact.
// Tri stable : à rang TVA égal, l'ordre d'entrée (puissance croissante) est conservé.
export function trierMonosParTva(sols, brand) {
    const rang = sol => {
        const info = getTvaInfo(sol.gamme, sol.reference_ensemble, 'mono', brand);
        if (!info) return 1;                                    // marque sans base TVA : rang neutre
        return info.statut === 'eligible' ? 0 : (info.statut === 'a_verifier' ? 1 : 2);
    };
    return [...sols].sort((a, b) => rang(a) - rang(b));
}

// Tous les groupes extérieurs du catalogue capables d'alimenter cet ensemble de pièces (nombre de
// sorties + besoin cumulé foisonné), triés par puissance froid croissante puis par nombre de
// sorties croissant (à puissance égale, inutile de proposer un groupe 3 sorties pour 2 pièces).
// Base commune aux options équivalentes (findMultiGroupOptions) et à l'escalade anti-déséquilibre
// (findGroupeEquilibre). roomsObj : tableau de { froidMatch, chaudMatch }.
export function findGroupesValides(roomsObj, brand, coefFoisonnementFroid, coefFoisonnementChaud) {
    if (roomsObj.length === 0) return [];
    const totF = roomsObj.reduce((sum, r) => sum + r.froidMatch, 0);
    const totC = roomsObj.reduce((sum, r) => sum + r.chaudMatch, 0);
    return CATALOGS[brand].multisplits_groupes_exterieurs.filter(g =>
        g.max_unites_interieures >= roomsObj.length &&
        (g.puissance_nominale_froid_kw * coefFoisonnementFroid) >= totF &&
        (g.puissance_nominale_chaud_kw * coefFoisonnementChaud) >= totC
    ).sort((a, b) => (a.puissance_nominale_froid_kw - b.puissance_nominale_froid_kw)
                  || (a.max_unites_interieures - b.max_unites_interieures));
}

// Toutes les gammes extérieures valides pour un ensemble de pièces (contrainte de puissance +
// nombre de sorties), triées par puissance croissante, avec la même tolérance de +15% qu'en
// monosplit pour inclure les alternatives équivalentes plutôt qu'un choix unique imposé.
// roomsObj : tableau de { froidMatch, chaudMatch }.
export function findMultiGroupOptions(roomsObj, brand, coefFoisonnementFroid, coefFoisonnementChaud) {
    const validGroups = findGroupesValides(roomsObj, brand, coefFoisonnementFroid, coefFoisonnementChaud);
    if (validGroups.length === 0) return [];
    const minFroid = validGroups[0].puissance_nominale_froid_kw;
    return validGroups.filter(g => g.puissance_nominale_froid_kw <= minFroid * TOLERANCE_EQUIVALENCE);
}

// Pièce la plus demandeuse d'un ensemble : celle qui dicte le déséquilibre d'un groupe multisplit
// (un compresseur unique alimente toutes les UI).
export function pieceDominante(roomsObj) {
    if (!roomsObj || roomsObj.length === 0) return null;
    return roomsObj.reduce((max, r) =>
        Math.max(r.froidMatch, r.chaudMatch) > Math.max(max.froidMatch, max.chaudMatch) ? r : max);
}

// Part de la puissance nominale d'un groupe absorbée par sa pièce la plus demandeuse (0 → 1).
export function ratioPieceDominante(group, roomsObj) {
    const piece = pieceDominante(roomsObj);
    const nominalMax = Math.max(group.puissance_nominale_froid_kw, group.puissance_nominale_chaud_kw);
    if (!piece || !nominalMax) return 0;
    return Math.max(piece.froidMatch, piece.chaudMatch) / nominalMax;
}

// Groupe déséquilibré : une seule pièce mobilise une part telle de la puissance du groupe que les
// autres pièces peuvent manquer de capacité en cas de forte demande simultanée. Sans objet sur une
// pièce unique (il n'y a alors personne à pénaliser).
export function estGroupeDesequilibre(group, roomsObj, seuil = SEUIL_DESEQUILIBRE_GROUPE) {
    return roomsObj.length > 1 && ratioPieceDominante(group, roomsObj) > seuil;
}

// Taux de charge d'un groupe = besoin réel cumulé / puissance nominale catalogue. Un besoin chaud
// nul ou absent (mode "froid seul") ne compte pas, comme dans le badge de taux de charge affiché.
export function tauxChargeGroupe(group, besoinFroid, besoinChaud) {
    const froid = group.puissance_nominale_froid_kw ? besoinFroid / group.puissance_nominale_froid_kw : 0;
    const chaud = (besoinChaud && group.puissance_nominale_chaud_kw) ? besoinChaud / group.puissance_nominale_chaud_kw : null;
    return { froid, chaud, min: chaud !== null ? Math.min(froid, chaud) : froid };
}

// Escalade anti-déséquilibre : plus petit groupe du catalogue qui couvre le besoin cumulé ET ramène
// la pièce dominante sous le seuil de déséquilibre. C'est la réponse "intelligente" à l'alerte de
// demande simultanée : monter d'un cran de groupe (ex. 2M14 -> 2M18) résout le problème sans
// imposer le délestage en monosplit dédié.
// besoins ({ froid, chaud } réels, non foisonnés) sert de garde-fou : on refuse une escalade qui
// ferait tomber le groupe sous SEUIL_SOUS_CHARGE_ESCALADE (surdimensionnement plus coûteux que le
// déséquilibre qu'il corrige). Retourne null si le catalogue n'offre aucun groupe de ce type —
// dans ce cas seul un monosplit dédié pour la pièce dominante résout le déséquilibre.
export function findGroupeEquilibre(roomsObj, brand, coefFoisonnementFroid, coefFoisonnementChaud, besoins = null,
                                    seuilDesequilibre = SEUIL_DESEQUILIBRE_GROUPE, seuilSousCharge = SEUIL_SOUS_CHARGE_ESCALADE) {
    const candidats = findGroupesValides(roomsObj, brand, coefFoisonnementFroid, coefFoisonnementChaud)
        .filter(g => !estGroupeDesequilibre(g, roomsObj, seuilDesequilibre));
    if (candidats.length === 0) return null;
    if (!besoins) return candidats[0];
    return candidats.find(g => tauxChargeGroupe(g, besoins.froid, besoins.chaud).min >= seuilSousCharge) || null;
}

// Meilleur groupe extérieur (ou "MONO" si une seule pièce restante, ou null si aucun ne convient).
export function findMultiGroup(roomsObj, brand, coefFoisonnementFroid, coefFoisonnementChaud) {
    if (roomsObj.length === 0) return null;
    if (roomsObj.length === 1) return "MONO";
    const opts = findMultiGroupOptions(roomsObj, brand, coefFoisonnementFroid, coefFoisonnementChaud);
    return opts.length > 0 ? opts[0] : null;
}

// Gammes uniques d'unités intérieures éligibles pour le besoin réel d'une pièce, éventuellement
// restreintes aux gammes compatibles avec le groupe extérieur choisi. Fonction pure : ne lit ni
// n'écrit d'état applicatif (utilisée à la fois pour initialiser un choix par défaut et pour
// l'affichage, sans dupliquer la logique de filtrage entre les deux usages).
export function getRoomEligibleGammes(room, allowedGammes, brand) {
    let sols = findBestMonos(room.froidMatch, room.chaudMatch, brand);
    if (allowedGammes) sols = sols.filter(s => allowedGammes.includes(s.gamme));
    return [...new Set(sols.map(s => s.gamme))];
}

// Extrait le code taille Toshiba (ex: "18" dans "RAS-18E2AVG-E") depuis une référence d'unité extérieure.
export function extractTailleCode(reference) {
    const m = reference.match(/RAS-(\d{2})/);
    return m ? m[1] : null;
}

// Racine d'une référence de groupe extérieur, suffixe commercial de millésime retiré
// (RAS-5M34G3AVG-E/ET et RAS-5M34G3AVG-E1 désignent la même machine) — voir TVA_RULES.multi.
export function normaliserReferenceGroupe(reference) {
    return String(reference || '').trim().toUpperCase().replace(/-E\d*(\/ET)?$/i, '').replace(/-ND$/i, '');
}

// Détermine l'éligibilité TVA 5,5% d'une gamme/référence, pour la marque donnée.
// context : 'mono' (monosplit dédié) ou 'multiUi' (unité intérieure raccordée à un groupe multisplit,
// auquel cas groupeReference est la référence du groupe extérieur retenu : c'est LUI qui porte
// l'éligibilité en multisplit, pas l'unité intérieure).
// Retourne null si la marque n'est pas couverte par la base TVA (pas d'affichage dans ce cas), sinon
// { statut, eligible, wifiRequired } avec statut :
//   'eligible'     → TVA 5,5% (sous condition de module Wifi si wifiRequired)
//   'non_eligible' → TVA 20%, refus explicite du tableau constructeur
//   'a_verifier'   → référence absente du tableau : ni promesse de 5,5%, ni condamnation à 20%
export function getTvaInfo(gammeName, referenceEnsemble, context, brand, groupeReference = null) {
    const rules = TVA_RULES[brand];
    if (!rules) return null;

    const resultat = (statut, wifiRequired = false) => ({ statut, eligible: statut === 'eligible', wifiRequired: statut === 'eligible' && wifiRequired });

    if (context === 'multiUi') {
        const multi = rules.multi;
        if (!multi) return null;
        // Groupe absent de la liste constructeur, ou unité intérieure hors des gammes couvertes :
        // le tableau ne tranche pas, on ne tranche pas non plus.
        const groupeListe = multi.groupesEligibles.includes(normaliserReferenceGroupe(groupeReference));
        if (!groupeListe || !multi.gammesUi.includes(gammeName)) return resultat('a_verifier');
        return resultat('eligible', multi.wifiRequired);
    }

    const rule = rules.mono && rules.mono[gammeName];
    if (!rule) return null;
    const taille = extractTailleCode(referenceEnsemble);
    if (taille && rule.taillesNonEligibles.includes(taille)) return resultat('non_eligible');
    if (taille && rule.taillesEligibles.includes(taille)) return resultat('eligible', rule.wifiRequired);
    return resultat('a_verifier');
}

// Éligibilité TVA du GROUPE EXTÉRIEUR multisplit lui-même : en multisplit, c'est lui qui porte
// l'éligibilité de l'installation entière (toutes les UI raccordées en héritent), d'où son
// affichage sur la carte du groupe. Retourne null si la marque n'est pas couverte.
export function getGroupTvaInfo(groupeReference, brand) {
    const multi = TVA_RULES[brand] && TVA_RULES[brand].multi;
    if (!multi) return null;
    const eligible = multi.groupesEligibles.includes(normaliserReferenceGroupe(groupeReference));
    return {
        statut: eligible ? 'eligible' : 'a_verifier',
        eligible,
        wifiRequired: eligible && multi.wifiRequired
    };
}

// Éligibilité TVA de la gamme choisie pour une pièce d'un groupe multisplit (recalcule les options
// compatibles avec cette pièce pour retrouver la référence exacte de l'UI sélectionnée).
export function getRoomSelectedTvaInfo(room, gammeName, allowedGammes, brand, groupeReference = null) {
    let sols = findBestMonos(room.froidMatch, room.chaudMatch, brand);
    if (allowedGammes) sols = sols.filter(s => allowedGammes.includes(s.gamme));
    const sol = sols.find(s => s.gamme === gammeName);
    return sol ? getTvaInfo(gammeName, sol.reference_ensemble, 'multiUi', brand, groupeReference) : null;
}
