# Ajouter une marque à Klimo

Klimo est multi-marque par construction : `js/calcul.js` ne contient **aucun branchement
par marque** (`if (brand === ...)`), seulement des lectures de tables indexées par la clé
de marque (`CATALOGS[brand]`, `UI_SIZE_TABLES[brand]`, etc.). Ajouter une marque est donc
censé être **une opération de données dans `js/data.js`**, pas un chantier de code — c'est
l'objectif que ce document et le script `scripts/valider-marque.mjs` vérifient.

Vendre à un client posant une autre marque que Toshiba se fait en deux temps bien
distincts :

1. **Ajouter la marque au produit** (ce document) — une fois, pour tous les clients futurs
   qui poseraient cette marque.
2. **Donner la marque à un client précis** (runbook en fin de document) — une ligne en
   base par client, aucun redéploiement.

---

## 1. Ce qu'il faut récupérer du constructeur

Avant d'écrire une ligne dans `data.js`, rassembler :

- **La fiche technique de chaque monosplit** de la gamme à intégrer : puissance
  frigorifique nominale et puissance calorifique nominale, **au point d'essai normalisé
  EN 14511** (35 °C ext. / 27 °C int. en froid, +7 °C ext. / 20 °C int. en chaud — c'est
  la convention sous laquelle les fabricants publient leurs fiches, et c'est l'hypothèse
  silencieuse dont dépend tout le moteur de sélection : marge canicule, déclassement grand
  froid). Une fiche qui citerait un autre point d'essai casserait cette hypothèse sans
  qu'aucun garde-fou du code ne le détecte.
- **La fiche technique de chaque groupe extérieur multisplit** : puissance froid/chaud
  nominale du groupe, nombre de sorties (unités intérieures raccordables).
- **Le tableau d'éligibilité TVA 5,5 %**, s'il existe pour cette marque. Optionnel :
  l'application dégrade proprement vers une pastille « TVA non renseignée » en son
  absence.
- Optionnel mais recommandé commercialement : une fiche descriptive par gamme (positionnement
  prix, points forts/faibles, disponibilité Wifi) — alimente le « Guide de la gamme »
  affiché à l'installateur, sans jamais influencer le calcul lui-même.

---

## 2. Schéma exact des données

Toutes les structures ci-dessous vivent dans `js/data.js`, indexées par une clé de marque
en minuscules, sans espace (ex. `daikin`, pas `Daikin` ni `daikin france`) — c'est cette
clé qui sert de valeur dans `entitlements.brands` (Supabase), dans `state.brand`, et dans
les attributs `data-brand` du DOM.

### `CATALOGS.<marque>` — obligatoire

```js
CATALOGS.daikin = {
  monosplits: [
    {
      gamme: "Sensira",                 // string — CLÉ DE JOINTURE vers GAMMES_INFO,
                                         // TVA_RULES.mono, et groupe.gammes_compatibles.
                                         // Doit correspondre caractère pour caractère.
      reference_ensemble: "FTXF20D / RXF20D",  // string — affiché tel quel, sert aussi de
                                         // clé de recherche pour retrouver cette entrée
                                         // (tailleDepuisReference, calcul.js) : DOIT être
                                         // unique dans le tableau.
      puissance_froid_kw: 2.0,          // number > 0, nominal EN 14511 (voir §1)
      puissance_chaud_kw: 2.5           // number > 0, nominal EN 14511
    },
    // ...
  ],
  multisplits_groupes_exterieurs: [
    {
      reference: "2MXM40M",             // string, unique
      max_unites_interieures: 2,        // integer > 0 — seule contrainte de comptage vérifiée
      puissance_nominale_froid_kw: 4.0, // number > 0, nominal du GROUPE
      puissance_nominale_chaud_kw: 4.6, // number > 0
      gammes_compatibles: ["Sensira"]   // OPTIONNEL — string[]. Absent = aucune restriction
                                         // (toutes les gammes sont proposées sur ce groupe).
                                         // [] (tableau vide) exclurait TOUTES les gammes —
                                         // ce n'est PAS équivalent à l'absence du champ.
    }
    // ...
  ]
};
```

