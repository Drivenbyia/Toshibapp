// Fiche de dimensionnement — modèle de document et gabarits d'impression.
//
// Module de fonctions PURES : aucun accès au DOM, à `window` ou à `localStorage`. Il ne doit
// JAMAIS importer js/app.js, qui touche `window` au chargement et cesserait d'être importable
// sous Node — donc intestable. C'est aussi ce qui rend possible l'impression d'une fiche
// ENREGISTRÉE : ce chemin-là ne peut lire aucun champ du formulaire, puisque le formulaire
// porte la saisie en cours, pas celle du chantier qu'on imprime.
//
// Ce que ce module produit, et pourquoi il existe :
// jusqu'ici l'export réimprimait `resultStr` / `equipments[]` / `roomDetails[]`, c'est-à-dire
// des phrases déjà écrites. Un tel document ne peut que RÉAFFIRMER la puissance retenue ; il
// ne peut pas la justifier, faute d'avoir sous la main le détail poste par poste du bilan
// (voir `detail` dans getRequiredKw, js/calcul.js). La fiche est donc un modèle structuré,
// dont les deux gabarits ne sont que deux projections.
import {
    getRequiredKw, getUiSizeForKw, resolveCoefG,
    getFacteurCanicule, getFacteurDeclassementChaud
} from './calcul.js';
import {
    DEPARTMENTS, tBaseMatrix, tBaseEteMatrix, CONSIGNE_REFERENCE,
    BRAND_LABELS, COEF_FOISONNEMENT_FROID, COEF_FOISONNEMENT_CHAUD
} from './data.js';

// --- Petits utilitaires -----------------------------------------------------------------
// Recopiés depuis app.js plutôt qu'importés : quatre lignes chacun contre une dépendance à un
// module qui touche le DOM. Le doublon est ici moins coûteux que le couplage.

export function nb(valeur, decimales = 1) {
    const n = Number(valeur);
    if (!Number.isFinite(n)) return '—';
    return n.toFixed(decimales).replace('.', ',');
}

export function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, ch =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function arrondi(valeur, decimales) {
    const n = Number(valeur);
    if (!Number.isFinite(n)) return null;
    const f = 10 ** decimales;
    return Math.round(n * f) / f;
}

function pourcent(part, tout) {
    if (!Number.isFinite(part) || !Number.isFinite(tout) || tout <= 0) return 0;
    return (part / tout) * 100;
}

// Répartit 100 points entiers entre des valeurs, au plus fort reste (méthode de Hare).
//
// Arrondir chaque part indépendamment produit une colonne qui ne fait pas 100 : sur la pièce
// « Chambre 1 » du jeu d'essai, 13,52 + 43,27 + 11,72 + 7,73 + 23,77 devient 14 + 43 + 12 + 8
// + 24 = 101 %, sous une ligne de total qui affiche « 100 % ». Sur un document dont la raison
// d'être est de JUSTIFIER une puissance, une colonne qui ne tombe pas juste discrédite tout le
// reste du calcul — y compris ce qui est exact. Le plus fort reste garantit la somme exacte en
// ne déplaçant qu'un point, vers les parts dont la décimale était la plus proche du rang
// supérieur : l'ordre de grandeur de chaque poste est préservé.
export function partsEntieres(valeurs, total = 100) {
    const somme = valeurs.reduce((s, v) => s + (Number(v) || 0), 0);
    if (somme <= 0) return valeurs.map(() => 0);
    const exactes = valeurs.map(v => ((Number(v) || 0) / somme) * total);
    const planchers = exactes.map(Math.floor);
    let reste = total - planchers.reduce((s, v) => s + v, 0);
    // Indices triés par reste décroissant ; à reste égal, la part la plus grande passe devant,
    // pour que le point supplémentaire ne parte jamais au poste le plus marginal.
    const ordre = exactes
        .map((e, i) => ({ i, reste: e - Math.floor(e), valeur: e }))
        .sort((a, b) => (b.reste - a.reste) || (b.valeur - a.valeur));
    const sortie = [...planchers];
    for (let k = 0; k < ordre.length && reste > 0; k++, reste--) sortie[ordre[k].i]++;
    return sortie;
}

// --- Libellés ---------------------------------------------------------------------------
// Seuls les CODES sont persistés dans la fiche ; les libellés français sont dérivés ici, au
// rendu. Stocker « Sous toiture / combles aménagés » dans chaque pièce de chaque chantier
// enregistrerait une décision d'affichage dans une donnée, et la figerait.

const LIB_EMPLACEMENT = {
    sous_toiture: 'Sous toiture',
    plain_pied: 'Plain-pied, combles isolés',
    etage_protege: 'Étage protégé'
};
const LIB_ORIENTATION = {
    nord: 'Nord', est: 'Est', sud: 'Sud', ouest: 'Ouest', mixte: 'Mixte'
};
const LIB_VITRAGE = { peu: 'Peu vitré', moyen: 'Vitrage moyen', beaucoup: 'Très vitré' };
const LIB_PROTECTION = {
    aucune: 'Sans protection', stores_int: 'Stores intérieurs', volets_ext: 'Volets extérieurs'
};
const LIB_TVA = {
    eligible: 'TVA 5,5 %',
    non_eligible: 'TVA 20 %',
    a_verifier: 'TVA à vérifier'
};

// Les cinq postes du bilan froid, dans l'ordre où ils sont empilés sur la règle de couverture.
// `explication` n'apparaît que sur le rapport client : sur la fiche de travail, nommer le poste
// suffit — l'installateur sait ce qu'est un apport solaire, et la phrase lui volerait la place
// des chiffres qu'il recopie.
const POSTES_FROID = [
    { cle: 'enveloppe', nom: 'Enveloppe',      explication: 'Ce qui traverse les murs, le sol et l\'air renouvelé.' },
    { cle: 'toiture',   nom: 'Toiture',        explication: 'La surchauffe de la couverture au-dessus de la pièce.' },
    { cle: 'solaire',   nom: 'Apports solaires', explication: 'Ce que le soleil fait entrer par les vitrages.' },
    { cle: 'internes',  nom: 'Apports internes', explication: 'L\'éclairage et les appareils en fonctionnement.' },
    { cle: 'occupants', nom: 'Occupants',      explication: 'La chaleur dégagée par les personnes présentes.' }
];

export function libelleTva(tva) {
    if (!tva) return 'TVA non renseignée';
    return (LIB_TVA[tva.statut] || LIB_TVA.a_verifier) + (tva.wifiRequired ? ' · module Wifi requis' : '');
}

// --- Construction du modèle depuis un calcul vivant --------------------------------------

