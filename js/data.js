// Données et constantes de l'application Klimo : catalogues matériel, coefficients
// physiques du modèle de calcul, base TVA, et référentiels climatiques par département.
// Module sans dépendance : ne lit jamais le DOM, ne modifie jamais d'état applicatif.

// --- COEFFICIENTS PHYSIQUES DU MODÈLE (froid / chaud) ---

// Apports internes de base (éclairage LED + équipements), résidentiel (W/m² au sol).
export const APPORTS_INTERNES = 5;

// Surcharge toiture en été (W/m² de surface au sol) si la pièce est sous la toiture.
// Rendue seulement quand la pièce est directement sous les combles / la couverture :
// c'est le poste le plus sous-estimé d'un modèle purement volumique (ΔTe toiture 25-45 K).
export const CHARGE_TOITURE = { bonne: 15, moyenne: 28, faible: 45 };

// Rayonnement solaire de pointe transmis par un vitrage clair (W/m² de vitrage),
// latitude ~45° (Sud-Ouest), par orientation dominante des baies. Méthode type Carrier.
export const RAYONNEMENT_VITRAGE = { nord: 45, est: 585, sud: 290, ouest: 585, mixte: 350 };
// Ratio surface vitrée / surface au sol selon la quantité de vitrage déclarée.
export const RATIO_VITRAGE = { peu: 0.10, moyen: 0.18, beaucoup: 0.28 };
// Coefficient de réduction des protections solaires (Fc, DIN 4108-2 / EN 14501).
export const FC_PROTECTION = { aucune: 1.0, stores_int: 0.55, volets_ext: 0.15 };
export const G_VITRAGE = 0.75;            // facteur solaire d'un double vitrage standard (valeur d'usage)
export const COEF_INERTIE_SOLAIRE = 0.8;  // amortissement / déphasage moyen (bâti mixte)
export const OCCUPANT_W = 100;            // apport total (sensible + latent) par occupant, résidentiel au repos
export const COEF_RELANCE = 1.20;         // majoration chauffage pour la relance matinale

// Coefficient G par défaut si la saisie personnalisée est vide ou invalide.
export const COEF_G_DEFAUT = 0.8;

// Consigne intérieure été de référence (utilisée pour l'écart affiché dans le bandeau climat).
export const CONSIGNE_REFERENCE = 26;

// Marge canicule : la puissance froid catalogue est donnée à 35°C ext. (EN 14511) ; en canicule
// réelle (40-42°C) elle chute ~10%, d'où une majoration du besoin pour la sélection.
//
// Auparavant une liste fixe de 3 zones (B, H, I) recevait +11%, les 6 autres 0% — binaire et
// incohérent : la zone F (Lyon, base été 33°C, la plus chaude de toutes hors H/I à 34°C) n'avait
// AUCUNE marge, quand la zone B (base été 32°C, donc plus douce) en avait une. Remplacé par une
// interpolation sur la température de base été elle-même, symétrique de la méthode déjà utilisée
// côté chaud (ratioDeclassementChaud) : aucune marge sous le seuil bas (climats océaniques, où
// les pointes dépassent rarement leur base), marge maximale au-delà du seuil haut (les zones les
// plus chaudes du référentiel), progressive entre les deux.
export const ABATTEMENT_CANICULE_SEUIL_BAS = 28;   // °C — en dessous, climat océanique tempéré : aucune marge
export const ABATTEMENT_CANICULE_SEUIL_HAUT = 34;  // °C — au-dessus, marge maximale (zones H/I du référentiel)
export const ABATTEMENT_CANICULE_MAX = 1.11;       // besoin froid majoré de 11% au maximum

// Déclassement de la puissance chaud par grand froid — PAC air/air.
// IMPORTANT : ces paliers sont une approximation générique (ordre de grandeur usuel pour une PAC
// air/air standard, non "grand froid"), PAS des données constructeur Toshiba/Panasonic spécifiques
// par gamme. Ils comblent un manque total de garde-fou en attendant les courbes de puissance
// réelles par référence — à substituer dès qu'elles sont disponibles (voir AUDIT.md §3.1).
export const DECLASSEMENT_CHAUD_PALIERS = [
    { temp: 7,   ratio: 1.00 },
    { temp: 0,   ratio: 0.90 },
    { temp: -7,  ratio: 0.72 },
    { temp: -15, ratio: 0.58 },
    { temp: -20, ratio: 0.50 }
];

// Foisonnement dissocié froid / chaud sur un groupe multisplit : la pointe froid est quasi
// simultanée sur toutes les pièces (même après-midi de canicule) et ne justifie qu'une faible
// marge. Le chauffage, lui, est davantage désynchronisé dans le temps et garde une marge plus large.
export const COEF_FOISONNEMENT_FROID = 1.05;
export const COEF_FOISONNEMENT_CHAUD = 1.25;

// Taux de charge (besoin réel / puissance nominale) en dessous duquel un inverter résidentiel
// cycle court : confort et rendement réel dégradés malgré une puissance affichée confortable.
export const SEUIL_SOUS_CHARGE = 0.5;

// Si une pièce consomme à elle seule plus de cette part de la puissance nominale d'un groupe
// multisplit, les autres pièces peuvent manquer de capacité en cas de forte demande simultanée.
export const SEUIL_DESEQUILIBRE_GROUPE = 0.6;

