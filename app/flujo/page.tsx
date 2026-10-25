'use client'

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { sb, errMsg } from '@/lib/supabase'
import type { Factura } from '@/lib/types'
import { diffDias, fmtFecha, fmtFechaLarga, fmtMoney, hoy, parseMonto, sumarDias } from '@/lib/utils'
import { Alerta, ItemProy, Proyeccion, agruparMeses, agruparSemanas, nivelSaldo, proyectarCuentas } from '@/lib/flujo'
import { Categoria, Cuenta, Disponible, Movimiento, cargarBase, disponibilidad } from '@/lib/tesoreria'
import { Obligacion, abierta, fechaPago } from '@/lib/pagos'
import { useAuth } from '@/components/AuthProvider'
import { Calendario, DiaResumen, ItemFila, SaldoChart, fmtCorto } from '@/components/Flujo'
import { AccionMov, CuentaSelect, EjecutarForm, MovimientoForm, accionRapida, exportarExcel } from '@/components/Tesoreria'
import { Alert, Badge, Button, Card, Empty, Field, Modal, PageHeader, Spinner, Stat, Table, compactCls, cx, inputCls, td, th } from '@/components/ui'
import type { Celda } from '@/lib/xlsx-lite'
import { etiquetaTipo, netearCreditos } from '@/lib/comprobantes'

type Vista = 'calendario' | 'diario' | 'cuentas' | 'mensual' | 'semanal' | 'movimientos'
type Sim = { id: string; origen: string; destino: string; importe: number; fecha_salida: string; fecha_acreditacion: string; nota: string | null; estado: string }
type FacturaFlujo = Pick<Factura, 'id' | 'cliente_id' | 'tipo' | 'signo' | 'tipo_comprobante' | 'numero' | 'fecha_vencimiento' | 'saldo' | 'fecha_estimada_cobro'> & { cliente: { razon_social: string } | null }

const PERIODOS = [7, 15, 30, 60]
const MOV_SELECT = '*, autor:perfiles!created_by(nombre)'