### `UI_SIZE_TABLES.<marque>` — obligatoire

Fait correspondre un besoin (kW froid, kW chaud) à un code taille commercial. **Chaque
palier doit avoir un plafond froid ET un plafond chaud explicites** — voir le commentaire
de `js/data.js` sur la régression que cette double borne a corrigée (une seule borne
partagée avait fait passer une taille sous-dimensionnée en froid).

```js
UI_SIZE_TABLES.daikin = [
    { code: "20", froidMax: 2.0, chaudMax: 2.5 },
    { code: "25", froidMax: 2.5, chaudMax: 3.3 },
    // ... trié par puissance CROISSANTE, froidMax et chaudMax doivent croître ensemble
];
```

`froidMax`/`chaudMax` = la puissance la plus élevée offerte par cette taille, tous
modèles confondus (voir `js/data.js` pour le détail). Le script de validation vérifie que
**chaque entrée de `CATALOGS.<marque>.monosplits` obtient bien une taille** — sinon cette
référence n'aura jamais de code affiché ni de rattachement TVA possible.

### `BRAND_LABELS.<marque>` — obligatoire

```js
BRAND_LABELS.daikin = 'Daikin';
```

Sans lui, le libellé retombe sur la clé technique brute partout où il est affiché (PDF,
partage, bouton).

### `GAMMES_INFO.<marque>` — optionnel, recommandé

Purement informatif — **n'entre jamais dans le calcul ni la sélection**. Alimente le
« Guide de la gamme » affiché sous chaque solution.

```js
GAMMES_INFO.daikin = {
    "Sensira": {
        tier: "€ · Entrée de gamme",
        wifi: "Option",              // comparé littéralement à 'De série' pour la couleur du badge
        plus: ["Prix contenu", "Fiabilité reconnue"],
        moins: ["Design basique"],
        ideal: "Rénovation, budget maîtrisé"
    }
};
```

### `TVA_RULES.<marque>` — entièrement optionnel

Absent = l'application affiche une pastille **« TVA non renseignée »** explicite (jamais
le silence — voir `renderTvaBadge`, `app.js`). À ne renseigner que si un tableau
d'éligibilité constructeur existe réellement.

```js
TVA_RULES.daikin = {
    mono: {
        "Sensira": {
            wifiRequired: false,
            taillesEligibles: ["20", "25"],       // codes de UI_SIZE_TABLES
            taillesNonEligibles: ["50", "60"]
            // une taille absente des deux listes → statut "à vérifier", jamais tranché à tort
        }
    },
    multi: {
        groupesEligibles: ["2MXM40M"],  // racines de référence SANS suffixe de millésime
        gammesUi: ["Sensira", "Emura"],
        wifiRequired: false
    }
};
```

Si les références du catalogue portent un suffixe de millésime que le tableau
constructeur omet (comme `-E1` chez Toshiba), déclarer aussi :

```js
SUFFIXES_MILLESIME_GROUPE.daikin = [/-V\d*$/i];  // exemple, à adapter à la vraie nomenclature
```

**Sans cette entrée, aucun suffixe n'est retiré pour cette marque** — c'est le
comportement sûr par défaut : appliquer par erreur la règle de retrait Toshiba à une
nomenclature différente ferait glisser l'éligibilité TVA d'une machine à une autre, en
silence.

---

## 3. Étapes

1. Ajouter les cinq blocs ci-dessus dans `js/data.js`, dans l'ordre : `CATALOGS`,
   `UI_SIZE_TABLES`, `BRAND_LABELS` (obligatoires), puis `GAMMES_INFO`, `TVA_RULES` /
   `SUFFIXES_MILLESIME_GROUPE` (optionnels).
