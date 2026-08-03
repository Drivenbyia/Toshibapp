// Tests de non-régression sur le cœur de calcul de ProSizer B2B.
// Exécution : node --test (aucune dépendance, runner natif de Node ≥ 18).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    getRequiredKw, getFacteurCanicule, getFacteurDeclassementChaud, ratioDeclassementChaud,
    estimerEcartConsigne, resolveCoefG, getUiSizeForKw, findBestMonos, findMultiGroupOptions,
    findMultiGroup, getRoomEligibleGammes, getTvaInfo, occupantsParDefaut,
    findGroupesValides, findGroupeEquilibre, estGroupeDesequilibre, ratioPieceDominante,
    pieceDominante, tauxChargeGroupe, getGroupTvaInfo, normaliserReferenceGroupe, trierMonosParTva
} from '../js/calcul.js';
import {
    CONSIGNE_REFERENCE, COEF_FOISONNEMENT_FROID, COEF_FOISONNEMENT_CHAUD,
    SEUIL_DESEQUILIBRE_GROUPE, CATALOGS
} from '../js/data.js';

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

describe('Équilibre du groupe multisplit (demande simultanée)', () => {
    // Cas réel remonté par le terrain : 2 pièces en zone chaude (canicule +11%) avec déclassement
    // chaud +25%. Le plus petit groupe valide (2M14) laisse la pièce 2 absorber ~63% de la puissance
    // nominale : l'application doit proposer d'elle-même le cran au-dessus (2M18) plutôt que de se
    // contenter d'alerter et de renvoyer vers un monosplit dédié.
    const CAS_TERRAIN = [
        { index: 1, req: { froid: 0.86, chaud: 1.83 }, froidMatch: 0.86 * 1.11, chaudMatch: 1.83 * 1.25 },
        { index: 2, req: { froid: 1.70, chaud: 2.23 }, froidMatch: 1.70 * 1.11, chaudMatch: 2.23 * 1.25 }
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
        // Une petite pièce + une grosse pièce proche du haut du catalogue : même le plus gros groupe
        // laisse la grosse pièce au-dessus du seuil.
        const rooms = [{ froidMatch: 0.8, chaudMatch: 1.0 }, { froidMatch: 7.0, chaudMatch: 8.0 }];
        assert.equal(findGroupeEquilibre(rooms, 'toshiba', COEF_FOISONNEMENT_FROID, COEF_FOISONNEMENT_CHAUD, { froid: 7.8, chaud: 9.0 }), null);
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
    test('Shorai Edge : éligible sans wifi requis', () => {
        const info = getTvaInfo('Shorai Edge', 'RAS-10J2AVSG-E1 / RAS-B10G3KVSG-E', 'mono', 'toshiba');
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
    test('Shorai Edge : toute la gamme est éligible, taille 24 comprise (absente du tableau v3)', () => {
        const info = getTvaInfo('Shorai Edge', 'RAS-24J2AVSG-E1 / RAS-B24G3KVSG-E', 'mono', 'toshiba');
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
    const attendu = { 'Naka': 'non_eligible', 'Yukai': 'eligible', 'Shorai Edge': 'eligible', 'Haori': 'eligible', 'Daiseikai 10': 'eligible', 'Console Double-Flux': 'eligible' };
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
        assert.equal(normaliserReferenceGroupe('RAS-5M34G3AVG-E/ET'), 'RAS-5M34G3AVG');
        assert.equal(normaliserReferenceGroupe('RAS-5M34G3AVG-E1'), 'RAS-5M34G3AVG');
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
        for (const gamme of ['Naka', 'Yukai', 'Console Double-Flux', 'Shorai Edge', 'Haori', 'Daiseikai 10']) {
            const info = getTvaInfo(gamme, 'RAS-10B2AVG-E / RAS-B10B2KVG-E', 'multiUi', 'toshiba', GROUPE);
            assert.equal(info.statut, 'eligible', gamme);
            assert.equal(info.wifiRequired, false, gamme);
        }
    });

    test('groupe extérieur hors tableau : les UI raccordées passent en "à vérifier"', () => {
        assert.equal(getGroupTvaInfo('RAS-9M99XXXX-E', 'toshiba').statut, 'a_verifier');
        assert.equal(getTvaInfo('Shorai Edge', 'RAS-10J2AVSG-E1 / RAS-B10G3KVSG-E', 'multiUi', 'toshiba', 'RAS-9M99XXXX-E').statut, 'a_verifier');
    });

    test('référence de groupe absente (null) : "à vérifier" plutôt qu\'une promesse de 5,5%', () => {
        assert.equal(getTvaInfo('Shorai Edge', 'RAS-10J2AVSG-E1 / RAS-B10G3KVSG-E', 'multiUi', 'toshiba').statut, 'a_verifier');
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
