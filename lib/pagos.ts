// Cuentas a pagar: obligaciones, estados y prioridades.
import { diffDias, hoy } from './utils'

export type EstadoObl = 'pendiente_revision' | 'pendiente_decision' | 'autorizado' | 'programado' | 'reprogramado' | 'pagado' | 'cancelado'
export type Prioridad = 'alta' | 'media' | 'baja'
export type TipoObl = 'proveedor' | 'sueldos' | 'alquiler' | 'servicios' | 'impuestos' | 'gastos' | 'cheque' | 'prestamo' | 'otro'

export interface Obligacion {
  id: string
  origen: 'manual' | 'sintesys'
  clave: string | null
  tipo: TipoObl
  proveedor: string
  cuit: string | null
  categoria_id: string | null
  comprobante: string | null
  concepto: string | null
  fecha_emision: string | null
  vencimiento: string | null
  vencimiento_original: string | null
  fecha_estimada_pago: string | null
  importe: number
  ajuste_previo: number
  pagado: number
  saldo: number
  saldo_sintesys: number | null
  prioridad: Prioridad
  estado: EstadoObl
  cuenta_id: string | null
  medio_previsto: string | null
  plan_id: string | null
  cuota: number | null
  cuotas: number | null
  observaciones: string | null
  motivo: string | null
  decidido_at: string | null
  ult_lote: string | null
  created_at: string
  decisor?: { nombre: string } | null
}

export const ESTADO_OBL: Record<EstadoObl, { label: string; tone: 'amber' | 'blue' | 'green' | 'slate' | 'red' | 'brand' | 'orange' }> = {
  pendiente_revision: { label: 'Pendiente de revisión', tone: 'slate' },
  pendiente_decision: { label: 'Pendiente de decisión', tone: 'amber' },
  autorizado: { label: 'Autorizado', tone: 'blue' },
  programado: { label: 'Programado', tone: 'brand' },
  reprogramado: { label: 'Reprogramado', tone: 'orange' },
  pagado: { label: 'Pagado', tone: 'green' },
  cancelado: { label: 'Cancelado', tone: 'slate' },
}

export const TIPO_OBL: Record<TipoObl, string> = {
  proveedor: 'Proveedor',
  sueldos: 'Sueldos y cargas',
  alquiler: 'Alquiler',
  servicios: 'Servicios públicos',
  impuestos: 'Impuestos',
  gastos: 'Gastos operativos',
  cheque: 'Cheque emitido / diferido',
  prestamo: 'Préstamo / plan de pagos',
  otro: 'Otro',
}

export const PRIORIDAD: Record<Prioridad, { label: string; tone: 'red' | 'amber' | 'slate'; orden: number }> = {
  alta: { label: 'Alta', tone: 'red', orden: 0 },
  media: { label: 'Media', tone: 'amber', orden: 1 },
  baja: { label: 'Baja', tone: 'slate', orden: 2 },
}

export const pagable = (o: Pick<Obligacion, 'estado' | 'saldo'>) => ['autorizado', 'programado', 'reprogramado'].includes(o.estado) && Number(o.saldo) > 0
export const abierta = (o: Pick<Obligacion, 'estado' | 'saldo'>) => o.estado !== 'cancelado' && o.estado !== 'pagado' && Number(o.saldo) > 0

/** Fecha en la que se espera pagar (sin inventar: si no hay ninguna, null). */
export const fechaPago = (o: Pick<Obligacion, 'fecha_estimada_pago' | 'vencimiento'>) => o.fecha_estimada_pago ?? o.vencimiento ?? null

/** Situación que se ve: suma lo que sale de las fechas y los pagos (vencido, parcial). */
export function situacion(o: Obligacion, ref = hoy()): { vencido: boolean; parcial: boolean; dias: number | null } {
  const f = fechaPago(o)
  const venc = o.vencimiento ?? f
  const dias = venc ? diffDias(venc, ref) : null
  return { vencido: abierta(o) && dias !== null && dias < 0, parcial: abierta(o) && Number(o.pagado) > 0, dias }
}

export function ordenarObligaciones(a: Obligacion, b: Obligacion) {
  const fa = fechaPago(a) ?? '9999'
  const fb = fechaPago(b) ?? '9999'
  return fa.localeCompare(fb) || PRIORIDAD[a.prioridad].orden - PRIORIDAD[b.prioridad].orden
}
