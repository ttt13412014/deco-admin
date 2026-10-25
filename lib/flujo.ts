// Flujo de fondos (A08): proyección diaria del saldo a partir del saldo disponible
// y de los movimientos previstos todavía no pagados/cobrados.
import { diffDias, sumarDias } from './utils'

import type { Movimiento } from './tesoreria'
import type { Obligacion } from './pagos'

export type TipoFlujo = 'ingreso' | 'egreso'
export type OrigenProy = 'tesoreria' | 'cobranza' | 'obligacion' | 'transferencia' | 'simulacion'

/** Lo que entra en la proyección: cobros y pagos previstos, cheques y transferencias. */
export interface ItemProy {
  id: string
  origen: OrigenProy
  tipo: TipoFlujo
  fecha: string // fecha en la proyección (las atrasadas pasan a hoy)
  fechaOriginal: string
  concepto: string
  categoria: string
  contraparte: string | null
  monto: number
  estado: string
  atrasado: boolean
  cuenta_id?: string | null
  /** Transferencia propia (real o simulada): mueve plata entre cuentas, no cambia el total. */
  interno?: boolean
  prioridad?: 'alta' | 'media' | 'baja'
  ref?: Movimiento
  obl?: Obligacion
  facturaId?: string
  simId?: string
}

export interface DiaProy {
  fecha: string
  ingresos: number
  egresos: number
  saldo: number // saldo al cierre del día
  items: ItemProy[]
}

export interface Proyeccion {
  dias: DiaProy[]
  saldoInicial: number
  totalIngresos: number
  totalEgresos: number
  saldoFinal: number
  minimo: { fecha: string; saldo: number }
  primerNegativo: string | null
  primerBajoColchon: string | null
  /** Plata que hace falta conseguir para no quedar por debajo del colchón en el horizonte. */
  necesidad: number
}

export function proyectar(opts: {
  saldoInicial: number
  desde: string
  dias: number
  items: Omit<ItemProy, 'fecha' | 'atrasado'>[]
  colchon?: number
}): Proyeccion {
  const { saldoInicial, desde, colchon = 0 } = opts
  const hasta = sumarDias(desde, opts.dias - 1)
  const porDia = new Map<string, ItemProy[]>()
  for (const it of opts.items) {
    if (it.fechaOriginal > hasta) continue
    const atrasado = it.fechaOriginal < desde
    const fecha = atrasado ? desde : it.fechaOriginal
    const arr = porDia.get(fecha) ?? []
    arr.push({ ...it, fecha, atrasado })
    porDia.set(fecha, arr)
  }
  const dias: DiaProy[] = []
  let saldo = saldoInicial
  let totI = 0
  let totE = 0
  let minimo = { fecha: desde, saldo: Infinity }
  let primerNegativo: string | null = null
  let primerBajoColchon: string | null = null
  for (let i = 0; i < opts.dias; i++) {
    const fecha = sumarDias(desde, i)
    const items = (porDia.get(fecha) ?? []).sort((a, b) => (a.tipo === b.tipo ? b.monto - a.monto : a.tipo === 'ingreso' ? -1 : 1))
    const ing = items.filter((x) => x.tipo === 'ingreso' && !x.interno).reduce((a, x) => a + x.monto, 0)
    const egr = items.filter((x) => x.tipo === 'egreso' && !x.interno).reduce((a, x) => a + x.monto, 0)
    saldo = Math.round((saldo + ing - egr) * 100) / 100
    totI += ing
    totE += egr
    if (saldo < minimo.saldo) minimo = { fecha, saldo }
    if (saldo < 0 && !primerNegativo) primerNegativo = fecha
    if (saldo < colchon && !primerBajoColchon) primerBajoColchon = fecha
    dias.push({ fecha, ingresos: ing, egresos: egr, saldo, items })
  }
  return {
    dias,
    saldoInicial,
    totalIngresos: totI,
    totalEgresos: totE,
    saldoFinal: saldo,
    minimo,
    primerNegativo,
    primerBajoColchon,
    necesidad: Math.max(0, colchon - minimo.saldo),
  }
}

/** Lunes de la semana de una fecha. */
export function lunesDe(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0 = domingo
  return sumarDias(iso, dow === 0 ? -6 : 1 - dow)
}

export interface SemanaProy {
  desde: string
  hasta: string
  ingresos: number
  egresos: number
  saldoFinal: number
  saldoMinimo: number
  diaMinimo: string
  items: ItemProy[]
}

export function agruparSemanas(p: Proyeccion): SemanaProy[] {
  const out: SemanaProy[] = []
  for (const d of p.dias) {
    const l = lunesDe(d.fecha)
    let s = out[out.length - 1]
    if (!s || lunesDe(s.desde) !== l) {
      s = { desde: d.fecha, hasta: d.fecha, ingresos: 0, egresos: 0, saldoFinal: d.saldo, saldoMinimo: d.saldo, diaMinimo: d.fecha, items: [] }
      out.push(s)
    }
    s.hasta = d.fecha
    s.ingresos += d.ingresos
    s.egresos += d.egresos
    s.saldoFinal = d.saldo
    if (d.saldo < s.saldoMinimo) (s.saldoMinimo = d.saldo), (s.diaMinimo = d.fecha)
    s.items.push(...d.items)
  }
  return out
}

/** Fechas para movimientos que se repiten. */
export function fechasRepetidas(inicio: string, cada: 'semanal' | 'quincenal' | 'mensual', veces: number): string[] {
  const out: string[] = []
  const [y, m, d] = inicio.split('-').map(Number)
  for (let i = 0; i < veces; i++) {
    if (cada === 'semanal') out.push(sumarDias(inicio, 7 * i))
    else if (cada === 'quincenal') out.push(sumarDias(inicio, 14 * i))
    else {
      const mm = m - 1 + i
      const yy = y + Math.floor(mm / 12)
      const mes = ((mm % 12) + 12) % 12
      const ult = new Date(Date.UTC(yy, mes + 1, 0)).getUTCDate()
      out.push(`${yy}-${String(mes + 1).padStart(2, '0')}-${String(Math.min(d, ult)).padStart(2, '0')}`)
    }
  }
  return out
}

