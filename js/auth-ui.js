// Écran de connexion et badge de compte. Délégation d'événements avec `data-action`, le même
// modèle déjà éprouvé au tableau de bord (voir initDashboardEvents dans js/app.js) : aucun
// `onclick=` inline ici, donc rien à ajouter à la liste blanche Object.assign(window, {...})
// qui n'existe que pour maintenir en vie les attributs hérités.
import * as account from './account.js';
import { supabaseConfigured } from './config.js';

function echapper(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function libelleBadge(status, email) {
    switch (status) {
        case 'authenticated': return email || 'Connecté';
        case 'stale': return `${email || 'Compte'} · hors ligne`;
        case 'revoked': return 'Session expirée';
        default: return 'Se connecter';
    }
}

export function renderAccountBadge() {
    const badge = document.getElementById('account-badge');
    if (!badge) return;
    const status = account.getStatus();
    badge.textContent = libelleBadge(status, account.getUserEmail());
    badge.dataset.status = status;
}

function messageErreurConnexion(error) {
    if (error && error.nonConfigure) return "Configuration Supabase manquante sur ce poste.";
    if (error && error.status === 400) return "Adresse e-mail ou mot de passe incorrect.";
    return "Connexion impossible. Vérifiez votre connexion réseau et réessayez.";
}

function renderOverlayContent(erreur) {
    const zone = document.getElementById('auth-overlay-content');
    if (!zone) return;
    const status = account.getStatus();

    if (status === 'authenticated' || status === 'stale') {
        zone.innerHTML = `
            <h2 class="text-lg font-semibold text-ink-900">Compte</h2>
            <p class="text-sm text-ink-500 mb-4 break-words">${echapper(account.getUserEmail() || '')}</p>
            ${status === 'stale' ? `
            <div class="k-note k-note-alert k-note-alert-warn mb-4">
                <span class="min-w-0">Hors ligne : la session n'a pas pu être reconfirmée, mais vos chantiers restent
                pleinement accessibles sur cet appareil.</span>
            </div>` : ''}
            <div class="flex gap-2">
                <button data-action="logout" class="k-btn-soft flex-1">Se déconnecter</button>
                <button data-action="close-overlay" class="k-btn-dark flex-1">Fermer</button>
            </div>`;
        return;
    }

    if (!supabaseConfigured()) {
        zone.innerHTML = `
            <h2 class="text-lg font-semibold text-ink-900 mb-1">Connexion</h2>
            <p class="text-sm text-ink-600 mb-4 leading-relaxed">La connexion aux comptes n'est pas encore configurée sur ce poste.</p>
            <button data-action="close-overlay" class="k-btn-dark w-full">Fermer</button>`;
        return;
    }

    zone.innerHTML = `
        <h2 class="text-lg font-semibold text-ink-900 mb-4">Connexion</h2>
        ${status === 'revoked' ? `
        <div class="k-note k-note-alert k-note-alert-danger mb-4">
            <span class="min-w-0">Votre session a expiré. Reconnectez-vous, ou continuez sans compte : vos chantiers
            restent disponibles sur cet appareil.</span>
        </div>` : ''}
        <div class="flex flex-col gap-3 mb-3">
            <input type="email" id="auth-email" placeholder="Adresse e-mail" autocomplete="username" class="k-input">
            <input type="password" id="auth-password" placeholder="Mot de passe" autocomplete="current-password" class="k-input">
        </div>
        ${erreur ? `<p class="text-xs font-semibold text-rose-600 mb-3">${echapper(erreur)}</p>` : ''}
        <button data-action="login-submit" class="k-btn-dark w-full mb-1">Se connecter</button>
        <button data-action="continue-offline" class="k-btn-ghost w-full text-xs">Continuer sans compte</button>`;
}

function ouvrirOverlay() {
    renderOverlayContent(null);
    const overlay = document.getElementById('auth-overlay');
    overlay.classList.remove('hidden');
    overlay.classList.add('flex');
}

function fermerOverlay() {
    const overlay = document.getElementById('auth-overlay');
    overlay.classList.add('hidden');
    overlay.classList.remove('flex');
}

export function initAuthUi() {
    const badge = document.getElementById('account-badge');
    if (badge) badge.addEventListener('click', ouvrirOverlay);

    const overlay = document.getElementById('auth-overlay');
    if (overlay) {
        overlay.addEventListener('click', async (e) => {
            if (e.target === overlay) { fermerOverlay(); return; }

            const btn = e.target.closest('[data-action]');
            if (!btn) return;

            if (btn.dataset.action === 'close-overlay' || btn.dataset.action === 'continue-offline') {
                fermerOverlay();
            } else if (btn.dataset.action === 'logout') {
                await account.logout();
                fermerOverlay();
            } else if (btn.dataset.action === 'login-submit') {
                const email = (document.getElementById('auth-email') || {}).value || '';
                const password = (document.getElementById('auth-password') || {}).value || '';
                if (!email || !password) {
                    renderOverlayContent("Renseignez l'adresse e-mail et le mot de passe.");
                    return;
                }
                btn.disabled = true;
                btn.textContent = 'Connexion…';
                const res = await account.login(email, password);
                if (!res.ok) {
                    renderOverlayContent(messageErreurConnexion(res.error));
                    return;
                }
                fermerOverlay();
            }
        });
    }

    account.subscribe(renderAccountBadge);
    renderAccountBadge();
}
