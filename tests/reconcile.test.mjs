// La réconciliation est la partie de la synchronisation qu'on peut vérifier exhaustivement
// sans backend : ce sont des fonctions pures. C'est aussi celle où une erreur coûte le plus
// cher — un devis faux remis à un client final, ou un chantier disparu sans trace. D'où une
// couverture volontairement lourde, incluant les trois scénarios nommés dans le plan.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    reconcile, toRemoteRow, fromRemoteRow,
    computeClockOffset, smoothClockOffset, clampFutureTimestamp, stampNow, MAX_SKEW_MS
} from '../js/reconcile.js';

const corps = (zone) => ({
    mode: 'mono', brand: 'toshiba', usage: 'reversible', resultStr: `1x Mono ${zone}`,
    equipments: [`REF-${zone}`], roomDetails: [`Pièce ${zone}`],
    params: { deptSelect: '69' }, rooms: [{ id: 1, surface: 20 }], selection: { mono: 0 }
});

// Enregistrement local interne (avec rev/syncedRev). `dirty` = modifications non poussées.
const local = ({ zone = 'Salon', updatedAt = '2026-08-10T10:00:00.000Z', deletedAt = null, dirty = false } = {}) => ({
    id: 'cfg-1', clientName: 'Dupont', zone, body: corps(zone),
    savedAt: updatedAt, createdAt: '2026-08-01T09:00:00.000Z', updatedAt, deletedAt,
    rev: dirty ? 3 : 2, syncedRev: 2
});

const remote = ({ zone = 'Salon', updatedAt = '2026-08-10T10:00:00.000Z', deletedAt = null, seq = 10 } = {}) => ({
    id: 'cfg-1', clientName: 'Dupont', zone, body: corps(zone),
    savedAt: updatedAt, createdAt: '2026-08-01T09:00:00.000Z', updatedAt, deletedAt, seq
});

describe('reconcile — cas de base', () => {
    test('identifiant jamais vu : insertion pure, aucun conflit', () => {
        const r = remote({ zone: 'Véranda' });
        const d = reconcile(undefined, r);
        assert.equal(d.action, 'insert');
        assert.equal(d.record, r);
        assert.equal(d.conflict, undefined);
    });

    test('local propre (rien à pousser) : le distant fait autorité, sans conflit', () => {
        // Le chemin de loin le plus fréquent : un appareil qui rattrape les écritures d'un autre.
        const d = reconcile(local({ dirty: false }), remote({ zone: 'Modifié ailleurs' }));
        assert.equal(d.action, 'take_remote');
        assert.equal(d.record.zone, 'Modifié ailleurs');
        assert.equal(d.conflict, undefined);
    });

    test('local propre : le distant gagne même s\'il est PLUS ANCIEN', () => {
        // Pas de dernier-écrit-gagne ici : sans modification locale non poussée, il n'y a
        // rien à défendre. Le distant est simplement l'état de référence.
        const d = reconcile(
            local({ dirty: false, updatedAt: '2026-08-10T18:00:00.000Z' }),
            remote({ updatedAt: '2026-08-10T08:00:00.000Z' })
        );
        assert.equal(d.action, 'take_remote');
        assert.equal(d.conflict, undefined);
    });
});

describe('reconcile — dernier écrit gagne, perdant conservé', () => {
    test('distant plus récent qu\'une modification locale non poussée : distant gagne, local en conflit', () => {
        const l = local({ dirty: true, zone: 'Version locale', updatedAt: '2026-08-10T10:00:00.000Z' });
        const d = reconcile(l, remote({ zone: 'Version distante', updatedAt: '2026-08-10T11:00:00.000Z' }));

        assert.equal(d.action, 'take_remote');
        assert.equal(d.record.zone, 'Version distante');
        assert.equal(d.conflict, l, 'la version locale ne doit jamais être jetée en silence');
    });

    test('modification locale plus récente : on garde le local, il écrasera le distant', () => {
        const d = reconcile(
            local({ dirty: true, updatedAt: '2026-08-10T12:00:00.000Z' }),
            remote({ updatedAt: '2026-08-10T11:00:00.000Z' })
        );
        assert.equal(d.action, 'keep_local');
        assert.equal(d.conflict, undefined);
    });

    test('égalité stricte des horodatages : on garde le local (converge)', () => {
        // Les deux appareils font le même raisonnement, tous deux poussent, le dernier
        // arrivé au serveur l'emporte, puis les deux le tirent — état final identique.
        const meme = '2026-08-10T10:00:00.000Z';
        const d = reconcile(local({ dirty: true, updatedAt: meme }), remote({ updatedAt: meme }));
        assert.equal(d.action, 'keep_local');
    });

    test('ne fusionne JAMAIS l\'intérieur d\'une configuration', () => {
        // Le scénario redouté : des `rooms` d'un appareil à côté d'`equipments` de l'autre
        // produiraient un devis faux mais parfaitement crédible.
        const l = local({ dirty: true, zone: 'A', updatedAt: '2026-08-10T10:00:00.000Z' });
        const r = remote({ zone: 'B', updatedAt: '2026-08-10T11:00:00.000Z' });
        const d = reconcile(l, r);

        assert.deepEqual(d.record.body, r.body, 'le corps retenu doit être celui du gagnant, entier');
        assert.equal(d.record.body.resultStr, r.body.resultStr);
        assert.deepEqual(d.record.body.rooms, r.body.rooms);
        assert.deepEqual(d.record.body.equipments, r.body.equipments);
    });
});

