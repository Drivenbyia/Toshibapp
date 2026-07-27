# Audit ProSizer B2B — état des lieux et plan d'amélioration

> Périmètre : `index.html` (1267 lignes, mono-fichier), `netlify.toml`, `README.md`.
> Version auditée : commit `2ee577b` (branche `main`), libellé applicatif « V18 - FROID PHYSIQUE ».
> Date : juillet 2026.

---

## 1. Synthèse

L'application est **fonctionnellement dense et métier-crédible** : le modèle de froid poste par
poste (enveloppe / toiture / solaire / internes / occupants) est nettement au-dessus de ce que
font la plupart des outils de dimensionnement terrain, qui se contentent d'un ratio W/m². La
base TVA 5,5 %, le délestage hybride multi→mono et le guide des gammes sont de vrais
différenciateurs commerciaux.

Les faiblesses ne sont pas dans l'ambition du modèle mais dans **trois angles morts** :

| Axe | Verdict | Enjeu |
|---|---|---|
| **Calculs** | Le froid est soigné, **le chaud est resté sur un modèle de 2 lignes** et n'est jamais déclassé à la température de base. Plusieurs incohérences internes vérifiées. | Risque de sous-dimensionnement chauffage → litige client |
| **PWA** | Le mode hors-ligne annoncé au README **ne fonctionne pas** (service worker enregistré depuis une `blob:` URL, rejeté par tous les navigateurs). L'app n'est vraisemblablement pas installable non plus. | La promesse produit principale n'est pas tenue |
| **UX terrain** | Aucun export/partage, aucune reprise d'un chantier sauvegardé, aucune persistance de la saisie en cours. | L'outil s'arrête au moment où le commercial en aurait le plus besoin |

Le reste (design, accessibilité, architecture) est perfectible mais non bloquant.

**Ce qu'il ne faut PAS changer** : le mono-fichier sans build. Pour un outil interne diffusé par
URL et installé sur des téléphones de terrain, c'est un excellent choix — zéro chaîne de build à
maintenir, déploiement Netlify instantané, débogage trivial. Les recommandations ci-dessous le
préservent (voir §6).

---

## 2. Bloquants (P0)

### 2.1 Le service worker ne s'enregistre jamais — le hors-ligne est fictif

```js
// index.html:1254-1257
const swBlob = new Blob([swCode], {type: 'application/javascript'});
navigator.serviceWorker.register(URL.createObjectURL(swBlob)).catch(err => console.warn('PWA SW: ', err));
```

Les navigateurs **refusent** l'enregistrement d'un service worker depuis une URL `blob:`
(« The URL protocol of the script is not supported »). L'erreur est avalée par un `console.warn`,
donc l'échec est silencieux. Conséquence : le README promet « application installable et
utilisable sans connexion » — ce n'est vrai ni pour l'un ni pour l'autre.

S'y ajoute que **Tailwind est chargé depuis `cdn.tailwindcss.com`** : même avec un service worker
correct, sans connexion l'application s'afficherait sans aucun style (HTML brut). Le CDN Tailwind
compile les classes en JavaScript au runtime — c'est aussi ~400 ko de JS et un avertissement
explicite « not for production » de la part de Tailwind.

**Correctif** : un vrai fichier `sw.js` à la racine + Tailwind figé en CSS local. Détail en §6.1.

### 2.2 Installabilité PWA probablement KO

- Icônes déclarées en `data:image/svg+xml` uniquement. Chrome exige des **icônes PNG 192×192 et
  512×512** pour proposer l'installation.
- Le manifest est lui aussi injecté via `URL.createObjectURL` (`index.html:1246`) — fragile, et
  `start_url` calculée depuis `window.location.href` variera selon la page d'entrée.
- Aucun `<meta name="theme-color">` dans le `<head>`.

### 2.3 Bug fonctionnel : les noms de client avec apostrophe cassent le dashboard

```js
// index.html:311
<button onclick="deleteChantier('${client}')">SUPPRIMER TOUT</button>
```

Un client nommé `L'Hôpital Nord`, `D'Anna`, `Sainte-Marie l'Église` produit
`onclick="deleteChantier('L'Hôpital Nord')"` → attribut HTML tronqué, **bouton inopérant**. Les
patronymes et raisons sociales françaises avec apostrophe sont courants ; le bug est certain, pas
théorique.

