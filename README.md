# Klimo

Outil de dimensionnement pour la sélection de climatisations (froid/chaud), sous forme de
**PWA** (Progressive Web App) installable sur mobile et desktop. Le catalogue couvre Toshiba
et Panasonic ; les marques visibles pour un compte donné sont contrôlées par ses droits
(`js/marques.js`, `js/account.js`) — Panasonic reste dans le code sans être exposé tant
qu'aucun compte ne l'autorise.

L'application est un site 100% statique : pas d'étape de build, pas de dépendances à installer
pour la faire tourner. `index.html` ne contient que le balisage ; la logique est répartie en
modules ES natifs du navigateur (aucun bundler) sous `js/` :

- `js/data.js` — catalogues matériel, base TVA, référentiel climatique (aucune fonction).
- `js/calcul.js` — fonctions de calcul **pures** (bilan thermique, sélection catalogue) :
  aucun accès au DOM, testables indépendamment de l'interface (voir `tests/`).
- `js/app.js` — état, rendu DOM, gestionnaires d'événements ; seul module qui touche au DOM
  ou à `localStorage`.

S'y ajoutent quelques fichiers statiques (`manifest.json`, `sw.js`, `assets/tailwind.css`,
`icons/`) nécessaires au fonctionnement PWA réel (voir plus bas).

## Fonctionnalités

- **Sélecteur de marque** : Toshiba ou Panasonic. Chaque marque a son propre catalogue
  (monosplit / multisplit) ; les résultats ne sont jamais mélangés entre marques.
- **Dimensionnement thermique** : calcul des besoins froid/chaud à partir de la surface,
  la hauteur sous plafond, le niveau d'isolation (coefficient G), le département,
  l'altitude et la consigne intérieure d'été.
- **Sélection automatique** du matériel dans le catalogue de la marque sélectionnée
  (monosplit / multisplit), avec proposition de gammes équivalentes.
  - Toshiba : Naka, Yukai, Shorai Curve, Haori, Daiseikai 10, Console Double-Flux (mono) ;
    groupes RAS-xMxxG3AVG-E (multi).
  - Panasonic : TZ Ultra Compact, Etherea (mono) ; groupes Multi TZ CU-2TZ/CU-3TZ (multi,
    compatibles avec les unités intérieures TZ Ultra Compact).
- **Architecture hybride** : en multisplit, délestage automatique des grandes pièces
  vers des monosplits dédiés.
- **Équilibre du groupe multisplit** : quand une pièce absorberait plus de 60% de la puissance
  du groupe (capacité limitée pour les autres pièces en demande simultanée), l'application
  propose d'elle-même le groupe supérieur du catalogue qui rééquilibre l'installation
  (ex. RAS-2M14 → RAS-2M18) et le sélectionne par défaut ; le groupe juste dimensionné reste
  proposé en alternative, et le monosplit dédié n'est conseillé que si aucun groupe ne
  rééquilibre.
- **Éligibilité TVA 5,5%** (Toshiba) : transcrite du tableau constructeur « TVA 5,5 éligibilité
  Toshiba v3 », avec ses deux régimes — en monosplit l'éligibilité se juge gamme par gamme et
  taille par taille (Naka refusée, Yukai refusée en 18/24, module Wifi exigé sur Yukai) ; en
  multisplit elle est portée par le groupe extérieur, qui rend éligibles toutes les unités
  intérieures raccordées, sans condition de Wifi. Une référence absente du tableau est signalée
  « TVA à vérifier » plutôt que tranchée arbitrairement.
- **Mes Chantiers** : sauvegarde locale (localStorage) des configurations par client
  et par zone.
- **PWA hors-ligne** : manifest (`manifest.json`) et service worker (`sw.js`) réels,
  servis en fichiers statiques (same-origin) — application installable et utilisable
  sans connexion après un premier chargement en ligne.

## Développement local

Aucun outil requis pour faire tourner l'app au quotidien. Servez le dossier :

```bash
python3 -m http.server 8000
# puis ouvrez http://localhost:8000
```

> Note : le service worker (mode hors-ligne) nécessite un contexte sécurisé
> (`https://` ou `http://localhost`) — ouvrir `index.html` directement en `file://`
> ne l'active pas.

### Système visuel

L'apparence de l'application est définie à deux endroits, et **nulle part ailleurs** :

- **`build/tailwind.config.js`** — les jetons : palette (`accent` teal Klimo, `ink` pour le
  texte, `line` pour les bordures, `froid` / `chaud` réservés aux puissances), ombres, rayons.
  Aucune couleur ne doit être écrite en dur ailleurs.
- **`build/input.css`** — la couche de composants (`@layer components`) : `.k-card`, `.k-input`,
  `.k-select`, `.k-btn-*`, `.k-pill-*`, `.k-note-*`, `.k-stat-*`, `.k-result`, `.k-seg`…
  C'est ce vocabulaire qu'emploient `index.html` et les gabarits de `js/app.js`.