describe('reconcile — la suppression l\'emporte toujours', () => {
    test('pierre tombale distante contre modification locale : suppression gagne, local en conflit', () => {
        const l = local({ dirty: true, zone: 'Modifiée ici' });
        const d = reconcile(l, remote({ deletedAt: '2026-08-10T11:00:00.000Z' }));

        assert.equal(d.action, 'take_remote');
        assert.ok(d.record.deletedAt, 'la pierre tombale doit être adoptée');
        assert.equal(d.conflict, l, 'la modification locale non poussée reste récupérable');
    });

    test('pierre tombale distante PLUS ANCIENNE qu\'une modification locale : elle gagne quand même', () => {
        // La suppression n'est pas soumise au dernier-écrit-gagne : elle est définitive.
        const l = local({ dirty: true, updatedAt: '2026-08-10T18:00:00.000Z' });
        const d = reconcile(l, remote({ deletedAt: '2026-08-10T08:00:00.000Z', updatedAt: '2026-08-10T08:00:00.000Z' }));

        assert.equal(d.action, 'take_remote');
        assert.ok(d.record.deletedAt);
        assert.equal(d.conflict, l);
    });

    test('notre propre suppression non poussée : on la garde, sans créer de conflit', () => {
        // C'est l'autre appareil, celui qui a modifié, qui verra sa version rétrogradée en
        // conflit lorsqu'il tirera cette pierre tombale — pas nous, qui avons supprimé
        // délibérément.
        const d = reconcile(
            local({ dirty: true, deletedAt: '2026-08-10T12:00:00.000Z' }),
            remote({ zone: 'Modifiée ailleurs', updatedAt: '2026-08-10T13:00:00.000Z' })
        );
        assert.equal(d.action, 'keep_local');
        assert.equal(d.conflict, undefined);
    });

    test('local propre et pierre tombale distante : adoptée sans conflit', () => {
        const d = reconcile(local({ dirty: false }), remote({ deletedAt: '2026-08-10T11:00:00.000Z' }));
        assert.equal(d.action, 'take_remote');
        assert.equal(d.conflict, undefined);
    });
});

describe('reconcile — les trois scénarios nommés dans le plan', () => {
    test('un appareil hors-ligne une semaine : union propre, aucun conflit', () => {
        // Ses créations portent des UUID générés côté client : collision impossible, donc
        // chaque enregistrement distant est soit inconnu (insertion), soit déjà à jour.
        const distants = [
            remote({ seq: 11 }), { ...remote({ seq: 12 }), id: 'cfg-2' }, { ...remote({ seq: 13 }), id: 'cfg-3' }
        ];
        const decisions = distants.map((r) => reconcile(undefined, r));
        assert.ok(decisions.every((d) => d.action === 'insert'));
        assert.ok(decisions.every((d) => d.conflict === undefined),
            'rattraper une semaine d\'écritures d\'un autre appareil ne doit produire aucun conflit');
    });

    test('suppression sur A, modification sur B — vu depuis B', () => {
        const editionDeB = local({ dirty: true, zone: 'Salon rénové' });
        const suppressionDeA = remote({ deletedAt: '2026-08-10T11:00:00.000Z' });
        const d = reconcile(editionDeB, suppressionDeA);

        assert.equal(d.action, 'take_remote');
        assert.ok(d.record.deletedAt, 'B doit adopter la suppression');
        assert.equal(d.conflict.zone, 'Salon rénové', 'mais garder sa version en conflit');
    });

    test('suppression sur A, modification sur B — vu depuis A', () => {
        const suppressionDeA = local({ dirty: true, deletedAt: '2026-08-10T10:00:00.000Z' });
        const editionDeB = remote({ zone: 'Salon rénové', updatedAt: '2026-08-10T11:00:00.000Z' });
        const d = reconcile(suppressionDeA, editionDeB);

        assert.equal(d.action, 'keep_local', 'A pousse sa pierre tombale, qui gagnera');
        assert.equal(d.conflict, undefined, 'A a supprimé délibérément : rien à lui restituer');
    });
});