export default function FlujoPage() {
  const { puedeEditar, esGerencia } = useAuth()
  const ref = hoy()

  const [movs, setMovs] = useState<Movimiento[] | null>(null)
  const [facturas, setFacturas] = useState<FacturaFlujo[]>([])
  const [obls, setObls] = useState<Obligacion[]>([])
  const [sims, setSims] = useState<Sim[]>([])
  const [disp, setDisp] = useState<Disponible[]>([])
  const [cuentas, setCuentas] = useState<Cuenta[]>([])
  const [categorias, setCategorias] = useState<Categoria[]>([])

  const [periodo, setPeriodo] = useState<number | 'rango'>(30)
  const [desdeR, setDesdeR] = useState(ref)
  const [hastaR, setHastaR] = useState(sumarDias(ref, 90))
  const [alternativa, setAlternativa] = useState(false)
  const [vista, setVista] = useState<Vista>('calendario')
  const [cuentaSel, setCuentaSel] = useState('')
  const [mes, setMes] = useState(`${ref.slice(0, 7)}-01`)
  const [diaSel, setDiaSel] = useState<string | null>(ref)
  const [cobranzas, setCobranzas] = useState(true)
  const [sinDecidir, setSinDecidir] = useState(true)
  const [conSims, setConSims] = useState(true)

  const [nuevo, setNuevo] = useState(false)
  const [editar, setEditar] = useState<Movimiento | null>(null)
  const [ejecutar, setEjecutar] = useState<Movimiento | null>(null)
  const [reservas, setReservas] = useState(false)
  const [simular, setSimular] = useState<Partial<Sim> | null>(null)
  const [msg, setMsg] = useState<{ tone: 'green' | 'red' | 'amber' | 'blue'; text: string } | null>(null)

  const cargar = useCallback(async () => {
    const s = sb()
    try {
      const [base, d, a, c, o, si] = await Promise.all([
        cargarBase(),
        disponibilidad(ref),
        s.from('tes_movimientos').select(MOV_SELECT).in('estado', ['pendiente', 'autorizado']).order('fecha_prevista'),
        s.from('facturas').select('id,cliente_id,tipo,signo,tipo_comprobante,numero,fecha_vencimiento,fecha_estimada_cobro,saldo,cliente:clientes(razon_social)').eq('estado', 'pendiente').order('fecha_vencimiento'),
        s.from('pag_obligaciones').select('*').not('estado', 'in', '(pagado,cancelado)'),
        s.from('tes_simulaciones').select('*').eq('estado', 'activa').order('fecha_salida'),
      ])
      setCuentas(base.cuentas)
      setCategorias(base.categorias)
      setDisp(d)
      setMovs(((a.data as Movimiento[]) ?? []).filter((m) => !m.obligacion_id || m.cheque_id))
      setFacturas((c.data as unknown as FacturaFlujo[]) ?? [])
      setObls(((o.data as Obligacion[]) ?? []).filter(abierta))
      setSims((si.data as Sim[]) ?? [])
    } catch (e) {
      setMsg({ tone: 'red', text: errMsg(e) })
      setMovs([])
    }
  }, [ref])

  useEffect(() => {
    if (puedeEditar) cargar()
  }, [cargar, puedeEditar])

  const desde = periodo === 'rango' ? (desdeR < ref ? ref : desdeR) : ref
  const hasta = periodo === 'rango' ? (hastaR < desde ? desde : hastaR) : sumarDias(ref, periodo - 1)
  const nDias = diffDias(hasta, ref) + 1
  const activas = useMemo(() => cuentas.filter((c) => c.activa), [cuentas])
  const catNombre = useMemo(() => new Map(categorias.map((c) => [c.id, c.nombre])), [categorias])
  const nombreCuenta = (id: string | null | undefined) => cuentas.find((c) => c.id === id)?.nombre ?? '—'
  const defIng = cuentas.find((c) => c.cobro_default)?.id ?? activas.find((c) => c.tipo === 'banco')?.id ?? activas[0]?.id ?? ''
  const defEgr = cuentas.find((c) => c.pago_default)?.id ?? defIng

  const { items, sinFecha } = useMemo(() => {
    const out: Omit<ItemProy, 'fecha' | 'atrasado'>[] = []
    const sf: ItemProy[] = []
    for (const m of movs ?? []) {
      const base = { id: m.id, fechaOriginal: m.fecha_prevista, concepto: m.concepto, contraparte: m.contraparte, monto: Number(m.importe), estado: m.estado, cuenta_id: m.cuenta_id, ref: m }
      if (m.tipo === 'transferencia') out.push({ ...base, origen: 'transferencia', tipo: m.sentido === 'entrada' ? 'ingreso' : 'egreso', categoria: 'Transferencia propia', interno: true })
      else
        out.push({
          ...base,
          origen: 'tesoreria',
          tipo: m.tipo,
          categoria: m.cheque_id ? (m.tipo === 'ingreso' ? 'Cheque a acreditar' : 'Cheque a debitar') : (m.categoria_id && catNombre.get(m.categoria_id)) || '',
        })
    }
    if (cobranzas)
      // Las notas de crédito / anula presupuesto no se cobran: descuentan de lo que se espera cobrar al mismo cliente
      for (const f of netearCreditos(facturas)) {
        const fecha = f.fecha_estimada_cobro ?? (f.fecha_vencimiento >= ref ? f.fecha_vencimiento : null)
        const it = {
          id: `fac-${f.id}`,
          origen: 'cobranza' as const,
          tipo: 'ingreso' as const,
          concepto: `${etiquetaTipo(f)} ${f.numero}`,
          categoria: f.fecha_estimada_cobro ? 'Cobranzas · fecha estimada' : 'Cobranzas · vencimiento',
          contraparte: f.cliente?.razon_social ?? null,
          monto: Number(f.saldo),
          estado: 'factura',
          cuenta_id: null,
          facturaId: f.id,
        }
        if (fecha) out.push({ ...it, fechaOriginal: fecha })
        else sf.push({ ...it, categoria: `Cobranzas · vencida el ${fmtFecha(f.fecha_vencimiento)}, sin fecha estimada`, fecha: '', fechaOriginal: f.fecha_vencimiento, atrasado: true })
      }
    for (const o of obls) {
      if (!sinDecidir && (o.estado === 'pendiente_decision' || o.estado === 'pendiente_revision')) continue
      const f = fechaPago(o)
      const it = {
        id: `obl-${o.id}`,
        origen: 'obligacion' as const,
        tipo: 'egreso' as const,
        concepto: o.concepto || o.comprobante || o.proveedor,
        categoria: o.cuotas ? `Cuota ${o.cuota}/${o.cuotas}` : '',
        contraparte: o.proveedor,
        monto: Number(o.saldo),
        estado: o.estado,
        cuenta_id: o.cuenta_id,
        prioridad: o.prioridad,
        obl: o,
      }
      if (f) out.push({ ...it, fechaOriginal: f })
      else sf.push({ ...it, categoria: 'Sin vencimiento ni fecha estimada', fecha: '', fechaOriginal: '', atrasado: false })
    }
    if (conSims)
      for (const s of sims) {
        const b = { origen: 'simulacion' as const, concepto: s.nota || 'Transferencia simulada', contraparte: null, monto: Number(s.importe), estado: 'simulada', interno: true, simId: s.id, categoria: 'Simulación' }
        out.push({ ...b, id: `sim-o-${s.id}`, tipo: 'egreso', fechaOriginal: s.fecha_salida, cuenta_id: s.origen })
        out.push({ ...b, id: `sim-d-${s.id}`, tipo: 'ingreso', fechaOriginal: s.fecha_acreditacion, cuenta_id: s.destino })
      }
    return { items: out, sinFecha: sf }
  }, [movs, facturas, obls, sims, cobranzas, sinDecidir, conSims, ref, catNombre])

  const proy = useMemo(
    () =>
      proyectarCuentas({
        cuentas: activas.map((c) => ({ id: c.id, nombre: c.nombre, reserva: Number(c.reserva_minima ?? 0) })),
        saldos: Object.fromEntries(disp.map((d) => [d.cuenta_id, d.saldo])),
        items,
        desde: ref,
        dias: Math.max(1, nDias),
        sinFecha,
        cuentaDefault: { ingreso: defIng, egreso: defEgr },
      }),
    [items, sinFecha, disp, activas, ref, nDias, defIng, defEgr],
  )

  // Lo que se muestra: total o una cuenta, recortado al período elegido
  const visible = useMemo<Proyeccion>(() => {
    const p = cuentaSel ? proy.porCuenta.get(cuentaSel) ?? proy.total : proy.total
    const dias = p.dias.filter((d) => d.fecha >= desde && d.fecha <= hasta)
    let minimo = { fecha: desde, saldo: Infinity }
    for (const d of dias) if (d.saldo < minimo.saldo) minimo = { fecha: d.fecha, saldo: d.saldo }
    const prev = p.dias.filter((d) => d.fecha < desde).at(-1)
    return {
      ...p,
      dias,
      saldoInicial: prev ? prev.saldo : p.saldoInicial,
      totalIngresos: dias.reduce((a, d) => a + d.ingresos, 0),
      totalEgresos: dias.reduce((a, d) => a + d.egresos, 0),
      saldoFinal: dias.at(-1)?.saldo ?? p.saldoInicial,
      minimo: minimo.saldo === Infinity ? { fecha: desde, saldo: p.saldoInicial } : minimo,
      primerNegativo: dias.find((d) => d.saldo < 0)?.fecha ?? null,
      primerBajoColchon: null,
    }
  }, [proy, cuentaSel, desde, hasta])

  const reservaSel = cuentaSel ? Number(cuentas.find((c) => c.id === cuentaSel)?.reserva_minima ?? 0) : 0
  const semanas = useMemo(() => agruparSemanas(visible), [visible])
  const meses = useMemo(() => agruparMeses(visible), [visible])
  const sfIng = proy.sinFecha.filter((x) => x.tipo === 'ingreso').reduce((a, x) => a + x.monto, 0)
  const sfEgr = proy.sinFecha.filter((x) => x.tipo === 'egreso').reduce((a, x) => a + x.monto, 0)

  if (!puedeEditar) return <Empty>El flujo de fondos es exclusivo de Administración y Gerencia (A08).</Empty>
  if (!movs) return <Spinner />

  const diaDet = diaSel ? visible.dias.find((d) => d.fecha === diaSel) : null
  const totalDisp = disp.reduce((a, d) => a + d.saldo, 0)

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

  /** Propone una transferencia preventiva para cubrir una alerta, desde la cuenta con más saldo ese día. */
  function proponer(a: Alerta) {
    if (!a.cuenta_id) return setSimular({ importe: a.falta, fecha_salida: ref, fecha_acreditacion: ref })
    const dia = a.fecha
    let mejor = ''
    let sobra = 0
    for (const c of activas) {
      if (c.id === a.cuenta_id) continue
      const p = proy.porCuenta.get(c.id)!
      const minDesde = Math.min(...p.dias.filter((d) => d.fecha >= sumarDias(dia, -1)).map((d) => d.saldo), Infinity) - Number(c.reserva_minima ?? 0)
      if (minDesde > sobra) (sobra = minDesde), (mejor = c.id)
    }
    const f = dia > ref ? sumarDias(dia, -1) : ref
    const reserva = a.tipo === 'faltante_cuenta' ? Number(cuentas.find((c) => c.id === a.cuenta_id)?.reserva_minima ?? 0) : 0
    setSimular({ origen: mejor || undefined, destino: a.cuenta_id, importe: Math.ceil(a.falta + reserva), fecha_salida: f, fecha_acreditacion: f, nota: `Cubrir ${a.tipo === 'reserva' ? 'reserva' : 'faltante'} de ${nombreCuenta(a.cuenta_id)} del ${fmtFecha(dia)}` })
  }

  async function confirmarSim(s: Sim) {
    const { error } = await sb().rpc('tes_confirmar_simulacion', { p_sim: s.id })
    if (error) return setMsg({ tone: 'red', text: errMsg(error) })
    setMsg({ tone: 'green', text: 'Transferencia registrada en Caja y Bancos. Si es a futuro queda pendiente hasta confirmar la acreditación.' })
    cargar()
  }
  async function descartarSim(s: Sim) {
    const { error } = await sb().from('tes_simulaciones').update({ estado: 'descartada' }).eq('id', s.id)
    if (error) return setMsg({ tone: 'red', text: errMsg(error) })
    cargar()
  }

  function exportar() {
    const enPeriodo = proy.total.dias.filter((d) => d.fecha >= desde && d.fecha <= hasta)
    const filasDia: Celda[][] = [
      ['Fecha', ...activas.map((c) => `Saldo ${c.nombre}`), 'Ingresos', 'Egresos', 'Saldo total'],
      ...enPeriodo.map((d) => [fmtFecha(d.fecha), ...activas.map((c) => proy.porCuenta.get(c.id)!.dias.find((x) => x.fecha === d.fecha)?.saldo ?? ''), d.ingresos, d.egresos, d.saldo]),
    ]
    const ORIGEN = { tesoreria: 'Caja y Bancos', cobranza: 'Cuentas a cobrar', obligacion: 'Cuentas a pagar', transferencia: 'Transferencia', simulacion: 'Simulación' }
    const filasMov: Celda[][] = [
      ['Fecha', 'Tipo', 'Origen', 'Concepto', 'Cliente / proveedor', 'Cuenta', 'Ingreso', 'Egreso', 'Estado', 'Atrasado'],
      ...enPeriodo.flatMap((d) =>
        d.items.map((it) => [
          fmtFecha(d.fecha),
          it.interno ? 'Transferencia propia' : it.tipo === 'ingreso' ? 'Ingreso' : 'Egreso',
          ORIGEN[it.origen],
          it.concepto,
          it.contraparte ?? '',
          nombreCuenta(it.cuenta_id || (it.tipo === 'ingreso' ? defIng : defEgr)),
          it.tipo === 'ingreso' ? it.monto : '',
          it.tipo === 'egreso' ? it.monto : '',
          it.estado,
          it.atrasado ? `Sí (${fmtFecha(it.fechaOriginal)})` : '',
        ]),
      ),
    ]
    const filasSF: Celda[][] = [['Tipo', 'Concepto', 'Cliente / proveedor', 'Importe', 'Detalle'], ...proy.sinFecha.map((x) => [x.tipo === 'ingreso' ? 'A cobrar' : 'A pagar', x.concepto, x.contraparte ?? '', x.monto, x.categoria])]
    const filasAl: Celda[][] = [
      ['Alerta', 'Cuenta', 'Desde', 'Saldo mínimo', 'Fecha mínimo', 'Falta', 'Pagos a revisar'],
      ...proy.alertas.map((a) => [
        a.tipo === 'faltante_total' ? 'Faltante total' : a.tipo === 'faltante_cuenta' ? 'Faltante por cuenta' : 'Debajo de la reserva',
        a.cuenta_id ? nombreCuenta(a.cuenta_id) : 'Todas',
        fmtFecha(a.fecha),
        a.minimo,
        fmtFecha(a.minFecha),
        a.falta,
        a.revisar.map((r) => `${r.contraparte} ${fmtMoney(r.monto)} (${fmtFecha(r.fechaOriginal)})`).join(' · '),
      ]),
    ]
    exportarExcel(`flujo-de-fondos-${desde}-a-${hasta}`, [
      { nombre: 'Saldos por día', filas: filasDia, anchos: [12, ...activas.map(() => 18), 16, 16, 18] },
      { nombre: 'Movimientos previstos', filas: filasMov, anchos: [12, 18, 16, 36, 26, 18, 14, 14, 18, 16] },
      { nombre: 'Sin fecha definida', filas: filasSF, anchos: [10, 36, 26, 14, 40] },
      { nombre: 'Alertas', filas: filasAl, anchos: [20, 18, 12, 16, 12, 14, 60] },
    ])
  }

  const tituloAlerta = (a: Alerta) =>
    a.tipo === 'faltante_total' ? 'Faltante total' : a.tipo === 'faltante_cuenta' ? `Faltante en ${nombreCuenta(a.cuenta_id)}` : `${nombreCuenta(a.cuenta_id)} por debajo de la reserva mínima`
  const alertasPeriodo = proy.alertas.filter((a) => a.fecha <= hasta)
  const chip = (activo: boolean) => cx('rounded-full border px-3 py-1 text-xs font-medium', activo ? 'border-brand-700 bg-brand-700 text-white' : 'border-slate-300 bg-white text-slate-600 hover:border-brand-400')

  return (
    <>
      <PageHeader
        title="Flujo de fondos"
        subtitle={
          <>
            A08 · Parte de la plata real de{' '}
            <Link href="/tesoreria" className="underline">
              Caja y Bancos
            </Link>
            , suma lo que se espera cobrar (Cuentas a cobrar) y resta lo que hay que pagar (
            <Link href="/pagos" className="underline">
              Cuentas a pagar
            </Link>
            ). Cuando algo se cobra o se paga, reemplaza a lo proyectado.
          </>
        }
        actions={
          <>
            <Button variant="secondary" onClick={exportar}>
              Excel
            </Button>
            <Button variant="secondary" onClick={() => setReservas(true)}>
              Reservas mínimas
            </Button>
            <Button variant="secondary" onClick={() => setSimular({ fecha_salida: ref, fecha_acreditacion: ref })}>
              Simular transferencia
            </Button>
            <Button onClick={() => setNuevo(true)}>+ Previsto</Button>
          </>
        }
      />

      {msg && (
        <Alert tone={msg.tone} className="mb-4">
          {msg.text}
        </Alert>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {PERIODOS.map((h) => (
          <button key={h} onClick={() => setPeriodo(h)} className={chip(periodo === h)}>
            {h} días
          </button>
        ))}
        <button onClick={() => setPeriodo('rango')} className={chip(periodo === 'rango')}>
          Rango
        </button>
        {periodo === 'rango' && (
          <>
            <input id="fl-desde" type="date" className={compactCls} value={desdeR} min={ref} onChange={(e) => e.target.value && setDesdeR(e.target.value)} aria-label="Desde" />
            <input id="fl-hasta" type="date" className={compactCls} value={hastaR} min={ref} onChange={(e) => e.target.value && setHastaR(e.target.value)} aria-label="Hasta" />
          </>
        )}
        <div className="ml-auto inline-flex rounded-lg border border-slate-300 bg-white p-0.5 text-xs">
          {[false, true].map((alt) => (
            <button key={String(alt)} onClick={() => setAlternativa(alt)} className={cx('rounded-md px-3 py-1.5 font-medium', alternativa === alt ? 'bg-brand-700 text-white' : 'text-slate-600')}>
              {alt ? `Con los sin fecha (${proy.sinFecha.length})` : 'Con fecha'}
            </button>
          ))}
        </div>
      </div>

      {alertasPeriodo.length === 0 ? (
        <Alert tone="green" className="mb-4">
          Entre el {fmtFecha(desde)} y el {fmtFecha(hasta)} ninguna cuenta queda en negativo ni por debajo de su reserva.
        </Alert>
      ) : (
        <div className="mb-4 space-y-2">
          {alertasPeriodo.map((a, i) => (
            <div key={i} className={cx('rounded-xl border p-4', a.tipo === 'reserva' ? 'border-amber-300 bg-amber-50 text-amber-950' : 'border-red-300 bg-red-50 text-red-950')}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">
                    {a.tipo === 'reserva' ? '◆' : '⚠'} {tituloAlerta(a)} desde el <span className="capitalize">{fmtFechaLarga(a.fecha)}</span>
                  </div>
                  <div className="mt-0.5 text-sm">
                    Saldo más bajo <b>{fmtMoney(a.minimo)}</b> el {fmtFecha(a.minFecha)}. {a.tipo === 'reserva' ? 'Para respetar la reserva faltan' : 'Faltan'} <b>{fmtMoney(a.falta)}</b>.
                    {a.tipo === 'faltante_cuenta' && (proy.total.dias.find((d) => d.fecha === a.fecha)?.saldo ?? -1) >= 0 && ' El total da positivo: se puede cubrir con una transferencia entre cuentas.'}
                  </div>
                  {a.motivo.length > 0 && (
                    <div className="mt-1 text-xs">Motivo: {a.motivo.map((m) => `${m.contraparte ?? m.concepto} ${fmtMoney(m.monto)} (${fmtFecha(m.fechaOriginal)})`).join(' · ')}</div>
                  )}
                  {a.revisar.length > 0 && (
                    <div className="mt-1 text-xs">
                      Pagos para revisar (por vencimiento y prioridad):{' '}
                      {a.revisar.map((r) => `${r.contraparte} ${fmtMoney(r.monto)} ${fmtFecha(r.fechaOriginal)}${r.prioridad === 'baja' ? ' · prioridad baja' : ''}`).join(' · ')}. No se reprograma nada solo.
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap gap-1">
                  <Button size="sm" variant="secondary" onClick={() => proponer(a)}>
                    Simular transferencia
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => (setDiaSel(a.fecha), setMes(`${a.fecha.slice(0, 7)}-01`), setCuentaSel(a.cuenta_id ?? ''), setVista('calendario'))}>
                    Ver ese día
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Disponible hoy" value={fmtMoney(totalDisp)} sub="Caja y Bancos, sin cheques en cartera" tone="brand" />
        <Stat label="Entra en el período" value={fmtMoney(visible.totalIngresos)} tone="green" />
        <Stat label="Sale en el período" value={fmtMoney(visible.totalEgresos)} tone="red" />
        <Stat
          label={alternativa ? 'Final con los sin fecha' : 'Saldo final'}
          value={<span className={(alternativa ? visible.saldoFinal + sfIng - sfEgr : visible.saldoFinal) < 0 ? 'text-red-700' : ''}>{fmtMoney(alternativa ? visible.saldoFinal + sfIng - sfEgr : visible.saldoFinal)}</span>}
          sub={`al ${fmtFecha(hasta)}${cuentaSel ? ` · ${nombreCuenta(cuentaSel)}` : ''}`}
          tone="slate"
        />
        <Stat label="Saldo mínimo" value={<span className={visible.minimo.saldo < 0 ? 'text-red-700' : ''}>{fmtMoney(visible.minimo.saldo)}</span>} sub={`el ${fmtFecha(visible.minimo.fecha)}`} tone={visible.minimo.saldo < 0 ? 'rose' : 'green'} />
      </div>

      <Card pad={false} className="mb-5" title="Por cuenta" subtitle="Saldo de hoy, el mínimo del período y cómo termina. Tocá una cuenta para ver solo esa.">
        <Table>
          <thead>
            <tr>
              <th className={th}>Cuenta</th>
              <th className={`${th} text-right`}>Hoy</th>
              <th className={`${th} text-right`}>Entra</th>
              <th className={`${th} text-right`}>Sale</th>
              <th className={`${th} text-right`}>Mínimo</th>
              <th className={`${th} text-right`}>Final</th>
              <th className={`${th} text-right`}>Reserva</th>
            </tr>
          </thead>
          <tbody>
            {activas.map((c) => {
              const p = proy.porCuenta.get(c.id)
              if (!p) return null
              const ds = p.dias.filter((d) => d.fecha >= desde && d.fecha <= hasta)
              const min = ds.reduce((m, d) => (d.saldo < m.saldo ? d : m), ds[0] ?? { saldo: p.saldoInicial, fecha: desde })
              const res = Number(c.reserva_minima ?? 0)
              return (
                <tr key={c.id} className={cx('cursor-pointer hover:bg-brand-50/40', cuentaSel === c.id && 'bg-brand-50/60')} onClick={() => setCuentaSel(cuentaSel === c.id ? '' : c.id)}>
                  <td className={`${td} font-medium`}>{c.nombre}</td>
                  <td className={`${td} text-right tabular-nums`}>{fmtMoney(p.saldoInicial)}</td>
                  <td className={`${td} text-right tabular-nums text-emerald-700`}>{fmtMoney(ds.reduce((a, d) => a + d.ingresos, 0))}</td>
                  <td className={`${td} text-right tabular-nums text-red-700`}>{fmtMoney(ds.reduce((a, d) => a + d.egresos, 0))}</td>
                  <td className={cx(td, 'text-right tabular-nums', min.saldo < 0 ? 'font-semibold text-red-700' : min.saldo < res ? 'text-amber-800' : '')}>
                    {fmtMoney(min.saldo)}
                    <div className="text-xs font-normal text-slate-500">{fmtFecha(min.fecha)}</div>
                  </td>
                  <td className={`${td} text-right font-semibold tabular-nums`}>{fmtMoney(ds.at(-1)?.saldo ?? p.saldoInicial)}</td>
                  <td className={`${td} text-right tabular-nums text-slate-500`}>{res ? fmtMoney(res) : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </Table>
        <p className="px-4 py-2 text-xs text-slate-500">
          Las cobranzas sin cuenta se proyectan en {nombreCuenta(defIng)} y los pagos sin cuenta en {nombreCuenta(defEgr)} (se cambia en Reservas mínimas). Las transferencias propias y simuladas mueven plata entre cuentas sin cambiar el total.
        </p>
      </Card>

      <Card
        title={`Saldo proyectado · ${cuentaSel ? nombreCuenta(cuentaSel) : 'todas las cuentas'}`}
        subtitle={`Del ${fmtFecha(desde)} al ${fmtFecha(hasta)}. Usa las fechas estimadas de cobro y pago; lo atrasado se cuenta hoy.`}
        actions={
          <select id="fl-cuenta" className={compactCls} value={cuentaSel} onChange={(e) => setCuentaSel(e.target.value)} aria-label="Cuenta">
            <option value="">Todas las cuentas</option>
            {activas.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nombre}
              </option>
            ))}
          </select>
        }
      >
        {visible.dias.length > 0 && <SaldoChart proy={visible} colchon={reservaSel} seleccionado={diaSel} onDia={(f) => (setDiaSel(f), setMes(`${f.slice(0, 7)}-01`))} />}
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-slate-100 pt-3 text-sm">
          <label className="flex items-center gap-2">
            <input id="op-cob" type="checkbox" className="h-4 w-4 accent-brand-700" checked={cobranzas} onChange={(e) => setCobranzas(e.target.checked)} />
            Contar cuentas a cobrar
          </label>
          <label className="flex items-center gap-2">
            <input id="op-dec" type="checkbox" className="h-4 w-4 accent-brand-700" checked={sinDecidir} onChange={(e) => setSinDecidir(e.target.checked)} />
            Incluir pagos sin decidir
          </label>
          <label className="flex items-center gap-2">
            <input id="op-sim" type="checkbox" className="h-4 w-4 accent-brand-700" checked={conSims} onChange={(e) => setConSims(e.target.checked)} />
            Aplicar simulaciones ({sims.length})
          </label>
        </div>
      </Card>

      {sims.length > 0 && (
        <Card className="mt-5" pad={false} title="Transferencias simuladas" subtitle="No mueven saldos reales ni crean movimientos hasta que la persona autorizada las confirma.">
          <ul className="divide-y divide-slate-100">
            {sims.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                <Badge tone="orange">Simulación</Badge>
                <span className="min-w-0 flex-1">
                  {nombreCuenta(s.origen)} → {nombreCuenta(s.destino)} · sale {fmtFecha(s.fecha_salida)}
                  {s.fecha_acreditacion !== s.fecha_salida && `, se acredita ${fmtFecha(s.fecha_acreditacion)}`}
                  {s.nota && <span className="block text-xs text-slate-500">{s.nota}</span>}
                </span>
                <span className="font-semibold tabular-nums">{fmtMoney(s.importe)}</span>
                {esGerencia ? (
                  <Button size="sm" variant="success" onClick={() => confirmarSim(s)}>
                    Confirmar y registrar
                  </Button>
                ) : (
                  <span className="text-xs text-slate-500">La confirma Gerencia</span>
                )}
                <Button size="sm" variant="ghost" onClick={() => descartarSim(s)}>
                  Descartar
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {alternativa && (
        <Card
          className="mt-5"
          pad={false}
          title={`Sin fecha definida (${proy.sinFecha.length})`}
          subtitle={`No se ubican en ningún día: no se inventan fechas. A cobrar ${fmtMoney(sfIng)} · a pagar ${fmtMoney(sfEgr)}. Poneles fecha estimada para que entren en la proyección.`}
        >
          {proy.sinFecha.length === 0 ? (
            <Empty>Todo tiene fecha.</Empty>
          ) : (
            <ul className="divide-y divide-slate-100">
              {proy.sinFecha.map((it) => (
                <li key={it.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
                  <span className={cx('h-2 w-2 rounded-full', it.tipo === 'ingreso' ? 'bg-emerald-500' : 'bg-red-500')} />
                  <span className="min-w-0 flex-1">
                    {it.contraparte} · {it.concepto}
                    <span className="block text-xs text-amber-700">{it.categoria}</span>
                  </span>
                  <span className={cx('font-semibold tabular-nums', it.tipo === 'ingreso' ? 'text-emerald-700' : 'text-red-700')}>
                    {it.tipo === 'ingreso' ? '+' : '−'} {fmtMoney(it.monto)}
                  </span>
                  <Link href={it.origen === 'cobranza' ? '/cobranzas' : '/pagos'} className="text-xs text-brand-700 hover:underline">
                    Poner fecha →
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <div className="mb-4 mt-6 flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex flex-wrap rounded-lg border border-slate-300 bg-white p-0.5">
          {(
            [
              ['calendario', 'Calendario'],
              ['diario', 'Día por día'],
              ['cuentas', 'Diario por cuenta'],
              ['semanal', 'Por semana'],
              ['mensual', 'Por mes'],
              ['movimientos', 'Movimientos'],
            ] as const
          ).map(([k, l]) => (
            <button key={k} onClick={() => setVista(k)} className={cx('rounded-md px-3 py-1.5 text-sm font-medium', vista === k ? 'bg-brand-700 text-white' : 'text-slate-600 hover:bg-slate-50')}>
              {l}
            </button>
          ))}
        </div>
        {vista === 'calendario' && (
          <div className="flex items-center gap-1">
            <Button variant="secondary" size="sm" onClick={() => setMes(cambiarMes(mes, -1))} aria-label="Mes anterior">
              ‹
            </Button>
            <span className="w-36 text-center text-sm font-medium capitalize">{nombreMes(mes)}</span>
            <Button variant="secondary" size="sm" onClick={() => setMes(cambiarMes(mes, 1))} aria-label="Mes siguiente">
              ›
            </Button>
          </div>
        )}
      </div>

      {vista === 'calendario' && (
        <div className="grid gap-5 lg:grid-cols-5">
          <div className="min-w-0 lg:col-span-3">
            <Calendario proy={visible} colchon={reservaSel} mes={mes} seleccionado={diaSel} onDia={setDiaSel} />
          </div>
          <Card className="lg:col-span-2" pad={false} title={diaDet ? <DiaResumen d={diaDet} colchon={reservaSel} /> : 'Elegí un día'}>
            {!diaDet ? (
              <Empty>Tocá un día del período.</Empty>
            ) : diaDet.items.length === 0 ? (
              <Empty>No hay nada previsto este día.</Empty>
            ) : (
              <ul className="divide-y divide-slate-100">
                {diaDet.items.map((it) => (
                  <ItemFila key={it.id} it={it} onAccion={accion} />
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      {vista === 'diario' && (
        <div className="space-y-3">
          {visible.dias.filter((d) => d.items.length).length === 0 && (
            <Card>
              <Empty>No hay nada previsto en el período.</Empty>
            </Card>
          )}
          {visible.dias
            .filter((d) => d.items.length)
            .map((d) => {
              const n = nivelSaldo(d.saldo, reservaSel)
              return (
                <section key={d.fecha} className={cx('min-w-0 rounded-xl border bg-white shadow-sm', n === 'negativo' ? 'border-red-300' : n === 'bajo' ? 'border-amber-300' : 'border-slate-200')}>
                  <header className={cx('rounded-t-xl border-b px-4 py-2.5', n === 'negativo' ? 'border-red-200 bg-red-50' : n === 'bajo' ? 'border-amber-200 bg-amber-50' : 'border-slate-100')}>
                    <DiaResumen d={d} colchon={reservaSel} />
                  </header>
                  <ul className="divide-y divide-slate-100">
                    {d.items.map((it) => (
                      <ItemFila key={it.id} it={it} onAccion={accion} />
                    ))}
                  </ul>
                </section>
              )
            })}
        </div>
      )}

      {vista === 'cuentas' && (
        <Card pad={false}>
          <Table>
            <thead>
              <tr>
                <th className={th}>Día</th>
                {activas.map((c) => (
                  <th key={c.id} className={`${th} text-right`}>
                    {c.nombre}
                  </th>
                ))}
                <th className={`${th} text-right`}>Total</th>
              </tr>
            </thead>
            <tbody>
              {proy.total.dias
                .filter((d) => d.fecha >= desde && d.fecha <= hasta)
                .map((d) => (
                  <tr key={d.fecha} className={cx(d.items.length === 0 && 'text-slate-400')}>
                    <td className={`${td} whitespace-nowrap`}>{fmtFecha(d.fecha)}</td>
                    {activas.map((c) => {
                      const x = proy.porCuenta.get(c.id)?.dias.find((y) => y.fecha === d.fecha)
                      if (!x) return <td key={c.id} className={td} />
                      const res = Number(c.reserva_minima ?? 0)
                      return (
                        <td key={c.id} className={cx(td, 'text-right tabular-nums', x.saldo < 0 ? 'font-semibold text-red-700' : x.saldo < res ? 'text-amber-800' : '')}>
                          {fmtMoney(x.saldo)}
                          {(x.ingresos > 0 || x.egresos > 0) && (
                            <div className="text-[11px] font-normal">
                              {x.ingresos > 0 && <span className="text-emerald-700">+{fmtCorto(x.ingresos).replace('$ ', '')} </span>}
                              {x.egresos > 0 && <span className="text-red-700">−{fmtCorto(x.egresos).replace('$ ', '')}</span>}
                            </div>
                          )}
                        </td>
                      )
                    })}
                    <td className={cx(td, 'text-right font-semibold tabular-nums', d.saldo < 0 && 'text-red-700')}>{fmtMoney(d.saldo)}</td>
                  </tr>
                ))}
            </tbody>
          </Table>
        </Card>
      )}

      {vista === 'semanal' && (
        <Card pad={false}>
          <Table>
            <thead>
              <tr>
                <th className={th}>Semana</th>
                <th className={`${th} text-right`}>Entra</th>
                <th className={`${th} text-right`}>Sale</th>
                <th className={`${th} text-right`}>Saldo más bajo</th>
                <th className={`${th} text-right`}>Saldo al cierre</th>
              </tr>
            </thead>
            <tbody>
              {semanas.map((s) => (
                <tr key={s.desde} className={cx(s.saldoMinimo < 0 && 'bg-red-50/70')}>
                  <td className={`${td} whitespace-nowrap`}>
                    {fmtFecha(s.desde)} – {fmtFecha(s.hasta)}
                  </td>
                  <td className={`${td} text-right tabular-nums text-emerald-700`}>{s.ingresos ? fmtMoney(s.ingresos) : '—'}</td>
                  <td className={`${td} text-right tabular-nums text-red-700`}>{s.egresos ? fmtMoney(s.egresos) : '—'}</td>
                  <td className={cx(td, 'text-right tabular-nums', s.saldoMinimo < 0 && 'font-semibold text-red-700')}>
                    {fmtMoney(s.saldoMinimo)}
                    <div className="text-xs font-normal text-slate-500">el {fmtFecha(s.diaMinimo)}</div>
                  </td>
                  <td className={cx(td, 'text-right font-semibold tabular-nums', s.saldoFinal < 0 && 'text-red-700')}>{fmtMoney(s.saldoFinal)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {vista === 'mensual' && (
        <Card pad={false} title="Resumen mensual">
          <Table>
            <thead>
              <tr>
                <th className={th}>Mes</th>
                <th className={`${th} text-right`}>Entra</th>
                <th className={`${th} text-right`}>Sale</th>
                <th className={`${th} text-right`}>Neto</th>
                <th className={`${th} text-right`}>Saldo más bajo</th>
                <th className={`${th} text-right`}>Saldo a fin de mes</th>
              </tr>
            </thead>
            <tbody>
              {meses.map((m) => (
                <tr key={m.mes}>
                  <td className={`${td} capitalize`}>{nombreMes(`${m.mes}-01`)}</td>
                  <td className={`${td} text-right tabular-nums text-emerald-700`}>{fmtMoney(m.ingresos)}</td>
                  <td className={`${td} text-right tabular-nums text-red-700`}>{fmtMoney(m.egresos)}</td>
                  <td className={cx(td, 'text-right tabular-nums', m.ingresos - m.egresos < 0 && 'text-red-700')}>{fmtMoney(m.ingresos - m.egresos)}</td>
                  <td className={cx(td, 'text-right tabular-nums', m.saldoMinimo < 0 && 'font-semibold text-red-700')}>
                    {fmtMoney(m.saldoMinimo)}
                    <div className="text-xs text-slate-500">el {fmtFecha(m.diaMinimo)}</div>
                  </td>
                  <td className={cx(td, 'text-right font-semibold tabular-nums', m.saldoFinal < 0 && 'text-red-700')}>{fmtMoney(m.saldoFinal)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          {alternativa && proy.sinFecha.length > 0 && (
            <p className="px-4 py-2 text-xs text-slate-600">
              Además, sin fecha definida: a cobrar {fmtMoney(sfIng)} y a pagar {fmtMoney(sfEgr)} (no se reparten entre meses).
            </p>
          )}
        </Card>
      )}

      {vista === 'movimientos' && (
        <Card pad={false} title="Todo lo previsto en el período">
          {visible.dias.every((d) => !d.items.length) ? (
            <Empty>No hay nada previsto en el período.</Empty>
          ) : (
            <ul className="divide-y divide-slate-100">
              {visible.dias.flatMap((d) =>
                d.items.map((it) => (
                  <li key={it.id} className="list-none">
                    <div className="bg-slate-50/70 px-4 pt-2 text-xs font-medium text-slate-500">
                      {fmtFecha(d.fecha)} · {nombreCuenta(it.cuenta_id || (it.tipo === 'ingreso' ? defIng : defEgr))}
                    </div>
                    <ul>
                      <ItemFila it={it} onAccion={accion} />
                    </ul>
                  </li>
                )),
              )}
            </ul>
          )}
        </Card>
      )}

      <Modal open={nuevo} onClose={() => setNuevo(false)} title="Ingreso o pago previsto" wide>
        {nuevo && <MovimientoForm cuentas={cuentas} categorias={categorias} preset={{ previsto: true }} onCancel={() => setNuevo(false)} onSaved={listo(() => setNuevo(false))} />}
      </Modal>
      <Modal open={!!editar} onClose={() => setEditar(null)} title="Editar movimiento" wide>
        {editar && <MovimientoForm cuentas={cuentas} categorias={categorias} inicial={editar} onCancel={() => setEditar(null)} onSaved={listo(() => setEditar(null))} />}
      </Modal>
      <Modal open={!!ejecutar} onClose={() => setEjecutar(null)} title={ejecutar?.tipo === 'egreso' ? 'Pagar' : 'Cobrar'}>
        {ejecutar && <EjecutarForm mov={ejecutar} cuentas={cuentas} onCancel={() => setEjecutar(null)} onDone={listo(() => setEjecutar(null))} />}
      </Modal>
      <Modal open={reservas} onClose={() => setReservas(false)} title="Reservas mínimas y cuentas por defecto">
        {reservas && <ReservasForm cuentas={activas} onCancel={() => setReservas(false)} onDone={listo(() => setReservas(false))} />}
      </Modal>
      <Modal open={!!simular} onClose={() => setSimular(null)} title="Simular transferencia entre cuentas propias">
        {simular && <SimularForm inicial={simular} cuentas={activas} onCancel={() => setSimular(null)} onDone={listo(() => setSimular(null))} />}
      </Modal>
    </>
  )
}

function ReservasForm({ cuentas, onDone, onCancel }: { cuentas: Cuenta[]; onDone: (m: string) => void; onCancel: () => void }) {
  const [res, setRes] = useState<Record<string, string>>(() => Object.fromEntries(cuentas.map((c) => [c.id, String(c.reserva_minima ?? 0).replace('.', ',')])))
  const [cob, setCob] = useState(cuentas.find((c) => c.cobro_default)?.id ?? cuentas[0]?.id ?? '')
  const [pag, setPag] = useState(cuentas.find((c) => c.pago_default)?.id ?? cuentas[0]?.id ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    for (const c of cuentas) {
      const v = parseMonto(res[c.id] ?? '0') || 0
      const { error } = await sb().rpc('tes_config_cuenta', { p_cuenta: c.id, p: { reserva_minima: v, cobro_default: c.id === cob, pago_default: c.id === pag } })
      if (error) {
        setBusy(false)
        return setError(errMsg(error))
      }
    }
    setBusy(false)
    onDone('Reservas guardadas. Las alertas preventivas se recalculan con estos montos.')
  }
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <p className="text-sm text-slate-600">Monto mínimo que querés tener en cada cuenta. Si la proyección baja de ahí, avisa antes. No es un gasto ni se descuenta del saldo.</p>
      <div className="space-y-2">
        {cuentas.map((c) => (
          <Field key={c.id} label={`Reserva ${c.nombre}`}>
            <input id={`res-${c.codigo}`} className={inputCls} inputMode="decimal" value={res[c.id] ?? ''} onChange={(e) => setRes({ ...res, [c.id]: e.target.value })} />
          </Field>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Las cobranzas sin cuenta entran en">
          <CuentaSelect cuentas={cuentas} value={cob} onChange={setCob} />
        </Field>
        <Field label="Los pagos sin cuenta salen de">
          <CuentaSelect cuentas={cuentas} value={pag} onChange={setPag} />
        </Field>
      </div>
      {error && <Alert tone="red">{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit" disabled={busy}>
          Guardar
        </Button>
      </div>
    </form>
  )
}

function SimularForm({ inicial, cuentas, onDone, onCancel }: { inicial: Partial<Sim>; cuentas: Cuenta[]; onDone: (m: string) => void; onCancel: () => void }) {
  const [origen, setOrigen] = useState(inicial.origen ?? cuentas.find((c) => c.id !== inicial.destino)?.id ?? '')
  const [destino, setDestino] = useState(inicial.destino ?? '')
  const [importe, setImporte] = useState(inicial.importe ? String(inicial.importe).replace('.', ',') : '')
  const [fs, setFs] = useState(inicial.fecha_salida ?? hoy())
  const [fa, setFa] = useState(inicial.fecha_acreditacion ?? hoy())
  const [nota, setNota] = useState(inicial.nota ?? '')
  const [error, setError] = useState<string | null>(null)
  const destinoEf = destino && destino !== origen ? destino : cuentas.find((c) => c.id !== origen)?.id ?? ''
  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const imp = parseMonto(importe)
    if (!(imp > 0)) return setError('Importe inválido.')
    if (!origen || !destinoEf || origen === destinoEf) return setError('Elegí dos cuentas distintas.')
    if (fa < fs) return setError('La acreditación no puede ser antes de la salida.')
    const { error } = await sb().from('tes_simulaciones').insert({ origen, destino: destinoEf, importe: imp, fecha_salida: fs, fecha_acreditacion: fa, nota: nota.trim() || null })
    if (error) return setError(errMsg(error))
    onDone('Simulación agregada: la proyección ya la tiene en cuenta. Los saldos reales no cambian.')
  }
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Sale de">
          <CuentaSelect id="sim-origen" cuentas={cuentas} value={origen} onChange={setOrigen} />
        </Field>
        <Field label="Entra en">
          <CuentaSelect id="sim-destino" cuentas={cuentas} value={destinoEf} onChange={setDestino} excluir={origen} />
        </Field>
        <Field label="Importe" required>
          <input id="sim-importe" className={inputCls} inputMode="decimal" value={importe} onChange={(e) => setImporte(e.target.value)} />
        </Field>
        <Field label="Nota">
          <input id="sim-nota" className={inputCls} value={nota} onChange={(e) => setNota(e.target.value)} />
        </Field>
        <Field label="Fecha de envío">
          <input id="sim-fs" type="date" className={inputCls} value={fs} min={hoy()} onChange={(e) => setFs(e.target.value)} />
        </Field>
        <Field label="Fecha de acreditación">
          <input id="sim-fa" type="date" className={inputCls} value={fa} min={fs} onChange={(e) => setFa(e.target.value)} />
        </Field>
      </div>
      <Alert tone="blue">Es solo para ver el efecto en la proyección. Para que se haga, Gerencia la confirma y se registra en Caja y Bancos.</Alert>
      {error && <Alert tone="red">{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit">Simular</Button>
      </div>
    </form>
  )
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
function nombreMes(mes: string) {
  const [y, m] = mes.split('-').map(Number)
  return `${MESES[m - 1]} ${y}`
}
function cambiarMes(mes: string, d: number) {
  const [y, m] = mes.split('-').map(Number)
  const t = y * 12 + (m - 1) + d
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}-01`
}
