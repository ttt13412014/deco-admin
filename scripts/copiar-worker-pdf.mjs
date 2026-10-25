// Copia el worker de pdf.js a /public para que la versión coincida siempre con la librería.
import { copyFileSync, mkdirSync } from 'fs'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const origen = require.resolve('pdfjs-dist/legacy/build/pdf.worker.min.mjs')
mkdirSync('public', { recursive: true })
copyFileSync(origen, 'public/pdf.worker.min.mjs')
console.log('pdf.worker.min.mjs copiado a public/')