// Taux de charge plancher accepté pour l'escalade anti-déséquilibre (findGroupeEquilibre) : monter
// d'un cran de groupe pour rééquilibrer fait mécaniquement baisser le taux de charge, et un cran
// de plus passe presque toujours sous SEUIL_SOUS_CHARGE. Un déficit de capacité en demande
// simultanée est plus pénalisant qu'un léger surdimensionnement, on tolère donc de descendre sous
// le seuil de sous-charge — mais pas en dessous de ce plancher, où le surcoût matériel et les
// cycles courts coûteraient plus que le déséquilibre corrigé (le badge de taux de charge continue
// d'alerter dès SEUIL_SOUS_CHARGE, l'utilisateur garde donc l'information).
export const SEUIL_SOUS_CHARGE_ESCALADE = 0.4;

// Tolérance de regroupement des solutions équivalentes (findBestMonos / findMultiGroupOptions) :
// on retient toutes les références dont la puissance froid nominale reste à +15% max de la plus
// petite solution valide, plutôt qu'un choix unique imposé.
export const TOLERANCE_EQUIVALENCE = 1.15;

// Libellés d'affichage. Registre unique : jusqu'ici le libellé était déduit par un ternaire
// binaire (`brand === 'toshiba' ? 'Toshiba' : 'Panasonic'`), qui affichait « Panasonic »
// pour toute valeur inattendue — y compris une marque restaurée d'un ancien chantier.
export const BRAND_LABELS = {
    toshiba: 'Toshiba',
    panasonic: 'Panasonic'
};

// --- CATALOGUES MATÉRIEL ---