// Une pièce de la fiche, à partir de sa saisie (`room`) et de ce que le calcul en a tiré
// (`rd` : l'entrée de roomsData d'app.js, qui porte req/froidMatch/chaudMatch/size).
// Toutes les entrées sont RECOPIÉES ici, bien qu'elles existent déjà dans `body.rooms` : une
// fiche est un document, elle doit rester imprimable sans dépendre d'une autre clé du body.
function pieceDepuisCalcul(room, rd, coefG, coefGSurcharge, role) {
    const d = rd.req.detail || null;
    return {
        index: rd.index,
        nom: rd.nom || room.nom || '',
        surface: Number(d ? d.entrees.surface : room.surface),
        hauteur: Number(d ? d.entrees.height : room.height),
        volume: d ? d.entrees.volume : null,
        emplacement: room.emplacement,
        orientation: room.orientation,
        vitrage: room.vitrage,
        protection: room.protection,
        expositionMurs: d ? d.exposition.nbMursExt : Number(room.expositionMurs) || 4,
        occupants: d ? d.occupants.nb : null,
        coefG,
        coefGSurcharge,
        req: { froid: rd.req.froid, chaud: rd.req.chaud },
        match: { froid: rd.froidMatch, chaud: rd.chaudMatch },
        taille: rd.size || null,
        postes: d ? { ...d.froidPostes } : null,
        chaudDetail: d ? {
            deltaT: d.chaudDetail.deltaT,
            deperditions: d.chaudDetail.deperditionsSeches,
            coefRelance: d.chaudDetail.coefRelance
        } : null,
        role: role || 'groupe'
    };
}

// Assemble le socle de la fiche — tout ce qui ne dépend PAS du choix de matériel.
// `materiel` est ajouté plus tard, par le rendu des résultats, parce que c'est lui qui sait
// quelle option est sélectionnée. Le construire ici aussi ferait exister deux réponses à la
// seule question que cet outil doit trancher : quelle machine a été retenue.
export function construireFiche({ hypotheses, pieces }) {
    const lignes = pieces.map(p =>
        pieceDepuisCalcul(p.room, p.rd, p.coefG, p.coefGSurcharge ?? null, p.role));
    return {
        origine: 'calcul',
        hypotheses,
        bilan: {
            froid: lignes.reduce((s, p) => s + p.req.froid, 0),
            chaud: lignes.reduce((s, p) => s + p.req.chaud, 0)
        },
        pieces: lignes,
        materiel: null
    };
}

// --- Repli : reconstituer une fiche enregistrée avant l'arrivée de body.fiche -------------

// Rejoue le MOTEUR sur les entrées persistées (body.rooms + body.params, présentes depuis
// l'origine), plutôt que de recopier ses formules. Si getRequiredKw change, ce repli change
// avec lui : c'est la seule façon qu'une fiche recalculée dise la vérité du jour et non une
// approximation figée qui divergerait silencieusement.
//
// Ne reconstitue PAS le matériel : la sélection dépend du catalogue, qui a pu bouger depuis
// l'enregistrement. Le matériel retenu reste celui qui a été enregistré, en texte
// (body.equipments) — c'est une décision prise à une date, pas une valeur à recalculer.
//
// Renvoie null quand les entrées ne permettent rien de fiable : mieux vaut le rendu dégradé
// d'origine qu'un bilan inventé.
export function ficheDeSecours(body) {
    const p = body && body.params;
    if (!p || !p.deptSelect || !DEPARTMENTS[p.deptSelect]) return null;
    if (!Array.isArray(body.rooms) || body.rooms.length === 0) return null;

    const zone = DEPARTMENTS[p.deptSelect].zone;
    const parAltitude = tBaseMatrix[p.altitude];
    const parAltitudeEte = tBaseEteMatrix[p.altitude];
    if (!parAltitude || !parAltitudeEte) return null;

    const tBaseHiver = parAltitude[zone];
    const tBaseEte = parAltitudeEte[zone];
    if (!Number.isFinite(tBaseHiver) || !Number.isFinite(tBaseEte)) return null;

    const consigne = Number(p.consigneInt) || CONSIGNE_REFERENCE;
    const coefGBatiment = resolveCoefG(p.isolationCoef, p.customCoef);
    const multi = body.mode === 'multi';
    const froidSeul = body.usage === 'froid_seul';
    const facteurCanicule = getFacteurCanicule(tBaseEte);
    const facteurDeclassementChaud = getFacteurDeclassementChaud(tBaseHiver);

    const pieces = [];
    for (let i = 0; i < body.rooms.length; i++) {
        const r = body.rooms[i];
        const surface = Number(String(r.surface).replace(',', '.'));
        const hauteur = Number(String(r.height).replace(',', '.'));
        if (!Number.isFinite(surface) || surface <= 0) return null;
        if (!Number.isFinite(hauteur) || hauteur <= 0) return null;

        // Surcharge d'isolation propre à la pièce : n'a de sens qu'en multisplit, exactement
        // comme getRoomCoefG (app.js). Une valeur survivant à un aller-retour multi -> mono ne
        // doit pas peser sur un bilan dont le document ne montrerait pas qu'elle existe.
        const surcharge = (multi && r.isolationCoef) ? resolveCoefG(r.isolationCoef, r.customCoefG) : null;
        const coefG = surcharge ?? coefGBatiment;

        const req = getRequiredKw(surface, hauteur, r, { coefG, tBaseHiver, tBaseEte, consigne });
        const froidMatch = req.froid * facteurCanicule;
        const chaudMatch = froidSeul ? 0 : req.chaud * facteurDeclassementChaud;
        pieces.push(pieceDepuisCalcul(
            r,
            { index: i + 1, nom: r.nom || '', req, froidMatch, chaudMatch,
              size: getUiSizeForKw(froidMatch, chaudMatch, body.brand) },
            coefG, surcharge, null
        ));
    }

    return {
        origine: 'recalculee',
        hypotheses: {
            dept: p.deptSelect,
            deptNom: DEPARTMENTS[p.deptSelect].name,
            altitude: p.altitude,
            zone, tBaseHiver, tBaseEte, consigne,
            isolationLabel: p.isolationCoef === 'custom'
                ? `saisie personnalisée (G ${nb(coefGBatiment, 2)})`
                : `G ${nb(coefGBatiment, 2)}`,
            coefG: coefGBatiment,
            facteurCanicule,
            facteurDeclassementChaud: froidSeul ? 1 : facteurDeclassementChaud,
            corrections: []
        },
        bilan: {
            froid: pieces.reduce((s, x) => s + x.req.froid, 0),
            chaud: pieces.reduce((s, x) => s + x.req.chaud, 0)
        },
        pieces,
        materiel: null
    };
}

// Aiguillage de lecture, en trois paliers. `cfg` est la vue aplatie du magasin (store.vueLisible).
//   1 — `fiche` enregistrée : fidélité totale.
//   2 — absente mais entrées exploitables : bilan recalculé, matériel lu dans equipments[].
//   3 — rien d'exploitable : pas de fiche, le rendu dégradé d'origine prend le relais.
export function ficheDepuisBody(cfg) {
    if (!cfg) return { fiche: null, palier: 3 };
    if (cfg.fiche && Array.isArray(cfg.fiche.pieces) && cfg.fiche.pieces.length > 0) {
        return { fiche: { ...cfg.fiche, identite: identiteDepuisConfig(cfg) }, palier: 1 };
    }
    if (cfg.legacyIncomplete) return { fiche: null, palier: 3 };
    const secours = ficheDeSecours(cfg);
    if (!secours) return { fiche: null, palier: 3 };
    return {
        fiche: {
            ...secours,
            identite: identiteDepuisConfig(cfg),
            equipementsEnregistres: cfg.equipments || []
        },
        palier: 2
    };
}

