// Tests du modèle de document et des deux gabarits d'impression (js/fiche.js).
//
// Ce que ces tests protègent en priorité : qu'un document produit par Klimo ne puisse jamais
// se contredire lui-même (une somme de postes différente du total qui a choisi la machine),
// ni présenter comme enregistré un bilan qui a été reconstitué à la lecture.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    construireFiche, ficheDeSecours, ficheDepuisBody, assainirFiche,
    lignesTableauFiche, gabaritTravail, gabaritClient, lignesPartage, libelleTva,
    partsEntieres, nb
} from '../js/fiche.js';
import { getRequiredKw, getUiSizeForKw, getFacteurCanicule, getFacteurDeclassementChaud } from '../js/calcul.js';

const CTX = { coefG: 0.8, tBaseHiver: -9, tBaseEte: 33, consigne: 26 };

const ROOM = {
    nom: 'Salon', surface: '30', height: '2.5', emplacement: 'plain_pied',
    orientation: 'sud', vitrage: 'moyen', protection: 'stores_int',
    occupants: '2', expositionMurs: '4', isolationCoef: '', customCoefG: ''
};

const HYPOTHESES = {
    dept: '69', deptNom: 'Rhône', altitude: '0 à 200m', zone: 'F',
    tBaseHiver: -9, tBaseEte: 33, consigne: 26,
    isolationLabel: 'G 0.8 — 2001 à 2012 (RT 2005)', coefG: 0.8,
    facteurCanicule: 1.06, facteurDeclassementChaud: 1.18,
    corrections: [{ libelle: 'Marge canicule', valeur: '+6 %', detail: 'Zone sujette à des pointes de 40-42 °C.' }]
};

// Construit une fiche complète comme le ferait le parcours vivant (calculate + renderResults).
function ficheDeTest({ nom = 'Salon', materiel = null } = {}) {
    const req = getRequiredKw(30, 2.5, { ...ROOM, nom }, CTX);
    const froidMatch = req.froid * 1.06;
    const chaudMatch = req.chaud * 1.18;
    const fiche = construireFiche({
        hypotheses: HYPOTHESES,
        pieces: [{
            room: { ...ROOM, nom },
            rd: { index: 1, nom, req, froidMatch, chaudMatch, size: getUiSizeForKw(froidMatch, chaudMatch, 'toshiba') },
            coefG: 0.8, coefGSurcharge: null, role: 'mono'
        }]
    });
    fiche.materiel = materiel;
    fiche.identite = {
        client: 'M. Martin', zone: 'Maison', dateStr: '17/08/2026',
        installateur: 'Dupont Climatisation', brandLabel: 'Toshiba', modeLabel: 'Monosplit'
    };
    fiche.moteur = 'V18';
    return fiche;
}

const MATERIEL_MONO = {
    type: 'mono', groupe: null, unites: [],
    monos: [{ piece: 1, nom: 'Salon', gamme: 'Shorai Curve', reference: 'RAS-13P2AVSG-E',
              froidKw: 3.5, chaudKw: 4.2, tva: { statut: 'eligible', wifiRequired: true } }],
    alertes: []
};

describe('construireFiche — socle du document', () => {
    test('reprend les entrées de la pièce et cumule le bilan', () => {
        const f = ficheDeTest();
        assert.equal(f.pieces.length, 1);
        assert.equal(f.pieces[0].surface, 30);
        assert.equal(f.pieces[0].volume, 75);
        assert.equal(f.pieces[0].nom, 'Salon');
        assert.equal(f.pieces[0].occupants, 2);
        assert.ok(Math.abs(f.bilan.froid - f.pieces[0].req.froid) < 1e-12);
        assert.equal(f.origine, 'calcul');
    });

    test('le détail des postes est repris tel quel depuis le moteur', () => {
        const f = ficheDeTest();
        const attendu = getRequiredKw(30, 2.5, ROOM, CTX).detail.froidPostes;
        assert.deepEqual(f.pieces[0].postes, { ...attendu });
    });
});

