// Adaptateur localStorage à résultat typé. « Absent », « illisible » (accès refusé —
// navigation privée Safari, quota dépassé) et « corrompu » (JSON invalide) ne doivent
// jamais se confondre : les traiter pareil fait écraser une donnée existante par la
// sauvegarde suivante après une lecture qui a simplement échoué — une perte silencieuse
// et définitive. Aucun état interne : chaque appel relit/réécrit directement localStorage.

export function kvGet(key) {
    let brut;
    try {
        brut = localStorage.getItem(key);
    } catch (e) {
        return { ok: false, reason: 'illisible', error: e };
    }
    if (brut === null) return { ok: false, reason: 'absent' };

    try {
        return { ok: true, value: JSON.parse(brut) };
    } catch (e) {
        return { ok: false, reason: 'corrompu', error: e };
    }
}

export function kvSet(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e };
    }
}

export function kvRemove(key) {
    try {
        localStorage.removeItem(key);
        return true;
    } catch (e) {
        return false;
    }
}
