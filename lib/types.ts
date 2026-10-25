import type { ComprobanteRuta } from './factura-pdf'
import type { TipoVenta } from './comprobantes'

export type Rol = 'administracion' | 'ventas' | 'gerencia' | 'pendiente'

export interface Perfil {
  id: string
  nombre: string
  email: string | null
  rol: Rol
  /** Secciones que ve (migración 18). null = las que trae su rol. */
  secciones?: string[] | null
}

export type EstadoCliente = 'activo' | 'pendiente' | 'inhabilitado'

export interface Cliente {
  id: string
  razon_social: string
  cuit_dni: string | null
  condicion_iva: string | null
  tipo_factura: string | null
  contacto_nombre: string | null
  telefono: string | null
  email: string | null
  direccion: string | null
  localidad: string | null
  provincia: string | null
  ubicacion: string | null
  lat: number | null
  lng: number | null
  horarios: string | null
  /** Horario de atención para ordenar la ruta (migración 14). "HH:MM" o null. */
  horario_desde?: string | null
  horario_hasta?: string | null
  /** Segundo horario (horario cortado). */
  horario2_desde?: string | null
  horario2_hasta?: string | null
  medio_pago_preferido: string | null
  estado: EstadoCliente
  observaciones: string | null
  created_at: string
  created_by: string | null
  updated_at: string
  updated_by: string | null
}

export interface ClienteSaldo extends Cliente {
  saldo: number
  vencido: number
  facturas_pendientes: number
}

export interface Factura {
  id: string
  cliente_id: string
  tipo_comprobante: string
  /** Tipo de comprobante de venta (migración 10). */
  tipo?: TipoVenta
  /** +1 suma a la deuda, −1 resta (NC / anula presupuesto). Calculado en la base. */
  signo?: 1 | -1
  numero: string
  fecha_emision: string
  fecha_vencimiento: string
  condicion_venta: 'Contado' | 'Cuenta corriente'
  medio_pago_acordado: string
  monto: number
  saldo: number
  estado: 'pendiente' | 'cobrado' | 'anulada'
  fecha_cobro: string | null
  observaciones: string | null
  created_at: string
  origen?: 'manual' | 'sintesys'
  vendedor?: string | null
  vencimiento_original?: string | null
  fecha_estimada_cobro?: string | null
  ajuste_previo?: number
  saldo_sintesys?: number | null
  ult_lote?: string | null
  cliente?: Pick<Cliente, 'id' | 'razon_social' | 'contacto_nombre' | 'telefono' | 'cuit_dni'> | null
}

export interface Cobro {
  id: string
  factura_id: string
  fecha: string
  monto: number
  medio_pago: string
  referencia: string | null
  observaciones: string | null
  created_at: string
  autor?: { nombre: string } | null
}

export type TipoGestion =
  | 'aviso_preventivo' | 'aviso_vencimiento' | 'aviso_atraso'
  | 'respuesta_cliente' | 'informe_ventas' | 'escalado_gerencia' | 'otro'

export interface Gestion {
  id: string
  factura_id: string | null
  cliente_id: string
  tipo: TipoGestion
  nota: string | null
  created_at: string
  autor?: { nombre: string } | null
}

export interface Caja {
  id: string
  fecha: string
  saldo_inicial: number
  efectivo_teorico: number | null
  efectivo_contado: number | null
  diferencia: number | null
  justificacion: string | null
  observaciones: string | null
  checklist: Record<string, boolean>
  estado: 'abierta' | 'cerrada'
  created_at: string
  cerrada_at: string | null
  abridor?: { nombre: string } | null
  cerrador?: { nombre: string } | null
}

export interface Movimiento {
  id: string
  caja_id: string
  tipo: 'ingreso' | 'egreso'
  concepto: string
  monto: number
  medio: string
  comprobante: string | null
  cobro_id: string | null
  created_at: string
  autor?: { nombre: string } | null
}

export interface HojaRuta {
  id: string
  fecha: string
  nombre: string | null
  chofer: string | null
  chofer_telefono: string | null
  origen: string
  volver_origen: boolean
  estado: 'borrador' | 'en_curso' | 'completada'
  observaciones: string | null
  /** Migración 14: hora de salida ("HH:MM"), minutos por parada y link del chofer. pago_repartidor ya no se usa (el chofer cobra sueldo). */
  hora_salida?: string | null
  min_por_parada?: number | null
  pago_repartidor?: number | null
  token_chofer?: string | null
  /** Migración 16: cuándo se terminó el recorrido y quién ('chofer' o el nombre de quien la cerró). */
  finalizada_at?: string | null
  finalizada_por?: string | null
  created_at: string
  autor?: { nombre: string } | null
  paradas?: Parada[]
}

export interface Parada {
  id?: string
  orden?: number
  cliente_id: string | null
  destino: string
  direccion: string
  telefono: string | null
  que_lleva: string | null
  bultos: number | null
  observaciones: string | null
  entregado: boolean
  entregado_at: string | null
  nota_entrega: string | null
  lat: number | null
  lng: number | null
  /** Monto de factura de la parada (las notas de crédito restan). Requiere migración 09. */
  monto_factura?: number | null
  /** Facturas / notas de crédito leídas de PDF. Requiere migración 09. */
  comprobantes?: ComprobanteRuta[] | null
  /** Migración 14: lo que marca el chofer (o la oficina). null = pendiente. */
  resultado?: 'entregado' | 'parcial' | 'no_entregado' | null
  motivo?: string | null
  monto_cobrado?: number | null
  forma_pago?: FormaPago | null
  marcado_at?: string | null
  marcado_por?: string | null
  /** Hora estimada de llegada ("HH:MM"), calculada al ordenar/guardar. */
  llegada_estimada?: string | null
  /** Migración 15: el cliente devolvió mercadería (hay devolución si hay detalle). */
  devolucion_detalle?: string | null
  devolucion_motivo?: string | null
  devolucion_monto?: number | null
}

export type FormaPago = 'efectivo' | 'transferencia' | 'cheque' | 'mixto'

export interface Producto {
  id: string
  codigo: string | null
  nombre: string
  descripcion: string | null
  categoria: string | null
  /** Sub rubro dentro de la categoría (ej: DESCARTABLES → GASTRONÓMICOS). Opcional. */
  subcategoria: string | null
  /** Medida o presentación (ej: 50x60, 500 cc, x 10 u.) */
  medida: string | null
  precio: number | null
  imagen_url: string | null
  activo: boolean
  orden: number
  created_at: string
  updated_at: string
}