Même racine, plus grave : `client`, `cfg.zone`, `cfg.resultStr` et les `equipments` sont injectés
en `innerHTML` **sans échappement** (`index.html:283-316`). Un nom de client contenant du HTML est
exécuté. L'impact est limité (données locales, saisies par l'utilisateur lui-même) mais c'est une
faille à corriger par principe — et le correctif (une fonction `escapeHtml` + `dataset` au lieu
d'`onclick` inline) règle les deux problèmes d'un coup.

### 2.4 `localStorage` sans filet

Aucun `try/catch` autour des lectures/écritures (`index.html:256, 323, 341, 356, 368`). En Safari
navigation privée ou en cas de quota dépassé, l'accès lève une exception → **l'écran « Mes
Chantiers » plante en blanc** sans message. Pas de versionnement de schéma non plus : une future
évolution du format de sauvegarde cassera les chantiers existants.

---

## 3. Calculs — analyse détaillée

C'est le cœur de valeur de l'outil, et c'est là que se trouvent les gains les plus importants.

### 3.1 🔴 Le chaud n'est jamais déclassé à la température de base

C'est **le point le plus important de l'audit**, et c'est une asymétrie flagrante avec le soin
apporté au froid.

Le besoin de chauffage est calculé à la température de base hiver (Lyon : −9 °C) :

```js
// index.html:429-432
const deltaTChaud = 20 - tBaseHiver;              // 29 K à Lyon
const besoinChaud = (volume * coefG * deltaTChaud) / 1000 * 1.20;
```

Puis comparé directement au champ catalogue `puissance_chaud_kw` :

```js
// index.html:600
.filter(p => p.puissance_froid_kw >= reqF && p.puissance_chaud_kw >= reqC)
```

Or `puissance_chaud_kw` est la **puissance nominale au point normalisé +7 °C extérieur / 20 °C
intérieur**. On compare donc un besoin exprimé à −9 °C à une capacité publiée à +7 °C. Une PAC
air/air perd de la capacité quand la température extérieure chute, et subit en plus des cycles de
dégivrage entre −5 °C et +5 °C.

L'ironie est que **le problème a été identifié et traité côté froid** — c'est exactement l'objet du
facteur canicule (`ABATTEMENT_CANICULE = 1.11`, `index.html:399`), qui majore le besoin froid parce
que « la puissance catalogue est donnée à 35 °C ext. ; en canicule (40-42 °C) elle chute ~10 % ».
Le raisonnement symétrique n'a jamais été appliqué au chauffage, alors que l'écart y est bien plus
grand (29 K de ΔT contre 7 K en été).

Nuance importante à ne pas ignorer dans le correctif : sur les groupes inverter récents, la
puissance nominale à +7 °C n'est **pas** la puissance maximale. Les constructeurs publient
séparément une « puissance maxi à −7 °C » qui reste souvent proche de la nominale. L'ampleur réelle
du déficit doit donc être établie **à partir des tables de capacité Toshiba/Panasonic**, pas d'une
règle générique. Mais le principe manque entièrement aujourd'hui, et dans le cas d'une zone
montagne (Tbase −19 °C) l'écart ne peut pas être négligeable.

**Recommandation** : ajouter au catalogue un champ `puissance_chaud_max_kw_a_-7` (ou une courbe
`{temp: kW}`) alimenté par les tables constructeur, et sélectionner sur la capacité interpolée à la
température de base du chantier — exactement la logique déjà en place pour la canicule. En
attendant les données, un coefficient de déclassement paramétrable par palier de Tbase, affiché
explicitement dans l'UI, vaut mieux que le silence actuel.

### 3.2 🔴 Les libellés de consigne intérieure annoncent des chiffres faux

```html
<!-- index.html:151-154 -->
<option value="25">25°C – Confort maximal (+12% froid)</option>
<option value="27">27°C – Optimisé (-12% froid)</option>
<option value="28">28°C – Sobre / Budget (-24% froid)</option>
```

La consigne n'intervient que dans **un seul poste sur cinq** — l'enveloppe
(`deltaTEte = tBaseEte - consigne`, `index.html:440`). Les apports toiture, solaires, internes et
occupants n'en dépendent pas. Mesuré sur un cas type (salon 30 m², h 2,5 m, G = 0,8, Lyon) :

| Consigne | Besoin froid | Écart réel | Écart annoncé |
|---|---|---|---|
| 25 °C | 1,87 kW | **+3,3 %** | +12 % |
| 26 °C | 1,81 kW | référence | référence |
| 27 °C | 1,75 kW | **−3,3 %** | −12 % |
| 28 °C | 1,69 kW | **−6,6 %** | −24 % |

L'écart est d'un facteur ~3,5. Ces pourcentages correspondent à l'ancien modèle purement volumique
(avant la V18) et **n'ont pas été mis à jour lors de la refonte physique**. Un commercial qui
argumente « montez à 28 et vous économisez un quart de la puissance » dit une contre-vérité.

**Correctif immédiat, coût quasi nul** : supprimer les pourcentages en dur des libellés et afficher
l'écart **calculé en direct** dans le bandeau climat (« consigne 28 °C → −6,6 % vs 26 °C »), qui est
de toute façon déjà recalculé à chaque changement (`updateClimateInfo`).

### 3.3 🟠 La marge canicule n'est pas appliquée aux monosplits délestés d'un multisplit

En mode mono, la sélection se fait bien sur le besoin majoré :

```js
// index.html:628-636
const froidMatch = req.froid * facteurCanicule;
mono: { options: findBestMonos(froidMatch, req.chaud) }
```

En mode multi, les pièces délestées vers un monosplit dédié sont sélectionnées sur le besoin **brut** :

```js
// index.html:683 et 692
options: findBestMonos(room.req.froid, room.req.chaud)   // ← facteurCanicule absent
```

Résultat vérifié : pour une pièce à 2,35 kW en zone chaude, le mode mono propose une machine
3,3 kW, le monosplit dédié d'une configuration multi propose 2,5 kW — **pour la même pièce, dans le
même département**. Le bandeau orange « marge canicule appliquée » s'affiche pourtant dans les deux
cas.

Même omission dans le guide de sélection des UI (`index.html:906`), où les gammes proposées par
pièce sont calculées sans canicule alors que la taille affichée à côté (`r.size`) l'inclut : les
deux informations peuvent se contredire à l'écran.

### 3.4 🟠 Double comptage résiduel de la toiture

Le commentaire du code est lucide sur le sujet (`index.html:435-437`) : le coefficient G capte la
transmission de **toutes** les parois, toiture comprise. La surcharge `qToiture` s'ajoute par-dessus
sans retrancher la part toiture déjà contenue dans `qEnveloppe`. Sur le cas type, la toiture pèse
23 % du besoin froid — la part double-comptée reste modeste en valeur absolue (ΔT été faible), mais
le poste mérite d'être formulé proprement : soit un G « parois hors toiture », soit une surcharge
exprimée en supplément de ΔT équivalent (ΔTe) plutôt qu'en W/m² additionnels.

Un précédent existe : le commit `6d7b32a` a déjà corrigé un double comptage de la ventilation. Le
même travail reste à faire sur la toiture.

### 3.5 🟠 Le coefficient G est un coefficient de bâtiment, appliqué pièce par pièce

`G · V · ΔT` est une méthode de **bilan bâtiment global**. L'appliquer à chaque pièce revient à
traiter chaque pièce comme un pavillon isolé déperditif sur ses six faces. Une chambre au centre du
logement, entourée de pièces chauffées, n'a en réalité qu'une façade déperditive.

En multisplit, l'erreur se cumule : on somme 4 ou 5 pièces toutes surestimées, ce qui pousse
mécaniquement vers un groupe extérieur plus gros. C'est structurel au modèle, pas un bug — mais
c'est la limite principale de la méthode et elle mérite au minimum d'être documentée, au mieux
corrigée par un coefficient d'exposition par pièce (nombre de façades sur l'extérieur), champ que
l'utilisateur saisit déjà implicitement via « Emplacement de la pièce ».

