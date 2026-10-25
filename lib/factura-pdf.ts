/**
 * Lectura de facturas electrónicas argentinas (formato AFIP/ARCA) a partir del
 * texto de un PDF. Todo es código puro (sin navegador) para poder probarlo.
 *
 * Detecta: tipo (Factura / Nota de crédito / Nota de débito / Presupuesto / Anula presupuesto),
 * letra (A/B/C/E/M), número, fecha, CUIT y razón social del RECEPTOR (el cliente,
 * no quien emite) e Importe Total. Las notas de crédito y "anula presupuesto" vuelven
 * con monto negativo. `tipoVenta` es el tipo de comprobante de la app (lib/comprobantes.ts):
 * A y M → A; B, C y E → B.
 */
import { TIPOS_VENTA, tipoVentaAfip, type TipoVenta } from './comprobantes'

export type TipoComprobante = 'factura' | 'nota_credito' | 'nota_debito' | 'presupuesto' | 'anula_presupuesto' | 'desconocido'

/** Lo que se guarda en cada parada de la hoja de ruta (columna `comprobantes`). */
export interface ComprobanteRuta {
  tipo: 'factura' | 'nota_credito' | 'nota_debito' | 'presupuesto' | 'anula_presupuesto'
  /** Tipo de la app (Factura A, Nota de crédito B, Presupuesto…). Las cargas viejas no lo tienen. */
  tipo_venta?: TipoVenta
  letra: string | null
  numero: string | null
  fecha: string | null // AAAA-MM-DD
  cuit: string | null
  razon_social: string | null
  monto: number // con signo: las notas de crédito restan
  archivo: string | null
}

export interface LecturaFactura {
  tipo: TipoComprobante
  letra: string | null
  codigo: number | null
  /** Tipo de comprobante de la app (ver lib/comprobantes.ts). */
  tipoVenta: TipoVenta
  numero: string | null
  fecha: string | null
  razonSocial: string | null
  cuitReceptor: string | null
  /** DNI del cliente (consumidor final), si figura en lugar del CUIT. */
  dniReceptor: string | null
  /** Todos los CUIT válidos que aparecen, en orden (sirve para buscar el cliente). */
  cuits: string[]
  /** Importe total tal como figura (siempre positivo). */
  total: number | null
  /** Monto para la hoja: negativo si es nota de crédito. */
  monto: number | null
  avisos: string[]
}

export const TIPO_LABEL: Record<TipoComprobante, string> = {
  factura: 'Factura',
  nota_credito: 'Nota de crédito',
  nota_debito: 'Nota de débito',
  presupuesto: 'Presupuesto',
  anula_presupuesto: 'Anula presupuesto',
  desconocido: 'Comprobante',
}

export const TIPO_CORTO: Record<ComprobanteRuta['tipo'], string> = {
  factura: 'FC',
  nota_credito: 'NC',
  nota_debito: 'ND',
  presupuesto: 'PRES',
  anula_presupuesto: 'ANULA PRES',
}

/** Restan del total: notas de crédito y anulaciones de presupuesto. */
export const restaTipo = (t: TipoComprobante | ComprobanteRuta['tipo']) => t === 'nota_credito' || t === 'anula_presupuesto'

// ---------------------------------------------------------------------
// Números con formato argentino
// ---------------------------------------------------------------------

