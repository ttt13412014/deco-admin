import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef6f6', 100: '#d5e9e9', 200: '#aed4d4', 300: '#7db7b8', 400: '#4f9597',
          500: '#357a7c', 600: '#2a6366', 700: '#245153', 800: '#1f4345', 900: '#1b393b', 950: '#0d2123',
        },
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
export default config
