// Application Klimo : état, rendu DOM et gestionnaires d'événements.
// Importe les données (data.js) et les fonctions de calcul pures (calcul.js) ; c'est le seul
// module qui touche au DOM, à localStorage ou à l'état applicatif.
import {
    CATALOGS, GAMMES_INFO, TVA_RULES, DEPARTMENTS, tBaseMatrix, tBaseEteMatrix,
    BRAND_LABELS, CONSIGNE_REFERENCE, COEF_FOISONNEMENT_FROID, COEF_FOISONNEMENT_CHAUD,
    SEUIL_SOUS_CHARGE, SEUIL_DESEQUILIBRE_GROUPE, TVA_DATE_VERIFICATION
} from './data.js';
import {
    occupantsParDefaut, resolveCoefG, getFacteurCanicule, getFacteurDeclassementChaud,
    estimerEcartConsigne, getRequiredKw as getRequiredKwCore, getUiSizeForKw, findBestMonos, findRoomMultiSolutions,
    findMultiGroup, findMultiGroupOptions, getRoomEligibleGammes, getTvaInfo, getRoomSelectedTvaInfo,
    getGroupTvaInfo, trierMonosParTva, parseNombreSaisi,
    findGroupeEquilibre, estGroupeDesequilibre, ratioPieceDominante, pieceDominantePourGroupe,
    tauxChargeGroupe
} from './calcul.js';
import {
    sauvegardeValide, construireSauvegarde, compterChantiers
} from './sauvegarde.js';
import {
    construireFiche, assainirFiche, ficheDepuisBody, lignesTableauFiche,
    gabaritTravail, gabaritClient, lignesPartage
} from './fiche.js';
import {
    MARQUES_ACTIVES, MARQUES_CONNUES, marqueAutorisee, marqueParDefaut, resoudreMarque, libelleMarque,
    selecteurMarqueVisible
} from './marques.js';
import { store } from './store.js';
import { init as initAccount, subscribe as subscribeAccount, getBrandsOverride, getStatus as getAuthStatus } from './account.js';
import { initAuthUi } from './auth-ui.js';
import { createSync } from './sync.js';

// --- STATE ---
let state = {
    brand: 'toshiba',
    mode: 'mono',
    // 'reversible' (défaut) : sélection du matériel sur le besoin froid ET chaud.
    // 'froid_seul' : le besoin chaud n'entre plus dans le dimensionnement (mais reste affiché à
    // titre indicatif) — permet de proposer une solution quand seul le chaud dépasse le catalogue.
    usage: 'reversible',
    // isolationCoef: '' → la pièce hérite du niveau d'isolation du bâtiment (le sélecteur global,
    // cas de loin le plus courant) ; une valeur ('2.0'…'0.25' ou 'custom' + customCoefG) surcharge
    // ce niveau pour CETTE pièce seule — voir getRoomCoefG. Cas visé : véranda accolée au salon,
    // dont l'enveloppe n'a rien à voir avec le reste de la maison.
    rooms: [{ id: 1, nom: '', surface: '', height: 2.5, emplacement: 'plain_pied', orientation: 'mixte', vitrage: 'moyen', protection: 'stores_int', occupants: '', expositionMurs: 4, isolationCoef: '', customCoefG: '' }],
    lastResultData: null,
    currentCalc: null,
    // Solution choisie par l'utilisateur parmi les options proposées (mono / dédiés multi / gammes UI du groupe / groupe extérieur)
    selection: { mono: 0, dedicated: {}, group: {}, groupChoice: 0 },
    // Ids de pièces que l'utilisateur a choisi de séparer du groupe multisplit en monosplit
    // dédié (voir separerPieceEnDedie) — PAS remis à zéro par calculate() comme state.selection,
    // sinon le choix ne survivrait pas au recalcul qu'il déclenche lui-même. Remis à zéro
    // explicitement à chaque saisie réellement nouvelle (startNewCalcul, reloadConfig, setMode).
    forcedDedicatedIds: new Set(),
    // Identifiant du chantier sauvegardé actuellement chargé (via reloadConfig), ou null pour
    // une saisie neuve. Permet de proposer une mise à jour en place plutôt qu'un doublon
    // systématique. Remis à null par calculate() ; posé par reloadConfig() une fois le calcul
    // relancé, pour ne pas être écrasé par cette remise à zéro.
    loadedConfigId: null
};

// Résout la liste de marques effective : la surcharge du compte connecté si elle existe,
// sinon la constante locale de js/marques.js. `getBrandsOverride()` renvoie `null` pour un
// appareil jamais connecté — comportement inchangé par rapport au lot précédent, aucun
// utilisateur local existant n'est cassé par l'arrivée des comptes.
function marquesActives() {
    return getBrandsOverride() || MARQUES_ACTIVES;
}

// Identifiants de pièce : compteur monotone, et non Date.now().
//
// Date.now() a une résolution d'une milliseconde : deux pièces créées dans la même milliseconde
// — un double tap sur « Ajouter une pièce », ou un appel programmatique — recevaient le MÊME
// identifiant. removeRoom filtre sur cet identifiant : supprimer l'une supprimait alors les deux
// d'un coup, sans avertissement et sans annulation possible. duplicateRoom était le chemin le
// plus exposé, la duplication suivant immédiatement le clic d'origine.
//
// Démarre à 2 : la pièce initiale de `state` porte l'identifiant 1 en dur (elle est déclarée
// avant ce compteur, donc ne peut pas l'appeler).
let prochainRoomId = 2;
function nouvelIdPiece() { return prochainRoomId++; }

// Après restauration d'un brouillon ou d'un chantier, le compteur doit repartir au-dessus du plus
// grand identifiant déjà présent — sinon la prochaine pièce ajoutée entrerait en collision avec
// une pièce restaurée. Couvre aussi les anciens identifiants issus de Date.now(), qui sont
// simplement de très grands entiers.
function reserverIdsPieces(rooms) {
    const maxExistant = (rooms || []).reduce((max, r) => Math.max(max, Number(r.id) || 0), 0);
    prochainRoomId = Math.max(prochainRoomId, maxExistant + 1);
}

function defaultRoom(id) {
    return { id, nom: '', surface: '', height: 2.5, emplacement: 'plain_pied', orientation: 'mixte', vitrage: 'moyen', protection: 'stores_int', occupants: '', expositionMurs: 4, isolationCoef: '', customCoefG: '' };
}

// Les boutons de marque sont retrouvés par leur attribut `data-brand` et non par un id en
// dur : une marque masquée (bouton absent du DOM) doit laisser cette fonction intacte,
// alors qu'un getElementById manquant la faisait planter sur un `null`.
function setBrand(brand) {
    // Garde unique : couvre du même coup les deux chemins de restauration (chantier
    // sauvegardé et brouillon), qui passaient jusqu'ici la marque enregistrée sans la
    // valider et pouvaient ainsi ressusciter une marque masquée. Passe par marquesActives()
    // pour tenir compte des droits du compte connecté, s'il y en a un.
    const actives = marquesActives();
    brand = resoudreMarque(brand, actives);
    state.brand = brand;
    // L'accent visuel est celui de Klimo, fixe, jamais celui du constructeur choisi (voir
    // --brand-accent dans index.html) : l'app doit rester identifiable comme l'outil de
    // l'installateur, pas comme le configurateur d'un fabricant.
    //
    // L'état sélectionné passe par `aria-pressed` et non par une réécriture de className :
    // le style vit dans .k-seg-item[aria-pressed="true"] (build/input.css), et l'état est du
    // même coup annoncé aux lecteurs d'écran, ce que la seule couleur de fond ne faisait pas.
    // C'est aussi ce qui règle le piège documenté ici auparavant : `className` réécrit en entier
    // devait reporter lui-même la classe `hidden`, faute de quoi un bouton masqué par
    // initSelecteurMarque() (marque non autorisée pour ce compte) se retrouvait démasqué au
    // premier setBrand() suivant. `classList.toggle` ne touche plus qu'à ce qu'il vise.
    document.querySelectorAll('[data-brand]').forEach((btn) => {
        btn.setAttribute('aria-pressed', String(btn.dataset.brand === brand));
        btn.classList.toggle('hidden', !actives.includes(btn.dataset.brand));
    });
    // Marque plutôt qu'efface (voir marquerResultatsObsoletes) : changer de marque en cours de
    // saisie ne doit pas faire disparaître un calcul affiché, exactement comme changer de
    // département ne le fait pas. Sans effet quand aucun calcul n'est affiché (garde interne),
    // et sans effet visible dans les chemins de restauration (reloadConfig, restoreDraftIfAny),
    // qui appellent calculate() juste après et écrasent de toute façon le rendu avant peinture.
    marquerResultatsObsoletes();
}

function initApp() {
    // Avant tout rendu : charge le magasin, migrant depuis l'ancien stockage si besoin (voir
    // js/store.js). Purement local et hors-ligne — aucune raison que ça échoue sans réseau.
    store.init();
    // Restaure la session depuis le cache local (aucun réseau ici), puis vérifie en
    // arrière-plan sans jamais bloquer ce premier rendu — voir js/account.js. Les données
    // locales s'affichent avant même de savoir quoi que ce soit de l'authentification.
    initAccount();

    const deptSelect = document.getElementById('deptSelect');
    const dernierDept = getDernierDept();
    Object.keys(DEPARTMENTS).sort().forEach(code => {
        const opt = document.createElement('option');
        opt.value = code;
        opt.textContent = `${code} - ${DEPARTMENTS[code].name}`;
        if (code === dernierDept) opt.selected = true;
        deptSelect.appendChild(opt);
    });
    updateClimateInfo();
    genererBoutonsMarque();
    initSelecteurMarque();
    renderRooms();
    viderResultats();
    initDashboardEvents();
    initAuthUi();
    subscribeAccount(onAccountChange);
    restoreDraftIfAny();

    // Déclencheurs de synchronisation. Chacun sort immédiatement si aucun compte n'est en
    // jeu (voir planifierSync) — un utilisateur en mode local n'émet jamais de requête.
    renderSyncBadge();
    planifierSync();
    window.addEventListener('online', planifierSync);
    // Retour au premier plan : le cas le plus fréquent sur mobile, où l'onglet est gelé
    // pendant des heures puis rouvert sur le chantier suivant.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') planifierSync();
    });
}

// Rejoue le sélecteur de marque quand l'état du compte change (connexion, déconnexion,
// droits rafraîchis). Sans effet si un calcul est déjà en cours à l'écran : initSelecteurMarque
// appelle setBrand(), qui efface les résultats affichés — se connecter en cours de saisie ne
// doit pas faire disparaître un travail non enregistré. La mise à jour s'applique au
// prochain calcul ou au prochain chargement.
function onAccountChange() {
    if (!state.currentCalc) initSelecteurMarque();
    planifierSync();
}

// --- SYNCHRONISATION ---------------------------------------------------------------
// Construite paresseusement : tant que personne ne s'est connecté, aucun module réseau
// n'est chargé et aucune requête n'est émise — l'application reste exactement aussi
// hors-ligne qu'avant l'arrivée des comptes.
let sync = null;
let syncPrete = null;

async function obtenirSync() {
    if (sync) return sync;
    if (!syncPrete) {
        syncPrete = (async () => {
            const { createSupabaseTransport } = await import('./supabase-client.js');
            sync = createSync({ store, transport: createSupabaseTransport() });
            sync.subscribe(renderSyncBadge);
            return sync;
        })();
    }
    return syncPrete;
}

// Ne synchronise que si un compte est réellement en jeu. Un utilisateur en mode local pur
// n'émet jamais rien : la synchro est un service rendu au compte, pas une condition d'usage.
async function planifierSync() {
    const statut = getAuthStatus();
    if (statut !== 'authenticated' && statut !== 'stale') return;
    const s = await obtenirSync();
    await s.run();
    renderSyncBadge();
    renderDashboard();
}

function renderSyncBadge() {
    const badge = document.getElementById('sync-badge');
    if (!badge) return;
    const statut = getAuthStatus();
    if (statut !== 'authenticated' && statut !== 'stale') { badge.classList.add('hidden'); return; }

    const etat = sync ? sync.getState() : { phase: 'idle', pending: 0 };
    const enAttente = etat.pending || 0;
    badge.classList.remove('hidden');

    // Pastilles du système visuel (voir build/input.css) plutôt que des chapelets d'utilitaires
    // recopiés : le badge suit automatiquement toute évolution de .k-pill.
    if (etat.phase === 'pushing' || etat.phase === 'pulling') {
        badge.textContent = 'Synchro…';
        badge.className = 'k-pill k-pill-neutral';
    } else if (etat.phase === 'offline') {
        // Jamais d'invite de connexion ici : hors-ligne est un état de fonctionnement normal,
        // pas une erreur à corriger. On informe, on ne réclame rien.
        badge.textContent = enAttente ? `Hors ligne — ${enAttente} en attente` : 'Hors ligne';
        badge.className = 'k-pill k-pill-warn';
    } else if (enAttente) {
        badge.textContent = `${enAttente} en attente`;
        badge.className = 'k-pill k-pill-warn';
    } else {
        badge.textContent = 'À jour';
        badge.className = 'k-pill k-pill-ok';
    }
}

// Génère un bouton par marque CONNUE du catalogue (MARQUES_CONNUES, js/marques.js) — pas
// seulement les marques actives : initSelecteurMarque() masque ensuite celles non autorisées
// pour ce compte, exactement comme avant, mais sans plus exiger qu'un bouton soit écrit à la
// main dans index.html pour chaque nouvelle marque. Ajouter une marque au catalogue lui fait
// donc un bouton automatiquement, actif ou masqué selon les droits.
//
// Idempotent (peut être rejoué sans dupliquer les boutons) : si le catalogue change en cours
// de session (peu probable, mais MARQUES_CONNUES est dérivée d'un import statique, pas d'un
// état mutable), ceci évite un piège silencieux plutôt que de le documenter comme limite.
function genererBoutonsMarque() {
    const container = document.getElementById('brand-buttons');
    if (!container) return;
    container.innerHTML = MARQUES_CONNUES.map(marque => `
        <button type="button" data-brand="${marque}" onclick="setBrand('${marque}')" aria-pressed="false" class="k-seg-item">${escapeHtml(libelleMarque(marque))}</button>
    `).join('');
}

// Masque (sans les retirer du DOM — voir setBrand) les boutons des marques non autorisées,
// et l'ensemble du sélecteur quand il n'en reste qu'une : un choix à une seule option
// n'aide personne. Rejouable sans effet de bord — initApp() comme onAccountChange()
// l'appellent — c'est ce qui permet à la connexion de faire réapparaître une marque en
// cours de session sans redémarrer l'application.
function initSelecteurMarque() {
    const actives = marquesActives();
    document.querySelectorAll('[data-brand]').forEach((btn) => {
        btn.classList.toggle('hidden', !actives.includes(btn.dataset.brand));
    });
    const section = document.getElementById('brand-section');
    if (section) section.classList.toggle('hidden', !selecteurMarqueVisible(actives));

    // Conserve le choix de marque en cours s'il reste valide, plutôt que de forcer la
    // marque par défaut à chaque rafraîchissement.
    setBrand(actives.includes(state.brand) ? state.brand : marqueParDefaut(actives));
}

// --- DASHBOARD & LOCALSTORAGE LOGIC ---
// Ne bascule QUE `hidden`, sans plus ajouter/retirer `flex` : la vue simulateur est désormais
// une grille (`grid` + `xl:grid-cols-...`, voir index.html) et non plus une colonne flex. Poser
// `flex` par-dessus `grid` laissait deux utilitaires de display en concurrence sur le même
// élément, départagés par leur ordre dans la feuille Tailwind — un détail d'implémentation
// qu'aucun test ne couvre et qui aurait cassé la mise en page à la première régénération du CSS.
function toggleDashboard(show) {
    document.getElementById('app-main').classList.toggle('hidden', show);
    document.getElementById('app-dashboard').classList.toggle('hidden', !show);
    if (show) renderDashboard();
}

// --- ICONOGRAPHIE ---
// Jeu d'icônes filaires de l'interface : un seul tracé (1.75px, bouts arrondis), monochrome,
// héritant de la couleur du texte parent.
//
// Ce sont les emojis qui tenaient ce rôle (☀️ 🥶 ❄️ ⚡ ✅ ⚠️ 📝 💾 📂 🖨️ 📤). Chacun apportait
// son propre style de dessin, sa propre palette et son propre rendu selon la plateforme — un
// soleil plat et orange à côté d'un visage bleu en volume à côté d'un triangle jaune vif —,
// si bien que trois blocs voisins semblaient empruntés à trois interfaces différentes. Sur une
// fiche que l'artisan montre au client, ça se remarque.
const ICONES = {
    soleil:   '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.5 1.5m11.2 11.2 1.5 1.5M2 12h2m16 0h2M4.9 19.1l1.5-1.5m11.2-11.2 1.5-1.5"/>',
    flocon:   '<path d="M12 2v20M4.2 7l15.6 10M4.2 17 19.8 7"/><path d="M12 6.5 9.8 4.3M12 6.5l2.2-2.2M12 17.5l-2.2 2.2M12 17.5l2.2 2.2"/>',
    alerte:   '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4m0 4h.01"/>',
    check:    '<path d="M20 6 9 17l-5-5"/>',
    checkRond:'<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
    info:     '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4.5M12 8h.01"/>',
    scinder:  '<path d="M3 6h5l4 6 4-6h5M3 18h5l4-6"/>',
    document: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    moins:    '<path d="M5 12h14"/>',
    chevron:  '<path d="m6 9 6 6 6-6"/>'
};

function icone(nom, classes = 'w-4 h-4') {
    return `<svg class="${classes} flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONES[nom] || ''}</svg>`;
}

// Couleur de l'icône par tonalité — la note elle-même reste sur surface neutre (voir .k-note
// dans build/input.css). `alert` réserve le fond teinté à ce qui doit interrompre.
const TON_ICONE = {
    info:    'text-froid-600',
    ok:      'text-emerald-600',
    warn:    'text-amber-600',
    danger:  'text-rose-600',
    neutral: 'text-ink-400'
};

// Encart d'information (climat, arbitrage, impasse…). `ton` : clé de TON_ICONE, éventuellement
// suffixée de ' alert' pour les cas qui doivent interrompre. `corps` est du HTML déjà sûr
// (texte de l'application) — tout ce qui vient de l'utilisateur passe par escapeHtml en amont.
function note(ton, nomIcone, corps, { alerte = false } = {}) {
    const classeAlerte = alerte ? ` k-note-alert k-note-alert-${ton === 'danger' ? 'danger' : 'warn'}` : '';
    const couleur = alerte ? '' : ` ${TON_ICONE[ton] || TON_ICONE.neutral}`;
    return `<div class="k-note${classeAlerte} fade-in">${nomIcone ? `<span class="k-note-icon${couleur}">${icone(nomIcone)}</span>` : ''}<div class="min-w-0">${corps}</div></div>`;
}

// Échappe une valeur avant insertion dans du innerHTML (noms de clients / zones saisis
// librement par l'utilisateur : apostrophes, accents, voire balises).
function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// Nombres à la française. L'application acceptait déjà la virgule en SAISIE
// (parseNombreSaisi, calcul.js) mais écrivait le point en SORTIE : « 2.19 kW »
// sur un outil francophone destiné à des artisans français. Décimales fixes au
// passage, pour que les puissances s'alignent réellement en colonne — le
// catalogue donne 4 là où la ligne d'à côté donne 3.5, et « 4 kW » face à
// « 3,5 kW » casse la comparaison que l'œil fait verticalement.
function nb(valeur, decimales = 1) {
    const n = Number(valeur);
    if (!Number.isFinite(n)) return '—';
    return n.toFixed(decimales).replace('.', ',');
}

