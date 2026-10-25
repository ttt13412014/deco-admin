// Tesorería: un solo libro de movimientos para caja, bancos, cheques y flujo de fondos.
import { sb } from './supabase'
import { diffDias, fmtFecha, hoy } from './utils'

export type TipoMov = 'ingreso' | 'egreso' | 'transferencia'
export type EstadoMov = 'pendiente' | 'autorizado' | 'realizado' | 'anulado'
export type Medio = 'efectivo' | 'transferencia' | 'deposito' | 'cheque' | 'echeq' | 'debito_automatico' | 'tarjeta' | 'endoso' | 'otro'

export interface Cuenta {
  id: string
  codigo: string
  nombre: string
  tipo: 'efectivo' | 'banco'
  orden: number
  activa: boolean
  reserva_minima: number
  cobro_default: boolean
  pago_default: boolean
}

export interface Categoria {
  id: string
  tipo: 'ingreso' | 'egreso'
  rubro: string
  nombre: string
  clave: string | null
  requiere_autorizacion: boolean
  orden: number
  activa: boolean
}

export interface Movimiento {
  id: string
  fecha: string
  tipo: TipoMov
  sentido: 'entrada' | 'salida'
  categoria_id: string | null
  concepto: string
  contraparte: string | null
  medio: Medio
  cuenta_id: string | null
  transferencia_id: string | null
  importe: number
  fecha_prevista: string
  fecha_efectiva: string | null
  estado: EstadoMov
  comprobante: string | null
  observaciones: string | null
  cheque_id: string | null
  cobro_id: string | null
  factura_id: string | null
  obligacion_id: string | null
  serie_id: string | null
  conciliado: boolean
  extracto_id: string | null
  autorizado_at: string | null
  realizado_at: string | null
  anulado_at: string | null
  motivo_anulacion: string | null
  created_at: string
  created_by: string | null
  autor?: { nombre: string } | null
}

export type EstadoCheque = 'en_cartera' | 'depositado' | 'acreditado' | 'endosado' | 'rechazado' | 'anulado' | 'emitido' | 'debitado'

export interface Cheque {
  id: string
  sentido: 'recibido' | 'emitido'
  formato: 'fisico' | 'echeq'
  numero: string
  banco: string | null
  contraparte: string
  cuit: string | null
  importe: number
  fecha_emision: string | null
  fecha_pago: string
  cuenta_id: string | null
  estado: EstadoCheque
  fecha_deposito: string | null
  fecha_efectiva: string | null
  endosado_a: string | null
  motivo: string | null
  observaciones: string | null
  cobro_id: string | null
  created_at: string
}

export interface Extracto {
  id: string
  cuenta_id: string
  fecha: string
  descripcion: string
  referencia: string | null
  importe: number
  saldo: number | null
  huella: string
  lote: string | null
  estado: 'pendiente' | 'conciliado' | 'ignorado'
  movimiento_id: string | null
  nota: string | null
  created_at: string
}

export interface Jornada {
  id: string
  fecha: string
  estado: 'abierta' | 'cerrada'
  checklist: Record<string, boolean>
  observaciones: string | null
  abierta_at: string
  cerrada_at: string | null
  abridor?: { nombre: string } | null
  cerrador?: { nombre: string } | null
  saldos?: JornadaSaldo[]
}

export interface JornadaSaldo {
  id: string
  jornada_id: string
  cuenta_id: string
  saldo_sistema: number | null
  saldo_inicial: number
  saldo_esperado: number | null
  saldo_real: number | null
  diferencia: number | null
  justificacion: string | null
}

export interface EventoJornada {
  id: number
  jornada_id: string
  accion: 'apertura' | 'cierre' | 'reapertura' | 'correccion'
  motivo: string | null
  datos: unknown
  fecha: string
  autor?: { nombre: string } | null
}

// ---------- Etiquetas ----------
export const MEDIOS: Record<Medio, string> = {
  efectivo: 'Efectivo',
  transferencia: 'Transferencia',
  deposito: 'Depósito',
  cheque: 'Cheque físico',
  echeq: 'E-cheq',
  debito_automatico: 'Débito automático',
  tarjeta: 'Tarjeta',
  endoso: 'Cheque endosado',
  otro: 'Otro',
}
export const MEDIOS_CARGA: Medio[] = ['efectivo', 'transferencia', 'deposito', 'cheque', 'echeq', 'debito_automatico', 'tarjeta', 'otro']