describe('gabarits — le document ne se contredit pas', () => {
    // Le test central du module : ce qui est IMPRIMÉ doit additionner exactement le besoin qui
    // a servi à choisir la machine. Un document qui affiche cinq postes dont la somme ne fait
    // pas son propre total ne justifie plus rien.
    test('la somme des postes imprimés vaut le besoin froid imprimé', () => {
        const f = ficheDeTest({ materiel: MATERIEL_MONO });
        const html = gabaritTravail(f);
        const p = f.pieces[0];
        const sommeW = Object.values(p.postes).reduce((a, b) => a + b, 0);
        assert.ok(Math.abs(sommeW / 1000 - p.req.froid) < 1e-9);
        // Le total imprimé dans le tableau des postes, en W, arrondi comme à l'écran.
        assert.ok(html.includes(sommeW.toFixed(0).replace('.', ',')),
            'le total en W du tableau des postes doit apparaître dans le document');
    });

    test('les cinq postes sont nommés dans les deux gabarits', () => {
        const f = ficheDeTest({ materiel: MATERIEL_MONO });
        for (const html of [gabaritTravail(f), gabaritClient(f)]) {
            for (const nomPoste of ['Enveloppe', 'Toiture', 'Apports solaires', 'Apports internes', 'Occupants']) {
                assert.ok(html.includes(nomPoste), `poste « ${nomPoste} » absent du document`);
            }
        }
    });

    test('la fiche de travail porte les réserves de méthode, pas le rapport client', () => {
        const f = ficheDeTest({ materiel: MATERIEL_MONO });
        assert.ok(gabaritTravail(f).includes('Réserves de méthode'));
        assert.ok(!gabaritClient(f).includes('Réserves de méthode'));
    });

    test('le rapport client explique les postes, la fiche de travail se contente de les nommer', () => {
        const f = ficheDeTest({ materiel: MATERIEL_MONO });
        const explication = 'Ce que le soleil fait entrer par les vitrages';
        assert.ok(gabaritClient(f).includes(explication));
        assert.ok(!gabaritTravail(f).includes(explication));
    });

    test('le vocabulaire de métier reste sur la fiche de travail, la valeur est la même partout', () => {
        const f = ficheDeTest({ materiel: MATERIEL_MONO });
        const chaud = `${nb(f.pieces[0].req.chaud, 2)} kW`.replace('.', ',');
        assert.ok(gabaritTravail(f).includes('de relance'), 'le chemin de calcul reste pour l\'installateur');
        assert.ok(!gabaritClient(f).includes('de relance'), 'pas de jargon sur le document remis au client');
        assert.ok(gabaritTravail(f).includes(chaud) && gabaritClient(f).includes(chaud),
            'la puissance chauffage imprimée est identique dans les deux documents');
    });

    // Le document est celui de l'installateur : c'est son nom qui l'émet, pas celui de l'outil.
    test('l\'émetteur est l\'installateur, Klimo ne se nomme qu\'en pied', () => {
        const f = ficheDeTest({ materiel: MATERIEL_MONO });
        for (const html of [gabaritTravail(f), gabaritClient(f)]) {
            const entete = html.split('</header>')[0];
            assert.ok(entete.includes('Dupont Climatisation'), 'l\'installateur signe le document');
            assert.ok(!entete.includes('Klimo'), 'Klimo n\'est pas l\'émetteur');
            assert.ok(html.includes('Klimo'), 'Klimo reste crédité en pied de page');
        }
    });

    test('sans identité installateur saisie, le document garde un émetteur', () => {
        const f = ficheDeTest({ materiel: MATERIEL_MONO });
        f.identite = { ...f.identite, installateur: '' };
        const entete = gabaritClient(f).split('</header>')[0];
        assert.ok(entete.includes('Klimo'), 'repli sur Klimo plutôt qu\'un document non signé');
    });

    test('les noms libres sont échappés (une apostrophe ne casse pas le balisage)', () => {
        const f = ficheDeTest({ nom: `L'Étage <b>x</b>`, materiel: MATERIEL_MONO });
        f.identite.client = `Société "Durand" & fils`;
        for (const html of [gabaritTravail(f), gabaritClient(f)]) {
            assert.ok(!html.includes('<b>x</b>'), 'le HTML saisi par l\'utilisateur ne doit pas être interprété');
            assert.ok(html.includes('&#39;Étage'));
            assert.ok(html.includes('&amp; fils'));
        }
    });

    test('la référence commandable et la TVA figurent sur la fiche de travail', () => {
        const html = gabaritTravail(ficheDeTest({ materiel: MATERIEL_MONO }));
        assert.ok(html.includes('RAS-13P2AVSG-E'));
        assert.ok(html.includes('TVA 5,5 %'));
        assert.ok(html.includes('module Wifi requis'));
    });

    test('une marque inconnue ne fait pas échouer la génération', () => {
        const f = ficheDeTest({ materiel: MATERIEL_MONO });
        f.identite.brandLabel = 'MarqueInexistante';
        assert.doesNotThrow(() => gabaritTravail(f));
        assert.doesNotThrow(() => gabaritClient(f));
    });

    test('une fiche nulle rend une chaîne vide plutôt que de lever', () => {
        assert.equal(gabaritTravail(null), '');
        assert.equal(gabaritClient(null), '');
    });

    // Un document ne doit jamais AFFIRMER ce qui n'a pas été enregistré. « 0,00 kW » se lit
    // comme un besoin nul mesuré, là où la vérité est qu'aucun bilan n'existe pour cette fiche.
    test('une fiche sans bilan n\'imprime pas « 0,00 kW », elle n\'imprime pas de bilan', () => {
        const degradee = {
            origine: 'calcul', moteur: null,
            hypotheses: { corrections: [] },
            bilan: { froid: null, chaud: null },
            pieces: [], materiel: null,
            equipementsEnregistres: ['Pièce 1 : 2,2 kW F / 2,1 kW C → Taille 13'],
            identite: { client: 'M. Martin', zone: 'Maison', dateStr: '02/01/2024', modeLabel: 'Monosplit' }
        };
        const html = gabaritTravail(degradee);
        assert.ok(!html.includes('0,00 kW'), 'aucun bilan inventé');
        assert.ok(!html.includes('Besoin froid cumulé'));
        assert.ok(html.includes('Taille 13'), 'ce qui est enregistré doit tout de même s\'imprimer');
    });

    test('une hypothèse absente n\'est pas rendue en tirets', () => {
        const f = ficheDeTest({ materiel: MATERIEL_MONO });
        f.hypotheses = { ...f.hypotheses, tBaseHiver: null, tBaseEte: null, consigne: null };
        const html = gabaritTravail(f);
        assert.ok(!html.includes('Températures de base'), 'la paire entière disparaît');
        assert.ok(!html.includes('Consigne intérieure'));
        assert.ok(html.includes('Localisation'), 'les hypothèses présentes restent affichées');
    });

    // Régression : les barres « Besoin calculé » se calaient chacune sur SON PROPRE total,
    // donc une pièce à 2 kW et une pièce à 0,5 kW s'imprimaient avec des barres RIGOUREUSEMENT
    // IDENTIQUES (chacune à 100 % de sa propre piste). Le nombre affiché à côté restait juste,
    // mais l'image — ce que l'œil retient en premier sur un document destiné à convaincre —
    // mentait sur l'écart réel entre les pièces. Voir echelleRoomsFiche() dans js/fiche.js.
    test('les barres de pièces à besoins différents ont des largeurs différentes, proportionnelles', () => {
        const grande = { ...ROOM, nom: 'Salon', surface: '34', vitrage: 'beaucoup', occupants: '3' };
        const petite = { ...ROOM, nom: 'Bureau', surface: '11', vitrage: 'peu', occupants: '1' };
        const piece = (room, index) => {
            const req = getRequiredKw(Number(room.surface), 2.5, room, CTX);
            const froidMatch = req.froid * 1.06;
            return {
                room, coefG: 0.8, coefGSurcharge: null, role: 'groupe',
                rd: { index, nom: room.nom, req, froidMatch, chaudMatch: req.chaud, size: '05' }
            };
        };
        const f = construireFiche({ hypotheses: HYPOTHESES, pieces: [piece(grande, 1), piece(petite, 2)] });
        f.materiel = { type: 'multi', groupe: null, unites: [], monos: [], alertes: [] };
        f.identite = { client: 'X', zone: 'Y', dateStr: 'Z', modeLabel: 'Multisplit' };

        assert.ok(f.pieces[0].req.froid > f.pieces[1].req.froid * 1.5,
            'préalable du test : les deux pièces doivent avoir des besoins nettement différents');

        const html = gabaritTravail(f);
        const largeurs = [...html.matchAll(/pf-regle-lib">Besoin calculé<\/span>\s*<span class="pf-barre">((?:<span class="pf-seg[^>]*>)*)/g)]
            .map(m => [...m[1].matchAll(/width:([\d.]+)%/g)].reduce((s, w) => s + Number(w[1]), 0));
        assert.equal(largeurs.length, 2, 'une barre par pièce');
        assert.ok(largeurs[0] > largeurs[1] * 1.3,
            `la barre du Salon (${largeurs[0]}%) doit être nettement plus large que celle du Bureau (${largeurs[1]}%) — pas 100 % chacune`);
        assert.ok(largeurs[0] <= 100.01, 'aucune barre ne déborde de sa piste');
    });
});