2. Valider la forme des données :
   ```bash
   node scripts/valider-marque.mjs <marque>
   ```
   Corrige toute **erreur** (bloquante) ; lit les **avertissements** (n'empêchent pas de
   vendre, mais signalent une dégradation — pastille TVA absente, guide de gamme vide...).
3. Vérifier qu'aucune régression n'est introduite :
   ```bash
   npm test
   ```
4. Lancer l'application (`python3 -m http.server 8000`) et vérifier à l'œil : le bouton de
   la nouvelle marque apparaît (généré automatiquement, `genererBoutonsMarque`,
   `js/app.js` — **aucun fichier HTML à toucher**), un calcul aboutit, le matériel
   affiché est cohérent.
5. Commiter, pousser, déployer (le déploiement Netlify est automatique sur push).

Ajouter la marque au produit **ne la rend visible à personne** : `MARQUES_ACTIVES`
(`js/marques.js`) reste `['toshiba']` par défaut, et un compte ne voit que les marques
listées dans sa colonne `entitlements.brands`. C'est volontaire — voir le runbook.

---

## 4. Runbook — donner une marque à un client précis

Aucun redéploiement. Depuis la console Supabase :

```sql
update public.entitlements
set brands = '{toshiba,daikin}'   -- ou '{daikin}' seul si le client ne pose plus Toshiba
where user_id = '<uuid du client>';
```

Les valeurs doivent correspondre **exactement** (casse comprise) aux clés utilisées dans
`data.js`. Le premier élément du tableau devient la marque par défaut à l'ouverture.

⚠️ **Les droits ne sont relus qu'à la connexion** (`js/account.js`, `login()`). Modifier
`entitlements.brands` en base **ne prend effet qu'à la prochaine connexion** du client —
il n'existe aujourd'hui aucun mécanisme de révocation ou d'extension à chaud pendant une
session déjà ouverte. À anticiper si le client est en train d'utiliser l'application au
moment du changement (prévenir, ou attendre une déconnexion naturelle).

**Le test à ne pas se contenter de supposer** : créer deux comptes de test avec des
marques différentes, enregistrer un chantier sur chacun, et vérifier depuis la console
Supabase que l'un ne peut pas lire les lignes `configurations` de l'autre (RLS).

---

## 5. Limites à connaître, à ne jamais présenter comme des garanties qu'elles ne sont pas

- **Les droits ne pilotent que l'interface, pas l'accès aux données du catalogue.**
  `js/data.js` contient les catalogues de **toutes** les marques et est servi tel quel à
  tout le monde (précaché pour l'usage hors-ligne, `sw.js`). Un client dont le compte
  n'autorise que Toshiba peut techniquement lire le catalogue Daikin en ouvrant
  `/js/data.js` dans son navigateur. C'est du masquage d'interface, pas du cloisonnement
  de données — acceptable pour des catalogues publics de constructeurs (l'information n'a
  rien de confidentiel en soi), mais à ne jamais décrire comme une protection des données
  d'un client vis-à-vis d'un autre. L'isolation qui compte réellement — les chantiers
  saisis par chaque client — est, elle, appliquée côté serveur par la RLS Postgres.
- **Le test d'exhaustivité du service worker a un angle mort sur ce cas précis.**
  `tests/precache.test.mjs` vérifie que tout fichier sous `js/*.js` est bien précaché —
  mais uniquement ce répertoire, avec cette extension. Tant que les catalogues restent des
  littéraux JavaScript dans `js/data.js` (le choix actuel, décrit dans le plan de mise sur
  le marché), ce n'est pas un problème. Si un jour les catalogues sont externalisés en
  fichiers séparés (`data/daikin.json` par exemple) pour alléger `data.js`, ce test devra
  être élargi en premier — sans quoi un fichier de catalogue oublié dans `PRECACHE_URLS`
  ferait échouer l'installation entière du service worker (`cache.addAll` rejette en bloc
  à la moindre entrée manquante), en production, silencieusement.
