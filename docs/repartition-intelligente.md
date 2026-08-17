# Répartition intelligente des unités intérieures

> Étude de faisabilité. Rien n'est implémenté à ce jour — ce document sert à décider
> **si** on le fait, et **selon quel critère**.

## Le besoin

Aujourd'hui l'installateur décide lui-même du découpage : il saisit une zone, obtient un
groupe extérieur, enregistre, recommence pour la zone suivante. L'application dimensionne
**ce qu'on lui donne** ; elle ne remet jamais en cause le découpage.

Or c'est justement le découpage qui fait la qualité d'une installation. Cas relevé sur un
chantier réel : un séjour de 50 m² et deux chambres de 12 m² sur un seul groupe. Le groupe
est dimensionné par le séjour ; quand celui-ci est éteint, les deux chambres seules ne
sollicitent plus que ~11 % du compresseur.

La question posée : **l'application peut-elle proposer d'elle-même une meilleure répartition
des unités intérieures entre groupes extérieurs ?**

## Réponse courte : oui, et sans heuristique

Le problème est une **partition d'ensemble** : répartir N pièces en groupes, chaque groupe
devant tenir dans un modèle du catalogue (nombre de sorties, puissance). C'est NP-difficile
dans le cas général — mais les tailles réelles rendent l'énumération **exhaustive** possible.

| Pièces | Partitions à évaluer |
|---|---|
| 3 | 5 |
| 4 | 15 |
| 5 | 52 |
| 6 | 203 |
| 8 | 4 140 |
| 10 | 115 975 |
| 12 | 4 213 597 |

Mesure sur le prototype : **0,03 ms** pour explorer un cas à 3 pièces, toutes partitions
comprises. À 8 pièces on reste sous la dizaine de millisecondes. Aucune simulation, aucune
optimisation approchée, aucun appel réseau : c'est de l'arithmétique sur un catalogue de
sept groupes.

Le plafond pratique est autour de **8 à 10 pièces**. Au-delà, il faudra soit borner
(regrouper par étage saisi), soit élaguer — mais un logement résidentiel dépasse rarement
huit pièces climatisées.

## Ce que le prototype produit déjà

Cas réel ci-dessus (zone B, G 1,10, séjour 50 m² + 2 chambres de 12 m²) — les cinq
dispositions possibles, toutes servables par le catalogue Toshiba :

| | Unités ext. | Installé | Charge min | Modulation min |
|---|---|---|---|---|
| 3M18 : Salon + Ch1 + Ch2 | 1 | 5,2 kW | **74 %** | 11 % |
| Mono 16 (Salon) + 2M10 (Ch1+Ch2) | 2 | 7,5 kW | 30 % | **18 %** |
| 2M18 (Salon+Ch1) + mono 05 (Ch2) | 2 | 6,7 kW | 30 % | 11 % |
| 2M18 (Salon+Ch2) + mono 05 (Ch1) | 2 | 6,7 kW | 30 % | 11 % |
| 3 monosplits | 3 | 7,2 kW | 30 % | — |

**Il n'y a pas de gagnant absolu**, et c'est le point important : le groupe unique gagne
largement sur la charge et sur le matériel installé ; le découpage séjour / chambres gagne
sur la modulation. Le classement dépend entièrement du critère retenu.

## La vraie question n'est pas technique

Elle est : **qu'est-ce qu'une « meilleure » disposition ?** Les critères disponibles, et ce
qu'ils coûtent l'un à l'autre :

- **Nombre d'unités extérieures** — coût de pose, place en façade, passages de liaisons.
  Presque toujours le critère dominant côté client.
- **Puissance totale installée** — coût matériel.
- **Taux de charge** — trop bas, la machine cycle court.
- **Modulation minimale** — ce que le compresseur doit fournir quand seule la plus petite
  pièce appelle. C'est le défaut décrit plus haut.
- **Éligibilité TVA 5,5 %** — 14,5 points d'écart, potentiellement décisif sur le devis.
  Portée en multisplit par le groupe extérieur : le découpage change donc l'éligibilité.
- **Réalité du bâti** — deux pièces aux extrémités opposées ne se raccordent pas au même
  groupe sans un coût de liaison que l'application ne connaît pas.

Ce dernier point est le plus limitant : **l'application ignore la géométrie**. Elle ne sait
pas quelles pièces sont voisines, ni où peut se poser un groupe extérieur. Une répartition
optimale sur le papier peut être irréalisable en pose.

## Position retenue

Ne pas « choisir à la place de l'installateur », mais **montrer les possibilités qu'il n'a
pas le temps d'énumérer**, en le laissant trancher :

1. **Ne rien décider automatiquement.** L'installateur garde la main ; c'est lui qui connaît
   le bâti, l'emplacement des groupes, le budget.
2. **Proposer, pas remplacer.** Un encart « Autres dispositions possibles » sous le résultat,
   avec deux ou trois alternatives et ce qu'elles changent, chiffré.
3. **Nommer le compromis, jamais un score unique.** Un classement global masquerait
   exactement les arbitrages que ce document met en évidence. Chaque alternative doit dire
   ce qu'elle gagne *et* ce qu'elle perd.
4. **Ne jamais faire disparaître la saisie de l'installateur.** Sa répartition reste la
   proposition principale.

## Pistes d'implémentation

- Fonction pure dans `js/calcul.js` (ou un module voisin) : `explorerRepartitions(pieces,
  brand)` → liste de dispositions évaluées. Testable sans DOM, comme le reste du moteur.
- Réutilise l'existant sans le dupliquer : `findGroupesValides`, `findBestMonos`,
  `getUiSizeForKw`, `tauxChargeGroupe`, `getGroupTvaInfo`.
- L'exploration doit porter sur **toutes les pièces du chantier**, pas zone par zone — donc
  après la saisie, ou au niveau du chantier enregistré. C'est le prolongement naturel du
  rapport de chantier groupé déjà en place.
- Borne dure à ~10 pièces, avec un message explicite au-delà plutôt qu'un calcul silencieux
  tronqué.

## Ce qu'il reste à trancher avant de coder

- **Le critère de classement par défaut** (voir plus haut). C'est une décision métier.
- **Où cela s'affiche** : dans les résultats, ou seulement sur un chantier à plusieurs zones ?
- **Le seuil de modulation** qui mérite d'être signalé. Retour terrain à ce jour : le cas
  « seules les petites pièces allumées » est réel mais **rare**, donc à ne pas transformer en
  avertissement permanent.
- **La géométrie** : accepte-t-on de proposer des répartitions que la pose peut interdire, en
  le disant clairement ? Ou faut-il d'abord saisir un rattachement de pièces (étage, façade) ?
