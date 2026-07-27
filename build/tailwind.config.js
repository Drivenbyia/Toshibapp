// Config Tailwind utilisée pour régénérer assets/tailwind.css (voir README).
// Reflète exactement le `tailwind.config` autrefois injecté en <script> pour le CDN.
module.exports = {
  content: ["../index.html", "../js/**/*.js"],
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