describe('partsEntieres — la colonne « Part » doit tomber sur 100', () => {
    // Cas réel qui a motivé la fonction : les cinq postes de la pièce « Chambre 1 » du jeu
    // d'essai valent 13,52 / 43,27 / 11,72 / 7,73 / 23,77 %. Arrondis un à un, ils faisaient
    // 14 + 43 + 12 + 8 + 24 = 101 %, sous une ligne de total qui annonce « 100 % ».
    test('le cas qui produisait 101 % tombe désormais juste', () => {
        const parts = partsEntieres([113.75, 364, 98.561, 65, 200]);
        assert.equal(parts.reduce((a, b) => a + b, 0), 100);
        assert.deepEqual(parts, [13, 43, 12, 8, 24]);
    });

    test('somme exacte sur des répartitions arbitraires', () => {
        const jeux = [
            [1, 1, 1], [1, 1, 1, 1, 1, 1, 7], [0.1, 0.1, 0.1, 99.7],
            [386.75, 476, 728.851, 170, 300], [67.375, 308, 23.76, 55, 100],
            [1000, 0, 0, 0, 0], [33.33, 33.33, 33.34]
        ];
        for (const jeu of jeux) {
            const parts = partsEntieres(jeu);
            assert.equal(parts.reduce((a, b) => a + b, 0), 100, `somme pour ${jeu.join('/')}`);
            assert.equal(parts.length, jeu.length);
            assert.ok(parts.every(p => p >= 0), 'aucune part négative');
        }
    });

    test('un poste nul reste à 0 et ne reçoit jamais le point d\'ajustement', () => {
        const parts = partsEntieres([500, 0, 500]);
        assert.deepEqual(parts, [50, 0, 50]);
    });

    test('un total nul ne divise pas par zéro', () => {
        assert.deepEqual(partsEntieres([0, 0, 0]), [0, 0, 0]);
    });

    test('les parts imprimées somment à 100 sur chaque pièce du document', () => {
        const f = ficheDeTest({ materiel: MATERIEL_MONO });
        const html = gabaritTravail(f);
        for (const tableau of html.matchAll(/<table class="pf-table pf-technique">([\s\S]*?)<\/table>/g)) {
            const parts = [...tableau[1].matchAll(/<td class="pf-n">(\d+) %<\/td>/g)].map(m => Number(m[1]));
            const postes = parts.slice(0, 5);
            assert.equal(postes.reduce((a, b) => a + b, 0), 100,
                `parts imprimées ${postes.join(' + ')} doivent faire 100`);
        }
    });
});

