'use client'

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { sb, errMsg } from '@/lib/supabase'
import { fmtFecha, fmtFechaHora, fmtFechaLarga, fmtMoney, hoy, parseMonto, sumarDias } from '@/lib/utils'
import {
  CHECKLIST_CIERRE, Categoria, Cuenta, Disponible, EventoJornada, Jornada, JornadaSaldo, Movimiento, TipoMov, cargarBase, disponibilidad, resumenPorCuenta,
} from '@/lib/tesoreria'
import { useAuth } from '@/components/AuthProvider'
import { ANCHOS_MOV, AccionMov, EjecutarForm, MovTabla, MovimientoForm, accionRapida, exportarExcel, filasMovimientos } from '@/components/Tesoreria'
import { Alert, Badge, Button, Card, Empty, Field, Modal, PageHeader, Spinner, Table, compactCls, cx, inputCls, td, th } from '@/components/ui'
import type { Celda } from '@/lib/xlsx-lite'

const JOR_SELECT = '*, saldos:tes_jornada_saldos(*), abridor:perfiles!abierta_por(nombre), cerrador:perfiles!cerrada_por(nombre)'
const MOV_SELECT = '*, autor:perfiles!created_by(nombre)'
const montoTxt = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n).replace('.', ','))

export default function JornadaPage() {
  const { puedeEditar, esGerencia } = useAuth()
  const [fecha, setFecha] = useState(hoy())
  const [base, setBase] = useState<{ cuentas: Cuenta[]; categorias: Categoria[] } | null>(null)
  const [jornada, setJornada] = useState<Jornada | null | undefined>(undefined)
  const [movs, setMovs] = useState<Movimiento[]>([])
  const [eventos, setEventos] = useState<EventoJornada[]>([])
  const [historial, setHistorial] = useState<Jornada[]>([])
  const [sistema, setSistema] = useState<Disponible[]>([])
  const [nuevo, setNuevo] = useState<TipoMov | null>(null)
  const [editar, setEditar] = useState<Movimiento | null>(null)
  const [ejecutar, setEjecutar] = useState<Movimiento | null>(null)
  const [msg, setMsg] = useState<{ tone: 'green' | 'red' | 'amber'; text: string } | null>(null)

  useEffect(() => {
    try {
      const f = new URLSearchParams(window.location.search).get('fecha')
      if (f && /^\d{4}-\d{2}-\d{2}$/.test(f)) setFecha(f)
    } catch {}
  }, [])

  const cargar = useCallback(async () => {
    const s = sb()
    try {
      const [b, j, m, h, d] = await Promise.all([
        cargarBase(),
        s.from('tes_jornadas').select(JOR_SELECT).eq('fecha', fecha).maybeSingle(),
        s.from('tes_movimientos').select(MOV_SELECT).eq('estado', 'realizado').eq('fecha_efectiva', fecha).order('created_at'),
        s.from('tes_jornadas').select(JOR_SELECT).order('fecha', { ascending: false }).limit(40),
        disponibilidad(sumarDias(fecha, -1)),
      ])
      setBase(b)
      const jo = (j.data as Jornada) ?? null
      setJornada(jo)
      setMovs((m.data as Movimiento[]) ?? [])
      setHistorial((h.data as Jornada[]) ?? [])
      setSistema(d)
      if (jo) {
        const { data } = await s.from('tes_jornada_eventos').select('*, autor:perfiles!usuario(nombre)').eq('jornada_id', jo.id).order('fecha')
        setEventos((data as EventoJornada[]) ?? [])
      } else setEventos([])
    } catch (e) {
      setMsg({ tone: 'red', text: errMsg(e) })
      setBase((x) => x ?? { cuentas: [], categorias: [] })
      setJornada(null)
    }
  }, [fecha])

  useEffect(() => {
    setJornada(undefined)
    cargar()
  }, [cargar])

  if (!puedeEditar) return <Empty>La apertura y cierre diario es exclusiva de Administración y Gerencia (A06).</Empty>
  if (!base || jornada === undefined) return <Spinner />
  const { cuentas, categorias } = base
  const activas = cuentas.filter((c) => c.activa)
  const anteriorAbierta = historial.find((h) => h.fecha < fecha && h.estado === 'abierta')

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

  async function reabrir() {
    const motivo = window.prompt('Motivo de la reapertura (queda en el historial):')
    if (!motivo?.trim()) return
    const { error } = await sb().rpc('tes_reabrir_jornada', { p_jornada: jornada!.id, p_motivo: motivo.trim() })
    if (error) return setMsg({ tone: 'red', text: errMsg(error) })
    setMsg({ tone: 'amber', text: 'Jornada reabierta. Corregí lo que haga falta y volvé a cerrarla.' })
    cargar()
  }

  async function corregirInicial(s: JornadaSaldo) {
    const c = cuentas.find((x) => x.id === s.cuenta_id)
    const v = window.prompt(`Nuevo saldo inicial de ${c?.nombre} (hoy ${fmtMoney(s.saldo_inicial)}):`, montoTxt(s.saldo_inicial))
    if (v === null) return
    const monto = parseMonto(v)
    if (!Number.isFinite(monto)) return setMsg({ tone: 'red', text: 'Monto inválido.' })
    const motivo = window.prompt('Motivo de la corrección:')
    if (!motivo?.trim()) return
    const { error } = await sb().rpc('tes_corregir_inicial', { p_jornada: jornada!.id, p_cuenta: s.cuenta_id, p_monto: monto, p_motivo: motivo.trim() })
    if (error) return setMsg({ tone: 'red', text: errMsg(error) })
    setMsg({ tone: 'green', text: 'Saldo inicial corregido. Queda en el historial.' })
    cargar()
  }

  const res = resumenPorCuenta(movs, fecha, fecha)

  function exportar() {
    if (!jornada) return
    const filas: Celda[][] = [
      ['Cuenta', 'Saldo inicial', 'Ingresos', 'Egresos', 'Transf. recibidas', 'Transf. enviadas', 'Esperado', 'Real', 'Diferencia', 'Justificación'],
      ...(jornada.saldos ?? []).map((s) => {
        const r = res.get(s.cuenta_id)
        const esp = Number(s.saldo_inicial) + (r ? r.ingresos - r.egresos + r.transfEntrada - r.transfSalida : 0)
        return [cuentas.find((c) => c.id === s.cuenta_id)?.nombre ?? '', Number(s.saldo_inicial), r?.ingresos ?? 0, r?.egresos ?? 0, r?.transfEntrada ?? 0, r?.transfSalida ?? 0, s.saldo_esperado ?? esp, s.saldo_real ?? '', s.diferencia ?? '', s.justificacion ?? '']
      }),
      [],
      ['Estado', jornada.estado === 'cerrada' ? 'Cerrada' : 'Abierta'],
      ['Abrió', `${jornada.abridor?.nombre ?? ''} ${fmtFechaHora(jornada.abierta_at)}`],
      ['Cerró', jornada.cerrada_at ? `${jornada.cerrador?.nombre ?? ''} ${fmtFechaHora(jornada.cerrada_at)}` : ''],
      ['Observaciones', jornada.observaciones ?? ''],
    ]
    const ev: Celda[][] = [['Fecha y hora', 'Acción', 'Usuario', 'Motivo'], ...eventos.map((e) => [fmtFechaHora(e.fecha), e.accion, e.autor?.nombre ?? '', e.motivo ?? ''])]
    exportarExcel(`cierre-${fecha}`, [
      { nombre: 'Cierre', filas, anchos: [20, 14, 14, 14, 16, 16, 14, 14, 14, 40] },
      { nombre: 'Movimientos', filas: filasMovimientos(movs, cuentas, categorias), anchos: ANCHOS_MOV },
      { nombre: 'Historial', filas: ev, anchos: [18, 14, 18, 40] },
    ])
  }

  return (
    <>
      <PageHeader
        title="Apertura y cierre"
        subtitle={
          <>
            A06 · <span className="capitalize">{fmtFechaLarga(fecha)}</span> · efectivo, Galicia y Macro por separado
          </>
        }
        actions={
          <div className="flex flex-wrap items-center gap-1">
            <Button variant="secondary" onClick={() => setFecha(sumarDias(fecha, -1))} aria-label="Día anterior">
              ‹
            </Button>
            <input id="jor-fecha" type="date" className={`${compactCls} w-40`} value={fecha} max={hoy()} onChange={(e) => e.target.value && setFecha(e.target.value)} aria-label="Fecha" />
            <Button variant="secondary" onClick={() => setFecha(sumarDias(fecha, 1))} disabled={fecha >= hoy()} aria-label="Día siguiente">
              ›
            </Button>
            {fecha !== hoy() && (
              <Button variant="ghost" onClick={() => setFecha(hoy())}>
                Hoy
              </Button>
            )}
            {jornada && (
              <Button variant="secondary" onClick={exportar}>
                Excel
              </Button>
            )}
          </div>
        }
      />

      {msg && (
        <Alert tone={msg.tone} className="mb-4">
          {msg.text}
        </Alert>
      )}
      {anteriorAbierta && (
        <Alert tone="red" className="mb-4">
          La jornada del <b>{fmtFecha(anteriorAbierta.fecha)}</b> sigue abierta. Cerrala antes de seguir.{' '}
          <button className="font-medium underline" onClick={() => setFecha(anteriorAbierta.fecha)}>
            Ir a ese día
          </button>
        </Alert>
      )}

      {!jornada ? (
        <Apertura fecha={fecha} cuentas={activas} sistema={sistema} bloqueada={!!anteriorAbierta} onDone={listo(() => {})} />
      ) : jornada.estado === 'abierta' ? (
        <Cierre jornada={jornada} cuentas={cuentas} res={res} onCorregir={corregirInicial} onDone={listo(() => {})} />
      ) : (
        <Card
          title={
            <span className="flex items-center gap-2">
              Jornada cerrada <Badge tone="green">Cerrada</Badge>
            </span>
          }
          subtitle={`Cerró ${jornada.cerrador?.nombre ?? '—'} el ${fmtFechaHora(jornada.cerrada_at)} · abrió ${jornada.abridor?.nombre ?? '—'} el ${fmtFechaHora(jornada.abierta_at)}`}
          actions={
            esGerencia ? (
              <Button variant="secondary" size="sm" onClick={reabrir}>
                Reabrir para corregir
              </Button>
            ) : (
              <span className="text-xs text-slate-500">Para corregir, Gerencia tiene que reabrirla</span>
            )
          }
          pad={false}
        >
          <TablaCierre jornada={jornada} cuentas={cuentas} res={res} />
          {jornada.observaciones && <p className="border-t border-slate-100 px-4 py-2 text-sm text-slate-600">Observaciones: {jornada.observaciones}</p>}
        </Card>
      )}

      {jornada && (
        <Card
          className="mt-5"
          title="Movimientos del día"
          subtitle="Realizados con fecha efectiva de este día"
          pad={false}
          actions={
            jornada.estado === 'abierta' && (
              <>
                <Button size="sm" variant="success" onClick={() => setNuevo('ingreso')}>
                  + Ingreso
                </Button>
                <Button size="sm" variant="danger" onClick={() => setNuevo('egreso')}>
                  + Egreso
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setNuevo('transferencia')}>
                  ⇄ Transferencia
                </Button>
              </>
            )
          }
        >
          <MovTabla movs={movs} cuentas={cuentas} categorias={categorias} onAccion={jornada.estado === 'abierta' ? accion : undefined} vacio="No hay movimientos realizados este día." />
        </Card>
      )}

      {eventos.length > 0 && (
        <Card className="mt-5" title="Historial de esta jornada" subtitle="Aperturas, cierres, reaperturas y correcciones" pad={false}>
          <ul className="divide-y divide-slate-100">
            {eventos.map((e) => (
              <li key={e.id} className="px-4 py-2.5 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={e.accion === 'cierre' ? 'green' : e.accion === 'reapertura' ? 'amber' : e.accion === 'correccion' ? 'orange' : 'blue'}>
                    {e.accion === 'correccion' ? 'Corrección' : e.accion.charAt(0).toUpperCase() + e.accion.slice(1)}
                  </Badge>
                  <span className="text-slate-600">
                    {fmtFechaHora(e.fecha)} · {e.autor?.nombre ?? '—'}
                  </span>
                </div>
                {e.motivo && <div className="mt-0.5 text-slate-700">{e.motivo}</div>}
                <DetalleEvento e={e} cuentas={cuentas} />
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="mt-5" title="Jornadas anteriores" pad={false}>
        {historial.length === 0 ? (
          <Empty>Todavía no hay jornadas.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <th className={th}>Fecha</th>
                <th className={th}>Estado</th>
                {activas.map((c) => (
                  <th key={c.id} className={`${th} text-right`}>
                    {c.nombre}
                  </th>
                ))}
                <th className={`${th} text-right`}>Diferencias</th>
                <th className={th}>Cerró</th>
              </tr>
            </thead>
            <tbody>
              {historial.map((h) => {
                const dif = (h.saldos ?? []).reduce((a, s) => a + Math.abs(Number(s.diferencia ?? 0)), 0)
                return (
                  <tr key={h.id} className={cx('cursor-pointer hover:bg-brand-50/40', h.fecha === fecha && 'bg-brand-50/60')} onClick={() => setFecha(h.fecha)}>
                    <td className={`${td} whitespace-nowrap`}>{fmtFecha(h.fecha)}</td>
                    <td className={td}>
                      <Badge tone={h.estado === 'cerrada' ? 'green' : 'amber'}>{h.estado === 'cerrada' ? 'Cerrada' : 'Abierta'}</Badge>
                    </td>
                    {activas.map((c) => {
                      const s = h.saldos?.find((x) => x.cuenta_id === c.id)
                      return (
                        <td key={c.id} className={`${td} text-right tabular-nums`}>
                          {s ? fmtMoney(s.saldo_real ?? s.saldo_inicial) : '—'}
                        </td>
                      )
                    })}
                    <td className={cx(td, 'text-right tabular-nums', dif > 0 && 'font-semibold text-amber-800')}>{h.estado === 'cerrada' ? (dif ? fmtMoney(dif) : 'Sin diferencias') : '—'}</td>
                    <td className={`${td} text-sm text-slate-600`}>{h.cerrador?.nombre ?? '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </Table>
        )}
        <p className="px-4 py-2 text-xs text-slate-500">Saldo real de cierre (o inicial si sigue abierta). Tocá una fila para verla.</p>
      </Card>

      <Modal open={!!nuevo} onClose={() => setNuevo(null)} title={nuevo === 'transferencia' ? 'Transferencia entre cuentas propias' : nuevo === 'ingreso' ? 'Nuevo ingreso' : 'Nuevo egreso'} wide>
        {nuevo && <MovimientoForm key={nuevo} cuentas={cuentas} categorias={categorias} preset={{ tipo: nuevo, fecha }} onCancel={() => setNuevo(null)} onSaved={listo(() => setNuevo(null))} />}
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

// ---------------------------------------------------------------------
function Apertura({ fecha, cuentas, sistema, bloqueada, onDone }: { fecha: string; cuentas: Cuenta[]; sistema: Disponible[]; bloqueada: boolean; onDone: (msg: string) => void }) {
  const sis = (id: string) => sistema.find((s) => s.cuenta_id === id)?.saldo ?? 0
  const [valores, setValores] = useState<Record<string, string>>(() => Object.fromEntries(cuentas.map((c) => [c.id, montoTxt(sis(c.id))])))
  const [obs, setObs] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setValores(Object.fromEntries(cuentas.map((c) => [c.id, montoTxt(sistema.find((s) => s.cuenta_id === c.id)?.saldo ?? 0)])))
  }, [cuentas, sistema])

  const difs = cuentas.map((c) => ({ c, v: parseMonto(valores[c.id] ?? ''), s: sis(c.id) })).filter((x) => Number.isFinite(x.v) && Math.abs(x.v - x.s) > 0.004)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const saldos = cuentas.map((c) => ({ cuenta_id: c.id, saldo_inicial: parseMonto(valores[c.id] ?? '') }))
    if (saldos.some((s) => !Number.isFinite(s.saldo_inicial))) return setError('Revisá los saldos: hay uno vacío o mal escrito.')
    if (difs.length && !obs.trim()) return setError('Hay saldos distintos a los del cierre anterior: explicá por qué en observaciones.')
    setBusy(true)
    const { error } = await sb().rpc('tes_abrir_jornada', { p_fecha: fecha, p_saldos: saldos, p_obs: obs.trim() || null })
    setBusy(false)
    if (error) return setError(errMsg(error))
    onDone('Jornada abierta. Cargá los movimientos y al final del día cerrala.')
  }

  return (
    <Card title="Abrir jornada" subtitle="Contá el efectivo y mirá el saldo de Galicia y Macro en el homebanking. Se propone el saldo que dejó el cierre anterior.">
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          {cuentas.map((c) => (
            <Field key={c.id} label={`${c.nombre} · saldo inicial`} hint={`Según el sistema: ${fmtMoney(sis(c.id))}`}>
              <input
                id={`ap-${c.codigo}`}
                className={inputCls}
                inputMode="decimal"
                value={valores[c.id] ?? ''}
                onChange={(e) => setValores({ ...valores, [c.id]: e.target.value })}
              />
            </Field>
          ))}
        </div>
        {difs.length > 0 && (
          <Alert tone="amber">
            {difs.map((d) => (
              <div key={d.c.id}>
                {d.c.nombre}: {fmtMoney(d.v)} contra {fmtMoney(d.s)} del sistema (diferencia {fmtMoney(d.v - d.s)}).
              </div>
            ))}
          </Alert>
        )}
        <Field label="Observaciones" required={difs.length > 0}>
          <input id="ap-obs" className={inputCls} value={obs} onChange={(e) => setObs(e.target.value)} />
        </Field>
        {error && <Alert tone="red">{error}</Alert>}
        <div className="flex justify-end">
          <Button type="submit" disabled={busy || bloqueada}>
            {busy ? 'Abriendo…' : 'Abrir jornada'}
          </Button>
        </div>
      </form>
    </Card>
  )
}

// ---------------------------------------------------------------------
type Res = ReturnType<typeof resumenPorCuenta>

function esperadoDe(s: JornadaSaldo, res: Res) {
  const r = res.get(s.cuenta_id)
  return Number(s.saldo_inicial) + (r ? r.ingresos - r.egresos + r.transfEntrada - r.transfSalida : 0)
}

function Cierre({ jornada, cuentas, res, onCorregir, onDone }: { jornada: Jornada; cuentas: Cuenta[]; res: Res; onCorregir: (s: JornadaSaldo) => void; onDone: (msg: string) => void }) {
  const saldos = useMemo(() => [...(jornada.saldos ?? [])].sort((a, b) => (cuentas.find((c) => c.id === a.cuenta_id)?.orden ?? 0) - (cuentas.find((c) => c.id === b.cuenta_id)?.orden ?? 0)), [jornada, cuentas])
  const [reales, setReales] = useState<Record<string, string>>({})
  const [just, setJust] = useState<Record<string, string>>({})
  const [check, setCheck] = useState<Record<string, boolean>>(() => ({ ...(jornada.checklist ?? {}) }))
  const [obs, setObs] = useState(jornada.observaciones ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const nombre = (id: string) => cuentas.find((c) => c.id === id)?.nombre ?? ''
  const filas = saldos.map((s) => {
    const esp = esperadoDe(s, res)
    const txt = reales[s.cuenta_id] ?? ''
    const real = txt.trim() === '' ? null : parseMonto(txt)
    const dif = real === null || !Number.isFinite(real) ? null : Math.round((real - esp) * 100) / 100
    return { s, esp, real, dif, r: res.get(s.cuenta_id) }
  })
  const faltaCheck = CHECKLIST_CIERRE.filter((c) => !check[c.key])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    for (const f of filas) {
      if (f.real === null || !Number.isFinite(f.real)) return setError(`Falta el saldo real de ${nombre(f.s.cuenta_id)}.`)
      if (f.dif && !(just[f.s.cuenta_id] ?? '').trim()) return setError(`${nombre(f.s.cuenta_id)} tiene una diferencia de ${fmtMoney(f.dif)}: justificala.`)
    }
    if (faltaCheck.length) return setError(`Falta tildar: ${faltaCheck.map((c) => c.label).join(', ')}.`)
    setBusy(true)
    const { error } = await sb().rpc('tes_cerrar_jornada', {
      p_jornada: jornada.id,
      p_reales: filas.map((f) => ({ cuenta_id: f.s.cuenta_id, saldo_real: f.real, justificacion: (just[f.s.cuenta_id] ?? '').trim() || null })),
      p_checklist: Object.fromEntries(CHECKLIST_CIERRE.map((c) => [c.key, !!check[c.key]])),
      p_obs: obs.trim() || null,
    })
    setBusy(false)
    if (error) return setError(errMsg(error))
    onDone('Jornada cerrada. Los saldos reales quedan como punto de partida de mañana.')
  }

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          Cerrar jornada <Badge tone="amber">Abierta</Badge>
        </span>
      }
      subtitle={`Abrió ${jornada.abridor?.nombre ?? '—'} el ${fmtFechaHora(jornada.abierta_at)}. Contá el efectivo y mirá el saldo real de cada banco.`}
      pad={false}
    >
      <form onSubmit={onSubmit}>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr>
                <th className={th}>Cuenta</th>
                <th className={`${th} text-right`}>Inicial</th>
                <th className={`${th} text-right`}>Ingresos</th>
                <th className={`${th} text-right`}>Egresos</th>
                <th className={`${th} text-right`}>Transf. ±</th>
                <th className={`${th} text-right`}>Esperado</th>
                <th className={th}>Real</th>
                <th className={`${th} text-right`}>Diferencia</th>
              </tr>
            </thead>
            <tbody>
              {filas.map(({ s, esp, dif, r }) => {
                const t = (r?.transfEntrada ?? 0) - (r?.transfSalida ?? 0)
                return (
                  <tr key={s.id}>
                    <td className={`${td} font-medium`}>
                      {nombre(s.cuenta_id)}
                      <button type="button" className="block text-[11px] font-normal text-slate-400 underline hover:text-slate-600" onClick={() => onCorregir(s)}>
                        corregir inicial
                      </button>
                    </td>
                    <td className={`${td} text-right tabular-nums`}>{fmtMoney(s.saldo_inicial)}</td>
                    <td className={`${td} text-right tabular-nums text-emerald-700`}>{r?.ingresos ? fmtMoney(r.ingresos) : '—'}</td>
                    <td className={`${td} text-right tabular-nums text-red-700`}>{r?.egresos ? fmtMoney(r.egresos) : '—'}</td>
                    <td className={`${td} text-right tabular-nums text-sky-700`}>{t ? `${t > 0 ? '+' : '−'} ${fmtMoney(Math.abs(t))}` : '—'}</td>
                    <td className={`${td} text-right font-semibold tabular-nums`}>{fmtMoney(esp)}</td>
                    <td className={td}>
                      <input
                        id={`real-${s.cuenta_id}`}
                        className={`${inputCls} w-36`}
                        inputMode="decimal"
                        value={reales[s.cuenta_id] ?? ''}
                        onChange={(e) => setReales({ ...reales, [s.cuenta_id]: e.target.value })}
                        placeholder={montoTxt(esp)}
                        aria-label={`Saldo real ${nombre(s.cuenta_id)}`}
                      />
                    </td>
                    <td className={cx(td, 'text-right font-semibold tabular-nums', dif === null ? 'text-slate-400' : dif === 0 ? 'text-emerald-700' : 'text-red-700')}>
                      {dif === null ? '—' : dif === 0 ? 'OK' : fmtMoney(dif)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {filas.some((f) => f.dif) && (
          <div className="grid gap-3 border-t border-slate-100 p-4 sm:grid-cols-2">
            {filas
              .filter((f) => f.dif)
              .map((f) => (
                <Field key={f.s.cuenta_id} label={`Justificación diferencia ${nombre(f.s.cuenta_id)} (${fmtMoney(f.dif)})`} required>
                  <input id={`just-${f.s.cuenta_id}`} className={inputCls} value={just[f.s.cuenta_id] ?? ''} onChange={(e) => setJust({ ...just, [f.s.cuenta_id]: e.target.value })} placeholder="Ej: faltante de cambio, comisión no cargada…" />
                </Field>
              ))}
            <p className="text-xs text-slate-500 sm:col-span-2">
              Si la diferencia es por algo que no se cargó (un débito, una comisión), mejor cargalo como movimiento y volvé a mirar: así la diferencia queda en cero.
            </p>
          </div>
        )}
        <div className="grid gap-4 border-t border-slate-100 p-4 lg:grid-cols-2">
          <fieldset>
            <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Checklist de cierre</legend>
            <div className="space-y-1.5">
              {CHECKLIST_CIERRE.map((c) => (
                <label key={c.key} className="flex items-center gap-2 text-sm">
                  <input id={`chk-${c.key}`} type="checkbox" className="h-4 w-4 accent-brand-700" checked={!!check[c.key]} onChange={(e) => setCheck({ ...check, [c.key]: e.target.checked })} />
                  {c.label}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="space-y-3">
            <Field label="Observaciones del día">
              <textarea id="cie-obs" className={inputCls} rows={3} value={obs} onChange={(e) => setObs(e.target.value)} />
            </Field>
            {error && <Alert tone="red">{error}</Alert>}
            <div className="flex justify-end">
              <Button type="submit" disabled={busy}>
                {busy ? 'Cerrando…' : 'Cerrar jornada'}
              </Button>
            </div>
          </div>
        </div>
      </form>
    </Card>
  )
}

function TablaCierre({ jornada, cuentas, res }: { jornada: Jornada; cuentas: Cuenta[]; res: Res }) {
  const nombre = (id: string) => cuentas.find((c) => c.id === id)?.nombre ?? ''
  return (
    <Table>
      <thead>
        <tr>
          <th className={th}>Cuenta</th>
          <th className={`${th} text-right`}>Inicial</th>
          <th className={`${th} text-right`}>Ingresos</th>
          <th className={`${th} text-right`}>Egresos</th>
          <th className={`${th} text-right`}>Transf. ±</th>
          <th className={`${th} text-right`}>Esperado</th>
          <th className={`${th} text-right`}>Real</th>
          <th className={`${th} text-right`}>Diferencia</th>
          <th className={th}>Justificación</th>
        </tr>
      </thead>
      <tbody>
        {(jornada.saldos ?? []).map((s) => {
          const r = res.get(s.cuenta_id)
          const d = Number(s.diferencia ?? 0)
          const t = (r?.transfEntrada ?? 0) - (r?.transfSalida ?? 0)
          return (
            <tr key={s.id}>
              <td className={`${td} font-medium`}>{nombre(s.cuenta_id)}</td>
              <td className={`${td} text-right tabular-nums`}>{fmtMoney(s.saldo_inicial)}</td>
              <td className={`${td} text-right tabular-nums text-emerald-700`}>{r?.ingresos ? fmtMoney(r.ingresos) : '—'}</td>
              <td className={`${td} text-right tabular-nums text-red-700`}>{r?.egresos ? fmtMoney(r.egresos) : '—'}</td>
              <td className={`${td} text-right tabular-nums text-sky-700`}>{t ? `${t > 0 ? '+' : '−'} ${fmtMoney(Math.abs(t))}` : '—'}</td>
              <td className={`${td} text-right tabular-nums`}>{fmtMoney(s.saldo_esperado)}</td>
              <td className={`${td} text-right font-semibold tabular-nums`}>{fmtMoney(s.saldo_real)}</td>
              <td className={cx(td, 'text-right font-semibold tabular-nums', d === 0 ? 'text-emerald-700' : 'text-red-700')}>{d === 0 ? 'OK' : fmtMoney(d)}</td>
              <td className={`${td} text-sm text-slate-600`}>{s.justificacion ?? ''}</td>
            </tr>
          )
        })}
      </tbody>
    </Table>
  )
}

function DetalleEvento({ e, cuentas }: { e: EventoJornada; cuentas: Cuenta[] }) {
  const d = e.datos as Record<string, unknown> | Record<string, unknown>[] | null
  if (!d) return null
  const nombre = (x: Record<string, unknown>) => (x.cuenta as string) ?? cuentas.find((c) => c.id === x.cuenta_id)?.nombre ?? ''
  if (Array.isArray(d)) {
    return (
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-500">
        {d.map((x, i) => (
          <span key={i}>
            {nombre(x)}:{' '}
            {e.accion === 'apertura'
              ? `inicial ${fmtMoney(x.inicial as number)}${x.sistema !== x.inicial ? ` (sistema ${fmtMoney(x.sistema as number)})` : ''}`
              : `real ${fmtMoney(x.real as number)}${Number(x.diferencia ?? 0) !== 0 ? ` · dif. ${fmtMoney(x.diferencia as number)}` : ''}`}
          </span>
        ))}
      </div>
    )
  }
  if (e.accion === 'correccion') {
    return (
      <div className="mt-1 text-xs text-slate-500">
        {nombre(d)}: {fmtMoney(d.antes as number)} → {fmtMoney(d.despues as number)}
      </div>
    )
  }
  return null
}