function identiteDepuisConfig(cfg) {
    return {
        client: cfg.clientName || '',
        zone: cfg.zone || '',
        dateStr: cfg.date || '',
        brand: cfg.brand,
        brandLabel: BRAND_LABELS[cfg.brand] || cfg.brand || '',
        modeLabel: cfg.mode === 'mono' ? 'Monosplit' : 'Multisplit',
        usage: cfg.usage
    };
}

// --- Assainissement avant persistance ----------------------------------------------------

// Une fiche est un DOCUMENT, pas une entrée de calcul : personne ne recalcule à partir d'elle.
// On arrondit donc à la précision réellement imprimée. Ce n'est pas une micro-optimisation :
// un seul `2.1900000000000004` pèse 18 octets contre 4, et il y a une quarantaine de nombres
// par pièce, dans un body déjà resérialisé en entier à chaque écriture (voir commit(), store.js).
//
// Garantit aussi que le résultat traverse structuredClone() et JSON.stringify() sans surprise :
// pas de fonction, pas d'undefined, pas de Set — les non-finis deviennent null plutôt que de
// se transformer silencieusement en `null` seulement au moment de la sérialisation.
export function assainirFiche(fiche) {
    if (!fiche) return null;
    const h = fiche.hypotheses || {};
    return {
        origine: fiche.origine || 'calcul',
        genereLe: fiche.genereLe || null,
        moteur: fiche.moteur || null,
        hypotheses: {
            dept: h.dept ?? null,
            deptNom: h.deptNom ?? null,
            altitude: h.altitude ?? null,
            zone: h.zone ?? null,
            tBaseHiver: arrondi(h.tBaseHiver, 1),
            tBaseEte: arrondi(h.tBaseEte, 1),
            consigne: arrondi(h.consigne, 1),
            isolationLabel: h.isolationLabel ?? null,
            coefG: arrondi(h.coefG, 4),
            facteurCanicule: arrondi(h.facteurCanicule, 4),
            facteurDeclassementChaud: arrondi(h.facteurDeclassementChaud, 4),
            // La prose des corrections est CONSERVÉE telle quelle, bien qu'elle soit
            // régénérable depuis data.js : une justification archivée qui change de
            // formulation parce qu'un commentaire a été réécrit six mois plus tard n'est
            // plus une justification.
            corrections: (h.corrections || []).map(c => ({
                libelle: String(c.libelle ?? ''),
                valeur: String(c.valeur ?? ''),
                detail: String(c.detail ?? '')
            }))
        },
        bilan: {
            froid: arrondi(fiche.bilan && fiche.bilan.froid, 3),
            chaud: arrondi(fiche.bilan && fiche.bilan.chaud, 3)
        },
        pieces: (fiche.pieces || []).map(p => ({
            index: p.index,
            nom: String(p.nom || ''),
            surface: arrondi(p.surface, 2),
            hauteur: arrondi(p.hauteur, 2),
            volume: arrondi(p.volume, 2),
            emplacement: p.emplacement ?? null,
            orientation: p.orientation ?? null,
            vitrage: p.vitrage ?? null,
            protection: p.protection ?? null,
            expositionMurs: arrondi(p.expositionMurs, 0),
            occupants: arrondi(p.occupants, 0),
            coefG: arrondi(p.coefG, 4),
            coefGSurcharge: p.coefGSurcharge === null || p.coefGSurcharge === undefined
                ? null : arrondi(p.coefGSurcharge, 4),
            req: { froid: arrondi(p.req && p.req.froid, 3), chaud: arrondi(p.req && p.req.chaud, 3) },
            match: { froid: arrondi(p.match && p.match.froid, 3), chaud: arrondi(p.match && p.match.chaud, 3) },
            taille: p.taille ?? null,
            postes: p.postes ? {
                enveloppe: arrondi(p.postes.enveloppe, 0),
                toiture: arrondi(p.postes.toiture, 0),
                solaire: arrondi(p.postes.solaire, 0),
                internes: arrondi(p.postes.internes, 0),
                occupants: arrondi(p.postes.occupants, 0)
            } : null,
            chaudDetail: p.chaudDetail ? {
                deltaT: arrondi(p.chaudDetail.deltaT, 1),
                deperditions: arrondi(p.chaudDetail.deperditions, 3),
                coefRelance: arrondi(p.chaudDetail.coefRelance, 3)
            } : null,
            // Chaîne calculée, jamais une référence au Set state.forcedDedicatedIds :
            // JSON.stringify rend un Set `{}` SANS lever, la perte serait silencieuse.
            role: String(p.role || 'groupe')
        })),
        materiel: assainirMateriel(fiche.materiel)
    };
}

function assainirMateriel(m) {
    if (!m) return null;
    const tva = (t) => t ? { statut: String(t.statut), wifiRequired: Boolean(t.wifiRequired) } : null;
    const machine = (x) => x ? {
        reference: String(x.reference ?? ''),
        gamme: x.gamme ? String(x.gamme) : null,
        froidKw: arrondi(x.froidKw, 2),
        chaudKw: arrondi(x.chaudKw, 2),
        sorties: x.sorties ?? null,
        piece: x.piece ?? null,
        nom: x.nom ? String(x.nom) : null,
        besoin: x.besoin ? { froid: arrondi(x.besoin.froid, 3), chaud: arrondi(x.besoin.chaud, 3) } : null,
        foisonnement: x.foisonnement
            ? { froid: arrondi(x.foisonnement.froid, 3), chaud: arrondi(x.foisonnement.chaud, 3) }
            : null,
        tva: tva(x.tva)
    } : null;
    return {
        type: String(m.type || 'mono'),
        groupe: machine(m.groupe),
        unites: (m.unites || []).map(u => ({
            piece: u.piece ?? null,
            nom: u.nom ? String(u.nom) : null,
            taille: u.taille ?? null,
            gamme: u.gamme ? String(u.gamme) : null,
            froidKw: arrondi(u.froidKw, 2),
            chaudKw: arrondi(u.chaudKw, 2),
            tva: tva(u.tva)
        })),
        monos: (m.monos || []).map(machine),
        alertes: (m.alertes || []).map(a => String(a))
    };
}

// --- Modèle de lignes pour le tableau de bord --------------------------------------------

// Le tableau « pièce / surface / froid / chaud / unité » du dashboard. Vit ici, et non dans
// app.js, parce que c'est un MODÈLE (quelles lignes, dans quel ordre, avec quelles valeurs) et
// qu'il se teste ; seul son habillage HTML reste dans app.js.
export function lignesTableauFiche(fiche) {
    if (!fiche || !Array.isArray(fiche.pieces) || fiche.pieces.length === 0) return null;
    const pieces = fiche.pieces.map(p => ({
        index: p.index,
        libelle: p.nom ? `${p.index} — ${p.nom}` : `Pièce ${p.index}`,
        surface: p.surface,
        froid: p.req.froid,
        chaud: p.req.chaud,
        // `null` signifie « aucune unité du catalogue ne couvre ce besoin », ce qui est une
        // information de dimensionnement à part entière — pas une case vide.
        taille: p.taille,
        horsCatalogue: !p.taille
    }));
    return {
        pieces,
        total: {
            surface: pieces.reduce((s, p) => s + (p.surface || 0), 0),
            froid: fiche.bilan.froid,
            chaud: fiche.bilan.chaud
        },
        recalculee: fiche.origine === 'recalculee'
    };
}

// --- Primitives de rendu ------------------------------------------------------------------

