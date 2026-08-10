// Règles de réconciliation et correction de dérive d'horloge. Fonctions **pures** : aucun
// DOM, aucun stockage, aucun réseau, aucune horloge lue directement — tout est injecté par
// l'appelant. C'est le cœur intellectuel de la synchronisation, et donc la partie qui doit
// être exhaustivement testable sans backend (voir tests/reconcile.test.mjs).

// ---------------------------------------------------------------------------
// Correspondance de forme entre l'enregistrement local et la ligne Postgres
// ---------------------------------------------------------------------------
// `brand`, `mode` et `result_str` sont promus en colonnes côté serveur pour permettre un
// affichage de liste sans désérialiser le JSON — mais ils restent présents dans `body`, qui
// fait autorité au retour. La promotion est une projection, jamais une source de vérité
// parallèle : ne jamais reconstruire `body` à partir des colonnes promues.
export function toRemoteRow(local) {
    return {
        id: local.id,
        client_name: local.clientName,
        zone: local.zone,
        brand: local.body && local.body.brand,
        mode: local.body && local.body.mode,
        result_str: local.body && local.body.resultStr,
        body: local.body,
        saved_at: local.savedAt,
        created_at: local.createdAt,
        updated_at: local.updatedAt,
        deleted_at: local.deletedAt
        // `owner` et `seq` sont volontairement absents : imposés par le trigger serveur.
    };
}

export function fromRemoteRow(row) {
    return {
        id: row.id,
        clientName: row.client_name,
        zone: row.zone,
        body: row.body,
        savedAt: row.saved_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        deletedAt: row.deleted_at || null,
        seq: row.seq
    };
}

// ---------------------------------------------------------------------------
// La règle de conflit
// ---------------------------------------------------------------------------
// **Dernier écrit gagne, sur l'enregistrement ENTIER, et le perdant est conservé.**
//
// Sur l'enregistrement entier, jamais champ par champ : `resultStr`, `equipments` et
// `roomDetails` sont un instantané dérivé et cohérent de `rooms` + `params` + `selection`.
// Fusionner les `rooms` d'un appareil avec les `equipments` d'un autre produirait un
// document annonçant cinq pièces à côté d'un matériel dimensionné pour trois — un devis
// faux mais parfaitement crédible, remis à un client final. On ne fusionne jamais l'intérieur
// d'une configuration.
//
// Le perdant est conservé : c'est ce qui rend le dernier-écrit-gagne acceptable. Rien ne
// disparaît, l'utilisateur arbitre à la main dans le cas rare.
//
// `local` est l'enregistrement interne du magasin (avec `rev`/`syncedRev`), `remote` le
// résultat de fromRemoteRow(). Renvoie une décision, jamais un effet de bord — c'est
// store.applyRemote() qui l'exécute.
export function reconcile(local, remote) {
    // Jamais vu cet identifiant : insertion pure, aucun conflit possible.
    if (!local) return { action: 'insert', record: remote };

    // Rien de local non poussé : le distant fait autorité sans discussion. C'est le chemin
    // de très loin le plus fréquent — un appareil qui se contente de rattraper les
    // écritures d'un autre.
    if (local.rev === local.syncedRev) return { action: 'take_remote', record: remote };

    // --- À partir d'ici il existe des modifications locales non encore poussées. ---

    // La suppression l'emporte toujours, dans les deux sens. Une pierre tombale est
    // définitive : « supprimé sur tous vos appareils ». La charge utile reste intacte en
    // base, et la version locale non poussée part en conflit pour ne rien perdre.
    if (remote.deletedAt) {
        return { action: 'take_remote', record: remote, conflict: local };
    }
    // Notre propre suppression est en file d'attente et gagnera à la poussée : on la garde.
    // Pas de conflit à créer ici — c'est l'autre appareil, celui qui a modifié, qui verra sa
    // version rétrogradée en conflit lorsqu'il tirera cette pierre tombale.
    if (local.deletedAt) {
        return { action: 'keep_local' };
    }

    // Dernier écrit gagne. À égalité stricte, on garde le local : il est déjà en file et
    // écrasera le distant, ce qui converge (l'autre appareil fera le même raisonnement et
    // le dernier arrivé au serveur l'emporte, puis les deux le tirent).
    if (remote.updatedAt > local.updatedAt) {
        return { action: 'take_remote', record: remote, conflict: local };
    }
    return { action: 'keep_local' };
}

// ---------------------------------------------------------------------------
// Dérive d'horloge
// ---------------------------------------------------------------------------
// Trois défenses, dont deux vivent ici (la troisième est le curseur `seq` assigné par le
// serveur, qui n'utilise jamais l'heure d'un client — voir sql/001_schema.sql).

// Chaque réponse HTTP porte un en-tête `Date`. L'écart avec l'horloge locale donne un
// décalage approximatif — biaisé d'environ un demi aller-retour réseau, ce qui est sans
// importance ici : on cherche à détecter des dérives de minutes ou d'années (une tablette
// mal réglée), pas à faire du NTP à la milliseconde près.
export function computeClockOffset(serverDateMs, localNowMs) {
    if (!Number.isFinite(serverDateMs) || !Number.isFinite(localNowMs)) return null;
    return serverDateMs - localNowMs;
}

// Moyenne mobile exponentielle : lisse le bruit de latence réseau sans réagir brutalement à
// un aller-retour anormalement lent.
export function smoothClockOffset(previous, sample, alpha = 0.3) {
    if (sample === null || !Number.isFinite(sample)) return previous;
    if (previous === null || !Number.isFinite(previous)) return sample;
    return Math.round(previous * (1 - alpha) + sample * alpha);
}

export const MAX_SKEW_MS = 5 * 60 * 1000;   // 5 minutes

// Bride du futur. Une tablette dont l'horloge affiche 2030 gagnerait sinon **tous** les
// conflits, pour toujours, de façon invisible — c'est la panne d'horloge qui mord réellement
// en pratique, bien plus qu'une dérive de quelques secondes. On plafonne à « le plus haut
// horodatage jamais observé + une marge », ce qui laisse le cas normal totalement intact
// tout en rendant impossible un saut arbitraire dans le futur.
export function clampFutureTimestamp(candidateMs, highestSeenMs, maxSkewMs = MAX_SKEW_MS) {
    if (!Number.isFinite(candidateMs)) return candidateMs;
    if (!Number.isFinite(highestSeenMs)) return candidateMs;
    const plafond = highestSeenMs + maxSkewMs;
    return candidateMs > plafond ? plafond : candidateMs;
}

// Horodatage d'écriture : heure locale corrigée du décalage serveur, puis bridée. Hors-ligne,
// le dernier décalage connu est réutilisé — c'est justement là que la correction sert le
// plus, puisqu'aucune réponse serveur ne viendra la rafraîchir avant la reconnexion.
export function stampNow({ localNowMs, clockOffsetMs = 0, highestSeenMs = null, maxSkewMs = MAX_SKEW_MS }) {
    const corrige = localNowMs + (Number.isFinite(clockOffsetMs) ? clockOffsetMs : 0);
    return new Date(clampFutureTimestamp(corrige, highestSeenMs, maxSkewMs)).toISOString();
}
