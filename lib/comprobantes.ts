// Tipos de comprobante de venta y su signo.
// Facturas, notas de débito y presupuestos SUMAN a la deuda del cliente y a los totales;
// notas de crédito y "anula presupuesto" RESTAN. Requiere la migración 10 (columna facturas.tipo).
// La misma clasificación está en la base: public.factura_tipo_de() (supabase/migracion_10_*.sql).

export type TipoVenta =
  | 'factura_a' | 'nota_credito_a' | 'nota_debito_a'
  | 'factura_b' | 'nota_credito_b' | 'nota_debito_b'
  | 'presupuesto' | 'anula_presupuesto'

export type ClaseVenta = 'factura' | 'nota_credito' | 'nota_debito' | 'presupuesto' | 'anula_presupuesto'

export interface InfoTipoVenta {
  label: string
  corto: string
  signo: 1 | -1
  clase: ClaseVenta
  letra: 'A' | 'B' | null
  /** Oficial (AFIP/ARCA) o "en negro". */
  oficial: boolean
  tone: 'brand' | 'red' | 'amber' | 'slate' | 'blue'
}

export const TIPOS_VENTA: Record<TipoVenta, InfoTipoVenta> = {
  factura_a: { label: 'Factura A', corto: 'FC A', signo: 1, clase: 'factura', letra: 'A', oficial: true, tone: 'brand' },
  nota_credito_a: { label: 'Nota de crédito A', corto: 'NC A', signo: -1, clase: 'nota_credito', letra: 'A', oficial: true, tone: 'red' },
  nota_debito_a: { label: 'Nota de débito A', corto: 'ND A', signo: 1, clase: 'nota_debito', letra: 'A', oficial: true, tone: 'blue' },
  factura_b: { label: 'Factura B', corto: 'FC B', signo: 1, clase: 'factura', letra: 'B', oficial: true, tone: 'brand' },
  nota_credito_b: { label: 'Nota de crédito B', corto: 'NC B', signo: -1, clase: 'nota_credito', letra: 'B', oficial: true, tone: 'red' },
  nota_debito_b: { label: 'Nota de débito B', corto: 'ND B', signo: 1, clase: 'nota_debito', letra: 'B', oficial: true, tone: 'blue' },
  presupuesto: { label: 'Presupuesto', corto: 'PRES', signo: 1, clase: 'presupuesto', letra: null, oficial: false, tone: 'amber' },
  anula_presupuesto: { label: 'Anula presupuesto', corto: 'ANULA PRES', signo: -1, clase: 'anula_presupuesto', letra: null, oficial: false, tone: 'red' },
}

export const TIPOS_VENTA_LISTA = Object.keys(TIPOS_VENTA) as TipoVenta[]

/** Grupos para el selector (mismo orden que pidió Administración). */
export const GRUPOS_TIPO_VENTA: { label: string; tipos: TipoVenta[] }[] = [
  { label: 'Oficiales · A', tipos: ['factura_a', 'nota_credito_a', 'nota_debito_a'] },
  { label: 'Oficiales · B', tipos: ['factura_b', 'nota_credito_b', 'nota_debito_b'] },
  { label: 'En negro', tipos: ['presupuesto', 'anula_presupuesto'] },
]

/** Filtros por clase para los listados. */
export const CLASES_VENTA: { key: ClaseVenta; label: string }[] = [
  { key: 'factura', label: 'Facturas' },
  { key: 'nota_credito', label: 'Notas de crédito' },
  { key: 'nota_debito', label: 'Notas de débito' },
  { key: 'presupuesto', label: 'Presupuestos' },
  { key: 'anula_presupuesto', label: 'Anula presupuesto' },
]

export const esTipoVenta = (t: unknown): t is TipoVenta => typeof t === 'string' && t in TIPOS_VENTA

const sinAcentos = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')

/**
 * Clasifica un texto libre ("Factura A", "FCA", "NC B", "Remito / Presupuesto", lo que venga de Sintesys…).
 * `negativo`: el importe vino con signo menos (Sintesys exporta así las notas de crédito).
 * Letra A o M → A; B, C, E o sin letra reconocible → según `letraDefault` (A).
 */
export function tipoVentaDe(texto: string | null | undefined, negativo = false, letraDefault: 'a' | 'b' = 'a'): TipoVenta {
  const crudo = (texto ?? '').trim()
  if (esTipoVenta(crudo.toLowerCase())) return crudo.toLowerCase() as TipoVenta
  const t = sinAcentos(crudo).toUpperCase()
  let clase: ClaseVenta
  if (/ANULA/.test(t) && /PRESUP/.test(t)) clase = 'anula_presupuesto'
  else if (/PRESUP|REMITO|(^|[^A-Z])X($|[^A-Z])/.test(t)) clase = 'presupuesto'
  else if (/NOTA\s+DE\s+CRED|(^|[^A-Z])N\/?C[ABCEM]?($|[^A-Z])|(^|[^A-Z])NCE?($|[^A-Z])/.test(t)) clase = 'nota_credito'
  else if (/NOTA\s+DE\s+DEB|(^|[^A-Z])N\/?D[ABCEM]?($|[^A-Z])|(^|[^A-Z])NDE?($|[^A-Z])/.test(t)) clase = 'nota_debito'
  else clase = 'factura'
  if (negativo) {
    if (clase === 'presupuesto') clase = 'anula_presupuesto'
    else if (clase === 'factura' || clase === 'nota_debito') clase = 'nota_credito'
  }
  if (clase === 'presupuesto' || clase === 'anula_presupuesto') return clase
  const m = t.match(/(?:^|[^A-Z/])(?:FCE|FC|FAC|FA|NCE|NC|NDE|ND|N\/C|N\/D)?\s*([ABCEM])(?:[^A-Z]|$)/)
  const letra = m ? (m[1] === 'A' || m[1] === 'M' ? 'a' : 'b') : letraDefault
  return `${clase}_${letra}` as TipoVenta
}

