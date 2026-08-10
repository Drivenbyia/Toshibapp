// Application ProSizer B2B : état, rendu DOM et gestionnaires d'événements.
// Importe les données (data.js) et les fonctions de calcul pures (calcul.js) ; c'est le seul
// module qui touche au DOM, à localStorage ou à l'état applicatif.
import {
    CATALOGS, GAMMES_INFO, TVA_RULES, DEPARTMENTS, tBaseMatrix, tBaseEteMatrix,
    BRAND_ACCENTS, BRAND_LABELS, CONSIGNE_REFERENCE, COEF_FOISONNEMENT_FROID, COEF_FOISONNEMENT_CHAUD,
    SEUIL_SOUS_CHARGE, SEUIL_DESEQUILIBRE_GROUPE
} from './data.js';
import {
    occupantsParDefaut, resolveCoefG, getFacteurCanicule, getFacteurDeclassementChaud,
    estimerEcartConsigne, getRequiredKw as getRequiredKwCore, getUiSizeForKw, findBestMonos,
    findMultiGroup, findMultiGroupOptions, getRoomEligibleGammes, getTvaInfo, getRoomSelectedTvaInfo,
    getGroupTvaInfo, trierMonosParTva,
    findGroupeEquilibre, estGroupeDesequilibre, ratioPieceDominante, pieceDominante
} from './calcul.js';

// --- STATE ---
let state = {
    brand: 'toshiba',
    mode: 'mono',
    // 'reversible' (défaut) : sélection du matériel sur le besoin froid ET chaud.
    // 'froid_seul' : le besoin chaud n'entre plus dans le dimensionnement (mais reste affiché à
    // titre indicatif) — permet de proposer une solution quand seul le chaud dépasse le catalogue.
    usage: 'reversible',
    rooms: [{ id: 1, nom: '', surface: '', height: 2.5, emplacement: 'plain_pied', orientation: 'mixte', vitrage: 'moyen', protection: 'stores_int', occupants: '', expositionMurs: 4 }],
    lastResultData: null,
    currentCalc: null,
    // Solution choisie par l'utilisateur parmi les options proposées (mono / dédiés multi / gammes UI du groupe / groupe extérieur)
    selection: { mono: 0, dedicated: {}, group: {}, groupChoice: 0 }
};

function defaultRoom(id) {
    return { id, nom: '', surface: '', height: 2.5, emplacement: 'plain_pied', orientation: 'mixte', vitrage: 'moyen', protection: 'stores_int', occupants: '', expositionMurs: 4 };
}

// Les boutons de marque sont retrouvés par leur attribut `data-brand` et non par un id en
// dur : une marque masquée (bouton absent du DOM) doit laisser cette fonction intacte,
// alors qu'un getElementById manquant la faisait planter sur un `null`.
function setBrand(brand) {
    state.brand = brand;
    const colors = BRAND_ACCENTS[brand];
    document.documentElement.style.setProperty('--brand-accent', colors.accent);
    document.documentElement.style.setProperty('--brand-accent-dark', colors.accentDark);
    document.querySelectorAll('[data-brand]').forEach((btn) => {
        const actif = btn.dataset.brand === brand;
        btn.className = `flex-1 py-2 text-sm font-bold rounded-md transition-all ${actif ? 'shadow-sm bg-white text-[var(--brand-accent)]' : 'text-gray-500'}`;
    });
    state.currentCalc = null;
    document.getElementById('results-container').innerHTML = '';
}

function initApp() {
    const deptSelect = document.getElementById('deptSelect');
    Object.keys(DEPARTMENTS).sort().forEach(code => {
        const opt = document.createElement('option');
        opt.value = code;
        opt.textContent = `${code} - ${DEPARTMENTS[code].name}`;
        if (code === "69") opt.selected = true;
        deptSelect.appendChild(opt);
    });
    updateClimateInfo();
    renderRooms();
    initDashboardEvents();
    restoreDraftIfAny();
}

// --- DASHBOARD & LOCALSTORAGE LOGIC ---
function toggleDashboard(show) {
    if (show) {
        document.getElementById('app-main').classList.add('hidden');
        document.getElementById('app-main').classList.remove('flex');
        document.getElementById('app-dashboard').classList.remove('hidden');
        document.getElementById('app-dashboard').classList.add('flex');
        renderDashboard();
    } else {
        document.getElementById('app-dashboard').classList.add('hidden');
        document.getElementById('app-dashboard').classList.remove('flex');
        document.getElementById('app-main').classList.remove('hidden');
        document.getElementById('app-main').classList.add('flex');
    }
}

// Échappe une valeur avant insertion dans du innerHTML (noms de clients / zones saisis
// librement par l'utilisateur : apostrophes, accents, voire balises).
function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// Accès localStorage protégés : Safari navigation privée / quota dépassé lèvent une
// exception sur getItem/setItem, ce qui plantait l'écran Dashboard sans message.
function loadChantiers() {
    try {
        return JSON.parse(localStorage.getItem('toshiba_chantiers') || '{}');
    } catch (e) {
        console.warn('Lecture des chantiers impossible :', e);
        return {};
    }
}
function persistChantiers(chantiers) {
    try {
        localStorage.setItem('toshiba_chantiers', JSON.stringify(chantiers));
        return true;
    } catch (e) {
        console.warn('Sauvegarde des chantiers impossible :', e);
        return false;
    }
}

