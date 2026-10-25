'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { sb, errMsg } from '@/lib/supabase'
import { fmtFecha, fmtFechaLarga, fmtMoney, hoy, sumarDias } from '@/lib/utils'
import {
  Categoria, Cheque, Cuenta, Disponible, ESTADO_CHEQUE, Jornada, Movimiento, cargarBase, diasHasta, disponibilidad, resumenPorCuenta,
} from '@/lib/tesoreria'
import { useAuth } from '@/components/AuthProvider'
import { ANCHOS_CHQ, ANCHOS_MOV, AccionMov, EjecutarForm, MovTabla, MovimientoForm, accionRapida, exportarExcel, filasCheques, filasMovimientos } from '@/components/Tesoreria'
import { Alert, Badge, Button, Card, Empty, Modal, PageHeader, Spinner, Stat, Table, cx, td, th } from '@/components/ui'
import type { Celda } from '@/lib/xlsx-lite'
import type { TipoMov } from '@/lib/tesoreria'
import { Obligacion, abierta, fechaPago, pagable } from '@/lib/pagos'

const MOV_SELECT = '*, autor:perfiles!created_by(nombre)'
const JOR_SELECT = '*, saldos:tes_jornada_saldos(*), abridor:perfiles!abierta_por(nombre), cerrador:perfiles!cerrada_por(nombre)'