function bandeau(titre) {
    return `<h2 class="pf-band">${escapeHtml(titre)}</h2>`;
}

function paire(libelle, valeur) {
    return `<div class="pf-paire"><dt>${escapeHtml(libelle)}</dt><dd>${valeur}</dd></div>`;
}

// LA RÈGLE DE COUVERTURE — l'objet qui porte tout le document.
//
// Le besoin est dessiné À L'ÉCHELLE, décomposé en ses cinq postes ; juste en dessous, la
// puissance de la machine, sur la MÊME échelle, doit visiblement dépasser. C'est exactement
// l'argument que la fiche existe pour tenir : d'où vient le besoin, et pourquoi cette machine
// le couvre. Une phrase peut l'affirmer ; seule une mise à l'échelle le montre.
//
// Les cinq postes se distinguent par la VALEUR et non par la teinte (dégradé du bleu froid du
// plus foncé au plus clair) : imprimé en noir et blanc sur le photocopieur d'un client, le
// dessin reste lisible en cinq marches. Une palette à cinq teintes ne survivrait pas.
//
// `echelle` est OPTIONNELLE et doit être fournie par l'appelant chaque fois que plusieurs
// barres apparaissent côte à côte sur le document (une par pièce) : sans elle, chaque barre se
// cale sur SON PROPRE total et remplit systématiquement 100 % de la piste, quelle que soit sa
// valeur réelle — un salon à 2,1 kW et un bureau à 0,55 kW s'imprimeraient alors avec des
// barres RIGOUREUSEMENT IDENTIQUES. Le nombre à côté resterait juste, mais l'image, qui est
// justement ce que le lecteur retient d'un coup d'œil, mentirait. Voir echelleRoomsFiche().
function regleCouverture({ postes, totalW, machineKw, libelleMachine, note, echelle: echelleImposee }) {
    const echelle = echelleImposee || Math.max(totalW, (machineKw || 0) * 1000);
    if (echelle <= 0) return '';

    // Sans détail des postes — le besoin CUMULÉ d'un groupe multisplit, qui est une somme de
    // pièces et non un bilan à décomposer — la barre est pleine d'un seul tenant. Empiler des
    // segments de largeur nulle laisserait une barre vide en face d'une valeur non nulle.
    const segments = postes
        ? POSTES_FROID.map((poste, i) => {
            const w = postes[poste.cle] || 0;
            if (w <= 0) return '';
            return `<span class="pf-seg pf-seg-${i}" style="width:${pourcent(w, echelle).toFixed(3)}%"
                          title="${escapeHtml(poste.nom)}"></span>`;
        }).join('')
        : `<span class="pf-seg pf-seg-1" style="width:${pourcent(totalW, echelle).toFixed(3)}%"></span>`;

    const barreMachine = machineKw > 0 ? `
        <div class="pf-regle-ligne">
            <span class="pf-regle-lib">${escapeHtml(libelleMachine || 'Machine retenue')}</span>
            <span class="pf-barre"><span class="pf-machine" style="width:${pourcent(machineKw * 1000, echelle).toFixed(3)}%"></span></span>
            <span class="pf-regle-val">${nb(machineKw, 2)} kW</span>
        </div>` : '';

    return `
    <div class="pf-regle">
        <div class="pf-regle-ligne">
            <span class="pf-regle-lib">Besoin calculé</span>
            <span class="pf-barre">${segments}</span>
            <span class="pf-regle-val">${nb(totalW / 1000, 2)} kW</span>
        </div>
        ${barreMachine}
        ${note ? `<p class="pf-regle-note">${note}</p>` : ''}
    </div>`;
}

function legendePostes({ avecExplication = false } = {}) {
    // En liste verticale dès qu'une explication accompagne chaque poste (rapport client) : sur
    // une seule ligne, le texte fait retomber les puces en un pavage imprévisible qui casse la
    // correspondance entre l'ordre de lecture et l'ordre des segments dans la barre — voir la
    // règle .pf-legende--detail (index.html).
    return `<ul class="pf-legende${avecExplication ? ' pf-legende--detail' : ''}">${POSTES_FROID.map((p, i) => `
        <li><span class="pf-puce pf-seg-${i}"></span><b>${escapeHtml(p.nom)}</b>${
            avecExplication ? ` <span class="pf-legende-txt">${escapeHtml(p.explication)}</span>` : ''
        }</li>`).join('')}</ul>`;
}

// En-tête du document. L'ÉMETTEUR est l'installateur, jamais Klimo : c'est son document, remis
// par lui, et le principe produit est explicite là-dessus (« l'outil est celui de l'installateur,
// pas du constructeur »). Klimo ne se nomme qu'en pied, comme l'outil qui a produit le calcul.
// Klimo ne remonte en émetteur que lorsque l'identité installateur n'a pas été saisie : un
// document sans émetteur du tout serait pire qu'un document signé par l'outil.
//
// Le titre porte seul : pas de sur-titre au-dessus de lui. Une étiquette posée là ne fait que
// retarder la ligne qui dit vraiment ce qu'on lit.
function enTete(fiche, titreDoc) {
    const id = fiche.identite || {};
    return `
    <header class="pf-head">
        <h1 class="pf-titre">${escapeHtml(titreDoc)}</h1>
        <p class="pf-emetteur">${escapeHtml(id.installateur || 'Klimo')}</p>
    </header>
    <dl class="pf-identite">
        ${id.client ? paire('Client', escapeHtml(id.client)) : ''}
        ${id.zone ? paire('Zone', escapeHtml(id.zone)) : ''}
        ${id.dateStr ? paire('Date', escapeHtml(id.dateStr)) : ''}
        ${paire('Installation', `${escapeHtml(id.modeLabel || '')}${id.brandLabel ? ` · ${escapeHtml(id.brandLabel)}` : ''}`)}
    </dl>`;
}

// Une fiche recalculée à la lecture doit le DIRE. Présenter un bilan reconstitué comme s'il
// avait été enregistré tel quel reviendrait à donner pour acquis ce qui ne l'est pas.
function avertissementOrigine(fiche) {
    if (fiche.origine !== 'recalculee') return '';
    return `<p class="pf-avert">Bilan reconstitué à partir des paramètres enregistrés avec ce chantier.
        Le matériel indiqué est celui qui avait été retenu lors de l'enregistrement.</p>`;
}

function piedDePage(fiche) {
    const id = fiche.identite || {};
    return `<footer class="pf-foot">
        <span>Klimo${fiche.moteur ? ` ${escapeHtml(fiche.moteur)}` : ''} — dimensionnement indicatif, à valider par un professionnel avant installation.</span>
        ${id.installateur ? `<span>${escapeHtml(id.installateur)}</span>` : ''}
    </footer>`;
}

// Une paire dont la valeur manque n'est pas rendue du tout. Afficher « Températures de base :
// — °C hiver · — °C été » sur une fiche ancienne donnerait à lire comme une mesure manquante
// ce qui n'a simplement jamais été enregistré.
function grille(entrees, classe = '') {
    const paires = entrees.filter(([, v]) => v !== null && v !== undefined && v !== '');
    if (paires.length === 0) return '';
    return `<dl class="pf-grille${classe ? ' ' + classe : ''}">${paires.map(([l, v]) => paire(l, v)).join('')}</dl>`;
}

