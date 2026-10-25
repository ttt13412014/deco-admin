import type { Cliente, Factura, TipoGestion } from './types'
import { TIPOS_VENTA, TIPOS_VENTA_LISTA, esCredito } from './comprobantes'

// ---------- Configuración de negocio (editable) ----------
/** Días antes del vencimiento para el aviso preventivo (A05: 72 hs). */
export const DIAS_AVISO_PREVIO = 3
/** A partir de cuántos días de atraso se considera "atraso prolongado". */
export const DIAS_ATRASO_PROLONGADO = 30
/** Días de plazo por defecto para cuenta corriente al cargar una factura. */
export const PLAZO_CC_DEFAULT = 30

export const CONDICIONES_IVA = ['Responsable Inscripto', 'Monotributista', 'Exento', 'Consumidor Final']
export const TIPOS_FACTURA = ['A', 'B', 'E', 'Presupuesto']
/** Texto para mostrar el formato de facturación del cliente ("Factura A", "Presupuesto"). */
export function fmtTipoFactura(t: string | null | undefined): string | null {
  if (!t) return null
  return t === 'Presupuesto' ? 'Presupuesto' : `Factura ${t}`
}
export const MEDIOS_PAGO = ['Efectivo', 'Transferencia', 'Cheque', 'E-cheq', 'Tarjeta']
/** Etiquetas de los tipos de comprobante de venta (ver lib/comprobantes.ts). */
export const TIPOS_COMPROBANTE = TIPOS_VENTA_LISTA.map((t) => TIPOS_VENTA[t].label)

// ---------- Fechas ----------
const pad = (n: number) => String(n).padStart(2, '0')

/** Fecha de hoy (hora local del navegador) en formato YYYY-MM-DD. */
export function hoy(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function toUTC(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

export function sumarDias(iso: string, dias: number): string {
  const d = new Date(toUTC(iso) + dias * 86400000)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** a - b en días. */
export function diffDias(a: string, b: string): number {
  return Math.round((toUTC(a) - toUTC(b)) / 86400000)
}

export function esLunes(iso = hoy()): boolean {
  return new Date(toUTC(iso)).getUTCDay() === 1
}

export function fmtFecha(iso?: string | null): string {
  if (!iso) return '—'
  const [y, m, d] = iso.slice(0, 10).split('-')
  return `${d}/${m}/${y}`
}

export function fmtFechaHora(iso?: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })
}

const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']
export function fmtFechaLarga(iso: string): string {
  const d = new Date(toUTC(iso))
  return `${DIAS_SEMANA[d.getUTCDay()]} ${fmtFecha(iso)}`
}

// ---------- Plata ----------
const money = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 2 })
export function fmtMoney(n?: number | string | null): string {
  return money.format(Number(n ?? 0))
}

export function parseMonto(s: string): number {
  // Acepta "1.234,56", "1234.56", "1234"
  const t = s.trim()
  if (!t) return NaN
  if (t.includes(',')) return Number(t.replace(/\./g, '').replace(',', '.'))
  return Number(t)
}

// ---------- CUIT / DNI ----------
export function soloDigitos(s: string): string {
  return (s || '').replace(/\D/g, '')
}

export function validarCuitDni(s: string): { ok: boolean; msg?: string } {
  const d = soloDigitos(s)
  if (d.length === 7 || d.length === 8) return { ok: true }
  if (d.length !== 11) return { ok: false, msg: 'Debe tener 11 dígitos (CUIT) o 7-8 (DNI).' }
  const mult = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  const suma = mult.reduce((acc, m, i) => acc + m * Number(d[i]), 0)
  let dv = 11 - (suma % 11)
  if (dv === 11) dv = 0
  if (dv === 10) dv = 9
  if (dv !== Number(d[10])) return { ok: false, msg: 'El dígito verificador del CUIT no coincide.' }
  return { ok: true }
}

export function fmtCuit(s: string | null | undefined): string {
  if (!s) return '—'
  const d = soloDigitos(s)
  if (d.length === 11) return `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}`
  if (d.length >= 7) return Number(d).toLocaleString('es-AR')
  return s
}

