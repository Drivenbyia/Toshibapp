# ProSizer B2B

Outil de dimensionnement B2B pour la sélection de climatisations Toshiba et Panasonic
(froid/chaud), sous forme de **PWA** (Progressive Web App) installable sur mobile et desktop.

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
  - Toshiba : Naka, Yukai, Shorai Edge, Haori, Daiseikai 10, Console Double-Flux (mono) ;
    groupes RAS-xMxxG3AVG-E (multi).
  - Panasonic : TZ Ultra Compact, Etherea (mono) ; groupes Multi TZ CU-2TZ/CU-3TZ (multi,
    compatibles avec les unités intérieures TZ Ultra Compact).
- **Architecture hybride** : en multisplit, délestage automatique des grandes pièces
  vers des monosplits dédiés.
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

### Régénérer le CSS Tailwind

`assets/tailwind.css` est un CSS Tailwind pré-compilé (pas le CDN `cdn.tailwindcss.com`,
qui casse le mode hors-ligne et n'est pas destiné à la production). Il n'a besoin d'être
régénéré que si vous ajoutez de nouvelles classes Tailwind dans `index.html` :

```bash
npx tailwindcss@3 -i build/input.css -o assets/tailwind.css \
  --config build/tailwind.config.js --minify
```

Cette commande nécessite Node.js et un accès réseau (téléchargement ponctuel de l'outil
Tailwind), mais reste sans effet sur le déploiement : le fichier généré est commité, et
Netlify continue de servir le site tel quel, sans étape de build.

### Tests

Le cœur de calcul (`js/calcul.js`) est couvert par des tests de non-régression, exécutés par
le runner natif de Node (aucune dépendance) :

```bash
npm test
# équivalent à : node --test "tests/**/*.test.mjs"
```

## Déploiement (Netlify)

Le dépôt est prêt pour un déploiement continu :

1. Sur Netlify → **Add new site** → **Import an existing project** → GitHub.
2. Sélectionnez ce dépôt (`drivenbyia/toshibapp`).
3. Aucune commande de build. Répertoire de publication : `.` (déjà défini dans `netlify.toml`).
4. **Deploy site**.

Chaque `git push` sur la branche par défaut redéploie automatiquement le site.

## Technologies

- HTML / JavaScript vanilla (modules ES natifs, aucun bundler)
- [Tailwind CSS](https://tailwindcss.com/) (CSS pré-compilé, versionné dans `assets/`)
- API Web (Service Worker, Web App Manifest, localStorage)
- [Node.js test runner](https://nodejs.org/api/test.html) (`node --test`) pour les tests