function blocHypotheses(fiche, { complet }) {
    const h = fiche.hypotheses || {};
    // `Number.isFinite(Number(null))` vaut true — Number(null) est 0. Une valeur absente doit
    // donc être écartée AVANT toute conversion, sinon elle s'imprime en « 0 °C ».
    const fini = (x) => x !== null && x !== undefined && x !== '' && Number.isFinite(Number(x));
    const base = grille([
        ['Localisation', h.dept ? `${escapeHtml(h.dept)} ${escapeHtml(h.deptNom || '')}${h.altitude ? ` · ${escapeHtml(h.altitude)}` : ''}`.trim() : null],
        ['Températures de base', fini(h.tBaseHiver) && fini(h.tBaseEte) ? `${nb(h.tBaseHiver, 0)} °C hiver · ${nb(h.tBaseEte, 0)} °C été` : null],
        ['Isolation', h.isolationLabel ? escapeHtml(h.isolationLabel) : (fini(h.coefG) ? `G ${nb(h.coefG, 2)}` : null)],
        ['Consigne intérieure', fini(h.consigne) ? `${nb(h.consigne, 0)} °C en été` : null]
    ]);
    if (!complet) return base;
    return base + grille([
        ['Zone climatique', h.zone ? escapeHtml(h.zone) : null],
        ['Coefficient G retenu', fini(h.coefG) ? nb(h.coefG, 2) : null],
        ['Marge canicule', h.facteurCanicule > 1 ? `× ${nb(h.facteurCanicule, 3)}` : null],
        ['Déclassement chaud', h.facteurDeclassementChaud > 1 ? `× ${nb(h.facteurDeclassementChaud, 3)}` : null]
    ], 'pf-technique');
}

// Le bilan cumulé n'est rendu que s'il existe : `nb(null)` donnerait « 0,00 kW », c'est-à-dire
// l'affirmation qu'il n'y a aucun besoin, là où la vérité est qu'il n'a pas été enregistré.
function blocBilan(fiche) {
    const b = fiche.bilan || {};
    return grille([
        ['Besoin froid cumulé', Number.isFinite(b.froid) ? `<b>${nb(b.froid, 2)} kW</b>` : null],
        ['Besoin chaud cumulé', Number.isFinite(b.chaud) ? `<b>${nb(b.chaud, 2)} kW</b>` : null]
    ], 'pf-bilan');
}

// Les majorations appliquées au besoin brut avant de choisir la machine.
//
// Le détail est montré dans LES DEUX documents, contrairement aux tableaux techniques. Sur le
// rapport client, « Déclassement chaud +46 % » livré nu est plus inquiétant qu'informatif : un
// pourcentage à deux chiffres sans sa raison se lit comme une majoration arbitraire, alors que
// c'est précisément ce que le document doit justifier. Seul le titre change, parce que le
// lecteur n'est pas le même : l'installateur lit des corrections apportées à sa sélection, le
// client demande pourquoi la machine posée est plus puissante que le besoin annoncé.
function blocCorrections(fiche, { avecDetail, titre }) {
    const corrections = (fiche.hypotheses && fiche.hypotheses.corrections) || [];
    if (corrections.length === 0) return '';
    return `
    ${bandeau(titre || 'Corrections appliquées à la sélection')}
    <ul class="pf-corrections">${corrections.map(c => `
        <li>
            <span class="pf-corr-lib">${escapeHtml(c.libelle)}</span>
            <span class="pf-corr-val">${escapeHtml(c.valeur)}</span>
            ${avecDetail && c.detail ? `<p class="pf-corr-detail">${escapeHtml(c.detail)}</p>` : ''}
        </li>`).join('')}</ul>`;
}

// La machine que la règle de couverture doit confronter au besoin d'une pièce donnée : le
// monosplit dédié quand la pièce en a un, sinon l'unité intérieure du groupe qui la dessert.
//
// Les deux ne répondent pas à la même question, et c'est voulu. Le monosplit dédié EST la
// machine : sa capacité au repos égale sa capacité en pointe. L'unité intérieure d'un groupe
// n'est qu'une sortie parmi d'autres d'un compresseur unique — sa fiche technique donne une
// puissance nominale, mais la puissance qu'elle délivre réellement dépend de ce que les autres
// unités demandent au même instant (c'est tout l'objet du foisonnement, montré séparément dans
// « La machine couvre le besoin »). On l'affiche ici quand même, parce que c'est la seule
// grandeur qui répond à la question du client : « cette unité posée dans MA pièce, elle vaut
// combien face à ce que vous avez calculé pour MA pièce ? ». La confondre avec une garantie de
// débit à pleine pointe serait faux ; l'omettre laisserait la corrélation besoin → matériel
// invisible pour la seule pièce que le client regarde vraiment.
function machinePourPiece(fiche, piece) {
    const m = fiche.materiel;
    if (!m) return null;
    if (m.type === 'mono' && m.monos.length > 0) return m.monos[0];
    const dedie = m.monos.find(x => x && x.piece === piece.index);
    if (dedie) return dedie;
    return m.unites.find(u => u && u.piece === piece.index) || null;
}

// Une seule échelle pour TOUTES les barres « Besoin calculé » de la section pièce par pièce,
// afin qu'elles restent comparables entre elles au premier coup d'œil — c'est la même barre,
// répétée : elle doit se lire une fois et valoir pour toutes. Inclut le besoin de chaque pièce
// ET la puissance de son éventuelle machine dédiée (monosplit délesté), pour qu'aucune barre
// machine ne déborde de sa piste. Le groupe multisplit n'y entre PAS : sa capacité (plusieurs
// kW de plus que n'importe quelle pièce) écraserait visuellement toutes les barres de pièces
// à une poignée de pixels — c'est un fait de dimensionnement différent, montré séparément dans
// son propre bloc « La machine couvre le besoin », avec sa propre échelle locale.
export function echelleRoomsFiche(fiche) {
    if (!fiche || !Array.isArray(fiche.pieces)) return 0;
    return fiche.pieces.reduce((max, piece) => {
        const totalW = piece.postes
            ? POSTES_FROID.reduce((s, p) => s + (piece.postes[p.cle] || 0), 0)
            : piece.req.froid * 1000;
        const machine = machinePourPiece(fiche, piece);
        return Math.max(max, totalW, (machine ? machine.froidKw : 0) * 1000);
    }, 0);
}

