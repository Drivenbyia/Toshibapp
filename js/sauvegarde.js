// Logique pure de sauvegarde / restauration des chantiers : validation de forme,
// déduplication et fusion. Aucun accès au DOM, à localStorage ni au réseau — ce module est
// testable indépendamment de l'interface (voir tests/sauvegarde.test.mjs), contrairement à
// app.js qui touche `window` dès son chargement.

export const FORMAT_SAUVEGARDE = 'prosizer-chantiers';

// Forme attendue : un objet { <nomClient>: { configurations: [...] } }. Une valeur
// analysable mais corrompue (un tableau, une chaîne, un objet sans `configurations`)
// partait jusqu'ici directement dans Object.keys() / .configurations et cassait le rendu.
export function formeChantiersValide(v) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
    return Object.values(v).every((c) =>
        c !== null && typeof c === 'object' && !Array.isArray(c) && Array.isArray(c.configurations));
}

// Signature de déduplication : deux enregistrements identiques sur ces trois champs sont le
// même relevé réimporté, pas deux relevés distincts.
export function signatureConfig(cfg) {
    return `${cfg.zone}|${cfg.date}|${cfg.resultStr}`;
}

// Vérifie qu'un fichier importé est bien une sauvegarde produite par l'application.
export function sauvegardeValide(charge) {
    return Boolean(charge)
        && charge.format === FORMAT_SAUVEGARDE
        && formeChantiersValide(charge.chantiers);
}

// La restauration FUSIONNE, elle ne remplace jamais : un utilisateur qui restaure une vieille
// sauvegarde par erreur ne doit pas perdre les chantiers saisis depuis. Les entrées déjà
// présentes sont comptées comme ignorées plutôt que dupliquées.
export function fusionnerChantiers(actuels, importes) {
    const sortie = JSON.parse(JSON.stringify(actuels));
    let ajoutes = 0;
    let ignores = 0;

    for (const [client, data] of Object.entries(importes)) {
        if (!sortie[client]) sortie[client] = { configurations: [] };
        const connues = new Set(sortie[client].configurations.map(signatureConfig));

        for (const cfg of data.configurations) {
            const sig = signatureConfig(cfg);
            if (connues.has(sig)) { ignores++; continue; }
            sortie[client].configurations.push(cfg);
            connues.add(sig);
            ajoutes++;
        }
    }
    return { chantiers: sortie, ajoutes, ignores };
}

// Contenu du fichier téléchargé. `exporteLe` est en ISO (et non en format d'affichage
// fr-FR comme le champ `date` des enregistrements) pour rester analysable et triable.
export function construireSauvegarde(chantiers, maintenant) {
    return {
        format: FORMAT_SAUVEGARDE,
        version: 1,
        exporteLe: maintenant.toISOString(),
        chantiers
    };
}

export function compterChantiers(chantiers) {
    const clients = Object.keys(chantiers).length;
    const configs = Object.values(chantiers).reduce((n, c) => n + c.configurations.length, 0);
    return { clients, configs };
}
