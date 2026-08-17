# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Installateurs frigoristes / poseurs de climatisation, en France.**

L'auteur du produit en est lui-même un : il pose de la climatisation, utilise Klimo sur ses
propres chantiers, et le vend à d'autres installateurs. Le premier utilisateur et l'éditeur
sont la même personne — les retours terrain viennent d'un usage réel, pas d'entretiens.

Situation d'usage : en rendez-vous chez le client, souvent debout et à une main, dans des
combles, des caves, des vides sanitaires ou sur une terrasse en plein soleil. Ou le soir, au
bureau, à ressaisir des relevés pris dans la journée.

Trois classes d'appareil sont de **premier rang, à égalité** :

- téléphone, sur le chantier ;
- tablette, très souvent tenue en paysage — le format le plus courant chez les artisans ;
- ordinateur, le soir, avec les notes du jour.

Le travail à faire : relever les paramètres du bâtiment, obtenir un besoin froid et chaud
fiable, et savoir quelle machine du catalogue de sa marque poser — pour monter ensuite son
devis.

## Product Purpose

Remplacer le dimensionnement au ratio au m² (ou la feuille de calcul maison) par un bilan
thermique qui tient compte du bâti, et enchaîner directement sur la sélection dans le
catalogue constructeur.

Le succès se mesure à la fin du rendez-vous : l'installateur repart avec la référence
commandable et la puissance justifiée, sans avoir eu à repasser au bureau pour trancher.

## Positioning

Ce qu'un outil voisin ne pourrait pas copier tel quel :

- **Multi-marque par construction.** Le moteur de calcul (`js/calcul.js`) ne contient aucun
  branchement par marque, seulement des lectures de tables indexées par sa clé. Ajouter une
  marque est une opération de données, et donner une marque à un client précis est une ligne
  en base, sans redéploiement. Le catalogue visible est configuré par compte.
- **Des corrections que les outils constructeurs n'appliquent pas** : marge canicule
  interpolée sur la température de base été, déclassement chaud à la température de base
  hiver, escalade automatique vers le groupe multisplit supérieur quand une pièce absorberait
  plus de 60 % de la puissance du groupe, et architecture hybride (délestage des grandes
  pièces vers des monosplits dédiés).
- **Une TVA qui ne ment jamais.** L'éligibilité 5,5 % est transcrite du tableau constructeur
  avec ses deux régimes distincts — en monosplit gamme par gamme et taille par taille, en
  multisplit portée par le groupe extérieur. Une référence absente du tableau est affichée
  « à vérifier », jamais tranchée arbitrairement.
- **Hors-ligne réel**, pas un mode dégradé : calcul, enregistrement et export fonctionnent
  sans réseau après un premier chargement.

## Operating Context

- **Le rendez-vous client est la scène principale.** L'écran des résultats est parfois montré
  au client pendant le rendez-vous et doit inspirer confiance.