// Groupe une liste de configurations (déjà triées par le magasin, savedAt décroissant) par
// client, en préservant l'ordre de première apparition — donc les clients les plus récemment
// actifs en tête, sans logique de tri séparée à maintenir ici.
function grouperParClient(configs) {
    const index = new Map();
    const groupes = [];
    configs.forEach((cfg) => {
        if (!index.has(cfg.clientName)) {
            index.set(cfg.clientName, groupes.length);
            groupes.push({ clientName: cfg.clientName, configs: [] });
        }
        groupes[index.get(cfg.clientName)].configs.push(cfg);
    });
    return groupes;
}

// Hypothèses de calcul d'une fiche enregistrée, en pastilles. Ces valeurs étaient persistées
// depuis l'origine (body.params) sans jamais être affichées : une fiche qu'on relit six mois
// plus tard ne disait pas avec quel climat ni quelle isolation elle avait été calculée.
function renderHypothesesPills(h) {
    if (!h) return '';
    // Number.isFinite(Number(null)) vaut true (Number(null) === 0) : une hypothèse absente doit
    // être écartée avant conversion, sinon elle s'affiche en « 0 °C » — une mesure inventée.
    const mesure = (x) => x !== null && x !== undefined && x !== '' && Number.isFinite(Number(x));
    const pills = [
        h.dept ? `${h.dept} ${h.deptNom || ''}`.trim() + (h.altitude ? ` · ${h.altitude}` : '') : null,
        h.zone && mesure(h.tBaseHiver) && mesure(h.tBaseEte) ? `Zone ${h.zone} · ${nb(h.tBaseHiver, 0)} °C / ${nb(h.tBaseEte, 0)} °C` : null,
        mesure(h.coefG) ? `G ${nb(h.coefG, 2)}` : null,
        mesure(h.consigne) ? `Consigne ${nb(h.consigne, 0)} °C` : null
    ].filter(Boolean);
    if (pills.length === 0) return '';
    return `<div class="flex flex-wrap items-center gap-1.5 mt-2">
        ${pills.map(p => `<span class="k-pill k-pill-neutral">${escapeHtml(p)}</span>`).join('')}
    </div>`;
}

// Le bilan par pièce, visible sans déplier. Rôles ARIA explicites : c'est une grille CSS et
// non un <table> (voir .k-fiche-tab dans build/input.css pour ce que ça résout sur téléphone),
// donc la sémantique de tableau doit être portée par le balisage.
function renderTableauPieces(t) {
    const cellule = (valeur, libelle, classe = '') =>
        `<span class="k-fiche-num ${classe}" data-l="${libelle}" role="cell">${valeur}</span>`;

    const lignes = t.pieces.map(p => `
        <div class="k-fiche-row" role="row">
            <span class="k-fiche-nom" role="cell">${escapeHtml(p.libelle)}</span>
            ${cellule(nb(p.surface, 0), 'm²')}
            ${cellule(nb(p.froid, 2), 'F', 'k-fiche-f')}
            ${cellule(nb(p.chaud, 2), 'C', 'k-fiche-c')}
            ${p.horsCatalogue
                ? cellule('hors cat.', 'UI', 'k-fiche-hors')
                : cellule(escapeHtml(String(p.taille)), 'UI')}
        </div>`).join('');

    // Ligne de total omise sur une pièce unique : elle répéterait la ligne au-dessus.
    const total = t.pieces.length > 1 ? `
        <div class="k-fiche-row k-fiche-total" role="row">
            <span class="k-fiche-nom" role="cell">Total ${t.pieces.length} pièces</span>
            ${cellule(nb(t.total.surface, 0), 'm²')}
            ${cellule(nb(t.total.froid, 2), 'F', 'k-fiche-f')}
            ${cellule(nb(t.total.chaud, 2), 'C', 'k-fiche-c')}
            <span class="k-fiche-num" role="cell"></span>
        </div>` : '';

    return `
    <div class="k-fiche-tab" role="table" aria-label="Bilan par pièce">
        <div class="k-fiche-head" role="row">
            <span role="columnheader">Pièce</span>
            <span role="columnheader">Surface</span>
            <span role="columnheader">Froid</span>
            <span role="columnheader">Chaud</span>
            <span role="columnheader">Unité</span>
        </div>
        ${lignes}${total}
    </div>
    ${t.recalculee ? `<p class="k-hint mt-1.5">Bilan reconstitué à partir des paramètres enregistrés.</p>` : ''}`;
}

function renderDashboard() {
    const list = document.getElementById('chantiers-list');
    const degrade = store.isDegraded();

    // Un stockage illisible affichait auparavant « Aucun chantier enregistré » : le message
    // le plus rassurant possible au pire moment. On dit ce qui se passe, et on annonce que
    // rien ne sera écrit tant que la situation dure.
    if (degrade) {
        list.innerHTML = note('danger', 'alerte', `
            <span class="k-note-title block mb-1">Chantiers illisibles sur cet appareil</span>
            <p>
                ${degrade === 'illisible'
                    ? "Le navigateur refuse l'accès au stockage local (navigation privée, ou espace saturé)."
                    : "Les données enregistrées sont corrompues et n'ont pas pu être relues."}
                Vos chantiers ne sont <b class="font-semibold">pas perdus pour autant</b> : par précaution,
                l'application n'écrira plus rien tant que ce message est affiché, afin de ne pas
                remplacer la sauvegarde existante.
            </p>
            <p class="mt-2">
                Essayez de rouvrir l'application dans une fenêtre normale (hors navigation privée),
                ou restaurez une sauvegarde avec le bouton ci-dessus.
            </p>`);
        return;
    }

    const groupes = grouperParClient(store.listConfigs());
    const conflits = store.listConflicts();

    if (groupes.length === 0 && conflits.length === 0) {
        list.innerHTML = `
        <div class="rounded-2xl border-2 border-dashed border-line bg-white/60 px-5 py-12 text-center">
            <div class="w-12 h-12 mx-auto mb-3 rounded-2xl bg-mute-100 text-ink-400 flex items-center justify-center">
                <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"></path></svg>
            </div>
            <p class="text-sm font-semibold text-ink-700">Aucun chantier enregistré</p>
            <p class="k-hint mt-1 max-w-xs mx-auto">Après un calcul, « Enregistrer au chantier » classe la fiche par client et par zone — elle se retrouvera ici.</p>
        </div>`;
        return;
    }

    let html = '';

    // Versions rétrogradées par la synchronisation : une modification faite ici a été
    // devancée par un autre appareil. Rien n'est jamais jeté — c'est ce qui rend le
    // dernier-écrit-gagne acceptable ; l'utilisateur arbitre lui-même.
    if (conflits.length > 0) {
        html += `
        <div class="rounded-2xl border border-amber-200 bg-amber-50 p-4 sm:p-5 fade-in">
            <h3 class="text-sm font-semibold text-amber-900 mb-1">${conflits.length} version(s) à arbitrer</h3>
            <p class="text-xs text-amber-900/80 mb-3 leading-relaxed">
                Ces modifications ont été faites sur cet appareil, mais un autre appareil avait
                déjà enregistré une version plus récente. Rien n'est perdu : récupérez-les comme
                fiches distinctes, ou écartez-les si elles ne servent plus.
            </p>
            <div class="flex flex-col gap-2">
                ${conflits.map((c) => `
                <div class="bg-white border border-amber-200 rounded-xl p-3 flex items-center justify-between gap-3 flex-wrap">
                    <div class="text-xs min-w-0">
                        <span class="font-semibold text-ink-900">${escapeHtml(c.clientName)}</span>
                        <span class="text-ink-500"> — ${escapeHtml(c.zone)}</span>
                    </div>
                    <div class="flex gap-2 flex-shrink-0">
                        <button data-action="restore-conflict" data-id="${escapeHtml(c.id)}" class="k-btn min-h-[44px] px-3 text-2xs bg-amber-600 text-white hover:bg-amber-700">Récupérer</button>
                        <button data-action="dismiss-conflict" data-id="${escapeHtml(c.id)}" class="k-btn-ghost min-h-[44px] text-2xs">Écarter</button>
                    </div>
                </div>`).join('')}
            </div>
        </div>`;
    }
    groupes.forEach(({ clientName, configs }) => {
        let configsHtml = configs.map((cfg) => {
            const eqs = cfg.equipments || [];
            const rds = cfg.roomDetails || [];
            // Enregistré sous une marque qui n'est plus proposée : consultable, mais pas
            // rechargeable — le recalcul porterait sur un autre catalogue (cf. reloadConfig).
            const marqueRetiree = cfg.brand && !marqueAutorisee(cfg.brand, marquesActives());

            // Bilan structuré de la fiche, en trois paliers (voir ficheDepuisBody, js/fiche.js) :
            // enregistré tel quel, reconstitué depuis les paramètres, ou indisponible.
            const { fiche, palier } = ficheDepuisBody(cfg);
            const tableau = fiche ? lignesTableauFiche(fiche) : null;

            // Le matériel reste replié : c'est la seule partie que `resultStr`, juste au-dessus,
            // résume déjà fidèlement. Le bilan par pièce, lui, n'était visible nulle part.
            let detailsHtml = '';
            if (eqs.length > 0 || (!tableau && rds.length > 0)) {
                detailsHtml = `
                <details class="mt-2.5 group">
                    <summary class="k-disclosure text-2xs">
                        <span>Détail des unités${tableau ? '' : ' et des pièces'}</span>
                        <span class="text-ink-400 transition-transform group-open:rotate-180">${icone('chevron', 'w-3.5 h-3.5')}</span>
                    </summary>
                    <div class="mt-2 rounded-xl border border-line bg-white p-3 text-2xs text-ink-700 flex flex-col gap-2.5 leading-relaxed">
                        ${eqs.length > 0 ? `<div><div class="k-eyebrow mb-1">Matériel proposé</div>${eqs.map(e => `<div class="text-ink-900">• ${escapeHtml(e)}</div>`).join('')}</div>` : ''}
                        ${!tableau && rds.length > 0 ? `<div><div class="k-eyebrow mb-1">Bilan par pièce</div>${rds.map(r => `<div>• ${escapeHtml(r)}</div>`).join('')}</div>` : ''}
                    </div>
                </details>`;
            }

            return `
            <div class="flex items-start justify-between gap-2 py-3.5 border-b border-line last:border-0">
                <div class="min-w-0 flex-grow">
                    <div class="flex flex-wrap items-center gap-2 mb-1">
                        <span class="font-semibold text-sm text-ink-900">${escapeHtml(cfg.zone)}</span>
                        <span class="k-pill k-pill-neutral">${escapeHtml(cfg.mode)}</span>
                        ${marqueRetiree ? `<span class="k-pill k-pill-warn" title="Marque plus proposée sur ce poste : fiche consultable, non rechargeable">${escapeHtml(libelleMarque(cfg.brand))} — archivé</span>` : ''}
                        ${palier === 3 ? `<span class="k-pill k-pill-warn" title="Fiche enregistrée avant que le détail des calculs ne soit conservé">fiche ancienne</span>` : ''}
                    </div>
                    <p class="text-xs font-medium text-accent-700">${escapeHtml(cfg.resultStr)}</p>
                    ${fiche ? renderHypothesesPills(fiche.hypotheses) : ''}
                    ${tableau ? renderTableauPieces(tableau) : ''}
                    ${detailsHtml}
                    <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 mt-2.5">
                        <span class="text-2xs text-ink-400 k-num">${escapeHtml(cfg.date)}</span>
                        <button data-action="pdf-travail" data-id="${escapeHtml(cfg.id)}" class="k-btn-ghost text-2xs">Fiche de travail</button>
                        ${palier === 3 ? '' : `<button data-action="pdf-client" data-id="${escapeHtml(cfg.id)}" class="k-btn-ghost text-2xs">Rapport client</button>`}
                    </div>
                </div>
                <div class="flex items-center gap-0.5 flex-shrink-0">
                    ${marqueRetiree ? '' : `<button data-action="reload-config" data-id="${escapeHtml(cfg.id)}" title="Recharger cette configuration pour la modifier" aria-label="Recharger cette configuration" class="k-icon-btn hover:text-accent-700 hover:bg-accent-50"><svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg></button>`}
                    <button data-action="delete-config" data-id="${escapeHtml(cfg.id)}" title="Supprimer cette zone" aria-label="Supprimer cette zone" class="k-icon-btn-danger"><svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg></button>
                </div>
            </div>
        `}).join('');

        html += `
        <div class="k-card fade-in">
            <div class="flex items-center justify-between gap-3 mb-1">
                <h3 class="flex items-center gap-2 text-base font-semibold text-ink-900 min-w-0">
                    <svg class="w-5 h-5 text-ink-400 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true"><path fill-rule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clip-rule="evenodd"></path></svg>
                    <span class="truncate">${escapeHtml(clientName)}</span>
                </h3>
                <button data-action="delete-chantier" data-client="${escapeHtml(clientName)}" class="k-btn min-h-[44px] px-3 text-2xs text-rose-600 border border-rose-200 hover:bg-rose-600 hover:text-white hover:border-rose-600 flex-shrink-0">Tout supprimer</button>
            </div>
            ${configsHtml}
        </div>`;
    });
    list.innerHTML = html;
}

// Délégation d'événements sur le conteneur du dashboard : évite d'injecter les noms de
// client (saisie libre, peut contenir apostrophes/guillemets) dans des attributs onclick.
function initDashboardEvents() {
    document.getElementById('chantiers-list').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        if (btn.dataset.action === 'delete-chantier') deleteChantier(btn.dataset.client);
        else if (btn.dataset.action === 'delete-config') deleteConfig(btn.dataset.id);
        else if (btn.dataset.action === 'reload-config') reloadConfig(btn.dataset.id);
        else if (btn.dataset.action === 'pdf-travail') exporterFicheEnregistree(btn.dataset.id, 'travail');
        else if (btn.dataset.action === 'pdf-client') exporterFicheEnregistree(btn.dataset.id, 'client');
        else if (btn.dataset.action === 'restore-conflict') {
            store.restoreConflict(btn.dataset.id);
            renderDashboard();
            planifierSync();
        } else if (btn.dataset.action === 'dismiss-conflict') {
            store.dismissConflict(btn.dataset.id);
            renderDashboard();
        }
    });

    // Sauvegarde / restauration : même délégation, hors de la liste puisque ces boutons
    // survivent aux reconstructions de #chantiers-list.
    document.getElementById('dashboard-actions').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        if (btn.dataset.action === 'export-chantiers') exportChantiers();
        else if (btn.dataset.action === 'import-chantiers') document.getElementById('import-file').click();
    });
    document.getElementById('import-file').addEventListener('change', importChantiers);
}

// --- SAUVEGARDE / RESTAURATION DE FICHIER ---
// Tant que les chantiers ne vivent que dans le localStorage d'un appareil, un cache vidé
// ou une tablette changée les emporte entièrement. Ces deux boutons sont le seul filet
// avant la synchronisation, et ils ne dépendent d'aucune infrastructure.
// La logique pure (validation, fusion, déduplication) vit dans js/sauvegarde.js.

function afficherMessageSauvegarde(texte, succes) {
    const box = document.getElementById('backup-msg');
    if (!box) return;
    box.textContent = texte;
    box.className = `text-xs font-semibold ${succes ? 'text-emerald-700' : 'text-rose-600'}`;
}

function exportChantiers() {
    if (store.isDegraded()) {
        afficherMessageSauvegarde("Chantiers illisibles : sauvegarde impossible depuis cet appareil.", false);
        return;
    }
    const blob = store.exportLegacyBlob();
    const nbClients = Object.keys(blob).length;
    if (nbClients === 0) {
        afficherMessageSauvegarde("Aucun chantier à sauvegarder pour le moment.", false);
        return;
    }

    const contenu = JSON.stringify(construireSauvegarde(blob, new Date()), null, 2);
    const url = URL.createObjectURL(new Blob([contenu], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `chantiers-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    const { configs } = compterChantiers(blob);
    afficherMessageSauvegarde(`${nbClients} client(s), ${configs} zone(s) sauvegardés dans un fichier.`, true);
}

async function importChantiers(event) {
    const input = event.target;
    const fichier = input.files && input.files[0];
    if (!fichier) return;
    input.value = '';   // permet de réimporter le même fichier ensuite

    let charge;
    try {
        charge = JSON.parse(await fichier.text());
    } catch (e) {
        afficherMessageSauvegarde("Fichier illisible : ce n'est pas un fichier de sauvegarde valide.", false);
        return;
    }
    if (!sauvegardeValide(charge)) {
        afficherMessageSauvegarde("Ce fichier n'est pas une sauvegarde de chantiers.", false);
        return;
    }
    if (store.isDegraded()) {
        afficherMessageSauvegarde("Chantiers actuels illisibles : restauration refusée pour ne rien écraser.", false);
        return;
    }

    const { ajoutes, ignores } = store.importLegacyBlob(charge.chantiers);
    renderDashboard();
    populateClientDatalist();
    afficherMessageSauvegarde(
        `${ajoutes} zone(s) restaurée(s)` + (ignores ? `, ${ignores} déjà présente(s).` : '.'),
        true
    );
}

function deleteChantier(clientName) {
    if (confirm(`Supprimer définitivement le chantier ${clientName} ?`)) {
        // Le retour de softDeleteByClient était ignoré dans l'ancienne version : un effacement
        // refusé par le stockage se réaffichait comme réussi, jusqu'au prochain rechargement
        // où le chantier « supprimé » réapparaissait.
        if (!store.softDeleteByClient(clientName)) {
            afficherMessageSauvegarde("Suppression impossible : le stockage local est indisponible.", false);
        }
        renderDashboard();
        planifierSync();
    }
}

function deleteConfig(id) {
    const cfg = store.getConfig(id);
    if (cfg && !confirm(`Supprimer définitivement la zone « ${cfg.zone} » ?`)) return;
    if (!store.softDelete(id)) {
        afficherMessageSauvegarde("Suppression impossible : le stockage local est indisponible.", false);
    }
    renderDashboard();
    planifierSync();
}

// Recharge une configuration sauvegardée dans le simulateur pour la modifier : marque,
// paramètres bâtiment, pièces et sélection utilisateur sont restaurés à l'identique, puis
// le calcul est relancé. Avant ce correctif, un chantier n'était consultable qu'en lecture
// seule (texte figé) : toute variante demandée par le client obligeait à tout ressaisir.
function reloadConfig(id) {
    const cfg = store.getConfig(id);
    if (!cfg) return;

    if (cfg.legacyIncomplete) {
        alert("Cette configuration a été enregistrée avec une version antérieure de l'outil et ne contient pas assez d'informations pour être rechargée automatiquement.");
        return;
    }

    // Refus AVANT toute bascule d'écran. Sans ce garde, setBrand ramènerait silencieusement
    // la marque sur celle par défaut, puis calculate() relancerait le dimensionnement
    // contre un AUTRE catalogue et afficherait un matériel différent sous le même intitulé
    // client / zone : un devis faux qui a toutes les apparences du juste.
    if (cfg.brand && !marqueAutorisee(cfg.brand, marquesActives())) {
        alert(`Cette configuration a été enregistrée en ${libelleMarque(cfg.brand)}, marque qui n'est plus proposée sur ce poste.\n\n`
            + `Elle ne peut pas être rechargée : le recalcul porterait sur un autre catalogue et proposerait un matériel différent. `
            + `Le détail reste consultable dans la fiche du chantier.`);
        return;
    }

    toggleDashboard(false);

    setBrand(cfg.brand || marqueParDefaut(marquesActives()));
    applyBuildingParams(cfg.params);

    state.mode = cfg.mode === 'multi' ? 'multi' : 'mono';
    state.usage = cfg.usage === 'froid_seul' ? 'froid_seul' : 'reversible';
    state.rooms = JSON.parse(JSON.stringify(cfg.rooms));
    state.forcedDedicatedIds = new Set(); // ids d'un autre chantier : rien à leur reporter ici.
    reserverIdsPieces(state.rooms);
    updateModeButtons(state.mode);
    updateUsageButtons(state.usage);
    renderRooms();

    calculate();   // remet state.loadedConfigId à null au passage : on le repose donc juste après,
                   // AVANT le second renderResults() ci-dessous, sans quoi le bouton de mise à
                   // jour ne serait pas encore éligible au moment où ce rendu-là a lieu.
    state.loadedConfigId = id;
    if (cfg.selection) {
        state.selection = JSON.parse(JSON.stringify(cfg.selection));
        renderResults();
    }

    const clientEl = document.getElementById('save-client');
    const zoneEl = document.getElementById('save-zone');
    if (clientEl) clientEl.value = cfg.clientName;
    if (zoneEl) zoneEl.value = cfg.zone || '';
}