export default function TesoreriaPage() {
  const { puedeEditar } = useAuth()
  const ref = hoy()
  const [base, setBase] = useState<{ cuentas: Cuenta[]; categorias: Categoria[] } | null>(null)
  const [disp, setDisp] = useState<Disponible[]>([])
  const [movsHoy, setMovsHoy] = useState<Movimiento[]>([])
  const [pend, setPend] = useState<Movimiento[]>([])
  const [obls, setObls] = useState<Obligacion[]>([])
  const [cheques, setCheques] = useState<Cheque[]>([])
  const [sinConciliar, setSinConciliar] = useState<Movimiento[]>([])
  const [extPend, setExtPend] = useState<{ cuenta_id: string; importe: number }[]>([])
  const [jornadas, setJornadas] = useState<Jornada[]>([])
  const [nuevo, setNuevo] = useState<TipoMov | null>(null)
  const [editar, setEditar] = useState<Movimiento | null>(null)
  const [ejecutar, setEjecutar] = useState<Movimiento | null>(null)
  const [msg, setMsg] = useState<{ tone: 'green' | 'red' | 'amber' | 'blue'; text: string } | null>(null)

  const cargar = useCallback(async () => {
    const s = sb()
    try {
      const [b, d, h, p, c, nc, ex, j, o] = await Promise.all([
        cargarBase(),
        disponibilidad(ref),
        s.from('tes_movimientos').select(MOV_SELECT).eq('estado', 'realizado').eq('fecha_efectiva', ref).order('created_at'),
        s.from('tes_movimientos').select(MOV_SELECT).in('estado', ['pendiente', 'autorizado']).order('fecha_prevista'),
        s.from('tes_cheques').select('*').in('estado', ['en_cartera', 'depositado', 'emitido']).order('fecha_pago'),
        s.from('tes_movimientos').select(MOV_SELECT).eq('estado', 'realizado').eq('conciliado', false).not('cuenta_id', 'is', null).gte('fecha_efectiva', sumarDias(ref, -90)).order('fecha_efectiva'),
        s.from('tes_extractos').select('cuenta_id,importe').eq('estado', 'pendiente'),
        s.from('tes_jornadas').select(JOR_SELECT).gte('fecha', sumarDias(ref, -45)).order('fecha', { ascending: false }),
        s.from('pag_obligaciones').select('*').not('estado', 'in', '(pagado,cancelado)'),
      ])
      setObls(((o.data as Obligacion[]) ?? []).filter(abierta))
      setBase(b)
      setDisp(d)
      setMovsHoy((h.data as Movimiento[]) ?? [])
      setPend((p.data as Movimiento[]) ?? [])
      setCheques((c.data as Cheque[]) ?? [])
      const bancos = new Set(b.cuentas.filter((x) => x.tipo === 'banco').map((x) => x.id))
      setSinConciliar(((nc.data as Movimiento[]) ?? []).filter((m) => m.cuenta_id && bancos.has(m.cuenta_id)))
      setExtPend((ex.data as { cuenta_id: string; importe: number }[]) ?? [])
      setJornadas((j.data as Jornada[]) ?? [])
    } catch (e) {
      setMsg({ tone: 'red', text: errMsg(e) })
      setBase((x) => x ?? { cuentas: [], categorias: [] })
    }
  }, [ref])

  useEffect(() => {
    if (puedeEditar) cargar()
  }, [cargar, puedeEditar])

  const porCuenta = useMemo(() => {
    const r = new Map<string, { cartera: number; emitidos: number; autorizados: number; aCobrar: number }>()
    const get = (id: string) => r.get(id) ?? (r.set(id, { cartera: 0, emitidos: 0, autorizados: 0, aCobrar: 0 }), r.get(id)!)
    for (const c of cheques) {
      if (!c.cuenta_id) continue
      if (c.sentido === 'recibido') get(c.cuenta_id).cartera += Number(c.importe)
      else get(c.cuenta_id).emitidos += Number(c.importe)
    }
    for (const m of pend) {
      if (!m.cuenta_id || m.cheque_id) continue
      if (m.tipo === 'transferencia' && m.estado === 'pendiente') {
        // transferencia propia que todavía no salió o no se acreditó
        if (m.sentido === 'entrada') get(m.cuenta_id).aCobrar += Number(m.importe)
        else get(m.cuenta_id).autorizados += Number(m.importe)
        continue
      }
      if (m.tipo === 'egreso' && m.estado === 'autorizado' && m.fecha_prevista <= sumarDias(ref, 7) && !m.obligacion_id) get(m.cuenta_id).autorizados += Number(m.importe)
      if (m.tipo === 'ingreso' && m.estado === 'pendiente' && m.fecha_prevista <= sumarDias(ref, 7)) get(m.cuenta_id).aCobrar += Number(m.importe)
    }
    const defPago = base?.cuentas.find((c) => c.pago_default)?.id
    for (const o of obls) {
      const f = fechaPago(o)
      const cid = o.cuenta_id ?? defPago
      if (cid && pagable(o) && f && f <= sumarDias(ref, 7)) get(cid).autorizados += Number(o.saldo)
    }
    return r
  }, [cheques, pend, obls, base, ref])

  if (!puedeEditar) return <Empty>Tesorería es exclusiva de Administración y Gerencia.</Empty>
  if (!base) return <Spinner />
  const { cuentas, categorias } = base

  const total = disp.reduce((a, d) => a + d.saldo, 0)
  const sumar = (k: 'cartera' | 'emitidos' | 'autorizados' | 'aCobrar') => Array.from(porCuenta.values()).reduce((a, x) => a + x[k], 0)
  const proyectado = (id: string, saldo: number) => {
    const x = porCuenta.get(id)
    return saldo + (x ? x.cartera + x.aCobrar - x.emitidos - x.autorizados : 0)
  }
  const resHoy = resumenPorCuenta(movsHoy, ref, ref)
  const ingHoy = movsHoy.filter((m) => m.tipo === 'ingreso').reduce((a, m) => a + Number(m.importe), 0)
  const egrHoy = movsHoy.filter((m) => m.tipo === 'egreso').reduce((a, m) => a + Number(m.importe), 0)
  const jHoy = jornadas.find((j) => j.fecha === ref)
  const jAbiertaVieja = jornadas.filter((j) => j.fecha < ref && j.estado === 'abierta').at(-1)
  const proxCheques = cheques.filter((c) => c.fecha_pago <= sumarDias(ref, 7))
  const chequesVencidos = cheques.filter((c) => c.fecha_pago < ref)
  const porAutorizar = pend.filter((m) => m.tipo === 'egreso' && m.estado === 'pendiente')
  const paraDecidir = obls.filter((o) => o.estado === 'pendiente_decision' || o.estado === 'pendiente_revision')
  const diferencias = jornadas
    .filter((j) => j.estado === 'cerrada')
    .flatMap((j) => (j.saldos ?? []).filter((s) => Number(s.diferencia ?? 0) !== 0).map((s) => ({ j, s })))
  const nombreCuenta = (id: string | null) => cuentas.find((c) => c.id === id)?.nombre ?? '—'
  const extPorCuenta = (id: string) => extPend.filter((e) => e.cuenta_id === id)
  const ncPorCuenta = (id: string) => sinConciliar.filter((m) => m.cuenta_id === id)

  async function accion(a: AccionMov, m: Movimiento) {
    setMsg(null)
    if (a === 'editar') return setEditar(m)
    if (a === 'ejecutar') return setEjecutar(m)
    try {
      const t = await accionRapida(a, m)
      if (t) setMsg({ tone: 'green', text: t })
      cargar()
    } catch (e) {
      setMsg({ tone: 'red', text: errMsg(e) })
    }
  }
  const listo = (cerrar: () => void) => (t: string) => {
    cerrar()
    setMsg({ tone: 'green', text: t })
    cargar()
  }

  function exportar() {
    const dispFilas: Celda[][] = [
      ['Cuenta', 'Disponible', 'Cheques a acreditar (+)', 'Cobros previstos 7 días (+)', 'Cheques emitidos a debitar (−)', 'Pagos autorizados 7 días (−)', 'Proyectado'],
      ...disp.map((d) => {
        const x = porCuenta.get(d.cuenta_id)
        return [d.nombre, d.saldo, x?.cartera ?? 0, x?.aCobrar ?? 0, x?.emitidos ?? 0, x?.autorizados ?? 0, proyectado(d.cuenta_id, d.saldo)]
      }),
      ['TOTAL', total, sumar('cartera'), sumar('aCobrar'), sumar('emitidos'), sumar('autorizados'), disp.reduce((a, d) => a + proyectado(d.cuenta_id, d.saldo), 0)],
    ]
    const hoyFilas: Celda[][] = [
      ['Cuenta', 'Ingresos', 'Egresos', 'Transferencias recibidas', 'Transferencias enviadas'],
      ...cuentas.map((c) => {
        const r = resHoy.get(c.id)
        return [c.nombre, r?.ingresos ?? 0, r?.egresos ?? 0, r?.transfEntrada ?? 0, r?.transfSalida ?? 0]
      }),
    ]
    const conc: Celda[][] = [
      ['Cuenta', 'Fecha', 'Concepto', 'Importe', 'Situación'],
      ...sinConciliar.map((m) => [nombreCuenta(m.cuenta_id), fmtFecha(m.fecha_efectiva), m.concepto, m.sentido === 'entrada' ? Number(m.importe) : -Number(m.importe), 'Cargado, falta verlo en el extracto']),
    ]
    const dif: Celda[][] = [
      ['Fecha', 'Cuenta', 'Saldo inicial', 'Esperado', 'Real', 'Diferencia', 'Justificación', 'Cerró'],
      ...diferencias.map(({ j, s }) => [fmtFecha(j.fecha), nombreCuenta(s.cuenta_id), Number(s.saldo_inicial), Number(s.saldo_esperado), Number(s.saldo_real), Number(s.diferencia), s.justificacion ?? '', j.cerrador?.nombre ?? '']),
    ]
    exportarExcel(`tesoreria-${ref}`, [
      { nombre: 'Disponibilidad', filas: dispFilas, anchos: [20, 16, 20, 22, 24, 20, 16] },
      { nombre: 'Movimientos de hoy', filas: filasMovimientos(movsHoy, cuentas, categorias), anchos: ANCHOS_MOV },
      { nombre: 'Resumen de hoy', filas: hoyFilas, anchos: [20, 14, 14, 22, 22] },
      { nombre: 'Previstos', filas: filasMovimientos(pend, cuentas, categorias), anchos: ANCHOS_MOV },
      { nombre: 'Cheques pendientes', filas: filasCheques(cheques, cuentas), anchos: ANCHOS_CHQ },
      { nombre: 'Sin conciliar', filas: conc, anchos: [18, 12, 40, 14, 34] },
      { nombre: 'Diferencias de cierre', filas: dif, anchos: [12, 18, 14, 14, 14, 14, 40, 16] },
    ])
  }

  return (
    <>
      <PageHeader
        title="Tesorería"
        subtitle={<span className="capitalize">{fmtFechaLarga(ref)}</span>}
        actions={
          <>
            <Button variant="success" onClick={() => setNuevo('ingreso')}>
              + Ingreso
            </Button>
            <Button variant="danger" onClick={() => setNuevo('egreso')}>
              + Egreso
            </Button>
            <Button variant="secondary" onClick={() => setNuevo('transferencia')}>
              ⇄ Transferencia
            </Button>
            <Button variant="secondary" onClick={exportar}>
              Excel
            </Button>
          </>
        }
      />

      {msg && (
        <Alert tone={msg.tone} className="mb-4">
          {msg.text}
        </Alert>
      )}

      {jAbiertaVieja ? (
        <Alert tone="red" className="mb-4">
          La jornada del <b>{fmtFecha(jAbiertaVieja.fecha)}</b> sigue abierta. No se postergan cierres (A06).{' '}
          <Link href={`/tesoreria/jornada?fecha=${jAbiertaVieja.fecha}`} className="font-medium underline">
            Cerrarla
          </Link>
        </Alert>
      ) : !jHoy ? (
        <Alert tone="amber" className="mb-4">
          Todavía no se abrió la jornada de hoy.{' '}
          <Link href="/tesoreria/jornada" className="font-medium underline">
            Abrir con los saldos de efectivo, Galicia y Macro
          </Link>
        </Alert>
      ) : jHoy.estado === 'cerrada' ? (
        <Alert tone="green" className="mb-4">
          Jornada de hoy cerrada{jHoy.cerrador?.nombre ? ` por ${jHoy.cerrador.nombre}` : ''}.
        </Alert>
      ) : null}

      {/* Disponibilidad */}
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {disp.map((d) => (
          <Stat key={d.cuenta_id} label={d.nombre} value={<span className={d.saldo < 0 ? 'text-red-700' : ''}>{fmtMoney(d.saldo)}</span>} sub={`Proyectado ${fmtMoney(proyectado(d.cuenta_id, d.saldo))}`} tone={d.tipo === 'efectivo' ? 'green' : 'brand'} />
        ))}
        <Stat label="Disponible total" value={fmtMoney(total)} sub={`Proyectado ${fmtMoney(disp.reduce((a, d) => a + proyectado(d.cuenta_id, d.saldo), 0))}`} tone="slate" />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="lg:col-span-2" title="Disponible y proyectado por cuenta" subtitle="Los cheques recibidos no son plata disponible hasta que se acreditan. Los emitidos se descuentan cuando se debitan." pad={false}>
          <Table>
            <thead>
              <tr>
                <th className={th}>Cuenta</th>
                <th className={`${th} text-right`}>Disponible</th>
                <th className={`${th} text-right`}>+ Cheques</th>
                <th className={`${th} text-right`}>− Comprometido</th>
                <th className={`${th} text-right`}>Proyectado</th>
              </tr>
            </thead>
            <tbody>
              {disp.map((d) => {
                const x = porCuenta.get(d.cuenta_id)
                return (
                  <tr key={d.cuenta_id}>
                    <td className={`${td} font-medium`}>{d.nombre}</td>
                    <td className={cx(td, 'text-right tabular-nums', d.saldo < 0 && 'text-red-700')}>{fmtMoney(d.saldo)}</td>
                    <td className={`${td} text-right tabular-nums text-emerald-700`}>{x && x.cartera + x.aCobrar ? fmtMoney(x.cartera + x.aCobrar) : '—'}</td>
                    <td className={`${td} text-right tabular-nums text-red-700`}>{x && x.emitidos + x.autorizados ? fmtMoney(x.emitidos + x.autorizados) : '—'}</td>
                    <td className={`${td} text-right font-semibold tabular-nums`}>{fmtMoney(proyectado(d.cuenta_id, d.saldo))}</td>
                  </tr>
                )
              })}
              <tr className="bg-slate-50 font-semibold">
                <td className={td}>Total</td>
                <td className={`${td} text-right tabular-nums`}>{fmtMoney(total)}</td>
                <td className={`${td} text-right tabular-nums text-emerald-700`}>{fmtMoney(sumar('cartera') + sumar('aCobrar'))}</td>
                <td className={`${td} text-right tabular-nums text-red-700`}>{fmtMoney(sumar('emitidos') + sumar('autorizados'))}</td>
                <td className={`${td} text-right tabular-nums`}>{fmtMoney(disp.reduce((a, d) => a + proyectado(d.cuenta_id, d.saldo), 0))}</td>
              </tr>
            </tbody>
          </Table>
          <p className="px-4 py-2 text-xs text-slate-500">
            + Cheques: recibidos en cartera o depositados, y cobros previstos de los próximos 7 días. − Comprometido: cheques emitidos sin debitar y pagos autorizados de los próximos 7 días. Para más adelante, mirá el Flujo de fondos.
          </p>
        </Card>

        <Card
          title="Hoy"
          subtitle={`Ingresos ${fmtMoney(ingHoy)} · Egresos ${fmtMoney(egrHoy)} · las transferencias propias van aparte`}
          pad={false}
          actions={
            <Link href="/tesoreria/jornada" className="text-sm font-medium text-brand-700 hover:underline">
              {jHoy?.estado === 'abierta' ? 'Cerrar jornada →' : 'Jornada →'}
            </Link>
          }
        >
          <Table>
            <thead>
              <tr>
                <th className={th}>Cuenta</th>
                <th className={`${th} text-right`}>Ingresos</th>
                <th className={`${th} text-right`}>Egresos</th>
                <th className={`${th} text-right`}>Transf. ±</th>
              </tr>
            </thead>
            <tbody>
              {cuentas
                .filter((c) => c.activa)
                .map((c) => {
                  const r = resHoy.get(c.id)
                  const t = (r?.transfEntrada ?? 0) - (r?.transfSalida ?? 0)
                  return (
                    <tr key={c.id}>
                      <td className={`${td} font-medium`}>{c.nombre}</td>
                      <td className={`${td} text-right tabular-nums text-emerald-700`}>{r?.ingresos ? fmtMoney(r.ingresos) : '—'}</td>
                      <td className={`${td} text-right tabular-nums text-red-700`}>{r?.egresos ? fmtMoney(r.egresos) : '—'}</td>
                      <td className={`${td} text-right tabular-nums text-sky-700`}>{t ? `${t > 0 ? '+' : '−'} ${fmtMoney(Math.abs(t))}` : '—'}</td>
                    </tr>
                  )
                })}
            </tbody>
          </Table>
        </Card>

        <Card
          title="Pendientes de conciliación"
          subtitle="Bancos: lo cargado que todavía no se vio en el extracto y lo del extracto que no se identificó"
          pad={false}
          actions={
            <Link href="/tesoreria/bancos" className="text-sm font-medium text-brand-700 hover:underline">
              Conciliar →
            </Link>
          }
        >
          <Table>
            <thead>
              <tr>
                <th className={th}>Banco</th>
                <th className={`${th} text-right`}>Cargado sin ver en el banco</th>
                <th className={`${th} text-right`}>Extracto sin identificar</th>
              </tr>
            </thead>
            <tbody>
              {cuentas
                .filter((c) => c.tipo === 'banco' && c.activa)
                .map((c) => {
                  const a = ncPorCuenta(c.id)
                  const e = extPorCuenta(c.id)
                  return (
                    <tr key={c.id}>
                      <td className={`${td} font-medium`}>{c.nombre}</td>
                      <td className={`${td} text-right tabular-nums`}>
                        {a.length ? (
                          <>
                            {a.length} <span className="text-xs text-slate-500">({fmtMoney(a.reduce((s, m) => s + (m.sentido === 'entrada' ? 1 : -1) * Number(m.importe), 0))})</span>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className={cx(td, 'text-right tabular-nums', e.length > 0 && 'font-semibold text-amber-800')}>
                        {e.length ? (
                          <>
                            {e.length} <span className="text-xs font-normal">({fmtMoney(e.reduce((s, x) => s + Number(x.importe), 0))})</span>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  )
                })}
            </tbody>
          </Table>
        </Card>
        <Card
          className="lg:col-span-2"
          title="Cheques próximos"
          subtitle="Vencen en los próximos 7 días o ya están vencidos sin acreditar/debitar"
          pad={false}
          actions={
            <Link href="/tesoreria/cheques" className="text-sm font-medium text-brand-700 hover:underline">
              Cheques →
            </Link>
          }
        >
          {proxCheques.length === 0 ? (
            <Empty>No hay cheques para los próximos 7 días.</Empty>
          ) : (
            <ul className="divide-y divide-slate-100">
              {proxCheques.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                  <span className={cx('h-2 w-2 shrink-0 rounded-full', c.sentido === 'recibido' ? 'bg-emerald-500' : 'bg-red-500')} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">
                      {c.sentido === 'recibido' ? 'Recibido' : 'Emitido'} N° {c.numero} · {c.contraparte}
                    </div>
                    <div className={cx('text-xs', c.fecha_pago < ref ? 'font-medium text-red-600' : 'text-slate-500')}>
                      {fmtFecha(c.fecha_pago)} ({diasHasta(c.fecha_pago)}) · {nombreCuenta(c.cuenta_id)}
                    </div>
                  </div>
                  <Badge tone={ESTADO_CHEQUE[c.estado].tone}>{ESTADO_CHEQUE[c.estado].label}</Badge>
                  <span className={cx('font-semibold tabular-nums', c.sentido === 'recibido' ? 'text-emerald-700' : 'text-red-700')}>{fmtMoney(c.importe)}</span>
                </li>
              ))}
            </ul>
          )}
          {chequesVencidos.length > 0 && (
            <p className="border-t border-slate-100 px-4 py-2 text-xs text-red-700">
              {chequesVencidos.length} con fecha de pago pasada: confirmá si se acreditaron o debitaron.
            </p>
          )}
        </Card>

      </div>

      {paraDecidir.length > 0 && (
        <Alert tone="blue" className="mt-5">
          Hay <b>{paraDecidir.length}</b> pagos esperando la decisión de los dueños por {fmtMoney(paraDecidir.reduce((a, o) => a + Number(o.saldo), 0))}.{' '}
          <Link href="/pagos" className="font-medium underline">
            Ir a Cuentas a pagar
          </Link>
        </Alert>
      )}
      {porAutorizar.length > 0 && (
        <Card className="mt-5" title={`Pagos por autorizar cargados en Tesorería (${porAutorizar.length})`} pad={false}>
          <MovTabla movs={porAutorizar} cuentas={cuentas} categorias={categorias} onAccion={accion} />
        </Card>
      )}

      <Card
        className="mt-5"
        title="Movimientos de hoy"
        pad={false}
        actions={
          <Link href="/tesoreria/movimientos" className="text-sm font-medium text-brand-700 hover:underline">
            Todos los movimientos →
          </Link>
        }
      >
        <MovTabla movs={movsHoy} cuentas={cuentas} categorias={categorias} onAccion={accion} vacio="Todavía no hay movimientos realizados hoy." />
      </Card>

      {diferencias.length > 0 && (
        <Card className="mt-5" title="Diferencias de cierre (últimos 45 días)" pad={false}>
          <Table>
            <thead>
              <tr>
                <th className={th}>Fecha</th>
                <th className={th}>Cuenta</th>
                <th className={`${th} text-right`}>Esperado</th>
                <th className={`${th} text-right`}>Real</th>
                <th className={`${th} text-right`}>Diferencia</th>
                <th className={th}>Justificación</th>
              </tr>
            </thead>
            <tbody>
              {diferencias.map(({ j, s }) => (
                <tr key={s.id}>
                  <td className={`${td} whitespace-nowrap`}>{fmtFecha(j.fecha)}</td>
                  <td className={td}>{nombreCuenta(s.cuenta_id)}</td>
                  <td className={`${td} text-right tabular-nums`}>{fmtMoney(s.saldo_esperado)}</td>
                  <td className={`${td} text-right tabular-nums`}>{fmtMoney(s.saldo_real)}</td>
                  <td className={cx(td, 'text-right font-semibold tabular-nums', Number(s.diferencia) < 0 ? 'text-red-700' : 'text-emerald-700')}>{fmtMoney(s.diferencia)}</td>
                  <td className={`${td} text-sm text-slate-600`}>{s.justificacion}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      <Modal open={!!nuevo} onClose={() => setNuevo(null)} title={nuevo === 'transferencia' ? 'Transferencia entre cuentas propias' : nuevo === 'ingreso' ? 'Nuevo ingreso' : 'Nuevo egreso'} wide>
        {nuevo && <MovimientoForm key={nuevo} cuentas={cuentas} categorias={categorias} preset={{ tipo: nuevo }} onCancel={() => setNuevo(null)} onSaved={listo(() => setNuevo(null))} />}
      </Modal>
      <Modal open={!!editar} onClose={() => setEditar(null)} title="Editar movimiento" wide>
        {editar && <MovimientoForm cuentas={cuentas} categorias={categorias} inicial={editar} onCancel={() => setEditar(null)} onSaved={listo(() => setEditar(null))} />}
      </Modal>
      <Modal open={!!ejecutar} onClose={() => setEjecutar(null)} title={ejecutar?.tipo === 'egreso' ? 'Pagar' : 'Cobrar'}>
        {ejecutar && <EjecutarForm mov={ejecutar} cuentas={cuentas} onCancel={() => setEjecutar(null)} onDone={listo(() => setEjecutar(null))} />}
      </Modal>
    </>
  )
}
