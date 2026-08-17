// Tests de non-régression sur le cœur de calcul de ProSizer B2B.
// Exécution : node --test (aucune dépendance, runner natif de Node ≥ 18).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    getRequiredKw, getFacteurCanicule, getFacteurDeclassementChaud, ratioDeclassementChaud,
    estimerEcartConsigne, resolveCoefG, parseNombreSaisi, getUiSizeForKw, findBestMonos, findMultiGroupOptions,
    findMultiGroup, getRoomEligibleGammes, getTvaInfo, occupantsParDefaut,
    findGroupesValides, findGroupeEquilibre, estGroupeDesequilibre, ratioPieceDominante,
    pieceDominante, pieceDominantePourGroupe, partPieceDansGroupe,
    tauxChargeGroupe, getGroupTvaInfo, normaliserReferenceGroupe, trierMonosParTva,
    interpolerChargeToiture, interpolerGVitrage, findRoomMultiSolutions,
    partitionner, evaluerBlocRepartition, explorerRepartitions, meilleureAlternative
} from '../js/calcul.js';
import {
    CONSIGNE_REFERENCE, COEF_FOISONNEMENT_FROID, COEF_FOISONNEMENT_CHAUD,
    SEUIL_DESEQUILIBRE_GROUPE, CATALOGS, UI_SIZE_TABLES, DEPARTMENTS, tBaseMatrix, tBaseEteMatrix,
    CHARGE_TOITURE_PALIERS, G_VITRAGE_PALIERS, PART_VENTILATION_G, ABATTEMENT_CANICULE_MAX,
    APPORTS_INTERNES, OCCUPANT_W, COEF_RELANCE, SEUIL_MODULATION_BASSE, SEUIL_SOUS_CHARGE
} from '../js/data.js';

const ROOM_TYPE = { emplacement: 'plain_pied', orientation: 'mixte', vitrage: 'moyen', protection: 'stores_int', occupants: '', expositionMurs: 4 };

describe('getRequiredKw — cas de référence par zone climatique', () => {
    // Valeur froid recalculée suite à l'interpolation du facteur solaire du vitrage (voir
    // « interpolerGVitrage — facteur solaire » plus bas) : à G=0.8, gVitrage vaut désormais 0.60
    // au lieu de la constante 0.75 d'origine, ce qui réduit le poste solaire — 34% du bilan — et
    // donc le besoin froid total de 1.8137 à 1.68896 kW. Le chaud est inchangé, ce poste n'y
    // intervenant pas.
    test('Lyon (zone F, Tbase hiver -9°C, Tbase été 33°C), salon 30 m², G=0.8', () => {
        const ctx = { coefG: 0.8, tBaseHiver: -9, tBaseEte: 33, consigne: 26 };
        const req = getRequiredKw(30, 2.5, ROOM_TYPE, ctx);
        assert.ok(Math.abs(req.froid - 1.68896) < 0.001, `froid attendu ~1.68896, obtenu ${req.froid}`);
        assert.ok(Math.abs(req.chaud - 2.088) < 0.001, `chaud attendu ~2.088, obtenu ${req.chaud}`);
    });

    test('Bretagne (zone A, climat plus doux), même pièce : besoin froid et chaud plus faibles', () => {
        const ctxLyon = { coefG: 0.8, tBaseHiver: -9, tBaseEte: 33, consigne: 26 };
        const ctxBretagne = { coefG: 0.8, tBaseHiver: -2, tBaseEte: 28, consigne: 26 };
        const reqLyon = getRequiredKw(30, 2.5, ROOM_TYPE, ctxLyon);
        const reqBretagne = getRequiredKw(30, 2.5, ROOM_TYPE, ctxBretagne);
        assert.ok(reqBretagne.chaud < reqLyon.chaud, 'le besoin chaud doit être plus faible en climat doux');
        assert.ok(reqBretagne.froid < reqLyon.froid, 'le besoin froid doit être plus faible en climat doux (moins de ΔT été)');
    });

    test('Montagne (Tbase hiver -19°C) : besoin chaud nettement plus élevé qu\'à Lyon (-9°C)', () => {
        const ctxLyon = { coefG: 0.8, tBaseHiver: -9, tBaseEte: 33, consigne: 26 };
        const ctxMontagne = { coefG: 0.8, tBaseHiver: -19, tBaseEte: 28, consigne: 26 };
        const reqLyon = getRequiredKw(30, 2.5, ROOM_TYPE, ctxLyon);
        const reqMontagne = getRequiredKw(30, 2.5, ROOM_TYPE, ctxMontagne);
        assert.ok(reqMontagne.chaud > reqLyon.chaud * 1.3, `besoin chaud montagne (${reqMontagne.chaud}) attendu nettement > Lyon (${reqLyon.chaud})`);
    });

    test('occupants=0 explicite reste 0 (pas de repli sur l\'estimation automatique)', () => {
        const ctx = { coefG: 0.8, tBaseHiver: -9, tBaseEte: 33, consigne: 26 };
        const roomAvecOccupants = { ...ROOM_TYPE, occupants: '' };
        const roomSansOccupant = { ...ROOM_TYPE, occupants: 0 };
        const reqAvec = getRequiredKw(30, 2.5, roomAvecOccupants, ctx);
        const reqSans = getRequiredKw(30, 2.5, roomSansOccupant, ctx);
        assert.ok(reqSans.froid < reqAvec.froid, 'une pièce à 0 occupant doit avoir un besoin froid plus faible (100W/occupant en moins)');
    });

    // Le ratio n'est plus 1/4 exact : G capte à la fois la transmission (qui dépend du nombre de
    // murs extérieurs) et le renouvellement d'air (qui n'en dépend pas — une pièce intérieure se
    // ventile pareil qu'une pièce d'angle). Avant ce correctif, 1 mur sur 4 divisait TOUT G,
    // ventilation comprise, par 4 — ce test verrouillait justement ce comportement, qui était le
    // bug. Avec 25% de G dédiés à la ventilation à taux plein (PART_VENTILATION_G, data.js), le
    // ratio effectif à 1 mur devient 0.75×(1/4) + 0.25 = 0.4375, dans la fourchette 0.4-0.6
    // attendue pour une pièce à un seul mur extérieur.
    test('exposition murs : 1 mur extérieur réduit le besoin chaud, mais pas à 1/4 (la ventilation ne varie pas avec l\'exposition)', () => {
        const ctx = { coefG: 0.8, tBaseHiver: -9, tBaseEte: 33, consigne: 26 };
        const req4 = getRequiredKw(30, 2.5, { ...ROOM_TYPE, expositionMurs: 4 }, ctx);
        const req1 = getRequiredKw(30, 2.5, { ...ROOM_TYPE, expositionMurs: 1 }, ctx);
        const ratio = req1.chaud / req4.chaud;
        assert.ok(Math.abs(ratio - 0.4375) < 0.0001, `ratio attendu 0.4375, obtenu ${ratio}`);
        assert.ok(ratio > 0.25, 'ne doit plus jamais retomber au ratio pur 1/4 (ancien comportement fautif)');
        assert.ok(ratio >= 0.4 && ratio <= 0.6, `ratio ${ratio} hors de la fourchette 0.4-0.6 recommandée`);
    });

    test('exposition murs : le besoin décroît de façon monotone avec le nombre de murs extérieurs', () => {
        const ctx = { coefG: 0.8, tBaseHiver: -9, tBaseEte: 33, consigne: 26 };
        const chaud = [1, 2, 3, 4].map(n => getRequiredKw(30, 2.5, { ...ROOM_TYPE, expositionMurs: n }, ctx).chaud);
        for (let i = 1; i < chaud.length; i++) {
            assert.ok(chaud[i] > chaud[i - 1], `chaud non croissant entre ${i} et ${i + 1} murs`);
        }
    });

    test('même à 0 mur extérieur (saisie hors bornes), le besoin ne descend jamais sous la part ventilation seule', () => {
        // room.expositionMurs est borné à [1,4] dans getRequiredKw ; ce test vérifie le plancher
        // conceptuel de PART_VENTILATION_G lui-même, indépendamment de ce clamp.
        const ctx = { coefG: 0.8, tBaseHiver: -9, tBaseEte: 33, consigne: 26 };
        const req1 = getRequiredKw(30, 2.5, { ...ROOM_TYPE, expositionMurs: 1 }, ctx);
        const req4 = getRequiredKw(30, 2.5, { ...ROOM_TYPE, expositionMurs: 4 }, ctx);
        const planchers = req4.chaud * PART_VENTILATION_G;
        assert.ok(req1.chaud > planchers, `même au minimum d'exposition, le besoin (${req1.chaud}) doit rester au-dessus de la seule part ventilation (${planchers})`);
    });

    test('consigne plus basse augmente le besoin froid (enveloppe uniquement, pas les autres postes)', () => {
        const ctx25 = { coefG: 0.8, tBaseHiver: -9, tBaseEte: 33, consigne: 25 };
        const ctx28 = { coefG: 0.8, tBaseHiver: -9, tBaseEte: 33, consigne: 28 };
        const req25 = getRequiredKw(30, 2.5, ROOM_TYPE, ctx25);
        const req28 = getRequiredKw(30, 2.5, ROOM_TYPE, ctx28);
        assert.ok(req25.froid > req28.froid, 'consigne 25°C doit demander plus de froid que 28°C');
    });
});

