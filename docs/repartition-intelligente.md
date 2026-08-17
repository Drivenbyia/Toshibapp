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

### La géométrie est déjà saisie — dans les zones

Première réaction : l'application ignore la géométrie, donc elle pourrait proposer des
répartitions impossibles à poser. Faux, et c'est ce qui débloque tout.

**Une zone EST une contrainte de géométrie.** L'installateur ne découpe pas au hasard : il
crée une zone parce qu'il a constaté sur place ce qui est raccordable ensemble. Cette
information n'a donc pas à être saisie une seconde fois — elle est déjà là, exprimée par le
découpage lui-même. Demander en plus un rattachement par étage ou par façade alourdirait la
saisie pour redemander ce que l'utilisateur vient de dire.

D'où la règle qui borne toute cette fonctionnalité :

> **L'exploration reste À L'INTÉRIEUR d'une zone. Jamais une pièce ne change de zone.**

Toutes les pièces d'une zone sont raccordables entre elles par construction : toute
sous-répartition de cette zone est donc physiquement réalisable — au pire deux groupes au
lieu d'un au même emplacement. À l'inverse, déplacer une pièce d'une zone à l'autre
contredirait exactement ce que l'installateur a constaté sur le terrain.

Effet secondaire heureux : une zone est plafonnée à 5 pièces (limite du multisplit), donc
**52 partitions au maximum**. La question du coût de calcul et du plafond à 10 pièces
disparaît complètement.

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
- **Portée : les pièces de la zone en cours, et elles seules** (voir plus haut). L'exploration
  se branche donc sur le calcul courant, pas sur le chantier enregistré.
- Aucune saisie supplémentaire. Aucune borne à prévoir : 5 pièces maximum par zone.

## Ce qu'il reste à trancher avant de coder

- **Le critère de classement par défaut** (voir plus haut). C'est la seule vraie décision
  métier restante.
- **Où cela s'affiche.** Contrainte posée : *« il faut que ça reste fluide »* — donc un bloc
  discret sous le résultat, replié par défaut, jamais une étape de plus dans le parcours.
- **Le seuil de modulation** qui mérite d'être signalé. Retour terrain à ce jour : le cas
  « seules les petites pièces allumées » est réel mais **rare**, donc à ne pas transformer en
  avertissement permanent.

## Tranché

- **La géométrie ne sera pas saisie.** Le découpage en zones la porte déjà ; la redemander
  alourdirait la saisie sans rien apprendre. L'exploration ne franchit jamais une zone.