function renderDashboard() {
    const list = document.getElementById('chantiers-list');
    const chantiers = loadChantiers();
    const clients = Object.keys(chantiers);

    if (clients.length === 0) {
        list.innerHTML = `<div class="p-8 bg-gray-50 text-center text-gray-500 rounded-xl border border-gray-200 border-dashed italic">Aucun chantier enregistré pour le moment.</div>`;
        return;
    }

    let html = '';
    clients.forEach(client => {
        const data = chantiers[client];
        let configsHtml = data.configurations.map((cfg, i) => {
            const eqs = cfg.equipments || [];
            const rds = cfg.roomDetails || [];

            let detailsHtml = '';
            if (eqs.length > 0 || rds.length > 0) {
                detailsHtml = `
                <details class="mt-3 group bg-white rounded-lg border border-blue-100 overflow-hidden shadow-sm">
                    <summary class="text-[11px] font-bold text-blue-600 bg-blue-50/50 p-2 cursor-pointer flex items-center justify-between hover:bg-blue-50 transition-colors">
                        <span class="flex items-center gap-1.5">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                            Détails des Unités & Pièces
                        </span>
                        <svg class="w-4 h-4 transition-transform group-open:rotate-180 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
                    </summary>
                    <div class="p-3 text-[11px] text-gray-700 flex flex-col gap-2">
                        ${eqs.length > 0 ? `<div><div class="font-extrabold text-gray-400 uppercase tracking-wider text-[11px] mb-1">Matériel Proposé :</div>${eqs.map(e => `<div class="font-medium text-toshiba-dark">• ${escapeHtml(e)}</div>`).join('')}</div>` : ''}
                        ${rds.length > 0 ? `<div><div class="font-extrabold text-gray-400 uppercase tracking-wider text-[11px] mb-1 mt-1">Bilan par Pièce :</div>${rds.map(r => `<div>• ${escapeHtml(r)}</div>`).join('')}</div>` : ''}
                    </div>
                </details>`;
            }

            return `
            <div class="flex justify-between items-start py-4 border-b border-gray-200 last:border-0 relative">
                <div class="w-full pr-8">
                    <div class="flex items-center gap-2 mb-1">
                        <span class="font-bold text-sm text-toshiba-dark">${escapeHtml(cfg.zone)}</span>
                        <span class="text-[11px] bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded font-bold uppercase">${escapeHtml(cfg.mode)}</span>
                    </div>
                    <p class="text-xs text-[var(--brand-accent)] font-bold uppercase tracking-tight">${escapeHtml(cfg.resultStr)}</p>
                    ${detailsHtml}
                    <p class="text-[11px] text-gray-400 mt-2 font-medium">${escapeHtml(cfg.date)}</p>
                </div>
                <div class="absolute right-0 top-3 flex items-center gap-1">
                    <button data-action="reload-config" data-client="${escapeHtml(client)}" data-index="${i}" class="text-gray-300 hover:text-[var(--brand-accent)] p-2" title="Recharger cette configuration pour la modifier"><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg></button>
                    <button data-action="delete-config" data-client="${escapeHtml(client)}" data-index="${i}" class="text-gray-300 hover:text-red-500 p-2" title="Supprimer cette zone"><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg></button>
                </div>
            </div>
        `}).join('');

        html += `
        <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-5 fade-in">
            <div class="flex justify-between items-center mb-3">
                <h3 class="text-lg font-bold text-toshiba-dark flex items-center gap-2">
                    <svg class="w-5 h-5 text-gray-400" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clip-rule="evenodd"></path></svg>
                    ${escapeHtml(client)}
                </h3>
                <button data-action="delete-chantier" data-client="${escapeHtml(client)}" class="text-[11px] font-bold text-red-500 hover:text-white border border-red-200 hover:bg-red-500 hover:border-red-500 transition-colors px-2 py-1 rounded">SUPPRIMER TOUT</button>
            </div>
            <div class="bg-gray-50 rounded-lg px-4 border border-gray-100">
                ${configsHtml}
            </div>
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
        const client = btn.dataset.client;
        if (btn.dataset.action === 'delete-chantier') deleteChantier(client);
        else if (btn.dataset.action === 'delete-config') deleteConfig(client, parseInt(btn.dataset.index, 10));
        else if (btn.dataset.action === 'reload-config') reloadConfig(client, parseInt(btn.dataset.index, 10));
    });
}

function deleteChantier(clientName) {
    if (confirm(`Supprimer définitivement le chantier ${clientName} ?`)) {
        let chantiers = loadChantiers();
        delete chantiers[clientName];
        persistChantiers(chantiers);
        renderDashboard();
    }
}

function deleteConfig(clientName, index) {
    let chantiers = loadChantiers();
    if (!chantiers[clientName]) return;
    chantiers[clientName].configurations.splice(index, 1);
    if (chantiers[clientName].configurations.length === 0) delete chantiers[clientName];
    persistChantiers(chantiers);
    renderDashboard();
}

// Recharge une configuration sauvegardée dans le simulateur pour la modifier : marque,
// paramètres bâtiment, pièces et sélection utilisateur sont restaurés à l'identique, puis
// le calcul est relancé. Avant ce correctif, un chantier n'était consultable qu'en lecture
// seule (texte figé) : toute variante demandée par le client obligeait à tout ressaisir.
function reloadConfig(clientName, index) {
    const chantiers = loadChantiers();
    const cfg = chantiers[clientName] && chantiers[clientName].configurations[index];
    if (!cfg) return;

    if (!cfg.rooms || !cfg.rooms.length) {
        alert("Cette configuration a été enregistrée avec une version antérieure de l'outil et ne contient pas assez d'informations pour être rechargée automatiquement.");
        return;
    }

    toggleDashboard(false);

    setBrand(cfg.brand || 'toshiba');
    applyBuildingParams(cfg.params);

    state.mode = cfg.mode === 'multi' ? 'multi' : 'mono';
    state.usage = cfg.usage === 'froid_seul' ? 'froid_seul' : 'reversible';
    state.rooms = JSON.parse(JSON.stringify(cfg.rooms));
    updateModeButtons(state.mode);
    updateUsageButtons(state.usage);
    renderRooms();

    calculate();
    if (cfg.selection) {
        state.selection = JSON.parse(JSON.stringify(cfg.selection));
        renderResults();
    }

    const clientEl = document.getElementById('save-client');
    const zoneEl = document.getElementById('save-zone');
    if (clientEl) clientEl.value = clientName;
    if (zoneEl) zoneEl.value = cfg.zone || '';
}

function populateClientDatalist() {
    const dl = document.getElementById('client-list');
    if (!dl) return;
    const chantiers = loadChantiers();
    dl.innerHTML = Object.keys(chantiers).map(c => `<option value="${escapeHtml(c)}">`).join('');
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
const DRAFT_KEY = 'toshiba_prosizer_draft';
function persistDraft() {
    try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({
            brand: state.brand,
            mode: state.mode,
            usage: state.usage,
            rooms: state.rooms,
            params: captureBuildingParams()
        }));
    } catch (e) { /* stockage indisponible : tant pis, pas de brouillon */ }
}
function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* ignoré */ }
}
function restoreDraftIfAny() {
    let draft;
    try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); }
    catch (e) { return; }
    if (!draft || !draft.rooms || !draft.rooms.length) return;
    // Un brouillon sans la moindre surface saisie n'a rien à restaurer.
    if (!draft.rooms.some(r => r.surface)) return;

    setBrand(draft.brand || 'toshiba');
    applyBuildingParams(draft.params);
    state.mode = draft.mode === 'multi' ? 'multi' : 'mono';
    state.usage = draft.usage === 'froid_seul' ? 'froid_seul' : 'reversible';
    state.rooms = draft.rooms;
    updateModeButtons(state.mode);
    updateUsageButtons(state.usage);
    renderRooms();

    const banner = document.getElementById('draft-banner');
    if (banner) banner.classList.remove('hidden');
}
// Efface le brouillon et repart d'une saisie vierge (bouton de la bannière de reprise).
function startNewCalcul() {
    clearDraft();
    state.rooms = [defaultRoom(Date.now())];
    state.currentCalc = null;
    document.getElementById('results-container').innerHTML = '';
    renderRooms();
    const banner = document.getElementById('draft-banner');
    if (banner) banner.classList.add('hidden');
}

function saveChantier() {
    const client = document.getElementById('save-client').value.trim();
    const zone = document.getElementById('save-zone').value.trim();
    const msgBox = document.getElementById('save-msg');

    if (!client || !zone) {
        msgBox.innerHTML = "Veuillez remplir le Client et la Zone.";
        msgBox.className = "mt-3 text-xs font-bold text-center text-red-500 block";
        return;
    }

    let chantiers = loadChantiers();
    if (!chantiers[client]) chantiers[client] = { configurations: [] };

    chantiers[client].configurations.push({
        zone: zone,
        mode: state.mode,
        brand: state.brand,
        usage: state.usage,
        resultStr: state.lastResultData.summaryText,
        equipments: state.lastResultData.equipments,
        roomDetails: state.lastResultData.roomDetails,
        params: captureBuildingParams(),
        rooms: JSON.parse(JSON.stringify(state.rooms)),
        selection: JSON.parse(JSON.stringify(state.selection)),
        date: new Date().toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    });

    if (!persistChantiers(chantiers)) {
        msgBox.innerHTML = "❌ Échec de la sauvegarde (stockage local indisponible ou plein).";
        msgBox.className = "mt-3 text-xs font-bold text-center text-red-500 block";
        return;
    }

    document.getElementById('save-zone').value = '';
    msgBox.innerHTML = "✅ Sauvegardé avec succès dans 'Mes Chantiers' !";
    msgBox.className = "mt-3 text-xs font-bold text-center text-green-600 block";
    populateClientDatalist();
}

// --- LECTURE DES PARAMÈTRES DEPUIS LE DOM (ponts vers le module de calcul pur) ---

function getCoefG() {
    const selectVal = document.getElementById('isolationCoef').value;
    const customVal = document.getElementById('customCoef').value;
    return resolveCoefG(selectVal, customVal);
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
        ecartHtml = ` (≈ ${signe}${ecart.toFixed(0)}% froid vs 26°C, pièce type)`;
    }
    document.getElementById('climate-diagnostic').innerHTML = `Zone <b>${zone}</b> • T base hiver : <b>${tBaseHiver}°C</b> • T base été : <b>${tBaseEte}°C</b> • Consigne été : <b>${consigne}°C</b>${ecartHtml}`;
}

// Pont DOM -> calcul pur : rassemble coefG/climat/consigne puis délègue à getRequiredKw (calcul.js).
function getRequiredKw(surface, height, room) {
    const { tBaseHiver, tBaseEte } = getClimateContext();
    const consigneEl = document.getElementById('consigneInt');
    const consigne = consigneEl ? parseFloat(consigneEl.value) : CONSIGNE_REFERENCE;
    return getRequiredKwCore(surface, height, room, { coefG: getCoefG(), tBaseHiver, tBaseEte, consigne });
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
    document.getElementById('btn-mono').className = `flex-1 py-2 text-sm font-medium rounded-md transition-all ${isMono ? 'shadow-sm bg-white text-[var(--brand-accent)]' : 'text-gray-500'}`;
    document.getElementById('btn-multi').className = `flex-1 py-2 text-sm font-medium rounded-md transition-all ${!isMono ? 'shadow-sm bg-white text-[var(--brand-accent)]' : 'text-gray-500'}`;
}

function setMode(mode) {
    state.mode = mode;
    state.rooms = [state.rooms[0]];
    updateModeButtons(mode);
    state.currentCalc = null;
    document.getElementById('results-container').innerHTML = '';
    renderRooms();
}

// Reflet visuel du toggle Réversible / Froid seul, séparé de setUsage() pour les mêmes raisons
// que updateModeButtons (reloadConfig / restoreDraftIfAny doivent pouvoir l'appliquer sans
// déclencher les effets de bord de setUsage).
function updateUsageButtons(usage) {
    const isReversible = usage !== 'froid_seul';
    document.getElementById('btn-usage-reversible').className = `flex-1 py-2 text-sm font-medium rounded-md transition-all ${isReversible ? 'shadow-sm bg-white text-[var(--brand-accent)]' : 'text-gray-500 hover:text-gray-700'}`;
    document.getElementById('btn-usage-froid_seul').className = `flex-1 py-2 text-sm font-medium rounded-md transition-all ${!isReversible ? 'shadow-sm bg-white text-[var(--brand-accent)]' : 'text-gray-500 hover:text-gray-700'}`;
    const note = document.getElementById('usage-note');
    if (note) note.classList.toggle('hidden', isReversible);
}

function setUsage(usage) {
    state.usage = usage;
    updateUsageButtons(usage);
    state.currentCalc = null;
    document.getElementById('results-container').innerHTML = '';
    persistDraft();
}

function renderRooms() {
    const container = document.getElementById('rooms-container');
    container.innerHTML = '';
    const canAddMore = state.rooms.length < 5;
    state.rooms.forEach((room, index) => {
        const showRemove = state.mode === 'multi' && state.rooms.length > 1;
        const showDuplicate = state.mode === 'multi' && canAddMore;
        container.insertAdjacentHTML('beforeend', `
            <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-5 fade-in relative">
                <div class="absolute top-4 right-4 flex items-center gap-1">
                    ${showDuplicate ? `<button onclick="duplicateRoom(${room.id})" title="Dupliquer cette pièce" class="text-gray-300 hover:text-[var(--brand-accent)] transition p-1"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 4h8a2 2 0 012 2v8a2 2 0 01-2 2h-8a2 2 0 01-2-2v-8a2 2 0 012-2z"></path></svg></button>` : ''}
                    ${showRemove ? `<button onclick="removeRoom(${room.id})" title="Supprimer cette pièce" class="text-gray-300 hover:text-red-500 transition p-1"><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg></button>` : ''}
                </div>
                <h3 class="text-sm font-bold text-gray-700 mb-4 flex items-center gap-2 uppercase tracking-tight">
                    <span class="bg-gray-100 text-gray-500 rounded-lg w-7 h-7 flex items-center justify-center text-xs border border-gray-200">${index + 1}</span>
                    ${state.mode === 'multi' ? `Pièce ${index + 1}` : 'Volume de la pièce'}
                </h3>
                ${state.mode === 'multi' ? `
                <div class="mb-4">
                    <label class="block text-[11px] font-bold text-gray-400 uppercase mb-1">Nom de la pièce (optionnel)</label>
                    <input type="text" maxlength="40" oninput="updateRoom(${room.id}, 'nom', this.value)" value="${escapeHtml(room.nom || '')}" placeholder="Ex: Salon, Chambre parents..." class="w-full bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm focus:ring-2 focus:ring-[var(--brand-accent)] outline-none">
                </div>` : ''}
                <div class="grid grid-cols-2 gap-4">
                    <div>
                        <label class="block text-[11px] font-bold text-gray-400 uppercase mb-1">Surface (m²)</label>
                        <input type="number" min="1" max="200" oninput="updateRoom(${room.id}, 'surface', this.value)" value="${room.surface}" placeholder="Ex: 30" class="w-full bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm focus:ring-2 focus:ring-[var(--brand-accent)] outline-none">
                    </div>
                    <div>
                        <label class="block text-[11px] font-bold text-gray-400 uppercase mb-1">Hauteur (m)</label>
                        <input type="number" min="1.8" max="6" oninput="updateRoom(${room.id}, 'height', this.value)" value="${room.height}" step="0.1" class="w-full bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm focus:ring-2 focus:ring-[var(--brand-accent)] outline-none">
                    </div>
                </div>
                <div class="mt-4">
                    <label class="block text-[11px] font-bold text-gray-400 uppercase mb-1">Emplacement de la pièce</label>
                    <select onchange="updateRoom(${room.id}, 'emplacement', this.value)" class="select-custom w-full bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm focus:ring-2 focus:ring-[var(--brand-accent)] outline-none">
                        <option value="sous_toiture" ${room.emplacement === 'sous_toiture' ? 'selected' : ''}>Sous toiture / combles aménagés (fort apport)</option>
                        <option value="plain_pied" ${room.emplacement === 'plain_pied' ? 'selected' : ''}>Plain-pied, combles perdus isolés (apport modéré)</option>
                        <option value="etage_protege" ${room.emplacement === 'etage_protege' ? 'selected' : ''}>Étage protégé / RDC sous un autre niveau (nul)</option>
                    </select>
                </div>
                ${state.mode === 'multi' ? `
                <div class="mt-4">
                    <label class="block text-[11px] font-bold text-gray-400 uppercase mb-1">Murs donnant sur l'extérieur</label>
                    <select onchange="updateRoom(${room.id}, 'expositionMurs', this.value)" class="select-custom w-full bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm focus:ring-2 focus:ring-[var(--brand-accent)] outline-none">
                        <option value="4" ${String(room.expositionMurs) === '4' ? 'selected' : ''}>4 (pièce isolée sur toutes ses faces)</option>
                        <option value="3" ${String(room.expositionMurs) === '3' ? 'selected' : ''}>3</option>
                        <option value="2" ${String(room.expositionMurs) === '2' ? 'selected' : ''}>2 (pièce d'angle)</option>
                        <option value="1" ${String(room.expositionMurs) === '1' ? 'selected' : ''}>1 (pièce intérieure, peu de déperditions)</option>
                    </select>
                </div>` : ''}
                <div class="grid grid-cols-2 gap-4 mt-4">
                    <div>
                        <label class="block text-[11px] font-bold text-gray-400 uppercase mb-1">Orientation des baies</label>
                        <select onchange="updateRoom(${room.id}, 'orientation', this.value)" class="select-custom w-full bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm focus:ring-2 focus:ring-[var(--brand-accent)] outline-none">
                            <option value="nord" ${room.orientation === 'nord' ? 'selected' : ''}>Nord</option>
                            <option value="est" ${room.orientation === 'est' ? 'selected' : ''}>Est</option>
                            <option value="sud" ${room.orientation === 'sud' ? 'selected' : ''}>Sud</option>
                            <option value="ouest" ${room.orientation === 'ouest' ? 'selected' : ''}>Ouest</option>
                            <option value="mixte" ${room.orientation === 'mixte' ? 'selected' : ''}>Mixte / plusieurs</option>
                        </select>
                    </div>
                    <div>
                        <label class="block text-[11px] font-bold text-gray-400 uppercase mb-1">Quantité de vitrage</label>
                        <select onchange="updateRoom(${room.id}, 'vitrage', this.value)" class="select-custom w-full bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm focus:ring-2 focus:ring-[var(--brand-accent)] outline-none">
                            <option value="peu" ${room.vitrage === 'peu' ? 'selected' : ''}>Peu vitré</option>
                            <option value="moyen" ${room.vitrage === 'moyen' ? 'selected' : ''}>Moyen</option>
                            <option value="beaucoup" ${room.vitrage === 'beaucoup' ? 'selected' : ''}>Très vitré</option>
                        </select>
                    </div>
                </div>
                <div class="grid grid-cols-2 gap-4 mt-4">
                    <div>
                        <label class="block text-[11px] font-bold text-gray-400 uppercase mb-1">Protection solaire</label>
                        <select onchange="updateRoom(${room.id}, 'protection', this.value)" class="select-custom w-full bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm focus:ring-2 focus:ring-[var(--brand-accent)] outline-none">
                            <option value="aucune" ${room.protection === 'aucune' ? 'selected' : ''}>Aucune</option>
                            <option value="stores_int" ${room.protection === 'stores_int' ? 'selected' : ''}>Stores / rideaux intérieurs</option>
                            <option value="volets_ext" ${room.protection === 'volets_ext' ? 'selected' : ''}>Volets / stores extérieurs</option>
                        </select>
                    </div>
                    <div>
                        <label class="block text-[11px] font-bold text-gray-400 uppercase mb-1">Occupants</label>
                        <input type="number" min="0" oninput="updateRoom(${room.id}, 'occupants', this.value)" value="${room.occupants}" placeholder="Auto: ${occupantsParDefaut(room.surface) || '–'}" class="w-full bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm focus:ring-2 focus:ring-[var(--brand-accent)] outline-none">
                    </div>
                </div>
            </div>
        `);
    });
    if (state.mode === 'multi' && state.rooms.length < 5) {
        container.insertAdjacentHTML('beforeend', `<button onclick="addRoom()" class="w-full border-2 border-dashed border-gray-200 rounded-xl p-4 text-gray-400 hover:border-[var(--brand-accent)] hover:text-[var(--brand-accent)] transition-all flex items-center justify-center gap-2 font-bold text-sm bg-white">Ajouter une pièce (${state.rooms.length}/5)</button>`);
    }
}

function addRoom() { state.rooms.push(defaultRoom(Date.now())); renderRooms(); persistDraft(); }
function removeRoom(id) { state.rooms = state.rooms.filter(r => r.id !== id); renderRooms(); persistDraft(); }
function duplicateRoom(id) {
    if (state.rooms.length >= 5) return;
    const idx = state.rooms.findIndex(r => r.id === id);
    if (idx === -1) return;
    const clone = { ...state.rooms[idx], id: Date.now() };
    state.rooms.splice(idx + 1, 0, clone);
    renderRooms();
    persistDraft();
}
function updateRoom(id, field, value) {
    const r = state.rooms.find(x => x.id === id);
    if (!r) return;
    const champsTexte = ['nom', 'emplacement', 'orientation', 'vitrage', 'protection'];
    if (champsTexte.includes(field)) {
        r[field] = value;
    } else {
        // Number.isFinite (et non `|| ''`) : un champ à 0 (ex: 0 occupant) doit rester 0,
        // pas retomber silencieusement sur l'estimation automatique.
        const num = parseFloat(value);
        r[field] = Number.isFinite(num) ? num : '';
    }
    persistDraft();
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

function calculate() {
    const resultsContainer = document.getElementById('results-container');
    if (state.rooms.some(r => !r.surface)) {
        resultsContainer.innerHTML = `<div class="p-4 bg-red-50 text-red-600 rounded-lg border border-red-200 text-sm font-medium">Saisie incomplète : indiquez la surface pour chaque pièce.</div>`;
        return;
    }

    const { zone, tBaseHiver } = getClimateContext();
    const froidSeul = state.usage === 'froid_seul';

    // Marge canicule : en zone chaude, la puissance froid réelle chute au-delà de 35°C ext.
    const facteurCanicule = getFacteurCanicule(zone);
    const caniculeNote = facteurCanicule > 1
        ? `<div class="p-2.5 bg-orange-50 border border-orange-200 text-orange-800 rounded-lg text-[11px] font-medium text-center mb-4 -mt-2">☀️ Zone chaude : marge canicule de +${Math.round((facteurCanicule - 1) * 100)}% appliquée à la sélection (pointes 40-42°C).</div>`
        : '';

    // Déclassement chaud : la puissance catalogue (+7°C) chute par grand froid. Sans objet en
    // "Froid seul" puisque le chaud n'entre alors plus dans le dimensionnement.
    const facteurDeclassementChaud = getFacteurDeclassementChaud(tBaseHiver);
    const declassementNote = (!froidSeul && facteurDeclassementChaud > 1.05)
        ? `<div class="p-2.5 bg-sky-50 border border-sky-200 text-sky-900 rounded-lg text-[11px] font-medium text-center mb-4 -mt-2">🥶 Grand froid : la puissance chaud requise en catalogue est majorée de +${Math.round((facteurDeclassementChaud - 1) * 100)}% pour compenser la perte de capacité de la PAC à température de base (estimation générique, à affiner avec les courbes constructeur).</div>`
        : '';
    const usageNote = froidSeul
        ? `<div class="p-2.5 bg-cyan-50 border border-cyan-200 text-cyan-900 rounded-lg text-[11px] font-medium text-center mb-4 -mt-2">❄️ Froid seul : la sélection ignore le besoin chauffage (affiché à titre indicatif ci-dessous). Les machines proposées restent des PAC réversibles standard.</div>`
        : '';

    // Reset des choix utilisateur à chaque nouveau calcul.
    state.selection = { mono: 0, dedicated: {}, group: {}, groupChoice: 0 };

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
            besoinsHtml: renderBesoinsCard([req]),
            caniculeNote: caniculeNote + declassementNote + usageNote,
            roomDetails: [`Pièce 1 : ${req.froid.toFixed(1)}kW F / ${req.chaud.toFixed(1)}kW C ➔ Taille ${size || 'HORS LIMITE'}`],
            mono: { options: trierMonosParTva(findBestMonos(froidMatch, chaudMatch, state.brand), state.brand), froidSeul }
        };
    } else {
        let roomsData = state.rooms.map((r, i) => {
            let req = getRequiredKw(r.surface, r.height, r);
            let froidMatch = req.froid * facteurCanicule;
            let chaudMatch = froidSeul ? 0 : req.chaud * facteurDeclassementChaud;
            let size = getUiSizeForKw(froidMatch, chaudMatch, state.brand);
            return { index: i + 1, nom: r.nom || '', req: req, froidMatch: froidMatch, chaudMatch: chaudMatch, size: size, maxKw: Math.max(froidMatch, chaudMatch) };
        });
        const roomDetails = roomsData.map(r => `Pièce ${r.index}${r.nom ? ' (' + r.nom + ')' : ''} : ${r.req.froid.toFixed(1)}kW F / ${r.req.chaud.toFixed(1)}kW C ➔ Taille ${r.size || 'HORS LIMITE'}`);

        let extractedForMono = roomsData.filter(r => r.size === null);
        let standardRooms = roomsData.filter(r => r.size !== null);
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
            label: `Monosplit Dédié (Pièce ${room.index}${room.nom ? ' — ' + escapeHtml(room.nom) : ''})`,
            options: trierMonosParTva(findBestMonos(room.froidMatch, room.chaudMatch, state.brand), state.brand)
        }));

        let groupOptions = [];
        if (bestGroup === "MONO" && standardRooms.length === 1) {
            // Une seule pièce restante après délestage : traitée comme un mono dédié de plus.
            dedicated.push({
                room: standardRooms[0],
                label: `Monosplit Restant (Pièce ${standardRooms[0].index}${standardRooms[0].nom ? ' — ' + escapeHtml(standardRooms[0].nom) : ''})`,
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
            besoinsHtml: renderBesoinsCard(roomsData.map(r => r.req), true, roomsData),
            caniculeNote: caniculeNote + declassementNote + usageNote,
            roomDetails: roomDetails,
            multi: { dedicated: dedicated, groupOptions: groupOptions, standardRooms: standardRooms, hybridNote: hybridNote, froidSeul, groupEquilibre: groupEquilibre }
        };
    }

    renderResults();
    resultsContainer.scrollIntoView({ behavior: 'smooth' });
}

// Reconstruit l'affichage des résultats à partir de state.currentCalc + state.selection,
// sans relancer le calcul (utilisé quand l'utilisateur choisit une solution parmi les options).
// Fonction de LECTURE uniquement : ne modifie jamais state (voir seedGroupGammeDefaults / selectGroup
// pour la logique d'initialisation des choix par défaut).
function renderResults() {
    const resultsContainer = document.getElementById('results-container');
    const calc = state.currentCalc;
    if (!calc) { resultsContainer.innerHTML = ''; return; }

    let html = `<h2 class="text-xl font-bold text-toshiba-dark flex items-center gap-2 mt-4"><span class="w-2 h-6 bg-[var(--brand-accent)] rounded-full"></span>Solutions recommandées</h2>`;
    html += calc.besoinsHtml + calc.caniculeNote;

    let summaryParts = [];
    let equipments = [];

    if (calc.mode === 'mono') {
        const options = calc.mono.options;
        if (options.length === 0) {
            html += `<div class="p-4 bg-orange-50 text-orange-800 rounded-lg text-sm italic">Aucun Monosplit du catalogue ne couvre ce niveau de puissance.</div>`;
        } else {
            const selIdx = Math.min(state.selection.mono || 0, options.length - 1);
            options.forEach((sol, idx) => {
                const selectOpts = options.length > 1 ? { selected: idx === selIdx, onclick: `selectMono(${idx})` } : null;
                const tvaInfo = getTvaInfo(sol.gamme, sol.reference_ensemble, 'mono', state.brand);
                html += renderCard("Monosplit Recommandé", sol.gamme, sol.reference_ensemble, sol.puissance_froid_kw, sol.puissance_chaud_kw, false, [], selectOpts, tvaInfo, { reqFroid: calc.req.froid, reqChaud: calc.mono.froidSeul ? null : calc.req.chaud });
            });
            const chosen = options[selIdx];
            const chosenTva = getTvaInfo(chosen.gamme, chosen.reference_ensemble, 'mono', state.brand);
            summaryParts.push(`1x Mono ${chosen.gamme}`);
            equipments.push(`Modèle sélectionné : ${chosen.gamme} (${chosen.reference_ensemble})${options.length > 1 ? ` — ${options.length - 1} autre${options.length > 2 ? 's' : ''} option${options.length > 2 ? 's' : ''} disponible${options.length > 2 ? 's' : ''}` : ''}${tvaSuffixText(chosenTva)}`);
        }
    } else {
        const m = calc.multi;

        if (m.hybridNote) {
            html += `
            <div class="p-3 bg-blue-50 border-l-4 border-blue-500 text-blue-900 rounded-r-lg text-sm my-4 shadow-sm flex gap-3 items-start fade-in">
                <svg class="w-6 h-6 flex-shrink-0 mt-0.5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                <div>
                    <strong class="block mb-1 text-blue-700">Expertise CVC : Architecture Hybride</strong>
                    Délestage requis : Monosplit(s) dédié(s) pour la/les plus grande(s) pièce(s), et un Multisplit pour le reste.
                </div>
            </div>`;
        }

        m.dedicated.forEach(dedItem => {
            const room = dedItem.room;
            const options = dedItem.options;
            if (options.length > 0) {
                const selIdx = Math.min(state.selection.dedicated[room.index] || 0, options.length - 1);
                options.forEach((sol, idx) => {
                    const selectOpts = options.length > 1 ? { selected: idx === selIdx, onclick: `selectDedicated(${room.index}, ${idx})` } : null;
                    const tvaInfo = getTvaInfo(sol.gamme, sol.reference_ensemble, 'mono', state.brand);
                    html += renderCard(dedItem.label, sol.gamme, sol.reference_ensemble, sol.puissance_froid_kw, sol.puissance_chaud_kw, false, [], selectOpts, tvaInfo, { reqFroid: room.req.froid, reqChaud: m.froidSeul ? null : room.req.chaud });
                });
                const chosen = options[selIdx];
                const chosenTva = getTvaInfo(chosen.gamme, chosen.reference_ensemble, 'mono', state.brand);
                summaryParts.push(`1x Mono ${chosen.gamme}`);
                equipments.push(`${dedItem.label} — Modèle sélectionné : ${chosen.gamme} (${chosen.reference_ensemble})${tvaSuffixText(chosenTva)}`);
            } else {
                html += `<div class="p-4 bg-orange-50 text-orange-800 rounded-lg text-sm italic mb-4">Pièce ${room.index} : Puissance requise (${room.maxKw.toFixed(1)} kW) hors catalogue.</div>`;
                equipments.push(`Pièce ${room.index} : Aucune machine assez puissante`);
            }
        });

        if (m.groupOptions.length > 0) {
            const sizesArr = m.standardRooms.map(r => r.size);
            const groupReqFroid = m.standardRooms.reduce((sum, r) => sum + r.req.froid, 0);
            const groupReqChaud = m.standardRooms.reduce((sum, r) => sum + r.req.chaud, 0);
            const selIdx = Math.min(state.selection.groupChoice || 0, m.groupOptions.length - 1);
            const bestGroup = m.groupOptions[selIdx];

            // Note d'équilibre du groupe RETENU (et non plus du plus petit groupe valide) : elle
            // suit donc le choix de l'utilisateur quand il passe d'une option à l'autre.
            const equilibre = analyseEquilibreGroupe(m, bestGroup);
            if (equilibre) html += renderBalanceNote(equilibre);

            m.groupOptions.forEach((g, idx) => {
                const selectOpts = m.groupOptions.length > 1 ? { selected: idx === selIdx, onclick: `selectGroup(${idx})` } : null;
                const estEquilibre = m.groupEquilibre && g.reference === m.groupEquilibre.reference;
                const badge = `Groupe Multisplit (${m.standardRooms.length} sorties)${estEquilibre ? ' · Équilibré' : ''}`;
                html += renderCard(badge, "Groupe Extérieur", g.reference, g.puissance_nominale_froid_kw, g.puissance_nominale_chaud_kw, true, sizesArr, selectOpts, getGroupTvaInfo(g.reference, state.brand), { reqFroid: groupReqFroid, reqChaud: m.froidSeul ? null : groupReqChaud });
            });
            html += renderMultiRoomsGuide(m.standardRooms, bestGroup);
            summaryParts.push(`1x Multi ${bestGroup.reference} (${m.standardRooms.length} UI)`);
            if (equilibre) equipments.push(`Équilibre du groupe : ${equilibre.message}`);

            const uiChoices = m.standardRooms.map(r => {
                const selGamme = state.selection.group[r.index];
                const info = selGamme ? getRoomSelectedTvaInfo(r, selGamme, bestGroup.gammes_compatibles, state.brand, bestGroup.reference) : null;
                return `Pièce ${r.index} (taille ${r.size}) : ${selGamme || '—'}${tvaSuffixText(info)}`;
            }).join(' / ');
            equipments.push(`Groupe Extérieur ${bestGroup.reference} — Unités sélectionnées : ${uiChoices}`);
        }
    }

    state.lastResultData = {
        summaryText: summaryParts.join(' | '),
        equipments: equipments,
        roomDetails: calc.roomDetails
    };

    if (state.lastResultData.summaryText) {
        html += `
        <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-5 mt-6 fade-in flex flex-col sm:flex-row gap-3">
            <button onclick="exportPdf()" class="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold py-3 rounded-lg transition-colors flex justify-center items-center gap-2 text-sm">
                🖨️ Imprimer / Exporter PDF
            </button>
            <button onclick="shareResults()" class="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold py-3 rounded-lg transition-colors flex justify-center items-center gap-2 text-sm">
                📤 Partager
            </button>
        </div>
        <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-5 mt-4 fade-in">
            <h3 class="text-sm font-bold text-toshiba-dark flex items-center gap-2 mb-4 uppercase tracking-wide">
                <svg class="w-5 h-5 text-[var(--brand-accent)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4"></path></svg>
                Enregistrer au Chantier
            </h3>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                <div>
                    <label class="block text-[11px] font-bold text-gray-400 uppercase mb-1">Nom du Client / Projet</label>
                    <input type="text" id="save-client" list="client-list" placeholder="Ex: Dupont" class="w-full bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm focus:ring-2 focus:ring-[var(--brand-accent)] outline-none">
                    <datalist id="client-list"></datalist>
                </div>
                <div>
                    <label class="block text-[11px] font-bold text-gray-400 uppercase mb-1">Désignation de la Zone</label>
                    <input type="text" id="save-zone" placeholder="Ex: RDC, Étage, Salon..." class="w-full bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm focus:ring-2 focus:ring-[var(--brand-accent)] outline-none">
                </div>
            </div>
            <button onclick="saveChantier()" class="w-full bg-gray-800 hover:bg-black text-white font-bold py-3 rounded-lg shadow transition-colors flex justify-center items-center gap-2 text-sm">
                💾 Sauvegarder
            </button>
            <div id="save-msg" class="mt-2 text-xs font-bold text-center hidden"></div>
        </div>
        `;
    }

    resultsContainer.innerHTML = html;
    populateClientDatalist();
}

// Export / partage de la fiche de dimensionnement. Aucune dépendance ajoutée : l'export
// PDF s'appuie sur l'impression native du navigateur (une feuille de style @media print
// isole une vue propre dans #print-area), et le partage utilise la Web Share API quand
// disponible, avec un repli mailto: sinon.
function buildResultSummaryLines() {
    const calc = state.currentCalc;
    if (!calc || !state.lastResultData) return null;
    const client = (document.getElementById('save-client') || {}).value?.trim() || '';
    const zone = (document.getElementById('save-zone') || {}).value?.trim() || '';
    const dateStr = new Date().toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    return {
        client, zone, dateStr,
        brandLabel: BRAND_LABELS[state.brand] || state.brand,
        modeLabel: calc.mode === 'mono' ? 'Monosplit' : 'Multisplit',
        roomDetails: calc.roomDetails || [],
        equipments: state.lastResultData.equipments || []
    };
}

function exportPdf() {
    const s = buildResultSummaryLines();
    if (!s) return;
    const printArea = document.getElementById('print-area');
    printArea.innerHTML = `
        <h1>ProSizer B2B — Fiche de dimensionnement</h1>
        ${s.client ? `<p><strong>Client :</strong> ${escapeHtml(s.client)}</p>` : ''}
        ${s.zone ? `<p><strong>Zone :</strong> ${escapeHtml(s.zone)}</p>` : ''}
        <p><strong>Date :</strong> ${escapeHtml(s.dateStr)} — <strong>Marque :</strong> ${s.brandLabel} — <strong>Mode :</strong> ${s.modeLabel}</p>
        <h2>Détail par pièce</h2>
        <ul>${s.roomDetails.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
        <h2>Équipements recommandés</h2>
        <ul>${s.equipments.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul>
        <p class="print-disclaimer">Dimensionnement indicatif généré par ProSizer B2B. À valider par un professionnel avant installation.</p>
    `;
    window.print();
}

function shareResults() {
    const s = buildResultSummaryLines();
    if (!s) return;
    const lines = [
        'ProSizer B2B — Fiche de dimensionnement',
        s.client ? `Client : ${s.client}` : null,
        s.zone ? `Zone : ${s.zone}` : null,
        `Marque : ${s.brandLabel} — Mode : ${s.modeLabel}`,
        '',
        'Détail par pièce :',
        ...s.roomDetails.map(r => `- ${r}`),
        '',
        'Équipements recommandés :',
        ...s.equipments.map(e => `- ${e}`)
    ].filter(l => l !== null);
    const text = lines.join('\n');

    if (navigator.share) {
        navigator.share({ title: 'ProSizer B2B — Dimensionnement', text }).catch(() => {});
    } else {
        const subject = encodeURIComponent(`ProSizer B2B — Dimensionnement${s.client ? ' — ' + s.client : ''}`);
        const body = encodeURIComponent(text);
        window.location.href = `mailto:?subject=${subject}&body=${body}`;
    }
}

// Ré-applique le choix de l'utilisateur et redessine les résultats, en conservant ce qui est
// déjà saisi dans les champs Client / Zone (le rendu régénère tout le bloc résultats).
function withSaveInputsPreserved(mutateFn) {
    const clientEl = document.getElementById('save-client');
    const zoneEl = document.getElementById('save-zone');
    const clientVal = clientEl ? clientEl.value : '';
    const zoneVal = zoneEl ? zoneEl.value : '';
    mutateFn();
    const newClientEl = document.getElementById('save-client');
    const newZoneEl = document.getElementById('save-zone');
    if (newClientEl) newClientEl.value = clientVal;
    if (newZoneEl) newZoneEl.value = zoneVal;
}

function selectMono(idx) {
    withSaveInputsPreserved(() => { state.selection.mono = idx; renderResults(); });
}
function selectDedicated(roomIndex, idx) {
    withSaveInputsPreserved(() => { state.selection.dedicated[roomIndex] = idx; renderResults(); });
}
function selectGroupGamme(roomIndex, gamme) {
    withSaveInputsPreserved(() => { state.selection.group[roomIndex] = gamme; renderResults(); });
}
// Changer de groupe extérieur peut changer les gammes d'UI compatibles (ex: Panasonic Multi TZ
// vs Multi Z Deluxe) : on re-seede les choix par défaut pour rester cohérent, en préservant le
// choix de l'utilisateur là où il reste valide pour le nouveau groupe (voir seedGroupGammeDefaults).
function selectGroup(idx) {
    withSaveInputsPreserved(() => {
        state.selection.groupChoice = idx;
        const m = state.currentCalc && state.currentCalc.multi;
        if (m && m.groupOptions[idx]) {
            seedGroupGammeDefaults(m.standardRooms, m.groupOptions[idx].gammes_compatibles);
        }
        renderResults();
    });
}

function renderBesoinsCard(reqs, isMulti = false, roomsData = []) {
    let totF = reqs.reduce((a, b) => a + b.froid, 0);
    let totC = reqs.reduce((a, b) => a + b.chaud, 0);
    let details = '';
    if (isMulti) {
        details = `<div class="mt-3 border-t border-gray-100 pt-2 flex flex-col gap-1">` +
            roomsData.map(r => `<div class="flex justify-between text-[11px] text-gray-500"><span>Pièce ${r.index}${r.nom ? ' — ' + escapeHtml(r.nom) : ''}</span><span>${r.req.froid.toFixed(1)} kW F / ${r.req.chaud.toFixed(1)} kW C</span></div>`).join('') + `</div>`;
    }
    return `<div class="bg-white border border-gray-200 rounded-xl p-4 shadow-sm flex flex-col gap-2 mb-4 mt-2">
        <span class="text-xs font-bold text-gray-400 uppercase tracking-wider">Bilan Thermique Cumulé</span>
        <div class="flex gap-3">
            <span class="bg-blue-50 text-blue-700 px-3 py-1.5 rounded-md text-sm font-bold border border-blue-100 flex-1 text-center">Froid: ${totF.toFixed(2)} kW</span>
            <span class="bg-red-50 text-red-700 px-3 py-1.5 rounded-md text-sm font-bold border border-red-100 flex-1 text-center">Chaud: ${totC.toFixed(2)} kW</span>
        </div>
        ${details}
    </div>`;
}

// Contenu factuel de la fiche gamme (idéal pour / plus / moins / wifi). Réutilisé en mono (dépliant) et en multi (chips par pièce).
function gammeGuideContent(gammeName) {
    const g = GAMMES_INFO[state.brand][gammeName];
    if (!g) return '';
    const wifiColor = g.wifi === 'De série' ? 'text-green-600' : 'text-amber-600';
    return `
    <div class="flex flex-col gap-2 text-[11px]">
        <div class="bg-gray-50 rounded-lg p-2.5 text-gray-700"><span class="font-bold text-gray-500 uppercase text-[11px] tracking-wider">Idéal pour</span><br>${g.ideal}</div>
        <div class="flex flex-col gap-1">
            ${g.plus.map(p => `<div class="flex items-start gap-1.5 text-green-700"><span class="font-bold">✓</span><span>${p}</span></div>`).join('')}
            ${g.moins.map(m => `<div class="flex items-start gap-1.5 text-amber-700"><span class="font-bold">!</span><span>${m}</span></div>`).join('')}
        </div>
        <div class="text-[11px] text-gray-400 font-medium">Wifi : <span class="${wifiColor} font-bold">${g.wifi}</span></div>
    </div>`;
}

// Fiche "carte d'identité" de la gamme, dépliable sous la carte résultat. Retourne '' si gamme inconnue.
function renderGammeGuide(gammeName) {
    const g = GAMMES_INFO[state.brand][gammeName];
    if (!g) return '';
    return `
    <details class="mt-4 pt-3 border-t border-gray-100 group/guide">
        <summary class="cursor-pointer text-[11px] font-bold text-gray-500 hover:text-[var(--brand-accent)] flex items-center gap-1.5 select-none">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
            Guide de la gamme
            <span class="ml-auto text-[11px] font-extrabold bg-gray-100 text-gray-600 px-2 py-0.5 rounded">${g.tier}</span>
            <svg class="w-4 h-4 transition-transform group-open/guide:rotate-180 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
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
            return `<div class="py-2.5 border-b border-gray-100 last:border-0 text-xs text-orange-700 italic">Pièce ${r.index} : aucune UI du catalogue ne couvre ce besoin.</div>`;
        }
        const sols = findBestMonos(r.froidMatch, r.chaudMatch, state.brand);
        const storedGamme = state.selection.group[r.index];
        const selectedGamme = gammesUniques.includes(storedGamme) ? storedGamme : gammesUniques[0];
        const chips = gammesUniques.map(g => {
            const isSel = g === selectedGamme;
            const gEsc = g.replace(/'/g, "\\'");
            const solForG = sols.find(s => s.gamme === g);
            const tvaInfo = getTvaInfo(g, solForG.reference_ensemble, 'multiUi', state.brand, group.reference);
            return `
            <div>
                <button type="button" onclick="selectGroupGamme(${r.index}, '${gEsc}')" class="cursor-pointer inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1.5 rounded-full select-none transition-colors border-2 ${isSel ? 'bg-[var(--brand-accent)] border-[var(--brand-accent)] text-white' : 'bg-gray-100 border-transparent hover:bg-gray-200 text-gray-700'}">
                    ${isSel ? '✓ ' : ''}${g}
                </button>
                ${renderTvaBadge(tvaInfo)}
                <details class="group/mg mt-1" onclick="event.stopPropagation()">
                    <summary class="cursor-pointer text-[11px] text-gray-400 hover:text-gray-600 select-none">Détails</summary>
                    <div class="mt-2 mb-1">${gammeGuideContent(g)}</div>
                </details>
            </div>`;
        }).join('');
        return `
        <div class="py-3 border-b border-gray-100 last:border-0">
            <div class="text-xs font-bold text-gray-700 mb-2">Pièce ${r.index}${r.nom ? ' — ' + escapeHtml(r.nom) : ''} <span class="font-normal text-gray-400">— ${r.req.froid.toFixed(1)} kW F / ${r.req.chaud.toFixed(1)} kW C</span></div>
            <div class="flex flex-wrap gap-3">${chips}</div>
        </div>`;
    }).join('');

    return `
    <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-5 mb-4 fade-in">
        <h3 class="text-sm font-bold text-toshiba-dark flex items-center gap-2 mb-1 uppercase tracking-wide">
            <svg class="w-5 h-5 text-[var(--brand-accent)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
            Guide de sélection des unités intérieures
        </h3>
        <p class="text-[11px] text-gray-400 mb-1">Sélectionnez la gamme souhaitée pour chaque pièce${allowedGammes ? ` (compatibles avec ${allowedGammes.join(' / ')})` : ''}. Vous pouvez mixer les gammes sur un même groupe extérieur pour éviter de surdimensionner une petite pièce. En multisplit, la TVA à 5,5% est portée par le groupe extérieur : toutes les unités intérieures raccordées à un groupe éligible en bénéficient, sans condition de module Wifi — y compris les gammes et tailles refusées en monosplit (Naka, Yukai 18 et 24).</p>
        ${rows}
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
    const dominante = pieceDominante(rooms);
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
        return {
            ton: 'ok',
            message: `Groupe supérieur retenu automatiquement pour tenir la demande simultanée : ${roomLabel(dominante)} ne représente plus que ${pct(ratioSel)}% de la puissance du ${selectedGroup.reference} (limite ${seuilPct}%).${detailBase}`
        };
    }

    if (ratioSel > SEUIL_DESEQUILIBRE_GROUPE) {
        const solution = equil
            ? ` Le ${equil.reference} (${puissances(equil)}), proposé en premier choix, ramène cette part à ${pct(ratioPieceDominante(equil, rooms))}% ; un monosplit dédié pour cette pièce est l'autre solution.`
            : ` Aucun groupe plus puissant du catalogue ne rééquilibre cette configuration : un monosplit dédié pour cette pièce est à envisager.`;
        return {
            ton: equil ? 'escalade' : 'alerte',
            message: `${roomLabel(dominante)} représente à elle seule ${pct(ratioSel)}% de la puissance du ${selectedGroup.reference} (limite ${seuilPct}%) : les autres pièces peuvent manquer de capacité en cas de forte demande simultanée.${solution}`
        };
    }

    return null;
}

// Bandeau de la note d'équilibre, au-dessus des cartes de groupe extérieur (contrairement aux notes
// climat, elle dépend du groupe sélectionné : sa place est donc à côté des solutions concernées).
function renderBalanceNote(analyse) {
    const styles = {
        ok:       { classes: 'bg-emerald-50 border-emerald-200 text-emerald-800', icone: '✅' },
        escalade: { classes: 'bg-amber-50 border-amber-200 text-amber-800', icone: '⚠️' },
        alerte:   { classes: 'bg-amber-50 border-amber-200 text-amber-800', icone: '⚠️' }
    }[analyse.ton];
    return `<div class="p-2.5 ${styles.classes} border rounded-lg text-[11px] font-medium text-center mb-4">${styles.icone} ${escapeHtml(analyse.message)}</div>`;
}

// Taux de charge = besoin réel / puissance nominale catalogue. En dessous de ~50%, un
// inverter résidentiel cycle court (marche/arrêt fréquents) : confort et rendement réel
// dégradés malgré une puissance affichée confortable — d'où l'alerte, absente jusqu'ici.
function renderChargeBadge(reqFroid, reqChaud, nominalFroid, nominalChaud) {
    if (!reqFroid || !nominalFroid) return '';
    const chargeF = reqFroid / nominalFroid;
    const chargeC = (reqChaud && nominalChaud) ? reqChaud / nominalChaud : null;
    const minCharge = chargeC !== null ? Math.min(chargeF, chargeC) : chargeF;
    const sousCharge = minCharge < SEUIL_SOUS_CHARGE;
    const classes = sousCharge ? 'bg-amber-50 text-amber-700 border-amber-300' : 'bg-gray-50 text-gray-500 border-gray-200';
    const label = `Taux de charge : ${Math.round(chargeF * 100)}% F${chargeC !== null ? ` / ${Math.round(chargeC * 100)}% C` : ''}`;
    const warn = sousCharge ? ` <span title="Machine surdimensionnée pour ce besoin : cycles courts, confort et rendement réel dégradés.">⚠️</span>` : '';
    return `<div class="mt-2 inline-flex items-center gap-1 text-[11px] font-bold px-2 py-1 rounded-full border ${classes}">${label}${warn}</div>`;
}

// selectOpts = null (carte simple, non sélectionnable) ou { selected: bool, onclick: string }
// quand plusieurs solutions équivalentes sont proposées et que l'utilisateur doit en choisir une.
function renderCard(badgeText, mainTitle, subtitle, froid, chaud, isMulti = false, sizes = [], selectOpts = null, tvaInfo = null, chargeInfo = null) {
    let footer = '';
    if (isMulti) {
        footer = `<div class="mt-4 pt-4 border-t border-gray-100 flex flex-wrap gap-2 items-center">
            <span class="text-xs font-bold text-gray-500">Tailles UI à connecter :</span>
            ${sizes.map(s => `<span class="text-[11px] font-black bg-gray-800 border border-gray-700 px-2 py-1 rounded text-white shadow-inner">${s}</span>`).join('')}
        </div>`;
    }

    let wrapperClasses = 'bg-white rounded-xl shadow-md border-l-4 border-[var(--brand-accent)] p-5 fade-in transition hover:shadow-lg mb-4 relative overflow-hidden';
    let clickAttr = '';
    let selectFooter = '';
    let gammeGuideBlock = renderGammeGuide(mainTitle);

    if (selectOpts) {
        // role="button" + tabindex rend la carte focusable au clavier, mais un onclick seul ne
        // répond ni à Entrée ni à Espace : on délègue explicitement au clic déjà câblé.
        clickAttr = ` onclick="${selectOpts.onclick}" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click();}" role="button" tabindex="0"`;
        wrapperClasses += selectOpts.selected
            ? ' cursor-pointer ring-2 ring-[var(--brand-accent)] ring-offset-2'
            : ' cursor-pointer opacity-60 hover:opacity-100 saturate-50 hover:saturate-100';
        selectFooter = `
        <div class="mt-4 pt-3 border-t border-gray-100 flex items-center justify-center">
            ${selectOpts.selected
                ? `<span class="inline-flex items-center gap-1.5 text-xs font-bold text-white bg-[var(--brand-accent)] px-3 py-1.5 rounded-full"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg> Solution sélectionnée</span>`
                : `<span class="inline-flex items-center gap-1.5 text-xs font-bold text-gray-500 border border-gray-300 px-3 py-1.5 rounded-full">Choisir cette solution</span>`
            }
        </div>`;
        // Empêche l'ouverture du guide de gamme de déclencher aussi la sélection de la carte.
        gammeGuideBlock = `<div onclick="event.stopPropagation()">${gammeGuideBlock}</div>`;
    }

    return `
    <div class="${wrapperClasses}"${clickAttr}>
        <div class="absolute -right-4 -top-4 opacity-5 pointer-events-none"><svg class="w-32 h-32" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zm0 7.5l-6-3v6.5l6 3 6-3V6.5l-6 3z"/></svg></div>
        <div class="flex justify-between items-start gap-4 relative z-10">
            <div class="flex-grow">
                <div class="text-[11px] font-black uppercase text-[var(--brand-accent)] mb-1 tracking-widest">${badgeText}</div>
                <h3 class="text-lg font-extrabold text-toshiba-dark leading-tight">${mainTitle}</h3>
                <p class="text-xs font-mono text-gray-500 mt-1">${subtitle}</p>
                ${renderTvaBadge(tvaInfo)}
                ${chargeInfo ? renderChargeBadge(chargeInfo.reqFroid, chargeInfo.reqChaud, froid, chaud) : ''}
            </div>
            <div class="flex flex-col gap-2 min-w-[90px]">
                <div class="bg-blue-50 px-3 py-1 rounded-lg text-center border border-blue-100">
                    <div class="text-[11px] font-bold text-blue-500 uppercase tracking-tighter leading-none">Froid Nom.</div>
                    <div class="text-sm font-black text-blue-700">${froid} kW</div>
                </div>
                <div class="bg-red-50 px-3 py-1 rounded-lg text-center border border-red-100">
                    <div class="text-[11px] font-bold text-red-500 uppercase tracking-tighter leading-none">Chaud Nom.</div>
                    <div class="text-sm font-black text-red-700">${chaud} kW</div>
                </div>
            </div>
        </div>
        ${gammeGuideBlock}
        ${footer}
        ${selectFooter}
    </div>`;
}

// Pastilles HTML "TVA 5,5% / TVA 20% / TVA à vérifier" + mention Wifi si un module est nécessaire
// pour en bénéficier. Le statut 'a_verifier' correspond à une référence absente du tableau
// d'éligibilité Toshiba : l'outil ne promet pas 5,5% mais ne condamne pas non plus à 20%.
function renderTvaBadge(tvaInfo) {
    if (!tvaInfo) return '';
    const badges = {
        eligible:     `<span class="inline-flex items-center gap-1 text-[11px] font-black px-2 py-1 rounded-full bg-green-100 text-green-700 border border-green-300">TVA 5,5%</span>`,
        non_eligible: `<span class="inline-flex items-center gap-1 text-[11px] font-black px-2 py-1 rounded-full bg-red-100 text-red-700 border border-red-300">TVA 20%</span>`,
        a_verifier:   `<span class="inline-flex items-center gap-1 text-[11px] font-black px-2 py-1 rounded-full bg-gray-100 text-gray-600 border border-gray-300" title="Référence absente du tableau d'éligibilité Toshiba : à confirmer auprès du constructeur avant de facturer en 5,5%.">TVA à vérifier</span>`
    };
    const wifi = tvaInfo.wifiRequired
        ? `<span class="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200">📶 Module Wifi requis</span>`
        : '';
    return `<div class="flex flex-wrap gap-1.5 mt-2">${badges[tvaInfo.statut] || badges.a_verifier}${wifi}</div>`;
}

function tvaSuffixText(tvaInfo) {
    if (!tvaInfo) return '';
    const libelles = { eligible: 'TVA 5,5%', non_eligible: 'TVA 20%', a_verifier: 'TVA à vérifier (référence absente du tableau Toshiba)' };
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
    addRoom, calculate, duplicateRoom, exportPdf, persistDraft, removeRoom, saveChantier,
    selectGroupGamme, setBrand, setMode, setUsage, shareResults, startNewCalcul, toggleCustomCoef,
    toggleDashboard, updateClimateInfo, updateRoom, selectDedicated, selectGroup, selectMono
});

window.onload = initApp;