function blocPiece(fiche, piece, { technique, echelle }) {
    const machine = machinePourPiece(fiche, piece);
    const totalW = piece.postes
        ? POSTES_FROID.reduce((s, p) => s + (piece.postes[p.cle] || 0), 0)
        : piece.req.froid * 1000;

    const caracteristiques = [
        `${nb(piece.surface, 0)} m²`,
        piece.volume ? `${nb(piece.volume, 0)} m³` : null,
        LIB_EMPLACEMENT[piece.emplacement],
        LIB_ORIENTATION[piece.orientation],
        LIB_VITRAGE[piece.vitrage],
        LIB_PROTECTION[piece.protection],
        piece.occupants !== null ? `${nb(piece.occupants, 0)} occupant${piece.occupants > 1 ? 's' : ''}` : null,
        technique && piece.expositionMurs ? `${piece.expositionMurs} mur(s) extérieur(s)` : null,
        piece.coefGSurcharge !== null && piece.coefGSurcharge !== undefined
            ? `isolation propre : G ${nb(piece.coefGSurcharge, 2)}` : null
    ].filter(Boolean);

    // Parts réparties au plus fort reste plutôt qu'arrondies une à une : la colonne doit tomber
    // sur les 100 % que sa propre ligne de total annonce (voir partsEntieres).
    const parts = piece.postes ? partsEntieres(POSTES_FROID.map(p => piece.postes[p.cle] || 0)) : [];
    const tableauPostes = technique && piece.postes ? `
    <table class="pf-table pf-technique">
        <thead><tr><th>Poste</th><th class="pf-n">W</th><th class="pf-n">Part</th></tr></thead>
        <tbody>
            ${POSTES_FROID.map((p, i) => {
                const w = piece.postes[p.cle] || 0;
                return `<tr><td>${escapeHtml(p.nom)}</td><td class="pf-n">${nb(w, 0)}</td><td class="pf-n">${parts[i]} %</td></tr>`;
            }).join('')}
            <tr class="pf-total"><td>Besoin froid</td><td class="pf-n">${nb(totalW, 0)}</td><td class="pf-n">100 %</td></tr>
        </tbody>
    </table>` : '';

    // Le chemin de calcul du chaud n'est écrit qu'en fiche de travail. « × 1,20 de relance » est
    // du vocabulaire de métier : sur le document remis au client, il n'explique rien et occupe
    // la ligne où se lit le résultat. Le client voit la puissance, l'installateur voit d'où elle
    // sort — même valeur, même arrondi, dans les deux cas.
    const ligneChaud = (technique && piece.chaudDetail) ? `
        <p class="pf-chaud-ligne">Chauffage : déperditions ${nb(piece.chaudDetail.deperditions, 2)} kW
        pour un écart de ${nb(piece.chaudDetail.deltaT, 0)} °C, × ${nb(piece.chaudDetail.coefRelance, 2)} de relance
        = <b>${nb(piece.req.chaud, 2)} kW</b></p>`
        : `<p class="pf-chaud-ligne">Chauffage : <b>${nb(piece.req.chaud, 2)} kW</b></p>`;

    return `
    <section class="pf-piece">
        <h3 class="pf-piece-titre">
            <span>${escapeHtml(piece.nom ? `${piece.index} · ${piece.nom}` : `Pièce ${piece.index}`)}</span>
            <span class="pf-piece-unite">${piece.taille ? `Unité taille ${escapeHtml(String(piece.taille))}` : 'Hors catalogue'}</span>
        </h3>
        <p class="pf-carac">${caracteristiques.map(escapeHtml).join(' · ')}</p>
        ${regleCouverture({
            postes: piece.postes,
            totalW,
            machineKw: machine ? machine.froidKw : 0,
            // La GAMME seule sur la piste : la référence commandable complète (deux codes
            // séparés par une barre, souvent plus de trente caractères) n'entre pas dans les
            // 32 mm du libellé et s'y ferait couper au milieu d'un code — une référence
            // tronquée sur un document de commande est pire qu'absente. Elle figure en entier,
            // et une seule fois, dans le tableau « Matériel retenu ».
            libelleMachine: machine ? (machine.gamme || machine.reference || '') : '',
            note: null,
            echelle
        })}
        ${ligneChaud}
        ${tableauPostes}
    </section>`;
}

// Couverture du groupe multisplit. La capacité confrontée au besoin cumulé n'est PAS la
// puissance nominale seule : un groupe alimente plusieurs pièces qui n'appellent jamais leur
// pointe au même instant, et la sélection l'admet explicitement (COEF_FOISONNEMENT_*, voir
// findGroupesValides). Dessiner le nominal nu ferait apparaître comme un sous-dimensionnement
// ce qui est un choix de conception — donc on dessine la capacité disponible en simultané, et
// on écrit le coefficient qui la produit.
function blocCouvertureGroupe(fiche) {
    const m = fiche.materiel;
    if (!m || !m.groupe) return '';
    const g = m.groupe;
    const foisF = (g.foisonnement && g.foisonnement.froid) || COEF_FOISONNEMENT_FROID;
    const besoinFroid = (g.besoin && g.besoin.froid) || 0;
    if (besoinFroid <= 0) return '';
    const disponible = g.froidKw * foisF;
    const marge = pourcent(disponible - besoinFroid, besoinFroid);
    // Une marge très large (groupe minimal du catalogue à ce nombre de sorties) se lit comme
    // une alerte si elle n'est présentée QUE comme un pourcentage brut — un « Marge de 102 % »
    // sonne comme une erreur de calcul plutôt que comme ce qu'elle est réellement : le plus
    // petit groupe du catalogue à ce nombre de sorties dépasse déjà largement le besoin. On le
    // dit en ces termes au-delà d'un certain seuil, plutôt que de laisser le lecteur deviner.
    const ampleur = marge >= 60
        ? ` C'est le groupe le plus petit du catalogue à ${g.sorties || m.unites.length} sorties : aucune référence plus proche du besoin n'existe pour ce nombre d'unités.`
        : '';

    return `
    ${bandeau('La machine couvre le besoin')}
    <div class="pf-couverture">
        ${regleCouverture({
            postes: null,
            totalW: besoinFroid * 1000,
            machineKw: disponible,
            libelleMachine: escapeHtml(g.reference),
            note: `Puissance nominale ${nb(g.froidKw, 2)} kW froid, soit ${nb(disponible, 2)} kW disponibles
                   en simultané sur ${g.sorties || m.unites.length} unités (coefficient de foisonnement ${nb(foisF, 2)}).
                   <b>Marge de ${nb(marge, 0)} %</b> sur le besoin cumulé.${ampleur}`
        })}
    </div>`;
}