/** "1.234.567,89" → 1234567.89 · "$ 1210,00" → 1210 · "(500,00)" → -500 · "1,234.50" → 1234.5 */
export function parsearNumeroAR(s: string | null | undefined): number | null {
  if (s == null) return null
  let t = String(s).trim()
  if (!t) return null
  let neg = false
  if (/^\(.*\)$/.test(t)) {
    neg = true
    t = t.slice(1, -1)
  }
  t = t.replace(/\$|ARS|\s/gi, '')
  if (t.startsWith('-')) {
    neg = !neg
    t = t.slice(1)
  } else if (t.endsWith('-')) {
    neg = !neg
    t = t.slice(0, -1)
  }
  if (!/^\d[\d.,]*$/.test(t)) return null
  const ultComa = t.lastIndexOf(',')
  const ultPunto = t.lastIndexOf('.')
  let n: number
  if (ultComa >= 0 && ultPunto >= 0) {
    // El separador que aparece último es el decimal
    n = ultComa > ultPunto ? Number(t.replace(/\./g, '').replace(',', '.')) : Number(t.replace(/,/g, ''))
  } else if (ultComa >= 0) {
    // En Argentina la coma es decimal ("1210,5"); "1,234,567" sería de miles
    n = /^\d{1,3}(,\d{3}){2,}$/.test(t) ? Number(t.replace(/,/g, '')) : Number(t.replace(/,/g, (m, i) => (i === ultComa ? '.' : '')))
  } else if (ultPunto >= 0) {
    // "1.234.567" o "12.345" son miles; "1234.56" es decimal
    n = /^\d{1,3}(\.\d{3})+$/.test(t) ? Number(t.replace(/\./g, '')) : Number(t)
  } else n = Number(t)
  if (!isFinite(n)) return null
  return Math.round((neg ? -n : n) * 100) / 100
}

// Un importe dentro de un texto: con separadores AR (1.234,56), sin miles (1234,56) o US (1,234.56)
const RE_IMPORTE = /\(?-?\$?\s*-?(?:\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d{1,3}(?:,\d{3})+\.\d{1,2}|\d+(?:[.,]\d{1,2})?)\)?(?![\d])/g

function importesEn(s: string): number[] {
  const out: number[] = []
  for (const m of s.match(RE_IMPORTE) ?? []) {
    // Tiras largas de dígitos sin separadores (código de barras, CAE) no son importes
    if (/^\D*\d{12,}\D*$/.test(m)) continue
    const n = parsearNumeroAR(m)
    if (n != null) out.push(n)
  }
  return out
}

// ---------------------------------------------------------------------
// Texto del PDF → líneas
// ---------------------------------------------------------------------

export interface ItemTexto {
  str: string
  transform: number[] // [a, b, c, d, x, y]
  width: number
  height: number
}

/**
 * Agrupa los pedacitos de texto que devuelve pdf.js en renglones (misma altura),
 * de izquierda a derecha. Los huecos grandes se marcan con 3 espacios, que sirven
 * para separar columnas ("CUIT: 30...   Apellido y Nombre / Razón Social: ...").
 */
export function armarLineas(items: ItemTexto[]): string[] {
  const vis = items.filter((it) => it.str && it.str.trim() !== '')
  type Fila = { y: number; h: number; its: ItemTexto[] }
  const filas: Fila[] = []
  for (const it of vis) {
    const y = it.transform[5]
    const h = Math.abs(it.height || it.transform[3] || 10)
    const f = filas.find((r) => Math.abs(r.y - y) <= Math.max(2, Math.min(r.h, h) * 0.45))
    if (f) f.its.push(it)
    else filas.push({ y, h, its: [it] })
  }
  filas.sort((a, b) => b.y - a.y)
  return filas.map((f) => {
    const its = f.its.sort((a, b) => a.transform[4] - b.transform[4])
    let s = ''
    let fin: number | null = null
    for (const it of its) {
      const x = it.transform[4]
      if (fin != null) {
        const gap = x - fin
        const em = Math.abs(it.height || it.transform[3] || 10)
        if (gap > em * 1.5) s += '   '
        else if (gap > em * 0.15 && !s.endsWith(' ') && !it.str.startsWith(' ')) s += ' '
      }
      s += it.str
      fin = x + (it.width || 0)
    }
    return s.replace(/\s+$/, '')
  })
}

// ---------------------------------------------------------------------
// Utilidades de texto
// ---------------------------------------------------------------------

const sinAcentos = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')

