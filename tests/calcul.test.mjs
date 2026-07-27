// Tests de non-régression sur le cœur de calcul de ProSizer B2B.
// Exécution : node --test (aucune dépendance, runner natif de Node ≥ 18).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    getRequiredKw, getFacteurCanicule, getFacteurDeclassementChaud, ratioDeclassementChaud,
    estimerEcartConsigne, resolveCoefG, getUiSizeForKw, findBestMonos, findMultiGroupOptions,
    findMultiGroup, getRoomEligibleGammes, getTvaInfo, occupantsParDefaut
} from '../js/calcul.js';
import { CONSIGNE_REFERENCE, COEF_FOISONNEMENT_FROID, COEF_FOISONNEMENT_CHAUD } from '../js/data.js';

const ROOM_TYPE = { emplacement: 'plain_pied', orientation: 'mixte', vitrage: 'moyen', protection: 'stores_int', occupants: '', expositionMurs: 4 };

describe('getRequiredKw — cas de référence par zone climatique', () => {
    test('Lyon (zone F, Tbase hiver -9°C, Tbase été 33°C), salon 30 m², G=0.8', () => {
        const ctx = { coefG: 0.8, tBaseHiver: -9, tBaseEte: 33, consigne: 26 };
        const req = getRequiredKw(30, 2.5, ROOM_TYPE, ctx);
        assert.ok(Math.abs(req.froid - 1.8137) < 0.001, `froid attendu ~1.8137, obtenu ${req.froid}`);
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

    test('exposition murs : 1 mur extérieur réduit le besoin chaud à 1/4 (ratio linéaire)', () => {
        const ctx = { coefG: 0.8, tBaseHiver: -9, tBaseEte: 33, consigne: 26 };
        const req4 = getRequiredKw(30, 2.5, { ...ROOM_TYPE, expositionMurs: 4 }, ctx);
        const req1 = getRequiredKw(30, 2.5, { ...ROOM_TYPE, expositionMurs: 1 }, ctx);
        assert.ok(Math.abs(req1.chaud - req4.chaud / 4) < 0.001, `chaud à 1 mur doit valoir 1/4 du besoin à 4 murs (${req4.chaud} / 4 = ${req4.chaud / 4}, obtenu ${req1.chaud})`);
    });

    test('consigne plus basse augmente le besoin froid (enveloppe uniquement, pas les autres postes)', () => {
        const ctx25 = { coefG: 0.8, tBaseHiver: -9, tBaseEte: 33, consigne: 25 };
        const ctx28 = { coefG: 0.8, tBaseHiver: -9, tBaseEte: 33, consigne: 28 };
        const req25 = getRequiredKw(30, 2.5, ROOM_TYPE, ctx25);
        const req28 = getRequiredKw(30, 2.5, ROOM_TYPE, ctx28);
        assert.ok(req25.froid > req28.froid, 'consigne 25°C doit demander plus de froid que 28°C');
    });
});

describe('Facteur canicule (froid)', () => {
    test('zone non chaude : facteur neutre', () => {
        assert.equal(getFacteurCanicule('F'), 1.0);
    });
    test('zone chaude (H) : majoration', () => {
        assert.equal(getFacteurCanicule('H'), 1.11);
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

describe('TVA 5,5% (Toshiba)', () => {
    test('Naka en mono : non éligible', () => {
        const info = getTvaInfo('Naka', 'RAS-10B2AVG-E / RAS-B10B2KVG-E', 'mono', 'toshiba');
        assert.equal(info.eligible, false);
    });
    test('Shorai Edge en mono : éligible sans wifi requis', () => {
        const info = getTvaInfo('Shorai Edge', 'RAS-10J2AVSG-E1 / RAS-B10G3KVSG-E', 'mono', 'toshiba');
        assert.equal(info.eligible, true);
        assert.equal(info.wifiRequired, false);
    });
    test('Panasonic : aucune règle TVA connue (retourne null)', () => {
        const info = getTvaInfo('Etherea', 'CU-Z35CKE / CS-Z35CKEW', 'mono', 'panasonic');
        assert.equal(info, null);
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
});