### 3.6 🟠 Foisonnement de 1,25 en froid : agressif et invisible

```js
// index.html:651, 660-662
const COEF_FOISONNEMENT = 1.25;
(g.puissance_nominale_froid_kw * COEF_FOISONNEMENT) >= totF
```

Le groupe extérieur est accepté s'il couvre les besoins **divisés par 1,25**, soit 20 % de moins que
la somme des pièces. Sur 4 pièces totalisant 7,9 kW, l'app accepte un groupe de 6,3 kW nominal.

Le foisonnement se justifie en chauffage (les pièces ne montent pas en température en même temps).
**En froid, c'est beaucoup plus discutable** : la pointe de refroidissement est simultanée sur toutes
les pièces — c'est le même après-midi de canicule qui les charge toutes. Et le facteur canicule
(+11 %) est appliqué *avant*, donc les deux se compensent en partie et s'annulent presque : la marge
de sécurité affichée à l'utilisateur est en réalité neutralisée par le foisonnement.

**Recommandation** : dissocier foisonnement froid et chaud (typiquement 1,0–1,1 en froid, 1,2–1,3 en
chaud), et l'exposer comme un réglage visible plutôt qu'une constante enfouie.

### 3.7 🟡 Aucun garde-fou de surdimensionnement

`findBestMonos` retient la plus petite machine qui couvre le besoin, plus les équivalents à +15 %.
Mais le **taux de charge** — besoin / puissance nominale, la donnée métier décisive — n'est jamais
calculé ni affiché. Cas réels produits par le catalogue actuel :