/** Etiquetas que cortan un valor cuando vienen en el mismo renglón. */
const RE_CORTE =
  /\s{3,}|\s+(?:CUIT|C\.U\.I\.T\.?|DNI|Doc(?:umento)?\.?\s*(?:Tipo|Nro)|Condici[oó]n\s+(?:frente\s+al\s+IVA|de\s+venta|IVA)|Cond\.\s*IVA|IVA\s*:|Domicilio|Direcci[oó]n|Localidad|Fecha|Ingresos\s+Brutos|Tel[eé]fono|Tel\.|Punto\s+de\s+Venta|Comp\.?\s*Nro)\b/i

function cortarValor(v: string): string {
  const t = v.replace(/^[\s:.\-–]+/, '')
  const m = t.match(RE_CORTE)
  return (m ? t.slice(0, m.index) : t).trim().replace(/[\s,;:\-–]+$/, '')
}

/** Valor que sigue a una etiqueta; si el renglón termina en la etiqueta, mira el siguiente. */
function valorEtiqueta(lineas: string[], re: RegExp, desde = 0): { valor: string; linea: number } | null {
  for (let i = desde; i < lineas.length; i++) {
    const m = lineas[i].match(re)
    if (!m || m.index == null) continue
    let v = cortarValor(lineas[i].slice(m.index + m[0].length))
    if (!v && i + 1 < lineas.length) v = cortarValor(lineas[i + 1].split(/\s{3,}/)[0])
    if (v) return { valor: v, linea: i }
  }
  return null
}

// ---------------------------------------------------------------------
// CUIT
// ---------------------------------------------------------------------

export function cuitValido(c: string): boolean {
  const d = c.replace(/\D/g, '')
  if (d.length !== 11 || !/^(20|23|24|25|26|27|30|33|34)/.test(d)) return false
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  const suma = pesos.reduce((a, p, i) => a + p * Number(d[i]), 0)
  let dv = 11 - (suma % 11)
  if (dv === 11) dv = 0
  if (dv === 10) dv = 9 // casos especiales (23/24): se acepta igual
  return dv === Number(d[10]) || d.startsWith('23') || d.startsWith('24')
}

function cuitsEn(s: string): string[] {
  const out: string[] = []
  // (sin lookbehind, para que ande en Safari viejos)
  for (const m of s.matchAll(/(?:^|\D)(\d{2})[-\s.]?(\d{8})[-\s.]?(\d)(?!\d)/g)) {
    const c = m[1] + m[2] + m[3]
    if (cuitValido(c) && !out.includes(c)) out.push(c)
  }
  return out
}

// ---------------------------------------------------------------------
// Tipo de comprobante
// ---------------------------------------------------------------------

/** Códigos AFIP de tipo de comprobante (incluye Factura de Crédito Electrónica MiPyME). */
const CODIGOS: Record<number, { tipo: TipoComprobante; letra: string }> = {
  1: { tipo: 'factura', letra: 'A' }, 2: { tipo: 'nota_debito', letra: 'A' }, 3: { tipo: 'nota_credito', letra: 'A' },
  6: { tipo: 'factura', letra: 'B' }, 7: { tipo: 'nota_debito', letra: 'B' }, 8: { tipo: 'nota_credito', letra: 'B' },
  11: { tipo: 'factura', letra: 'C' }, 12: { tipo: 'nota_debito', letra: 'C' }, 13: { tipo: 'nota_credito', letra: 'C' },
  19: { tipo: 'factura', letra: 'E' }, 20: { tipo: 'nota_debito', letra: 'E' }, 21: { tipo: 'nota_credito', letra: 'E' },
  51: { tipo: 'factura', letra: 'M' }, 52: { tipo: 'nota_debito', letra: 'M' }, 53: { tipo: 'nota_credito', letra: 'M' },
  201: { tipo: 'factura', letra: 'A' }, 202: { tipo: 'nota_debito', letra: 'A' }, 203: { tipo: 'nota_credito', letra: 'A' },
  206: { tipo: 'factura', letra: 'B' }, 207: { tipo: 'nota_debito', letra: 'B' }, 208: { tipo: 'nota_credito', letra: 'B' },
  211: { tipo: 'factura', letra: 'C' }, 212: { tipo: 'nota_debito', letra: 'C' }, 213: { tipo: 'nota_credito', letra: 'C' },
}