describe('règle de couverture', () => {
    test('la barre machine dépasse la barre besoin quand la machine couvre', () => {
        const f = ficheDeTest({ materiel: MATERIEL_MONO });
        const html = gabaritClient(f);
        const largeurs = [...html.matchAll(/pf-machine" style="width:([\d.]+)%/g)].map(m => Number(m[1]));
        assert.ok(largeurs.length > 0, 'la barre machine doit être dessinée');
        assert.equal(largeurs[0], 100, 'la machine, plus puissante que le besoin, fixe l\'échelle');
    });

    // Sur le bloc groupe il n'y a pas de décomposition en postes : le besoin est une somme de
    // pièces. Sans segment plein, la barre « besoin » resterait vide en face d'une valeur non
    // nulle — c'est-à-dire que l'objet qui porte l'argument du document ne montrerait rien.
    test('la barre « besoin » du groupe est pleine, jamais vide', () => {
        const f = ficheDeTest();
        f.materiel = {
            type: 'multi',
            groupe: { reference: 'RAS-3M26G3AVG-E', froidKw: 7.5, chaudKw: 9.0, sorties: 3,
                      besoin: { froid: 6.2, chaud: 7.1 }, foisonnement: { froid: 1.05, chaud: 1.25 },
                      tva: { statut: 'eligible', wifiRequired: false } },
            unites: [], monos: [], alertes: []
        };
        const couverture = gabaritClient(f).split('La machine couvre le besoin')[1];
        const segments = [...couverture.matchAll(/pf-seg pf-seg-\d" style="width:([\d.]+)%/g)].map(m => Number(m[1]));
        assert.equal(segments.length, 1, 'un seul segment plein pour un besoin cumulé');
        assert.ok(segments[0] > 0, 'la barre besoin ne doit pas être vide');
    });

    test('le groupe multisplit est confronté à sa capacité en simultané, foisonnement écrit', () => {
        const f = ficheDeTest();
        f.materiel = {
            type: 'multi',
            groupe: { reference: 'RAS-3M26G3AVG-E', froidKw: 7.5, chaudKw: 9.0, sorties: 3,
                      besoin: { froid: 6.2, chaud: 7.1 }, foisonnement: { froid: 1.05, chaud: 1.25 },
                      tva: { statut: 'eligible', wifiRequired: false } },
            unites: [{ piece: 1, nom: 'Salon', taille: '13', gamme: 'Shorai Curve', tva: { statut: 'eligible', wifiRequired: false } }],
            monos: [], alertes: []
        };
        const html = gabaritClient(f);
        assert.ok(html.includes('coefficient de foisonnement'),
            'le document doit dire pourquoi la capacité retenue dépasse la puissance nominale');
        assert.ok(html.includes('7,88 kW'), '7,5 × 1,05 = 7,875 kW disponibles en simultané');
    });

    // La corrélation entre le besoin d'UNE pièce et l'unité qui y est posée : une taille
    // catalogue (« 05 », « 07 ») ne dit rien à un client, une puissance se compare. Sans cette
    // barre, seul le monosplit dédié montrait cette comparaison — les pièces raccordées à un
    // groupe multisplit n'avaient RIEN pour la porter, alors qu'elles sont la majorité des cas.
    test('l\'unité intérieure d\'une pièce raccordée à un groupe porte aussi sa propre barre', () => {
        const f = ficheDeTest();
        f.materiel = {
            type: 'multi',
            groupe: { reference: 'RAS-3M26G3AVG-E', froidKw: 7.5, chaudKw: 9.0, sorties: 3,
                      besoin: { froid: 6.2, chaud: 7.1 }, foisonnement: { froid: 1.05, chaud: 1.25 },
                      tva: { statut: 'eligible', wifiRequired: false } },
            unites: [{ piece: 1, nom: 'Salon', taille: '13', gamme: 'Shorai Curve',
                       froidKw: 3.5, chaudKw: 4.2, tva: { statut: 'eligible', wifiRequired: false } }],
            monos: [], alertes: []
        };
        for (const html of [gabaritTravail(f), gabaritClient(f)]) {
            const blocPiece = html.split('1 · Salon')[1].split('Chauffage')[0];
            assert.ok(blocPiece.includes('Shorai Curve'), 'la barre porte le nom de la gamme posée');
            assert.ok(blocPiece.includes('3,50 kW'), 'et sa puissance froid propre — pas le besoin de la pièce');
            const largeurMachine = [...blocPiece.matchAll(/pf-machine" style="width:([\d.]+)%/g)];
            assert.equal(largeurMachine.length, 1, 'une seule barre machine pour cette pièce');
        }
    });

    test('sans puissance connue pour l\'unité (fiche ancienne), pas de barre machine plutôt qu\'une barre fausse', () => {
        const f = ficheDeTest();
        f.materiel = {
            type: 'multi', groupe: null,
            unites: [{ piece: 1, nom: 'Salon', taille: '13', gamme: 'Shorai Curve', froidKw: null, chaudKw: null, tva: null }],
            monos: [], alertes: []
        };
        const bloc = gabaritTravail(f).split('1 · Salon')[1].split('Chauffage')[0];
        assert.equal([...bloc.matchAll(/pf-machine" style=/g)].length, 0);
    });

    // Le tableau « Matériel retenu » est le bon de commande : la puissance de chaque unité doit
    // s'y lire à côté de sa taille, sans avoir à remonter au bloc de la pièce.
    test('le tableau matériel porte le froid et le chaud de chaque unité intérieure', () => {
        const f = ficheDeTest();
        f.materiel = {
            type: 'multi', groupe: null,
            unites: [{ piece: 1, nom: 'Salon', taille: '13', gamme: 'Shorai Curve',
                       froidKw: 3.5, chaudKw: 4.2, tva: { statut: 'eligible', wifiRequired: false } }],
            monos: [], alertes: []
        };
        for (const html of [gabaritTravail(f), gabaritClient(f)]) {
            const tableau = html.match(/<table class="pf-table">\s*<thead><tr><th>Pièce<\/th>[\s\S]*?<\/table>/)[0];
            assert.ok(tableau.includes('<th class="pf-n">Froid</th>'));
            assert.ok(tableau.includes('<th class="pf-n">Chaud</th>'));
            assert.ok(tableau.includes('3,50 kW'));
            assert.ok(tableau.includes('4,20 kW'));
        }
    });

    test('une unité sans puissance connue affiche un tiret, jamais 0,00 kW inventé', () => {
        const f = ficheDeTest();
        f.materiel = {
            type: 'multi', groupe: null,
            unites: [{ piece: 1, nom: 'Salon', taille: '13', gamme: 'Shorai Curve', froidKw: null, chaudKw: null, tva: null }],
            monos: [], alertes: []
        };
        const tableau = gabaritTravail(f).match(/<table class="pf-table">\s*<thead><tr><th>Pièce<\/th>[\s\S]*?<\/table>/)[0];
        assert.ok(!tableau.includes('0,00 kW'));
        assert.ok(tableau.includes('>—<'));
    });
});

describe('ficheDeSecours — repli sur les entrées enregistrées', () => {
    const BODY = {
        mode: 'mono', brand: 'toshiba', usage: 'reversible',
        params: { deptSelect: '69', altitude: '0 à 200m', isolationCoef: '0.8', customCoef: '', consigneInt: '26' },
        rooms: [ROOM],
        equipments: ['Modèle sélectionné : Shorai Curve (RAS-13P2AVSG-E)'],
        roomDetails: ['Pièce 1 : 2,2 kW F / 2,1 kW C → Taille 13']
    };

    // LE test du repli : il doit rejouer le moteur, pas en recopier les formules. Sans lui, une
    // évolution de getRequiredKw ferait diverger silencieusement les fiches anciennes des neuves.
    test('rend exactement les mêmes besoins que le chemin vivant pour les mêmes entrées', () => {
        const secours = ficheDeSecours(BODY);
        const attendu = getRequiredKw(30, 2.5, ROOM, CTX);
        assert.ok(Math.abs(secours.pieces[0].req.froid - attendu.froid) < 1e-12);
        assert.ok(Math.abs(secours.pieces[0].req.chaud - attendu.chaud) < 1e-12);
        assert.deepEqual(secours.pieces[0].postes, { ...attendu.detail.froidPostes });
    });

    test('est marquée « recalculee » et le document le dit en clair', () => {
        const { fiche, palier } = ficheDepuisBody({ ...BODY, clientName: 'M. Martin', zone: 'Maison' });
        assert.equal(palier, 2);
        assert.equal(fiche.origine, 'recalculee');
        assert.ok(gabaritClient(fiche).includes('Bilan reconstitué'));
        assert.ok(gabaritTravail(fiche).includes('Bilan reconstitué'));
    });

    test('ne reconstitue pas le matériel : les équipements enregistrés sont repris tels quels', () => {
        const { fiche } = ficheDepuisBody({ ...BODY, clientName: 'M. Martin', zone: 'Maison' });
        assert.equal(fiche.materiel, null);
        assert.ok(gabaritTravail(fiche).includes('Shorai Curve (RAS-13P2AVSG-E)'));
    });

    test('applique les facteurs de correction du climat enregistré', () => {
        const secours = ficheDeSecours(BODY);
        assert.equal(secours.hypotheses.facteurCanicule, getFacteurCanicule(33));
        assert.equal(secours.hypotheses.facteurDeclassementChaud, getFacteurDeclassementChaud(-9));
    });

    test('en froid seul, le besoin chaud ne pèse pas sur la sélection', () => {
        const secours = ficheDeSecours({ ...BODY, usage: 'froid_seul' });
        assert.equal(secours.pieces[0].match.chaud, 0);
        assert.ok(secours.pieces[0].req.chaud > 0, 'le besoin chaud reste calculé et affiché');
    });

    test('la surcharge d\'isolation par pièce n\'est lue qu\'en multisplit', () => {
        const piece = { ...ROOM, isolationCoef: '2.0' };
        const enMulti = ficheDeSecours({ ...BODY, mode: 'multi', rooms: [piece] });
        const enMono = ficheDeSecours({ ...BODY, mode: 'mono', rooms: [piece] });
        assert.equal(enMulti.pieces[0].coefG, 2.0);
        assert.equal(enMulti.pieces[0].coefGSurcharge, 2.0);
        assert.equal(enMono.pieces[0].coefG, 0.8);
        assert.equal(enMono.pieces[0].coefGSurcharge, null);
    });

    test('accepte une hauteur saisie à la française (virgule décimale)', () => {
        const secours = ficheDeSecours({ ...BODY, rooms: [{ ...ROOM, height: '2,7' }] });
        assert.equal(secours.pieces[0].hauteur, 2.7);
        assert.equal(secours.pieces[0].volume, 81);
    });

    test('renvoie null plutôt qu\'un bilan inventé quand les entrées manquent', () => {
        assert.equal(ficheDeSecours(null), null);
        assert.equal(ficheDeSecours({ ...BODY, params: null }), null);
        assert.equal(ficheDeSecours({ ...BODY, params: { ...BODY.params, deptSelect: 'ZZ' } }), null);
        assert.equal(ficheDeSecours({ ...BODY, params: { ...BODY.params, altitude: 'sur la Lune' } }), null);
        assert.equal(ficheDeSecours({ ...BODY, rooms: [] }), null);
        assert.equal(ficheDeSecours({ ...BODY, rooms: [{ ...ROOM, surface: '' }] }), null);
    });
});

describe('ficheDepuisBody — les trois paliers de lecture', () => {
    test('palier 1 : une fiche enregistrée est rendue telle quelle', () => {
        const enregistree = assainirFiche(ficheDeTest({ materiel: MATERIEL_MONO }));
        const { fiche, palier } = ficheDepuisBody({
            clientName: 'M. Martin', zone: 'Maison', brand: 'toshiba', mode: 'mono',
            date: '17/08/2026', fiche: enregistree
        });
        assert.equal(palier, 1);
        assert.equal(fiche.origine, 'calcul');
        assert.equal(fiche.identite.client, 'M. Martin');
        assert.equal(fiche.materiel.monos[0].reference, 'RAS-13P2AVSG-E');
    });

    test('palier 3 : rien d\'exploitable rend une fiche nulle, sans lever', () => {
        assert.deepEqual(ficheDepuisBody(null), { fiche: null, palier: 3 });
        assert.deepEqual(ficheDepuisBody({ clientName: 'X', zone: 'Y' }), { fiche: null, palier: 3 });
        assert.equal(ficheDepuisBody({ clientName: 'X', legacyIncomplete: true, params: {}, rooms: [] }).palier, 3);
    });

    test('une fiche marquée legacyIncomplete n\'est jamais recalculée', () => {
        const { palier } = ficheDepuisBody({
            clientName: 'X', zone: 'Y', mode: 'mono', brand: 'toshiba', legacyIncomplete: true,
            params: { deptSelect: '69', altitude: '0 à 200m', isolationCoef: '0.8', customCoef: '', consigneInt: '26' },
            rooms: [ROOM]
        });
        assert.equal(palier, 3);
    });
});

describe('assainirFiche — la fiche doit survivre à la persistance', () => {
    test('arrondit les flottants à la précision réellement imprimée', () => {
        const propre = assainirFiche(ficheDeTest({ materiel: MATERIEL_MONO }));
        const serialise = JSON.stringify(propre);
        assert.ok(!/\d\.\d{5,}/.test(serialise),
            `aucun flottant à rallonge ne doit être persisté : ${serialise.match(/\d\.\d{5,}/)}`);
    });

    test('traverse structuredClone et JSON sans perte', () => {
        const propre = assainirFiche(ficheDeTest({ materiel: MATERIEL_MONO }));
        assert.doesNotThrow(() => structuredClone(propre));
        assert.deepEqual(JSON.parse(JSON.stringify(propre)), propre);
    });

    test('les non-finis deviennent null plutôt que de disparaître à la sérialisation', () => {
        const f = ficheDeTest();
        f.pieces[0].req.froid = NaN;
        f.pieces[0].volume = Infinity;
        const propre = assainirFiche(f);
        assert.equal(propre.pieces[0].req.froid, null);
        assert.equal(propre.pieces[0].volume, null);
        assert.equal(JSON.parse(JSON.stringify(propre)).pieces[0].req.froid, null);
    });

    test('role est toujours une chaîne (un Set sérialiserait en {} sans lever)', () => {
        const f = ficheDeTest();
        f.pieces[0].role = undefined;
        assert.equal(assainirFiche(f).pieces[0].role, 'groupe');
    });

    test('la prose des corrections est conservée telle quelle', () => {
        const propre = assainirFiche(ficheDeTest());
        assert.equal(propre.hypotheses.corrections[0].detail, HYPOTHESES.corrections[0].detail);
    });

    test('une fiche nulle reste nulle', () => {
        assert.equal(assainirFiche(null), null);
    });

    test('la puissance de chaque unité intérieure survit à la persistance, arrondie', () => {
        const f = ficheDeTest();
        f.materiel = {
            type: 'multi', groupe: null,
            unites: [{ piece: 1, nom: 'Salon', taille: '13', gamme: 'Shorai Curve',
                       froidKw: 3.499999999, chaudKw: 4.2000001, tva: null }],
            monos: [], alertes: []
        };
        const propre = assainirFiche(f);
        assert.equal(propre.materiel.unites[0].froidKw, 3.5);
        assert.equal(propre.materiel.unites[0].chaudKw, 4.2);
        assert.deepEqual(JSON.parse(JSON.stringify(propre)).materiel.unites[0], propre.materiel.unites[0]);
    });
});

describe('lignesTableauFiche — modèle du tableau de bord', () => {
    test('une ligne par pièce, plus un total cohérent avec le bilan', () => {
        const f = ficheDeTest();
        const t = lignesTableauFiche(f);
        assert.equal(t.pieces.length, 1);
        assert.equal(t.pieces[0].libelle, '1 — Salon');
        assert.equal(t.pieces[0].surface, 30);
        assert.equal(t.total.surface, 30);
        assert.equal(t.total.froid, f.bilan.froid);
        assert.equal(t.recalculee, false);
    });

    test('une pièce sans nom garde un libellé identifiable', () => {
        const f = ficheDeTest({ nom: '' });
        assert.equal(lignesTableauFiche(f).pieces[0].libelle, 'Pièce 1');
    });

    test('une taille absente est signalée comme hors catalogue, pas comme case vide', () => {
        const f = ficheDeTest();
        f.pieces[0].taille = null;
        const t = lignesTableauFiche(f);
        assert.equal(t.pieces[0].horsCatalogue, true);
    });

    test('une fiche nulle ou vide rend null', () => {
        assert.equal(lignesTableauFiche(null), null);
        assert.equal(lignesTableauFiche({ pieces: [] }), null);
    });
});

describe('lignesPartage', () => {
    test('reprend le bilan par pièce et le matériel retenu', () => {
        const lignes = lignesPartage(ficheDeTest({ materiel: MATERIEL_MONO }));
        const texte = lignes.join('\n');
        assert.ok(texte.includes('M. Martin'));
        assert.ok(texte.includes('1 Salon · 30 m²'));
        assert.ok(texte.includes('RAS-13P2AVSG-E'));
        assert.ok(!texte.includes('<'), 'le partage est du texte brut, jamais du HTML');
    });

    test('une fiche nulle rend une liste vide', () => {
        assert.deepEqual(lignesPartage(null), []);
    });
});

describe('libelleTva', () => {
    test('ne tranche jamais à la place du tableau constructeur', () => {
        assert.equal(libelleTva(null), 'TVA non renseignée');
        assert.equal(libelleTva({ statut: 'a_verifier' }), 'TVA à vérifier');
        assert.equal(libelleTva({ statut: 'non_eligible' }), 'TVA 20 %');
        assert.equal(libelleTva({ statut: 'eligible', wifiRequired: true }), 'TVA 5,5 % · module Wifi requis');
    });
});