// Le poste solaire pèse 34% du bilan froid sur le cas de référence — c'est le poste dominant —
// et pourtant aucun test ne vérifiait que les quatre champs qui le pilotent (orientation,
// vitrage, protection, emplacement) changent réellement le résultat, ni dans quel sens. Un bug
// qui aurait rendu l'orientation sans effet, par exemple, serait passé inaperçu indéfiniment.
describe('getRequiredKw — poste solaire (orientation, vitrage, protection, emplacement)', () => {
    const CTX = { coefG: 0.8, tBaseHiver: -9, tBaseEte: 33, consigne: 26 };

    test('orientation : Nord < Sud < mixte < Est = Ouest (RAYONNEMENT_VITRAGE, data.js)', () => {
        const froidPour = (orientation) => getRequiredKw(30, 2.5, { ...ROOM_TYPE, orientation }, CTX).froid;
        const nord = froidPour('nord'), sud = froidPour('sud'), mixte = froidPour('mixte');
        const est = froidPour('est'), ouest = froidPour('ouest');
        assert.ok(nord < sud, 'Nord doit demander moins de froid que Sud');
        assert.ok(sud < mixte, 'Sud doit demander moins de froid qu\'une orientation mixte');
        assert.ok(mixte < est, 'mixte doit demander moins de froid qu\'Est');
        assert.ok(Math.abs(est - ouest) < 1e-9, 'Est et Ouest doivent être strictement identiques (même valeur en table)');
    });

    test('orientation inconnue : repli sur mixte plutôt qu\'un plantage', () => {
        const mixte = getRequiredKw(30, 2.5, { ...ROOM_TYPE, orientation: 'mixte' }, CTX).froid;
        const inconnue = getRequiredKw(30, 2.5, { ...ROOM_TYPE, orientation: 'nord-nord-ouest' }, CTX).froid;
        assert.equal(inconnue, mixte);
    });

    test('vitrage : plus de surface vitrée augmente le besoin froid (peu < moyen < beaucoup)', () => {
        const froidPour = (vitrage) => getRequiredKw(30, 2.5, { ...ROOM_TYPE, vitrage }, CTX).froid;
        assert.ok(froidPour('peu') < froidPour('moyen'), 'peu de vitrage doit demander moins de froid que moyen');
        assert.ok(froidPour('moyen') < froidPour('beaucoup'), 'moyen doit demander moins de froid que beaucoup');
    });

    test('protection solaire : moins de protection augmente le besoin froid (volets < stores < aucune)', () => {
        const froidPour = (protection) => getRequiredKw(30, 2.5, { ...ROOM_TYPE, protection }, CTX).froid;
        const volets = froidPour('volets_ext'), stores = froidPour('stores_int'), aucune = froidPour('aucune');
        assert.ok(volets < stores, 'des volets extérieurs doivent demander moins de froid que des stores intérieurs');
        assert.ok(stores < aucune, 'une protection doit toujours demander moins de froid qu\'aucune protection');
    });

    test('emplacement : étage protégé < plain-pied < sous toiture (surcharge toiture, CHARGE_TOITURE_PALIERS)', () => {
        const froidPour = (emplacement) => getRequiredKw(30, 2.5, { ...ROOM_TYPE, emplacement }, CTX).froid;
        const protege = froidPour('etage_protege'), plainPied = froidPour('plain_pied'), sousToiture = froidPour('sous_toiture');
        assert.ok(protege < plainPied, 'un étage protégé doit demander moins de froid qu\'un plain-pied (pas de surcharge toiture)');
        assert.ok(plainPied < sousToiture, 'un plain-pied (demi-surcharge) doit demander moins de froid qu\'une pièce sous toiture (surcharge pleine)');
    });

    test('emplacement sous toiture reçoit exactement le double de la surcharge d\'un plain-pied (facteur 0.5 documenté)', () => {
        const base = { ...ROOM_TYPE, orientation: 'nord', vitrage: 'peu', protection: 'volets_ext', occupants: 0 };
        const plainPied = getRequiredKw(30, 2.5, { ...base, emplacement: 'plain_pied' }, CTX).froid;
        const protege = getRequiredKw(30, 2.5, { ...base, emplacement: 'etage_protege' }, CTX).froid;
        const sousToiture = getRequiredKw(30, 2.5, { ...base, emplacement: 'sous_toiture' }, CTX).froid;
        const demiSurcharge = plainPied - protege;
        const surchargePleine = sousToiture - protege;
        assert.ok(Math.abs(surchargePleine - demiSurcharge * 2) < 1e-6,
            `surcharge sous toiture (${surchargePleine}) attendue au double de la demi-surcharge plain-pied (${demiSurcharge})`);
    });
});

// Le détail poste par poste est la matière de la fiche imprimée : c'est lui qui permet à un
// document de justifier une puissance au lieu de se contenter de l'affirmer. Ces tests ne
// vérifient donc pas des valeurs de référence de plus — ils vérifient que ce qui sera IMPRIMÉ
// est exactement ce qui a servi à choisir la machine.
describe('getRequiredKw — détail des postes', () => {
    const CTX = { coefG: 0.8, tBaseHiver: -9, tBaseEte: 33, consigne: 26 };

    test('la somme des postes froid vaut exactement le besoin froid', () => {
        const { froid, detail } = getRequiredKw(30, 2.5, ROOM_TYPE, CTX);
        const somme = Object.values(detail.froidPostes).reduce((a, b) => a + b, 0);
        assert.equal(detail.froidTotalW, somme, 'froidTotalW doit être la somme littérale des postes');
        assert.ok(Math.abs(somme / 1000 - froid) < 1e-12,
            `somme des postes ${somme / 1000} kW ≠ besoin froid ${froid} kW`);
    });

    test('déperditions sèches × coefficient de relance = besoin chaud', () => {
        const { chaud, detail } = getRequiredKw(30, 2.5, ROOM_TYPE, CTX);
        assert.equal(detail.chaudDetail.coefRelance, COEF_RELANCE);
        assert.ok(Math.abs(detail.chaudDetail.deperditionsSeches * COEF_RELANCE - chaud) < 1e-12);
    });

    test('poste toiture : nul en étage protégé, demi en plain-pied, plein sous toiture', () => {
        const toiture = (emplacement) =>
            getRequiredKw(30, 2.5, { ...ROOM_TYPE, emplacement }, CTX).detail.froidPostes.toiture;
        assert.equal(toiture('etage_protege'), 0);
        assert.ok(Math.abs(toiture('plain_pied') * 2 - toiture('sous_toiture')) < 1e-9);
    });

    test('postes internes et occupants suivent leurs constantes', () => {
        const { detail } = getRequiredKw(30, 2.5, { ...ROOM_TYPE, occupants: 3 }, CTX);
        assert.equal(detail.froidPostes.internes, APPORTS_INTERNES * 30);
        assert.equal(detail.froidPostes.occupants, 3 * OCCUPANT_W);
        assert.equal(detail.occupants.nb, 3);
        assert.equal(detail.occupants.wParOccupant, OCCUPANT_W);
    });

    test('occupants = 0 explicite se lit 0 dans le détail (pas de repli sur l\'estimation)', () => {
        const { detail } = getRequiredKw(30, 2.5, { ...ROOM_TYPE, occupants: 0 }, CTX);
        assert.equal(detail.occupants.nb, 0);
        assert.equal(detail.froidPostes.occupants, 0);
    });

    test('gPondere égale G quand les 4 murs donnent sur l\'extérieur', () => {
        const { detail } = getRequiredKw(30, 2.5, { ...ROOM_TYPE, expositionMurs: 4 }, CTX);
        assert.equal(detail.exposition.ratioExposition, 1);
        assert.equal(detail.exposition.nbMursExt, 4);
        assert.ok(Math.abs(detail.exposition.gPondere - 0.8) < 1e-12);
    });

    test('consigne au-dessus de la Tbase été : ΔT plancher à 0, poste enveloppe nul', () => {
        const { detail } = getRequiredKw(30, 2.5, ROOM_TYPE, { ...CTX, consigne: 40 });
        assert.equal(detail.deltaTEte, 0);
        assert.equal(detail.froidPostes.enveloppe, 0);
    });

    test('les entrées reprises dans le détail sont celles reçues (volume = surface × hauteur)', () => {
        const { detail } = getRequiredKw(30, 2.5, ROOM_TYPE, CTX);
        assert.equal(detail.entrees.surface, 30);
        assert.equal(detail.entrees.height, 2.5);
        assert.equal(detail.entrees.volume, 75);
        assert.equal(detail.entrees.coefG, 0.8);
        assert.equal(detail.entrees.consigne, 26);
    });

    test('non-régression : exposer le détail ne déplace ni froid ni chaud (cas Lyon)', () => {
        const req = getRequiredKw(30, 2.5, ROOM_TYPE, CTX);
        assert.ok(Math.abs(req.froid - 1.68896) < 0.001, `froid attendu ~1.68896, obtenu ${req.froid}`);
        assert.ok(Math.abs(req.chaud - 2.088) < 0.001, `chaud attendu ~2.088, obtenu ${req.chaud}`);
    });
});

describe('Facteur canicule (froid)', () => {
    test('climat tempéré (Tbase été au seuil bas ou en dessous) : facteur neutre', () => {
        assert.equal(getFacteurCanicule(28), 1.0);
        assert.equal(getFacteurCanicule(20), 1.0);
    });
    test('Tbase été au seuil haut (34°C, zones H/I) : majoration maximale', () => {
        assert.equal(getFacteurCanicule(34), 1.11);
        assert.equal(getFacteurCanicule(40), 1.11, 'plafonné au-delà du seuil haut');
    });
    test('interpolation progressive entre les seuils', () => {
        const f31 = getFacteurCanicule(31);
        assert.ok(f31 > 1.0 && f31 < 1.11, `attendu strictement entre 1.0 et 1.11, obtenu ${f31}`);
    });
    // La régression corrigée : zone F (Lyon, Tbase été 33°C) n'avait aucune marge alors que la
    // zone B (Tbase été 32°C, donc plus douce) en avait une — une inversion pure.
    test('une Tbase été plus élevée ne peut jamais donner une marge plus faible', () => {
        assert.ok(getFacteurCanicule(33) > getFacteurCanicule(32),
            'Lyon (33°C) doit recevoir une marge au moins aussi forte que la zone B (32°C)');
    });
    test('sans valeur de Tbase (undefined/NaN) : aucune marge, pas de crash', () => {
        assert.equal(getFacteurCanicule(undefined), 1.0);
        assert.equal(getFacteurCanicule(NaN), 1.0);
    });
});

describe('Déclassement chaud (grand froid)', () => {
    test('à +7°C ou plus : aucun déclassement (ratio 1.0)', () => {
        assert.equal(ratioDeclassementChaud(7), 1.0);
        assert.equal(ratioDeclassementChaud(15), 1.0);
    });
    test('à -20°C ou moins : ratio plancher (0.50)', () => {
        assert.equal(ratioDeclassementChaud(-20), 0.50);
        assert.equal(ratioDeclassementChaud(-30), 0.50);
    });
    test('interpolation à -9°C : entre les paliers -7°C (0.72) et -15°C (0.58)', () => {
        const ratio = ratioDeclassementChaud(-9);
        assert.ok(ratio < 0.72 && ratio > 0.58, `ratio attendu entre 0.58 et 0.72, obtenu ${ratio}`);
    });
    test('le facteur (multiplicateur) est l\'inverse du ratio', () => {
        const ratio = ratioDeclassementChaud(-9);
        const facteur = getFacteurDeclassementChaud(-9);
        assert.ok(Math.abs(facteur - 1 / ratio) < 1e-9);
    });
});

describe('estimerEcartConsigne', () => {
    test('écart nul à la consigne de référence', () => {
        assert.equal(estimerEcartConsigne(CONSIGNE_REFERENCE, 0.8, 33), 0);
    });
    test('consigne plus haute que la référence => écart négatif (besoin réduit)', () => {
        const ecart = estimerEcartConsigne(28, 0.8, 33);
        assert.ok(ecart < 0, `écart attendu négatif, obtenu ${ecart}`);
    });
});

describe('resolveCoefG', () => {
    test('valeur numérique directe', () => {
        assert.equal(resolveCoefG('0.35', ''), 0.35);
    });
    test('"custom" avec saisie valide', () => {
        assert.equal(resolveCoefG('custom', '0.65'), 0.65);
    });
    test('"custom" avec saisie vide ou invalide : repli sur la valeur par défaut (0.8)', () => {
        assert.equal(resolveCoefG('custom', ''), 0.8);
        assert.equal(resolveCoefG('custom', 'abc'), 0.8);
    });
});

