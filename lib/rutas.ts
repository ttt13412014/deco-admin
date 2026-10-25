import type { Cliente, FormaPago, Parada } from './types'
import { fmtFechaLarga, fmtMoney } from './utils'
import type { LecturaFactura } from './factura-pdf'
import { parseCoords } from './geo'

export const ESTADO_HOJA = {
  borrador: { label: 'Armada', tone: 'slate' },
  en_curso: { label: 'En reparto', tone: 'amber' },
  completada: { label: 'Completada', tone: 'green' },
} as const

/** Máximo de paradas intermedias que acepta un link de Google Maps. */
export const MAX_WAYPOINTS = 9

export const norm = (s: string) =>
  (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Acepta "-31.41, -64.18", un link de Google Maps con @lat,lng / q=lat,lng / ll=lat,lng,
 * o "!3d-31.4!4d-64.1". Devuelve "lat,lng" o '' si no encuentra coordenadas.
 */
export function normalizarUbicacion(s: string): string {
  const t = (s || '').trim()
  if (!t) return ''
  const pats = [
    /@(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/,
    /[?&](?:q|ll|query|destination)=(-?\d{1,2}\.\d+)(?:,|%2C)\s*(-?\d{1,3}\.\d+)/i,
    /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/,
    /^(-?\d{1,2}\.\d+)\s*[,; ]\s*(-?\d{1,3}\.\d+)$/,
  ]
  for (const p of pats) {
    const m = t.match(p)
    if (m) return `${Number(m[1]).toFixed(6)},${Number(m[2]).toFixed(6)}`
  }
  return ''
}

type ClienteDir = Pick<Cliente, 'direccion' | 'localidad' | 'provincia' | 'ubicacion'>

/** Lo que se le manda a Google Maps para ese cliente. */
export function direccionCliente(c: ClienteDir): string {
  if (c.ubicacion) return c.ubicacion
  if (!c.direccion?.trim()) return ''
  const prov = c.provincia && norm(c.provincia) !== norm(c.localidad ?? '') ? c.provincia : null
  return [c.direccion, c.localidad, prov, 'Argentina'].filter((x) => x && x.trim()).join(', ')
}

export interface Tramo {
  numero: number
  desde: number // índice de parada (0 = salida)
  hasta: number
  url: string
}

const enc = (s: string) => encodeURIComponent(s.trim())

/**
 * Arma los links de Google Maps respetando el orden de la lista.
 * Si hay más de 9 paradas intermedias, lo parte en tramos encadenados.
 */
export function linksMaps(origen: string, direcciones: string[], volver: boolean): Tramo[] {
  const puntos = [origen, ...direcciones]
  if (volver) puntos.push(origen)
  if (puntos.length < 2) return []
  const tramos: Tramo[] = []
  let i = 0
  while (i < puntos.length - 1) {
    const fin = Math.min(i + MAX_WAYPOINTS + 1, puntos.length - 1)
    const wps = puntos.slice(i + 1, fin)
    let url = `https://www.google.com/maps/dir/?api=1&origin=${enc(puntos[i])}&destination=${enc(puntos[fin])}&travelmode=driving`
    if (wps.length) url += `&waypoints=${wps.map(enc).join('%7C')}`
    tramos.push({ numero: tramos.length + 1, desde: i, hasta: fin, url })
    i = fin
  }
  return tramos
}

export function textoChofer(
  h: { fecha: string; nombre: string | null; chofer: string | null; origen: string; volver_origen: boolean; observaciones: string | null },
  paradas: Parada[],
  tramos: Tramo[],
  extra: { link?: string | null; horario?: (p: Parada) => string } = {},
): string {
  const l: string[] = []
  l.push(`*Hoja de ruta${h.nombre ? ` – ${h.nombre}` : ''}*`)
  l.push(`${fmtFechaLarga(h.fecha)}${h.chofer ? ` · Chofer: ${h.chofer}` : ''}`)
  l.push(`Salida: ${h.origen}`)
  if (h.observaciones) l.push(`Obs.: ${h.observaciones}`)
  l.push('')
  paradas.forEach((p, i) => {
    const hor = extra.horario?.(p)
    l.push(`*${i + 1}. ${p.destino}*${hor ? ` (${hor})` : ''}`)
    l.push(`   📍 ${p.direccion}`)
    if (p.que_lleva) l.push(`   📦 ${p.que_lleva}${p.bultos ? ` (${p.bultos} ${p.bultos === 1 ? 'bulto' : 'bultos'})` : ''}`)
    else if (p.bultos) l.push(`   📦 ${p.bultos} ${p.bultos === 1 ? 'bulto' : 'bultos'}`)
    if (p.telefono) l.push(`   📞 ${p.telefono}`)
    if (p.observaciones) l.push(`   ⚠️ ${p.observaciones}`)
    if (p.monto_factura != null) l.push(`   💲 ${p.monto_factura < 0 ? 'Nota de crédito' : 'Factura'}: ${fmtMoney(p.monto_factura)}`)
  })
  const t = totalesRuta(paradas)
  if (t.conMonto) l.push('', `*Total facturas de la hoja: ${fmtMoney(t.total)}*`)
  if (h.volver_origen) l.push('', `Regreso: ${h.origen}`)
  if (extra.link) l.push('', '*Marcá cada entrega y lo cobrado acá:*', extra.link)
  l.push('', '*Recorrido en Google Maps:*')
  for (const t of tramos) {
    l.push(tramos.length > 1 ? `Tramo ${t.numero} (paradas ${Math.max(t.desde, 1)}–${Math.min(t.hasta, paradas.length)}): ${t.url}` : t.url)
  }
  return l.join('\n')
}

export function mensajeEnCamino(p: Parada): string {
  return `Hola, ¿cómo estás? Te escribimos de DE&CO. Hoy te estamos llevando tu pedido${p.que_lleva ? `: ${p.que_lleva}` : ''}. Cualquier cosa avisanos por acá. ¡Gracias!`
}

// ---------------------------------------------------------------------
// Carga rápida: "Cliente - qué lleva" (una línea por parada)
// ---------------------------------------------------------------------
export type ClienteRuta = Pick<
  Cliente,
  'id' | 'razon_social' | 'cuit_dni' | 'direccion' | 'localidad' | 'provincia' | 'ubicacion' | 'telefono' | 'contacto_nombre' | 'lat' | 'lng'
  | 'horarios' | 'horario_desde' | 'horario_hasta' | 'horario2_desde' | 'horario2_hasta'
>

export interface LineaRapida {
  linea: string
  nombre: string
  queLleva: string
  bultos: number | null
  candidatos: ClienteRuta[]
  elegido: string // id del cliente ('' = sin asignar)
}

export function puntaje(q: string, nombre: string): number {
  const a = norm(q)
  const b = norm(nombre)
  if (!a || !b) return 0
  if (a === b) return 100
  if (b.startsWith(a)) return 85
  if (b.includes(a)) return 70
  const ta = a.split(' ').filter((t) => t.length > 1)
  const tb = new Set(b.split(' '))
  const hits = ta.filter((t) => tb.has(t) || Array.from(tb).some((x) => x.startsWith(t))).length
  if (ta.length && hits === ta.length) return 60
  if (ta.length > 1 && hits >= ta.length - 1) return 40
  return 0
}

export function parsearCargaRapida(texto: string, clientes: ClienteRuta[]): LineaRapida[] {
  return texto
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((linea) => {
      const m = linea.match(/^(.+?)(?:\t|\s+[-–—]\s+|\s*:\s+|\s*\|\s*)(.*)$/)
      const nombre = (m ? m[1] : linea).replace(/^\d+[.)-]\s*/, '').trim()
      let queLleva = (m ? m[2] : '').trim()
      let bultos: number | null = null
      const b = queLleva.match(/\(?\s*(\d+)\s*bult\w*\s*\)?/i)
      if (b) {
        bultos = Number(b[1])
        queLleva = queLleva.replace(b[0], '').replace(/\s{2,}/g, ' ').replace(/[,;]\s*$/, '').trim()
      }
      const scored = clientes
        .map((c) => ({ c, s: puntaje(nombre, c.razon_social) }))
        .filter((x) => x.s > 0)
        .sort((x, y) => y.s - x.s)
      const top = scored[0]?.s ?? 0
      const candidatos = scored.slice(0, 6).map((x) => x.c)
      const empatados = scored.filter((x) => x.s === top).length
      const elegido = top >= 60 && empatados === 1 ? scored[0].c.id : ''
      return { linea, nombre, queLleva, bultos, candidatos, elegido }
    })
}

export function paradaDesdeCliente(c: ClienteRuta, queLleva = '', bultos: number | null = null): Parada {
  const pos = parseCoords(c.ubicacion) ?? (c.lat != null && c.lng != null ? { lat: c.lat, lng: c.lng } : null)
  return {
    lat: pos?.lat ?? null,
    lng: pos?.lng ?? null,
    cliente_id: c.id,
    destino: c.razon_social,
    direccion: direccionCliente(c),
    telefono: c.telefono,
    que_lleva: queLleva || null,
    bultos,
    observaciones: null,
    entregado: false,
    entregado_at: null,
    nota_entrega: null,
    monto_factura: null,
    comprobantes: [],
  }
}

// ---------------------------------------------------------------------
// Montos de factura por parada (caja del chofer)
// ---------------------------------------------------------------------
export interface TotalesRuta {
  facturas: number // suma de lo positivo
  notas: number // suma de las notas de crédito (negativo)
  total: number
  entregado: number // total de las paradas ya entregadas
  conMonto: number // cuántas paradas tienen monto
}

const r2 = (n: number) => Math.round(n * 100) / 100

export function totalesRuta(paradas: Pick<Parada, 'monto_factura' | 'entregado'>[]): TotalesRuta {
  const t: TotalesRuta = { facturas: 0, notas: 0, total: 0, entregado: 0, conMonto: 0 }
  for (const p of paradas) {
    if (p.monto_factura == null) continue
    const m = Number(p.monto_factura) || 0
    t.conMonto++
    if (m >= 0) t.facturas += m
    else t.notas += m
    t.total += m
    if (p.entregado) t.entregado += m
  }
  return { ...t, facturas: r2(t.facturas), notas: r2(t.notas), total: r2(t.total), entregado: r2(t.entregado) }
}

/** Saca "S.A.", "S.R.L.", "SAS", etc. para comparar nombres de empresas. */
const sinSociedad = (s: string) =>
  norm(s)
    .replace(/\b(s a i c|s a s|s r l|s a|s h|s c|saic|srl|sas|sa|sh|sac|sci|y cia|cia)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Busca el cliente de una factura leída del PDF: primero por CUIT/DNI del receptor,
 * después por nombre. Si hay un solo candidato claro lo deja elegido.
 */
export function clientePorFactura(l: Pick<LecturaFactura, 'cuitReceptor' | 'dniReceptor' | 'razonSocial'>, clientes: ClienteRuta[]): { elegido: string; candidatos: ClienteRuta[]; porCuit: boolean } {
  const docs = [l.cuitReceptor, l.dniReceptor].filter((x): x is string => !!x)
  for (const d of docs) {
    const c = clientes.find((x) => x.cuit_dni && x.cuit_dni.replace(/\D/g, '') === d)
    if (c) return { elegido: c.id, candidatos: [c], porCuit: true }
  }
  if (!l.razonSocial) return { elegido: '', candidatos: [], porCuit: false }
  const q = sinSociedad(l.razonSocial)
  const scored = clientes
    .map((c) => ({ c, s: Math.max(puntaje(q, sinSociedad(c.razon_social)), puntaje(l.razonSocial!, c.razon_social)) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
  const top = scored[0]?.s ?? 0
  const empatados = scored.filter((x) => x.s === top).length
  return { elegido: top >= 60 && empatados === 1 ? scored[0].c.id : '', candidatos: scored.slice(0, 6).map((x) => x.c), porCuit: false }
}

// ---------------------------------------------------------------------
// Entregas y cobros marcados por el chofer (migración 14)
// ---------------------------------------------------------------------
export const MOTIVOS_NO_ENTREGA = ['Cerrado', 'No tenía plata', 'Rechazó mercadería', 'No llegó a tiempo', 'Dirección equivocada', 'Otro'] as const

export const FORMAS_PAGO: { k: FormaPago; label: string; corto: string }[] = [
  { k: 'efectivo', label: 'Efectivo', corto: 'Ef.' },
  { k: 'transferencia', label: 'Transferencia', corto: 'Transf.' },
  { k: 'cheque', label: 'Cheque', corto: 'Ch.' },
  { k: 'mixto', label: 'Mixto', corto: 'Mixto' },
]
export const labelFormaPago = (k: string | null | undefined) => FORMAS_PAGO.find((f) => f.k === k)?.label ?? ''

export const MOTIVOS_DEVOLUCION = ['Fallado', 'No lo pidió', 'Vencido / dañado', 'Sobrante', 'Otro'] as const

export type EstadoParada = 'pendiente' | 'entregado' | 'parcial' | 'no_entregado'
export function estadoParada(p: Pick<Parada, 'entregado' | 'resultado'>): EstadoParada {
  if (p.resultado === 'parcial') return 'parcial'
  if (p.entregado || p.resultado === 'entregado') return 'entregado'
  if (p.resultado === 'no_entregado') return 'no_entregado'
  return 'pendiente'
}

export const ESTADO_PARADA: Record<EstadoParada, { label: string; tone: 'green' | 'red' | 'slate' | 'amber'; icono: string }> = {
  pendiente: { label: 'Pendiente', tone: 'slate', icono: '' },
  entregado: { label: 'Entregado', tone: 'green', icono: '✓' },
  parcial: { label: 'Entrega parcial', tone: 'amber', icono: '◐' },
  no_entregado: { label: 'No entregado', tone: 'red', icono: '✗' },
}

export interface TotalesCobro {
  cobrado: number
  porForma: Record<FormaPago | 'sin_forma', number>
  entregadas: number
  parciales: number
  noEntregadas: number
  pendientes: number
  /** Paradas con devolución y suma de los montos devueltos que se cargaron. */
  devoluciones: number
  devuelto: number
}

export function totalesCobro(
  paradas: Pick<Parada, 'entregado' | 'resultado' | 'monto_cobrado' | 'forma_pago' | 'devolucion_detalle' | 'devolucion_monto'>[],
): TotalesCobro {
  const t: TotalesCobro = {
    cobrado: 0,
    porForma: { efectivo: 0, transferencia: 0, cheque: 0, mixto: 0, sin_forma: 0 },
    entregadas: 0,
    parciales: 0,
    noEntregadas: 0,
    pendientes: 0,
    devoluciones: 0,
    devuelto: 0,
  }
  for (const p of paradas) {
    const e = estadoParada(p)
    if (p.devolucion_detalle) {
      t.devoluciones++
      t.devuelto += Number(p.devolucion_monto ?? 0) || 0
    }
    if (e === 'entregado') t.entregadas++
    else if (e === 'parcial') t.parciales++
    else if (e === 'no_entregado') t.noEntregadas++
    else t.pendientes++
    const m = Number(p.monto_cobrado ?? 0) || 0
    if (!m) continue
    t.cobrado += m
    t.porForma[(p.forma_pago as FormaPago) || 'sin_forma'] += m
  }
  t.cobrado = r2(t.cobrado)
  t.devuelto = r2(t.devuelto)
  for (const k of Object.keys(t.porForma) as (keyof TotalesCobro['porForma'])[]) t.porForma[k] = r2(t.porForma[k])
  return t
}

/** Link que se le manda al chofer para marcar las entregas desde el celular. */
export const urlChofer = (token: string) => `${typeof window !== 'undefined' ? window.location.origin : 'https://deco-admin.vercel.app'}/chofer/${token}`

export function mensajeLinkChofer(h: { chofer: string | null; fecha: string; nombre: string | null }, url: string): string {
  return (
    `Hola${h.chofer ? ` ${h.chofer.split(' ')[0]}` : ''}! Este es el reparto del ${fmtFechaLarga(h.fecha)}${h.nombre ? ` (${h.nombre})` : ''}.\n` +
    `Abrí este link, seguí el orden y en cada cliente tocá *Entregado* o *No entregado* (con el motivo) y anotá cuánto cobraste:\n${url}\n` +
    `Tip: guardalo en la pantalla de inicio del celular para abrirlo rápido.`
  )
}

// ---------------------------------------------------------------------
// Informe de la ruta (cuando el chofer toca "Terminé el recorrido", migración 16)
// ---------------------------------------------------------------------
type ParadaInforme = Pick<
  Parada,
  'destino' | 'entregado' | 'resultado' | 'motivo' | 'monto_cobrado' | 'forma_pago' | 'nota_entrega' | 'devolucion_detalle' | 'devolucion_motivo' | 'devolucion_monto' | 'monto_factura'
>

/** Hora "HH:MM" en Argentina (24 h). */
export const horaAR = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Argentina/Buenos_Aires' }) : ''

/** Fecha "AAAA-MM-DD" en Argentina de un timestamp. */
export const fechaAR = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }) : '')

/** Resumen en texto para mandar por WhatsApp. */
export function textoInformeRuta(
  h: { fecha: string; nombre: string | null; chofer: string | null; finalizada_at?: string | null; finalizada_por?: string | null },
  paradas: ParadaInforme[],
): string {
  const t = totalesCobro(paradas)
  const l: string[] = []
  l.push(`*Informe de la ruta${h.nombre ? ` – ${h.nombre}` : ''}*`)
  l.push(`${fmtFechaLarga(h.fecha)}${h.chofer ? ` · Chofer: ${h.chofer}` : ''}`)
  if (h.finalizada_at) l.push(`Terminada a las ${horaAR(h.finalizada_at)}${h.finalizada_por && h.finalizada_por !== 'chofer' ? ` (cerró ${h.finalizada_por})` : ' por el chofer'}`)
  l.push('')
  l.push(`✅ Entregados: ${t.entregadas}`)
  if (t.parciales) l.push(`◐ Parciales: ${t.parciales}`)
  if (t.noEntregadas) l.push(`❌ No entregados: ${t.noEntregadas}`)
  if (t.pendientes) l.push(`⏳ Sin marcar: ${t.pendientes}`)
  const parciales = paradas.filter((p) => estadoParada(p) === 'parcial')
  const noEnt = paradas.filter((p) => estadoParada(p) === 'no_entregado')
  const pend = paradas.filter((p) => estadoParada(p) === 'pendiente')
  if (parciales.length) {
    l.push('', '*Entregas parciales:*')
    for (const p of parciales) l.push(`• ${p.destino}${p.motivo ? `: faltó ${p.motivo}` : ''}`)
  }
  if (noEnt.length) {
    l.push('', '*No entregados:*')
    for (const p of noEnt) l.push(`• ${p.destino}${p.motivo ? ` – ${p.motivo}` : ''}`)
  }
  if (pend.length) {
    l.push('', '*Sin marcar:*')
    for (const p of pend) l.push(`• ${p.destino}`)
  }
  l.push('', `*Cobrado: ${fmtMoney(t.cobrado)}*`)
  for (const f of FORMAS_PAGO) if (t.porForma[f.k]) l.push(`   ${f.label}: ${fmtMoney(t.porForma[f.k])}`)
  if (t.porForma.sin_forma) l.push(`   Sin forma de pago: ${fmtMoney(t.porForma.sin_forma)}`)
  const devs = paradas.filter((p) => p.devolucion_detalle)
  if (devs.length) {
    l.push('', `*Devoluciones (${devs.length})${t.devuelto ? `: ${fmtMoney(t.devuelto)}` : ''}*`)
    for (const p of devs)
      l.push(`• ${p.destino}: ${p.devolucion_detalle}${p.devolucion_motivo ? ` (${p.devolucion_motivo})` : ''}${p.devolucion_monto != null ? ` · ${fmtMoney(p.devolucion_monto)}` : ''}`)
  }
  return l.join('\n')
}

export const waInformeRuta = (texto: string) => `https://wa.me/?text=${encodeURIComponent(texto)}`