// ---------- Clientes (A01) ----------
// El CUIT/DNI es opcional (migración 12), salvo para clientes con Factura A, que necesitan CUIT (migración 13).
const OBLIGATORIOS: [keyof Cliente, string][] = [
  ['razon_social', 'Razón social'],
  ['condicion_iva', 'Condición IVA'],
  ['tipo_factura', 'Tipo de factura'],
  ['contacto_nombre', 'Contacto'],
  ['telefono', 'Teléfono'],
  ['email', 'Email'],
  ['direccion', 'Dirección'],
  ['localidad', 'Localidad'],
  ['horarios', 'Horarios'],
]

export function faltantesCliente(c: Partial<Cliente>): string[] {
  const out = OBLIGATORIOS.filter(([k]) => !String(c[k] ?? '').trim()).map(([, l]) => l)
  // Factura A necesita CUIT (11 dígitos); B, E y Presupuesto no (migración 13)
  if (c.tipo_factura === 'A' && soloDigitos(String(c.cuit_dni ?? '')).length !== 11) out.splice(1, 0, 'CUIT (Factura A)')
  return out
}

export const ESTADO_CLIENTE = {
  activo: { label: 'Activo', tone: 'green' },
  pendiente: { label: 'Pendiente de validar', tone: 'amber' },
  inhabilitado: { label: 'Inhabilitado', tone: 'slate' },
} as const

// ---------- Cobranzas (A05) ----------
export type EstadoCob = 'al_dia' | 'por_vencer' | 'vence_hoy' | 'atrasado' | 'atraso_prolongado' | 'credito' | 'cobrado' | 'imputada' | 'anulada'

export function estadoCobranza(f: Pick<Factura, 'estado' | 'fecha_vencimiento'> & Partial<Pick<Factura, 'tipo' | 'tipo_comprobante' | 'signo'>>, ref = hoy()): EstadoCob {
  if (f.estado === 'anulada') return 'anulada'
  // Notas de crédito / anula presupuesto: no vencen, son saldo a favor del cliente hasta que se imputan
  if (esCredito(f)) return f.estado === 'cobrado' ? 'imputada' : 'credito'
  if (f.estado === 'cobrado') return 'cobrado'
  const d = diffDias(f.fecha_vencimiento, ref)
  if (d > DIAS_AVISO_PREVIO) return 'al_dia'
  if (d > 0) return 'por_vencer'
  if (d === 0) return 'vence_hoy'
  if (d >= -DIAS_ATRASO_PROLONGADO) return 'atrasado'
  return 'atraso_prolongado'
}

export type Tone = 'green' | 'amber' | 'orange' | 'red' | 'rose' | 'slate' | 'blue' | 'brand'

export const ESTADO_COB: Record<EstadoCob, { label: string; tone: Tone; accion: string }> = {
  al_dia: { label: 'Al día', tone: 'green', accion: 'Dentro del plazo. No perseguir al cliente.' },
  por_vencer: { label: 'Vence en ≤72 hs', tone: 'amber', accion: 'Enviar aviso preventivo e informar a Ventas.' },
  vence_hoy: { label: 'Vence hoy', tone: 'orange', accion: 'Comunicar al cliente el vencimiento del día.' },
  atrasado: { label: 'Atrasado', tone: 'red', accion: 'Registrar atraso e informar a Ventas y Gerencia.' },
  atraso_prolongado: {
    label: 'Atraso prolongado',
    tone: 'rose',
    accion: 'Informar a Gerencia para decidir y a Ventas (posible corte de suministro, Manual Comercial cap. 2).',
  },
  credito: { label: 'Crédito a favor', tone: 'blue', accion: 'Resta del saldo del cliente. Imputalo contra una factura, nota de débito o presupuesto pendiente.' },
  cobrado: { label: 'Cobrado', tone: 'blue', accion: '' },
  imputada: { label: 'Imputada', tone: 'slate', accion: '' },
  anulada: { label: 'Anulada', tone: 'slate', accion: '' },
}