function populateClientDatalist() {
    const dl = document.getElementById('client-list');
    if (!dl) return;
    dl.innerHTML = store.listClientNames().map(c => `<option value="${escapeHtml(c)}">`).join('');
}

// Paramètres bâtiment courants (isolation, localisation, consigne), lus depuis le DOM.
// Sauvegardés avec chaque configuration de chantier pour la rendre reproductible et
// modifiable plus tard (voir reloadConfig) — auparavant seul le résultat texte était
// conservé, sans savoir avec quelles hypothèses il avait été produit.
function captureBuildingParams() {
    return {
        deptSelect: document.getElementById('deptSelect').value,
        altitude: document.getElementById('altitude').value,
        isolationCoef: document.getElementById('isolationCoef').value,
        customCoef: document.getElementById('customCoef').value,
        consigneInt: document.getElementById('consigneInt').value
    };
}
function applyBuildingParams(params) {
    if (!params) return;
    if (params.deptSelect) document.getElementById('deptSelect').value = params.deptSelect;
    if (params.altitude) document.getElementById('altitude').value = params.altitude;
    if (params.isolationCoef) document.getElementById('isolationCoef').value = params.isolationCoef;
    if (params.customCoef) document.getElementById('customCoef').value = params.customCoef;
    toggleCustomCoef();
    if (params.consigneInt) document.getElementById('consigneInt').value = params.consigneInt;
    updateClimateInfo();
}

// Autosave de la saisie en cours (pas encore enregistrée dans "Mes Chantiers") : un onglet
// mobile tué en arrière-plan, ou un appel qui interrompt la saisie, ne doit pas faire perdre
// 5 pièces déjà remplies. Sauvegarde silencieuse à chaque modification, restaurée au chargement.
const DRAFT_KEY = 'klimo:v2:local:draft';
const DRAFT_KEY_LEGACY = 'toshiba_prosizer_draft';

// Dernier département utilisé : clé SÉPARÉE du brouillon, qui survit à clearDraft() (appelé à
// chaque "Nouveau calcul" et après chaque enregistrement de chantier — donc à chaque parcours
// complet et réussi). Sans elle, "69" par défaut revenait sans arrêt pour un installateur qui
// travaille toujours dans un autre département, à corriger à chaque nouveau calcul.
const LAST_DEPT_KEY = 'klimo:v2:local:lastDept';
function getDernierDept() {
    try { return localStorage.getItem(LAST_DEPT_KEY) || '69'; } catch (e) { return '69'; }
}
function persistDernierDept(code) {
    try { if (code) localStorage.setItem(LAST_DEPT_KEY, code); } catch (e) { /* ignoré */ }
}

// Identité de l'installateur (nom/société/téléphone) : propriété de l'appareil, pas d'un
// chantier précis — clé séparée, jamais effacée par clearDraft() ni par la suppression d'une
// fiche, pour ne pas avoir à la ressaisir à chaque export PDF.
const INSTALLATEUR_KEY = 'klimo:v2:local:installateur';
function getInstallateur() {
    try { return localStorage.getItem(INSTALLATEUR_KEY) || ''; } catch (e) { return ''; }
}
function persistInstallateur(value) {
    try { localStorage.setItem(INSTALLATEUR_KEY, value); } catch (e) { /* ignoré */ }
}

function persistDraft() {
    try {
        const params = captureBuildingParams();
        persistDernierDept(params.deptSelect);
        localStorage.setItem(DRAFT_KEY, JSON.stringify({
            brand: state.brand,
            mode: state.mode,
            usage: state.usage,
            rooms: state.rooms,
            params: params
        }));
    } catch (e) { /* stockage indisponible : tant pis, pas de brouillon */ }
}
function clearDraft() {
    try {
        localStorage.removeItem(DRAFT_KEY);
        localStorage.removeItem(DRAFT_KEY_LEGACY);
    } catch (e) { /* ignoré */ }
}
// Lit la nouvelle clé, et à défaut l'ancienne une seule fois (renommage sans migration
// dédiée : un brouillon est une saisie éphémère non encore validée, la perte d'un brouillon
// en cours dans le pire cas est sans commune mesure avec celle d'un chantier enregistré).
// La prochaine sauvegarde écrit sous la nouvelle clé, achevant la bascule.
function restoreDraftIfAny() {
    let draft;
    try {
        const brut = localStorage.getItem(DRAFT_KEY) || localStorage.getItem(DRAFT_KEY_LEGACY);
        draft = JSON.parse(brut || 'null');
    } catch (e) { return; }
    if (!draft || !draft.rooms || !draft.rooms.length) return;
    // Un brouillon sans la moindre surface saisie n'a rien à restaurer.
    if (!draft.rooms.some(r => r.surface)) return;

    // Contrairement à reloadConfig, on ne bloque jamais la restauration d'un brouillon : c'est
    // une saisie non validée, la perdre serait pire que la recalculer sous une autre marque.
    // Mais setBrand() coercerait silencieusement une marque non autorisée sans qu'on le
    // détecte ici — et si une seule marque est active, la section marque est masquée : rien
    // à l'écran n'indiquerait que la marque a changé sous les pièces déjà saisies. On calcule
    // donc le décalage AVANT setBrand() pour pouvoir le dire dans la bannière.
    const marqueAjustee = draft.brand && !marqueAutorisee(draft.brand, marquesActives());

    setBrand(draft.brand || marqueParDefaut(marquesActives()));
    applyBuildingParams(draft.params);
    state.mode = draft.mode === 'multi' ? 'multi' : 'mono';
    state.usage = draft.usage === 'froid_seul' ? 'froid_seul' : 'reversible';
    state.rooms = draft.rooms;
    reserverIdsPieces(state.rooms);
    updateModeButtons(state.mode);
    updateUsageButtons(state.usage);
    renderRooms();

    const banner = document.getElementById('draft-banner');
    const bannerText = document.getElementById('draft-banner-text');
    if (bannerText) {
        bannerText.textContent = marqueAjustee
            ? `Saisie précédente restaurée — marque ajustée en ${libelleMarque(state.brand)} (${libelleMarque(draft.brand)} n'est plus proposée sur ce poste). Vérifiez le matériel avant d'enregistrer.`
            : 'Saisie précédente restaurée.';
    }
    if (banner) banner.classList.remove('hidden');
}
// Efface le brouillon et repart d'une saisie vierge (bouton de la bannière de reprise).
// Irréversible et sans le moindre "annuler" : la saisie précédente n'est nulle part ailleurs
// une fois clearDraft() passé, d'où la confirmation avant d'agir.
function startNewCalcul() {
    if (!confirm('Repartir d\'une saisie vierge ? La saisie précédente restaurée ci-dessus sera perdue.')) return;
    clearDraft();
    state.rooms = [defaultRoom(nouvelIdPiece())];
    state.forcedDedicatedIds = new Set();
    state.currentCalc = null;
    viderResultats();
    renderRooms();
    const banner = document.getElementById('draft-banner');
    if (banner) banner.classList.add('hidden');
}

// Capture l'état courant du calcul dans la forme que le magasin attend pour `body` — factorisé
// car saveChantier() (toujours un ajout) et updateChantier() (mise à jour explicite) en ont
// besoin à l'identique.
// `v` versionne le CORPS de la fiche, distinct du `schema: 2` du magasin (qui versionne le
// conteneur, voir store.js). Il ne monte que si un champ existant change de sens ou disparaît —
// en ajouter un ne le bouge pas. Aucune lecture ne doit être conditionnée à `v === 2` seul : la
// synchronisation fait circuler des corps entre versions différentes de l'application, et un
// corps écrit par une version plus récente doit continuer à afficher ce qu'il peut.
const VERSION_CORPS = 2;

function captureCorpsChantier() {
    return {
        v: VERSION_CORPS,
        fiche: assainirFiche(ficheCourante()),
        mode: state.mode,
        brand: state.brand,
        usage: state.usage,
        resultStr: state.lastResultData.summaryText,
        equipments: state.lastResultData.equipments,
        roomDetails: state.lastResultData.roomDetails,
        params: captureBuildingParams(),
        rooms: JSON.parse(JSON.stringify(state.rooms)),
        selection: JSON.parse(JSON.stringify(state.selection))
    };
}

// Chemin par défaut, toujours un ajout : un nouveau dimensionnement devient un identifiant
// neuf, qui ne peut structurellement pas entrer en conflit avec un autre appareil. La mise à
// jour en place reste un geste explicite, séparé (voir updateChantier), pour ne jamais
// écraser une fiche par accident.
function saveChantier() {
    const client = document.getElementById('save-client').value.trim();
    const zone = document.getElementById('save-zone').value.trim();
    const msgBox = document.getElementById('save-msg');

    if (!client || !zone) {
        msgBox.innerHTML = "Veuillez remplir le Client et la Zone.";
        msgBox.className = "mt-3 text-xs font-semibold text-center text-rose-600 block";
        return;
    }

    const id = store.saveConfig({ clientName: client, zone, body: captureCorpsChantier() });
    if (id === null) {
        msgBox.innerHTML = "Échec de la sauvegarde (stockage local indisponible ou plein).";
        msgBox.className = "mt-3 text-xs font-semibold text-center text-rose-600 block";
        return;
    }

    clearDraft();
    state.loadedConfigId = null;
    document.getElementById('save-zone').value = '';
    planifierSync();
    msgBox.innerHTML = "Enregistré dans Mes chantiers.";
    msgBox.className = "mt-3 text-xs font-semibold text-center text-emerald-700 block";
    populateClientDatalist();
}

// Met à jour en place la fiche chargée par reloadConfig(), plutôt que d'empiler un doublon.
// N'apparaît dans l'interface que lorsqu'une fiche est effectivement chargée (state.loadedConfigId).
function updateChantier() {
    if (!state.loadedConfigId) return;
    const client = document.getElementById('save-client').value.trim();
    const zone = document.getElementById('save-zone').value.trim();
    const msgBox = document.getElementById('save-msg');

    if (!client || !zone) {
        msgBox.innerHTML = "Veuillez remplir le Client et la Zone.";
        msgBox.className = "mt-3 text-xs font-semibold text-center text-rose-600 block";
        return;
    }

    const ok = store.updateConfig(state.loadedConfigId, { clientName: client, zone, body: captureCorpsChantier() });
    if (!ok) {
        msgBox.innerHTML = "Échec de la mise à jour (stockage local indisponible, ou fiche introuvable).";
        msgBox.className = "mt-3 text-xs font-semibold text-center text-rose-600 block";
        return;
    }

    clearDraft();
    planifierSync();
    msgBox.innerHTML = "Configuration mise à jour.";
    msgBox.className = "mt-3 text-xs font-semibold text-center text-emerald-700 block";
    populateClientDatalist();
}

// Abandonne la fiche chargée sans la modifier : repart sur un enregistrement neuf au prochain
// « Sauvegarder » plutôt que de continuer à proposer une mise à jour.
function oublierConfigChargee() {
    state.loadedConfigId = null;
    renderResults();
}

// --- LECTURE DES PARAMÈTRES DEPUIS LE DOM (ponts vers le module de calcul pur) ---

function getCoefG() {
    const selectVal = document.getElementById('isolationCoef').value;
    const customVal = document.getElementById('customCoef').value;
    return resolveCoefG(selectVal, customVal);
}

// Coefficient G résolu pour UNE pièce : hérite du bâtiment (getCoefG) sauf surcharge explicite
// (room.isolationCoef non vide) — cas d'une véranda ou d'une pièce dont l'enveloppe diffère du
// reste du logement, sans devoir changer le niveau d'isolation global pour toute l'installation.
function getRoomCoefG(room) {
    // La surcharge n'a de sens qu'en multisplit (plusieurs pièces à distinguer) : son contrôle
    // est masqué en mono (voir renderRooms), mais une valeur peut y survivre après un aller-retour
    // multi -> mono (setMode ne vide pas les champs). Sans cette garde, elle continuerait
    // silencieusement à peser sur un calcul dont l'interface ne montre plus qu'elle existe.
    if (state.mode !== 'multi' || !room.isolationCoef) return getCoefG();
    return resolveCoefG(room.isolationCoef, room.customCoefG);
}

function getClimateContext() {
    const code = document.getElementById('deptSelect').value;
    const alt = document.getElementById('altitude').value;
    const zone = DEPARTMENTS[code].zone;
    return {
        zone,
        tBaseHiver: tBaseMatrix[alt][zone],
        tBaseEte: tBaseEteMatrix[alt][zone]
    };
}

function updateClimateInfo() {
    const { zone, tBaseHiver, tBaseEte } = getClimateContext();
    const consigneEl = document.getElementById('consigneInt');
    const consigne = consigneEl ? parseFloat(consigneEl.value) : CONSIGNE_REFERENCE;
    const coefG = getCoefG();
    let ecartHtml = '';
    if (consigne !== CONSIGNE_REFERENCE) {
        const ecart = estimerEcartConsigne(consigne, coefG, tBaseEte);
        const signe = ecart > 0 ? '+' : '';
        ecartHtml = `<div class="mt-2 pt-2 border-t border-white/20 text-accent-200">≈ ${signe}${nb(ecart, 0)} % de besoin froid vs 26 °C (pièce type)</div>`;
    }
    // Quatre mesures en paires libellé/valeur plutôt qu'une phrase à puces : lues d'un coup
    // d'œil pour vérifier que le département saisi correspond bien au chantier.
    const mesure = (libelle, valeur) => `<span class="inline-flex items-baseline gap-1.5"><span class="text-accent-200">${libelle}</span><b>${valeur}</b></span>`;
    document.getElementById('climate-diagnostic').innerHTML =
        `<div class="flex flex-wrap gap-x-4 gap-y-1">
            ${mesure('Zone', zone)}
            ${mesure('T base hiver', `${tBaseHiver} °C`)}
            ${mesure('T base été', `${tBaseEte} °C`)}
            ${mesure('Consigne été', `${consigne} °C`)}
        </div>${ecartHtml}`;
}

// Pont DOM -> calcul pur : rassemble coefG/climat/consigne puis délègue à getRequiredKw (calcul.js).
// coefG résolu PAR PIÈCE (getRoomCoefG) : le bâtiment reste la valeur par défaut, une pièce peut
// la surcharger (voir state.rooms, isolationCoef) sans affecter les autres pièces du même calcul.
function getRequiredKw(surface, height, room) {
    const { tBaseHiver, tBaseEte } = getClimateContext();
    const consigneEl = document.getElementById('consigneInt');
    const consigne = consigneEl ? parseFloat(consigneEl.value) : CONSIGNE_REFERENCE;
    return getRequiredKwCore(surface, height, room, { coefG: getRoomCoefG(room), tBaseHiver, tBaseEte, consigne });
}

// Version du moteur estampillée sur chaque fiche produite. Un document archivé doit dire par
// quelle version de l'outil il a été calculé : sans cette trace, une fiche imprimée il y a un
// an et rouverte aujourd'hui est indiscernable d'une fiche produite par les règles actuelles.
const VERSION_MOTEUR = 'V18';

// Hypothèses de calcul dans la forme que la fiche attend : les mêmes valeurs que
// captureBuildingParams() (qui les capture pour être RÉAPPLIQUÉES au formulaire), mais
// résolues pour un lecteur — le nom du département plutôt que son code, le libellé du niveau
// d'isolation plutôt que son coefficient nu.
function hypothesesFiche(corrections, facteurCanicule, facteurDeclassementChaud) {
    const deptCode = document.getElementById('deptSelect').value;
    const altitude = document.getElementById('altitude').value;
    const { zone, tBaseHiver, tBaseEte } = getClimateContext();
    const isolationSelect = document.getElementById('isolationCoef');
    return {
        dept: deptCode,
        deptNom: (DEPARTMENTS[deptCode] && DEPARTMENTS[deptCode].name) || deptCode,
        altitude, zone, tBaseHiver, tBaseEte,
        consigne: parseFloat(document.getElementById('consigneInt').value),
        isolationLabel: isolationSelect.value === 'custom'
            ? `saisie personnalisée (G ${nb(getCoefG(), 2)})`
            : isolationSelect.options[isolationSelect.selectedIndex].textContent,
        coefG: getCoefG(),
        facteurCanicule,
        facteurDeclassementChaud,
        corrections: corrections || []
    };
}

// Identité portée par le document lui-même (par opposition aux hypothèses de calcul).
// Lue depuis le formulaire : ne vaut donc que pour le parcours vivant — une fiche enregistrée
// tient la sienne de son enregistrement (voir ficheDepuisBody, js/fiche.js).
function identiteFiche() {
    const val = (id) => (document.getElementById(id) || {}).value?.trim() || '';
    return {
        client: val('save-client'),
        zone: val('save-zone'),
        installateur: val('save-installateur') || getInstallateur(),
        dateStr: new Date().toLocaleString('fr-FR', {
            day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
        }),
        brand: state.brand,
        brandLabel: BRAND_LABELS[state.brand] || state.brand,
        modeLabel: state.mode === 'mono' ? 'Monosplit' : 'Multisplit',
        usage: state.usage
    };
}

// La fiche du calcul EN COURS, prête à imprimer : le socle produit par calculate() (hypothèses,
// bilan, pièces) complété par le matériel réellement sélectionné, que seul renderResults()
// connaît. Renvoie null tant qu'aucun résultat n'a été rendu.
function ficheCourante() {
    const calc = state.currentCalc;
    if (!calc || !calc.fiche || !state.lastResultData) return null;
    return {
        ...calc.fiche,
        materiel: state.lastResultData.materiel || null,
        identite: identiteFiche(),
        genereLe: new Date().toISOString(),
        moteur: VERSION_MOTEUR
    };
}

function toggleCustomCoef() {
    const select = document.getElementById('isolationCoef');
    const customInput = document.getElementById('customCoef');
    customInput.classList.toggle('hidden', select.value !== 'custom');
    if (select.value === 'custom') customInput.focus();
}

// Reflet visuel du mode (boutons Monosplit/Multisplit), séparé de setMode() : reloadConfig()
// a besoin de mettre à jour l'affichage sans déclencher la réinitialisation des pièces.
function updateModeButtons(mode) {
    const isMono = mode === 'mono';
    document.getElementById('btn-mono').setAttribute('aria-pressed', String(isMono));
    document.getElementById('btn-multi').setAttribute('aria-pressed', String(!isMono));
}

// Texte par défaut du bandeau de péremption — celui déjà présent dans index.html au premier
// rendu. Réécrit ici après un passage éventuel par afficherErreurSaisie(), qui détourne le
// même bandeau (voir plus bas).
const STALE_TEXTE_DEFAUT = 'Les hypothèses ont changé — ces solutions ne sont plus à jour.';