// La surcharge toiture sautait de +61% (28 → 45 W/m²) exactement à la frontière G=0.8, qui est
// la valeur par défaut de l'application, et de +86% (15 → 28) à la frontière G=0.35. Les deux
// sauts n'avaient aucune justification physique — c'était un artefact des trois blocs disjoints
// 'bonne'/'moyenne'/'faible'.
describe('interpolerChargeToiture — continuité', () => {
    test('les points d\'ancrage sont préservés (pas de régression sur les cas de référence)', () => {
        for (const p of CHARGE_TOITURE_PALIERS) {
            assert.equal(interpolerChargeToiture(p.g), p.charge, `palier G=${p.g}`);
        }
    });
    test('plafonné en dehors des paliers, jamais extrapolé au-delà', () => {
        assert.equal(interpolerChargeToiture(0.1), CHARGE_TOITURE_PALIERS[0].charge, 'G très bas → minimum');
        assert.equal(interpolerChargeToiture(3.0), CHARGE_TOITURE_PALIERS.at(-1).charge, 'G véranda → maximum');
    });
    test('aucun saut supérieur à la variation d\'un pas de saisie usuel (±0.01) autour des anciennes frontières', () => {
        for (const frontiere of [0.35, 0.8]) {
            const avant = interpolerChargeToiture(frontiere - 0.005);
            const apres = interpolerChargeToiture(frontiere + 0.005);
            const ecartRelatif = Math.abs(apres - avant) / avant;
            assert.ok(ecartRelatif < 0.02, `saut de ${(ecartRelatif * 100).toFixed(1)}% autour de G=${frontiere}`);
        }
    });
    test('strictement croissante entre les paliers (jamais plate ni décroissante)', () => {
        const echantillon = [0.2, 0.35, 0.5, 0.65, 0.8, 1.0, 1.2, 2.0];
        for (let i = 1; i < echantillon.length; i++) {
            assert.ok(
                interpolerChargeToiture(echantillon[i]) >= interpolerChargeToiture(echantillon[i - 1]),
                `décroissance entre G=${echantillon[i - 1]} et G=${echantillon[i]}`
            );
        }
    });
});

// G_VITRAGE était une constante unique à 0.75 (proche du simple vitrage) appliquée à tout âge
// de bâti, alors que le vitrage posé suit la même époque de construction que le reste de
// l'enveloppe : un double vitrage clair standard est plutôt à 0.60, un vitrage à isolation
// renforcée (norme depuis la RT2012) à 0.52. Le vitrage pesant 34% du bilan froid, la
// surestimation touchait tout bâti récent.
describe('interpolerGVitrage — facteur solaire', () => {
    test('les points d\'ancrage sont préservés', () => {
        for (const p of G_VITRAGE_PALIERS) {
            assert.equal(interpolerGVitrage(p.g), p.gVitrage, `palier G=${p.g}`);
        }
    });
    test('plafonné en dehors des paliers', () => {
        assert.equal(interpolerGVitrage(0.1), G_VITRAGE_PALIERS[0].gVitrage, 'G très bas (RE2020) → minimum');
        assert.equal(interpolerGVitrage(3.0), G_VITRAGE_PALIERS.at(-1).gVitrage, 'G véranda → maximum');
    });
    test('un bâti plus ancien (G plus élevé) ne peut jamais avoir un facteur solaire plus faible', () => {
        const echantillon = [0.2, 0.35, 0.5, 0.65, 0.8, 1.0, 1.2, 2.0];
        for (let i = 1; i < echantillon.length; i++) {
            assert.ok(
                interpolerGVitrage(echantillon[i]) >= interpolerGVitrage(echantillon[i - 1]),
                `facteur solaire décroissant entre G=${echantillon[i - 1]} et G=${echantillon[i]}`
            );
        }
    });
    test('toutes les valeurs restent dans la fourchette physique d\'un vitrage résidentiel (0.4 à 0.85)', () => {
        for (const g of [0.1, 0.35, 0.5, 0.8, 1.2, 3.0]) {
            const v = interpolerGVitrage(g);
            assert.ok(v >= 0.4 && v <= 0.85, `G=${g} → gVitrage=${v} hors fourchette plausible`);
        }
    });
});

// Un artisan français tape « 2,5 », pas « 2.5 ». Les champs étaient en type="number", dont la
// valeur est vide dès que le contenu n'est pas au format anglo-saxon : la virgule n'atteignait
// jamais JavaScript, la hauteur devenait 0, et le besoin chaud s'affichait à 0.00 kW.
describe('parseNombreSaisi — virgule décimale', () => {
    test('accepte la virgule comme séparateur décimal', () => {
        assert.equal(parseNombreSaisi('2,5'), 2.5);
        assert.equal(parseNombreSaisi('0,65'), 0.65);
        assert.equal(parseNombreSaisi('30,25'), 30.25);
    });
    test('accepte toujours le point et les nombres déjà typés', () => {
        assert.equal(parseNombreSaisi('2.5'), 2.5);
        assert.equal(parseNombreSaisi(2.5), 2.5);
        assert.equal(parseNombreSaisi('30'), 30);
    });
    test('tolère les espaces autour de la saisie', () => {
        assert.equal(parseNombreSaisi('  2,5  '), 2.5);
    });
    test('conserve le zéro explicite, qui est une valeur métier (pièce inoccupée)', () => {
        assert.equal(parseNombreSaisi('0'), 0);
        assert.ok(Number.isFinite(parseNombreSaisi('0')));
    });
    test('renvoie NaN sur une saisie vide ou non numérique, sans choisir de repli', () => {
        for (const v of ['', '   ', 'abc', '2,5,3', null, undefined]) {
            assert.ok(Number.isNaN(parseNombreSaisi(v)), `« ${v} » devrait donner NaN`);
        }
    });
    test('le coefficient G personnalisé accepte la virgule', () => {
        assert.equal(resolveCoefG('custom', '0,45'), 0.45);
        assert.equal(resolveCoefG('custom', '0.45'), 0.45);
    });
});

// Ces tests portent sur UI_SIZE_TABLES, qui est une table saisie à la main en regard du
// catalogue : c'est exactement le genre de donnée qui diverge en silence. Le premier test la
// recalcule depuis CATALOGS pour interdire toute dérive ; les suivants verrouillent le
// comportement de la recherche de taille.
describe('Tailles UI — cohérence avec le catalogue', () => {
    // Extraction du code taille depuis une référence, par marque. Vit ici et non dans le code
    // de production : c'est un outil de vérification, pas une règle métier — la production lit
    // la table, elle ne la dérive pas (le catalogue doit rester chargeable sans parsing).
    const EXTRACTEURS = {
        toshiba: (ref) => (ref.match(/RAS-(\d{2})/) || [])[1],
        panasonic: (ref) => (ref.match(/^CU-(?:TZ|Z)(\d{2})/) || [])[1]
    };

    for (const marque of ['toshiba', 'panasonic']) {
        test(`${marque} : chaque plafond déclaré correspond au catalogue réel`, () => {
            const reel = new Map();
            for (const m of CATALOGS[marque].monosplits) {
                const code = EXTRACTEURS[marque](m.reference_ensemble);
                assert.ok(code, `code taille introuvable dans « ${m.reference_ensemble} »`);
                const cumul = reel.get(code) || { froidMax: 0, chaudMax: 0 };
                cumul.froidMax = Math.max(cumul.froidMax, m.puissance_froid_kw);
                cumul.chaudMax = Math.max(cumul.chaudMax, m.puissance_chaud_kw);
                reel.set(code, cumul);
            }

            const declaree = UI_SIZE_TABLES[marque];
            assert.deepEqual(
                declaree.map(r => r.code).sort(),
                [...reel.keys()].sort(),
                'les tailles déclarées et celles présentes au catalogue doivent coïncider'
            );
            for (const row of declaree) {
                const attendu = reel.get(row.code);
                assert.equal(row.froidMax, attendu.froidMax, `taille ${row.code} : plafond froid`);
                assert.equal(row.chaudMax, attendu.chaudMax, `taille ${row.code} : plafond chaud`);
            }
        });

        test(`${marque} : les plafonds croissent avec la taille`, () => {
            const t = UI_SIZE_TABLES[marque];
            for (let i = 1; i < t.length; i++) {
                assert.ok(t[i].froidMax >= t[i - 1].froidMax, `froid non monotone en ${t[i].code}`);
                assert.ok(t[i].chaudMax >= t[i - 1].chaudMax, `chaud non monotone en ${t[i].code}`);
            }
        });

        // La régression corrigée : un besoin exprimé en froid était confronté au plafond chaud,
        // toujours plus élevé sur une PAC air/air, donc la taille annoncée ne couvrait pas le froid.
        test(`${marque} : la taille retournée couvre réellement le besoin froid`, () => {
            for (const row of UI_SIZE_TABLES[marque]) {
                const besoin = row.froidMax;
                const code = getUiSizeForKw(besoin, 0, marque);
                assert.ok(code, `aucune taille pour un besoin de ${besoin} kW en froid`);
                const retenue = UI_SIZE_TABLES[marque].find(r => r.code === code);
                assert.ok(
                    retenue.froidMax >= besoin,
                    `besoin ${besoin} kW froid → taille ${code} qui ne délivre que ${retenue.froidMax} kW`
                );
            }
        });
    }

    test('un besoin hors catalogue ne renvoie aucune taille (déclencheur du délestage)', () => {
        assert.equal(getUiSizeForKw(999, 0, 'toshiba'), null);
        assert.equal(getUiSizeForKw(0, 999, 'toshiba'), null);
    });
});

describe('Sélection catalogue (Toshiba)', () => {
    test('getUiSizeForKw retourne le palier attendu', () => {
        assert.equal(getUiSizeForKw(1.8, 3.05, 'toshiba'), '10');
    });
    test('findBestMonos retourne les gammes équivalentes à +15% de la plus petite puissance', () => {
        const sols = findBestMonos(1.8, 3.05, 'toshiba');
        assert.ok(sols.length > 0, 'au moins une solution attendue');
        const minFroid = Math.min(...sols.map(s => s.puissance_froid_kw));
        for (const s of sols) {
            assert.ok(s.puissance_froid_kw <= minFroid * 1.15 + 1e-9, `${s.gamme} dépasse la tolérance de +15%`);
        }
    });
    // Sans départage par le chaud, l'ordre entre machines de même puissance froid était celui du
    // catalogue, donc arbitraire — et la première option est celle proposée par défaut.
    test('findBestMonos : à puissance froid égale, la machine la mieux ajustée en chaud passe devant', () => {
        const sols = findBestMonos(3.4, 3.5, 'toshiba');
        assert.ok(sols.length > 1, 'ce besoin doit produire plusieurs équivalents');
        for (let i = 1; i < sols.length; i++) {
            const [prec, cur] = [sols[i - 1], sols[i]];
            if (prec.puissance_froid_kw === cur.puissance_froid_kw) {
                assert.ok(prec.puissance_chaud_kw <= cur.puissance_chaud_kw,
                    `${prec.gamme} (${prec.puissance_chaud_kw} kW C) devrait suivre ${cur.gamme} (${cur.puissance_chaud_kw} kW C)`);
            }
        }
    });
    test('findBestMonos : le tri reste piloté par le froid en premier critère', () => {
        const sols = findBestMonos(2.0, 2.0, 'toshiba');
        for (let i = 1; i < sols.length; i++) {
            assert.ok(sols[i].puissance_froid_kw >= sols[i - 1].puissance_froid_kw, 'froid non croissant');
        }
    });
    test('findBestMonos retourne un tableau vide si aucune machine ne couvre le besoin', () => {
        assert.deepEqual(findBestMonos(999, 999, 'toshiba'), []);
    });

    // "Froid seul" (app.js) neutralise le besoin chaud pour la sélection en le mettant à 0 avant
    // d'appeler ces fonctions pures — un besoin chaud hors catalogue à lui seul ne doit donc plus
    // exclure de solution, alors qu'un besoin froid hors catalogue doit toujours en exclure.
    test('un besoin chaud = 0 ne contraint plus la sélection (mode "froid seul")', () => {
        const sansContrainteChaud = findBestMonos(1.8, 0, 'toshiba');
        assert.ok(sansContrainteChaud.length > 0, 'des solutions doivent rester disponibles');
        assert.equal(getUiSizeForKw(1.8, 0, 'toshiba'), getUiSizeForKw(1.8, 0.1, 'toshiba'), 'la taille ne doit dépendre que du froid quand le chaud est neutralisé');
    });
    test('un besoin chaud hors catalogue exclut toujours tout en mode réversible normal', () => {
        assert.deepEqual(findBestMonos(1.8, 999, 'toshiba'), []);
    });
});