function detectarTipo(lineas: string[]): { tipo: TipoComprobante; letra: string | null; codigo: number | null } {
  const T = sinAcentos(lineas.join('\n')).toUpperCase()
  let codigo: number | null = null
  const mc = T.match(/\bCOD(?:IGO)?\.?\s*(?:N[°ºO]?\.?\s*)?:?\s*0*(\d{1,3})\b/)
  if (mc && CODIGOS[Number(mc[1])]) codigo = Number(mc[1])

  let tipo: TipoComprobante = codigo ? CODIGOS[codigo].tipo : 'desconocido'
  let letra: string | null = codigo ? CODIGOS[codigo].letra : null

  if (!codigo) {
    // Ojo: "Factura de Crédito Electrónica" es una FACTURA, no una nota de crédito
    if (/\bANULA(?:CION)?\s+(?:DE(?:L)?\s+)?PRESUPUESTO\b/.test(T)) tipo = 'anula_presupuesto'
    else if (/NOTA\s+DE\s+CREDITO/.test(T)) tipo = 'nota_credito'
    else if (/NOTA\s+DE\s+DEBITO/.test(T)) tipo = 'nota_debito'
    else if (/\bPRESUPUESTO\b/.test(T) || /NO\s+VALIDO\s+COMO\s+FACTURA/.test(T)) tipo = 'presupuesto'
    else if (/\bFACTURA\b/.test(T)) tipo = 'factura'
  }
  // Un comprobante sin CAE que dice "presupuesto" se ignora aunque mencione "factura"
  if (tipo !== 'presupuesto' && tipo !== 'anula_presupuesto' && /\bPRESUPUESTO\b/.test(T) && !/\bCAE\b/.test(T) && !codigo) tipo = 'presupuesto'

  if (!letra) {
    const ml =
      T.match(/(?:FACTURA|NOTA\s+DE\s+(?:CREDITO|DEBITO))\s*(?:ELECTRONICA\s*)?(?:TIPO\s*)?["“]?([ABCEM])["”]?(?![A-Z])/) ??
      T.match(/^\s*([ABCEM])\s*$/m)
    if (ml) letra = ml[1]
  }
  return { tipo, letra, codigo }
}

// ---------------------------------------------------------------------
// Lectura completa
// ---------------------------------------------------------------------

/** Se queda solo con la copia ORIGINAL (AFIP repite el comprobante en DUPLICADO y TRIPLICADO). */
export function paginasOriginal(paginas: string[][]): string[][] {
  if (paginas.length <= 1) return paginas
  const i = paginas.findIndex((p, k) => k > 0 && p.some((l) => /^\s*(DUPLICADO|TRIPLICADO|CUADRUPLICADO)\b/i.test(l) || /\b(DUPLICADO|TRIPLICADO)\s*$/i.test(l)))
  return i > 0 ? paginas.slice(0, i) : paginas
}

const RE_RECEPTOR = [
  /Apellido\s+y\s+Nombre\s*\/\s*Raz[oó]n\s+Social\s*:?/i,
  /Raz[oó]n\s+Social\s*\/\s*Apellido\s+y\s+Nombre\s*:?/i,
  /(?:Raz[oó]n\s+Social|Nombre)\s+(?:del\s+)?(?:cliente|receptor|comprador)\s*:?/i,
  /(?:^|\s)(?:Se[ñn]or(?:\/?\(?es\)?)?|Sr(?:\/?\(?es\)?|es)?\.?|Cliente)\s*:/i,
]

