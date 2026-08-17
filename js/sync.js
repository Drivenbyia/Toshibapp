// Orchestration de la synchronisation : vide la file d'attente, tire par curseur, applique
// les décisions de réconciliation. Le transport est **injecté** — jamais importé — pour que
// toute la logique de séquencement soit testable avec un faux transport, sans backend
// (voir tests/sync.test.mjs). js/reconcile.js porte les règles ; ce module ne porte que
// l'enchaînement et la gestion des pannes.
//
// Invariant central : **une panne ne doit jamais corrompre l'état.** Une poussée qui échoue
// laisse la file intacte (on repoussera), un tirage qui échoue laisse le curseur immobile
// (on retirera depuis le même point). Le local reste la source de vérité en toutes
// circonstances.

import { reconcile, toRemoteRow, fromRemoteRow, computeClockOffset, smoothClockOffset } from './reconcile.js';

// Descendu de 200 à 100 avec l'arrivée de `body.fiche` : le corps d'un chantier multisplit est
// passé d'environ 2 à 5,5 ko, ce qui portait une page de tirage à près d'un mégaoctet. La
// pagination existe pour que la synchronisation reste faisable sur une connexion de chantier ;
// doubler le poids d'une page sans toucher au compte l'aurait vidée de son sens.
export const PAGE_SIZE = 100;

// `transport` doit exposer :
//   push(rows)             -> { ok, error?, serverDateMs? }
//   pull(sinceSeq, limit)  -> { ok, rows?, error?, serverDateMs? }
export function createSync({ store, transport }) {
    let enCours = false;
    let dernierEtat = { phase: 'idle', pending: 0, error: null };
    const listeners = new Set();

    function notify(etat) {
        dernierEtat = { ...dernierEtat, ...etat };
        listeners.forEach((fn) => fn(dernierEtat));
    }

    function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
    function getState() { return dernierEtat; }

    // Le décalage d'horloge se déduit de l'en-tête `Date` de n'importe quelle réponse — donc
    // aussi bien d'une poussée que d'un tirage, y compris quand l'opération elle-même a
    // échoué : le serveur a répondu, son heure est exploitable.
    function absorberDate(res) {
        if (!res || !Number.isFinite(res.serverDateMs)) return;
        const horloge = store.getClockState();
        const echantillon = computeClockOffset(res.serverDateMs, Date.now());
        store.setClockState({
            offsetMs: smoothClockOffset(horloge.offsetMs, echantillon),
            highestSeenMs: horloge.highestSeenMs
        });
    }

    async function pousser() {
        const enAttente = store.getPending();
        if (enAttente.length === 0) return { ok: true, pousses: 0 };

        notify({ phase: 'pushing', pending: enAttente.length });
        const res = await transport.push(enAttente.map((e) => toRemoteRow(e.record)));
        absorberDate(res);

        if (!res.ok) {
            // File laissée intacte : on repoussera au prochain passage. C'est exactement ce
            // qui rend une coupure réseau inoffensive.
            return { ok: false, error: res.error };
        }
        // On ne marque synchronisé que la révision effectivement poussée : si l'utilisateur a
        // modifié l'enregistrement pendant l'aller-retour, `rev` a avancé et la nouvelle
        // modification reste légitimement en attente.
        store.markPushed(enAttente.map(({ id, rev }) => ({ id, rev })));
        return { ok: true, pousses: enAttente.length };
    }

    async function tirer() {
        let curseur = store.getCursor();
        let total = 0;

        // Boucle de pagination : on avance tant que le serveur rend une page pleine.
        for (;;) {
            notify({ phase: 'pulling' });
            const res = await transport.pull(curseur, PAGE_SIZE);
            absorberDate(res);
            if (!res.ok) return { ok: false, error: res.error, tires: total };

            const lignes = res.rows || [];
            if (lignes.length === 0) break;

            const distants = lignes.map(fromRemoteRow);
            const decisions = distants.map((r) => ({ remote: r, decision: reconcile(store.getRaw(r.id), r) }));
            store.applyRemote(decisions);

            // Le curseur n'avance qu'APRÈS l'application réussie : une interruption au
            // milieu d'une page fait simplement rejouer cette page au passage suivant, ce
            // qui est sans effet (la réconciliation est idempotente sur un local propre).
            curseur = lignes.reduce((max, l) => (l.seq > max ? l.seq : max), curseur);
            store.setCursor(curseur);

            total += lignes.length;
            if (lignes.length < PAGE_SIZE) break;
        }
        return { ok: true, tires: total };
    }

    // **Tirage d'abord, poussée ensuite — l'ordre inverse casse la détection de conflit.**
    //
    // La poussée est un `upsert` que le serveur accepte tel quel : pousser en premier rend
    // l'enregistrement local propre, et le tirage qui suit ne voit plus aucune modification
    // locale à défendre. Le dernier-écrit-gagne serait alors arbitré par l'ordre d'arrivée
    // des poussées plutôt que par `updatedAt`, et le perdant disparaîtrait en silence — ce
    // que toute la règle de conflit vise justement à empêcher.
    //
    // En tirant d'abord, chaque modification locale non poussée est confrontée au distant
    // AVANT de partir : soit elle gagne et sera poussée juste après, soit elle perd et est
    // conservée en conflit (applyRemote retire alors son entrée de file, pour ne pas pousser
    // une version qu'on vient de juger perdante).
    //
    // Portée exacte de la garantie, dite franchement : le perdant conservé couvre le travail
    // local **non encore poussé** — celui qui n'existe nulle part ailleurs. Une version qui a
    // bien atteint le serveur puis se fait écraser par une modification plus récente d'un
    // autre appareil relève du dernier-écrit-gagne ordinaire, et n'est pas rétrogradée en
    // conflit : elle n'est pas « perdue », elle est simplement remplacée par plus récent.
    async function run() {
        if (enCours) return { ok: false, error: { dejaEnCours: true } };
        enCours = true;
        try {
            const t = await tirer();
            if (!t.ok) {
                notify({ phase: 'offline', pending: store.getPending().length, error: t.error });
                return { ok: false, error: t.error };
            }
            const p = await pousser();
            if (!p.ok) {
                notify({ phase: 'offline', pending: store.getPending().length, error: p.error });
                return { ok: false, error: p.error };
            }
            notify({ phase: 'idle', pending: store.getPending().length, error: null });
            return { ok: true, pousses: p.pousses, tires: t.tires };
        } finally {
            enCours = false;
        }
    }

    return { run, subscribe, getState };
}
