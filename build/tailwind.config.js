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
      // --- Jetons de couleur ---
      // Une seule famille d'accent (teal Klimo), un gris froid unique pour tout le neutre, et
      // deux couleurs de mesure (froid / chaud) qui ne servent QU'À ça. Tout le reste — succès,
      // avertissement, danger — passe par emerald / amber / rose, jamais par le bleu ou le rouge
      // des puissances : à l'écran, un bloc bleu veut dire « froid », pas « information ».
      colors: {
        canvas: '#F1F5F9',   // fond de page
        ink: {
          900: '#0F172A',    // titres
          700: '#334155',    // texte courant
          600: '#475569',    // texte secondaire
          500: '#64748B',    // libellés, méta
          400: '#94A3B8'     // désactivé, placeholder
        },
        line: {
          DEFAULT: '#E2E8F0', // séparateurs, bordures de cartes
          strong: '#CBD5E1'   // bordures de champs (contraste suffisant en plein soleil)
        },
        // Teal Klimo : accent de l'outil, indépendant de la marque de matériel sélectionnée.
        // accent-700 sur blanc = ~7:1, accent-600 = ~5.4:1 — au-dessus du seuil AA (4.5:1).
        accent: {
          50:  '#F0FDFA',
          100: '#CCFBF1',
          200: '#99F6E4',
          300: '#5EEAD4',
          500: '#0F766E',
          600: '#0D6862',
          700: '#115E59',
          900: '#0A3F3B'
        },
        froid: {
          50:  '#EFF6FF',
          100: '#DBEAFE',
          200: '#BFDBFE',
          600: '#2563EB',
          700: '#1D4ED8',
          800: '#1E3A8A'
        },
        chaud: {
          50:  '#FEF3F2',
          100: '#FEE4E2',
          200: '#FECDCA',
          600: '#DC2626',
          700: '#B42318',
          800: '#912018'
        }
      },
      // Ombres portées très basses : l'app est lue en extérieur, une ombre marquée trouble la
      // lecture des bordures sans rien ajouter à la hiérarchie.
      boxShadow: {
        card: '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.06)',
        cardHover: '0 2px 4px -1px rgb(15 23 42 / 0.06), 0 6px 16px -4px rgb(15 23 42 / 0.10)',
        seg: '0 1px 2px 0 rgb(15 23 42 / 0.08)',
        pop: '0 12px 32px -8px rgb(15 23 42 / 0.24)',
        bar: '0 -8px 24px -12px rgb(15 23 42 / 0.35)'
      },
      borderRadius: {
        xl: '0.75rem',
        '2xl': '1rem'
      },
      // Barre d'action collante + hauteur du header : utilisées par scroll-mt et par les
      // décalages sticky, déclarées une fois plutôt que recopiées en valeurs arbitraires.
      spacing: {
        header: '4rem'
      },
      fontSize: {
        // Palier manquant entre text-xs (12) et text-sm (14), utilisé pour la méta dense.
        '2xs': ['0.6875rem', { lineHeight: '1rem' }]
      }
    }
  }
}