| Besoin | Machine retenue | Taux de charge |
|---|---|---|
| 2,1 kW | 5,0 kW | **42 %** |
| 1,6 kW | 3,3 kW | **48 %** |

En dessous de ~50 % de charge, un inverter résidentiel cycle court : SEER réel dégradé, confort
médiocre, usure du compresseur. Afficher le taux de charge et alerter sous un seuil serait un
argument technique fort côté commercial — et éviterait de vendre trop gros « par sécurité ».

### 3.8 🟡 Aucune contrainte de compatibilité multisplit

La sélection du groupe extérieur ne vérifie que deux choses : nombre de sorties et puissance totale
(`index.html:659-663`). Manquent :

- le **ratio de connexion** (somme des puissances UI / puissance UE), typiquement borné à 50–130 %
  chez les constructeurs ;
- la **puissance mini/maxi admissible par sortie** (une UI taille 16 sur un `RAS-2M10G3AVG-E` est
  hors spécification) ;
- le fait qu'un seul groupe est proposé, sans alternative — alors que le mode mono, lui, propose
  systématiquement des équivalents.

### 3.9 🟡 Robustesse numérique

- `getRequiredKw` **lit le DOM à chaque appel** (`index.html:418-424`) au lieu de recevoir ses
  paramètres. Si « Saisie personnalisée » est sélectionnée et le champ vidé, `parseFloat('')`
  renvoie `NaN` qui se propage dans tout le calcul et s'affiche `NaN kW` sans le moindre message
  d'erreur.
- `updateRoom` (`index.html:591`) : `parseFloat(value) || ''` transforme **0 en chaîne vide**. Il est
  donc impossible de déclarer une pièce à 0 occupant : la valeur retombe sur l'estimation
  automatique (1 pers. / 15 m²). Pour une chambre d'amis ou un bureau inoccupé, c'est faux.
- Aucune borne de saisie : surface 5000 m², hauteur 0,3 m sont acceptées sans broncher.
- `ABATTEMENT_CANICULE` est nommé « abattement » alors qu'il s'agit d'une majoration ; le
  commentaire dit « ~10 % », la valeur vaut 1,11 et l'UI affiche « +11 % ».

### 3.10 🟡 Traçabilité et TVA

- Aucune source citée dans l'UI pour `tBaseEteMatrix` / `tBaseMatrix` ni pour les coefficients de
  rayonnement. Sur un outil qui produit des recommandations engageantes, une ligne « méthode et
  sources » consultable serait précieuse en cas de contestation.
- La base TVA 5,5 % n'existe **que pour Toshiba** (`TVA_RULES`, `index.html:1153`) — c'est assumé et
  documenté dans le code. Mais à l'écran, Toshiba affiche des pastilles vertes « TVA 5,5 % » et
  Panasonic n'affiche rien du tout. Un commercial pressé lira « Panasonic = pas éligible ». Il faut
  une mention explicite « éligibilité non renseignée pour cette marque ».
- `extractTailleCode` (`index.html:1179`) filtre sur `/RAS-(\d{2})/`, spécifique Toshiba. Si des
  règles Panasonic sont ajoutées un jour, la fonction renverra `null` et les exclusions de taille
  seront **silencieusement ignorées**.
- Aucune date de validité affichée pour un dispositif fiscal qui, par nature, change.

---

## 4. UX

### 4.1 Les manques structurants