describe('correspondance de forme local ↔ ligne Postgres', () => {
    test('aller-retour sans perte', () => {
        const l = local({ zone: 'Salon' });
        const rejoue = fromRemoteRow({ ...toRemoteRow(l), seq: 42 });

        assert.equal(rejoue.id, l.id);
        assert.equal(rejoue.clientName, l.clientName);
        assert.equal(rejoue.zone, l.zone);
        assert.deepEqual(rejoue.body, l.body);
        assert.equal(rejoue.savedAt, l.savedAt);
        assert.equal(rejoue.createdAt, l.createdAt);
        assert.equal(rejoue.updatedAt, l.updatedAt);
        assert.equal(rejoue.deletedAt, null);
        assert.equal(rejoue.seq, 42);
    });

    test('n\'envoie jamais `owner` ni `seq` : imposés par le trigger serveur', () => {
        const row = toRemoteRow(local());
        assert.equal('owner' in row, false, 'le client ne doit pas pouvoir formuler un propriétaire');
        assert.equal('seq' in row, false, 'le curseur est assigné par le serveur');
    });

    test('les colonnes promues sont une projection de body, jamais une source parallèle', () => {
        const row = toRemoteRow(local({ zone: 'Salon' }));
        assert.equal(row.brand, row.body.brand);
        assert.equal(row.mode, row.body.mode);
        assert.equal(row.result_str, row.body.resultStr);
    });

    test('un deleted_at absent est normalisé en null, pas en undefined', () => {
        assert.equal(fromRemoteRow({ ...toRemoteRow(local()), seq: 1, deleted_at: undefined }).deletedAt, null);
    });
});

describe('dérive d\'horloge', () => {
    test('computeClockOffset renvoie l\'écart signé serveur − local', () => {
        assert.equal(computeClockOffset(1000, 400), 600);
        assert.equal(computeClockOffset(400, 1000), -600);
    });

    test('computeClockOffset renvoie null sur une entrée non numérique', () => {
        assert.equal(computeClockOffset(NaN, 1000), null);
        assert.equal(computeClockOffset(1000, undefined), null);
    });

    test('smoothClockOffset adopte le premier échantillon, puis lisse', () => {
        assert.equal(smoothClockOffset(null, 1000), 1000);
        const lisse = smoothClockOffset(1000, 2000, 0.3);
        assert.ok(lisse > 1000 && lisse < 2000, 'un échantillon aberrant ne doit pas être adopté brutalement');
    });

    test('smoothClockOffset ignore un échantillon invalide plutôt que de corrompre l\'état', () => {
        assert.equal(smoothClockOffset(1000, null), 1000);
        assert.equal(smoothClockOffset(1000, NaN), 1000);
    });

    // LE test qui compte : une tablette réglée en 2030 gagnerait sinon tous les conflits,
    // pour toujours, de façon invisible.
    test('clampFutureTimestamp plafonne un horodatage aberrant', () => {
        const maintenant = Date.parse('2026-08-10T10:00:00.000Z');
        const en2030 = Date.parse('2030-01-01T00:00:00.000Z');
        const bride = clampFutureTimestamp(en2030, maintenant);

        assert.ok(bride < en2030, 'la valeur aberrante doit être ramenée');
        assert.equal(bride, maintenant + MAX_SKEW_MS);
    });

    test('clampFutureTimestamp laisse le cas normal totalement intact', () => {
        const haut = Date.parse('2026-08-10T10:00:00.000Z');
        const normal = haut + 30 * 1000;   // 30 s plus tard : parfaitement plausible
        assert.equal(clampFutureTimestamp(normal, haut), normal);
    });

    test('clampFutureTimestamp ne remonte jamais un horodatage passé', () => {
        const haut = Date.parse('2026-08-10T10:00:00.000Z');
        const passe = haut - 60 * 60 * 1000;
        assert.equal(clampFutureTimestamp(passe, haut), passe, 'seul le futur est bridé');
    });

    test('clampFutureTimestamp sans référence connue laisse passer', () => {
        assert.equal(clampFutureTimestamp(12345, null), 12345);
    });

    test('stampNow applique le décalage serveur puis la bride, et rend de l\'ISO', () => {
        const localNowMs = Date.parse('2026-08-10T10:00:00.000Z');
        const iso = stampNow({ localNowMs, clockOffsetMs: 60000, highestSeenMs: null });
        assert.equal(iso, '2026-08-10T10:01:00.000Z');
    });

    test('stampNow bride une horloge locale aberrante malgré un décalage nul', () => {
        const en2030 = Date.parse('2030-01-01T00:00:00.000Z');
        const haut = Date.parse('2026-08-10T10:00:00.000Z');
        const iso = stampNow({ localNowMs: en2030, clockOffsetMs: 0, highestSeenMs: haut });
        assert.equal(Date.parse(iso), haut + MAX_SKEW_MS);
    });
});