describe('Sélection groupe multisplit', () => {
    test('findMultiGroup renvoie "MONO" pour une seule pièce', () => {
        assert.equal(findMultiGroup([{ froidMatch: 2, chaudMatch: 2 }], 'toshiba', COEF_FOISONNEMENT_FROID, COEF_FOISONNEMENT_CHAUD), 'MONO');
    });
    test('findMultiGroup renvoie null si aucun groupe ne convient (besoin hors catalogue)', () => {
        const roomsObj = [{ froidMatch: 50, chaudMatch: 50 }, { froidMatch: 50, chaudMatch: 50 }];
        assert.equal(findMultiGroup(roomsObj, 'toshiba', COEF_FOISONNEMENT_FROID, COEF_FOISONNEMENT_CHAUD), null);
    });
    test('findMultiGroupOptions couvre le besoin cumulé avec le foisonnement', () => {
        const roomsObj = [{ froidMatch: 1.3, chaudMatch: 1.5 }, { froidMatch: 1.3, chaudMatch: 1.5 }];
        const opts = findMultiGroupOptions(roomsObj, 'toshiba', COEF_FOISONNEMENT_FROID, COEF_FOISONNEMENT_CHAUD);
        assert.ok(opts.length > 0, 'au moins un groupe doit convenir pour 2 petites pièces');
        const totF = 2.6, totC = 3.0;
        for (const g of opts) {
            assert.ok(g.puissance_nominale_froid_kw * COEF_FOISONNEMENT_FROID >= totF - 1e-9);
            assert.ok(g.puissance_nominale_chaud_kw * COEF_FOISONNEMENT_CHAUD >= totC - 1e-9);
        }
    });
});

// La part d'un groupe absorbée par une pièce était calculée en divisant max(froidMatch,
// chaudMatch) par max(nominal froid, nominal chaud) : deux maxima pris indépendamment, donc
// possiblement issus de MODES DIFFÉRENTS. Le nominal chaud étant toujours le plus élevé sur les
// groupes du catalogue, tout besoin dominé par le froid était rapporté à une capacité chaud plus
// grande et sa part sous-estimée — sans jamais déclencher l'alerte de déséquilibre.
describe('Part d\'un groupe absorbée par une pièce (froid et chaud confrontés à leur propre capacité)', () => {
    const GROUPE = { reference: 'TEST-2M', max_unites_interieures: 3, puissance_nominale_froid_kw: 5.2, puissance_nominale_chaud_kw: 6.8 };

    test('le besoin froid est rapporté à la capacité FROID, pas à la capacité chaud', () => {
        const piece = { froidMatch: 3.4, chaudMatch: 0 };
        assert.ok(Math.abs(partPieceDansGroupe(piece, GROUPE) - 3.4 / 5.2) < 1e-9,
            'en froid seul, la part doit valoir froidMatch / nominal froid');
    });

    test('le besoin chaud est rapporté à la capacité CHAUD', () => {
        const piece = { froidMatch: 0.5, chaudMatch: 3.4 };
        assert.ok(Math.abs(partPieceDansGroupe(piece, GROUPE) - 3.4 / 6.8) < 1e-9);
    });

    test('la part retenue est la plus contraignante des deux modes', () => {
        const piece = { froidMatch: 3.0, chaudMatch: 3.0 };
        // 3.0/5.2 = 0.577 en froid, 3.0/6.8 = 0.441 en chaud : c'est le froid qui contraint.
        assert.ok(Math.abs(partPieceDansGroupe(piece, GROUPE) - 3.0 / 5.2) < 1e-9);
    });

    // La régression exacte, en mode « Froid seul » — le mode où le bug était systématique.
    test('mode froid seul : une pièce à 65% de la capacité froid est bien détectée comme déséquilibrante', () => {
        // Les besoins dépassent volontairement la puissance nominale (5,6 > 5,2) : c'est la
        // condition pour que la question du déséquilibre se pose, puisque le groupe s'appuie
        // alors sur le foisonnement (voir estGroupeDesequilibre). La version précédente de ce
        // test totalisait 5,1 kW, donc sous le nominal — le groupe servait déjà les trois pièces
        // à leur pointe simultanée et aucune ne pouvait en priver une autre. Il testait donc le
        // seuil sur une configuration où il n'a pas lieu de s'appliquer ; les besoins sont
        // relevés pour que la régression d'origine (le ratio calculé à 50 % au lieu de 65 %)
        // reste couverte sur un cas où elle compte vraiment.
        const pieces = [
            { index: 1, froidMatch: 3.4, chaudMatch: 0 },
            { index: 2, froidMatch: 1.2, chaudMatch: 0 },
            { index: 3, froidMatch: 1.0, chaudMatch: 0 }
        ];
        const ratio = ratioPieceDominante(GROUPE, pieces);
        assert.ok(Math.abs(ratio - 3.4 / 5.2) < 1e-9, `ratio attendu ${(3.4 / 5.2).toFixed(3)}, obtenu ${ratio}`);
        assert.ok(ratio > SEUIL_DESEQUILIBRE_GROUPE, 'ce ratio dépasse le seuil et doit donc alerter');
        assert.equal(estGroupeDesequilibre(GROUPE, pieces), true,
            'avec l\'ancien calcul, cette configuration passait à 50% et n\'alertait jamais');
    });

    // Le garde-fou qui manquait : le seuil de part dominante ne vaut que si le groupe parie sur
    // le foisonnement. Quand il couvre déjà la somme des pointes, aucune pièce ne peut en priver
    // une autre, et la part dominante — si élevée soit-elle — ne décrit plus un risque.
    test('un groupe qui couvre la somme des pointes n\'est jamais déséquilibré, même à 65%', () => {
        const pieces = [
            { index: 1, froidMatch: 3.4, chaudMatch: 0 },
            { index: 2, froidMatch: 0.9, chaudMatch: 0 },
            { index: 3, froidMatch: 0.8, chaudMatch: 0 }
        ];
        const total = 3.4 + 0.9 + 0.8;
        assert.ok(total <= GROUPE.puissance_nominale_froid_kw,
            `${total} kW doivent tenir dans les ${GROUPE.puissance_nominale_froid_kw} kW du groupe`);
        assert.ok(ratioPieceDominante(GROUPE, pieces) > SEUIL_DESEQUILIBRE_GROUPE,
            'la pièce dominante dépasse pourtant bien le seuil');
        assert.equal(estGroupeDesequilibre(GROUPE, pieces), false,
            'quand la pièce dominante est à sa pointe, il reste de quoi servir les autres');
    });

    // Le nom affiché et le pourcentage affiché doivent désigner la même pièce.
    test('la pièce dominante en part du groupe peut différer de la pièce dominante en kW bruts', () => {
        const pieces = [
            { index: 1, froidMatch: 3.0, chaudMatch: 2.0 },   // 3.0/5.2 = 0.577
            { index: 2, froidMatch: 2.0, chaudMatch: 3.5 }    // 3.5/6.8 = 0.515
        ];
        assert.equal(pieceDominante(pieces).index, 2, 'en kW bruts, la pièce 2 demande le plus (3.5)');
        assert.equal(pieceDominantePourGroupe(GROUPE, pieces).index, 1, 'mais c\'est la pièce 1 qui pèse le plus sur le groupe');
        assert.ok(Math.abs(ratioPieceDominante(GROUPE, pieces) - 3.0 / 5.2) < 1e-9,
            'le ratio doit être celui de la pièce réellement dominante');
    });

    test('entrées dégradées : ni pièce ni groupe ne fait planter le calcul', () => {
        assert.equal(partPieceDansGroupe(null, GROUPE), 0);
        assert.equal(partPieceDansGroupe({ froidMatch: 1, chaudMatch: 1 }, null), 0);
        assert.equal(pieceDominantePourGroupe(GROUPE, []), null);
    });
});