export const ESTADO_MOV: Record<EstadoMov, { label: string; tone: 'amber' | 'blue' | 'green' | 'slate' }> = {
  pendiente: { label: 'Pendiente', tone: 'amber' },
  autorizado: { label: 'Autorizado', tone: 'blue' },
  realizado: { label: 'Realizado', tone: 'green' },
  anulado: { label: 'Anulado', tone: 'slate' },
}

export const ESTADO_CHEQUE: Record<EstadoCheque, { label: string; tone: 'amber' | 'blue' | 'green' | 'slate' | 'red' | 'brand' }> = {
  en_cartera: { label: 'En cartera', tone: 'amber' },
  depositado: { label: 'Depositado', tone: 'blue' },
  acreditado: { label: 'Acreditado', tone: 'green' },
  endosado: { label: 'Endosado', tone: 'brand' },
  rechazado: { label: 'Rechazado', tone: 'red' },
  anulado: { label: 'Anulado', tone: 'slate' },
  emitido: { label: 'Emitido · débito pendiente', tone: 'amber' },
  debitado: { label: 'Debitado', tone: 'green' },
}

export const TIPO_MOV: Record<TipoMov, string> = { ingreso: 'Ingreso', egreso: 'Egreso', transferencia: 'Transferencia propia' }

/** Estado que se muestra (un pago autorizado con cheque emitido está "esperando el débito"). */
export function etiquetaMov(m: Movimiento): string {
  if (m.estado === 'autorizado' && m.cheque_id) return 'Cheque emitido · débito pendiente'
  if (m.estado === 'pendiente' && m.cheque_id && m.sentido === 'entrada') return 'Cheque a acreditar'
  if (m.tipo === 'ingreso' && m.estado === 'pendiente') return 'A cobrar'
  if (m.tipo === 'egreso' && m.estado === 'pendiente') return 'Pendiente de autorizar'
  if (m.tipo === 'ingreso' && m.estado === 'realizado') return 'Cobrado'
  if (m.tipo === 'egreso' && m.estado === 'realizado') return 'Pagado'
  return ESTADO_MOV[m.estado].label
}

export const firmado = (m: Pick<Movimiento, 'sentido' | 'importe'>) => (m.sentido === 'entrada' ? Number(m.importe) : -Number(m.importe))

// ---------- Carga de datos comunes ----------
export async function cargarBase(): Promise<{ cuentas: Cuenta[]; categorias: Categoria[] }> {
  const s = sb()
  const [c, k] = await Promise.all([
    s.from('tes_cuentas').select('*').order('orden'),
    s.from('tes_categorias').select('*').order('tipo').order('rubro').order('orden').order('nombre'),
  ])
  return { cuentas: (c.data as Cuenta[]) ?? [], categorias: (k.data as Categoria[]) ?? [] }
}

export interface Disponible {
  cuenta_id: string
  codigo: string
  nombre: string
  tipo: 'efectivo' | 'banco'
  saldo: number
}

export async function disponibilidad(al = hoy()): Promise<Disponible[]> {
  const { data, error } = await sb().rpc('tes_disponibilidad', { p_al: al })
  if (error) throw error
  return ((data as Disponible[]) ?? []).map((d) => ({ ...d, saldo: Number(d.saldo) }))
}

/** Categorías agrupadas por rubro para un <select>. */
export function porRubro(cats: Categoria[], tipo: 'ingreso' | 'egreso', incluirInactivas = false) {
  const m = new Map<string, Categoria[]>()
  for (const c of cats) {
    if (c.tipo !== tipo || (!c.activa && !incluirInactivas)) continue
    const arr = m.get(c.rubro) ?? []
    arr.push(c)
    m.set(c.rubro, arr)
  }
  return Array.from(m.entries())
}

// ---------- Resúmenes ----------
export interface ResumenCuenta {
  ingresos: number
  egresos: number
  transfEntrada: number
  transfSalida: number
}