- **Deux documents distincts sont exportés, pour deux destinataires.** La *fiche de travail*
  est le document de l'installateur, qui s'en sert pour monter son devis : détail poste par
  poste, références commandables, taux de TVA, réserves de méthode. Le *rapport client* est
  remis au client et justifie la puissance et le matériel retenus — mêmes données, projection
  différente. La promesse du site vitrine (« le client repart avec un document, pas une
  estimation à l'oral ») est donc désormais exacte.
- Aucun réseau garanti sur la scène d'usage : cave, vide sanitaire, chantier neuf.
- Deux sites distincts : `klimo.fr` pour la vitrine, `app.klimo.fr` pour l'application, servie
  **à la racine** — un découpage en sous-dossier changerait la portée du service worker et
  casserait les installations déjà faites sur l'appareil d'un client.
- Les comptes sont créés à la main, sur demande, après démonstration. Pas d'inscription en
  libre-service.

## Capabilities and Constraints

**Fonctionnel confirmé** — bilan thermique pièce par pièce (surface, hauteur, isolation via
le coefficient G, département, altitude, consigne d'été, orientation, vitrage, protection
solaire, occupants, exposition des murs) ; sélection monosplit et multisplit ; jusqu'à
5 pièces en multisplit ; choix de gamme par pièce ; enregistrement des chantiers par client
et par zone ; export PDF et partage ; synchronisation optionnelle entre appareils.

**Contraintes techniques durables :**

- PWA 100 % statique : **aucune étape de build au déploiement**, aucun bundler, modules ES
  natifs du navigateur. Netlify sert le dépôt tel quel.
- `assets/tailwind.css` est précompilé et **commité** ; il doit être régénéré après toute
  modification de `build/input.css` ou `build/tailwind.config.js`. Une classe absente du CSS
  régénéré n'échoue pas — elle ne fait rien.
- **Aucun CDN.** Toute ressource doit être servie same-origin et précachée par `sw.js`, sinon
  le hors-ligne casse. Cela vaut pour les polices comme pour les scripts.
- Le calcul est isolé dans `js/calcul.js`, sans accès au DOM, et couvert par des tests de
  non-régression exécutés par le runner natif de Node (aucune dépendance).
- Stockage local (`localStorage`) avec synchronisation Supabase optionnelle : dernier-écrit-
  gagne, mais la version perdante est conservée et arbitrée par l'utilisateur — rien n'est
  jamais jeté silencieusement.
- **Hypothèse silencieuse de tout le moteur** : les puissances catalogue sont données au point
  d'essai normalisé EN 14511 (35 °C extérieur en froid, +7 °C extérieur en chaud). Une fiche
  constructeur citant un autre point casserait la sélection sans qu'aucun garde-fou ne le
  détecte.

**Terminologie métier** à respecter dans l'interface : monosplit, multisplit, groupe
extérieur, unité intérieure (UI), gamme, coefficient G, température de base, taux de charge,
foisonnement, délestage, chantier, zone.

**Explicitement non décidé :** le tarif définitif (49 €/mois est annoncé comme « tarif de
lancement »), le SIRET et l'adresse des mentions légales, et la relecture juridique des CGV.

## Brand Commitments

- **Nom : Klimo.** Vitrine `klimo.fr`, application `app.klimo.fr`.
- **L'accent visuel est celui de Klimo, fixe, jamais celui de la marque de matériel
  sélectionnée.** L'application doit se présenter comme l'outil de l'installateur, pas comme
  le configurateur d'un constructeur. C'est une contrainte d'identité, pas une préférence
  esthétique.
- Registre visuel retenu en août 2026 : **« affirmé »** — typographie condensée (Archivo
  variable, auto-hébergée) sur les titres, les valeurs et les actions ; sections annoncées
  par un aplat ; arêtes franches ; couleur pleine réservée aux deux grandeurs mesurées.
- Interface en français, vouvoiement, vocabulaire de métier plutôt que vocabulaire logiciel.
- Une demande de design porte sur la couche visuelle et **ne remet pas en cause la structure
  du produit** : l'application est déjà utilisée telle quelle.

## Evidence on Hand

**Réel, utilisable :**

- Catalogues Toshiba et Panasonic dans `js/data.js`, puissances au point EN 14511.
- Tableau d'éligibilité TVA Toshiba « TVA 5,5 éligibilité Toshiba v3 », avec sa date de
  vérification portée par `TVA_DATE_VERIFICATION`.
- Référentiel climatique par département, altitude et zone (`tBaseMatrix`, `tBaseEteMatrix`).
- `AUDIT.md`, `docs/ajouter-une-marque.md`, `scripts/valider-marque.mjs`.
- Site vitrine rédigé (`site/index.html`) : proposition, tarif, FAQ.

**Absences que les futurs travaux ne doivent pas combler par de l'invention :**

- **Klimo est en pré-lancement : aucun compte client payant à ce jour.** Aucun témoignage,
  aucun logo client, aucun chiffre d'usage, aucune référence, aucun cas d'étude ne doit être
  écrit ni suggéré. Le site vitrine n'en contient aujourd'hui aucun — c'est à préserver.
- Les pages légales (`site/mentions-legales.html`, `site/cgv.html`,
  `site/confidentialite.html`) contiennent des rubriques `[à compléter]` et n'ont pas été
  relues par un professionnel du droit.

## Product Principles

1. **Le terrain prime sur le bureau.** Une main, des gants, du plein soleil et pas de réseau
   sont les conditions normales, pas des cas limites.
2. **Ne jamais promettre ce que le tableau constructeur ne dit pas.** « À vérifier » est une
   réponse acceptable ; une réponse inventée qui a l'apparence du juste ne l'est pas.
3. **Aucun état ne se signale par l'effacement.** Une option non retenue ou un résultat périmé
   reste lisible en plein contraste ; c'est la bordure, la coche ou la saturation qui portent
   l'information.
4. **L'outil est celui de l'installateur, pas du constructeur.**
5. **Le hors-ligne est le mode normal**, pas un mode dégradé.

## Accessibility & Inclusion

Contraintes d'usage établies, plutôt qu'une conformité réglementaire (aucune exigence
normative n'a été fixée à ce stade) :

- Cibles tactiles de **44 px minimum**, et champs de saisie à **16 px** — en dessous, iOS
  zoome à chaque prise de focus et l'utilisateur perd sa place dans le formulaire.
- Contraste utilisable **en plein soleil** ; le niveau AA est un plancher, pas un objectif.
- Utilisation **à une main** et **avec des gants**.
- `prefers-reduced-motion` respecté.
