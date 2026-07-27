// Fonctions de calcul de ProSizer B2B — bilan thermique et sélection matériel.
// Module de fonctions PURES : aucun accès au DOM, aucune lecture/écriture d'état applicatif.
// Toutes les entrées (climat, coefficients, marque...) sont passées en paramètres explicites,
// ce qui les rend testables indépendamment de l'interface (voir tests/calcul.test.mjs).
import {
    CATALOGS, UI_SIZE_TABLES, TVA_RULES,
    APPORTS_INTERNES, CHARGE_TOITURE, RAYONNEMENT_VITRAGE, RATIO_VITRAGE, FC_PROTECTION,
    G_VITRAGE, COEF_INERTIE_SOLAIRE, OCCUPANT_W, COEF_RELANCE, COEF_G_DEFAUT,
    CONSIGNE_REFERENCE, ZONES_CHAUDES, ABATTEMENT_CANICULE, DECLASSEMENT_CHAUD_PALIERS,
    TOLERANCE_EQUIVALENCE
} from './data.js';

// Nombre d'occupants par défaut (≈ 1 pers. / 15 m²) tant que rien n'est saisi.
export function occupantsParDefaut(surface) {
    return surface ? Math.max(1, Math.round(surface / 15)) : '';
}

// Coefficient G résolu à partir de la sélection (valeur numérique ou "custom"), avec repli sur
// la valeur par défaut si la saisie personnalisée est vide ou invalide (évite la propagation de
// NaN dans tout le calcul).
export function resolveCoefG(selectVal, customVal) {
    const raw = selectVal === 'custom' ? parseFloat(customVal) : parseFloat(selectVal);
    return Number.isFinite(raw) && raw > 0 ? raw : COEF_G_DEFAUT;
}

// Marge canicule : en zone chaude, la puissance froid catalogue (donnée à 35°C ext.) chute
// réellement au-delà de 35°C (pointes 40-42°C).
export function getFacteurCanicule(zone) {
    return zone && ZONES_CHAUDES.includes(zone) ? ABATTEMENT_CANICULE : 1.0;
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

// Code taille UI (ex: "10") pour un besoin donné, propre à la marque.
export function getUiSizeForKw(reqFroid, reqChaud, brand) {
    const maxReq = Math.max(reqFroid, reqChaud);
    const table = UI_SIZE_TABLES[brand];
    for (const row of table) { if (maxReq <= row.max) return row.code; }
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

// Toutes les gammes extérieures valides pour un ensemble de pièces (contrainte de puissance +
// nombre de sorties), triées par puissance croissante, avec la même tolérance de +15% qu'en
// monosplit pour inclure les alternatives équivalentes plutôt qu'un choix unique imposé.
// roomsObj : tableau de { froidMatch, chaudMatch }.
export function findMultiGroupOptions(roomsObj, brand, coefFoisonnementFroid, coefFoisonnementChaud) {
    if (roomsObj.length === 0) return [];
    let totF = roomsObj.reduce((sum, r) => sum + r.froidMatch, 0);
    let totC = roomsObj.reduce((sum, r) => sum + r.chaudMatch, 0);
    let validGroups = CATALOGS[brand].multisplits_groupes_exterieurs.filter(g =>
        g.max_unites_interieures >= roomsObj.length &&
        (g.puissance_nominale_froid_kw * coefFoisonnementFroid) >= totF &&
        (g.puissance_nominale_chaud_kw * coefFoisonnementChaud) >= totC
    ).sort((a, b) => a.puissance_nominale_froid_kw - b.puissance_nominale_froid_kw);
    if (validGroups.length === 0) return [];
    const minFroid = validGroups[0].puissance_nominale_froid_kw;
    return validGroups.filter(g => g.puissance_nominale_froid_kw <= minFroid * TOLERANCE_EQUIVALENCE);
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

// Détermine l'éligibilité TVA 5,5% d'une gamme/référence, pour la marque donnée.
// context : 'mono' (monosplit dédié) ou 'multiUi' (unité intérieure choisie sur un groupe multisplit).
// Retourne null si la marque ou la gamme n'est pas couverte par la base TVA (pas d'affichage dans ce cas).
export function getTvaInfo(gammeName, referenceEnsemble, context, brand) {
    const rules = TVA_RULES[brand] && TVA_RULES[brand][context];
    const rule = rules && rules[gammeName];
    if (!rule) return null;
    let eligible = rule.eligible;
    if (eligible && rule.taillesNonEligibles) {
        const taille = extractTailleCode(referenceEnsemble);
        if (taille && rule.taillesNonEligibles.includes(taille)) eligible = false;
    }
    return { eligible, wifiRequired: !!(eligible && rule.wifiRequired) };
}

// Éligibilité TVA de la gamme choisie pour une pièce d'un groupe multisplit (recalcule les options
// compatibles avec cette pièce pour retrouver la référence exacte de l'UI sélectionnée).
export function getRoomSelectedTvaInfo(room, gammeName, allowedGammes, brand) {
    let sols = findBestMonos(room.froidMatch, room.chaudMatch, brand);
    if (allowedGammes) sols = sols.filter(s => allowedGammes.includes(s.gamme));
    const sol = sols.find(s => s.gamme === gammeName);
    return sol ? getTvaInfo(gammeName, sol.reference_ensemble, 'multiUi', brand) : null;
}
