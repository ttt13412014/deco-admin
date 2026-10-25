// Tablas que entran en el respaldo completo.

/** Todas las tablas de la app, en orden lógico. */
export const TABLAS: { tabla: string; nombre: string; orden: string; soloGerencia?: boolean }[] = [
  { tabla: 'clientes', nombre: 'Clientes', orden: 'razon_social' },
  { tabla: 'facturas', nombre: 'Facturas', orden: 'fecha_emision' },
  { tabla: 'cobros', nombre: 'Cobros', orden: 'fecha' },
  { tabla: 'gestiones_cobranza', nombre: 'Gestiones de cobranza', orden: 'created_at' },
  { tabla: 'tes_cuentas', nombre: 'Tesorería - Cuentas', orden: 'orden' },
  { tabla: 'tes_categorias', nombre: 'Tesorería - Categorías', orden: 'tipo' },
  { tabla: 'tes_movimientos', nombre: 'Tesorería - Movimientos', orden: 'fecha_prevista' },
  { tabla: 'tes_cheques', nombre: 'Tesorería - Cheques', orden: 'fecha_pago' },
  { tabla: 'tes_extractos', nombre: 'Tesorería - Extractos', orden: 'fecha' },
  { tabla: 'tes_jornadas', nombre: 'Tesorería - Jornadas', orden: 'fecha' },
  { tabla: 'tes_jornada_saldos', nombre: 'Tesorería - Saldos diarios', orden: 'jornada_id' },
  { tabla: 'tes_jornada_eventos', nombre: 'Tesorería - Historial cierres', orden: 'fecha' },
  { tabla: 'tes_simulaciones', nombre: 'Tesorería - Simulaciones', orden: 'created_at' },
  { tabla: 'pag_obligaciones', nombre: 'Cuentas a pagar', orden: 'vencimiento' },
  { tabla: 'cob_promesas', nombre: 'Promesas de pago', orden: 'fecha_promesa' },
  { tabla: 'cob_pagos_informados', nombre: 'Pagos informados', orden: 'created_at' },
  { tabla: 'hist_fechas', nombre: 'Historial de fechas', orden: 'fecha' },
  { tabla: 'imp_lotes', nombre: 'Importaciones Sintesys', orden: 'created_at' },
  { tabla: 'cajas', nombre: 'Caja anterior (histórico)', orden: 'fecha' },
  { tabla: 'movimientos_caja', nombre: 'Mov. caja anterior', orden: 'created_at' },
  { tabla: 'flujo_movimientos', nombre: 'Flujo anterior (histórico)', orden: 'fecha' },
  { tabla: 'productos', nombre: 'Catálogo de productos', orden: 'categoria' },
  { tabla: 'hojas_ruta', nombre: 'Hojas de ruta', orden: 'fecha' },
  { tabla: 'hoja_ruta_paradas', nombre: 'Paradas de reparto', orden: 'hoja_id' },
  { tabla: 'empleados', nombre: 'Empleados', orden: 'apellido' },
  { tabla: 'novedades', nombre: 'Novedades de personal', orden: 'fecha_desde' },
  { tabla: 'perfiles', nombre: 'Usuarios', orden: 'nombre' },
  { tabla: 'auditoria', nombre: 'Auditoría', orden: 'fecha', soloGerencia: true },
]

export const RESPALDO_KEY = 'deco_ultimo_respaldo'