const RE_TOTAL = [
  /Importe\s+Total\s*(?:\$|ARS)?\s*:?/i,
  /Total\s+(?:a\s+pagar|general|del\s+comprobante|comprobante|factura|final)\s*(?:\$|ARS)?\s*:?/i,
  /\bTOTAL\s*(?:\$|ARS)?\s*:?(?!\s*(?:neto|iva|gravado|exento|bultos|items|unidades|percep|tributos|otros))/i,
  // Presupuestos propios: "T O T A L" con letras separadas y el importe en el renglón de abajo
  /\bT\s+O\s+T\s+A\s+L\b\s*(?:\$|ARS)?\s*:?/i,
]

function buscarTotal(lineas: string[]): number | null {
  for (const re of RE_TOTAL) {
    const candidatos: number[] = []
    for (let i = 0; i < lineas.length; i++) {
      const l = lineas[i]
      if (/sub\s*-?\s*total/i.test(l) && !/importe\s+total/i.test(l) && re !== RE_TOTAL[0]) {
        // "Subtotal: ...   Total: ..." en el mismo renglón: miramos solo lo que sigue a "Total"
        const m2 = l.slice(l.search(/sub\s*-?\s*total/i) + 3).match(re)
        if (!m2) continue
      }
      const m = l.match(re)
      if (!m || m.index == null) continue
      if (/sub$/i.test(l.slice(Math.max(0, m.index - 3), m.index).trim())) continue
      let ns = importesEn(l.slice(m.index + m[0].length))
      if (!ns.length) {
        // Encabezado en columnas ("Neto   IVA 21%   ...   TOTAL") y los valores abajo:
        // tomamos el valor de la misma columna que la etiqueta
        const cols = l.split(/\s{3,}/)
        const col = cols.findIndex((c) => re.test(c))
        for (const j of [i + 1, i + 2, i + 3]) {
          if (j >= lineas.length) continue
          if (/^[\s$\d.,()-]+$/.test(lineas[j])) {
            const vals = lineas[j].trim().split(/\s{3,}/)
            if (cols.length > 1 && col >= 0 && vals.length === cols.length) {
              ns = importesEn(vals[col])
              if (ns.length) break
            }
            ns = importesEn(lineas[j])
            if (ns.length) break
          }
          // "DOCUMENTO NO VALIDO COMO FACTURA   6260.00": el importe es la última columna del renglón
          const ult = lineas[j].split(/\s{3,}/).pop() ?? ''
          if (/^\s*\$?\s*[\d.,()-]+\s*$/.test(ult) && /\d/.test(ult)) {
            ns = importesEn(ult)
            if (ns.length) break
          }
        }
      }
      if (ns.length) {
        candidatos.push(Math.abs(ns[0]))
        if (re === RE_TOTAL[0]) return candidatos[0] // "Importe Total" es inequívoco: el primero
      }
    }
    // Con etiquetas genéricas ("Total"), el mayor suele ser el total del comprobante
    if (candidatos.length) return Math.max(...candidatos)
  }
  return null
}

/** Subtotal o neto gravado (para controlar que el total leído tenga sentido). */
function buscarSubtotal(lineas: string[]): number | null {
  const re = /\b(?:Sub\s*-?\s*total|Importe\s+Neto\s+Gravado|Neto\s+Gravado)\s*(?:\$|ARS)?\s*:?/i
  for (const l of lineas) {
    const m = l.match(re)
    if (!m || m.index == null) continue
    const ns = importesEn(l.slice(m.index + m[0].length).split(/\s{3,}(?=\D)/)[0])
    if (ns.length && ns[0] > 0) return Math.abs(ns[0])
  }
  return null
}