describe('Équilibre du groupe multisplit (demande simultanée)', () => {
    // Cas réel remonté par le terrain : 2 pièces en zone chaude (canicule +11%) avec déclassement
    // chaud +25%. Le plus petit groupe valide (2M14) laisse la pièce 2 absorber ~63% de la puissance
    // nominale : l'application doit proposer d'elle-même le cran au-dessus (2M18) plutôt que de se
    // contenter d'alerter et de renvoyer vers un monosplit dédié.
    // Marges reprises des constantes réelles plutôt que recopiées en dur : un changement de
    // ABATTEMENT_CANICULE_MAX ou de COEF_FOISONNEMENT_CHAUD doit se répercuter ici automatiquement,
    // sinon ce test continuerait de passer avec des marges qui ne correspondent plus à l'application.
    const CAS_TERRAIN = [
        { index: 1, req: { froid: 0.86, chaud: 1.83 }, froidMatch: 0.86 * ABATTEMENT_CANICULE_MAX, chaudMatch: 1.83 * COEF_FOISONNEMENT_CHAUD },
        { index: 2, req: { froid: 1.70, chaud: 2.23 }, froidMatch: 1.70 * ABATTEMENT_CANICULE_MAX, chaudMatch: 2.23 * COEF_FOISONNEMENT_CHAUD }
    ];
    const besoinsTerrain = { froid: 2.56, chaud: 4.06 };

    test('pieceDominante identifie la pièce la plus demandeuse', () => {
        assert.equal(pieceDominante(CAS_TERRAIN).index, 2);
        assert.equal(pieceDominante([]), null);
    });

    test('le plus petit groupe valide (2M14) est bien détecté comme déséquilibré', () => {
        const opts = findMultiGroupOptions(CAS_TERRAIN, 'toshiba', COEF_FOISONNEMENT_FROID, COEF_FOISONNEMENT_CHAUD);
        assert.equal(opts[0].reference, 'RAS-2M14G3AVG-E');
        assert.ok(ratioPieceDominante(opts[0], CAS_TERRAIN) > SEUIL_DESEQUILIBRE_GROUPE);
        assert.equal(estGroupeDesequilibre(opts[0], CAS_TERRAIN), true);
    });

    test('findGroupeEquilibre propose le 2M18 : couvre le besoin ET repasse sous le seuil', () => {
        const up = findGroupeEquilibre(CAS_TERRAIN, 'toshiba', COEF_FOISONNEMENT_FROID, COEF_FOISONNEMENT_CHAUD, besoinsTerrain);
        assert.equal(up.reference, 'RAS-2M18G3AVG-E');
        assert.equal(estGroupeDesequilibre(up, CAS_TERRAIN), false);
        assert.ok(ratioPieceDominante(up, CAS_TERRAIN) < SEUIL_DESEQUILIBRE_GROUPE);
    });

    test('à puissance froid égale, le groupe au plus petit nombre de sorties passe devant (2M18 avant 3M18)', () => {
        const refs = findGroupesValides(CAS_TERRAIN, 'toshiba', COEF_FOISONNEMENT_FROID, COEF_FOISONNEMENT_CHAUD).map(g => g.reference);
        assert.ok(refs.indexOf('RAS-2M18G3AVG-E') < refs.indexOf('RAS-3M18G3AVG-E'), `ordre inattendu : ${refs.join(', ')}`);
    });

    test('une pièce unique n\'est jamais déséquilibrée (personne à pénaliser)', () => {
        const group = { reference: 'X', max_unites_interieures: 2, puissance_nominale_froid_kw: 3.3, puissance_nominale_chaud_kw: 4.0 };
        assert.equal(estGroupeDesequilibre(group, [{ froidMatch: 3.0, chaudMatch: 3.9 }]), false);
    });

    test('deux pièces équilibrées : aucune escalade n\'est nécessaire (le groupe juste dimensionné convient)', () => {
        const rooms = [{ froidMatch: 1.3, chaudMatch: 1.5 }, { froidMatch: 1.3, chaudMatch: 1.5 }];
        const opts = findMultiGroupOptions(rooms, 'toshiba', COEF_FOISONNEMENT_FROID, COEF_FOISONNEMENT_CHAUD);
        assert.equal(estGroupeDesequilibre(opts[0], rooms), false);
        const up = findGroupeEquilibre(rooms, 'toshiba', COEF_FOISONNEMENT_FROID, COEF_FOISONNEMENT_CHAUD, { froid: 2.6, chaud: 3.0 });
        assert.equal(up.reference, opts[0].reference, 'le groupe déjà équilibré doit être retourné tel quel');
    });

    test('escalade refusée si elle ferait tomber le groupe sous le plancher de taux de charge', () => {
        // Même configuration de pièces, mais un besoin réel volontairement dérisoire : tout groupe
        // rééquilibrant serait alors très surdimensionné, l'escalade doit être abandonnée (le
        // délestage en monosplit dédié reste la seule réponse au déséquilibre).
        const up = findGroupeEquilibre(CAS_TERRAIN, 'toshiba', COEF_FOISONNEMENT_FROID, COEF_FOISONNEMENT_CHAUD, { froid: 0.5, chaud: 0.5 });
        assert.equal(up, null);
    });

    test('aucun groupe rééquilibrant dans le catalogue : findGroupeEquilibre retourne null', () => {
        // Une petite pièce + une grosse pièce, dans un cas où AUCUN groupe ne couvre la somme des
        // pointes : le foisonnement reste donc indispensable, le seuil de part dominante
        // s'applique, et aucun groupe du catalogue ne ramène la grosse pièce sous les 60 %.
        // 10,5 / 12,5 kW dépassent le plus gros groupe du catalogue (10 / 12), qui reste néanmoins
        // valide grâce au foisonnement — donc le seuil s'applique, et la grosse pièce y pèse 70 %.
        const rooms = [{ froidMatch: 3.5, chaudMatch: 4.5 }, { froidMatch: 7.0, chaudMatch: 8.0 }];
        assert.equal(findGroupeEquilibre(rooms, 'toshiba', COEF_FOISONNEMENT_FROID, COEF_FOISONNEMENT_CHAUD, { froid: 10.5, chaud: 12.5 }), null);
    });

    // Le pendant du test précédent, à la frontière exacte : la plus grosse UI du catalogue
    // (taille 24 = 7,0 kW F / 8,0 kW C) avec une petite pièce totalise 7,8 / 9,0 kW, que le
    // RAS-4M27 (8 / 9 kW) couvre tout juste. La grosse pièce y pèse 89 %, très au-dessus du
    // seuil, mais elle ne peut priver personne : il reste exactement de quoi servir la petite.
    // Le groupe est donc proposé, là où l'ancienne règle renvoyait au monosplit dédié.
    test('à la frontière du catalogue, un groupe qui couvre tout est proposé malgré une part de 89%', () => {
        const rooms = [{ froidMatch: 0.8, chaudMatch: 1.0 }, { froidMatch: 7.0, chaudMatch: 8.0 }];
        const up = findGroupeEquilibre(rooms, 'toshiba', COEF_FOISONNEMENT_FROID, COEF_FOISONNEMENT_CHAUD, { froid: 7.8, chaud: 9.0 });
        assert.equal(up.reference, 'RAS-4M27G3AVG-E');
        assert.equal(7.8 <= up.puissance_nominale_froid_kw && 9.0 <= up.puissance_nominale_chaud_kw, true,
            'le groupe retenu couvre bien les deux pièces à leur pointe simultanée');
    });

    test('tauxChargeGroupe ignore le chaud en mode "froid seul" (besoin chaud nul)', () => {
        const group = { puissance_nominale_froid_kw: 5.2, puissance_nominale_chaud_kw: 5.6 };
        const avecChaud = tauxChargeGroupe(group, 2.56, 4.06);
        assert.ok(Math.abs(avecChaud.froid - 2.56 / 5.2) < 1e-9);
        assert.ok(Math.abs(avecChaud.min - 2.56 / 5.2) < 1e-9);
        const froidSeul = tauxChargeGroupe(group, 2.56, 0);
        assert.equal(froidSeul.chaud, null);
        assert.equal(froidSeul.min, froidSeul.froid);
    });
});

// Référence : fichier Toshiba « TVA 5,5 éligibilité Toshiba v3 » (voir TVA_RULES dans data.js).
describe('TVA 5,5% (Toshiba) — monosplit', () => {
    test('Naka : non éligible, toutes tailles', () => {
        for (const ref of ['RAS-05B2AVG-E / RAS-B05B2KVG-E', 'RAS-10B2AVG-E / RAS-B10B2KVG-E', 'RAS-24B2AVG-E / RAS-B24B2KVG-E']) {
            const info = getTvaInfo('Naka', ref, 'mono', 'toshiba');
            assert.equal(info.statut, 'non_eligible', ref);
            assert.equal(info.eligible, false);
        }
    });
    test('Shorai Curve : éligible sans wifi requis', () => {
        const info = getTvaInfo('Shorai Curve', 'RAS-10P2AVSG-E / RAS-B10P2KVSG-E', 'mono', 'toshiba');
        assert.equal(info.statut, 'eligible');
        assert.equal(info.eligible, true);
        assert.equal(info.wifiRequired, false);
    });
    test('Yukai : éligible avec module Wifi jusqu\'à la taille 16, refusée en 18 et 24', () => {
        const t16 = getTvaInfo('Yukai', 'RAS-16E2AVG-E / RAS-B16E2KVG-E', 'mono', 'toshiba');
        assert.equal(t16.statut, 'eligible');
        assert.equal(t16.wifiRequired, true);
        for (const ref of ['RAS-18E2AVG-E / RAS-B18E2KVG-E', 'RAS-24E2AVG-E / RAS-B24E2KVG-E']) {
            assert.equal(getTvaInfo('Yukai', ref, 'mono', 'toshiba').statut, 'non_eligible', ref);
        }
    });
    test('Haori, Daiseikai 10, Console Double-Flux : éligibles sans wifi sur leurs tailles listées', () => {
        for (const [gamme, ref] of [
            ['Haori', 'RAS-13J2AVSG-E1 / RAS-B13N4KVRG-E'],
            ['Daiseikai 10', 'RAS-18S4AVPG-E / RAS-B18S4KVDG-E'],
            ['Console Double-Flux', 'RAS-10J2AVSG-E1 / RAS-B10J2FVG-E']
        ]) {
            const info = getTvaInfo(gamme, ref, 'mono', 'toshiba');
            assert.equal(info.statut, 'eligible', gamme);
            assert.equal(info.wifiRequired, false, gamme);
        }
    });
    test('Shorai Curve : toute la gamme est éligible, taille 24 comprise (absente du tableau v3)', () => {
        const info = getTvaInfo('Shorai Curve', 'RAS-24P2AVSG-E / RAS-B24P2KVSG-E', 'mono', 'toshiba');
        assert.equal(info.statut, 'eligible');
        assert.equal(info.wifiRequired, false);
    });

    test('taille inconnue d\'une gamme couverte : "à vérifier", ni 5,5% ni 20%', () => {
        const info = getTvaInfo('Haori', 'RAS-22J2AVSG-E1 / RAS-B22N4KVRG-E', 'mono', 'toshiba');
        assert.equal(info.statut, 'a_verifier');
        assert.equal(info.eligible, false);
        assert.equal(info.wifiRequired, false);
    });
    test('Panasonic : aucune règle TVA connue (retourne null)', () => {
        assert.equal(getTvaInfo('Etherea', 'CU-Z35CKE / CS-Z35CKEW', 'mono', 'panasonic'), null);
        assert.equal(getTvaInfo('Etherea', 'CU-Z35CKE / CS-Z35CKEW', 'multiUi', 'panasonic', 'CU-2Z50CBE'), null);
        assert.equal(getGroupTvaInfo('CU-2Z50CBE', 'panasonic'), null);
    });
});

// Garde-fou de dérive : chaque machine réellement proposable par l'application doit avoir un statut
// TVA connu et conforme au tableau v3 — un ajout au catalogue sans mise à jour des règles se voit ici.
describe('TVA — couverture de tout le catalogue monosplit Toshiba', () => {
    const attendu = { 'Naka': 'non_eligible', 'Yukai': 'eligible', 'Shorai Curve': 'eligible', 'Haori': 'eligible', 'Daiseikai 10': 'eligible', 'Console Double-Flux': 'eligible' };
    const exceptions = { 'Yukai:18': 'non_eligible', 'Yukai:24': 'non_eligible' };

    test('statut conforme pour chaque référence du catalogue', () => {
        for (const m of CATALOGS.toshiba.monosplits) {
            const taille = m.reference_ensemble.match(/RAS-(\d{2})/)[1];
            const attenduRef = exceptions[`${m.gamme}:${taille}`] || attendu[m.gamme];
            const info = getTvaInfo(m.gamme, m.reference_ensemble, 'mono', 'toshiba');
            assert.ok(info, `aucune règle TVA pour ${m.gamme} ${m.reference_ensemble}`);
            assert.equal(info.statut, attenduRef, `${m.gamme} taille ${taille}`);
        }
    });

    test('le module Wifi n\'est exigé que sur Yukai en monosplit', () => {
        for (const m of CATALOGS.toshiba.monosplits) {
            const info = getTvaInfo(m.gamme, m.reference_ensemble, 'mono', 'toshiba');
            assert.equal(info.wifiRequired, m.gamme === 'Yukai' && info.eligible, `${m.gamme} ${m.reference_ensemble}`);
        }
    });
});

describe('Priorité TVA entre solutions équivalentes (monosplit)', () => {
    test('à puissance équivalente, une machine éligible passe devant une machine en TVA 20%', () => {
        // Besoin couvert à la fois par Naka (refusée) et par des gammes éligibles de même puissance.
        const sols = findBestMonos(2.4, 3.0, 'toshiba');
        assert.ok(sols.some(s => s.gamme === 'Naka'), 'le cas de test suppose une Naka parmi les équivalents');
        const tries = trierMonosParTva(sols, 'toshiba');
        assert.notEqual(tries[0].gamme, 'Naka', 'la première option (choisie par défaut) ne doit plus être la gamme non éligible');
        assert.equal(getTvaInfo(tries[0].gamme, tries[0].reference_ensemble, 'mono', 'toshiba').statut, 'eligible');
        assert.equal(tries.length, sols.length, 'aucune option ne doit être retirée');
        assert.equal(tries[tries.length - 1].gamme, 'Naka', 'la gamme en TVA 20% reste proposée, en dernier');
    });

    test('tri stable : à rang TVA égal, l\'ordre par puissance croissante est conservé', () => {
        const sols = findBestMonos(2.4, 3.0, 'toshiba');
        const tries = trierMonosParTva(sols, 'toshiba');
        const eligibles = tries.filter(s => getTvaInfo(s.gamme, s.reference_ensemble, 'mono', 'toshiba').statut === 'eligible');
        const attendu = sols.filter(s => getTvaInfo(s.gamme, s.reference_ensemble, 'mono', 'toshiba').statut === 'eligible');
        assert.deepEqual(eligibles.map(s => s.reference_ensemble), attendu.map(s => s.reference_ensemble));
    });

    test('marque sans base TVA (Panasonic) : ordre inchangé', () => {
        const sols = findBestMonos(2.4, 3.0, 'panasonic');
        assert.deepEqual(trierMonosParTva(sols, 'panasonic').map(s => s.reference_ensemble), sols.map(s => s.reference_ensemble));
    });

    test('le guide des UI en multisplit n\'est pas réordonné par la TVA (findBestMonos intact)', () => {
        const sols = findBestMonos(2.4, 3.0, 'toshiba');
        const puissances = sols.map(s => s.puissance_froid_kw);
        assert.deepEqual(puissances, [...puissances].sort((a, b) => a - b), 'findBestMonos doit rester trié par puissance croissante');
    });
});