/** Nivel de alerta de un saldo. */
export function nivelSaldo(saldo: number, colchon: number): 'negativo' | 'bajo' | 'ok' {
  if (saldo < 0) return 'negativo'
  if (saldo < colchon) return 'bajo'
  return 'ok'
}

export const diasEntre = (a: string, b: string) => diffDias(b, a)

// ---------------------------------------------------------------------
// Proyección por cuenta, alertas de faltante y reserva mínima
// ---------------------------------------------------------------------
export interface CuentaProy {
  id: string
  nombre: string
  reserva: number
}

export interface Alerta {
  tipo: 'faltante_total' | 'faltante_cuenta' | 'reserva'
  cuenta_id: string | null
  fecha: string // primer día con el problema
  minimo: number // saldo más bajo
  minFecha: string
  falta: number // lo que hace falta para no quedar en negativo / bajo la reserva
  motivo: ItemProy[] // los egresos más grandes hasta ese día en esa cuenta
  revisar: ItemProy[] // pagos (obligaciones) hasta ese día, por vencimiento y prioridad
}

export interface ProyCuentas {
  porCuenta: Map<string, Proyeccion>
  total: Proyeccion
  sinFecha: ItemProy[]
  alertas: Alerta[]
}

const PRIO = { alta: 0, media: 1, baja: 2 } as const

/** Saldo día por día de cada cuenta y del total. Los ítems sin cuenta van a la cuenta por defecto; sin fecha no se ubican. */
export function proyectarCuentas(opts: {
  cuentas: CuentaProy[]
  saldos: Record<string, number>
  items: Omit<ItemProy, 'fecha' | 'atrasado'>[]
  desde: string
  dias: number
  sinFecha: ItemProy[]
  cuentaDefault: { ingreso: string; egreso: string }
}): ProyCuentas {
  const { cuentas, saldos, desde, dias, cuentaDefault } = opts
  const porCuenta = new Map<string, Proyeccion>()
  for (const c of cuentas) {
    const its = opts.items.filter((it) => (it.cuenta_id || (it.tipo === 'ingreso' ? cuentaDefault.ingreso : cuentaDefault.egreso)) === c.id)
    // dentro de una sola cuenta, una transferencia sí es entrada o salida
    porCuenta.set(c.id, proyectar({ saldoInicial: saldos[c.id] ?? 0, desde, dias, items: its.map((x) => ({ ...x, interno: false })), colchon: c.reserva }))
  }
  const total = proyectar({ saldoInicial: cuentas.reduce((a, c) => a + (saldos[c.id] ?? 0), 0), desde, dias, items: opts.items, colchon: 0 })

  const alertas: Alerta[] = []
  const egresosHasta = (cid: string | null, hasta: string) => {
    const lista: ItemProy[] = []
    const fuente = cid ? porCuenta.get(cid)! : total
    for (const d of fuente.dias) {
      if (d.fecha > hasta) break
      for (const it of d.items) if (it.tipo === 'egreso' && !(cid === null && it.interno)) lista.push(it)
    }
    return lista
  }
  const armar = (tipo: Alerta['tipo'], cid: string | null, p: Proyeccion, umbral: number) => {
    const primero = p.dias.find((d) => d.saldo < umbral)
    if (!primero) return
    let min = { fecha: primero.fecha, saldo: primero.saldo }
    for (const d of p.dias) if (d.saldo < min.saldo) min = { fecha: d.fecha, saldo: d.saldo }
    const eg = egresosHasta(cid, primero.fecha)
    alertas.push({
      tipo,
      cuenta_id: cid,
      fecha: primero.fecha,
      minimo: min.saldo,
      minFecha: min.fecha,
      falta: Math.round((umbral - min.saldo) * 100) / 100,
      motivo: [...eg].sort((a, b) => b.monto - a.monto).slice(0, 3),
      revisar: eg
        .filter((x) => x.origen === 'obligacion')
        .sort((a, b) => a.fechaOriginal.localeCompare(b.fechaOriginal) || PRIO[b.prioridad ?? 'media'] - PRIO[a.prioridad ?? 'media'])
        .slice(0, 6),
    })
  }
  armar('faltante_total', null, total, 0)
  for (const c of cuentas) {
    const p = porCuenta.get(c.id)!
    armar('faltante_cuenta', c.id, p, 0)
    if (c.reserva > 0) armar('reserva', c.id, p, c.reserva)
  }
  return { porCuenta, total, sinFecha: opts.sinFecha, alertas }
}

export interface MesProy {
  mes: string // YYYY-MM
  ingresos: number
  egresos: number
  saldoFinal: number
  saldoMinimo: number
  diaMinimo: string
}

export function agruparMeses(p: Proyeccion): MesProy[] {
  const out: MesProy[] = []
  for (const d of p.dias) {
    const m = d.fecha.slice(0, 7)
    let x = out[out.length - 1]
    if (!x || x.mes !== m) {
      x = { mes: m, ingresos: 0, egresos: 0, saldoFinal: d.saldo, saldoMinimo: d.saldo, diaMinimo: d.fecha }
      out.push(x)
    }
    x.ingresos += d.ingresos
    x.egresos += d.egresos
    x.saldoFinal = d.saldo
    if (d.saldo < x.saldoMinimo) (x.saldoMinimo = d.saldo), (x.diaMinimo = d.fecha)
  }
  return out
}