export const TIPO_GESTION: Record<TipoGestion, string> = {
  aviso_preventivo: 'Aviso preventivo (72 hs)',
  aviso_vencimiento: 'Aviso de vencimiento',
  aviso_atraso: 'Aviso de atraso',
  respuesta_cliente: 'Respuesta del cliente',
  informe_ventas: 'Informado a Ventas',
  escalado_gerencia: 'Escalado a Gerencia',
  otro: 'Otro',
}

export function gestionPorEstado(e: EstadoCob): TipoGestion {
  if (e === 'por_vencer' || e === 'al_dia') return 'aviso_preventivo'
  if (e === 'vence_hoy') return 'aviso_vencimiento'
  return 'aviso_atraso'
}

/** Mensaje de WhatsApp sugerido según el estado. Editá los textos acá. */
export function mensajeCobranza(f: Factura, e: EstadoCob = estadoCobranza(f)): string {
  const nombre = f.cliente?.contacto_nombre || f.cliente?.razon_social || ''
  const comp = `${f.tipo_comprobante} N° ${f.numero} por ${fmtMoney(f.saldo)}`
  if (e === 'vence_hoy') {
    return `Hola ${nombre}, ¿cómo estás? Te escribimos de Administración de DE&CO. Te recordamos que hoy vence la ${comp}. Medio de pago acordado: ${f.medio_pago_acordado}. Si ya realizaste el pago, por favor envianos el comprobante. ¡Muchas gracias!`
  }
  if (e === 'atrasado' || e === 'atraso_prolongado') {
    return `Hola ${nombre}, te escribimos de Administración de DE&CO. La ${comp} venció el ${fmtFecha(f.fecha_vencimiento)} y en nuestros registros figura pendiente de pago. Si ya la abonaste, por favor envianos el comprobante así lo registramos. ¡Gracias!`
  }
  return `Hola ${nombre}, ¿cómo estás? Te escribimos de Administración de DE&CO. Te recordamos que la ${comp} vence el ${fmtFecha(f.fecha_vencimiento)}. Medio de pago acordado: ${f.medio_pago_acordado}. ¡Muchas gracias!`
}

/** Link de WhatsApp. Normaliza números argentinos a 549 + área + número. */
export function waLink(telefono: string | null | undefined, texto: string): string | null {
  let d = soloDigitos(telefono || '')
  if (!d) return null
  if (d.startsWith('00')) d = d.slice(2)
  if (d.startsWith('0')) d = d.slice(1)
  if (!d.startsWith('54')) d = '54' + d
  if (!d.startsWith('549')) d = '549' + d.slice(2)
  return `https://wa.me/${d}?text=${encodeURIComponent(texto)}`
}

// ---------- Caja (A06 / A04) ----------
export const CHECKLIST_CIERRE: { key: string; label: string; ref: string }[] = [
  { key: 'ingresos', label: 'Ingresos del día registrados', ref: 'A06' },
  { key: 'egresos', label: 'Egresos del día registrados', ref: 'A06' },
  { key: 'comprobantes', label: 'Comprobantes respaldados', ref: 'A06' },
  { key: 'banco', label: 'Cuenta bancaria coincidente', ref: 'A06' },
  { key: 'cheques', label: 'Cartera de cheques coincidente (o no corresponde)', ref: 'A06' },
  { key: 'facturas', label: 'Facturas emitidas y archivadas', ref: 'A04' },
  { key: 'cobros', label: 'Cobros registrados', ref: 'A04' },
  { key: 'pagos', label: 'Pagos registrados', ref: 'A04' },
  { key: 'flujo', label: 'Flujo de fondos actualizado', ref: 'A04' },
]

/** "1 aviso" / "3 avisos" */
export function plural(n: number, uno: string, varios: string): string {
  return n === 1 ? uno : varios
}

export function copiar(texto: string): Promise<void> {
  return navigator.clipboard.writeText(texto)
}