describe('TVA 5,5% (Toshiba) — multisplit : la règle change', () => {
    const GROUPE = 'RAS-2M14G3AVG-E';

    test('le groupe extérieur porte l\'éligibilité et est listé comme éligible', () => {
        const info = getGroupTvaInfo(GROUPE, 'toshiba');
        assert.equal(info.statut, 'eligible');
        assert.equal(info.wifiRequired, false);
    });

    test('suffixe de millésime ignoré : RAS-5M34G3AVG-E/ET (catalogue) = -E1 (tableau)', () => {
        assert.equal(normaliserReferenceGroupe('RAS-5M34G3AVG-E/ET', 'toshiba'), 'RAS-5M34G3AVG');
        assert.equal(normaliserReferenceGroupe('RAS-5M34G3AVG-E1', 'toshiba'), 'RAS-5M34G3AVG');
        assert.equal(getGroupTvaInfo('RAS-5M34G3AVG-E/ET', 'toshiba').statut, 'eligible');
    });

    test('tous les groupes du catalogue Toshiba sont éligibles', () => {
        for (const g of CATALOGS.toshiba.multisplits_groupes_exterieurs) {
            assert.equal(getGroupTvaInfo(g.reference, 'toshiba').statut, 'eligible', g.reference);
        }
    });

    test('Naka en UI sur un groupe : éligible, alors qu\'elle est refusée en monosplit', () => {
        assert.equal(getTvaInfo('Naka', 'RAS-10B2AVG-E / RAS-B10B2KVG-E', 'mono', 'toshiba').statut, 'non_eligible');
        const enMulti = getTvaInfo('Naka', 'RAS-10B2AVG-E / RAS-B10B2KVG-E', 'multiUi', 'toshiba', GROUPE);
        assert.equal(enMulti.statut, 'eligible');
    });

    test('Yukai 18 en UI sur un groupe : éligible, alors que la taille est refusée en monosplit', () => {
        assert.equal(getTvaInfo('Yukai', 'RAS-18E2AVG-E / RAS-B18E2KVG-E', 'mono', 'toshiba').statut, 'non_eligible');
        assert.equal(getTvaInfo('Yukai', 'RAS-18E2AVG-E / RAS-B18E2KVG-E', 'multiUi', 'toshiba', GROUPE).statut, 'eligible');
    });

    test('plus aucune condition de module Wifi en multisplit (changement v2 -> v3)', () => {
        for (const gamme of ['Naka', 'Yukai', 'Console Double-Flux', 'Shorai Curve', 'Haori', 'Daiseikai 10']) {
            const info = getTvaInfo(gamme, 'RAS-10B2AVG-E / RAS-B10B2KVG-E', 'multiUi', 'toshiba', GROUPE);
            assert.equal(info.statut, 'eligible', gamme);
            assert.equal(info.wifiRequired, false, gamme);
        }
    });

    test('groupe extérieur hors tableau : les UI raccordées passent en "à vérifier"', () => {
        assert.equal(getGroupTvaInfo('RAS-9M99XXXX-E', 'toshiba').statut, 'a_verifier');
        assert.equal(getTvaInfo('Shorai Curve', 'RAS-10P2AVSG-E / RAS-B10P2KVSG-E', 'multiUi', 'toshiba', 'RAS-9M99XXXX-E').statut, 'a_verifier');
    });

    test('référence de groupe absente (null) : "à vérifier" plutôt qu\'une promesse de 5,5%', () => {
        assert.equal(getTvaInfo('Shorai Curve', 'RAS-10P2AVSG-E / RAS-B10P2KVSG-E', 'multiUi', 'toshiba').statut, 'a_verifier');
    });
});

// L'extraction du code taille et la normalisation de référence de groupe étaient toutes deux
// verrouillées sur la nomenclature Toshiba (préfixe "RAS-" + 2 chiffres, suffixes "-E"/"-ND").
// Pour toute autre marque, la regex ne matchait jamais et les deux gardes `if (taille && ...)`
// de getTvaInfo étaient sautées : TOUTE référence de cette marque atterrissait sur "a_verifier",
// y compris une taille qu'un futur tableau constructeur désignerait explicitement comme non
// éligible. Ces tests ajoutent une marque fictive à la nomenclature délibérément différente
// (aucun "RAS-", aucun suffixe "-E") pour prouver que plus aucune regex ne conditionne le
// résultat — la taille est désormais résolue depuis le catalogue lui-même.
describe('Généricité multi-marques (extraction taille, normalisation référence)', () => {
    const MARQUE_FICTIVE = 'marque-test-generique';

    // Nomenclature volontairement exotique : espaces, minuscules, aucun tiret — rien qui puisse
    // matcher /RAS-(\d{2})/ ni aucun autre motif Toshiba par accident.
    CATALOGS[MARQUE_FICTIVE] = {
        monosplits: [
            { gamme: 'Alpha', reference_ensemble: 'ZX 100 alpha unit', puissance_froid_kw: 2.2, puissance_chaud_kw: 2.6 },
            { gamme: 'Alpha', reference_ensemble: 'ZX 200 alpha unit', puissance_froid_kw: 3.8, puissance_chaud_kw: 4.1 }
        ],
        multisplits_groupes_exterieurs: []
    };
    UI_SIZE_TABLES[MARQUE_FICTIVE] = [
        { code: 'petit', froidMax: 2.2, chaudMax: 2.6 },
        { code: 'grand', froidMax: 3.8, chaudMax: 4.1 }
    ];

    test('getUiSizeForKw résout la bonne taille sans dépendre d\'un format de référence', () => {
        assert.equal(getUiSizeForKw(2.2, 2.6, MARQUE_FICTIVE), 'petit');
        assert.equal(getUiSizeForKw(3.8, 4.1, MARQUE_FICTIVE), 'grand');
    });

    test('getTvaInfo dégrade sur "aucune base TVA" pour une marque inconnue du dispositif, sans planter', () => {
        assert.equal(getTvaInfo('Alpha', 'ZX 100 alpha unit', 'mono', MARQUE_FICTIVE), null);
    });

    test('normaliserReferenceGroupe ne retire AUCUN suffixe pour une marque hors SUFFIXES_MILLESIME_GROUPE', () => {
        // Même chaîne, comportement délibérément différent selon la marque : "-E1" est un
        // suffixe de millésime CHEZ TOSHIBA, retiré pour la comparaison au tableau constructeur.
        // Pour la marque fictive, "-E1" pourrait tout aussi bien désigner une révision matérielle
        // distincte — sans entrée dans SUFFIXES_MILLESIME_GROUPE, rien n'est retiré, et c'est le
        // comportement sûr : appliquer la règle Toshiba par défaut à une nomenclature inconnue
        // ferait glisser l'éligibilité TVA d'une machine à une autre, en silence.
        assert.equal(normaliserReferenceGroupe('ZX-900-E1', MARQUE_FICTIVE), 'ZX-900-E1');
        assert.equal(normaliserReferenceGroupe('ZX-900-E1', 'toshiba'), 'ZX-900', 'chez Toshiba, "-E1" est bien un suffixe de millésime retiré');
    });

    test('une référence inconnue du catalogue dégrade sur "a_verifier", jamais une TypeError', () => {
        // Simule une entrée TVA_RULES qui existerait pour cette marque : même dans ce cas, une
        // référence absente du catalogue (faute de frappe, gamme retirée) ne doit jamais faire
        // planter le calcul — seulement renvoyer une taille introuvable.
        assert.doesNotThrow(() => getTvaInfo('Alpha', 'référence qui n\'existe pas', 'mono', MARQUE_FICTIVE));
    });

    // Nettoyage : ces clés ne doivent pas fuiter vers les autres tests du fichier (CATALOGS et
    // UI_SIZE_TABLES sont des singletons partagés, importés une seule fois par tout le module).
    test('nettoyage de la marque fictive', () => {
        delete CATALOGS[MARQUE_FICTIVE];
        delete UI_SIZE_TABLES[MARQUE_FICTIVE];
        assert.equal(CATALOGS[MARQUE_FICTIVE], undefined);
    });
});

describe('occupantsParDefaut', () => {
    test('≈ 1 personne / 15 m²', () => {
        assert.equal(occupantsParDefaut(30), 2);
        assert.equal(occupantsParDefaut(10), 1);
    });
    test('surface vide : pas d\'estimation', () => {
        assert.equal(occupantsParDefaut(''), '');
    });
});

describe('getRoomEligibleGammes', () => {
    test('restreint aux gammes compatibles avec le groupe (Panasonic Multi TZ)', () => {
        const room = { froidMatch: 1.8, chaudMatch: 2.2 };
        const gammes = getRoomEligibleGammes(room, ['TZ Ultra Compact'], 'panasonic');
        assert.deepEqual(gammes, ['TZ Ultra Compact']);
    });

    // Une petite chambre (besoin ~1,5 kW F / 2,0 kW C) tombe pile sur la taille 05 : la Shorai
    // Curve démarre au 07 (2,0 kW F), donc trop grande de +33% en froid pour entrer dans la bande
    // d'équivalence (+15%, TOLERANCE_EQUIVALENCE) — elle disparaissait des gammes proposées, quand
    // bien même Toshiba vend une UI Curve 05 attelée à un groupe multisplit (RAS-M05P2KVSG-E, voir
    // UI_MULTI_SEUL, data.js). En groupe multisplit uniquement, elle doit redevenir une alternative
    // à Naka/Yukai à cette taille.
    test('Shorai Curve 05 (multi-seule) rejoint Naka/Yukai à la taille 05, en groupe multisplit', () => {
        const room = { froidMatch: 1.5, chaudMatch: 2.0 };
        const gammes = getRoomEligibleGammes(room, null, 'toshiba');
        assert.ok(gammes.includes('Shorai Curve'), `Shorai Curve absente : ${gammes.join(', ')}`);
        assert.ok(gammes.includes('Naka'));
        assert.ok(gammes.includes('Yukai'));
    });

    test('Shorai Curve 05 reste absente de findBestMonos seul : aucun ensemble mono ne l\'offre à cette taille', () => {
        const sols = findBestMonos(1.5, 2.0, 'toshiba');
        assert.ok(!sols.some(s => s.gamme === 'Shorai Curve'), 'la Curve ne doit pas apparaître en monosplit dédié à la taille 05');
    });

    test('findRoomMultiSolutions expose la référence UI multi-seule de la Curve 05', () => {
        const sols = findRoomMultiSolutions(1.5, 2.0, 'toshiba');
        const curve = sols.find(s => s.gamme === 'Shorai Curve');
        assert.ok(curve, 'Shorai Curve absente de findRoomMultiSolutions');
        assert.equal(curve.reference_ensemble, 'RAS-M05P2KVSG-E');
    });
});

