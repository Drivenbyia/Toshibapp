// Config Tailwind utilisée pour régénérer assets/tailwind.css (voir README).
// Chemins résolus depuis ce fichier (`__dirname`) et non depuis le répertoire courant : Tailwind
// résout `content` relativement au CWD, donc la commande documentée dans le README, lancée à la
// racine, ne trouvait aucune classe et régénérait un CSS vide de tous les utilitaires.
const path = require('path');

module.exports = {
  content: [
    path.join(__dirname, '../index.html'),
    path.join(__dirname, '../js/**/*.js'),
    path.join(__dirname, 'input.css')
  ],
  theme: {
    extend: {
      // --- Typographie ---
      // Deux rôles tirés d'une seule superfamille : `display` porte les titres, les valeurs et
      // les actions (condensée, capitales, caractère marqué) ; `sans` porte tout le reste.
      //
      // Archivo (SIL OFL, variable wght + wdth) est la cible de production : un seul woff2
      // sous-ensemblé couvre les deux rôles, la condensation venant de l'axe `wdth` piloté par
      // `font-stretch` (voir .k-display dans input.css). Tant que le fichier n'est pas déposé
      // dans assets/, la pile de secours donne une vraie condensée sur macOS / iOS — les deux
      // plateformes de terrain — et retombe sur la grotesque système ailleurs.
      fontFamily: {
        sans: ['Archivo', 'Avenir Next', 'Segoe UI', 'system-ui', '-apple-system', 'sans-serif'],
        display: ['Archivo', 'Avenir Next Condensed', 'Avenir Next', 'Segoe UI', 'system-ui', '-apple-system', 'sans-serif']
      },
      // --- Jetons de couleur ---
      // Une seule famille d'accent (teal Klimo), un gris unique pour tout le neutre, et deux
      // couleurs de mesure (froid / chaud) qui ne servent QU'À ça. Tout le reste — succès,
      // avertissement, danger — passe par emerald / amber / rose, jamais par le bleu ou le rouge
      // des puissances : à l'écran, un bloc bleu veut dire « froid », pas « information ».
      //
      // Les neutres portent une légère dérive vers le vert de l'accent plutôt que le bleu de
      // slate : posés à côté du teal ils se lisent comme choisis, pas comme hérités de la
      // palette par défaut. Tous les niveaux de texte tiennent AA sur blanc, y compris ink-400
      // (~4,6:1), ce qui n'était pas le cas de l'ancien #94A3B8 (2,6:1) — or c'est lui qui
      // portait les déclencheurs cliquables.
      colors: {
        canvas: '#DCE4E1',   // fond de page
        ink: {
          900: '#08130F',    // titres
          700: '#33443F',    // texte courant
          600: '#435450',    // texte secondaire
          500: '#556661',    // libellés, méta
          400: '#6E807B'     // désactivé, placeholder — AA sur blanc
        },
        line: {
          DEFAULT: '#B9C6C2', // séparateurs, bordures de cartes — visibles en plein soleil
          strong: '#9CADA8'   // bordures de champs
        },
        // Surfaces neutres internes (champs groupés, pistes de contrôle segmenté). Remplacent
        // les `slate-*` de Tailwind, dont la dérive bleue jurait avec le fond de page.
        mute: {
          50:  '#F2F6F4',
          100: '#E8EFEC',
          200: '#D8E2DE'
        },
        // Teal Klimo : accent de l'outil, indépendant de la marque de matériel sélectionnée.
        // accent-500 sur blanc = ~5,3:1, accent-700 = ~9,7:1 — au-dessus du seuil AA (4,5:1).
        // accent-900 est le fond des bandeaux de section (blanc dessus = ~13:1).
        accent: {
          50:  '#E2F0EC',
          100: '#C3E0D9',
          200: '#8FC7BB',
          300: '#4FA394',
          500: '#0A6E5F',
          600: '#085A4E',
          700: '#06463D',
          900: '#062F28'
        },
        froid: {
          50:  '#E8EEF9',
          100: '#CBD9F0',
          200: '#A8BFE6',
          600: '#12409E',
          700: '#0E3480',
          800: '#0A2760'
        },
        chaud: {
          50:  '#FBEAE8',
          100: '#F5D2CE',
          200: '#EDAFA8',
          600: '#A82615',
          700: '#8A1F11',
          800: '#6D180D'
        }
      },
      // Ombres portées quasi nulles : la structure est portée par des bordures franches, pas par
      // de la profondeur. Une ombre marquée trouble la lecture des bordures en extérieur sans
      // rien ajouter à la hiérarchie.
      boxShadow: {
        card: '0 1px 0 0 rgb(8 19 15 / 0.03)',
        cardHover: '0 1px 2px 0 rgb(8 19 15 / 0.08), 0 4px 10px -4px rgb(8 19 15 / 0.10)',
        seg: '0 1px 1px 0 rgb(8 19 15 / 0.10)',
        pop: '0 12px 32px -8px rgb(8 19 15 / 0.32)',
        bar: '0 -8px 24px -12px rgb(8 19 15 / 0.35)'
      },
      // Registre affirmé : arêtes franches. Une seule famille de rayons, très basse, pour toutes
      // les surfaces et tous les contrôles ; seules les puces de sélection restent circulaires
      // (rounded-full), parce que la forme y porte le sens du bouton radio.
      borderRadius: {
        lg: '0.1875rem',
        xl: '0.25rem',
        '2xl': '0.375rem'
      },
      // Barre d'action collante + hauteur du header : utilisées par scroll-mt et par les
      // décalages sticky, déclarées une fois plutôt que recopiées en valeurs arbitraires.
      spacing: {
        header: '4rem'
      },
      fontSize: {
        // Palier manquant entre text-xs (12) et text-sm (14), utilisé pour la méta dense.
        '2xs': ['0.6875rem', { lineHeight: '1rem' }]
      },
      // Point de bascule deux colonnes. `xl` (1280px) laissait toute tablette en paysage sur la
      // mise en page téléphone : 736px de contenu dans 1194px d'écran, et la saisie à dérouler
      // entièrement avant d'atteindre le matériel. La place existe dès ~1000px.
      screens: {
        duo: '1000px'
      }
    }
  }
}
