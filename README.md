# ProSizer B2B

Outil de dimensionnement B2B pour la sélection de climatisations Toshiba et Panasonic
(froid/chaud), sous forme de **PWA** (Progressive Web App) installable sur mobile et desktop.

L'application est entièrement contenue dans un seul fichier `index.html` :
pas d'étape de build, pas de dépendances à installer.

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
- **PWA hors-ligne** : manifest et service worker générés dynamiquement,
  application installable et utilisable sans connexion.

## Développement local

Aucun outil requis. Ouvrez simplement `index.html` dans un navigateur, ou servez
le dossier :

```bash
python3 -m http.server 8000
# puis ouvrez http://localhost:8000
```

> Note : le service worker (mode hors-ligne) nécessite un contexte sécurisé
> (`https://` ou `http://localhost`).

## Déploiement (Netlify)

Le dépôt est prêt pour un déploiement continu :

1. Sur Netlify → **Add new site** → **Import an existing project** → GitHub.
2. Sélectionnez ce dépôt (`drivenbyia/toshibapp`).
3. Aucune commande de build. Répertoire de publication : `.` (déjà défini dans `netlify.toml`).
4. **Deploy site**.

Chaque `git push` sur la branche par défaut redéploie automatiquement le site.

## Technologies

- HTML / JavaScript vanilla
- [Tailwind CSS](https://tailwindcss.com/) (via CDN)
- API Web (Service Worker, Web App Manifest, localStorage)