// Signale que les résultats affichés ne correspondent plus aux hypothèses saisies.
//
// Sans cela, modifier le département, l'isolation, l'altitude, la consigne ou n'importe quel
// champ de pièce laissait les solutions précédentes à l'écran, sans la moindre marque
// d'obsolescence : un artisan qui corrigeait « 69 » en « 13 » voyait le bandeau climat se
// mettre à jour et recopiait le matériel calculé pour Lyon.
//
// setMode, setUsage et setBrand appellent maintenant cette fonction eux aussi (ils appelaient
// jusqu'ici viderResultats() : passer de « Réversible » à « Froid seul » pour vérifier une
// hypothèse effaçait toute la colonne, exactement ce que ce mécanisme existe pour éviter
// ailleurs — la même classe de changement se comportait différemment selon le contrôle tapé).
//
// On avertit au lieu d'effacer : faire disparaître un résultat sous les doigts à la première
// frappe dans un champ est hostile, et l'information reste utile en comparaison. Le bandeau
// disparaît au recalcul.
function marquerResultatsObsoletes() {
    if (!state.currentCalc) return;              // rien d'affiché : rien à périmer
    const banner = document.getElementById('stale-banner');
    if (banner) {
        // Remet le bandeau dans son état « péremption » par défaut, au cas où le dernier
        // passage ici était afficherErreurSaisie() (rôle, tonalité, texte, bouton diffèrent).
        banner.classList.remove('hidden', 'k-note-alert-danger');
        banner.classList.add('k-note-alert-warn');
        banner.setAttribute('role', 'status');
        const texte = document.getElementById('stale-banner-text');
        if (texte) texte.textContent = STALE_TEXTE_DEFAUT;
        const action = document.getElementById('stale-banner-action');
        if (action) action.classList.remove('hidden');
    }
    const results = document.getElementById('results-container');
    // Désaturation et non plus `opacity-50` : la mise en veille visuelle du bloc doit rester
    // lisible. À 50% d'opacité, les références machine et les kW — le contenu qu'on garde
    // justement à l'écran pour comparer — tombaient sous le seuil de contraste AA, en plein
    // soleil comme ailleurs. Drainer la couleur suffit à dire « ce n'est plus à jour » sans
    // toucher au contraste du texte, qui est presque neutre.
    if (results) results.classList.add('k-stale');
}

function effacerMarqueObsolescence() {
    const banner = document.getElementById('stale-banner');
    if (banner) banner.classList.add('hidden');
    const results = document.getElementById('results-container');
    if (results) results.classList.remove('k-stale');
}

// --- Erreur de saisie : signalée sans effacer -----------------------------------------
//
// calculate() mettait `state.currentCalc = null` puis remplaçait TOUT #results-container par
// le message d'erreur, quel que soit ce qui s'y trouvait — un calcul valide affiché disparaissait
// donc au moindre champ mal rempli. Désormais : le dernier calcul valide reste affiché
// (désaturé, comme pour toute autre péremption), l'erreur se lit dans le bandeau de tête de
// colonne, et le champ fautif est marqué et reçoit le focus — voir calculate().

// Élément actuellement marqué en erreur (ou null) : suivi pour pouvoir le nettoyer sans avoir
// à parcourir tous les champs de toutes les pièces à chaque recalcul.
let champFautifActuel = null;

function effacerMarqueChampFautif() {
    if (!champFautifActuel) return;
    champFautifActuel.classList.remove('k-input-error');
    champFautifActuel.removeAttribute('aria-invalid');
    champFautifActuel = null;
}

function marquerChampFautif(roomId, champ) {
    effacerMarqueChampFautif();
    const el = document.getElementById(`room-${roomId}-${champ}`);
    if (!el) return null;               // pièce retirée entre la saisie et le clic, par ex.
    el.classList.add('k-input-error');
    el.setAttribute('aria-invalid', 'true');
    champFautifActuel = el;
    return el;
}

