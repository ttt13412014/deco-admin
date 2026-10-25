/**
 * Pruebas del lector de facturas PDF.  Correr con:  npm run test:facturas
 * 1) Casos de texto (renglones como los arma pdf.js).
 * 2) PDFs de prueba en scripts/facturas-prueba/ (generados con generar-facturas-prueba.py),
 *    leídos con pdf.js igual que en el navegador.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { armarLineas, comprobanteDesdeLectura, leerFactura, parsearNumeroAR, type ItemTexto, type LecturaFactura } from '../lib/factura-pdf'

let fallas = 0
let ok = 0
function igual(nombre: string, real: unknown, esperado: unknown) {
  if (JSON.stringify(real) === JSON.stringify(esperado)) ok++
  else {
    fallas++
    console.error(`✗ ${nombre}: esperaba ${JSON.stringify(esperado)} y vino ${JSON.stringify(real)}`)
  }
}
function revisar(nombre: string, l: LecturaFactura, e: Partial<LecturaFactura>) {
  for (const [k, v] of Object.entries(e)) igual(`${nombre} · ${k}`, (l as unknown as Record<string, unknown>)[k], v)
}

// ---------- Números ----------
igual('1.234.567,89', parsearNumeroAR('1.234.567,89'), 1234567.89)
igual('$ 1210,00', parsearNumeroAR('$ 1210,00'), 1210)
igual('12.345', parsearNumeroAR('12.345'), 12345)
igual('1234.56', parsearNumeroAR('1234.56'), 1234.56)
igual('1,234.50', parsearNumeroAR('1,234.50'), 1234.5)
igual('(500,00)', parsearNumeroAR('(500,00)'), -500)
igual('-12.100,00', parsearNumeroAR('-12.100,00'), -12100)
igual('0,5', parsearNumeroAR('0,5'), 0.5)
igual('texto', parsearNumeroAR('abc'), null)

// ---------- Texto ----------
const afipTexto = [
  'ORIGINAL',
  'DISTRIBUIDORA DE&CO   A   FACTURA',
  'COD. 01',
  'Razón Social: DE&CO S.A.   Punto de Venta: 00003   Comp. Nro: 00001234',
  'Fecha de Emisión: 21/10/2026',
  'Domicilio Comercial: Av. Colón 1234 - Córdoba   CUIT: 30714567892',
  'Condición frente al IVA: IVA Responsable Inscripto   Ingresos Brutos: 280123456',
  'Fecha de Inicio de Actividades: 01/03/2015',
  'CUIT: 30712345671   Apellido y Nombre / Razón Social: METALÚRGICA NORTE S.R.L.',
  'Condición frente al IVA: IVA Responsable Inscripto   Domicilio: Ruta 9 Km 5 - Córdoba',
  'Importe Neto Gravado: $   1000,00',
  'IVA 21%: $   210,00',
  'Importe Total: $   1210,00',
  'CAE N°: 76423456789012',
]
revisar('AFIP texto', leerFactura([afipTexto]), {
  tipo: 'factura', letra: 'A', numero: '00003-00001234', fecha: '2026-10-21',
  razonSocial: 'METALÚRGICA NORTE S.R.L.', cuitReceptor: '30712345671', total: 1210, monto: 1210,
})

const ncTexto = afipTexto.map((l) => l.replace('FACTURA', 'NOTA DE CRÉDITO').replace('COD. 01', 'COD. 03'))
revisar('NC texto', leerFactura([ncTexto]), { tipo: 'nota_credito', letra: 'A', total: 1210, monto: -1210 })

revisar('Sin código, NC escrita', leerFactura([['NOTA DE CREDITO B', 'Nº 0002-00000099', 'Cliente: JUAN PEREZ', 'TOTAL: $ 5.000,00']]), {
  tipo: 'nota_credito', letra: 'B', numero: '00002-00000099', razonSocial: 'JUAN PEREZ', monto: -5000,
})

revisar('FCE no es nota de crédito', leerFactura([['FACTURA DE CRÉDITO ELECTRÓNICA MiPyMEs (FCE)', 'Importe Total: $ 3025000,00']]), {
  tipo: 'factura', monto: 3025000,
})

revisar('Subtotal y Total en el mismo renglón', leerFactura([['FACTURA A', 'Cliente: FERRETERIA LOS ANDES SRL', 'Subtotal: 10.203,03   IVA 21%: 2.142,64   TOTAL: 12.345,67']]), {
  total: 12345.67, razonSocial: 'FERRETERIA LOS ANDES SRL',
})

revisar('Presupuesto', leerFactura([['PRESUPUESTO', 'Señor(es): TORNILLERIA EL TORNILLO', 'TOTAL $ 48.400,00', 'Documento no válido como factura']]), {
  tipo: 'presupuesto', monto: 48400,
})

revisar('Anula presupuesto', leerFactura([['ANULA PRESUPUESTO', 'NUMERO   22450', 'FECHA   29/04/2026', 'Señor/es:   CLIENTE DEMO   Zona:', 'T O T A L', 'DOCUMENTO NO VALIDO COMO FACTURA   1260.00']]), {
  tipo: 'anula_presupuesto', tipoVenta: 'anula_presupuesto', numero: '22450', razonSocial: 'CLIENTE DEMO', total: 1260, monto: -1260,
})
for (const [cod, tipo, tv, signo] of [
  ['01', 'factura', 'factura_a', 1], ['02', 'nota_debito', 'nota_debito_a', 1], ['03', 'nota_credito', 'nota_credito_a', -1],
  ['06', 'factura', 'factura_b', 1], ['07', 'nota_debito', 'nota_debito_b', 1], ['08', 'nota_credito', 'nota_credito_b', -1],
] as const) {
  revisar(`AFIP COD. ${cod}`, leerFactura([afipTexto.map((l) => (l === 'COD. 01' ? `COD. ${cod}` : l))]), { tipo, tipoVenta: tv, monto: 1210 * signo })
}

revisar('Vacío', leerFactura([[]]), { total: null, avisos: ['El PDF no tiene texto (¿es una foto o un escaneo?). Cargá el monto a mano.'] })

// Copias: solo se lee la ORIGINAL aunque el total de las otras sea distinto
revisar('Copias', leerFactura([afipTexto, afipTexto.map((l) => (l === 'ORIGINAL' ? 'DUPLICADO' : l.replace('1210,00', '9999,00')))]), { total: 1210 })

// Armado de renglones a partir de items sueltos de pdf.js
const it = (str: string, x: number, y: number, w = str.length * 5): ItemTexto => ({ str, transform: [9, 0, 0, 9, x, y], width: w, height: 9 })
igual(
  'armarLineas',
  armarLineas([it('Importe Total:', 300, 100), it('Fecha:', 40, 700), it('$', 400, 100.5), it('1210,00', 500, 99.8), it('21/10/2026', 72, 700)]),
  ['Fecha: 21/10/2026', 'Importe Total:   $   1210,00'],
)

// ---------- Formato con pie en columnas (datos inventados) ----------
// Pie en columnas con el código de barras metido entre el encabezado y los valores
{
  const l = leerFactura([[
    'FACTURA', 'A', 'COD. Nº 1', 'N° 0003   - 00006524', 'Fecha: 22/10/2026',
    'Señor(es): COMERCIO DEMO SRL', 'IVA:   RESP.INSCRIPTO   CUIT: 30712345671',
    'Cantidad   Descripción   P. Unit.   Dto. Total',
    '240   BANDEJA TAPA BISAGRA   304,60   0.0073104,00',
    'Neto   IVA 21%   IVA 10,5%   Exento   TOTAL',
    '307145678922026102200003864388960950602026110192',
    '200984,96   42206,84   0   0   243191,8',
  ]])
  igual('Pie en columnas con código de barras · total', l.total, 243191.8)
}

async function pdfs() {
  // import() dinámico real (pdf.js es un módulo ESM)
  const pdfjs = await (new Function('s', 'return import(s)') as (s: string) => Promise<typeof import('pdfjs-dist')>)('pdfjs-dist/legacy/build/pdf.mjs')
  const dir = join(__dirname, '..', '..', 'scripts', 'facturas-prueba')
  async function leer(nombre: string) {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(join(dir, nombre))), isEvalSupported: false, useSystemFonts: false, verbosity: 0 }).promise
    const paginas: string[][] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const tc = await (await doc.getPage(i)).getTextContent()
      paginas.push(armarLineas(tc.items.filter((x) => 'str' in x) as unknown as ItemTexto[]))
    }
    if (process.env.VER) console.log(nombre, paginas[0])
    return leerFactura(paginas)
  }
  revisar('PDF factura A (3 copias)', await leer('factura-a-3-copias.pdf'), {
    tipo: 'factura', letra: 'A', codigo: 1, numero: '00003-00001234', fecha: '2026-10-21',
    razonSocial: 'METALURGICA NORTE S.R.L.', cuitReceptor: '30712345671', total: 1529440, monto: 1529440,
  })
  revisar('PDF nota de crédito A', await leer('nota-credito-a.pdf'), {
    tipo: 'nota_credito', letra: 'A', numero: '00003-00000057', fecha: '2026-10-22', razonSocial: 'METALURGICA NORTE S.R.L.', total: 12100, monto: -12100,
  })
  revisar('PDF factura B consumidor final', await leer('factura-b-consumidor-final.pdf'), {
    tipo: 'factura', letra: 'B', numero: '00005-00098765', razonSocial: 'PEREZ JUAN CARLOS', cuitReceptor: null, dniReceptor: '28123456', total: 12505, monto: 12505,
  })
  revisar('PDF FCE MiPyME', await leer('fce-mipyme.pdf'), { tipo: 'factura', letra: 'A', codigo: 201, razonSocial: 'AGRO PAMPA S.A.', cuitReceptor: '30500010912', monto: 3025000 })
  revisar('PDF presupuesto', await leer('presupuesto.pdf'), { tipo: 'presupuesto', razonSocial: 'TORNILLERIA EL TORNILLO' })
  revisar('PDF formato sistema', await leer('factura-sistema.pdf'), {
    tipo: 'factura', letra: 'A', numero: '00004-00000321', fecha: '2026-10-19', razonSocial: 'FERRETERIA LOS ANDES SRL', cuitReceptor: '30500010912', total: 12345.67,
  })
  revisar('PDF escaneado', await leer('escaneada.pdf'), { total: null, razonSocial: null })
}

pdfs()
  .catch((e) => {
    fallas++
    console.error(e)
  })
  .finally(() => {
    console.log(`${ok} ok · ${fallas} fallas`)
    process.exit(fallas ? 1 : 0)
  })
