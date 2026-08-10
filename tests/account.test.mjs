// Les trois fonctions pures d'account.js portent l'exigence la plus critique du lot comptes :
// une coupure réseau ne doit JAMAIS bloquer l'accès aux données locales. Seule une réponse
// définitive du serveur (400/401) fait basculer en session révoquée — tout le reste
// (panne réseau, 5xx, délai dépassé, CORS) doit rester `stale`, qui laisse l'accès complet.
// C'est exactement ce que classifySessionCheckFailure doit garantir, et c'est le test qui
// compte le plus dans ce fichier.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    classifySessionCheckFailure, nextAuthState, resolveBrands,
    login, getStatus, subscribe
} from '../js/account.js';

describe('classifySessionCheckFailure — l\'exigence du vide sanitaire', () => {
    test('un statut 400 ou 401 est la seule chose qui produit "definitive"', () => {
        assert.equal(classifySessionCheckFailure({ status: 400 }), 'definitive');
        assert.equal(classifySessionCheckFailure({ status: 401 }), 'definitive');
    });

    test('un rejet de fetch (pas de statut du tout) produit toujours "transport"', () => {
        assert.equal(classifySessionCheckFailure(null), 'transport');
        assert.equal(classifySessionCheckFailure(undefined), 'transport');
        assert.equal(classifySessionCheckFailure(new Error('network error')), 'transport');
        assert.equal(classifySessionCheckFailure({}), 'transport');
    });

    test('tout statut non-4xx (5xx compris) produit "transport", jamais "definitive"', () => {
        for (const status of [500, 502, 503, 429, 0]) {
            assert.equal(classifySessionCheckFailure({ status }), 'transport',
                `un statut ${status} ne doit jamais révoquer la session`);
        }
    });

    test('un 403 (permission refusée, pas identité invalide) reste "transport"', () => {
        // Seuls 400/401 sont traités comme définitifs par construction — un 403 pourrait
        // provenir d'une politique RLS mal configurée, pas d'une session invalide : mieux
        // vaut rester prudent (stale) que verrouiller l'accès local par erreur.
        assert.equal(classifySessionCheckFailure({ status: 403 }), 'transport');
    });
});

describe('nextAuthState', () => {
    test('login_success mène toujours à authenticated', () => {
        for (const depart of ['anonymous', 'stale', 'revoked']) {
            assert.equal(nextAuthState(depart, { type: 'login_success' }), 'authenticated');
        }
    });

    test('logout ramène toujours à anonymous', () => {
        for (const depart of ['authenticated', 'stale', 'revoked']) {
            assert.equal(nextAuthState(depart, { type: 'logout' }), 'anonymous');
        }
    });

    test('session_check_ok mène à authenticated depuis stale', () => {
        assert.equal(nextAuthState('stale', { type: 'session_check_ok' }), 'authenticated');
    });

    test('session_check_failed route sur la raison, jamais sur l\'état de départ', () => {
        assert.equal(nextAuthState('stale', { type: 'session_check_failed', reason: 'transport' }), 'stale');
        assert.equal(nextAuthState('authenticated', { type: 'session_check_failed', reason: 'transport' }), 'stale');
        assert.equal(nextAuthState('stale', { type: 'session_check_failed', reason: 'definitive' }), 'revoked');
    });

    test('un événement inconnu ne change pas l\'état (aucune transition fantôme)', () => {
        assert.equal(nextAuthState('authenticated', { type: 'evenement_inexistant' }), 'authenticated');
        assert.equal(nextAuthState('stale', {}), 'stale');
    });
});

describe('resolveBrands', () => {
    test('anonymous renvoie null : aucune surcharge, marques.js pilote seul', () => {
        assert.equal(resolveBrands('anonymous', null), null);
        assert.equal(resolveBrands('anonymous', { brands: ['toshiba', 'panasonic'] }), null,
            'même avec un cache résiduel, un appareil jamais connecté ne doit rien surcharger');
    });

    test('session sans droits en cache (première connexion hors-ligne) : repli sur toshiba seul', () => {
        for (const status of ['authenticated', 'stale', 'revoked']) {
            assert.deepEqual(resolveBrands(status, null), ['toshiba']);
        }
    });

    test('des droits en cache, même en stale, s\'appliquent immédiatement (pas d\'attente réseau)', () => {
        assert.deepEqual(resolveBrands('stale', { brands: ['toshiba', 'panasonic'] }), ['toshiba', 'panasonic']);
    });

    test('un cache avec une liste de marques vide ou invalide dégrade vers toshiba seul', () => {
        assert.deepEqual(resolveBrands('authenticated', { brands: [] }), ['toshiba']);
        assert.deepEqual(resolveBrands('authenticated', {}), ['toshiba']);
        assert.deepEqual(resolveBrands('authenticated', { brands: 'toshiba' }), ['toshiba']);
    });
});

// Ces tests touchent le singleton exporté par account.js (comme l'application le fait) —
// pas de fausse instance possible ici, contrairement à store.js. On ne teste donc que ce qui
// reste sûr sans backend réel : la configuration Supabase absente est détectée avant tout
// appel réseau, et l'API de base répond comme attendu.
describe('account.js — singleton, sans backend Supabase réel', () => {
    test('getStatus() démarre à anonymous avant tout init()', () => {
        assert.equal(getStatus(), 'anonymous');
    });

    test('login() sans configuration Supabase échoue proprement, sans tenter de réseau', async () => {
        const res = await login('test@example.com', 'motdepasse');
        assert.equal(res.ok, false);
        assert.equal(res.error && res.error.nonConfigure, true);
    });

    test('subscribe() renvoie une fonction de désabonnement fonctionnelle', () => {
        let appels = 0;
        const desabonner = subscribe(() => { appels++; });
        assert.equal(typeof desabonner, 'function');
        desabonner();
        // Rien à observer de plus sans déclencher notify() ; on vérifie juste l'absence
        // d'exception à l'appel et au désabonnement.
        assert.equal(appels, 0);
    });
});