| Manque | Pourquoi ça compte |
|---|---|
| **Aucun export / partage** | C'est le chaînon manquant n°1. Un outil de dimensionnement B2B dont le résultat ne peut être ni imprimé, ni envoyé au client, ni annexé à un devis s'arrête juste avant l'usage qui le justifie. PDF, ou à défaut Web Share API / `mailto:` prérempli. |
| **Chantiers en lecture seule** | On peut consulter et supprimer, jamais **recharger** une configuration pour la modifier. Le client demande une variante → tout ressaisir. |
| **Paramètres bâtiment non sauvegardés** | Isolation, département, altitude et consigne ne sont pas stockés avec le chantier. Le calcul enregistré est donc **non reproductible** : impossible de savoir avec quelles hypothèses il a été produit. |
| **Aucune persistance de la saisie en cours** | Sur mobile, l'onglet est tué en arrière-plan sans prévenir. Un appel téléphonique au milieu d'une saisie 5 pièces = tout est perdu. Un simple autosave dans `localStorage` suffit. |
| **Pas de nom de pièce** | Le récap client dit « Pièce 1 / Pièce 2 / Pièce 3 ». Trois semaines plus tard, personne ne sait de quelle pièce il s'agit. Un champ libre (Salon, Chambre parents…) change tout. |
| **Pas de duplication de pièce** | Les chambres d'un même étage partagent presque tous leurs paramètres. Un bouton « dupliquer » économise 6 champs × N pièces. |

### 4.2 Frictions de parcours

- `setMode` fait `state.rooms = [state.rooms[0]]` (`index.html:503`) : basculer multi → mono
  **supprime les pièces 2 à 5 sans avertissement**, et le retour en multi ne les restaure pas.
- Le message d'erreur de saisie incomplète s'affiche dans `results-container`, **tout en bas de la
  page** (`index.html:613`) — hors écran au moment où l'utilisateur clique. Il faudrait le placer
  près du bouton et marquer les champs fautifs.
- `resultsContainer.scrollIntoView()` (`index.html:708`) ne compense pas le header sticky de 64 px :
  le titre « Solutions recommandées » passe dessous. `scroll-margin-top` règle ça.
- `confirm()` natif bloquant pour la suppression, sans annulation possible.
- Le badge de version « V18 - FROID PHYSIQUE » est en `hidden sm:block` (`index.html:76`) : invisible
  précisément sur mobile, là où l'app est utilisée. Or savoir quelle version de méthode a produit un
  chiffre est important sur ce type d'outil.
- Changer de marque vide les résultats mais ne réinitialise pas `state.selection` (`setBrand`,
  `index.html:214-223`) — des sélections de gammes de l'ancienne marque peuvent survivre.

### 4.3 Accessibilité

- `maximum-scale=1.0, user-scalable=no` (`index.html:5`) **bloque le zoom**. Violation WCAG 1.4.4, et
  contresens pour un outil utilisé en extérieur, souvent par des utilisateurs qui zooment.
- Les cartes de solution non sélectionnées sont en `opacity-60 saturate-50` (`index.html:971`) →
  contraste sous les seuils AA.
- `role="button" tabindex="0"` sur les cartes (`index.html:968`) mais **aucun gestionnaire clavier** :
  annoncées comme boutons aux lecteurs d'écran, elles ne réagissent ni à Entrée ni à Espace.
- Aucun `aria-live` sur le conteneur de résultats : le calcul se termine sans annonce.
- Abondance de `text-[8px]`, `text-[9px]`, `text-[10px]` : illisible en plein soleil sur un chantier.

---

## 5. Design

Le design est propre et cohérent, dans un registre Tailwind très standard. Les axes d'amélioration
sont réels mais moins prioritaires que le reste.

- **Hiérarchie visuelle plate** : saisie et résultats utilisent exactement le même motif (carte
  blanche, ombre `shadow-sm`, bordure grise, titre à pastille colorée). Rien ne distingue
  visuellement « ce que je remplis » de « ce que l'outil me répond ». Les résultats — la valeur
  produite — devraient trancher nettement.
- **Densité typographique excessive** : jusqu'à 8 px. Un plancher à 11–12 px, avec une échelle
  typographique explicite (4 niveaux maximum) serait plus lisible et plus tenable.
- **Rouge `#FF0000` pur** : très saturé, fatigant sur de larges aplats, et proche de la limite de
  contraste sur blanc pour du texte. Un rouge légèrement désaturé et assombri (autour de `#E01A1A`)
  garderait l'identité Toshiba en gagnant en confort et en conformité.
- **Pas de mode sombre**, alors qu'une PWA installée sur mobile en hérite naturellement via
  `prefers-color-scheme`.