function blocMateriel(fiche, { technique }) {
    const m = fiche.materiel;
    if (!m) {
        const enr = fiche.equipementsEnregistres || [];
        if (enr.length === 0) return '';
        return `${bandeau('Matériel retenu')}
            <ul class="pf-liste">${enr.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`;
    }

    const groupe = m.groupe ? `
    <table class="pf-table">
        <thead><tr><th>Groupe extérieur</th><th class="pf-n">Froid</th><th class="pf-n">Chaud</th><th>Conditions</th></tr></thead>
        <tbody><tr>
            <td><b>${escapeHtml(m.groupe.reference)}</b>${m.groupe.sorties ? ` · ${m.groupe.sorties} sorties` : ''}</td>
            <td class="pf-n">${nb(m.groupe.froidKw, 2)} kW</td>
            <td class="pf-n">${nb(m.groupe.chaudKw, 2)} kW</td>
            <td>${escapeHtml(libelleTva(m.groupe.tva))}</td>
        </tr></tbody>
    </table>` : '';

    // Froid/Chaud : la puissance de l'unité intérieure ELLE-MÊME, pas le besoin de la pièce
    // (déjà affiché plus haut, pièce par pièce) — c'est la corrélation entre les deux qui
    // manquait : une taille de code catalogue ne dit rien à un client, un kW se compare.
    const unites = m.unites.length > 0 ? `
    <table class="pf-table">
        <thead><tr><th>Pièce</th><th>Unité intérieure</th><th class="pf-n">Taille</th><th class="pf-n">Froid</th><th class="pf-n">Chaud</th>${technique ? '<th>Conditions</th>' : ''}</tr></thead>
        <tbody>${m.unites.map(u => `<tr>
            <td>${escapeHtml(u.nom ? `${u.piece} · ${u.nom}` : `Pièce ${u.piece}`)}</td>
            <td>${escapeHtml(u.gamme || '—')}</td>
            <td class="pf-n">${escapeHtml(String(u.taille ?? '—'))}</td>
            <td class="pf-n">${Number.isFinite(u.froidKw) ? `${nb(u.froidKw, 2)} kW` : '—'}</td>
            <td class="pf-n">${Number.isFinite(u.chaudKw) ? `${nb(u.chaudKw, 2)} kW` : '—'}</td>
            ${technique ? `<td>${escapeHtml(libelleTva(u.tva))}</td>` : ''}
        </tr>`).join('')}</tbody>
    </table>` : '';

    const monos = m.monos.length > 0 ? `
    <table class="pf-table">
        <thead><tr><th>Monosplit dédié</th><th>Référence</th><th class="pf-n">Froid</th><th class="pf-n">Chaud</th><th>Conditions</th></tr></thead>
        <tbody>${m.monos.map(x => `<tr>
            <td>${escapeHtml(x.nom ? `${x.piece} · ${x.nom}` : (x.piece ? `Pièce ${x.piece}` : '—'))}</td>
            <td><b>${escapeHtml(x.gamme || '')}</b> ${escapeHtml(x.reference || '')}</td>
            <td class="pf-n">${nb(x.froidKw, 2)} kW</td>
            <td class="pf-n">${nb(x.chaudKw, 2)} kW</td>
            <td>${escapeHtml(libelleTva(x.tva))}</td>
        </tr>`).join('')}</tbody>
    </table>` : '';

    const alertes = m.alertes.length > 0
        ? `<ul class="pf-liste">${m.alertes.map(a => `<li>${escapeHtml(a)}</li>`).join('')}</ul>`
        : '';

    return `${bandeau('Matériel retenu')}${groupe}${unites}${monos}${alertes}`;
}

// Les réserves de méthode qui closent la fiche de travail, qu'il y ait une zone ou plusieurs :
// elles portent sur le MOTEUR de calcul, pas sur une zone en particulier, donc une seule
// occurrence suffit même quand gabaritTravailChantier imprime plusieurs zones à la suite.
function blocReserves() {
    return `
    ${bandeau('Réserves de méthode')}
    <ul class="pf-liste pf-reserves">
        <li>Puissances catalogue données au point d'essai EN 14511 (35 °C ext. en froid, +7 °C ext. en chaud).</li>
        <li>La surcharge toiture se cumule en partie avec la transmission déjà captée par le coefficient G : le biais va vers le surdimensionnement, jamais vers le déficit.</li>
        <li>Le déclassement chaud est une estimation générique, à affiner sur les courbes constructeur.</li>
        <li>Le coefficient G est appliqué pièce par pièce, pondéré par le nombre de murs extérieurs déclarés.</li>
    </ul>`;
}

// --- Gabarit 1 : fiche de travail ---------------------------------------------------------
//
// Destinataire : l'installateur, qui monte son devis. Tout y est, dense, dans l'ordre où on le
// recopie sur un bon de commande. La prose est masquée par le CSS (.pf-prose) : ici, nommer un
// poste suffit, et l'expliquer volerait la place des chiffres.
export function gabaritTravail(fiche) {
    if (!fiche) return '';
    const echelle = echelleRoomsFiche(fiche);
    return `
    ${enTete(fiche, 'Fiche de travail')}
    ${avertissementOrigine(fiche)}
    ${bandeau('Hypothèses de calcul')}
    ${blocHypotheses(fiche, { complet: true })}
    ${bandeau('Bilan pièce par pièce')}
    ${legendePostes()}
    ${fiche.pieces.map(p => blocPiece(fiche, p, { technique: true, echelle })).join('')}
    ${blocBilan(fiche)}
    ${blocCouvertureGroupe(fiche)}
    ${blocMateriel(fiche, { technique: true })}
    ${blocCorrections(fiche, { avecDetail: true })}
    ${blocReserves()}
    ${piedDePage(fiche)}`;
}

// --- Gabarit 2 : rapport client -----------------------------------------------------------
//
// Destinataire : le client, qui veut savoir pourquoi cette puissance et ce matériel. Même
// modèle, projection différente : les tableaux techniques sont masqués par le CSS
// (.pf-technique), la légende des postes est expliquée, et la règle de couverture porte le
// document — c'est elle qui montre le besoin composé puis couvert.
export function gabaritClient(fiche) {
    if (!fiche) return '';
    const echelle = echelleRoomsFiche(fiche);
    return `
    ${enTete(fiche, 'Étude de dimensionnement')}
    ${avertissementOrigine(fiche)}
    <p class="pf-chapo pf-prose">Cette étude calcule, pièce par pièce, la puissance nécessaire pour
        chauffer et rafraîchir votre logement dans les conditions climatiques de votre commune.
        Elle sert à choisir un matériel à la bonne taille : une machine trop petite ne tient pas
        les températures, une machine trop grande fonctionne par à-coups et s'use plus vite.</p>
    ${bandeau('Ce qui a été mesuré')}
    ${blocHypotheses(fiche, { complet: false })}
    ${bandeau('Pièce par pièce')}
    ${legendePostes({ avecExplication: true })}
    ${fiche.pieces.map(p => blocPiece(fiche, p, { technique: false, echelle })).join('')}
    ${blocBilan(fiche)}
    ${blocCouvertureGroupe(fiche)}
    ${blocMateriel(fiche, { technique: false })}
    ${blocCorrections(fiche, { avecDetail: true, titre: 'Pourquoi la machine dépasse le besoin calculé' })}
    ${piedDePage(fiche)}`;
}

// --- Gabarits 3 et 4 : chantier complet (plusieurs zones du même client) -----------------
//
// Le besoin : un même logement peut être desservi par plusieurs groupes extérieurs distincts
// (un par étage, une aile séparée…), chacun enregistré comme sa propre zone — c'est le bon
// découpage pour le CALCUL, un groupe multisplit ne se dimensionne que pour les pièces qu'il
// dessert. Mais pour le client, c'est un seul chantier, et il doit recevoir un seul document.
// Ces deux gabarits reprennent donc le corps de gabaritTravail/gabaritClient tel quel, une
// fois par zone, sous un UNIQUE en-tête et un UNIQUE pied de page — chaque zone démarre sur
// une nouvelle page (.pf-saut) pour rester identifiable au feuilletage.

// En-tête chantier : l'identité du CLIENT porte le document, pas celle d'une zone en
// particulier — contrairement à enTete(), qui identifie une fiche unique. `installateur` et
// `dateStr` sont supposés partagés entre zones (même saisie, même jour) ; en cas d'écart, ceux
// de la première zone priment plutôt que de choisir arbitrairement entre plusieurs valeurs.
function enTeteChantier(clientName, fiches, titreDoc) {
    const id = (fiches[0] && fiches[0].identite) || {};
    const zones = fiches.map(f => (f.identite && f.identite.zone) || '').filter(Boolean);
    return `
    <header class="pf-head">
        <h1 class="pf-titre">${escapeHtml(titreDoc)}</h1>
        <p class="pf-emetteur">${escapeHtml(id.installateur || 'Klimo')}</p>
    </header>
    <dl class="pf-identite">
        ${clientName ? paire('Client', escapeHtml(clientName)) : ''}
        ${zones.length > 0 ? paire(zones.length > 1 ? 'Zones' : 'Zone', escapeHtml(zones.join(' · '))) : ''}
        ${id.dateStr ? paire('Date', escapeHtml(id.dateStr)) : ''}
    </dl>`;
}

