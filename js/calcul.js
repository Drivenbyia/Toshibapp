// Fonctions de calcul de Klimo — bilan thermique et sélection matériel.
// Module de fonctions PURES : aucun accès au DOM, aucune lecture/écriture d'état applicatif.
// Toutes les entrées (climat, coefficients, marque...) sont passées en paramètres explicites,
// ce qui les rend testables indépendamment de l'interface (voir tests/calcul.test.mjs).
import {
    CATALOGS, UI_MULTI_SEUL, UI_SIZE_TABLES, TVA_RULES, SUFFIXES_MILLESIME_GROUPE,
    APPORTS_INTERNES, CHARGE_TOITURE_PALIERS, RAYONNEMENT_VITRAGE, RATIO_VITRAGE, FC_PROTECTION,
    G_VITRAGE_PALIERS, COEF_INERTIE_SOLAIRE, OCCUPANT_W, COEF_RELANCE, COEF_G_DEFAUT, PART_VENTILATION_G,
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

// Interpolation linéaire générique sur une table de paliers { g, [cle]: valeur } triée par g
// croissant, plafonnée en dehors (jamais extrapolée) : sous le premier palier, la valeur reste
// à son minimum ; au-delà du dernier, à son maximum. Partagée par les deux grandeurs de
// l'enveloppe qui suivent l'époque de construction (coefficient G) sans variation continue
// propre : la surcharge toiture et le facteur solaire du vitrage.
function interpolerSurG(coefG, paliers, cle) {
    if (coefG <= paliers[0].g) return paliers[0][cle];
    if (coefG >= paliers[paliers.length - 1].g) return paliers[paliers.length - 1][cle];
    for (let i = 0; i < paliers.length - 1; i++) {
        const a = paliers[i], b = paliers[i + 1];
        if (coefG >= a.g && coefG <= b.g) {
            const t = (coefG - a.g) / (b.g - a.g);
            return a[cle] + t * (b[cle] - a[cle]);
        }
    }
    return paliers[paliers.length - 1][cle];
}

// Surcharge toiture interpolée sur le coefficient G, à partir des paliers CHARGE_TOITURE_PALIERS
// (voir data.js pour la discontinuité que ça corrige) : la charge ne devient pas négative pour
// un G très bas, ni ne croît sans borne pour un G très élevé (véranda, G=3.0).
export function interpolerChargeToiture(coefG) {
    return interpolerSurG(coefG, CHARGE_TOITURE_PALIERS, 'charge');
}

// Facteur solaire du vitrage interpolé sur le coefficient G, à partir des paliers
// G_VITRAGE_PALIERS (voir data.js pour la surestimation que ça corrige).
export function interpolerGVitrage(coefG) {
    return interpolerSurG(coefG, G_VITRAGE_PALIERS, 'gVitrage');
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
        const qEnveloppe = coefG * volume * deltaTEte;
        const qToiture = interpolerChargeToiture(coefG) * 0.5 * surfaceRef;
        const qSolaire = RAYONNEMENT_VITRAGE.mixte * interpolerGVitrage(coefG) * FC_PROTECTION.stores_int * COEF_INERTIE_SOLAIRE * surfaceRef * RATIO_VITRAGE.moyen;
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

    // G capte à la fois la transmission par les parois ET le renouvellement d'air (voir plus
    // bas) — mais seule la transmission dépend du nombre de murs extérieurs. Une pièce
    // intérieure se ventile pareil qu'une pièce d'angle : appliquer ratioExposition à la
    // totalité de G, comme avant ce correctif, réduisait aussi le débit d'air neuf, jusqu'à /4
    // pour une pièce à un seul mur extérieur. On sépare donc G en deux parts (voir
    // PART_VENTILATION_G, data.js) : la part ventilation reste à taux plein quelle que soit
    // l'exposition, seule la part transmission est pondérée.
    const gTransmission = coefG * (1 - PART_VENTILATION_G);
    const gVentilation = coefG * PART_VENTILATION_G;
    const gPondere = gTransmission * ratioExposition + gVentilation;

    // --- CHAUD : méthode déperditions (coefficient volumique G · V · ΔT) ---
    const deltaTChaud = 20 - tBaseHiver;
    const deperditionsSeches = (volume * gPondere * deltaTChaud) / 1000;
    const besoinChaud = deperditionsSeches * COEF_RELANCE;

    // --- FROID : bilan poste par poste (enveloppe + toiture + solaire + internes + occupants) ---
    // Le coefficient G (hivernal) capte la transmission des parois et le renouvellement d'air
    // mais ignore le rayonnement solaire estival ; on ajoute donc explicitement la surcharge
    // toiture et les apports solaires par les vitrages, postes dominants du froid en été.
    const deltaTEte = Math.max(0, tBaseEte - consigne);

    // 1. Enveloppe : transmission des parois + air neuf (via G), pondérée par l'exposition
    //    (voir gPondere ci-dessus — seule la part transmission de G varie avec l'exposition).
    const qEnveloppe = gPondere * volume * deltaTEte;   // W

    // 2. Toiture : surcharge solaire si la pièce est sous la couverture. Approximation
    //    connue et non résolue : le G capte déjà la transmission de toute l'enveloppe,
    //    toiture comprise (voir plus haut), donc cette surcharge se cumule en partie avec
    //    une part déjà comptée dans qEnveloppe pour les pièces sous toiture — sans données
    //    de géométrie réelle (surface de toiture distincte des murs), on ne peut pas isoler
    //    proprement cette part pour la retrancher. Le double comptage biaise vers une
    //    surestimation (donc un sur-dimensionnement), jamais vers un déficit de puissance.
    //    plain_pied = combles perdus isolés (apport modéré) → demi-surcharge.
    const chargeToit = interpolerChargeToiture(coefG);
    const qToiture = room.emplacement === 'sous_toiture' ? chargeToit * surface
                   : room.emplacement === 'plain_pied'   ? chargeToit * 0.5 * surface
                   : 0;                              // W

    // 3. Solaire : rayonnement × facteur g × protection × inertie × surface vitrée estimée.
    const rayon     = RAYONNEMENT_VITRAGE[room.orientation] ?? RAYONNEMENT_VITRAGE.mixte;
    const ratioVit  = RATIO_VITRAGE[room.vitrage] ?? RATIO_VITRAGE.moyen;
    const fc        = FC_PROTECTION[room.protection] ?? FC_PROTECTION.stores_int;
    const sVitree   = surface * ratioVit;
    const gVit      = interpolerGVitrage(coefG);
    const qSolaire  = rayon * gVit * fc * COEF_INERTIE_SOLAIRE * sVitree; // W

    // 4. Apports internes de base : éclairage + équipements.
    const qInternesBase = APPORTS_INTERNES * surface; // W

    // 5. Occupants (sensible + latent). Si non saisi, on estime ≈ 1 pers. / 15 m².
    // Un 0 explicitement saisi (pièce inoccupée) doit rester 0, pas retomber sur l'estimation :
    // on ne bascule sur la valeur par défaut que si le champ est réellement vide.
    const occupantsSaisis = room.occupants === '' || room.occupants === null || room.occupants === undefined
        ? null : parseFloat(room.occupants);
    const nbOcc = Number.isFinite(occupantsSaisis) ? occupantsSaisis : (occupantsParDefaut(surface) || 0);
    const qOccupants = nbOcc * OCCUPANT_W;            // W

    // Une SEULE expression pour la somme, réutilisée par `detail.froidTotalW` : réécrire la
    // même addition à deux endroits ferait diverger les derniers bits, et la fiche imprimée
    // n'additionnerait plus exactement le total qui a choisi la machine — c'est-à-dire que le
    // document censé justifier le dimensionnement se contredirait tout seul.
    const froidTotalW = qEnveloppe + qToiture + qSolaire + qInternesBase + qOccupants;
    const besoinFroid = froidTotalW / 1000;

    // `froid` et `chaud` restent la réponse de cette fonction ; `detail` n'ajoute aucun calcul,
    // il expose les grandeurs intermédiaires DÉJÀ calculées ci-dessus, qui étaient jusqu'ici
    // jetées. C'est la matière de la fiche imprimée : sans elles, un document ne peut que
    // réaffirmer le résultat, jamais le justifier.
    // Unités mêlées et explicites : les postes froid en W (la grandeur naturelle du bilan poste
    // par poste), les besoins et le chaud en kW (la grandeur du catalogue).
    return {
        froid: besoinFroid,
        chaud: besoinChaud,
        detail: {
            entrees:     { surface, height, volume, coefG, tBaseHiver, tBaseEte, consigne },
            exposition:  { nbMursExt, ratioExposition, gTransmission, gVentilation, gPondere },
            froidPostes: { enveloppe: qEnveloppe, toiture: qToiture, solaire: qSolaire,
                           internes: qInternesBase, occupants: qOccupants },   // W
            froidTotalW,
            solaire:     { rayonnement: rayon, gVitrage: gVit, fcProtection: fc,
                           inertie: COEF_INERTIE_SOLAIRE, sVitree, ratioVitrage: ratioVit },
            toiture:     { chargeSurfacique: chargeToit, emplacement: room.emplacement },
            occupants:   { nb: nbOcc, wParOccupant: OCCUPANT_W },
            internes:    { wParM2: APPORTS_INTERNES },
            chaudDetail: { deltaT: deltaTChaud, deperditionsSeches, coefRelance: COEF_RELANCE },  // kW
            deltaTEte
        }
    };
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
// Départage par le chaud à froid égal : sans ce second critère, l'ordre entre machines de même
// puissance froid était celui du catalogue, donc arbitraire — la première option étant celle
// proposée par défaut, une machine nettement plus surdimensionnée en chaud pouvait passer devant
// une autre strictement mieux ajustée. Le tri reste piloté par le froid en premier : c'est lui qui
// définit la bande d'équivalence ci-dessous.
// extraCatalog : UI supplémentaires à inclure dans la bande d'équivalence, en plus des ensembles
// monosplit du catalogue — vide par défaut, donc le comportement mono/délestage (seuls appelants
// à 3 arguments) est strictement inchangé. Réservé en pratique à findRoomMultiSolutions, qui y
// passe UI_MULTI_SEUL : des UI qui n'existent qu'attelées à un groupe multisplit ne doivent
// jamais se glisser dans une sélection mono ou un monosplit dédié (voir data.js, UI_MULTI_SEUL).
export function findBestMonos(reqF, reqC, brand, extraCatalog = []) {
    let allSols = [...CATALOGS[brand].monosplits, ...extraCatalog]
                               .filter(p => p.puissance_froid_kw >= reqF && p.puissance_chaud_kw >= reqC)
                               .sort((a, b) => (a.puissance_froid_kw - b.puissance_froid_kw)
                                            || (a.puissance_chaud_kw - b.puissance_chaud_kw));

    if (allSols.length === 0) return [];

    const minFroid = allSols[0].puissance_froid_kw;
    return allSols.filter(p => p.puissance_froid_kw <= minFroid * TOLERANCE_EQUIVALENCE);
}

// Solutions d'UI utilisables pour une pièce raccordée à un groupe multisplit : les ensembles
// monosplit du catalogue, enrichis des UI qui n'existent qu'en multisplit (UI_MULTI_SEUL,
// data.js — ex. Shorai Curve taille 05, sans groupe mono dédié pour l'écarter de la bande
// d'équivalence). Seule fonction de ce fichier à consommer UI_MULTI_SEUL : un monosplit dédié ou
// une sélection mono doivent continuer à passer par findBestMonos seul, sans cet enrichissement.
export function findRoomMultiSolutions(reqF, reqC, brand) {
    return findBestMonos(reqF, reqC, brand, UI_MULTI_SEUL[brand] || []);
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

// Pièce la plus demandeuse d'un ensemble, en puissance brute et indépendamment de tout groupe.
// Ne sert plus à décider d'un déséquilibre (voir pieceDominantePourGroupe, qui raisonne en part
// de la capacité réellement disponible) : conservée pour les usages où aucun groupe n'est encore
// choisi.
export function pieceDominante(roomsObj) {
    if (!roomsObj || roomsObj.length === 0) return null;
    return roomsObj.reduce((max, r) =>
        Math.max(r.froidMatch, r.chaudMatch) > Math.max(max.froidMatch, max.chaudMatch) ? r : max);
}

// Part de la puissance nominale d'un groupe absorbée par UNE pièce (0 → 1), mode par mode.
//
// Chaque besoin est confronté à SA propre capacité : le froid au nominal froid, le chaud au
// nominal chaud. Auparavant le calcul divisait `max(froidMatch, chaudMatch)` par
// `max(nominal froid, nominal chaud)` — deux maxima pris indépendamment, qui pouvaient donc
// provenir de modes différents. Comme le nominal chaud est TOUJOURS supérieur au nominal froid
// sur les groupes du catalogue, tout besoin dominé par le froid était divisé par une capacité
// chaud plus grande, et sa part systématiquement sous-estimée.
//
// Deux cas où ça mordait, et ce sont exactement les cas cibles d'un outil de climatisation :
//   - mode « Froid seul » : chaudMatch vaut 0, le besoin froid était donc toujours rapporté au
//     nominal chaud. Sur un RAS-3M18 (5,2 kW F / 6,8 kW C), une pièce à 3,4 kW froid occupe
//     réellement 65% du groupe et était comptée à 50% : sous le seuil, aucune alerte.
//   - mode réversible en zone chaude et bâti bien isolé, où le besoin froid dépasse le chaud.
export function partPieceDansGroupe(piece, group) {
    if (!piece || !group) return 0;
    const parts = [];
    if (group.puissance_nominale_froid_kw) parts.push(piece.froidMatch / group.puissance_nominale_froid_kw);
    if (piece.chaudMatch && group.puissance_nominale_chaud_kw) parts.push(piece.chaudMatch / group.puissance_nominale_chaud_kw);
    return parts.length ? Math.max(...parts) : 0;
}

// Pièce qui absorbe la plus grande PART de la puissance d'un groupe donné — ce n'est pas
// forcément celle qui demande le plus de kW bruts : une pièce dominée par le froid pèse sur une
// capacité plus petite qu'une pièce dominée par le chaud. C'est cette pièce-là qui dicte le
// déséquilibre, et c'est donc elle que l'interface doit nommer à côté du pourcentage affiché.
export function pieceDominantePourGroupe(group, roomsObj) {
    if (!roomsObj || roomsObj.length === 0) return null;
    return roomsObj.reduce((max, r) =>
        partPieceDansGroupe(r, group) > partPieceDansGroupe(max, group) ? r : max);
}

// Part de la puissance nominale d'un groupe absorbée par sa pièce la plus demandeuse (0 → 1).
export function ratioPieceDominante(group, roomsObj) {
    return partPieceDansGroupe(pieceDominantePourGroupe(group, roomsObj), group);
}

// Groupe déséquilibré : une seule pièce mobilise une part telle de la puissance du groupe que les
// autres pièces peuvent manquer de capacité en cas de forte demande simultanée. Sans objet sur une
// pièce unique (il n'y a alors personne à pénaliser).
//
// Le seuil de part dominante ne se justifie QUE lorsque le groupe s'appuie sur le foisonnement.
// Les coefficients COEF_FOISONNEMENT_* autorisent un besoin cumulé supérieur à la puissance
// nominale, en pariant que les pièces n'appellent pas leur pointe au même instant — pari d'autant
// plus fragile qu'une pièce écrase les autres, d'où ce garde-fou.
//
// Mais quand la somme des besoins tient DÉJÀ dans la puissance nominale, il n'y a plus de pari à
// protéger : le groupe sert les trois pièces à leur pointe simultanée, et aucune ne peut en priver
// une autre. « Reste-t-il de quoi servir les autres quand la pièce dominante est à sa pointe ? »
// se réduit exactement à « le total tient-il dans le nominal ? » — donc au test ci-dessous.
//
// Sans cette condition, la règle écartait des groupes parfaitement capables : un salon à 5,00 kW
// chaud avec deux chambres à 0,75 kW fait 6,50 kW, que le RAS-3M18 (6,8 kW) couvre intégralement,
// et il était pourtant refusé parce que le salon pesait 74 % du nominal. L'escalade se payait
// alors sur l'autre grandeur — le groupe supérieur tombait à 44 % de charge en froid, donc cycles
// courts et surcoût, pour corriger un déséquilibre qui n'existait pas. Sur un balayage de 436
// escalades (9 zones × 5 isolations × 7 tailles de séjour × 5 tailles de chambre), la moitié
// étaient dans ce cas.
//
// Rappel de ce que la contrainte constructeur impose réellement : le nombre de sorties, porté par
// la référence elle-même (2M/3M/4M/5M chez Toshiba) et déjà filtré par findGroupesValides. Aucun
// taux de raccordement ne vient s'y ajouter — ce seuil ne tenait donc lieu de rien d'autre.
export function estGroupeDesequilibre(group, roomsObj, seuil = SEUIL_DESEQUILIBRE_GROUPE) {
    if (!roomsObj || roomsObj.length <= 1) return false;
    const totalFroid = roomsObj.reduce((s, r) => s + (r.froidMatch || 0), 0);
    const totalChaud = roomsObj.reduce((s, r) => s + (r.chaudMatch || 0), 0);
    const couvreToutEnSimultane = totalFroid <= group.puissance_nominale_froid_kw
                               && totalChaud <= group.puissance_nominale_chaud_kw;
    if (couvreToutEnSimultane) return false;
    return ratioPieceDominante(group, roomsObj) > seuil;
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
    let sols = findRoomMultiSolutions(room.froidMatch, room.chaudMatch, brand);
    if (allowedGammes) sols = sols.filter(s => allowedGammes.includes(s.gamme));
    return [...new Set(sols.map(s => s.gamme))];
}

// Code taille (ex: "18") d'une référence monosplit, résolu depuis le CATALOGUE plutôt que
// parsé dans la chaîne de référence. C'est la différence qui rend cette fonction générique par
// marque : l'ancienne version filtrait sur /RAS-(\d{2})/, une nomenclature strictement Toshiba
// (le préfixe "RAS-" suivi de deux chiffres). Pour toute autre marque, la regex ne matchait
// jamais et retombait sur `null` — et dans getTvaInfo, les deux gardes `if (taille && ...)`
// étant alors sautées, TOUTE référence de cette marque atterrissait silencieusement sur
// `a_verifier`, y compris celles qu'un futur tableau constructeur désignerait explicitement
// comme non éligibles.
//
// Le catalogue porte déjà tout ce qu'il faut pour retrouver la taille sans parser quoi que ce
// soit : chaque entrée monosplit a ses puissances nominales, et UI_SIZE_TABLES (déjà par
// marque, voir data.js) fait la correspondance puissance → code taille. getUiSizeForKw renvoie
// alors exactement le palier de cette entrée, quelle que soit la convention de nommage du
// constructeur.
function tailleDepuisReference(referenceEnsemble, brand) {
    const catalogue = CATALOGS[brand];
    if (!catalogue) return null;
    const entree = catalogue.monosplits.find(m => m.reference_ensemble === referenceEnsemble);
    if (!entree) return null;
    return getUiSizeForKw(entree.puissance_froid_kw, entree.puissance_chaud_kw, brand);
}

// Suffixes de millésime commercial à ignorer pour faire correspondre une référence de groupe
// extérieur du CATALOGUE (qui les porte, ex. "RAS-5M34G3AVG-E/ET") à celle citée par le
// TABLEAU CONSTRUCTEUR d'éligibilité TVA (qui généralement ne les porte pas, ex.
// "RAS-5M34G3AVG"). Par marque (SUFFIXES_MILLESIME_GROUPE, data.js) : une marque absente de
// cette table n'a AUCUN suffixe retiré — la comparaison se fait alors sur la référence exacte.
// C'est le comportement sûr par défaut : appliquer par erreur une règle de retrait taillée pour
// la nomenclature Toshiba à une autre marque, où "-E" pourrait distinguer deux machines
// différentes, ferait glisser l'éligibilité TVA de l'une à l'autre sans qu'aucune erreur ne
// soit levée.
export function normaliserReferenceGroupe(reference, brand) {
    let ref = String(reference || '').trim().toUpperCase();
    const suffixes = SUFFIXES_MILLESIME_GROUPE[brand];
    if (suffixes) {
        for (const regex of suffixes) ref = ref.replace(regex, '');
    }
    return ref;
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
        const groupeListe = multi.groupesEligibles.includes(normaliserReferenceGroupe(groupeReference, brand));
        if (!groupeListe || !multi.gammesUi.includes(gammeName)) return resultat('a_verifier');
        return resultat('eligible', multi.wifiRequired);
    }

    const rule = rules.mono && rules.mono[gammeName];
    if (!rule) return null;
    const taille = tailleDepuisReference(referenceEnsemble, brand);
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
    const eligible = multi.groupesEligibles.includes(normaliserReferenceGroupe(groupeReference, brand));
    return {
        statut: eligible ? 'eligible' : 'a_verifier',
        eligible,
        wifiRequired: eligible && multi.wifiRequired
    };
}

// Éligibilité TVA de la gamme choisie pour une pièce d'un groupe multisplit (recalcule les options
// compatibles avec cette pièce pour retrouver la référence exacte de l'UI sélectionnée).
export function getRoomSelectedTvaInfo(room, gammeName, allowedGammes, brand, groupeReference = null) {
    let sols = findRoomMultiSolutions(room.froidMatch, room.chaudMatch, brand);
    if (allowedGammes) sols = sols.filter(s => allowedGammes.includes(s.gamme));
    const sol = sols.find(s => s.gamme === gammeName);
    return sol ? getTvaInfo(gammeName, sol.reference_ensemble, 'multiUi', brand, groupeReference) : null;
}