- **Pas de gestion du notch iOS** : `apple-mobile-web-app-status-bar-style: black-translucent` est
  déclaré (`index.html:10`) sans `viewport-fit=cover` ni `env(safe-area-inset-*)` — le header sticky
  passe sous la barre d'état en mode installé sur iPhone.
- **Pas d'états de chargement ni de transitions entre vues** : le passage simulateur ↔ dashboard est
  un `display:none` sec.
- Les pastilles TVA vert/rouge reposent sur la couleur seule pour transmettre l'information
  (problème pour les daltoniens) — une icône ou un libellé explicite lèverait l'ambiguïté.

---

## 6. Code et architecture

**Le mono-fichier n'est pas le problème** et ne doit pas être sacrifié. Le problème est
l'entrelacement de trois choses distinctes dans un même flux : les données catalogue, la logique de
calcul, et le rendu HTML par concaténation de chaînes.

### 6.1 Réparer la PWA sans introduire de build

```
index.html      ← inchangé dans son principe
sw.js           ← vrai service worker, servi en same-origin
manifest.json   ← manifest statique
tailwind.css    ← CSS Tailwind figé (généré une fois, commité)
icons/          ← PNG 192 et 512
```

Points clés du `sw.js` : mise en cache explicite de `index.html`, `tailwind.css`, `manifest.json` et
des icônes ; `skipWaiting` + `clients.claim` ; stratégie **network-first sur le document** (sinon les
utilisateurs restent bloqués sur une version périmée, le `must-revalidate` de `netlify.toml` étant
court-circuité par un cache-first) ; cache versionné avec purge des anciens à l'activation.

Figer Tailwind supprime aussi 400 ko de JS au chargement et l'avertissement production du CDN.
L'esprit « aucun outil requis » est préservé : la génération du CSS est une opération ponctuelle,
pas une étape de build à chaque déploiement.

### 6.2 Découper sans framework

Trois modules ES, chargés par `<script type="module">`, sans bundler ni npm :

| Fichier | Contenu | Bénéfice |
|---|---|---|
| `data/catalogues.js` | `CATALOGS`, `GAMMES_INFO`, `TVA_RULES`, `DEPARTMENTS`, matrices de températures | Mettre à jour un catalogue ne demande plus de toucher au HTML — et devient relisible par un non-développeur |
| `core/calcul.js` | `getRequiredKw`, `findBestMonos`, `findMultiGroup` — **fonctions pures**, paramètres explicites, zéro accès au DOM | Testable, et supprime d'un coup le risque `NaN` du §3.9 |
| `ui/render.js` | Rendu et gestion d'état | Le reste |

La fonction `getRequiredKw` qui lit `document.getElementById` en interne est le point de couplage
le plus coûteux : la rendre pure est le prérequis de tout test automatisé sur les calculs.

### 6.3 Tests

Aucun test aujourd'hui, sur un outil dont la valeur repose entièrement sur la justesse de ses
chiffres. Une fois `core/calcul.js` isolé, une poignée de cas de référence (Lyon / Bretagne /
Méditerranée / montagne × mono / multi) exécutés par le runner natif de Node (`node --test`, sans
aucune dépendance) suffirait à empêcher toute régression silencieuse. Les incohérences des §3.2 et
§3.3 auraient été détectées immédiatement.

### 6.4 Rendu et état

- `renderResults()` régénère **tout le bloc résultats en `innerHTML`** à chaque interaction, d'où le
  contournement `withSaveInputsPreserved` (`index.html:828-838`) qui sauvegarde et restaure
  manuellement les champs Client/Zone. C'est le symptôme, pas la cause : un rendu ciblé (ne
  redessiner que les cartes concernées) rend le hack inutile.
- Effet de bord caché : `renderMultiRoomsGuide` **écrit dans `state.selection.group`** pendant le
  rendu (`index.html:912-914`). Une fonction de rendu qui mute l'état est une source classique de
  bugs difficiles à reproduire.
- Tout est en variables globales et `onclick` inline. La délégation d'événements avec des attributs
  `data-*` réglerait au passage le bug d'apostrophe du §2.3.

### 6.5 Déploiement

`netlify.toml` est correct sur les en-têtes de sécurité. À ajouter : une `Content-Security-Policy`,
`Cache-Control: no-cache` explicite sur `/sw.js`, et un cache long sur les futurs assets statiques
versionnés.