export const CATALOGS = {
  toshiba: {
    monosplits: [
        // --- NAKA (entrée de gamme) ---
        { gamme: "Naka", reference_ensemble: "RAS-05B2AVG-E / RAS-B05B2KVG-E", puissance_froid_kw: 1.5, puissance_chaud_kw: 2.0 },
        { gamme: "Naka", reference_ensemble: "RAS-07B2AVG-E / RAS-B07B2KVG-E", puissance_froid_kw: 2.0, puissance_chaud_kw: 2.5 },
        { gamme: "Naka", reference_ensemble: "RAS-10B2AVG-E / RAS-B10B2KVG-E", puissance_froid_kw: 2.5, puissance_chaud_kw: 3.2 },
        { gamme: "Naka", reference_ensemble: "RAS-13B2AVG-E / RAS-B13B2KVG-E", puissance_froid_kw: 3.3, puissance_chaud_kw: 3.6 },
        { gamme: "Naka", reference_ensemble: "RAS-16B2AVG-E / RAS-B16B2KVG-E", puissance_froid_kw: 4.2, puissance_chaud_kw: 5.0 },
        { gamme: "Naka", reference_ensemble: "RAS-18B2AVG-E / RAS-B18B2KVG-E", puissance_froid_kw: 5.0, puissance_chaud_kw: 5.4 },
        { gamme: "Naka", reference_ensemble: "RAS-24B2AVG-E / RAS-B24B2KVG-E", puissance_froid_kw: 6.5, puissance_chaud_kw: 7.0 },
        { gamme: "Daiseikai 10", reference_ensemble: "RAS-10S4AVPG-E / RAS-B10S4KVDG-E", puissance_froid_kw: 2.5, puissance_chaud_kw: 3.2 },
        { gamme: "Daiseikai 10", reference_ensemble: "RAS-13S4AVPG-E / RAS-B13S4KVDG-E", puissance_froid_kw: 3.5, puissance_chaud_kw: 4.0 },
        { gamme: "Daiseikai 10", reference_ensemble: "RAS-18S4AVPG-E / RAS-B18S4KVDG-E", puissance_froid_kw: 5.0, puissance_chaud_kw: 6.0 },
        { gamme: "Haori", reference_ensemble: "RAS-10J2AVSG-E1 / RAS-B10N4KVRG-E1", puissance_froid_kw: 2.5, puissance_chaud_kw: 3.2 },
        { gamme: "Haori", reference_ensemble: "RAS-13J2AVSG-E1 / RAS-B13N4KVRG-E", puissance_froid_kw: 3.5, puissance_chaud_kw: 4.2 },
        { gamme: "Haori", reference_ensemble: "RAS-16J2AVSG-E1 / RAS-B16N4KVRG-E", puissance_froid_kw: 4.6, puissance_chaud_kw: 5.5 },
        { gamme: "Console Double-Flux", reference_ensemble: "RAS-10J2AVSG-E1 / RAS-B10J2FVG-E", puissance_froid_kw: 2.5, puissance_chaud_kw: 3.2 },
        { gamme: "Console Double-Flux", reference_ensemble: "RAS-13J2AVSG-E1 / RAS-B13J2FVG-E", puissance_froid_kw: 3.5, puissance_chaud_kw: 4.2 },
        // --- NOUVEAUX YUKAI ---
        { gamme: "Yukai", reference_ensemble: "RAS-05E2AVG-E / RAS-B05E2KVG-E", puissance_froid_kw: 1.5, puissance_chaud_kw: 2.0 },
        { gamme: "Yukai", reference_ensemble: "RAS-07E2AVG-E / RAS-B07E2KVG-E", puissance_froid_kw: 2.0, puissance_chaud_kw: 2.5 },
        { gamme: "Yukai", reference_ensemble: "RAS-10E2AVG-E / RAS-B10E2KVG-E", puissance_froid_kw: 2.5, puissance_chaud_kw: 3.2 },
        { gamme: "Yukai", reference_ensemble: "RAS-13E2AVG-E / RAS-B13E2KVG-E", puissance_froid_kw: 3.3, puissance_chaud_kw: 3.6 },
        { gamme: "Yukai", reference_ensemble: "RAS-16E2AVG-E / RAS-B16E2KVG-E", puissance_froid_kw: 4.2, puissance_chaud_kw: 5.0 },
        { gamme: "Yukai", reference_ensemble: "RAS-18E2AVG-E / RAS-B18E2KVG-E", puissance_froid_kw: 5.0, puissance_chaud_kw: 5.4 },
        { gamme: "Yukai", reference_ensemble: "RAS-24E2AVG-E / RAS-B24E2KVG-E", puissance_froid_kw: 6.5, puissance_chaud_kw: 7.0 },
        // --- NOUVEAUX SHORAI EDGE ---
        { gamme: "Shorai Edge", reference_ensemble: "RAS-07J2AVSG-E1 / RAS-B07G3KVSG-E", puissance_froid_kw: 2.0, puissance_chaud_kw: 2.5 },
        { gamme: "Shorai Edge", reference_ensemble: "RAS-10J2AVSG-E1 / RAS-B10G3KVSG-E", puissance_froid_kw: 2.5, puissance_chaud_kw: 3.2 },
        { gamme: "Shorai Edge", reference_ensemble: "RAS-13J2AVSG-E1 / RAS-B13G3KVSG-E", puissance_froid_kw: 3.5, puissance_chaud_kw: 4.2 },
        { gamme: "Shorai Edge", reference_ensemble: "RAS-16J2AVSG-E1 / RAS-B16G3KVSG-E", puissance_froid_kw: 4.6, puissance_chaud_kw: 5.5 },
        { gamme: "Shorai Edge", reference_ensemble: "RAS-18J2AVSG-E1 / RAS-B18G3KVSG-E", puissance_froid_kw: 5.0, puissance_chaud_kw: 6.0 },
        { gamme: "Shorai Edge", reference_ensemble: "RAS-22J2AVSG-E1 / RAS-B22G3KVSG-E", puissance_froid_kw: 6.1, puissance_chaud_kw: 7.0 },
        { gamme: "Shorai Edge", reference_ensemble: "RAS-24J2AVSG-E1 / RAS-B24G3KVSG-E", puissance_froid_kw: 7.0, puissance_chaud_kw: 8.0 }
    ],
    multisplits_groupes_exterieurs: [
        { reference: "RAS-2M10G3AVG-E", max_unites_interieures: 2, puissance_nominale_froid_kw: 3.3, puissance_nominale_chaud_kw: 4.0 },
        { reference: "RAS-2M14G3AVG-E", max_unites_interieures: 2, puissance_nominale_froid_kw: 4.0, puissance_nominale_chaud_kw: 4.4 },
        { reference: "RAS-2M18G3AVG-E", max_unites_interieures: 2, puissance_nominale_froid_kw: 5.2, puissance_nominale_chaud_kw: 5.6 },
        { reference: "RAS-3M18G3AVG-E", max_unites_interieures: 3, puissance_nominale_froid_kw: 5.2, puissance_nominale_chaud_kw: 6.8 },
        { reference: "RAS-3M26G3AVG-E", max_unites_interieures: 3, puissance_nominale_froid_kw: 7.5, puissance_nominale_chaud_kw: 9.0 },
        { reference: "RAS-4M27G3AVG-E", max_unites_interieures: 4, puissance_nominale_froid_kw: 8.0, puissance_nominale_chaud_kw: 9.0 },
        { reference: "RAS-5M34G3AVG-E/ET", max_unites_interieures: 5, puissance_nominale_froid_kw: 10.0, puissance_nominale_chaud_kw: 12.0 }
    ]
  },
  panasonic: {
    monosplits: [
        // --- TZ ULTRA COMPACT ---
        { gamme: "TZ Ultra Compact", reference_ensemble: "CU-TZ20CKE / CS-TZ20CKEW", puissance_froid_kw: 2.00, puissance_chaud_kw: 2.70 },
        { gamme: "TZ Ultra Compact", reference_ensemble: "CU-TZ25CKE / CS-TZ25CKEW", puissance_froid_kw: 2.50, puissance_chaud_kw: 3.30 },
        { gamme: "TZ Ultra Compact", reference_ensemble: "CU-TZ35CKE / CS-TZ35CKEW", puissance_froid_kw: 3.50, puissance_chaud_kw: 4.00 },
        { gamme: "TZ Ultra Compact", reference_ensemble: "CU-TZ42CKE / CS-TZ42CKEW", puissance_froid_kw: 4.20, puissance_chaud_kw: 5.00 },
        { gamme: "TZ Ultra Compact", reference_ensemble: "CU-TZ50CKE / CS-TZ50CKEW", puissance_froid_kw: 5.00, puissance_chaud_kw: 5.80 },
        { gamme: "TZ Ultra Compact", reference_ensemble: "CU-TZ71CKE / CS-TZ71CKEW", puissance_froid_kw: 7.10, puissance_chaud_kw: 8.20 },
        // --- ETHEREA ---
        { gamme: "Etherea", reference_ensemble: "CU-Z20CKE / CS-Z20CKEW", puissance_froid_kw: 2.05, puissance_chaud_kw: 2.80 },
        { gamme: "Etherea", reference_ensemble: "CU-Z25CKE / CS-Z25CKEW", puissance_froid_kw: 2.50, puissance_chaud_kw: 3.40 },
        { gamme: "Etherea", reference_ensemble: "CU-Z35CKE / CS-Z35CKEW", puissance_froid_kw: 3.50, puissance_chaud_kw: 4.00 },
        { gamme: "Etherea", reference_ensemble: "CU-Z42CKE / CS-Z42CKEW", puissance_froid_kw: 4.20, puissance_chaud_kw: 5.30 },
        { gamme: "Etherea", reference_ensemble: "CU-Z50CKE / CS-Z50CKEW", puissance_froid_kw: 5.00, puissance_chaud_kw: 5.80 }
    ],
    multisplits_groupes_exterieurs: [
        // --- MULTI TZ (compatible uniquement avec unités intérieures TZ Ultra Compact) ---
        { reference: "CU-2TZ41TBE", max_unites_interieures: 2, puissance_nominale_froid_kw: 4.10, puissance_nominale_chaud_kw: 4.40, gammes_compatibles: ["TZ Ultra Compact"] },
        { reference: "CU-2TZ50TBE", max_unites_interieures: 2, puissance_nominale_froid_kw: 5.00, puissance_nominale_chaud_kw: 5.70, gammes_compatibles: ["TZ Ultra Compact"] },
        { reference: "CU-3TZ52TBE", max_unites_interieures: 3, puissance_nominale_froid_kw: 5.20, puissance_nominale_chaud_kw: 6.80, gammes_compatibles: ["TZ Ultra Compact"] },
        // --- MULTI Z DELUXE (compatible avec TZ Ultra Compact et Etherea) ---
        { reference: "CU-2Z35CBE", max_unites_interieures: 2, puissance_nominale_froid_kw: 3.50, puissance_nominale_chaud_kw: 4.20, gammes_compatibles: ["TZ Ultra Compact", "Etherea"] },
        { reference: "CU-2Z41CBE", max_unites_interieures: 2, puissance_nominale_froid_kw: 4.10, puissance_nominale_chaud_kw: 4.60, gammes_compatibles: ["TZ Ultra Compact", "Etherea"] },
        { reference: "CU-2Z50CBE", max_unites_interieures: 2, puissance_nominale_froid_kw: 5.00, puissance_nominale_chaud_kw: 5.60, gammes_compatibles: ["TZ Ultra Compact", "Etherea"] },
        { reference: "CU-3Z52CBE", max_unites_interieures: 3, puissance_nominale_froid_kw: 5.20, puissance_nominale_chaud_kw: 6.80, gammes_compatibles: ["TZ Ultra Compact", "Etherea"] },
        { reference: "CU-3Z68CBE", max_unites_interieures: 3, puissance_nominale_froid_kw: 6.80, puissance_nominale_chaud_kw: 8.50, gammes_compatibles: ["TZ Ultra Compact", "Etherea"] },
        { reference: "CU-4Z68CBE", max_unites_interieures: 4, puissance_nominale_froid_kw: 6.80, puissance_nominale_chaud_kw: 8.50, gammes_compatibles: ["TZ Ultra Compact", "Etherea"] },
        { reference: "CU-4Z80CBE", max_unites_interieures: 4, puissance_nominale_froid_kw: 8.00, puissance_nominale_chaud_kw: 9.40, gammes_compatibles: ["TZ Ultra Compact", "Etherea"] },
        { reference: "CU-5Z90CBE", max_unites_interieures: 5, puissance_nominale_froid_kw: 9.00, puissance_nominale_chaud_kw: 10.40, gammes_compatibles: ["TZ Ultra Compact", "Etherea"] }
    ]
  }
};

