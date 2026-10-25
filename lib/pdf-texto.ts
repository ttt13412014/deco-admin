'use client'

import { armarLineas, leerFactura, type ItemTexto, type LecturaFactura } from './factura-pdf'

/** Archivo del worker de pdf.js (lo copia scripts/copiar-worker-pdf.mjs a /public). */
const WORKER = '/pdf.worker.min.mjs'
/** AFIP repite el comprobante en 3 copias; con las primeras páginas alcanza. */
const MAX_PAGINAS = 6

type PdfJs = typeof import('pdfjs-dist')
let cargado: Promise<PdfJs> | null = null

function pdfjs(): Promise<PdfJs> {
  if (!cargado) {
    cargado = import('pdfjs-dist/legacy/build/pdf.mjs').then((m) => {
      const lib = m as unknown as PdfJs
      lib.GlobalWorkerOptions.workerSrc = WORKER
      return lib
    })
    cargado.catch(() => (cargado = null))
  }
  return cargado
}

/** Texto del PDF, una lista de renglones por página. Todo pasa en el navegador: el PDF no se sube a ningún lado. */
export async function textoDePdf(archivo: File): Promise<string[][]> {
  const lib = await pdfjs()
  const doc = await lib.getDocument({ data: new Uint8Array(await archivo.arrayBuffer()), isEvalSupported: false }).promise
  try {
    const paginas: string[][] = []
    for (let i = 1; i <= Math.min(doc.numPages, MAX_PAGINAS); i++) {
      const tc = await (await doc.getPage(i)).getTextContent()
      paginas.push(armarLineas(tc.items.filter((x) => 'str' in x) as unknown as ItemTexto[]))
    }
    return paginas
  } finally {
    doc.destroy()
  }
}

export interface ArchivoLeido {
  archivo: string
  lectura: LecturaFactura | null
  error: string | null
}

export async function leerFacturaPdf(archivo: File): Promise<ArchivoLeido> {
  if (!/\.pdf$/i.test(archivo.name) && archivo.type !== 'application/pdf') {
    return { archivo: archivo.name, lectura: null, error: 'No es un PDF.' }
  }
  try {
    return { archivo: archivo.name, lectura: leerFactura(await textoDePdf(archivo)), error: null }
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    return {
      archivo: archivo.name,
      lectura: null,
      error: /password/i.test(m) ? 'El PDF tiene contraseña.' : `No pude abrir el PDF (${m}).`,
    }
  }
}
