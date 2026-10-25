// Lectura de Excel/CSV (Sintesys y otros) con detección de columnas y búsqueda de clientes parecidos.
import { normTxt, parseFechaExtracto, parseImporte } from './tesoreria'

export interface Campo {
  k: string
  label: string
  claves: RegExp
  requerido?: boolean
  ayuda?: string
}

export type Fila = Record<string, unknown> & { _fila: number }

export async function leerPlanilla(file: File): Promise<unknown[][]> {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(await file.arrayBuffer(), { cellDates: false })
  // La primera hoja con datos
  for (const n of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[n], { header: 1, defval: '', raw: true, blankrows: false })
    if (rows.length > 1) return rows
  }
  return []
}

/** La fila de títulos: la primera (de las 25 primeras) que tenga más coincidencias con los campos. */
export function detectarCabecera(rows: unknown[][], campos: Campo[]): number {
  let mejor = 0
  let puntos = -1
  rows.slice(0, 25).forEach((r, i) => {
    const p = r.filter((c) => {
      const t = normTxt(String(c))
      return t && campos.some((x) => x.claves.test(t))
    }).length
    if (p > puntos) (puntos = p), (mejor = i)
  })
  return mejor
}

export function detectarColumnas(cab: unknown[], campos: Campo[]): Record<string, number | undefined> {
  const m: Record<string, number | undefined> = {}
  const usadas = new Set<number>()
  for (const c of campos) {
    cab.forEach((h, i) => {
      if (m[c.k] !== undefined || usadas.has(i)) return
      const t = normTxt(String(h))
      if (t && c.claves.test(t)) {
        m[c.k] = i
        usadas.add(i)
      }
    })
  }
  return m
}

export function extraerFilas(rows: unknown[][], cab: number, map: Record<string, number | undefined>): Fila[] {
  const out: Fila[] = []
  rows.slice(cab + 1).forEach((r, i) => {
    if (!r.some((c) => String(c ?? '').trim() !== '')) return
    const f: Fila = { _fila: cab + i + 2 }
    for (const [k, idx] of Object.entries(map)) if (idx !== undefined) f[k] = r[idx]
    out.push(f)
  })
  return out
}

export const txt = (v: unknown) => String(v ?? '').trim()
export const num = (v: unknown) => parseImporte(v)
export const fecha = (v: unknown) => parseFechaExtracto(v)
export const soloDig = (v: unknown) => String(v ?? '').replace(/\D/g, '')

const SUFIJOS = /\b(s\s*\.?\s*a\s*\.?\s*i?\s*c?\s*\.?|s\s*\.?\s*r\s*\.?\s*l\s*\.?|s\s*\.?\s*a\s*\.?\s*s\s*\.?|srl|sa|sas|saic|sh|soc(iedad)?|anonima|de responsabilidad limitada|y cia|cia|hnos|hermanos)\b/g

/** "Metalúrgica Norte S.A." y "METALURGICA NORTE SA" dan lo mismo. */
export function normEmpresa(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[.,]/g, ' ')
    .replace(SUFIJOS, ' ')
    .replace(/[^a-z0-9]/g, '')
}

/** Parecido entre 0 y 1 (coeficiente de Dice sobre pares de letras). */
export function similitud(a: string, b: string): number {
  const x = normEmpresa(a)
  const y = normEmpresa(b)
  if (!x || !y) return 0
  if (x === y) return 1
  const pares = (s: string) => {
    const m = new Map<string, number>()
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1)
    return m
  }
  const px = pares(x)
  const py = pares(y)
  let comun = 0
  px.forEach((n, k) => (comun += Math.min(n, py.get(k) ?? 0)))
  return (2 * comun) / (x.length - 1 + (y.length - 1)) || 0
}

export interface ClienteRef {
  id: string
  razon_social: string
  cuit_dni: string | null
}

export type Coincidencia = { tipo: 'cuit' | 'nombre' | 'parecido' | 'nuevo'; cliente: ClienteRef | null; score: number }

export function buscarCliente(nombre: string, cuit: string, clientes: ClienteRef[]): Coincidencia {
  const c = soloDig(cuit)
  if (c) {
    const x = clientes.find((k) => k.cuit_dni === c)
    if (x) return { tipo: 'cuit', cliente: x, score: 1 }
  }
  const n = normEmpresa(nombre)
  const igual = clientes.find((k) => normEmpresa(k.razon_social) === n)
  if (igual) return { tipo: 'nombre', cliente: igual, score: 1 }
  let mejor: ClienteRef | null = null
  let s = 0
  for (const k of clientes) {
    if (c && k.cuit_dni && k.cuit_dni !== c) continue // CUIT distinto: es otro
    const v = similitud(nombre, k.razon_social)
    if (v > s) (s = v), (mejor = k)
  }
  if (mejor && s >= 0.82) return { tipo: 'parecido', cliente: mejor, score: s }
  return { tipo: 'nuevo', cliente: null, score: s }
}

/** "FCA 0003-00001234" → tipo "FCA" + número "0003-00001234". */
export function separarComprobante(s: string): { tipo: string; numero: string } {
  const t = txt(s)
  const m = t.match(/^([A-Za-z.]{1,6}(?:\s?[ABCEM])?)\s*[-:]?\s*(\d[\d\s-]*)$/)
  if (m) return { tipo: m[1].replace(/\s+/g, ' ').trim().toUpperCase(), numero: m[2].replace(/\s+/g, '') }
  return { tipo: 'Comprobante', numero: t }
}

/** Clave estable de una obligación para no duplicarla al reimportar. */
export function claveObligacion(proveedor: string, cuit: string, comprobante: string, extra = ''): string {
  const p = soloDig(cuit) || normEmpresa(proveedor)
  return `${p}|${normTxt(comprobante)}${extra ? '|' + normTxt(extra) : ''}`
}