// Tailles UI (codes commerciaux) par palier de puissance, propres à chaque marque.
//
// `froidMax` / `chaudMax` = puissance nominale la plus élevée offerte par cette taille, tous
// modèles de la marque confondus. Une taille couvre donc un besoin si elle le couvre EN FROID
// ET EN CHAUD — les deux plafonds sont vérifiés séparément (voir getUiSizeForKw).
//
// Pourquoi deux colonnes et pas une : il n'y avait ici qu'un seul champ `max`, dont la
// signification différait silencieusement d'une marque à l'autre — la puissance CHAUD côté
// Toshiba, la puissance FROID côté Panasonic. Le besoin froid n'était donc jamais confronté à
// la capacité froid réelle : un besoin de 3,0 kW en froid renvoyait la taille "10", qui ne
// délivre que 2,5 kW en froid. La taille annoncée à l'installateur était sous-dimensionnée
// d'environ 20%, et l'écart était maximal en mode « Froid seul ».
//
// « Plus élevée » et non « la plus faible » : cette taille indique le calibre à commander, et
// l'application affiche séparément, pièce par pièce, quelles gammes de ce calibre couvrent
// réellement le besoin (getRoomEligibleGammes). Retenir le plafond haut garde les deux
// informations cohérentes ; retenir le plafond bas ferait monter d'un cran des tailles pour
// lesquelles une gamme convient parfaitement.
//
// Les valeurs sont dérivées du catalogue ci-dessus et vérifiées par un test qui recalcule la
// table depuis CATALOGS (tests/calcul.test.mjs) : elles ne peuvent plus diverger en silence.
export const UI_SIZE_TABLES = {
    toshiba: [
        { code: "05", froidMax: 1.5, chaudMax: 2.0 },
        { code: "07", froidMax: 2.0, chaudMax: 2.5 },
        { code: "10", froidMax: 2.5, chaudMax: 3.2 },
        { code: "13", froidMax: 3.5, chaudMax: 4.2 },
        { code: "16", froidMax: 4.6, chaudMax: 5.5 },
        { code: "18", froidMax: 5.0, chaudMax: 6.0 },
        { code: "22", froidMax: 6.1, chaudMax: 7.0 },
        { code: "24", froidMax: 7.0, chaudMax: 8.0 }
    ],
    panasonic: [
        { code: "20", froidMax: 2.05, chaudMax: 2.8 },
        { code: "25", froidMax: 2.5,  chaudMax: 3.4 },
        { code: "35", froidMax: 3.5,  chaudMax: 4.0 },
        { code: "42", froidMax: 4.2,  chaudMax: 5.3 },
        { code: "50", froidMax: 5.0,  chaudMax: 5.8 },
        { code: "71", froidMax: 7.1,  chaudMax: 8.2 }
    ]
};