Écrire une nouvelle carte ou un nouveau champ consiste donc à réutiliser une classe existante,
pas à recopier une pile d'utilitaires : le balisage de l'app est produit par des littéraux de
gabarit répartis dans une quinzaine de fonctions de rendu, et une valeur recopiée à la main
dans l'une d'elles se désynchronise des autres sans jamais casser un test.

Quelques conventions que le système encode :

- **Le bleu et le rouge veulent dire « froid » et « chaud »**, jamais « information » ou
  « erreur » : les encarts d'information passent par `.k-note-*`, jamais par les couleurs de mesure.
- **Cibles tactiles de 44px minimum** et champs de saisie en 16px (en dessous, iOS zoome à
  chaque prise de focus).
- **Aucun état ne se signale par l'effacement.** Une option non retenue ou un résultat périmé
  reste lisible en plein contraste ; c'est la bordure, la coche ou la saturation qui portent
  l'information (`.k-result[aria-pressed]`, `.k-stale`).
- **`aria-pressed` porte l'état sélectionné** des contrôles segmentés et des cartes ; le style
  en découle (`.k-seg-item[aria-pressed="true"]`), plutôt que l'inverse.

### Régénérer le CSS Tailwind

`assets/tailwind.css` est un CSS Tailwind pré-compilé (pas le CDN `cdn.tailwindcss.com`,
qui casse le mode hors-ligne et n'est pas destiné à la production). Il doit être régénéré
après **toute** modification de `build/input.css`, `build/tailwind.config.js`, ou après l'ajout
d'une classe Tailwind dans `index.html` ou `js/` :

```bash
npx tailwindcss@3 -i build/input.css -o assets/tailwind.css \
  --config build/tailwind.config.js --minify
```

Cette commande nécessite Node.js et un accès réseau (téléchargement ponctuel de l'outil
Tailwind), mais reste sans effet sur le déploiement : le fichier généré est commité, et
Netlify continue de servir le site tel quel, sans étape de build.

> Attention : une classe utilisée dans le balisage mais absente du CSS régénéré n'échoue pas,
> elle ne fait simplement rien. Un rendu inchangé après une modification de style est presque
> toujours un CSS non régénéré.

### Tests

Le cœur de calcul (`js/calcul.js`) est couvert par des tests de non-régression, exécutés par
le runner natif de Node (aucune dépendance) :

```bash
npm test
# équivalent à : node --test "tests/**/*.test.mjs"
```

### Ajouter une marque

Klimo est multi-marque par construction (`js/calcul.js` ne contient aucun branchement par
marque, seulement des tables indexées par sa clé). Le schéma exact des données à fournir,
un script de validation (`scripts/valider-marque.mjs`), et le runbook pour donner une
marque à un client précis (côté Supabase, sans redéploiement) sont dans
[`docs/ajouter-une-marque.md`](docs/ajouter-une-marque.md).

## Déploiement (Netlify)

Le dépôt est prêt pour un déploiement continu :

1. Sur Netlify → **Add new site** → **Import an existing project** → GitHub.
2. Sélectionnez ce dépôt (`drivenbyia/toshibapp`).
3. Aucune commande de build. Répertoire de publication : `.` (déjà défini dans `netlify.toml`).
4. **Deploy site**.

Chaque `git push` sur la branche par défaut redéploie automatiquement le site.

### Vitrine et pages légales (`site/`)

`site/` est un second site statique indépendant — la vitrine (page d'accueil, tarif, CGV,
mentions légales, confidentialité), séparée de l'application pour une raison précise : elle
doit vivre sur `klimo.fr`, tandis que l'application doit rester à la **racine** de
`app.klimo.fr` pour ne jamais changer la portée (`scope`) de son service worker ni casser une
installation déjà faite sur l'appareil d'un client. Un découpage par sous-dossier
(`klimo.fr/app`) aurait cet effet de bord ; le sous-domaine l'évite.

Pour la mise en ligne, créer un **second site Netlify** à partir du même dépôt :

1. Sur Netlify → **Add new site** → **Import an existing project**, même dépôt GitHub.
2. **Base directory** : `site` (Netlify y trouve alors `site/netlify.toml`).
3. Aucune commande de build, répertoire de publication `.` (relatif à `site/`).
4. Une fois le nom de domaine réservé, brancher `klimo.fr` sur ce site et
   `app.klimo.fr` sur le premier (celui qui sert déjà `index.html` à la racine).

Avant de rendre `site/` public : les pages `mentions-legales.html`, `cgv.html` et
`confidentialite.html` contiennent des rubriques `[à compléter]` (SIRET, adresse) et un
encart signalant ce qui manque — les CGV en particulier ne doivent pas être publiées sans
relecture par un professionnel du droit (voir le plan de mise sur le marché).

## Technologies

- HTML / JavaScript vanilla (modules ES natifs, aucun bundler)
- [Tailwind CSS](https://tailwindcss.com/) (CSS pré-compilé, versionné dans `assets/`)
- API Web (Service Worker, Web App Manifest, localStorage)
- [Node.js test runner](https://nodejs.org/api/test.html) (`node --test`) pour les tests