// Bandeau de section réutilisé pour ouvrir chaque zone, à la place du bandeau générique
// bandeau() : porte le nom de la zone (l'information qui manquerait sinon, une fois l'en-tête
// commun remonté au niveau du chantier) et, à droite, mode + marque de CETTE zone — deux
// groupes du même chantier peuvent être de marques différentes si le catalogue a changé entre
// deux visites, la mention doit donc rester par zone et non remonter à l'en-tête chantier.
function bandeauZone(fiche, index, total) {
    const id = fiche.identite || {};
    const sousTitre = [id.modeLabel, id.brandLabel].filter(Boolean).join(' · ');
    const compteur = total > 1 ? `Zone ${index + 1}/${total} — ` : '';
    return `<h2 class="pf-band pf-band-zone">
        <span>${escapeHtml(compteur)}${escapeHtml(id.zone || `Zone ${index + 1}`)}</span>
        ${sousTitre ? `<span class="pf-band-sub">${escapeHtml(sousTitre)}</span>` : ''}
    </h2>`;
}

// Fiche de travail — chantier complet. Corps identique à gabaritTravail, répété par zone ;
// seules les réserves de méthode (§blocReserves) ne portent qu'une fois, en fin de document :
// elles décrivent le moteur de calcul, pas une zone en particulier.
export function gabaritTravailChantier(clientName, fiches) {
    if (!fiches || fiches.length === 0) return '';
    return `
    ${enTeteChantier(clientName, fiches, 'Fiche de travail')}
    ${fiches.map((fiche, i) => {
        const echelle = echelleRoomsFiche(fiche);
        return `
    <section class="pf-zone${i > 0 ? ' pf-saut' : ''}">
        ${bandeauZone(fiche, i, fiches.length)}
        ${avertissementOrigine(fiche)}
        ${bandeau('Hypothèses de calcul')}
        ${blocHypotheses(fiche, { complet: true })}
        ${bandeau('Bilan pièce par pièce')}
        ${legendePostes()}
        ${fiche.pieces.map(p => blocPiece(fiche, p, { technique: true, echelle })).join('')}
        ${blocBilan(fiche)}
        ${blocCouvertureGroupe(fiche)}
        ${blocMateriel(fiche, { technique: true })}
        ${blocCorrections(fiche, { avecDetail: true })}
    </section>`;
    }).join('')}
    ${blocReserves()}
    ${piedDePage(fiches[0])}`;
}

// Rapport client — chantier complet. Même principe ; le chapô d'ouverture ne s'écrit qu'une
// fois et signale, s'il y a plusieurs zones, que le logement est desservi par plusieurs
// groupes — sans quoi un client qui tourne la page tomberait sur un second « Ce qui a été
// mesuré » sans comprendre pourquoi le document recommence.
export function gabaritClientChantier(clientName, fiches) {
    if (!fiches || fiches.length === 0) return '';
    const multi = fiches.length > 1;
    return `
    ${enTeteChantier(clientName, fiches, 'Étude de dimensionnement')}
    <p class="pf-chapo pf-prose">Cette étude calcule, pièce par pièce, la puissance nécessaire pour
        chauffer et rafraîchir votre logement dans les conditions climatiques de votre commune.
        ${multi ? `Le logement est desservi par ${fiches.length} groupes distincts, un par zone : chacune
        est détaillée séparément dans les pages qui suivent.` : ''}
        Elle sert à choisir un matériel à la bonne taille : une machine trop petite ne tient pas
        les températures, une machine trop grande fonctionne par à-coups et s'use plus vite.</p>
    ${fiches.map((fiche, i) => `
    <section class="pf-zone${i > 0 ? ' pf-saut' : ''}">
        ${bandeauZone(fiche, i, fiches.length)}
        ${avertissementOrigine(fiche)}
        ${bandeau('Ce qui a été mesuré')}
        ${blocHypotheses(fiche, { complet: false })}
        ${bandeau('Pièce par pièce')}
        ${legendePostes({ avecExplication: true })}
        ${fiche.pieces.map(p => blocPiece(fiche, p, { technique: false, echelle: echelleRoomsFiche(fiche) })).join('')}
        ${blocBilan(fiche)}
        ${blocCouvertureGroupe(fiche)}
        ${blocMateriel(fiche, { technique: false })}
        ${blocCorrections(fiche, { avecDetail: true, titre: 'Pourquoi la machine dépasse le besoin calculé' })}
    </section>`).join('')}
    ${piedDePage(fiches[0])}`;
}

// --- Partage texte -------------------------------------------------------------------------
// Web Share API / mailto : le même modèle, réduit à ce qui survit à un corps de message.
export function lignesPartage(fiche) {
    if (!fiche) return [];
    const id = fiche.identite || {};
    const lignes = [
        'Klimo — Fiche de dimensionnement',
        id.installateur ? `Installateur : ${id.installateur}` : null,
        id.client ? `Client : ${id.client}` : null,
        id.zone ? `Zone : ${id.zone}` : null,
        `${id.modeLabel || ''}${id.brandLabel ? ` — ${id.brandLabel}` : ''}`,
        '',
        'Bilan par pièce :'
    ];
    fiche.pieces.forEach(p => {
        lignes.push(`- ${p.nom ? `${p.index} ${p.nom}` : `Pièce ${p.index}`} · ${nb(p.surface, 0)} m² : `
            + `${nb(p.req.froid, 2)} kW froid / ${nb(p.req.chaud, 2)} kW chaud`
            + ` → ${p.taille ? `taille ${p.taille}` : 'hors catalogue'}`);
    });
    lignes.push('', `Cumul : ${nb(fiche.bilan.froid, 2)} kW froid / ${nb(fiche.bilan.chaud, 2)} kW chaud`);

    const m = fiche.materiel;
    if (m) {
        lignes.push('', 'Matériel retenu :');
        if (m.groupe) lignes.push(`- Groupe ${m.groupe.reference} (${nb(m.groupe.froidKw, 2)} kW froid) — ${libelleTva(m.groupe.tva)}`);
        m.unites.forEach(u => lignes.push(`- Pièce ${u.piece} : ${u.gamme || '—'} taille ${u.taille ?? '—'}`));
        m.monos.forEach(x => lignes.push(`- ${x.nom ? `${x.piece} ${x.nom}` : `Pièce ${x.piece}`} : ${x.gamme || ''} ${x.reference || ''} — ${libelleTva(x.tva)}`));
    } else if ((fiche.equipementsEnregistres || []).length > 0) {
        lignes.push('', 'Matériel retenu :');
        fiche.equipementsEnregistres.forEach(e => lignes.push(`- ${e}`));
    }
    return lignes.filter(l => l !== null);
}

// Réexporté pour que les tests et app.js parlent des mêmes coefficients que la sélection.
export { COEF_FOISONNEMENT_FROID, COEF_FOISONNEMENT_CHAUD };