// --- GUIDE DES GAMMES (fiche affichée sous chaque solution) ---
// Données factuelles (source constructeur). Purement informatif, n'influence pas la sélection.
export const GAMMES_INFO = {
  toshiba: {
    "Naka": {
        tier: "€ · Entrée de gamme", wifi: "Option",
        plus: ["Meilleur rapport qualité/prix", "Silencieux (dès 19 dB)", "Compatible mono & multisplit"],
        moins: ["Wifi en option", "Chauffage A+ : moins tenace par grand froid"],
        ideal: "Froid + chauffage d'appoint, budget maîtrisé"
    },
    "Yukai": {
        tier: "€ · Entrée / milieu", wifi: "Option",
        plus: ["Filtre Ultra-Fresh de série", "SCOP jusqu'à 4,6", "Fonctionne jusqu'à −15 °C"],
        moins: ["Wifi en option", "Moins performante que Daiseikai par grand froid"],
        ideal: "Pièce principale, bon équilibre froid / chaud"
    },
    "Shorai Edge": {
        tier: "€€ · Milieu / haut de gamme", wifi: "De série",
        plus: ["A+++ froid ET chaud (SCOP 5,1)", "Très silencieux (19 dB)", "Wifi intégré de série", "Design compact noir / blanc"],
        moins: ["Plus chère que l'entrée de gamme"],
        ideal: "Chauffage principal en climat doux / tempéré"
    },
    "Haori": {
        tier: "€€€ · Haut de gamme design", wifi: "De série",
        plus: ["Habillage textile personnalisable (14 coloris)", "A+++ / 19 dB", "Ioniseur plasma + diffusion 3D", "Wifi de série"],
        moins: ["Prix élevé", "Puissances limitées (2,5–4,6 kW)", "Textile à entretenir"],
        ideal: "Salon / pièce à vivre où l'esthétique prime"
    },
    "Daiseikai 10": {
        tier: "€€€ · Haut de gamme chauffage", wifi: "De série",
        plus: ["Meilleur SCOP du marché (5,3)", "SEER jusqu'à 10,7", "Fonctionne jusqu'à −15 °C", "Détection de présence"],
        moins: ["Prix élevé", "Puissances limitées (2,5–5,0 kW)"],
        ideal: "Chauffage principal, recherche du meilleur rendement"
    },
    "Console Double-Flux": {
        tier: "€€ · Format console", wifi: "Selon modèle",
        plus: ["Pose basse en allège (sous fenêtre)", "Double flux d'air haut / bas", "Remplace idéalement un radiateur"],
        moins: ["Encombrement au sol", "Choix de puissances limité"],
        ideal: "Remplacement de radiateur, diffusion type chauffage central"
    }
  },
  panasonic: {
    "TZ Ultra Compact": {
        tier: "€€ · Milieu de gamme compacte", wifi: "De série",
        plus: ["Wifi intégré de série (appli Comfort Cloud)", "Très silencieux dès 20 dB(A)", "nanoe™ X (purification de l'air)", "Chauffage garanti jusqu'à −15 °C", "Compatible mono & Multi TZ", "Design compact (largeur 765 mm)"],
        moins: ["SCOP 4,1 à 4,6 (classe A+/A++) : un cran sous Etherea", "Coloris blanc uniquement"],
        ideal: "Pièce principale ou secondaire, bon rapport performance/prix"
    },
    "Etherea": {
        tier: "€€€ · Haut de gamme design", wifi: "De série",
        plus: ["SEER jusqu'à 9,50 / SCOP jusqu'à 5,20 (classe A+++)", "Ultra silencieuse dès 19 dB(A)", "Mode ECO IA : jusqu'à 20 % d'économies en froid", "nanoe™ X Mark 3 + nettoyage interne à la demande", "3 coloris (graphite, gris argenté, blanc mat)", "Chauffage garanti jusqu'à −20 °C"],
        moins: ["Prix plus élevé", "Coloris graphite/gris argenté non disponibles sur toutes les puissances"],
        ideal: "Salon / pièce à vivre, recherche du meilleur rendement énergétique et du design"
    }
  }
};