function fechaISO(d: string, m: string, a: string): string | null {
  const dd = Number(d)
  const mm = Number(m)
  let aa = Number(a)
  if (aa < 100) aa += 2000
  if (!(dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12 && aa >= 2000 && aa <= 2100)) return null
  return `${aa}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
}

function limpiarNombre(s: string): string {
  return s
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s"'“”]+|[\s"'“”,;:-]+$/g, '')
    .trim()
}

export function leerFactura(paginas: string[][]): LecturaFactura {
  const avisos: string[] = []
  const lineas = paginasOriginal(paginas).flat().map((l) => l.replace(/\u00a0/g, ' '))
  const texto = lineas.join('\n')

  const { tipo, letra, codigo } = detectarTipo(lineas)

  // Número: "Punto de Venta: 00003   Comp. Nro: 00001234"
  let numero: string | null = null
  const mn =
    texto.match(/Punto\s+de\s+Venta\s*:?\s*(\d{1,5})\s*(?:-|\s{1,}|\n)\s*Comp(?:robante)?\.?\s*N(?:ro|°|º|o)?\.?\s*:?\s*(\d{1,8})/i) ??
    texto.match(/(?:N[°º]|Nro\.?|N[uú]mero|Comp(?:robante)?\.?\s*N(?:ro|°|º)\.?)\s*:?\s*(\d{4,5})\s*-\s*(\d{6,8})\b/i) ??
    texto.match(/(?:^|[^\d-])(\d{4,5})-(\d{8})(?![\d-])/)
  if (mn) numero = `${mn[1].padStart(5, '0')}-${mn[2].padStart(8, '0')}`
  else {
    // Presupuestos propios: "NUMERO   22443"
    const mp = texto.match(/(?:^|\n|\s{2})\s*N(?:[UÚ]MERO|RO\.?|[°º])\s*:?\s*(\d{1,8})(?!\d|[/.-]\d)/i)
    if (mp) numero = mp[1]
  }

  // Fecha de emisión
  let fecha: string | null = null
  const mf =
    texto.match(/Fecha\s+(?:de\s+)?Emisi[oó]n\s*:?\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/i) ??
    texto.match(/(?:^|[\n:]|\s{2})\s*Fecha\s*:?\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/i) ??
    texto.match(/(?:^|[^\d/])(\d{1,2})\/(\d{1,2})\/(\d{4})(?![\d/])/)
  if (mf) fecha = fechaISO(mf[1], mf[2], mf[3])

  // Receptor
  let razonSocial: string | null = null
  let lineaReceptor = -1
  for (const re of RE_RECEPTOR) {
    const v = valorEtiqueta(lineas, re)
    if (v && v.valor.length > 1 && !/^\d+$/.test(v.valor)) {
      razonSocial = limpiarNombre(v.valor)
      lineaReceptor = v.linea
      break
    }
  }
  if (!razonSocial) {
    // Formato genérico con dos "Razón Social:": la primera es del emisor y la segunda del cliente
    const idx: number[] = []
    lineas.forEach((l, i) => /Raz[oó]n\s+Social\s*:/i.test(l) && idx.push(i))
    if (idx.length >= 2) {
      const v = valorEtiqueta(lineas, /Raz[oó]n\s+Social\s*:/i, idx[1])
      if (v) {
        razonSocial = limpiarNombre(v.valor)
        lineaReceptor = v.linea
      }
    }
  }

  const cuits = cuitsEn(texto)
  let cuitReceptor: string | null = null
  if (lineaReceptor >= 0) {
    // Buscar el CUIT en el renglón del cliente o en los vecinos
    for (const j of [lineaReceptor, lineaReceptor - 1, lineaReceptor + 1, lineaReceptor - 2, lineaReceptor + 2]) {
      if (j < 0 || j >= lineas.length) continue
      const c = cuitsEn(lineas[j])
      if (c.length) {
        cuitReceptor = c[c.length - 1]
        break
      }
    }
    // Si el único CUIT cerca es el primero del documento, seguramente es del emisor
    if (cuitReceptor && cuits.length > 1 && cuitReceptor === cuits[0] && lineaReceptor > 0) {
      const primero = lineas.findIndex((l) => cuitsEn(l).includes(cuits[0]))
      if (primero >= 0 && primero < lineaReceptor - 2) cuitReceptor = cuits[1]
    }
  }
  if (!cuitReceptor && cuits.length >= 2) cuitReceptor = cuits[1]
  let dniReceptor: string | null = null
  if (lineaReceptor >= 0) {
    const md = [lineaReceptor, lineaReceptor - 1, lineaReceptor + 1]
      .map((j) => lineas[j] ?? '')
      .join('\n')
      .match(/\bD\.?N\.?I\.?\s*(?:N[°ºro.]*)?\s*:?\s*(\d{1,2}\.?\d{3}\.?\d{3})\b/i)
    if (md) dniReceptor = md[1].replace(/\D/g, '')
  }

  const total = buscarTotal(lineas)
  let monto: number | null = null
  if (total != null) monto = restaTipo(tipo) ? -Math.abs(total) : Math.abs(total)
  const tipoVenta = tipoVentaAfip(tipo, letra)

  if (tipo === 'desconocido') avisos.push('No reconocí el tipo de comprobante: revisá si es factura o nota de crédito.')
  if (total == null) avisos.push('No encontré el importe total.')
  if (!razonSocial) avisos.push('No encontré el nombre del cliente.')
  if (total != null) {
    const ref = buscarSubtotal(lineas)
    if (Math.abs(total) >= 100_000_000) avisos.push('El importe leído es muy grande: revisá que sea el TOTAL de la factura.')
    else if (ref != null && ref > 0 && (Math.abs(total) < ref * 0.99 || Math.abs(total) > ref * 1.6))
      avisos.push(`El total leído no cierra con el subtotal/neto (${ref.toLocaleString('es-AR', { minimumFractionDigits: 2 })}): revisá el importe.`)
  }
  if (!lineas.some((l) => l.trim())) avisos.splice(0, avisos.length, 'El PDF no tiene texto (¿es una foto o un escaneo?). Cargá el monto a mano.')

  return { tipo, letra, codigo, tipoVenta, numero, fecha, razonSocial, cuitReceptor, dniReceptor, cuits, total, monto, avisos }
}

/** Convierte la lectura en lo que se guarda en la parada (null si no hay monto). Presupuestos suman; NC y anula presupuesto restan. */
export function comprobanteDesdeLectura(l: LecturaFactura, archivo: string | null, monto = l.monto): ComprobanteRuta | null {
  if (monto == null) return null
  const tipo: ComprobanteRuta['tipo'] = l.tipo === 'desconocido' ? 'factura' : l.tipo
  const tv = l.tipoVenta ?? tipoVentaAfip(tipo, l.letra)
  return {
    tipo,
    tipo_venta: tv,
    letra: l.letra,
    numero: l.numero,
    fecha: l.fecha,
    cuit: l.cuitReceptor ?? l.dniReceptor,
    razon_social: l.razonSocial,
    monto: restaTipo(tipo) ? -Math.abs(monto) : Math.abs(monto),
    archivo,
  }
}

export function etiquetaComprobante(c: Pick<ComprobanteRuta, 'tipo' | 'letra' | 'numero'> & { tipo_venta?: TipoVenta }): string {
  if (c.tipo_venta && TIPOS_VENTA[c.tipo_venta]) return [TIPOS_VENTA[c.tipo_venta].corto, c.numero].filter(Boolean).join(' ')
  const sinLetra = c.tipo === 'presupuesto' || c.tipo === 'anula_presupuesto'
  return [TIPO_CORTO[c.tipo] ?? 'FC', sinLetra ? null : c.letra, c.numero].filter(Boolean).join(' ')
}

export const sumaComprobantes = (cs: ComprobanteRuta[]) => Math.round(cs.reduce((a, c) => a + (Number(c.monto) || 0), 0) * 100) / 100
