// Config Tailwind utilisée pour régénérer assets/tailwind.css (voir README).
// Reflète exactement le `tailwind.config` autrefois injecté en <script> pour le CDN.
// Chemins résolus depuis ce fichier (`__dirname`) et non depuis le répertoire courant : Tailwind
// résout `content` relativement au CWD, donc la commande documentée dans le README, lancée à la
// racine, ne trouvait aucune classe et régénérait un CSS vide de tous les utilitaires.
const path = require('path');

module.exports = {
  content: [path.join(__dirname, '../index.html'), path.join(__dirname, '../js/**/*.js')],
  theme: {
    extend: {
      colors: {
        toshiba: {
          red: '#E01A1A',
          dark: '#111111',
          gray: '#F3F4F6'
        }
      }
    }
  }
}