---

## 7. Plan d'action proposé

Ordonné par rapport impact/effort. Les lots sont indépendants et livrables séparément.

### Lot 1 — Corriger ce qui est faux (½ à 1 jour) — **priorité maximale**

1. Libellés de consigne : retirer les pourcentages erronés, afficher l'écart calculé en direct (§3.2)
2. Appliquer le facteur canicule aux monos délestés et au guide UI (§3.3)
3. Échapper les injections HTML + passer les callbacks en `data-*` → règle le bug apostrophe (§2.3)
4. `try/catch` sur tous les accès `localStorage` (§2.4)
5. Garde-fous numériques : `NaN`, occupants à 0, bornes de saisie (§3.9)

> Ce lot ne change aucune architecture et supprime toutes les erreurs **visibles par un client**.

### Lot 2 — Tenir la promesse PWA (1 jour)

1. `sw.js` réel + `manifest.json` statique + icônes PNG (§2.1, §2.2)
2. Tailwind figé en CSS local
3. `theme-color`, `viewport-fit=cover`, safe-area iOS, rétablissement du zoom (§4.3)
4. Mise à jour du README pour qu'il décrive ce qui existe réellement

### Lot 3 — Fiabiliser le chaud (1 à 2 jours, dont la collecte des données constructeur)

1. Étendre le catalogue avec les capacités chaud à basse température (§3.1)
2. Sélectionner sur la capacité à la température de base du chantier, comme pour la canicule
3. Afficher explicitement l'hypothèse retenue dans la carte résultat
4. Dissocier les coefficients de foisonnement froid et chaud (§3.6)

> C'est le lot à plus fort enjeu métier : il porte sur le risque de sous-dimensionnement chauffage.
> Il dépend de la disponibilité des tables constructeur — à lancer en parallèle du lot 1.

### Lot 4 — Rendre l'outil exploitable jusqu'au bout (2 à 3 jours)

1. Export PDF / partage de la fiche de dimensionnement (§4.1)
2. Recharger un chantier sauvegardé pour le modifier
3. Sauvegarder les paramètres bâtiment avec le chantier → calculs reproductibles
4. Autosave de la saisie en cours
5. Nom libre par pièce + duplication de pièce

### Lot 5 — Qualité de la sélection (1 à 2 jours)

1. Afficher le taux de charge + alerte de surdimensionnement (§3.7)
2. Contraintes multisplit : ratio de connexion, puissance par sortie (§3.8)
3. Proposer des groupes extérieurs alternatifs, comme en mono
4. Coefficient d'exposition par pièce pour corriger l'usage pièce-par-pièce du G (§3.5)
5. Reformuler la surcharge toiture pour lever le double comptage (§3.4)

### Lot 6 — Fondations techniques (1 à 2 jours)

1. Extraire `data/`, `core/`, `ui/` en modules ES (§6.2)
2. Rendre les fonctions de calcul pures
3. Cas de référence sous `node --test` (§6.3)
4. Supprimer la mutation d'état dans le rendu (§6.4)

### Lot 7 — Design et accessibilité (1 à 2 jours)

1. Échelle typographique, plancher à 11 px (§5)
2. Hiérarchie visuelle saisie / résultats
3. Rouge désaturé, contrastes AA, pastilles TVA non dépendantes de la seule couleur
4. Mode sombre
5. Gestion clavier des cartes sélectionnables, `aria-live` sur les résultats (§4.3)

---

## 8. Ce qui mérite d'être conservé tel quel

Pour éviter que le plan ne se lise comme un réquisitoire — plusieurs choix sont bons et
structurants :

- **Le mono-fichier sans build.** Pour un outil interne déployé par URL, c'est le bon compromis.
- **Le modèle de froid poste par poste.** Rare à ce niveau de finesse sur un outil terrain, et
  visiblement fondé sur une vraie méthode (type Carrier, Fc DIN 4108-2).
- **Le délestage hybride multi → mono.** Logique métier pertinente, bien implémentée.
- **La qualité des commentaires de code.** Ils expliquent le *pourquoi* physique, pas le *quoi* —
  c'est exactement ce qu'il faut, et c'est ce qui a rendu cet audit possible.
- **La base TVA 5,5 %** avec sa base légale citée en commentaire : différenciateur commercial fort.
- **Le guide des gammes** (idéal pour / plus / moins / wifi) : transforme un outil de calcul en outil
  d'aide à la vente.