// Le référentiel climatique n'avait aucun test : c'est pourtant une table saisie à la main de
// 9 zones × 11 tranches d'altitude × 2 saisons, où une coquille se traduit directement par un
// dimensionnement faux sur tout un département. Ces tests ne valident pas les valeurs contre la
// norme (payante) — ils interdisent les incohérences internes détectables par le code.
describe('Référentiel climatique — cohérence interne', () => {
    const ALTITUDES = Object.keys(tBaseMatrix);
    const ZONES = [...new Set(Object.values(DEPARTMENTS).map(d => d.zone))].sort();

    test('chaque zone référencée par un département existe dans les deux matrices', () => {
        for (const z of ZONES) {
            for (const alt of ALTITUDES) {
                assert.ok(Number.isFinite(tBaseMatrix[alt][z]), `hiver manquant : zone ${z}, ${alt}`);
                assert.ok(Number.isFinite(tBaseEteMatrix[alt][z]), `été manquant : zone ${z}, ${alt}`);
            }
        }
    });

    test('les deux matrices couvrent les mêmes tranches d\'altitude', () => {
        assert.deepEqual(Object.keys(tBaseEteMatrix), ALTITUDES);
    });

    // Il ne fait jamais plus chaud en montant. Une inversion serait une coquille pure.
    // Les paliers plats sont tolérés ici : les zones A (Bretagne), B (Landes / Gironde) et
    // D (Nord / Île-de-France) en comportent au-delà de 1400 m, altitude qu'aucun de leurs
    // départements n'atteint — le plateau y est sans effet. Il n'en allait pas de même pour la
    // zone F, qui contient la Savoie et la Haute-Savoie (cas vérifié séparément plus bas).
    test('la température ne remonte jamais avec l\'altitude', () => {
        for (const z of ZONES) {
            for (let i = 1; i < ALTITUDES.length; i++) {
                const [prec, cur] = [ALTITUDES[i - 1], ALTITUDES[i]];
                assert.ok(
                    tBaseMatrix[cur][z] <= tBaseMatrix[prec][z],
                    `zone ${z} : hiver plus doux en altitude entre ${prec} et ${cur}`
                );
                assert.ok(
                    tBaseEteMatrix[cur][z] <= tBaseEteMatrix[prec][z],
                    `zone ${z} : été plus chaud en altitude entre ${prec} et ${cur}`
                );
            }
        }
    });

    // La régression corrigée : la zone F stagnait à -13°C de 800 m à 2200 m alors qu'elle
    // contient la Savoie, la Haute-Savoie et le Jura. Un chalet à 1800 m était calculé 5 à 8 K
    // trop chaud. Le test porte sur les zones qui contiennent réellement de la montagne.
    test('les zones de montagne conservent un gradient jusqu\'en altitude', () => {
        const ZONES_MONTAGNE = [...new Set(
            ['73', '74', '38', '05', '04', '09', '65', '15', '88', '68']
                .filter(d => DEPARTMENTS[d])
                .map(d => DEPARTMENTS[d].zone)
        )];
        assert.ok(ZONES_MONTAGNE.length > 0, 'aucune zone de montagne identifiée');
        for (const z of ZONES_MONTAGNE) {
            for (let i = 1; i < ALTITUDES.length; i++) {
                const [prec, cur] = [ALTITUDES[i - 1], ALTITUDES[i]];
                assert.ok(
                    tBaseMatrix[cur][z] < tBaseMatrix[prec][z],
                    `zone ${z} : plateau hiver entre ${prec} et ${cur} (${tBaseMatrix[prec][z]}°C), alors que la zone contient de la montagne`
                );
            }
        }
    });

    test('l\'été est toujours plus chaud que l\'hiver, dans toutes les zones', () => {
        for (const z of ZONES) {
            for (const alt of ALTITUDES) {
                assert.ok(tBaseEteMatrix[alt][z] > tBaseMatrix[alt][z], `zone ${z} à ${alt}`);
            }
        }
    });

    test('chaque département déclare une zone connue', () => {
        for (const [code, info] of Object.entries(DEPARTMENTS)) {
            assert.ok(info.zone, `département ${code} sans zone`);
            assert.ok(ZONES.includes(info.zone), `département ${code} : zone ${info.zone} inconnue`);
        }
    });

    // Garde-fou de plausibilité : une base hiver plus froide que -30°C ou plus douce que +25°C
    // au niveau de la mer signale une erreur de saisie, pas un climat français.
    test('les bases au niveau de la mer restent dans des bornes plausibles', () => {
        for (const z of ZONES) {
            const h = tBaseMatrix['0 à 200m'][z];
            const e = tBaseEteMatrix['0 à 200m'][z];
            assert.ok(h >= -20 && h <= 25, `zone ${z} : base hiver ${h}°C hors bornes plausibles`);
            assert.ok(e >= 25 && e <= 40, `zone ${z} : base été ${e}°C hors bornes plausibles`);
        }
    });

    // Les trois écarts corrigés, verrouillés par des cas nommés.
    test('l\'est continental n\'est plus calculé comme la vallée du Rhône', () => {
        const zoneStrasbourg = DEPARTMENTS['67'].zone;
        assert.equal(tBaseMatrix['0 à 200m'][zoneStrasbourg], -15,
            'la base hiver publiée pour Strasbourg est -15°C');
        assert.ok(tBaseMatrix['0 à 200m'][zoneStrasbourg] < tBaseMatrix['0 à 200m'][DEPARTMENTS['69'].zone],
            'Strasbourg doit être plus froid que Lyon');
    });

    test('les DOM n\'ont pas de besoin de chauffage au niveau de la mer', () => {
        for (const dom of ['971', '972', '973', '974', '976']) {
            const t = tBaseMatrix['0 à 200m'][DEPARTMENTS[dom].zone];
            assert.ok(t > 15, `département ${dom} : base hiver ${t}°C, incompatible avec un climat tropical`);
        }
    });
});