// --- TVA 5,5% (rénovation énergétique) — Pompes à chaleur Air/Air ---
// Base légale : Article 92, Loi n°2026-103 du 19/02/2026 de finances pour 2026 (codifié à l'art. 278-0 bis A du CGI)
// + Arrêté du 13/07/2026 (exigences SEER/SCOP classe A++ en mono-split ≤12kW / A+ en multi-split, et pilotage à distance Wifi).
//
// SOURCE : fichier Toshiba « TVA 5,5 éligibilité Toshiba v3 » fourni par l'entreprise (remplace la v2
// du 17/07/2026). Le tableau est référence par référence (UE + UI), colonne « Eligible TVA 5,5 Mono ».
// Les règles ci-dessous en sont la transcription littérale, taille par taille, pour rester
// re-vérifiable ligne à ligne face au fichier d'origine.
//
// DEUX RÉGIMES DISTINCTS, c'est le point clé du tableau :
//   - MONOSPLIT : l'éligibilité se juge sur l'ensemble UE+UI, gamme par gamme et taille par taille
//     (Naka refusée en entier, Yukai refusée en 18 et 24, Wifi exigé sur les gammes signalées
//     « option Wifi necessaire »).
//   - MULTISPLIT : l'éligibilité est portée par le GROUPE EXTÉRIEUR. Le tableau liste les groupes
//     éligibles avec, en unité intérieure, « Toutes unités intérieures » — donc les gammes et tailles
//     refusées en monosplit (Naka, Yukai 18/24) redeviennent éligibles une fois raccordées à un
//     groupe listé, et AUCUNE condition de module Wifi n'est posée en multisplit (contrairement à la
//     v2, qui en exigeait un sur Naka / Yukai / Console).
//
// Une référence absente du tableau n'est PAS traitée comme refusée mais comme « à vérifier » :
// l'outil ne peut ni promettre 5,5% ni condamner à 20% une machine que le constructeur n'a pas
// tranchée (voir getTvaInfo). Aucun cas dans le catalogue actuel : la seule référence non listée,
// Shorai Edge taille 24, a été confirmée éligible par l'entreprise (toute la gamme l'est).
//
// Couvert par le tableau mais hors catalogue de l'application (aucune donnée de puissance
// exploitable ici, donc non transcrit) : Shorai Curve et Shorai Curve Super Heating (mêmes tailles
// qu'en Shorai Edge, éligibles), Cassette 1 voie (RAV-GM303/403 : non éligibles), Gainable standard
// (éligibilité par référence — série GP éligible avec Wifi, série GM non éligible), et le groupe
// multisplit RAS-2M60S4AVG-ND (éligible, réservé aux UI « ND » : Haori ND, Shorai Curve ND).
//
// Uniquement disponible pour la marque Toshiba : aucune donnée d'éligibilité officielle communiquée pour Panasonic.
export const TVA_RULES = {
  toshiba: {
    // Monosplit (une UE dédiée à une seule UI). taillesEligibles / taillesNonEligibles = codes taille
    // effectivement présents dans le tableau ; toute autre taille est « à vérifier ».
    mono: {
        "Naka":                 { wifiRequired: false, taillesEligibles: [],                                 taillesNonEligibles: ["05", "07", "10", "13", "16", "18", "24"] },
        "Yukai":                { wifiRequired: true,  taillesEligibles: ["05", "07", "10", "13", "16"],     taillesNonEligibles: ["18", "24"] },
        // Taille 24 absente du tableau v3, mais éligible : toute la gamme Shorai Edge l'est
        // (confirmation de l'entreprise, 03/08/2026).
        "Shorai Edge":          { wifiRequired: false, taillesEligibles: ["07", "10", "13", "16", "18", "22", "24"], taillesNonEligibles: [] },
        "Haori":                { wifiRequired: false, taillesEligibles: ["10", "13", "16"],                 taillesNonEligibles: [] },
        "Daiseikai 10":         { wifiRequired: false, taillesEligibles: ["10", "13", "18"],                 taillesNonEligibles: [] },
        "Console Double-Flux":  { wifiRequired: false, taillesEligibles: ["10", "13", "18"],                 taillesNonEligibles: [] }
    },
    // Multisplit : éligibilité portée par le groupe extérieur, sans condition de Wifi.
    multi: {
        // Groupes listés comme éligibles, par racine de référence : le suffixe commercial varie selon
        // les millésimes (RAS-5M34G3AVG-E/ET au catalogue, -E1 dans le tableau) sans changer la machine.
        groupesEligibles: [
            "RAS-2M10G3AVG", "RAS-2M14G3AVG", "RAS-2M18G3AVG", "RAS-2M60S4AVG",
            "RAS-3M18G3AVG", "RAS-3M26G3AVG", "RAS-4M27G3AVG", "RAS-5M34G3AVG"
        ],
        // « Toutes unités intérieures », détaillées en commentaire du tableau (noms alignés sur les
        // gammes du catalogue de l'application).
        gammesUi: [
            "Daiseikai 10", "Haori", "Shorai Edge", "Shorai Curve", "Yukai", "Naka",
            "Cassette 1 voie", "Console Double-Flux"
        ],
        wifiRequired: false
    }
  }
};

// --- RÉFÉRENTIEL CLIMATIQUE ---

