// Config Tailwind utilisée pour régénérer assets/tailwind.css (voir README).
// Reflète exactement le `tailwind.config` autrefois injecté en <script> pour le CDN.
module.exports = {
  content: ["../index.html"],
  theme: {
    extend: {
      colors: {
        toshiba: {
          red: '#FF0000',
          dark: '#111111',
          gray: '#F3F4F6'
        }
      }
    }
  }
}