/** Ingresos y egresos realizados por cuenta en un rango (las transferencias propias van aparte). */
export function resumenPorCuenta(movs: Movimiento[], desde: string, hasta: string): Map<string, ResumenCuenta> {
  const r = new Map<string, ResumenCuenta>()
  for (const m of movs) {
    if (m.estado !== 'realizado' || !m.cuenta_id || !m.fecha_efectiva || m.fecha_efectiva < desde || m.fecha_efectiva > hasta) continue
    const x = r.get(m.cuenta_id) ?? { ingresos: 0, egresos: 0, transfEntrada: 0, transfSalida: 0 }
    const v = Number(m.importe)
    if (m.tipo === 'transferencia') m.sentido === 'entrada' ? (x.transfEntrada += v) : (x.transfSalida += v)
    else m.sentido === 'entrada' ? (x.ingresos += v) : (x.egresos += v)
    r.set(m.cuenta_id, x)
  }
  return r
}

export function diasHasta(f: string): string {
  const d = diffDias(f, hoy())
  if (d === 0) return 'hoy'
  if (d === 1) return 'mañana'
  if (d === -1) return 'ayer'
  return d > 0 ? `en ${d} días` : `hace ${-d} días`
}

export const fechaCorta = (f: string | null) => (f ? fmtFecha(f).slice(0, 5) : '—')

// ---------- Importación de extractos ----------
export const normTxt = (s: string) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '')

/** "1.234,56" · "-1234.56" · "$ 1.234" · "(1.234,56)" → número. */
export function parseImporte(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') return v
  let s = String(v).trim().replace(/\$|\s/g, '')
  let neg = false
  if (/^\(.*\)$/.test(s)) (neg = true), (s = s.slice(1, -1))
  if (s.startsWith('-')) (neg = true), (s = s.slice(1))
  if (s.endsWith('-')) (neg = true), (s = s.slice(0, -1))
  if (!s) return null
  const coma = s.lastIndexOf(',')
  const punto = s.lastIndexOf('.')
  if (coma > punto) s = s.replace(/\./g, '').replace(',', '.')
  else if (punto > coma && coma >= 0) s = s.replace(/,/g, '')
  else if (coma === -1 && (s.match(/\./g) ?? []).length > 1) s = s.replace(/\./g, '')
  const n = Number(s)
  return Number.isFinite(n) ? (neg ? -n : n) : null
}

/** "15/10/2026" · "2026-10-15" · "15-10-26" · número de serie de Excel → YYYY-MM-DD. */
export function parseFechaExtracto(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const d = new Date(Math.round((v - 25569) * 86400000))
    return d.toISOString().slice(0, 10)
  }
  const s = String(v).trim()
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/)
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3]
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  }
  return null
}

/** Busca el movimiento que corresponde a una línea del extracto (mismo importe, mismo sentido, fecha cercana). */
export function sugerirConciliacion(e: Extracto, candidatos: Movimiento[], usados: Set<string>): Movimiento | null {
  const entrada = e.importe > 0
  const imp = Math.abs(Number(e.importe))
  let mejor: Movimiento | null = null
  let dMejor = Infinity
  for (const m of candidatos) {
    if (usados.has(m.id) || m.conciliado || m.estado === 'anulado' || m.cuenta_id !== e.cuenta_id) continue
    if ((m.sentido === 'entrada') !== entrada || Math.abs(Number(m.importe) - imp) > 0.005) continue
    const f = m.fecha_efectiva ?? m.fecha_prevista
    const d = Math.abs(diffDias(f, e.fecha))
    if (d > 7) continue
    if (d < dMejor) (dMejor = d), (mejor = m)
  }
  return mejor
}

export const CHECKLIST_CIERRE = [
  { key: 'ingresos', label: 'Ingresos del día registrados' },
  { key: 'egresos', label: 'Egresos del día registrados' },
  { key: 'comprobantes', label: 'Comprobantes respaldados y archivados' },
  { key: 'bancos', label: 'Saldos de Galicia y Macro verificados en homebanking' },
  { key: 'cheques', label: 'Cartera de cheques controlada (o no corresponde)' },
  { key: 'cobros', label: 'Cobros del día cargados' },
  { key: 'pagos', label: 'Pagos del día cargados con su orden de pago' },
]