export const DEPARTMENTS = { "01": { name: "Ain", zone: "F" }, "02": { name: "Aisne", zone: "D" }, "03": { name: "Allier", zone: "F" }, "04": { name: "Alpes-de-Haute-Provence", zone: "I" }, "05": { name: "Hautes-Alpes", zone: "I" }, "06": { name: "Alpes-Maritimes", zone: "H" }, "07": { name: "Ardèche", zone: "I" }, "08": { name: "Ardennes", zone: "F" }, "09": { name: "Ariège", zone: "I" }, "10": { name: "Aube", zone: "F" }, "11": { name: "Aude", zone: "H" }, "12": { name: "Aveyron", zone: "G" }, "13": { name: "Bouches-du-Rhône", zone: "H" }, "14": { name: "Calvados", zone: "C" }, "15": { name: "Cantal", zone: "G" }, "16": { name: "Charente", zone: "B" }, "17": { name: "Charente-Maritime", zone: "B" }, "18": { name: "Cher", zone: "E" }, "19": { name: "Corrèze", zone: "G" }, "2A": { name: "Corse-du-Sud", zone: "H" }, "2B": { name: "Haute-Corse", zone: "H" }, "21": { name: "Côte-d'Or", zone: "F" }, "22": { name: "Côtes-d'Armor", zone: "A" }, "23": { name: "Creuse", zone: "G" }, "24": { name: "Dordogne", zone: "B" }, "25": { name: "Doubs", zone: "J" }, "26": { name: "Drôme", zone: "F" }, "27": { name: "Eure", zone: "C" }, "28": { name: "Eure-et-Loir", zone: "E" }, "29": { name: "Finistère", zone: "A" }, "30": { name: "Gard", zone: "H" }, "31": { name: "Haute-Garonne", zone: "I" }, "32": { name: "Gers", zone: "I" }, "33": { name: "Gironde", zone: "B" }, "34": { name: "Hérault", zone: "H" }, "35": { name: "Ille-et-Vilaine", zone: "A" }, "36": { name: "Indre", zone: "E" }, "37": { name: "Indre-et-Loire", zone: "E" }, "38": { name: "Isère", zone: "F" }, "39": { name: "Jura", zone: "F" }, "40": { name: "Landes", zone: "B" }, "41": { name: "Loir-et-Cher", zone: "E" }, "42": { name: "Loire", zone: "F" }, "43": { name: "Haute-Loire", zone: "F" }, "44": { name: "Loire-Atlantique", zone: "A" }, "45": { name: "Loiret", zone: "E" }, "46": { name: "Lot", zone: "B" }, "47": { name: "Lot-et-Garonne", zone: "B" }, "48": { name: "Lozère", zone: "G" }, "49": { name: "Maine-et-Loire", zone: "E" }, "50": { name: "Manche", zone: "C" }, "51": { name: "Marne", zone: "F" }, "52": { name: "Haute-Marne", zone: "F" }, "53": { name: "Mayenne", zone: "E" }, "54": { name: "Meurthe-et-Moselle", zone: "J" }, "55": { name: "Meuse", zone: "J" }, "56": { name: "Morbihan", zone: "A" }, "57": { name: "Moselle", zone: "J" }, "58": { name: "Nièvre", zone: "F" }, "59": { name: "Nord", zone: "D" }, "60": { name: "Oise", zone: "D" }, "61": { name: "Orne", zone: "C" }, "62": { name: "Pas-de-Calais", zone: "D" }, "63": { name: "Puy-de-Dôme", zone: "F" }, "64": { name: "Pyrénées-Atlantiques", zone: "B" }, "65": { name: "Hautes-Pyrénées", zone: "I" }, "66": { name: "Pyrénées-Orientales", zone: "H" }, "67": { name: "Bas-Rhin", zone: "J" }, "68": { name: "Haut-Rhin", zone: "J" }, "69": { name: "Rhône", zone: "F" }, "70": { name: "Haute-Saône", zone: "J" }, "71": { name: "Saône-et-Loire", zone: "F" }, "72": { name: "Sarthe", zone: "E" }, "73": { name: "Savoie", zone: "F" }, "74": { name: "Haute-Savoie", zone: "F" }, "75": { name: "Paris", zone: "D" }, "76": { name: "Seine-Maritime", zone: "C" }, "77": { name: "Seine-et-Marne", zone: "D" }, "78": { name: "Yvelines", zone: "D" }, "79": { name: "Deux-Sèvres", zone: "E" }, "80": { name: "Somme", zone: "D" }, "81": { name: "Tarn", zone: "I" }, "82": { name: "Tarn-et-Garonne", zone: "I" }, "83": { name: "Var", zone: "H" }, "84": { name: "Vaucluse", zone: "H" }, "85": { name: "Vendée", zone: "A" }, "86": { name: "Vienne", zone: "E" }, "87": { name: "Haute-Vienne", zone: "G" }, "88": { name: "Vosges", zone: "J" }, "89": { name: "Yonne", zone: "F" }, "90": { name: "Territoire de Belfort", zone: "J" }, "91": { name: "Essonne", zone: "D" }, "92": { name: "Hauts-de-Seine", zone: "D" }, "93": { name: "Seine-Saint-Denis", zone: "D" }, "94": { name: "Val-de-Marne", zone: "D" }, "95": { name: "Val-d'Oise", zone: "D" }, "971": { name: "Guadeloupe", zone: "T" }, "972": { name: "Martinique", zone: "T" }, "973": { name: "Guyane", zone: "T" }, "974": { name: "La Réunion", zone: "T" }, "976": { name: "Mayotte", zone: "T" } };