// erreur = { message, roomId, champ } — voir validerSaisiePieces(). Réutilise le bandeau de
// péremption plutôt que d'en ouvrir un second : les deux disent au fond la même chose (« ce
// qui est affiché dessous ne correspond plus à ce qui est saisi ») et ne surviennent jamais
// ensemble, une erreur de saisie empêchant justement le recalcul qui ferait apparaître l'autre.
// Fonctionne aussi SANS calcul préalable (currentCalc null) — seul cas où ce bandeau doit
// s'afficher avant le premier calcul réussi.
function afficherErreurSaisie(erreur) {
    const banner = document.getElementById('stale-banner');
    if (banner) {
        banner.classList.remove('hidden', 'k-note-alert-warn');
        banner.classList.add('k-note-alert-danger');
        banner.setAttribute('role', 'alert');
        const texte = document.getElementById('stale-banner-text');
        if (texte) texte.textContent = erreur.message;
        // Pas de bouton ici : le champ fautif reçoit directement le focus juste après, et
        // « Recalculer » n'aiderait de toute façon à rien tant que l'erreur n'est pas corrigée.
        const action = document.getElementById('stale-banner-action');
        if (action) action.classList.add('hidden');
    }
    // Ne désature les résultats que s'il y en a : sur un premier calcul jamais réussi,
    // #results-container ne porte que l'état vide, que ça n'aiderait en rien à assombrir.
    if (state.currentCalc) {
        const results = document.getElementById('results-container');
        if (results) results.classList.add('k-stale');
    }
    const champEl = marquerChampFautif(erreur.roomId, erreur.champ);
    if (champEl) {
        champEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        champEl.focus({ preventScroll: true });
    } else {
        // Repli : la pièce visée n'existe plus, mais l'erreur reste vraie ailleurs à l'écran —
        // au moins amener le bandeau sous les yeux plutôt que ne rien montrer du tout.
        document.getElementById('stale-banner')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

// Passer en Monosplit ne garde que la première pièce : sans garde, un artisan qui teste "et si
// je repassais en mono ?" perdait la saisie des pièces 2 à 5 en un clic, sans le moindre signe
// avant-coureur (le bouton Monosplit/Multisplit ne ressemble à rien de destructeur). Le passage
// inverse (mono -> multi) ne perd rien : la pièce 1 reste, on ne fait qu'ajouter des emplacements.
function setMode(mode) {
    if (mode === 'mono' && state.mode === 'multi' && state.rooms.length > 1) {
        if (!confirm(`Repasser en Monosplit ? La saisie des ${state.rooms.length - 1} autre(s) pièce(s) sera perdue (seule la première est conservée).`)) return;
    }
    state.mode = mode;
    state.rooms = [state.rooms[0]];
    state.forcedDedicatedIds = new Set();
    updateModeButtons(mode);
    // Marque plutôt qu'efface (voir marquerResultatsObsoletes) : passer en Multisplit pour
    // ajouter des pièces ne doit pas faire disparaître le résultat mono déjà affiché — ce
    // que la troncature de state.rooms ci-dessus n'affecte pas, currentCalc étant un
    // instantané indépendant du formulaire courant.
    marquerResultatsObsoletes();
    renderRooms();
}

// Reflet visuel du toggle Réversible / Froid seul, séparé de setUsage() pour les mêmes raisons
// que updateModeButtons (reloadConfig / restoreDraftIfAny doivent pouvoir l'appliquer sans
// déclencher les effets de bord de setUsage).
function updateUsageButtons(usage) {
    const isReversible = usage !== 'froid_seul';
    document.getElementById('btn-usage-reversible').setAttribute('aria-pressed', String(isReversible));
    document.getElementById('btn-usage-froid_seul').setAttribute('aria-pressed', String(!isReversible));
    const note = document.getElementById('usage-note');
    if (note) note.classList.toggle('hidden', isReversible);
}

function setUsage(usage) {
    state.usage = usage;
    updateUsageButtons(usage);
    // Marque plutôt qu'efface (voir marquerResultatsObsoletes) : basculer sur « Froid seul »
    // pour vérifier une hypothèse ne doit pas faire disparaître le calcul affiché — c'était
    // jusqu'ici le seul contrôle qui punissait la curiosité de l'artisan par un écran vide.
    marquerResultatsObsoletes();
    persistDraft();
}

// Paliers d'isolation proposés à la surcharge par pièce : mêmes valeurs/libellés que le
// sélecteur global (#isolationCoef, index.html), qui reste rendu en HTML statique — à maintenir
// synchronisé si ces paliers changent, faute d'une source commune entre les deux rendus.
const NIVEAUX_ISOLATION = [
    { value: '2.0',  label: 'G 2.0 — avant 1974, non isolé' },
    { value: '1.2',  label: 'G 1.2 — 1974 à 1988' },
    { value: '1.1',  label: 'G 1.1 — 1989 à 2000' },
    { value: '0.8',  label: 'G 0.8 — 2001 à 2012 (RT 2005)' },
    { value: '0.35', label: 'G 0.35 — 2013 à 2021 (RT 2012)' },
    { value: '0.25', label: 'G 0.25 — après 2022 (RE 2020)' },
    { value: '3.0',  label: 'G 3.0 — véranda' }
];

// Bascule locale (pas de re-rendu de la liste des pièces) de l'input de saisie personnalisée,
// symétrique de toggleCustomCoef() pour le sélecteur global.
function toggleRoomCustomCoef(id) {
    const select = document.getElementById(`room-${id}-isolationCoef`);
    const customInput = document.getElementById(`room-${id}-customCoefG`);
    if (!select || !customInput) return;
    customInput.classList.toggle('hidden', select.value !== 'custom');
    if (select.value === 'custom') customInput.focus();
}

function renderRooms() {
    const container = document.getElementById('rooms-container');
    container.innerHTML = '';
    const canAddMore = state.rooms.length < 5;
    state.rooms.forEach((room, index) => {
        const showRemove = state.mode === 'multi' && state.rooms.length > 1;
        const showDuplicate = state.mode === 'multi' && canAddMore;
        // Les actions de la pièce (dupliquer / supprimer) passent de vignettes flottantes en
        // absolu à une barre d'en-tête en flux : superposées au titre, elles se retrouvaient
        // sous le pouce à chaque défilement d'une main, et leurs zones tactiles se chevauchaient.
        container.insertAdjacentHTML('beforeend', `
            <div class="k-card fade-in">
                <div class="flex items-center gap-3 mb-4">
                    <span class="w-8 h-8 rounded-xl bg-accent-50 text-accent-700 border border-accent-100 flex items-center justify-center text-sm font-bold flex-shrink-0 k-num">${index + 1}</span>
                    <h3 class="text-sm font-semibold text-ink-900 flex-grow min-w-0 truncate">${state.mode === 'multi' ? `Pièce ${index + 1}${room.nom ? ` — ${escapeHtml(room.nom)}` : ''}` : 'Volume de la pièce'}</h3>
                    ${state.mode === 'multi' && room.isolationCoef ? `<span class="k-pill k-pill-neutral k-num flex-shrink-0" title="Isolation propre à cette pièce, différente du bâtiment">G ${nb(getRoomCoefG(room), 2)}</span>` : ''}
                    ${showDuplicate ?`<button onclick="duplicateRoom(${room.id})" title="Dupliquer cette pièce" aria-label="Dupliquer cette pièce" class="k-icon-btn hover:text-accent-700 hover:bg-accent-50"><svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 4h8a2 2 0 012 2v8a2 2 0 01-2 2h-8a2 2 0 01-2-2v-8a2 2 0 012-2z"></path></svg></button>` : ''}
                    ${showRemove ? `<button onclick="removeRoom(${room.id})" title="Supprimer cette pièce" aria-label="Supprimer cette pièce" class="k-icon-btn-danger"><svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg></button>` : ''}
                </div>
                <div class="flex flex-col gap-4">
                    ${state.mode === 'multi' ? `
                    <div>
                        <label for="room-${room.id}-nom" class="k-label">Nom de la pièce (optionnel)</label>
                        <input id="room-${room.id}-nom" type="text" maxlength="40" oninput="updateRoom(${room.id}, 'nom', this.value)" value="${escapeHtml(room.nom || '')}" placeholder="Ex : Salon, Chambre parents…" class="k-input">
                    </div>` : ''}
                    <div class="grid grid-cols-2 gap-3">
                        <div>
                            <label for="room-${room.id}-surface" class="k-label">Surface (m²)</label>
                            <input id="room-${room.id}-surface" type="text" inputmode="decimal" oninput="updateRoom(${room.id}, 'surface', this.value)" value="${room.surface}" placeholder="Ex : 30" class="k-input k-num">
                        </div>
                        <div>
                            <label for="room-${room.id}-height" class="k-label">Hauteur (m)</label>
                            <input id="room-${room.id}-height" type="text" inputmode="decimal" oninput="updateRoom(${room.id}, 'height', this.value)" value="${room.height}" class="k-input k-num">
                        </div>
                    </div>
                    <div>
                        <label for="room-${room.id}-emplacement" class="k-label">Emplacement de la pièce</label>
                        <select id="room-${room.id}-emplacement" onchange="updateRoom(${room.id}, 'emplacement', this.value)" class="k-select">
                            <option value="sous_toiture" ${room.emplacement === 'sous_toiture' ? 'selected' : ''}>Sous toiture / combles aménagés — fort apport</option>
                            <option value="plain_pied" ${room.emplacement === 'plain_pied' ? 'selected' : ''}>Plain-pied, combles isolés — apport modéré</option>
                            <option value="etage_protege" ${room.emplacement === 'etage_protege' ? 'selected' : ''}>Étage protégé / sous un niveau — nul</option>
                        </select>
                    </div>
                    ${state.mode === 'multi' ? `
                    <details data-k="room-isolation:${room.id}" class="group/iso" ${room.isolationCoef ? 'open' : ''}>
                        <summary class="k-disclosure text-2xs font-medium text-ink-500">
                            <span>${room.isolationCoef ? 'Isolation propre à cette pièce' : "Isolation différente de celle du bâtiment ?"}</span>
                            <span class="ml-auto transition-transform group-open/iso:rotate-180">${icone('chevron', 'w-3.5 h-3.5')}</span>
                        </summary>
                        <div class="mt-2 flex gap-2">
                            <select id="room-${room.id}-isolationCoef" onchange="updateRoom(${room.id}, 'isolationCoef', this.value); toggleRoomCustomCoef(${room.id});" class="k-select flex-grow min-w-0">
                                <option value="">Comme le bâtiment (par défaut)</option>
                                ${NIVEAUX_ISOLATION.map(n => `<option value="${n.value}" ${room.isolationCoef === n.value ? 'selected' : ''}>${n.label}</option>`).join('')}
                                <option value="custom" ${room.isolationCoef === 'custom' ? 'selected' : ''}>Saisie personnalisée…</option>
                            </select>
                            <input type="text" inputmode="decimal" id="room-${room.id}-customCoefG" oninput="updateRoom(${room.id}, 'customCoefG', this.value)" value="${escapeHtml(String(room.customCoefG ?? ''))}" placeholder="0.65" aria-label="Coefficient G personnalisé pour cette pièce" class="k-input w-24 flex-shrink-0 ${room.isolationCoef === 'custom' ? '' : 'hidden'}">
                        </div>
                    </details>` : ''}
                    ${state.mode === 'multi' ? `
                    <div>
                        <label for="room-${room.id}-expositionMurs" class="k-label">Murs donnant sur l'extérieur</label>
                        <select id="room-${room.id}-expositionMurs" onchange="updateRoom(${room.id}, 'expositionMurs', this.value)" class="k-select">
                            <option value="4" ${String(room.expositionMurs) === '4' ? 'selected' : ''}>4 — isolée sur toutes ses faces</option>
                            <option value="3" ${String(room.expositionMurs) === '3' ? 'selected' : ''}>3</option>
                            <option value="2" ${String(room.expositionMurs) === '2' ? 'selected' : ''}>2 — pièce d'angle</option>
                            <option value="1" ${String(room.expositionMurs) === '1' ? 'selected' : ''}>1 — pièce intérieure</option>
                        </select>
                    </div>` : ''}
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                            <label for="room-${room.id}-orientation" class="k-label">Orientation des baies</label>
                            <select id="room-${room.id}-orientation" onchange="updateRoom(${room.id}, 'orientation', this.value)" class="k-select">
                                <option value="nord" ${room.orientation === 'nord' ? 'selected' : ''}>Nord</option>
                                <option value="est" ${room.orientation === 'est' ? 'selected' : ''}>Est</option>
                                <option value="sud" ${room.orientation === 'sud' ? 'selected' : ''}>Sud</option>
                                <option value="ouest" ${room.orientation === 'ouest' ? 'selected' : ''}>Ouest</option>
                                <option value="mixte" ${room.orientation === 'mixte' ? 'selected' : ''}>Mixte / plusieurs</option>
                            </select>
                        </div>
                        <div>
                            <label for="room-${room.id}-vitrage" class="k-label">Quantité de vitrage</label>
                            <select id="room-${room.id}-vitrage" onchange="updateRoom(${room.id}, 'vitrage', this.value)" class="k-select">
                                <option value="peu" ${room.vitrage === 'peu' ? 'selected' : ''}>Peu vitré</option>
                                <option value="moyen" ${room.vitrage === 'moyen' ? 'selected' : ''}>Moyen</option>
                                <option value="beaucoup" ${room.vitrage === 'beaucoup' ? 'selected' : ''}>Très vitré</option>
                            </select>
                        </div>
                        <div>
                            <label for="room-${room.id}-protection" class="k-label">Protection solaire</label>
                            <select id="room-${room.id}-protection" onchange="updateRoom(${room.id}, 'protection', this.value)" class="k-select">
                                <option value="aucune" ${room.protection === 'aucune' ? 'selected' : ''}>Aucune</option>
                                <option value="stores_int" ${room.protection === 'stores_int' ? 'selected' : ''}>Stores intérieurs</option>
                                <option value="volets_ext" ${room.protection === 'volets_ext' ? 'selected' : ''}>Volets extérieurs</option>
                            </select>
                        </div>
                        <div>
                            <label for="room-${room.id}-occupants" class="k-label">Occupants</label>
                            <input id="room-${room.id}-occupants" type="text" inputmode="numeric" oninput="updateRoom(${room.id}, 'occupants', this.value)" value="${room.occupants}" placeholder="Auto : ${occupantsParDefaut(room.surface) || '–'}" class="k-input k-num">
                        </div>
                    </div>
                </div>
            </div>
        `);
    });
    if (state.mode === 'multi' && state.rooms.length < 5) {
        container.insertAdjacentHTML('beforeend', `<button onclick="addRoom()" class="k-btn-add"><svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 5v14M5 12h14"></path></svg>Ajouter une pièce <span class="k-num text-ink-400">(${state.rooms.length}/5)</span></button>`);
    }
}

function addRoom() { state.rooms.push(defaultRoom(nouvelIdPiece())); renderRooms(); persistDraft(); }
// Confirmation avant suppression : geste irréversible (aucun "annuler"), qui efface d'un coup
// toute la saisie de la pièce (surface, orientation, vitrage...) — voir la note en tête de
// fichier sur duplicateRoom, le même risque s'applique ici, en pire (duplicateRoom recopie,
// removeRoom détruit).
function removeRoom(id) {
    const idx = state.rooms.findIndex(r => r.id === id);
    if (idx === -1) return;
    const label = roomLabel({ index: idx + 1, nom: state.rooms[idx].nom });
    if (!confirm(`Supprimer ${label} ? Sa saisie sera perdue.`)) return;
    state.rooms = state.rooms.filter(r => r.id !== id);
    state.forcedDedicatedIds.delete(id);
    renderRooms();
    persistDraft();
}
function duplicateRoom(id) {
    if (state.rooms.length >= 5) return;
    const idx = state.rooms.findIndex(r => r.id === id);
    if (idx === -1) return;
    const clone = { ...state.rooms[idx], id: nouvelIdPiece() };
    state.rooms.splice(idx + 1, 0, clone);
    renderRooms();
    persistDraft();
}
function updateRoom(id, field, value) {
    const r = state.rooms.find(x => x.id === id);
    if (!r) return;
    const champsTexte = ['nom', 'emplacement', 'orientation', 'vitrage', 'protection', 'isolationCoef', 'customCoefG'];
    if (champsTexte.includes(field)) {
        r[field] = value;
    } else {
        // Number.isFinite (et non `|| ''`) : un champ à 0 (ex: 0 occupant) doit rester 0,
        // pas retomber silencieusement sur l'estimation automatique.
        // parseNombreSaisi accepte la virgule décimale (voir calcul.js).
        const num = parseNombreSaisi(value);
        r[field] = Number.isFinite(num) ? num : '';
    }
    persistDraft();
    marquerResultatsObsoletes();
}

// Seede les choix de gamme par défaut pour chaque pièce d'un groupe multisplit, sans jamais le
// faire depuis une fonction de rendu (voir renderMultiRoomsGuide, purement lecture). Appelée à la
// création du calcul et à chaque changement de groupe (les gammes compatibles peuvent différer
// d'un groupe à l'autre) ; ne modifie que les entrées absentes ou devenues invalides, pour
// préserver le choix de l'utilisateur quand il reste valide.
function seedGroupGammeDefaults(standardRooms, allowedGammes) {
    standardRooms.forEach(r => {
        const eligibles = getRoomEligibleGammes(r, allowedGammes, state.brand);
        if (eligibles.length === 0) return;
        if (!state.selection.group[r.index] || !eligibles.includes(state.selection.group[r.index])) {
            state.selection.group[r.index] = eligibles[0];
        }
    });
}

// Bornes de saisie. Elles étaient déclarées en attributs `min`/`max` sur les champs, mais
// aucun <form> n'entoure la saisie et aucun checkValidity() n'est appelé : elles n'ont jamais
// rien validé. Une surface négative traversait tous les filtres et faisait proposer la plus
// petite machine du catalogue sans un mot ; une surface de 5000 m² produisait « aucune machine
// ne couvre ce besoin » sans jamais mettre en cause la saisie.
const BORNES_SAISIE = {
    surface:  { min: 1,   max: 200, label: 'La surface', unite: 'm²' },
    height:   { min: 1.8, max: 6,   label: 'La hauteur sous plafond', unite: 'm' },
    occupants:{ min: 0,   max: 30,  label: "Le nombre d'occupants", unite: '' }
};

// Renvoie { message, roomId, champ }, ou null si tout est cohérent. Nomme toujours la pièce
// fautive dans le message : avec cinq pièces, « Saisie incomplète » obligeait à toutes les
// rouvrir pour trouver laquelle. roomId + champ permettent en plus à calculate() de
// retrouver le CHAMP DOM exact (id="room-${roomId}-${champ}", voir renderRooms()) pour le
// marquer et lui donner le focus — la pièce fautive nommée en toutes lettres n'évite déjà
// plus qu'il faille rouvrir les autres, mais laissait encore chercher le bon champ À
// L'INTÉRIEUR de la bonne pièce quand elle en compte huit.
function validerSaisiePieces(rooms, multi) {
    for (let i = 0; i < rooms.length; i++) {
        const r = rooms[i];
        const nom = r.nom ? `« ${r.nom} »` : (multi ? `Pièce ${i + 1}` : 'La pièce');

        if (r.surface === '' || r.surface === null || r.surface === undefined) {
            return { message: `${nom} : indiquez la surface.`, roomId: r.id, champ: 'surface' };
        }
        for (const [champ, b] of Object.entries(BORNES_SAISIE)) {
            const v = r[champ];
            if (v === '' || v === null || v === undefined) continue;   // champ optionnel laissé vide
            if (!Number.isFinite(v)) {
                return { message: `${nom} : ${b.label.toLowerCase()} n'est pas un nombre valide.`, roomId: r.id, champ };
            }
            if (v < b.min || v > b.max) {
                return {
                    message: `${nom} : ${b.label.toLowerCase()} doit être comprise entre ${b.min} et ${b.max} ${b.unite}`.trim() + '.',
                    roomId: r.id, champ
                };
            }
        }
    }
    return null;
}

function calculate() {
    const resultsContainer = document.getElementById('results-container');
    const erreur = validerSaisiePieces(state.rooms, state.mode === 'multi');
    if (erreur) {
        // currentCalc n'est PAS remis à null ici : une erreur de saisie ne rend pas caduc un
        // calcul déjà réussi, elle empêche seulement d'en produire un nouveau tant qu'elle
        // persiste. Le dernier résultat valide reste donc affiché, désaturé comme pour toute
        // autre péremption, pendant que le bandeau et le champ fautif portent l'erreur — voir
        // afficherErreurSaisie(). Avant ce correctif, remplacer #results-container par le seul
        // message d'erreur détruisait un calcul valide pour une faute de frappe dans un champ
        // sans rapport.
        afficherErreurSaisie(erreur);
        return;
    }
    effacerMarqueChampFautif();
    effacerMarqueObsolescence();

    const { tBaseHiver, tBaseEte } = getClimateContext();
    const froidSeul = state.usage === 'froid_seul';

    // Corrections appliquées au besoin brut avant sélection. Elles sortaient jusqu'ici en trois
    // encarts pastel empilés, chacun avec sa couleur et son paragraphe : entre le bilan
    // thermique et la première solution, l'artisan traversait une dizaine de lignes de prose
    // avant de voir une machine. Elles tiennent maintenant en trois lignes chiffrées dans un
    // seul bloc (voir renderHypotheses) — la justification reste accessible, repliée, parce
    // qu'elle est le fond du métier de cet outil ; c'est son volume à l'écran qui changeait
    // l'ordre de lecture, pas son existence.
    const hypotheses = [];

    // Marge canicule : au-delà de la température de base été, la puissance froid réelle chute
    // (catalogue donné à 35°C ext.). Interpolée sur la Tbase été elle-même, pas sur une liste de
    // zones : voir data.js pour la régression que ça corrige.
    const facteurCanicule = getFacteurCanicule(tBaseEte);
    if (facteurCanicule > 1) {
        hypotheses.push({
            libelle: 'Marge canicule',
            valeur: `+${Math.round((facteurCanicule - 1) * 100)} %`,
            detail: `Zone sujette à des pointes de 40-42 °C. Le catalogue donne la puissance froid à 35 °C extérieur : au-delà, la puissance réelle chute, d'où la marge appliquée à la sélection.`
        });
    }

    // Déclassement chaud : la puissance catalogue (+7°C) chute par grand froid. Sans objet en
    // "Froid seul" puisque le chaud n'entre alors plus dans le dimensionnement.
    const facteurDeclassementChaud = getFacteurDeclassementChaud(tBaseHiver);
    if (!froidSeul && facteurDeclassementChaud > 1.05) {
        hypotheses.push({
            libelle: 'Déclassement chaud',
            valeur: `+${Math.round((facteurDeclassementChaud - 1) * 100)} %`,
            detail: `La puissance chaud du catalogue est donnée à +7 °C extérieur ; elle chute à la température de base hiver (${tBaseHiver} °C ici). Estimation générique, à affiner avec les courbes constructeur.`
        });
    }

    if (froidSeul) {
        hypotheses.push({
            libelle: 'Sélection',
            valeur: 'Froid seul',
            detail: `Le besoin chauffage reste affiché à titre indicatif mais n'entre pas dans le choix du matériel. Les machines proposées restent des PAC réversibles standard.`
        });
    }

    const hypothesesHtml = renderHypotheses(hypotheses);

    // Reset des choix utilisateur à chaque nouveau calcul. loadedConfigId aussi : un calcul
    // fraîchement lancé n'est plus l'édition d'une fiche existante, sauf si reloadConfig() le
    // repose juste après avoir appelé calculate() pour recharger une configuration.
    state.selection = { mono: 0, dedicated: {}, group: {}, groupChoice: 0 };
    state.loadedConfigId = null;

    if (state.mode === 'mono') {
        const req = getRequiredKw(state.rooms[0].surface, state.rooms[0].height, state.rooms[0]);
        const froidMatch = req.froid * facteurCanicule;
        // En "Froid seul", le besoin chaud est neutralisé pour la sélection (mais reste affiché
        // via req.chaud, non modifié, dans le détail par pièce et le bilan cumulé).
        const chaudMatch = froidSeul ? 0 : req.chaud * facteurDeclassementChaud;
        const size = getUiSizeForKw(froidMatch, chaudMatch, state.brand);

        state.currentCalc = {
            mode: 'mono',
            req: req,
            bilan: { froid: req.froid, chaud: req.chaud },
            besoinsHtml: renderBesoinsCard([req]),
            hypothesesHtml: hypothesesHtml,
            roomDetails: [`Pièce 1 : ${nb(req.froid)} kW F / ${nb(req.chaud)} kW C → Taille ${size || 'HORS LIMITE'}`],
            fiche: construireFiche({
                hypotheses: hypothesesFiche(hypotheses, facteurCanicule, froidSeul ? 1 : facteurDeclassementChaud),
                pieces: [{
                    room: state.rooms[0], coefG: getRoomCoefG(state.rooms[0]), coefGSurcharge: null, role: 'mono',
                    rd: { index: 1, nom: state.rooms[0].nom || '', req, froidMatch, chaudMatch, size }
                }]
            }),
            mono: { options: trierMonosParTva(findBestMonos(froidMatch, chaudMatch, state.brand), state.brand), froidSeul }
        };
    } else {
        let roomsData = state.rooms.map((r, i) => {
            let req = getRequiredKw(r.surface, r.height, r);
            let froidMatch = req.froid * facteurCanicule;
            let chaudMatch = froidSeul ? 0 : req.chaud * facteurDeclassementChaud;
            let size = getUiSizeForKw(froidMatch, chaudMatch, state.brand);
            // Tracée dans la fiche (roomDetails, ci-dessous) uniquement quand la pièce surcharge
            // le niveau d'isolation du bâtiment (voir getRoomCoefG) : sinon la mention serait
            // redondante avec l'hypothèse globale déjà affichée (hypothesesFiche).
            const gSurcharge = r.isolationCoef ? getRoomCoefG(r) : null;
            return { id: r.id, index: i + 1, nom: r.nom || '', req: req, froidMatch: froidMatch, chaudMatch: chaudMatch, size: size, maxKw: Math.max(froidMatch, chaudMatch), gSurcharge };
        });
        const roomDetails = roomsData.map(r => `Pièce ${r.index}${r.nom ? ' (' + r.nom + ')' : ''}${r.gSurcharge !== null ? ` · G ${nb(r.gSurcharge, 2)} (isolation propre à cette pièce)` : ''} : ${nb(r.req.froid)} kW F / ${nb(r.req.chaud)} kW C → Taille ${r.size || 'HORS LIMITE'}`);

        // Une pièce quitte le groupe multisplit soit parce qu'aucune UI du catalogue ne couvre
        // son besoin (size === null), soit parce que l'utilisateur l'en a délibérément sortie
        // (separerPieceEnDedie, state.forcedDedicatedIds) pour ne plus faire dépendre les autres
        // pièces de sa demande de pointe — voir analyseEquilibreGroupe / renderBalanceNote.
        let extractedForMono = roomsData.filter(r => r.size === null || state.forcedDedicatedIds.has(r.id));
        let standardRooms = roomsData.filter(r => r.size !== null && !state.forcedDedicatedIds.has(r.id));
        const hybridNote = extractedForMono.length > 0;

        let bestGroup = findMultiGroup(standardRooms, state.brand, COEF_FOISONNEMENT_FROID, COEF_FOISONNEMENT_CHAUD);

        if (!bestGroup && standardRooms.length > 1) {
            standardRooms.sort((a, b) => b.maxKw - a.maxKw);
            while (!bestGroup && standardRooms.length > 1) {
                let biggestRoom = standardRooms.shift();
                extractedForMono.push(biggestRoom);
                bestGroup = findMultiGroup(standardRooms, state.brand, COEF_FOISONNEMENT_FROID, COEF_FOISONNEMENT_CHAUD);
            }
        }

        // Cartes "monosplit dédié" (pièces trop grosses / délestées du groupe).
        let dedicated = extractedForMono.map(room => ({
            room: room,
            label: `Monosplit dédié · Pièce ${room.index}${room.nom ? ' — ' + room.nom : ''}`,
            options: trierMonosParTva(findBestMonos(room.froidMatch, room.chaudMatch, state.brand), state.brand)
        }));

        let groupOptions = [];
        if (bestGroup === "MONO" && standardRooms.length === 1) {
            // Une seule pièce restante après délestage : traitée comme un mono dédié de plus.
            dedicated.push({
                room: standardRooms[0],
                label: `Monosplit restant · Pièce ${standardRooms[0].index}${standardRooms[0].nom ? ' — ' + standardRooms[0].nom : ''}`,
                options: trierMonosParTva(findBestMonos(standardRooms[0].froidMatch, standardRooms[0].chaudMatch, state.brand), state.brand)
            });
        } else if (bestGroup && bestGroup !== "MONO") {
            groupOptions = findMultiGroupOptions(standardRooms, state.brand, COEF_FOISONNEMENT_FROID, COEF_FOISONNEMENT_CHAUD);
        }

        // Escalade anti-déséquilibre : quand la plus petite solution valide laisse une pièce
        // absorber une part excessive de la puissance du groupe (demande simultanée limitée pour
        // les autres pièces), on ne se contente plus d'alerter — on va chercher dans le catalogue
        // le groupe supérieur qui rééquilibre (ex. 2M14 -> 2M18) et on le propose en tête, donc
        // sélectionné par défaut. Le groupe juste dimensionné reste sélectionnable en dessous, et
        // le délestage en monosplit dédié reste l'alternative quand aucun groupe ne rééquilibre.
        let groupEquilibre = null;
        if (groupOptions.length > 0 && estGroupeDesequilibre(groupOptions[0], standardRooms)) {
            const besoins = {
                froid: standardRooms.reduce((sum, r) => sum + r.req.froid, 0),
                chaud: froidSeul ? 0 : standardRooms.reduce((sum, r) => sum + r.req.chaud, 0)
            };
            const upgrade = findGroupeEquilibre(standardRooms, state.brand, COEF_FOISONNEMENT_FROID, COEF_FOISONNEMENT_CHAUD, besoins);
            if (upgrade && !groupOptions.some(g => g.reference === upgrade.reference)) {
                groupEquilibre = upgrade;
                groupOptions = [upgrade, ...groupOptions];
            }
        }

        if (groupOptions.length > 0) {
            // Seede les choix de gamme par défaut pour le premier groupe (groupChoice = 0 après le reset ci-dessus).
            seedGroupGammeDefaults(standardRooms, groupOptions[0].gammes_compatibles);
        }

        state.currentCalc = {
            mode: 'multi',
            bilan: {
                froid: roomsData.reduce((sum, r) => sum + r.req.froid, 0),
                chaud: roomsData.reduce((sum, r) => sum + r.req.chaud, 0)
            },
            besoinsHtml: renderBesoinsCard(roomsData.map(r => r.req), true, roomsData),
            hypothesesHtml: hypothesesHtml,
            roomDetails: roomDetails,
            fiche: construireFiche({
                hypotheses: hypothesesFiche(hypotheses, facteurCanicule, froidSeul ? 1 : facteurDeclassementChaud),
                // Le rôle d'une pièce est calculé ICI, en chaîne : le lire plus tard depuis
                // state.forcedDedicatedIds ferait entrer un Set dans la fiche, et JSON.stringify
                // le rendrait `{}` SANS lever — une perte parfaitement silencieuse.
                pieces: roomsData.map((rd, i) => ({
                    room: state.rooms[i],
                    coefG: getRoomCoefG(state.rooms[i]),
                    coefGSurcharge: rd.gSurcharge,
                    role: standardRooms.some(r => r.id === rd.id) ? 'groupe' : 'dedie',
                    rd
                }))
            }),
            multi: { dedicated: dedicated, groupOptions: groupOptions, standardRooms: standardRooms, hybridNote: hybridNote, froidSeul, groupEquilibre: groupEquilibre }
        };
    }

    renderResults({ anime: true });
    resultsContainer.scrollIntoView({ behavior: 'smooth' });
}

// --- TVA : dite une fois par bloc plutôt qu'une fois par carte -----------------------
//
// Une pastille verte « TVA 5,5% » recopiée sur chaque option — et, en multisplit, sur
// chacune des gammes de chacune des pièces, soit douze fois sur un seul écran — n'informe
// de rien : elle occupe la couleur de succès, donc le premier point de fixation de l'œil,
// sur toute la colonne où l'artisan cherche justement ce qui DISTINGUE les options.
//
// Le statut remonte donc au bandeau du bloc quand il est commun à toutes les options, et
// les cartes n'en portent plus. Dès qu'une seule option s'écarte, tvaCommune() renvoie
// `commun: false` et les pastilles réapparaissent sur chaque carte — c'est alors une vraie
// différence, qui mérite d'être vue.
function tvaCommune(infos) {
    if (infos.length === 0) return { commun: false };
    const cle = (i) => (i ? `${i.statut}|${i.wifiRequired ? 'wifi' : ''}` : 'aucun');
    const reference = cle(infos[0]);
    return infos.every(i => cle(i) === reference) ? { commun: true, info: infos[0] } : { commun: false };
}

function mentionTvaBloc(tvaBloc, nbOptions) {
    if (!tvaBloc.commun) return '';
    const info = tvaBloc.info;
    if (!info) return 'TVA non renseignée';
    if (info.statut === 'a_verifier') return nbOptions > 1 ? 'TVA à vérifier sur tous' : 'TVA à vérifier';
    const libelle = info.statut === 'eligible' ? 'TVA 5,5 %' : 'TVA 20 %';
    return `${nbOptions > 1 ? 'Tous en ' : ''}${libelle}${info.wifiRequired ? ' · module Wifi requis' : ''}`;
}

// Méta du bandeau de bloc : le nombre de modèles comparables, et le statut TVA quand il
// est commun. L'ancien texte annonçait « TVA 5,5% en tête » pour expliquer l'ordre de tri
// (trierMonosParTva, calcul.js) — une explication qui n'a plus lieu d'être une fois le
// statut énoncé pour l'ensemble du bloc.
function metaBloc(nbOptions, tvaBloc) {
    return [
        nbOptions > 1 ? `${nbOptions} modèles` : '',
        mentionTvaBloc(tvaBloc, nbOptions)
    ].filter(Boolean).join(' · ');
}

// État vide de la colonne des solutions. Il tient deux rôles, l'un pour chaque format d'écran :
// sur mobile il remplace le vide muet qui suivait « Nouveau calcul » (rien à l'écran, aucune
// indication de ce qui va se passer) ; sur grand écran, où la saisie et les solutions sont
// désormais côte à côte, il occupe la colonne de droite tant qu'aucun calcul n'a été lancé,
// évitant une demi-page blanche au premier chargement.
function etatVideResultats() {
    return `
    <div class="rounded-2xl border-2 border-dashed border-line bg-white/60 px-5 py-10 text-center">
        <div class="w-12 h-12 mx-auto mb-3 rounded-2xl bg-mute-100 text-ink-400 flex items-center justify-center">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z"></path></svg>
        </div>
        <p class="text-sm font-semibold text-ink-700">Aucune solution calculée</p>
        <p class="k-hint mt-1 max-w-xs mx-auto">Renseignez les pièces, puis lancez « Rechercher les solutions » : le bilan thermique et le matériel proposé s'afficheront ici.</p>
    </div>`;
}

function viderResultats() {
    const c = document.getElementById('results-container');
    if (c) c.innerHTML = etatVideResultats();
}

// Corrections appliquées au besoin brut avant la sélection du matériel : une ligne chiffrée
// par correction, la justification repliée derrière « Pourquoi ». Voir le commentaire dans
// calculate() sur ce que ce bloc remplace.
function renderHypotheses(lignes) {
    if (lignes.length === 0) return '';
    // La ligne entière est le déclencheur du dépliant : un lien « Pourquoi » sous chaque ligne
    // doublait la hauteur du bloc pour n'ajouter qu'une invite. Le chevron suffit à dire qu'il
    // y a quelque chose dessous, et la valeur chiffrée reste alignée à droite.
    return `
    <div class="k-card fade-in">
        <span class="k-eyebrow">Corrections appliquées</span>
        <div class="mt-1 divide-y divide-line">
            ${lignes.map(l => `
            <details data-k="hyp:${l.libelle}" class="group/hyp py-2 first:pt-1 last:pb-0">
                <summary class="flex items-baseline justify-between gap-4 min-h-[44px] cursor-pointer select-none list-none -mx-1 px-1 rounded-lg hover:bg-mute-50 transition-colors">
                    <span class="flex items-baseline gap-1.5 min-w-0 text-xs text-ink-700">
                        ${l.libelle}
                        <span class="text-ink-400 transition-transform group-open/hyp:rotate-180 self-center">${icone('chevron', 'w-3.5 h-3.5')}</span>
                    </span>
                    <span class="text-xs font-semibold text-ink-900 k-num whitespace-nowrap">${l.valeur}</span>
                </summary>
                <p class="k-hint mt-1.5 pr-6">${l.detail}</p>
            </details>`).join('')}
        </div>
    </div>`;
}

// Intertitre d'un bloc de solutions. Il remplace la répétition du même badge « Monosplit
// recommandé » en tête de chacune des six cartes : un intitulé recopié à l'identique sur toutes
// les options ne distingue plus rien, il occupe seulement la ligne la plus visible de la carte.
// Le type d'installation et le nombre d'options se disent une fois, au-dessus de la liste.
function blocTitre(titre, sousTitre) {
    return `<div class="k-band mt-1">
        <h3 class="k-band-title">${titre}</h3>
        ${sousTitre ? `<span class="k-band-meta k-num">${sousTitre}</span>` : ''}
    </div>`;
}

// Grille des cartes d'un bloc de solutions (monosplit, mono dédié par pièce, groupes
// multisplit) : en une seule colonne empilée jusqu'ici quelle que soit la largeur d'écran, si
// bien qu'en tablette paysage — le format le plus courant sur le terrain (voir PRODUCT.md) —
// six cartes s'étirent sur près de 3000px de défilement pendant que la moitié de l'écran
// reste vide à côté du formulaire. `auto-fill` avec un minimum plutôt qu'un palier de largeur
// fixe : le nombre de colonnes se résout à la largeur RÉELLEMENT disponible pour ce bloc
// (colonne de droite du simulateur, ou pleine largeur du tableau de bord), pas à la largeur de
// la fenêtre — deux grandeurs différentes dès que le palier `duo` divise l'écran en deux. Un
// palier fixe aurait fallu être recalé à la main à chaque changement du ratio des colonnes.
function wrapGrilleResultats(cardsHtml) {
    return `<div class="k-results-grid">${cardsHtml}</div>`;
}

// Reconstruit l'affichage des résultats à partir de state.currentCalc + state.selection,
// sans relancer le calcul (utilisé quand l'utilisateur choisit une solution parmi les options).
// Fonction de LECTURE uniquement : ne modifie jamais state (voir seedGroupGammeDefaults / selectGroup
// pour la logique d'initialisation des choix par défaut).
// `anime` : réservé au premier rendu d'un calcul (calculate). Les rendus suivants — un
// choix d'option — rejouaient sinon le fondu de toute la colonne à chaque comparaison,
// devant le client. La classe est posée AVANT l'injection du HTML, sinon l'animation a
// déjà démarré au moment où le style s'applique.
function renderResults({ anime = false } = {}) {
    const resultsContainer = document.getElementById('results-container');
    resultsContainer.classList.toggle('k-sans-anim', !anime);
    const calc = state.currentCalc;
    if (!calc) { resultsContainer.innerHTML = etatVideResultats(); return; }

    let html = `<h2 class="k-section-title text-lg">Solutions recommandées</h2>`;
    html += calc.besoinsHtml + calc.hypothesesHtml;

    let summaryParts = [];
    let equipments = [];
    // Version STRUCTURÉE du matériel retenu, construite dans la même passe que `equipments`
    // et jamais ailleurs : c'est ici, et ici seulement, que le code sait quelle option est
    // sélectionnée (selIdx, state.selection.group, escalade, délestage). La reconstruire
    // depuis la fiche donnerait deux réponses possibles à la seule question que cet outil
    // doit trancher — quelle machine a été retenue.
    let materiel = { type: calc.mode === 'mono' ? 'mono' : 'multi', groupe: null, unites: [], monos: [], alertes: [] };

    if (calc.mode === 'mono') {
        const options = calc.mono.options;
        if (options.length === 0) {
            html += note('warn', 'alerte', 'Aucun monosplit du catalogue ne couvre ce niveau de puissance.');
        } else {
            const tvaInfos = options.map(sol => getTvaInfo(sol.gamme, sol.reference_ensemble, 'mono', state.brand));
            const tvaBloc = tvaCommune(tvaInfos);
            html += blocTitre('Monosplit', metaBloc(options.length, tvaBloc));
            const selIdx = Math.min(state.selection.mono || 0, options.length - 1);
            let cardsMono = '';
            options.forEach((sol, idx) => {
                const selectOpts = options.length > 1 ? { selected: idx === selIdx, onclick: `selectMono(${idx})` } : null;
                cardsMono += renderCard(idx === 0 ? 'Recommandé' : '', sol.gamme, sol.reference_ensemble, sol.puissance_froid_kw, sol.puissance_chaud_kw, false, [], selectOpts, tvaInfos[idx], { reqFroid: calc.req.froid, reqChaud: calc.mono.froidSeul ? null : calc.req.chaud }, { tvaMasquee: tvaBloc.commun });
            });
            html += wrapGrilleResultats(cardsMono);
            const chosen = options[selIdx];
            const chosenTva = getTvaInfo(chosen.gamme, chosen.reference_ensemble, 'mono', state.brand);
            summaryParts.push(`1x Mono ${chosen.gamme}`);
            equipments.push(`Modèle sélectionné : ${chosen.gamme} (${chosen.reference_ensemble})${options.length > 1 ? ` — ${options.length - 1} autre${options.length > 2 ? 's' : ''} option${options.length > 2 ? 's' : ''} disponible${options.length > 2 ? 's' : ''}` : ''}${tvaSuffixText(chosenTva)}`);
            materiel.monos.push({
                piece: 1, nom: state.rooms[0].nom || '',
                gamme: chosen.gamme, reference: chosen.reference_ensemble,
                froidKw: chosen.puissance_froid_kw, chaudKw: chosen.puissance_chaud_kw,
                besoin: { froid: calc.req.froid, chaud: calc.mono.froidSeul ? 0 : calc.req.chaud },
                tva: chosenTva
            });
        }
    } else {
        const m = calc.multi;

        if (m.hybridNote) {
            html += note('neutral', 'scinder', `<span class="k-note-title">Architecture hybride</span> — un monosplit dédié pour la ou les plus grandes pièces, un multisplit pour le reste.`);
        }

        m.dedicated.forEach(dedItem => {
            const room = dedItem.room;
            const options = dedItem.options;
            if (options.length > 0) {
                const tvaInfos = options.map(sol => getTvaInfo(sol.gamme, sol.reference_ensemble, 'mono', state.brand));
                const tvaBloc = tvaCommune(tvaInfos);
                html += blocTitre(escapeHtml(dedItem.label), metaBloc(options.length, tvaBloc));
                // Bouton de retour proposé uniquement pour une séparation VOLONTAIRE (voir
                // separerPieceEnDedie) : une pièce délestée parce qu'elle dépasse le catalogue
                // (forcedDedicatedIds ne la contient pas) n'a nulle part où être réintégrée.
                if (state.forcedDedicatedIds.has(room.id)) {
                    html += `<button type="button" onclick="reintegrerPieceAuGroupe(${room.id})" class="k-btn-ghost -mt-2 mb-3">${icone('chevron', 'w-3.5 h-3.5 rotate-90')}Réintégrer au groupe multisplit</button>`;
                }
                const selIdx = Math.min(state.selection.dedicated[room.index] || 0, options.length - 1);
                let cardsDed = '';
                options.forEach((sol, idx) => {
                    const selectOpts = options.length > 1 ? { selected: idx === selIdx, onclick: `selectDedicated(${room.index}, ${idx})` } : null;
                    cardsDed += renderCard(idx === 0 ? 'Recommandé' : '', sol.gamme, sol.reference_ensemble, sol.puissance_froid_kw, sol.puissance_chaud_kw, false, [], selectOpts, tvaInfos[idx], { reqFroid: room.req.froid, reqChaud: m.froidSeul ? null : room.req.chaud }, { tvaMasquee: tvaBloc.commun });
                });
                html += wrapGrilleResultats(cardsDed);
                const chosen = options[selIdx];
                const chosenTva = getTvaInfo(chosen.gamme, chosen.reference_ensemble, 'mono', state.brand);
                summaryParts.push(`1x Mono ${chosen.gamme}`);
                equipments.push(`${dedItem.label} — Modèle sélectionné : ${chosen.gamme} (${chosen.reference_ensemble})${tvaSuffixText(chosenTva)}`);
                materiel.monos.push({
                    piece: room.index, nom: room.nom || '',
                    gamme: chosen.gamme, reference: chosen.reference_ensemble,
                    froidKw: chosen.puissance_froid_kw, chaudKw: chosen.puissance_chaud_kw,
                    besoin: { froid: room.req.froid, chaud: m.froidSeul ? 0 : room.req.chaud },
                    tva: chosenTva
                });
            } else {
                html += note('warn', 'alerte', `<span class="k-note-title">Pièce ${room.index}</span> — puissance requise (${nb(room.maxKw)} kW) hors catalogue.`);
                equipments.push(`Pièce ${room.index} : Aucune machine assez puissante`);
                materiel.alertes.push(`Pièce ${room.index}${room.nom ? ` (${room.nom})` : ''} : puissance requise (${nb(room.maxKw)} kW) hors catalogue — aucune machine assez puissante.`);
            }
        });

        if (m.groupOptions.length > 0) {
            // Les tailles d'UI sortaient en pastilles nues — « 13 · 05 · 05 » — sur la carte
            // du groupe : des codes catalogue zéro-paddés, sans unité et sans rattachement à
            // une pièce, à recopier de tête sur le bon de commande. Elles portent désormais
            // le nom de la pièce à laquelle elles se raccordent.
            const sizesArr = m.standardRooms.map(r => ({ label: roomLabel(r), size: r.size }));
            const groupReqFroid = m.standardRooms.reduce((sum, r) => sum + r.req.froid, 0);
            const groupReqChaud = m.standardRooms.reduce((sum, r) => sum + r.req.chaud, 0);
            const selIdx = Math.min(state.selection.groupChoice || 0, m.groupOptions.length - 1);
            const bestGroup = m.groupOptions[selIdx];

            // Note d'équilibre du groupe RETENU (et non plus du plus petit groupe valide) : elle
            // suit donc le choix de l'utilisateur quand il passe d'une option à l'autre.
            const equilibre = analyseEquilibreGroupe(m, bestGroup);

            const tvaInfosGroupe = m.groupOptions.map(g => getGroupTvaInfo(g.reference, state.brand));
            const tvaBlocGroupe = tvaCommune(tvaInfosGroupe);
            html += blocTitre(`Groupe multisplit · ${m.standardRooms.length} sorties`, metaBloc(m.groupOptions.length, tvaBlocGroupe));
            if (equilibre) html += renderBalanceNote(equilibre);

            // La référence commandée passe en titre de carte, « Groupe extérieur » en sous-titre :
            // toutes les cartes s'intitulaient « Groupe Extérieur » et ne se distinguaient que par
            // la ligne grise en dessous — soit exactement l'inverse de ce qu'on compare ici.
            let cardsGroupe = '';
            m.groupOptions.forEach((g, idx) => {
                const selectOpts = m.groupOptions.length > 1 ? { selected: idx === selIdx, onclick: `selectGroup(${idx})` } : null;
                const estEquilibre = m.groupEquilibre && g.reference === m.groupEquilibre.reference;
                const badge = estEquilibre ? 'Équilibré' : (idx === 0 ? 'Recommandé' : '');
                cardsGroupe += renderCard(badge, g.reference, 'Groupe extérieur', g.puissance_nominale_froid_kw, g.puissance_nominale_chaud_kw, true, sizesArr, selectOpts, tvaInfosGroupe[idx], { reqFroid: groupReqFroid, reqChaud: m.froidSeul ? null : groupReqChaud }, { tvaMasquee: tvaBlocGroupe.commun });
            });
            html += wrapGrilleResultats(cardsGroupe);
            html += renderMultiRoomsGuide(m.standardRooms, bestGroup);
            summaryParts.push(`1x Multi ${bestGroup.reference} (${m.standardRooms.length} UI)`);
            if (equilibre) equipments.push(`Équilibre du groupe : ${equilibre.resume} ${equilibre.detail}`);

            const uiChoices = m.standardRooms.map(r => {
                const selGamme = state.selection.group[r.index];
                const info = selGamme ? getRoomSelectedTvaInfo(r, selGamme, bestGroup.gammes_compatibles, state.brand, bestGroup.reference) : null;
                return `Pièce ${r.index} (taille ${r.size}) : ${selGamme || '—'}${tvaSuffixText(info)}`;
            }).join(' / ');
            equipments.push(`Groupe Extérieur ${bestGroup.reference} — Unités sélectionnées : ${uiChoices}`);

            materiel.groupe = {
                reference: bestGroup.reference,
                froidKw: bestGroup.puissance_nominale_froid_kw,
                chaudKw: bestGroup.puissance_nominale_chaud_kw,
                sorties: m.standardRooms.length,
                besoin: { froid: groupReqFroid, chaud: m.froidSeul ? 0 : groupReqChaud },
                // Les coefficients qui ont RENDU ce groupe éligible (voir findGroupesValides) :
                // sans eux, la fiche opposerait un besoin cumulé à une puissance nominale plus
                // petite, et donnerait à lire comme un sous-dimensionnement ce qui est un choix
                // de conception assumé — les pièces n'appellent pas leur pointe au même instant.
                foisonnement: { froid: COEF_FOISONNEMENT_FROID, chaud: COEF_FOISONNEMENT_CHAUD },
                tva: tvaInfosGroupe[selIdx]
            };
            materiel.unites = m.standardRooms.map(r => {
                const selGamme = state.selection.group[r.index];
                return {
                    piece: r.index, nom: r.nom || '', taille: r.size, gamme: selGamme || null,
                    tva: selGamme ? getRoomSelectedTvaInfo(r, selGamme, bestGroup.gammes_compatibles, state.brand, bestGroup.reference) : null
                };
            });
            if (equilibre) materiel.alertes.push(`${equilibre.resume} ${equilibre.detail}`);
        }
        if (m.hybridNote) materiel.type = 'hybride';
    }

    state.lastResultData = {
        summaryText: summaryParts.join(' | '),
        equipments: equipments,
        roomDetails: calc.roomDetails,
        materiel: materiel
    };

    // Impasse : aucune option n'a abouti nulle part (mono hors catalogue, ou en multi aucune
    // pièce déléstée ni aucun groupe valide). Auparavant l'artisan ne voyait que les 1-2 lignes
    // oranges ci-dessus, sans piste : ni le bloc Imprimer/Partager (rien à exporter) ni le bloc
    // Enregistrer (rien à sauvegarder) ne s'affichaient, l'écran s'arrêtait net.
    if (!state.lastResultData.summaryText) {
        html += `
        <div class="k-card fade-in">
            <h3 class="text-sm font-semibold text-ink-900 mb-2">Aucune solution ne ressort du catalogue ${escapeHtml(libelleMarque(state.brand))} pour cette configuration.</h3>
            <p class="k-hint mb-2">Pistes à essayer :</p>
            <ul class="k-hint flex flex-col gap-1.5 list-disc pl-4 marker:text-ink-400">
                <li>vérifier le niveau d'isolation saisi — une valeur trop pessimiste gonfle le besoin calculé ;</li>
                <li>en multisplit, redécouper une grande pièce en plusieurs zones plutôt qu'une seule pièce surdimensionnée ;</li>
                <li>repasser en « Froid seul » si seul le besoin chauffage dépasse le catalogue.</li>
            </ul>
        </div>`;
    }

    if (state.lastResultData.summaryText) {
        html += `
        <div class="k-card fade-in mt-2">
            <h3 class="k-section-title mb-4">Exporter la fiche</h3>
            <div class="mb-4">
                <label for="save-installateur" class="k-label">Identité installateur (apparaît sur le PDF)</label>
                <input type="text" id="save-installateur" oninput="persistInstallateur(this.value)" value="${escapeHtml(getInstallateur())}" placeholder="Ex : Dupont Climatisation — 06 12 34 56 78" class="k-input">
            </div>
            <div class="flex flex-col sm:flex-row gap-3">
                <button onclick="exportFiche('travail')" class="k-btn-outline flex-1">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2-10V5a2 2 0 012-2h2a2 2 0 012 2v2M7 17v2a2 2 0 002 2h6a2 2 0 002-2v-2"></path></svg>
                    Fiche de travail
                </button>
                <button onclick="exportFiche('client')" class="k-btn-outline flex-1">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
                    Rapport client
                </button>
                <button onclick="shareResults()" class="k-btn-ghost">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M8.7 10.7a3 3 0 100 2.6m0-2.6l6.6-3.4m-6.6 6l6.6 3.4M18 8a3 3 0 100-6 3 3 0 000 6zm0 14a3 3 0 100-6 3 3 0 000 6z"></path></svg>
                    Partager
                </button>
            </div>
            <p class="k-hint mt-2.5">La fiche de travail porte le détail des calculs, pour monter le devis. Le rapport client justifie la puissance et le matériel retenus.</p>
        </div>
        <div class="k-card fade-in">
            <h3 class="k-section-title mb-4">Enregistrer au chantier</h3>
            ${state.loadedConfigId ? `
            <div class="k-note mb-4 items-center justify-between gap-3 flex-wrap">
                <span class="min-w-0">Configuration chargée — vous pouvez la mettre à jour au lieu d'en créer une nouvelle.</span>
                <button onclick="oublierConfigChargee()" class="k-btn-outline min-h-[44px] px-3 text-2xs whitespace-nowrap flex-shrink-0">Nouvelle fiche</button>
            </div>` : ''}
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                <div>
                    <label for="save-client" class="k-label">Nom du client / projet</label>
                    <input type="text" id="save-client" list="client-list" placeholder="Ex : Dupont" class="k-input">
                    <datalist id="client-list"></datalist>
                </div>
                <div>
                    <label for="save-zone" class="k-label">Désignation de la zone</label>
                    <input type="text" id="save-zone" placeholder="Ex : RDC, Étage, Salon…" class="k-input">
                </div>
            </div>
            <div class="flex flex-col sm:flex-row gap-3">
                <button onclick="saveChantier()" class="${state.loadedConfigId ? 'k-btn-outline' : 'k-btn-dark'} flex-1">
                    Enregistrer comme nouvelle fiche
                </button>
                ${state.loadedConfigId ? `
                <button onclick="updateChantier()" class="k-btn-primary flex-1">
                    Mettre à jour cette fiche
                </button>` : ''}
            </div>
            <div id="save-msg" class="mt-3 text-xs font-semibold text-center hidden"></div>
        </div>
        `;
    }

    resultsContainer.innerHTML = html;
    populateClientDatalist();
}

// --- Export / partage --------------------------------------------------------------------
//
// Aucune dépendance ajoutée : l'export s'appuie sur l'impression native du navigateur (une
// feuille @media print isole #print-area, voir index.html), et le partage sur la Web Share
// API avec repli mailto:.
//
// Ces fonctions ne sont plus qu'un PONT : rassembler la fiche, demander son gabarit à
// js/fiche.js, injecter, imprimer. Toute la mise en forme vit dans un module pur, ce qui la
// rend testable — et ce qui permet d'imprimer une fiche ENREGISTRÉE, chemin qui ne peut lire
// aucun champ du formulaire puisque le formulaire porte la saisie en cours.

// Injecte un gabarit dans la zone d'impression et déclenche l'impression.
// La classe est posée sur #print-area lui-même : c'est elle qui choisit le gabarit côté CSS
// (.pf--travail masque la prose, .pf--client masque les tableaux techniques).
function imprimerFiche(fiche, variante) {
    if (!fiche) return;
    const zone = document.getElementById('print-area');
    zone.className = `pf pf--${variante}`;
    zone.innerHTML = variante === 'client' ? gabaritClient(fiche) : gabaritTravail(fiche);
    window.print();
}

function exportFiche(variante) {
    imprimerFiche(ficheCourante(), variante);
}

// Export depuis une fiche ENREGISTRÉE, sans passer par un rechargement. Recharger relancerait
// un calcul complet, qui peut proposer un autre matériel si le catalogue a bougé depuis ;
// imprimer depuis la fiche stockée imprime ce qui a été DÉCIDÉ — la bonne sémantique pour un
// document. Fonctionne donc aussi sur une fiche enregistrée sous une marque retirée, qui reste
// consultable sans être rechargeable (voir reloadConfig).
function exporterFicheEnregistree(id, variante) {
    const cfg = store.getConfig(id);
    if (!cfg) return;
    const { fiche, palier } = ficheDepuisBody(cfg);
    // Palier 3 : aucune donnée structurée exploitable. Le rapport client n'est pas proposé dans
    // ce cas (le bouton n'est pas rendu), et la fiche de travail retombe sur le contenu texte
    // enregistré plutôt que sur rien.
    if (!fiche) {
        if (variante === 'client') return;
        imprimerFiche(ficheTexteDegradee(cfg), 'travail');
        return;
    }
    if (palier === 3) return;
    imprimerFiche(fiche, variante);
}

// Dernier recours : une fiche ancienne dont il ne reste que les chaînes déjà formatées.
// On imprime ce qu'on a, en le disant, plutôt que de refuser d'imprimer.
function ficheTexteDegradee(cfg) {
    return {
        origine: 'calcul',
        moteur: null,
        hypotheses: { corrections: [] },
        bilan: { froid: null, chaud: null },
        pieces: [],
        materiel: null,
        equipementsEnregistres: [...(cfg.roomDetails || []), ...(cfg.equipments || [])],
        identite: {
            client: cfg.clientName || '', zone: cfg.zone || '', dateStr: cfg.date || '',
            installateur: getInstallateur(),
            brandLabel: BRAND_LABELS[cfg.brand] || cfg.brand || '',
            modeLabel: cfg.mode === 'mono' ? 'Monosplit' : 'Multisplit'
        }
    };
}

function shareResults() {
    const lignes = lignesPartage(ficheCourante());
    if (lignes.length === 0) return;
    const text = lignes.join('\n');
    const client = (document.getElementById('save-client') || {}).value?.trim() || '';

    if (navigator.share) {
        navigator.share({ title: 'Klimo — Dimensionnement', text }).catch(() => {});
    } else {
        const subject = encodeURIComponent(`Klimo — Dimensionnement${client ? ' — ' + client : ''}`);
        window.location.href = `mailto:?subject=${subject}&body=${encodeURIComponent(text)}`;
    }
}

// --- Préservation de l'état d'interface à travers un rendu -------------------------
//
// renderResults() reconstruit tout le bloc résultats par innerHTML : c'est ce qui le
// garde purement fonction de l'état, et c'est très bien. Mais chaque choix d'option
// emportait avec lui tout ce que l'utilisateur avait ouvert ou saisi dedans — dépliants
// « Guide de la gamme », explications TVA, détail d'une correction, champs Client /
// Zone —, ainsi que le focus clavier et la position de défilement. Comparer deux
// machines refermait donc la fiche qu'on venait justement d'ouvrir pour les comparer.
//
// Seuls les champs Client / Zone étaient rattrapés jusqu'ici, un à un. On capture
// maintenant l'ensemble avant le rendu et on le repose après, via les clés stables
// `data-k` portées par les éléments concernés.
function capturerEtatUi(racine) {
    const actif = document.activeElement;
    return {
        ouverts: new Set([...racine.querySelectorAll('details[data-k][open]')].map(d => d.dataset.k)),
        focus: actif && racine.contains(actif) ? (actif.dataset.k || null) : null,
        defilement: window.scrollY,
        champs: [...racine.querySelectorAll('input[id]')].map(i => [i.id, i.value])
    };
}

function restaurerEtatUi(racine, etat) {
    racine.querySelectorAll('details[data-k]').forEach(d => { d.open = etat.ouverts.has(d.dataset.k); });
    etat.champs.forEach(([id, valeur]) => {
        const el = document.getElementById(id);
        if (el) el.value = valeur;
    });
    if (etat.focus) {
        const cible = racine.querySelector(`[data-k="${CSS.escape(etat.focus)}"]`);
        if (cible) cible.focus();
    }
    // Le contenu peut changer de hauteur (choisir un autre groupe extérieur réécrit le
    // guide des unités intérieures) : sans ça, la page glisse sous les doigts au moment
    // même où l'on désigne une machine.
    window.scrollTo({ top: etat.defilement });
}

function avecEtatUiPreserve(mutateFn) {
    const racine = document.getElementById('results-container');
    if (!racine) { mutateFn(); return; }
    const etat = capturerEtatUi(racine);
    mutateFn();
    restaurerEtatUi(racine, etat);
}

function selectMono(idx) {
    avecEtatUiPreserve(() => { state.selection.mono = idx; renderResults(); });
}
function selectDedicated(roomIndex, idx) {
    avecEtatUiPreserve(() => { state.selection.dedicated[roomIndex] = idx; renderResults(); });
}
function selectGroupGamme(roomIndex, gamme) {
    avecEtatUiPreserve(() => { state.selection.group[roomIndex] = gamme; renderResults(); });
}
// Changer de groupe extérieur peut changer les gammes d'UI compatibles (ex: Panasonic Multi TZ
// vs Multi Z Deluxe) : on re-seede les choix par défaut pour rester cohérent, en préservant le
// choix de l'utilisateur là où il reste valide pour le nouveau groupe (voir seedGroupGammeDefaults).
function selectGroup(idx) {
    avecEtatUiPreserve(() => {
        state.selection.groupChoice = idx;
        const m = state.currentCalc && state.currentCalc.multi;
        if (m && m.groupOptions[idx]) {
            seedGroupGammeDefaults(m.standardRooms, m.groupOptions[idx].gammes_compatibles);
        }
        renderResults();
    });
}

// Sort une pièce du groupe multisplit pour lui donner son propre monosplit dédié, quand cette
// pièce mobilise une part disproportionnée de la puissance du groupe (voir analyseEquilibreGroupe)
// et qu'aucun groupe plus puissant du catalogue ne corrige l'écart. Recalcule entièrement
// (calculate()) plutôt que de retoucher state.currentCalc en place : sortir une pièce change la
// répartition standardRooms/extractedForMono et donc le groupe extérieur lui-même, pas seulement
// l'affichage d'une carte.
function separerPieceEnDedie(roomId) {
    state.forcedDedicatedIds.add(roomId);
    calculate();
}

// Réintègre une pièce précédemment séparée manuellement (voir separerPieceEnDedie) au groupe
// multisplit. Sans objet pour une pièce délestée automatiquement (hors catalogue) : le bouton
// n'est proposé que sur les cartes issues de forcedDedicatedIds (voir renderResults).
function reintegrerPieceAuGroupe(roomId) {
    state.forcedDedicatedIds.delete(roomId);
    calculate();
}

function renderBesoinsCard(reqs, isMulti = false, roomsData = []) {
    let totF = reqs.reduce((a, b) => a + b.froid, 0);
    let totC = reqs.reduce((a, b) => a + b.chaud, 0);
    let details = '';
    if (isMulti) {
        details = `<div class="mt-3 pt-3 k-divider flex flex-col gap-1.5">` +
            roomsData.map(r => `<div class="flex justify-between gap-3 text-2xs"><span class="text-ink-500 min-w-0 truncate">Pièce ${r.index}${r.nom ? ' — ' + escapeHtml(r.nom) : ''}</span><span class="text-ink-700 k-num whitespace-nowrap">${nb(r.req.froid)} kW F · ${nb(r.req.chaud)} kW C</span></div>`).join('') + `</div>`;
    }
    // Même vocabulaire visuel que les puissances des cartes (tuiles froid/chaud de largeur
    // égale) : le besoin calculé et la puissance machine se lisent alors dans la même unité
    // de mise en forme, ce qui est précisément la comparaison que l'artisan fait des yeux.
    return `<div class="k-card">
        <span class="k-eyebrow">Bilan thermique cumulé</span>
        <div class="grid grid-cols-2 gap-2 mt-2">
            <div class="k-stat k-stat-froid">
                <span class="k-stat-label">Besoin froid</span>
                <span class="k-stat-value">${nb(totF, 2)} kW</span>
            </div>
            <div class="k-stat k-stat-chaud">
                <span class="k-stat-label">Besoin chaud</span>
                <span class="k-stat-value">${nb(totC, 2)} kW</span>
            </div>
        </div>
        ${details}
    </div>`;
}

// Contenu factuel de la fiche gamme (idéal pour / plus / moins / wifi). Réutilisé en mono (dépliant) et en multi (chips par pièce).
function gammeGuideContent(gammeName) {
    const g = GAMMES_INFO[state.brand]?.[gammeName];
    if (!g) return '';
    const wifiColor = g.wifi === 'De série' ? 'text-emerald-700' : 'text-amber-700';
    return `
    <div class="flex flex-col gap-2.5 text-2xs leading-relaxed">
        <div class="bg-mute-50 rounded-xl border border-line p-3 text-ink-700">
            <span class="k-eyebrow block mb-0.5">Idéal pour</span>${g.ideal}
        </div>
        <ul class="flex flex-col gap-1.5">
            ${g.plus.map(p => `<li class="flex items-start gap-2 text-ink-700"><span class="text-emerald-600 mt-0.5">${icone('check', 'w-3.5 h-3.5')}</span><span>${p}</span></li>`).join('')}
            ${g.moins.map(m => `<li class="flex items-start gap-2 text-ink-700"><span class="text-amber-600 mt-0.5">${icone('moins', 'w-3.5 h-3.5')}</span><span>${m}</span></li>`).join('')}
        </ul>
        <div class="text-ink-500">Wifi : <span class="${wifiColor} font-semibold">${g.wifi}</span></div>
    </div>`;
}

// Fiche "carte d'identité" de la gamme, dépliable sous la carte résultat. Retourne '' si gamme inconnue.
function renderGammeGuide(gammeName) {
    const g = GAMMES_INFO[state.brand]?.[gammeName];
    if (!g) return '';
    // Le positionnement de gamme (€, €€€, « haut de gamme design »…) sort du dépliant : c'est
    // un critère de choix, il doit être lisible carte fermée et non après un geste de plus.
    // Le positionnement de gamme ne figure plus ici : il est remonté en clair sous la
    // référence, dans la tête de carte (voir renderCard). Logé dans ce résumé, il passait à
    // la ligne dès que la colonne se resserrait, et le seul critère commercial lisible carte
    // fermée était donc aussi le seul à casser.
    return `
    <details data-k="guide:${gammeName}" class="mt-3 pt-3 k-divider group/guide">
        <summary class="k-disclosure">
            ${icone('info')}
            <span>Guide de la gamme</span>
            <span class="ml-auto transition-transform group-open/guide:rotate-180">${icone('chevron')}</span>
        </summary>
        <div class="mt-3">${gammeGuideContent(gammeName)}</div>
    </details>`;
}

// Guide de sélection des UI en multisplit : pour chaque pièce du groupe, les gammes éligibles
// pour son besoin réel, avec fiche dépliable. Fonction de LECTURE uniquement : les gammes
// éligibles sont recalculées via getRoomEligibleGammes (calcul.js) et la sélection courante
// (state.selection.group) est supposée déjà valide, seedée par calculate()/selectGroup() —
// jamais mutée ici (contrairement à l'ancienne implémentation).
// group : le groupe extérieur retenu — c'est lui qui porte l'éligibilité TVA en multisplit
// (voir TVA_RULES.multi), en plus de restreindre éventuellement les gammes d'UI compatibles.
function renderMultiRoomsGuide(roomsData, group) {
    const allowedGammes = group.gammes_compatibles;
    const rows = roomsData.map(r => {
        const gammesUniques = getRoomEligibleGammes(r, allowedGammes, state.brand);
        if (gammesUniques.length === 0) {
            return `<div class="py-3 border-b border-line last:border-0 text-xs text-amber-800">Pièce ${r.index} : aucune UI du catalogue ne couvre ce besoin.</div>`;
        }
        const sols = findRoomMultiSolutions(r.froidMatch, r.chaudMatch, state.brand);
        const storedGamme = state.selection.group[r.index];
        const selectedGamme = gammesUniques.includes(storedGamme) ? storedGamme : gammesUniques[0];
        // Statut TVA de CETTE pièce : masqué sur les pastilles quand toutes les gammes
        // éligibles partagent le même, ce qui est le cas courant en multisplit — l'éligibilité
        // y est portée par le groupe extérieur, donc identique pour toutes les unités qui s'y
        // raccordent (voir TVA_RULES.multi). Douze pastilles vertes strictement identiques
        // couvraient l'écran pendant que l'artisan y cherchait ce qui sépare les gammes.
        const tvaParGamme = gammesUniques.map(g => {
            const solForG = sols.find(s => s.gamme === g);
            return getTvaInfo(g, solForG.reference_ensemble, 'multiUi', state.brand, group.reference);
        });
        const tvaBlocPiece = tvaCommune(tvaParGamme);

        const chips = gammesUniques.map((g, i) => {
            const isSel = g === selectedGamme;
            const gEsc = g.replace(/'/g, "\\'");
            // Chaque gamme devient une colonne autonome (bouton de choix, statut TVA quand il
            // se distingue, détails) au lieu d'une file de pastilles dont les « Détails » se
            // retrouvaient alignés en bas sans qu'on sache plus lequel appartenait à laquelle.
            return `
            <div class="flex flex-col items-start gap-1.5 min-w-0">
                <button type="button" onclick="selectGroupGamme(${r.index}, '${gEsc}')" aria-pressed="${isSel}" data-k="chip:${r.index}:${g}" class="k-chip">
                    ${isSel ? icone('check', 'w-3.5 h-3.5') : ''}${g}
                </button>
                ${tvaBlocPiece.commun ? '' : `<div class="flex flex-wrap gap-1.5">${renderTvaBadge(tvaParGamme[i], `${r.index}:${g}`)}</div>`}
                <details data-k="gamme:${r.index}:${g}" class="group/mg" onclick="event.stopPropagation()">
                    <summary class="k-disclosure text-2xs font-medium group/d">Détails<span class="transition-transform group-open/d:rotate-180">${icone('chevron', 'w-3 h-3')}</span></summary>
                    <div class="mt-2 mb-1">${gammeGuideContent(g)}</div>
                </details>
            </div>`;
        }).join('');
        return `
        <div class="py-4 border-b border-line last:border-0 last:pb-0">
            <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 mb-3">
                <span class="text-xs font-semibold text-ink-900">Pièce ${r.index}${r.nom ? ' — ' + escapeHtml(r.nom) : ''}</span>
                <span class="text-2xs text-ink-500 k-num">${nb(r.req.froid)} kW F · ${nb(r.req.chaud)} kW C${tvaBlocPiece.commun ? ` · ${mentionTvaBloc(tvaBlocPiece, 1)}` : ''}</span>
            </div>
            <div class="flex flex-wrap gap-x-5 gap-y-3">${chips}</div>
        </div>`;
    }).join('');

    return `
    <div class="k-card fade-in">
        <h3 class="k-section-title">Unités intérieures</h3>
        <p class="k-hint mt-1.5">Une gamme par pièce, mixables sur le même groupe.</p>
        <details data-k="tva-multi" class="mt-2 group/tva">
            <summary class="k-disclosure text-2xs font-medium text-ink-400">
                <span>TVA 5,5 % en multisplit</span>
                <span class="text-ink-400 transition-transform group-open/tva:rotate-180">${icone('chevron', 'w-3.5 h-3.5')}</span>
            </summary>
            <p class="k-hint mt-1.5">Portée par le groupe extérieur : toutes les unités raccordées à un groupe éligible en bénéficient, sans condition de module Wifi — y compris les gammes et tailles refusées en monosplit (Naka, Yukai 18 et 24).${allowedGammes ? ` Gammes compatibles avec ce groupe : ${escapeHtml(allowedGammes.join(', '))}.` : ''}</p>
        </details>
        <div class="mt-3">${rows}</div>
    </div>`;
}

// "Pièce 2" ou "Pièce 2 (Salon)" — libellé court en texte brut (échappé au moment du rendu HTML,
// jamais ici : le même libellé alimente aussi l'export PDF / le partage, qui échappent de leur côté).
function roomLabel(room) {
    return `Pièce ${room.index}${room.nom ? ` (${room.nom})` : ''}`;
}

// Équilibre du groupe extérieur retenu : un compresseur unique alimente toutes les UI, donc une
// pièce qui absorbe l'essentiel de la puissance nominale peut priver les autres en cas de demande
// simultanée (seuil SEUIL_DESEQUILIBRE_GROUPE, générique : pas de donnée constructeur de ratio de
// raccordement par référence). Trois situations, au lieu de la seule alerte d'avant :
//   - 'ok'       : le groupe proposé par l'escalade est retenu -> on explique ce qu'il corrige ;
//   - 'escalade' : un groupe déséquilibré est retenu alors qu'un groupe rééquilibrant existe ;
//   - 'alerte'   : déséquilibré et aucun groupe du catalogue ne rééquilibre -> monosplit dédié.
// Retourne null quand il n'y a rien à signaler. Message en texte brut (voir roomLabel).
function analyseEquilibreGroupe(m, selectedGroup) {
    const rooms = m.standardRooms;
    if (!selectedGroup || rooms.length < 2) return null;
    // Pièce dominante EN PART DU GROUPE, et non en kW bruts : c'est celle dont le pourcentage est
    // affiché juste à côté. Les deux notions divergent réellement (une pièce dominée par le froid
    // pèse sur une capacité plus petite qu'une pièce dominée par le chaud), et nommer l'une en
    // citant le pourcentage de l'autre serait un message faux.
    const dominante = pieceDominantePourGroupe(selectedGroup, rooms);
    if (!dominante) return null;

    const pct = ratio => Math.round(ratio * 100);
    const seuilPct = pct(SEUIL_DESEQUILIBRE_GROUPE);
    const ratioSel = ratioPieceDominante(selectedGroup, rooms);
    const equil = m.groupEquilibre;
    const puissances = g => `${g.puissance_nominale_froid_kw} kW F / ${g.puissance_nominale_chaud_kw} kW C`;

    if (equil && selectedGroup.reference === equil.reference) {
        // L'escalade n'existe que si le groupe juste dimensionné était déséquilibré : il est
        // forcément présent dans les options, juste après celui-ci.
        const justeDimensionne = m.groupOptions.find(g => g.reference !== equil.reference);
        const detailBase = justeDimensionne
            ? ` Sur le ${justeDimensionne.reference}, juste dimensionné, elle en absorbait ${pct(ratioPieceDominante(justeDimensionne, rooms))}% : cette référence reste sélectionnable si le budget primait, en acceptant la limite en demande simultanée.`
            : '';
        // Monter d'un cran fait mécaniquement baisser le taux de charge, parfois sous le seuil qui
        // déclenche le badge « surdimensionné » juste en dessous. C'est un arbitrage assumé (un
        // déficit en demande simultanée coûte plus cher qu'un léger surdimensionnement), mais tu
        // laisserais sinon deux messages se contredire à l'écran sans explication.
        const besoinFroid = rooms.reduce((sum, r) => sum + r.req.froid, 0);
        const besoinChaud = m.froidSeul ? 0 : rooms.reduce((sum, r) => sum + r.req.chaud, 0);
        const charge = tauxChargeGroupe(selectedGroup, besoinFroid, besoinChaud);
        const detailSousCharge = charge.min < SEUIL_SOUS_CHARGE
            ? ` Ce cran supérieur fait tomber le taux de charge à ${pct(charge.min)}%, sous le seuil de ${pct(SEUIL_SOUS_CHARGE)}% signalé plus bas : c'est le prix assumé du rééquilibrage, un déficit en demande simultanée étant plus pénalisant qu'un surdimensionnement modéré.`
            : '';
        return {
            ton: 'ok',
            room: dominante,
            resume: `Un groupe plus puissant a été retenu pour que ${roomLabel(dominante)} ne mobilise plus que ${pct(ratioSel)}% du ${selectedGroup.reference} (repère : ${seuilPct}%).`,
            detail: `Ce cran supérieur a été choisi automatiquement pour que les autres pièces gardent leur puissance si toutes réclament leur maximum en même temps (canicule, grand froid).${detailBase}${detailSousCharge}`.trim()
        };
    }

    if (ratioSel > SEUIL_DESEQUILIBRE_GROUPE) {
        const solution = equil
            ? ` Le ${equil.reference} (${puissances(equil)}), proposé en premier choix, ramène cette part à ${pct(ratioPieceDominante(equil, rooms))}% ; séparer cette pièce sur son propre climatiseur est l'autre solution.`
            : ` Aucun groupe plus puissant du catalogue ne corrige cet écart : séparer cette pièce sur son propre climatiseur est la solution.`;
        return {
            ton: equil ? 'escalade' : 'alerte',
            room: dominante,
            resume: `Par forte chaleur ou grand froid, ${roomLabel(dominante)} peut priver les autres pièces de puissance.`,
            detail: `Elle mobilise à elle seule ${pct(ratioSel)}% de la puissance du ${selectedGroup.reference} — au-delà de ${seuilPct}%, les autres unités intérieures peuvent ne plus recevoir toute la leur si la demande est simultanée sur l'ensemble du groupe.${solution}`
        };
    }

    return null;
}

// Bandeau de la note d'équilibre, au-dessus des cartes de groupe extérieur (contrairement aux notes
// climat, elle dépend du groupe sélectionné : sa place est donc à côté des solutions concernées).
// Le résumé chiffré reste visible, le raisonnement est replié. La note faisait jusqu'à six
// lignes de prose au-dessus des cartes de groupe : l'arbitrage qu'elle explique est le plus
// technique de l'outil, mais il se vérifie d'abord sur un pourcentage et une limite — le reste
// se lit quand on conteste le choix, pas à chaque calcul.
function renderBalanceNote(analyse) {
    const styles = {
        ok:       { ton: 'ok',   icone: 'checkRond' },
        escalade: { ton: 'warn', icone: 'alerte' },
        alerte:   { ton: 'warn', icone: 'alerte' }
    }[analyse.ton];
    // Rend la recommandation actionnable plutôt que descriptive : « alerte » (aucun groupe ne
    // rééquilibre) l'affiche en action principale, « escalade »/« ok » (un groupe la corrige déjà)
    // l'affiche en alternative discrète — voir separerPieceEnDedie.
    const bouton = analyse.room ? `
        <button type="button" onclick="separerPieceEnDedie(${analyse.room.id})"
            class="${analyse.ton === 'alerte' ? 'k-btn-outline' : 'k-btn-ghost'} mt-2.5 w-full sm:w-auto">
            ${icone('scinder', 'w-3.5 h-3.5')}Séparer ${escapeHtml(roomLabel(analyse.room))} en monosplit dédié
        </button>` : '';
    return note(styles.ton, styles.icone, `
        <span class="k-note-title">${escapeHtml(analyse.resume)}</span>
        <details data-k="equilibre" class="mt-1">
            <summary class="k-disclosure text-2xs font-medium text-ink-400 group/b">En détail<span class="transition-transform group-open/b:rotate-180">${icone('chevron', 'w-3 h-3')}</span></summary>
            <p class="k-hint mt-1.5">${escapeHtml(analyse.detail)}</p>
        </details>${bouton}`);
}

// Taux de charge = besoin réel / puissance nominale catalogue. En dessous de ~50%, un
// inverter résidentiel cycle court (marche/arrêt fréquents) : confort et rendement réel
// dégradés malgré une puissance affichée confortable — d'où l'alerte, absente jusqu'ici.
//
// L'explication était jusqu'ici uniquement dans l'attribut title du ⚠️ — jamais visible au
// doigt sur mobile (pas de survol tactile fiable). Affichée ici en texte, sous le badge :
// un peu plus de place prise, mais lisible par l'artisan qui compte l'utiliser sur le terrain.
// Découpé en deux : la pastille rejoint la rangée de pastilles de la carte (TVA, Wifi), tandis
// que l'explication en toutes lettres reste une ligne à part entière sous cette rangée. Les
// deux étaient auparavant renvoyées collées, ce qui obligeait la carte à les insérer au même
// endroit et cassait l'alignement de la rangée dès qu'un avertissement apparaissait.
function tauxCharge(reqFroid, reqChaud, nominalFroid, nominalChaud) {
    if (!reqFroid || !nominalFroid) return null;
    const chargeF = reqFroid / nominalFroid;
    const chargeC = (reqChaud && nominalChaud) ? reqChaud / nominalChaud : null;
    const minCharge = chargeC !== null ? Math.min(chargeF, chargeC) : chargeF;
    return { chargeF, chargeC, sousCharge: minCharge < SEUIL_SOUS_CHARGE };
}

// Pied de carte : le besoin calculé face à la puissance nominale de la machine, sur UNE
// ligne. Le taux de charge n'y figure plus — il est monté dans les tuiles (voir renderCard),
// qui sont l'objet le plus visible de la carte et doivent porter le jugement le plus utile,
// pas la puissance nominale (quasi identique d'une option à l'autre, elle ne distinguait
// rien). Le kW nominal reste utile — c'est la donnée qu'on recopie sur un bon de commande —
// mais en pied, à côté du besoin qu'il couvre plutôt qu'en écriture géante.
function renderPiedMesures(chargeInfo, nominalFroid, nominalChaud) {
    if (!chargeInfo) return '';
    const aChaud = chargeInfo.reqChaud !== null && chargeInfo.reqChaud !== undefined;
    const besoin = `${nb(chargeInfo.reqFroid)} kW F${aChaud ? ` · ${nb(chargeInfo.reqChaud)} kW C` : ''}`;
    const nominal = `${nb(nominalFroid)} kW F · ${nb(nominalChaud)} kW C`;

    return `
    <div class="mt-3 pt-3 k-divider flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span class="text-2xs text-ink-500 k-num">Besoin ${besoin}</span>
        <span class="text-2xs font-semibold text-ink-700 k-num">Nominal ${nominal}</span>
    </div>`;
}

function renderSousChargeWarning(sousCharge) {
    if (!sousCharge) return '';
    return `<p class="text-2xs text-amber-800 mt-2.5 leading-relaxed">Surdimensionnée pour ce besoin : cycles courts, rendement réel dégradé.</p>`;
}

// selectOpts = null (carte simple, non sélectionnable) ou { selected: bool, onclick: string }
// quand plusieurs solutions équivalentes sont proposées et que l'utilisateur doit en choisir une.
// Carte d'une solution. Réorganisée autour de ce qu'un installateur y cherche dans l'ordre :
// le nom de la gamme, sa référence commandable, le jugement le plus utile, puis les
// conditions (TVA, Wifi) et enfin la fiche de gamme dépliable.
//
// Quatre changements de fond par rapport à la version précédente :
//   - les tuiles portent désormais le TAUX DE CHARGE (besoin / puissance machine), pas la
//     puissance nominale : sur un jeu d'options catalogue, la puissance nominale varie peu
//     (3,3 à 3,5 kW sur six modèles n'est pas ce qui les distingue), alors que la charge dit
//     directement si la machine est à la bonne taille — c'est le jugement que l'artisan porte
//     en comparant les cartes, il mérite l'objet le plus visible plutôt que l'arithmétique
//     mentale. Le kW nominal descend en pied, à côté du besoin qu'il couvre ;
//   - l'option non retenue n'est plus délavée (`opacity-60 saturate-50`) mais rendue en plein
//     contraste : ce sont les options à comparer, les effacer va contre leur raison d'être.
//     La sélection se lit à la bordure, à l'anneau et à la puce cochée ;
//   - le filigrane décoratif en coin est retiré : il n'apportait rien et passait sous du texte ;
//   - même largeur de tuile, mêmes couleurs froid/chaud qu'avant : la lecture reste la même
//     geste, seul ce qu'elle mesure change.
function renderCard(badgeText, mainTitle, subtitle, froid, chaud, isMulti = false, sizes = [], selectOpts = null, tvaInfo = null, chargeInfo = null, { tvaMasquee = false } = {}) {
    let footer = '';
    if (isMulti) {
        // Une taille par pièce, nommée : c'est cette correspondance-là qui part sur le bon
        // de commande, et elle n'existait nulle part à l'écran.
        footer = `<div class="mt-4 pt-4 k-divider">
            <span class="k-eyebrow">Unités à connecter</span>
            <div class="mt-2 flex flex-col gap-1">
                ${sizes.map(s => `<div class="flex items-baseline justify-between gap-3 text-2xs">
                    <span class="text-ink-600 min-w-0 truncate">${escapeHtml(s.label)}</span>
                    <span class="font-semibold text-ink-900 k-num whitespace-nowrap">taille ${escapeHtml(String(s.size))}</span>
                </div>`).join('')}
            </div>
        </div>`;
    }

    let wrapperClasses = 'k-result fade-in';
    let attrs = '';
    let gammeGuideBlock = renderGammeGuide(mainTitle);
    let radio = '';

    if (selectOpts) {
        // role="button" + tabindex rend la carte focusable au clavier, mais un onclick seul ne
        // répond ni à Entrée ni à Espace : on délègue explicitement au clic déjà câblé.
        attrs = ` onclick="${selectOpts.onclick}" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click();}" role="button" tabindex="0" data-k="sol:${selectOpts.onclick}" aria-pressed="${selectOpts.selected}"`;
        wrapperClasses += ' k-result-selectable';
        radio = `
        <span class="k-radio" aria-hidden="true">
            ${selectOpts.selected ? icone('check', 'w-3.5 h-3.5') : ''}
        </span>`;
        // Empêche l'ouverture du guide de gamme de déclencher aussi la sélection de la carte.
        gammeGuideBlock = `<div onclick="event.stopPropagation()">${gammeGuideBlock}</div>`;
    }

    const badge = badgeText
        ? `<span class="k-pill ${selectOpts && !selectOpts.selected ? 'k-pill-neutral' : 'k-pill-accent'} mb-2">${escapeHtml(badgeText)}</span>`
        : '';

    // Positionnement de gamme (€€€, « haut de gamme design »…) : c'est un critère de choix,
    // sa place est ici, en clair sous la référence. Il était logé dans le résumé du dépliant
    // « Guide de la gamme », où il passait à la ligne dès que la colonne se resserrait.
    const infoGamme = GAMMES_INFO[state.brand]?.[mainTitle];
    const tier = infoGamme
        ? `<p class="text-xs text-ink-600 mt-1.5"><b class="font-semibold text-ink-900 k-num">${escapeHtml(infoGamme.tier)}</b></p>`
        : '';

    // La pastille TVA ne s'affiche que si le bloc ne l'a pas déjà énoncée pour toutes ses
    // options (voir tvaCommune) : sinon elle est identique sur chaque carte et ne signale rien.
    const pastilles = tvaMasquee ? '' : `<div class="flex flex-wrap gap-1.5 mt-3">${renderTvaBadge(tvaInfo, mainTitle)}</div>`;

    // Taux de charge, calculé une seule fois ici : c'est lui qui pilote la tuile ET
    // l'avertissement de sous-charge (voir le commentaire de renderCard ci-dessus). Repli sur
    // la puissance nominale — l'ancien affichage — quand chargeInfo est absent, ce qui ne
    // survient dans aucun appel actuel mais garde la fonction sûre si un futur appelant omet
    // ce paramètre.
    const t = chargeInfo ? tauxCharge(chargeInfo.reqFroid, chargeInfo.reqChaud, froid, chaud) : null;
    const tuileFroid = t
        ? { label: 'Charge froid', valeur: `${Math.round(t.chargeF * 100)} %` }
        : { label: 'Froid nominal', valeur: `${nb(froid)} kW` };
    // Le chaud retombe sur la puissance nominale en « Froid seul » : le besoin chaud n'entre
    // alors plus dans le dimensionnement (reqChaud est null), donc aucun taux de charge chaud
    // n'a de sens à afficher — voir calculate() dans ce même fichier.
    const tuileChaud = (t && t.chargeC !== null)
        ? { label: 'Charge chaud', valeur: `${Math.round(t.chargeC * 100)} %` }
        : { label: 'Chaud nominal', valeur: `${nb(chaud)} kW` };

    return `
    <div class="${wrapperClasses}"${attrs}>
        <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
                ${badge}
                <h4 class="text-xl font-semibold text-ink-900 uppercase tracking-[0.015em] leading-tight break-words">${mainTitle}</h4>
                <p class="text-xs text-ink-500 mt-1 break-words k-num">${subtitle}</p>
                ${tier}
            </div>
            ${radio}
        </div>

        <div class="grid grid-cols-2 gap-2 mt-4">
            <div class="k-stat k-stat-froid">
                <span class="k-stat-label">${tuileFroid.label}</span>
                <span class="k-stat-value">${tuileFroid.valeur}</span>
            </div>
            <div class="k-stat k-stat-chaud">
                <span class="k-stat-label">${tuileChaud.label}</span>
                <span class="k-stat-value">${tuileChaud.valeur}</span>
            </div>
        </div>
        ${renderSousChargeWarning(t && t.sousCharge)}

        ${renderPiedMesures(chargeInfo, froid, chaud)}
        ${pastilles}
        ${gammeGuideBlock}
        ${footer}
    </div>`;
}

// Pastilles HTML "TVA 5,5% / TVA 20% / TVA à vérifier / non renseignée" + mention Wifi si un
// module est nécessaire pour en bénéficier. Le statut 'a_verifier' correspond à une référence
// absente du tableau d'éligibilité DE LA MARQUE COURANTE (state.brand) : l'outil ne promet pas
// 5,5% mais ne condamne pas non plus à 20%.
//
// `tvaInfo === null` est un cas DIFFÉRENT, distingué ici plutôt que confondu avec 'a_verifier' :
// c'est la marque ENTIÈRE qui n'a aucun dispositif TVA renseigné (getTvaInfo/getGroupTvaInfo
// retournent null quand TVA_RULES[brand] n'existe pas). Ce cas rendait jusqu'ici une chaîne
// vide — aucune pastille du tout — qu'un commercial pressé lit « pas éligible », alors que
// « non renseigné » et « non éligible » n'ont rien à voir. Toshiba affiche une pastille verte,
// une future marque sans tableau doit afficher SA propre pastille grise plutôt que le silence.
// Pastille = <details>/<summary> plutôt qu'un <span title="...">: l'explication qui suivait
// jusqu'ici n'était visible qu'au survol souris, jamais au doigt sur mobile. Le rendu fermé
// est visuellement identique à l'ancienne pastille (même forme, même couleur) ; ouvrir révèle
// le texte. event.stopPropagation() : la carte parente peut porter son propre onclick de
// sélection (voir renderCard) — ouvrir l'explication ne doit pas aussi sélectionner la carte.
function pastilleTva(variante, texte, explication, cle) {
    return `<details data-k="tva:${cle}:${texte}" onclick="event.stopPropagation()" class="inline-block align-top">
        <summary class="k-pill k-pill-${variante} cursor-pointer">${texte}<span class="opacity-45">${icone('info', 'w-3 h-3')}</span></summary>
        <p class="text-2xs text-ink-500 mt-1.5 max-w-xs leading-relaxed">${explication}</p>
    </details>`;
}

// Ne renvoie que les pastilles : leur mise en rangée est la responsabilité de l'appelant
// (la carte les regroupe avec le taux de charge dans un seul `flex flex-wrap`, au lieu des
// deux rangées empilées qu'imposait l'ancien conteneur inclus ici).
function renderTvaBadge(tvaInfo, cle = "") {
    if (!tvaInfo) {
        return pastilleTva("neutral", "TVA non renseignée", `Aucun dispositif d'éligibilité TVA renseigné pour ${escapeHtml(libelleMarque(state.brand))} dans cette version de l'outil — statut à vérifier auprès du fournisseur avant de facturer.`, cle);
    }
    const marque = escapeHtml(libelleMarque(state.brand));
    const dateVerif = new Date(TVA_DATE_VERIFICATION).toLocaleDateString('fr-FR');
    const badges = {
        eligible:     pastilleTva('ok', 'TVA 5,5 %', `Éligibilité vérifiée face au tableau ${marque} le ${dateVerif}.`, cle),
        non_eligible: pastilleTva('danger', 'TVA 20 %', `Éligibilité vérifiée face au tableau ${marque} le ${dateVerif}.`, cle),
        a_verifier:   pastilleTva('neutral', 'TVA à vérifier', `Référence absente du tableau d'éligibilité ${marque} (vérifié le ${dateVerif}) : à confirmer auprès du constructeur avant de facturer en 5,5 %.`, cle)
    };
    const wifi = tvaInfo.wifiRequired
        ? `<span class="k-pill k-pill-neutral">Module Wifi requis</span>`
        : '';
    return (badges[tvaInfo.statut] || badges.a_verifier) + wifi;
}

function tvaSuffixText(tvaInfo) {
    if (!tvaInfo) return ` — TVA non renseignée pour ${libelleMarque(state.brand)}`;
    const libelles = { eligible: 'TVA 5,5 %', non_eligible: 'TVA 20 %', a_verifier: `TVA à vérifier (référence absente du tableau ${libelleMarque(state.brand)})` };
    return ` — ${libelles[tvaInfo.statut] || libelles.a_verifier}${tvaInfo.wifiRequired ? ' (Module Wifi requis)' : ''}`;
}

// --- PWA ---
// Manifest (manifest.json) et icônes sont des fichiers statiques réels (voir <head>). Le service
// worker (sw.js) est servi en same-origin : contrairement à l'ancienne version enregistrée depuis
// une blob: URL, les navigateurs l'acceptent.
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(err => console.warn('PWA SW: ', err));
    });
}

// --- PONT VERS LES ATTRIBUTS onclick/oninput/onchange DU HTML ---
// Un <script type="module"> ne place pas ses fonctions sur `window` (contrairement à un script
// classique) : les attributs onclick="calculate()" etc. du HTML ont donc besoin de ce pont
// explicite pour continuer à fonctionner sans réécrire toute la gestion d'événements en
// délégation. Liste figée = fonctions effectivement référencées depuis des attributs HTML.
Object.assign(window, {
    addRoom, calculate, duplicateRoom, exportFiche, oublierConfigChargee, persistDraft, removeRoom,
    saveChantier, selectGroupGamme, setBrand, setMode, setUsage, shareResults, startNewCalcul,
    toggleCustomCoef, toggleRoomCustomCoef, toggleDashboard, updateChantier, updateClimateInfo, updateRoom,
    selectDedicated, selectGroup, selectMono, marquerResultatsObsoletes, persistInstallateur,
    separerPieceEnDedie, reintegrerPieceAuGroupe
});

window.onload = initApp;