/** Tipo desde lo que lee el PDF (clase AFIP + letra). A y M → A; B, C, E → B. */
export function tipoVentaAfip(clase: ClaseVenta | 'desconocido', letra: string | null): TipoVenta {
  if (clase === 'presupuesto' || clase === 'anula_presupuesto') return clase
  const c = clase === 'desconocido' ? 'factura' : clase
  const l = !letra || letra === 'A' || letra === 'M' ? 'a' : 'b'
  return `${c}_${l}` as TipoVenta
}

type ConTipo = { tipo?: string | null; tipo_comprobante?: string | null; signo?: number | null }

/** Tipo del comprobante (las filas viejas sin `tipo` se clasifican por el texto). */
export function tipoDe(f: ConTipo): TipoVenta {
  return esTipoVenta(f.tipo) ? f.tipo : tipoVentaDe(f.tipo_comprobante)
}
export const infoTipo = (f: ConTipo): InfoTipoVenta => TIPOS_VENTA[tipoDe(f)]
/** +1 suma (factura, nota de débito, presupuesto) · −1 resta (nota de crédito, anula presupuesto). */
export const signoDe = (f: ConTipo): 1 | -1 => (f.signo === -1 || f.signo === 1 ? (f.signo as 1 | -1) : infoTipo(f).signo)
export const esCredito = (f: ConTipo) => signoDe(f) < 0
/** Saldo con signo: lo que suma o resta a la deuda del cliente. */
export const saldoFirmado = (f: ConTipo & { saldo: number | string }) => signoDe(f) * Number(f.saldo)
export const montoFirmado = (f: ConTipo & { monto: number | string }) => signoDe(f) * Number(f.monto)
export const sumaFirmada = (fs: (ConTipo & { saldo: number | string })[]) => Math.round(fs.reduce((a, f) => a + saldoFirmado(f), 0) * 100) / 100

/** Etiqueta para mostrar: la del tipo, salvo que el texto original diga otra cosa (p. ej. "Factura E" de Sintesys). */
export function etiquetaTipo(f: ConTipo): string {
  return TIPOS_VENTA[tipoDe(f)].label
}

/**
 * Descuenta los créditos pendientes (NC / anula presupuesto) de las facturas del mismo cliente,
 * empezando por las que vencen primero. Sirve para proyectar cobranzas sin contar de más.
 */
export function netearCreditos<T extends ConTipo & { saldo: number | string; cliente_id?: string; fecha_vencimiento: string }>(
  fs: T[],
  clave: (f: T) => string = (f) => f.cliente_id ?? '',
): T[] {
  const credito = new Map<string, number>()
  for (const f of fs) if (esCredito(f)) credito.set(clave(f), (credito.get(clave(f)) ?? 0) + Number(f.saldo))
  const out: T[] = []
  for (const f of [...fs].filter((x) => !esCredito(x)).sort((a, b) => a.fecha_vencimiento.localeCompare(b.fecha_vencimiento))) {
    const k = clave(f)
    const c = credito.get(k) ?? 0
    const s = Number(f.saldo)
    if (c <= 0) out.push(f)
    else if (c >= s) credito.set(k, c - s)
    else {
      credito.set(k, 0)
      out.push({ ...f, saldo: Math.round((s - c) * 100) / 100 })
    }
  }
  return out
}

/**
 * Vencido neto por cliente: lo vencido de facturas / ND / presupuestos, descontando los créditos
 * a favor del mismo cliente (nunca más que su saldo). Igual que v_clientes_saldos.vencido.
 */
export function vencidoNeto<T extends ConTipo & { saldo: number | string; cliente_id?: string }>(fs: T[], vencida: (f: T) => boolean): number {
  const por = new Map<string, { neto: number; venc: number }>()
  for (const f of fs) {
    const k = f.cliente_id ?? ''
    const x = por.get(k) ?? { neto: 0, venc: 0 }
    x.neto += saldoFirmado(f)
    if (!esCredito(f) && vencida(f)) x.venc += Number(f.saldo)
    por.set(k, x)
  }
  let t = 0
  for (const x of Array.from(por.values())) t += Math.max(0, Math.min(x.neto, x.venc))
  return Math.round(t * 100) / 100
}