// Températures de base HIVER (°C) par zone × altitude.
//
// ⚠️ SOURCE — à faire valider. Ces valeurs s'appuient sur la table usuelle des températures
// extérieures de base par zone A→I et sur les valeurs publiques citées pour la norme
// NF P52-612/CN (complément national à la NF EN 12831-1), dont le texte intégral est payant.
// Elles n'ont PAS été confrontées ligne à ligne au document normatif : c'est une vérification
// à mener avant de s'appuyer dessus dans un contexte contractuel.
//
// Zones J et T ajoutées, et plateau de la zone F supprimé — trois corrections d'écarts mesurés :
//
// • Zone J (est continental : Alsace, Lorraine, Franche-Comté, Territoire de Belfort).
//   Ces départements étaient en zone F à -9°C alors que la valeur de référence publiée pour
//   Strasbourg est -15°C. Sur un ΔT de 29 K, c'était environ 20% de SOUS-dimensionnement
//   chauffage — le seul biais du modèle qui allait vers le déficit de puissance, tous les
//   autres surdimensionnent. Besançon et Belfort, dont la base usuelle est plutôt -12°C,
//   sont inclus dans cette zone : les surdimensionner de ~10% est préférable à les
//   sous-dimensionner de 20%.
//
// • Zone T (départements et régions d'outre-mer). Les cinq DOM étaient rattachés à la zone H,
//   donc calculés avec une base hiver de -5°C : un ΔT de 25 K et un besoin de chauffage
//   substantiel en Guadeloupe, Martinique, Guyane, Réunion et Mayotte. La base tropicale au
//   niveau de la mer annule de fait le besoin chauffage (ΔT de 2 K), ce qui est le
//   comportement attendu ; le gradient d'altitude reste appliqué pour les hauts de la Réunion.
//
// • Zone F : le gradient s'arrêtait à -13°C et restait plat de 800 m à 2200 m, là où la zone G
//   descend à -29°C. Un chalet à 1800 m en Savoie ou en Haute-Savoie était donc calculé 5 à 8 K
//   trop chaud. Le plateau était un artefact de saisie, pas une réalité physique : le gradient
//   propre à la zone (-1 K par tranche de 200 m) est simplement prolongé.
export const tBaseMatrix = { "0 à 200m": {A: -2, B: -4, C: -5, D: -7, E: -8, F: -9, G: -10, H: -5, I: -6, J: -15, T: 18}, "200 à 400m": {A: -4, B: -5, C: -6, D: -8, E: -9, F: -10, G: -11, H: -6, I: -7, J: -16, T: 17}, "400 à 600m": {A: -6, B: -6, C: -7, D: -9, E: -11, F: -11, G: -13, H: -7, I: -8, J: -17, T: 16}, "600 à 800m": {A: -8, B: -7, C: -8, D: -11, E: -13, F: -12, G: -14, H: -9, I: -10, J: -18, T: 14}, "800 à 1000m": {A: -10, B: -8, C: -9, D: -13, E: -15, F: -13, G: -17, H: -10, I: -11, J: -19, T: 13}, "1000 à 1200m": {A: -12, B: -9, C: -10, D: -14, E: -17, F: -14, G: -19, H: -11, I: -12, J: -20, T: 12}, "1200 à 1400m": {A: -14, B: -10, C: -11, D: -15, E: -19, F: -15, G: -21, H: -12, I: -13, J: -21, T: 11}, "1400 à 1600m": {A: -16, B: -10, C: -12, D: -15, E: -21, F: -16, G: -23, H: -13, I: -14, J: -22, T: 9}, "1600 à 1800m": {A: -18, B: -10, C: -13, D: -15, E: -23, F: -17, G: -24, H: -15, I: -16, J: -23, T: 8}, "1800 à 2000m": {A: -20, B: -10, C: -14, D: -15, E: -25, F: -18, G: -25, H: -16, I: -17, J: -24, T: 7}, "2000 à 2200m": {A: -20, B: -10, C: -15, D: -15, E: -27, F: -19, G: -29, H: -17, I: -18, J: -25, T: 6} };

// Températures de base ÉTÉ (°C) par zone × altitude. Base du calcul de froid physique (ΔT été
// réel). Gradient -0,6°C/100m. Zone J alignée sur la zone F (l'est continental connaît les mêmes
// pointes estivales) ; zone T (DOM) à 32°C, la pointe tropicale étant plus basse et surtout plus
// constante qu'une canicule continentale.
export const tBaseEteMatrix = { "0 à 200m": {A: 28, B: 32, C: 28, D: 30, E: 31, F: 33, G: 30, H: 34, I: 34, J: 33, T: 32}, "200 à 400m": {A: 27, B: 31, C: 27, D: 29, E: 30, F: 32, G: 29, H: 33, I: 33, J: 32, T: 31}, "400 à 600m": {A: 26, B: 30, C: 26, D: 28, E: 29, F: 31, G: 28, H: 32, I: 32, J: 31, T: 30}, "600 à 800m": {A: 24, B: 28, C: 24, D: 26, E: 27, F: 29, G: 26, H: 30, I: 30, J: 29, T: 28}, "800 à 1000m": {A: 23, B: 27, C: 23, D: 25, E: 26, F: 28, G: 25, H: 29, I: 29, J: 28, T: 27}, "1000 à 1200m": {A: 22, B: 26, C: 22, D: 24, E: 25, F: 27, G: 24, H: 28, I: 28, J: 27, T: 26}, "1200 à 1400m": {A: 21, B: 25, C: 21, D: 23, E: 24, F: 26, G: 23, H: 27, I: 27, J: 26, T: 25}, "1400 à 1600m": {A: 20, B: 24, C: 20, D: 22, E: 23, F: 25, G: 22, H: 26, I: 26, J: 25, T: 24}, "1600 à 1800m": {A: 18, B: 22, C: 18, D: 20, E: 21, F: 23, G: 20, H: 24, I: 24, J: 23, T: 22}, "1800 à 2000m": {A: 17, B: 21, C: 17, D: 19, E: 20, F: 22, G: 19, H: 23, I: 23, J: 22, T: 21}, "2000 à 2200m": {A: 16, B: 20, C: 16, D: 18, E: 19, F: 21, G: 18, H: 22, I: 22, J: 21, T: 20} };