// Répartition des unités intérieures entre groupes extérieurs (voir docs/repartition-intelligente.md).
// Ce que ces tests protègent : que l'exploration soit réellement EXHAUSTIVE (aucune disposition
// servable ne doit être perdue), et qu'elle ne franchisse jamais la frontière d'une zone —
// laquelle porte la géométrie constatée sur le terrain par l'installateur.
describe('Répartition des unités entre groupes extérieurs', () => {
    const P = (nom, froid, chaud) => ({ nom, req: { froid, chaud }, froidMatch: froid * 1.07, chaudMatch: chaud * 1.25 });
    // Le cas réel : un séjour de 50 m² et deux chambres de 12 m², zone B.
    const CAS_REEL = [P('Salon', 2.67, 3.96), P('Ch 1', 0.59, 0.59), P('Ch 2', 0.59, 0.59)];
    const explorer = (pieces) => explorerRepartitions(pieces, 'toshiba', COEF_FOISONNEMENT_FROID, COEF_FOISONNEMENT_CHAUD);

    describe('partitionner — l\'énumération doit être complète', () => {
        test('produit exactement les nombres de Bell', () => {
            // 1, 2, 5, 15, 52 : si l'énumération en perd une, c'est une disposition valable que
            // l'installateur ne verra jamais — le défaut le plus grave possible ici.
            const attendus = { 1: 1, 2: 2, 3: 5, 4: 15, 5: 52 };
            for (const [n, bell] of Object.entries(attendus)) {
                const items = Array.from({ length: Number(n) }, (_, i) => i);
                assert.equal(partitionner(items).length, bell, `${n} pièces doivent donner ${bell} partitions`);
            }
        });

        test('chaque partition couvre toutes les pièces, une seule fois', () => {
            const items = ['a', 'b', 'c', 'd'];
            for (const p of partitionner(items)) {
                const plat = p.flat();
                assert.equal(plat.length, items.length, 'aucune pièce perdue ni dupliquée');
                assert.deepEqual([...plat].sort(), [...items].sort());
                assert.ok(p.every(bloc => bloc.length > 0), 'aucun bloc vide');
            }
        });

        test('un ensemble vide donne une partition vide, pas une erreur', () => {
            assert.deepEqual(partitionner([]), [[]]);
        });
    });

    describe('evaluerBlocRepartition', () => {
        test('une pièce seule est servie par un monosplit, sans modulation à signaler', () => {
            const b = evaluerBlocRepartition([P('Ch', 0.59, 0.59)], 'toshiba', COEF_FOISONNEMENT_FROID, COEF_FOISONNEMENT_CHAUD);
            assert.equal(b.type, 'mono');
            assert.ok(b.reference.includes('/'), 'un monosplit porte une référence de couple UE/UI');
            assert.equal(b.modulationMin, null, 'une machine dédiée n\'a personne à moduler pour');
        });

        test('plusieurs pièces sont servies par un groupe, avec sa modulation minimale', () => {
            const b = evaluerBlocRepartition(CAS_REEL, 'toshiba', COEF_FOISONNEMENT_FROID, COEF_FOISONNEMENT_CHAUD);
            assert.equal(b.type, 'multi');
            assert.equal(b.reference, 'RAS-3M18G3AVG-E');
            // La plus petite pièce (0,59 kW) face aux 5,2 kW du groupe : c'est exactement le
            // défaut décrit par l'installateur — les chambres seules sur un groupe de séjour.
            assert.ok(Math.abs(b.modulationMin - 0.59 / 5.2) < 1e-9, `modulation attendue ${(0.59 / 5.2).toFixed(3)}, obtenue ${b.modulationMin}`);
        });

        test('un bloc que le catalogue ne peut pas servir est écarté, pas approximé', () => {
            // Deux pièces énormes : aucune UI multisplit ne les couvre.
            const trop = [P('A', 9, 10), P('B', 9, 10)];
            assert.equal(evaluerBlocRepartition(trop, 'toshiba', COEF_FOISONNEMENT_FROID, COEF_FOISONNEMENT_CHAUD), null);
            assert.equal(evaluerBlocRepartition([], 'toshiba', COEF_FOISONNEMENT_FROID, COEF_FOISONNEMENT_CHAUD), null);
        });
    });

    describe('explorerRepartitions', () => {
        test('le cas réel : les cinq dispositions sont trouvées, groupe unique en tête', () => {
            const d = explorer(CAS_REEL);
            assert.equal(d.length, 5, 'les 5 partitions de 3 pièces sont toutes servables ici');
            assert.equal(d[0].nbGroupes, 1);
            assert.equal(d[0].blocs[0].reference, 'RAS-3M18G3AVG-E');
            assert.equal(d[d.length - 1].nbGroupes, 3, 'trois monosplits ferment la marche');
        });

        test('classement : le moins d\'unités extérieures d\'abord, puis la meilleure charge', () => {
            const d = explorer(CAS_REEL);
            for (let i = 1; i < d.length; i++) {
                assert.ok(d[i - 1].nbGroupes <= d[i].nbGroupes, 'le nombre d\'unités ne doit jamais décroître');
                if (d[i - 1].nbGroupes === d[i].nbGroupes) {
                    assert.ok(d[i - 1].chargeMin >= d[i].chargeMin - 1e-9,
                        'à nombre d\'unités égal, la meilleure charge passe devant');
                }
            }
        });

        test('chaque disposition expose ses grandeurs séparément, sans score composite', () => {
            for (const d of explorer(CAS_REEL)) {
                assert.equal(typeof d.nbGroupes, 'number');
                assert.equal(typeof d.puissanceTotale, 'number');
                assert.equal(typeof d.chargeMin, 'number');
                assert.ok(d.modulationMin === null || typeof d.modulationMin === 'number');
                assert.equal(d.score, undefined, 'aucun score unique : il masquerait le compromis');
                // Toute pièce doit se retrouver dans exactement un bloc.
                const noms = d.blocs.flatMap(b => b.pieces.map(p => p.nom));
                assert.deepEqual(noms.sort(), CAS_REEL.map(p => p.nom).sort());
            }
        });

        test('le compromis est réel : le groupe unique gagne en charge, le découpage en modulation', () => {
            const d = explorer(CAS_REEL);
            const unique = d.find(x => x.nbGroupes === 1);
            const meilleureModulation = d.filter(x => x.modulationMin !== null)
                .reduce((m, x) => (x.modulationMin > m.modulationMin ? x : m));
            assert.ok(unique.chargeMin > meilleureModulation.chargeMin,
                'le groupe unique doit dominer sur le taux de charge');
            assert.ok(meilleureModulation.modulationMin > unique.modulationMin,
                'et une disposition découpée doit dominer sur la modulation');
            assert.ok(meilleureModulation.nbGroupes > unique.nbGroupes,
                'ce gain se paie en unités extérieures — c\'est l\'arbitrage à montrer');
        });

        test('une pièce hors catalogue multisplit n\'apparaît que seule, jamais dans un groupe', () => {
            const pieces = [P('Enorme', 7.5, 9.0), P('Ch 1', 0.59, 0.59)];
            const d = explorer(pieces);
            for (const disposition of d) {
                for (const bloc of disposition.blocs) {
                    if (bloc.pieces.some(p => p.nom === 'Enorme')) {
                        assert.equal(bloc.pieces.length, 1, 'une pièce hors catalogue doit être isolée');
                        assert.equal(bloc.type, 'mono');
                    }
                }
            }
        });

        test('moins de deux pièces : rien à répartir', () => {
            assert.deepEqual(explorer([P('Seule', 1, 1)]), []);
            assert.deepEqual(explorer([]), []);
            assert.deepEqual(explorer(null), []);
        });

        test('cinq pièces (le plafond d\'une zone) restent exhaustivement explorables', () => {
            const cinq = [P('S', 2.0, 2.5), P('A', 0.6, 0.6), P('B', 0.6, 0.6), P('C', 0.7, 0.7), P('D', 0.7, 0.7)];
            const t0 = process.hrtime.bigint();
            const d = explorer(cinq);
            const ms = Number(process.hrtime.bigint() - t0) / 1e6;
            assert.ok(d.length > 0, 'au moins une disposition servable');
            assert.ok(d.length <= 52, 'jamais plus que le nombre de partitions de 5 éléments');
            assert.ok(ms < 100, `exploration en ${ms.toFixed(1)} ms — doit rester imperceptible`);
        });
    });

    describe('gammesPreferees — la gamme déjà choisie ne se refait pas', () => {
        // Un séjour de 50 m² en zone B, G 1,10 : req 2,672 kW F / 3,960 kW C, corrigé (marge
        // canicule × déclassement chaud) à 2,867 kW F / 4,968 kW C — taille UI 16. Valeurs
        // recalculées via getRequiredKw/getFacteurCanicule/getFacteurDeclassementChaud plutôt
        // qu'approchées, pour ne pas glisser d'une taille de catalogue à une autre. Quatre
        // gammes conviennent à cette taille (Yukai, Haori, Shorai Curve, Naka), et le tri TVA
        // par défaut retient Yukai en premier — ce qui imposait silencieusement cette gamme
        // avant l'ajout de ce paramètre.
        const SEJOUR = {
            nom: 'Salon', index: 1,
            req: { froid: 2.6715800000000005, chaud: 3.9599999999999995 },
            froidMatch: 2.8674958666666677, chaudMatch: 4.967741935483871
        };

        test('la gamme choisie en amont est reprise sur le monosplit', () => {
            const b = evaluerBlocRepartition([SEJOUR], 'toshiba', COEF_FOISONNEMENT_FROID, COEF_FOISONNEMENT_CHAUD, { 1: 'Haori' });
            assert.equal(b.gamme, 'Haori');
        });

        test('sans préférence, le repli reste le premier du tri TVA (comportement inchangé)', () => {
            const b = evaluerBlocRepartition([SEJOUR], 'toshiba', COEF_FOISONNEMENT_FROID, COEF_FOISONNEMENT_CHAUD);
            assert.equal(b.gamme, 'Yukai');
        });

        // Le cas nommé par l'installateur : Shorai Curve n'existe en CATALOGS.monosplits qu'à
        // partir de la taille 07 (2/2,5 kW) — la taille 05 (1,5/2 kW) n'existe que via
        // UI_MULTI_SEUL, donc uniquement comme unité de groupe, jamais en monosplit dédié. Une
        // petite chambre dont le besoin résout à cette taille doit ignorer silencieusement la
        // préférence, pas faire planter ni renvoyer une machine inexistante.
        test('une préférence sans déclinaison monosplit à cette taille (Shorai Curve, taille 05) retombe sur le repli', () => {
            const petiteChambre = { nom: 'Ch', index: 3, req: { froid: 0.9, chaud: 0.9 }, froidMatch: 1.0, chaudMatch: 1.1 };
            assert.equal(getUiSizeForKw(petiteChambre.froidMatch, petiteChambre.chaudMatch, 'toshiba'), '05',
                'préalable : ce besoin doit bien résoudre à la taille 05');
            const b = evaluerBlocRepartition([petiteChambre], 'toshiba', COEF_FOISONNEMENT_FROID, COEF_FOISONNEMENT_CHAUD, { 3: 'Shorai Curve' });
            assert.notEqual(b.gamme, 'Shorai Curve');
        });

        test('une pièce sans préférence connue (index absent de la map) n\'est pas affectée', () => {
            const b = evaluerBlocRepartition([SEJOUR], 'toshiba', COEF_FOISONNEMENT_FROID, COEF_FOISONNEMENT_CHAUD, { 99: 'Haori' });
            assert.equal(b.gamme, 'Yukai');
        });

        test('explorerRepartitions propage la préférence à chaque bloc monosplit qu\'elle produit', () => {
            const chambre = { nom: 'Ch', index: 2, req: { froid: 0.6, chaud: 0.6 }, froidMatch: 0.6 * 1.07, chaudMatch: 0.6 * 1.25 };
            const d = explorerRepartitions([SEJOUR, chambre], 'toshiba', COEF_FOISONNEMENT_FROID, COEF_FOISONNEMENT_CHAUD, { 1: 'Haori' });
            const blocsSejourSeul = d.flatMap(x => x.blocs).filter(b => b.type === 'mono' && b.pieces.some(p => p.nom === 'Salon'));
            assert.ok(blocsSejourSeul.length > 0, 'au moins une disposition sert le séjour en monosplit dédié');
            assert.ok(blocsSejourSeul.every(b => b.gamme === 'Haori'),
                'la préférence doit s\'appliquer partout où le séjour apparaît seul, quelle que soit la partition');
        });
    });
});

// meilleureAlternative : ce qui décide qu'une autre répartition mérite d'être proposée.
// Le risque principal ici n'est pas de manquer une alternative, c'est d'en proposer une qui
// n'apporte rien — la saisie de l'installateur est le plus souvent déjà première au classement.
describe('meilleureAlternative — ne proposer que ce qui corrige un défaut', () => {
    const P = (nom, froid, chaud) => ({ nom, req: { froid, chaud }, froidMatch: froid * 1.07, chaudMatch: chaud * 1.25 });
    const explorer = (pieces) => explorerRepartitions(pieces, 'toshiba', COEF_FOISONNEMENT_FROID, COEF_FOISONNEMENT_CHAUD);

    test('le cas terrain : un séjour dominant fait proposer de le séparer', () => {
        // Séjour 50 m² + deux chambres de 12 m² : sur un groupe unique, les chambres seules ne
        // sollicitent plus que ~11 % du compresseur. C'est le défaut décrit sur chantier.
        const d = explorer([P('Salon', 2.67, 3.96), P('Ch 1', 0.59, 0.59), P('Ch 2', 0.59, 0.59)]);
        const alt = meilleureAlternative(d[0], d);
        assert.ok(alt, 'une alternative doit être proposée');
        assert.ok(d[0].modulationMin < SEUIL_MODULATION_BASSE, 'la saisie a bien un problème de modulation');
        assert.ok(alt.modulationMin === null || alt.modulationMin > d[0].modulationMin,
            'l\'alternative doit améliorer la modulation');
    });

    test('une installation saine ne déclenche AUCUNE proposition', () => {
        // Deux pièces équivalentes sur un groupe bien chargé : rien à corriger. Proposer d'ajouter
        // une unité extérieure ici serait du bruit, et un mauvais conseil.
        const d = explorer([P('A', 1.049, 1.584), P('B', 1.049, 1.584)]);
        assert.ok(d[0].chargeMin >= SEUIL_SOUS_CHARGE, 'préalable : la saisie n\'est pas sous-chargée');
        assert.ok(d[0].modulationMin >= SEUIL_MODULATION_BASSE, 'préalable : la modulation est correcte');
        assert.equal(meilleureAlternative(d[0], d), null);
    });

    test('un gain de taux de charge ne compte que si la saisie est réellement sous-chargée', () => {
        // Deux pièces de 20 m² (zone B, G 1,10) : le groupe est à 64 % de charge, et deux
        // monosplits monteraient à 70 %. Sans ce garde-fou, on proposait donc une unité
        // extérieure de plus pour gagner six points sur une installation qui n'a rien à
        // corriger — un mauvais échange, et du bruit à l'écran.
        const d = explorer([P('A', 1.049, 1.584), P('B', 1.049, 1.584)]);
        assert.ok(d[0].chargeMin >= SEUIL_SOUS_CHARGE, 'préalable : la saisie n\'est pas sous-chargée');
        assert.ok(d.slice(1).some(x => x.chargeMin > d[0].chargeMin),
            'préalable : une alternative a bien un meilleur taux de charge');
        assert.equal(meilleureAlternative(d[0], d), null, 'et elle ne doit pourtant pas être proposée');
    });

    test('l\'alternative retenue est la moins coûteuse en unités extérieures', () => {
        const d = explorer([P('Salon', 2.67, 3.96), P('Ch 1', 0.59, 0.59), P('Ch 2', 0.59, 0.59)]);
        const alt = meilleureAlternative(d[0], d);
        const gagnantes = d.filter(x => x !== d[0] && (x.modulationMin === null || x.modulationMin > d[0].modulationMin + 0.005));
        const minUnites = Math.min(...gagnantes.map(x => x.nbGroupes));
        assert.equal(alt.nbGroupes, minUnites,
            'à gain équivalent, on ne fait pas payer une unité extérieure de plus');
    });

    test('toutes les pièces se retrouvent dans l\'alternative proposée', () => {
        const pieces = [P('Salon', 2.67, 3.96), P('Ch 1', 0.59, 0.59), P('Ch 2', 0.59, 0.59)];
        const d = explorer(pieces);
        const alt = meilleureAlternative(d[0], d);
        const noms = alt.blocs.flatMap(b => b.pieces.map(p => p.nom)).sort();
        assert.deepEqual(noms, pieces.map(p => p.nom).sort());
    });

    test('entrées dégradées : ni disposition ni liste ne fait planter', () => {
        assert.equal(meilleureAlternative(null, []), null);
        assert.equal(meilleureAlternative({ nbGroupes: 1, chargeMin: 0.6, modulationMin: 0.3, blocs: [] }, null), null);
    });
});
