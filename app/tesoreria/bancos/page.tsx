'use client'

import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { sb, errMsg } from '@/lib/supabase'
import { fmtFecha, fmtMoney, hoy, sumarDias } from '@/lib/utils'
import {
  Categoria, Cheque, Cuenta, Disponible, Extracto, Movimiento, cargarBase, disponibilidad, firmado, normTxt, parseFechaExtracto, parseImporte, sugerirConciliacion,
} from '@/lib/tesoreria'
import { Obligacion, fechaPago } from '@/lib/pagos'
import { useAuth } from '@/components/AuthProvider'
import { CategoriaSelect, exportarExcel } from '@/components/Tesoreria'
import { Alert, Badge, Button, Card, Empty, Field, Modal, PageHeader, Spinner, Stat, cx, compactCls, inputCls } from '@/components/ui'
import type { Celda } from '@/lib/xlsx-lite'

const MOV_SELECT = '*, autor:perfiles!created_by(nombre)'

export default function BancosPage() {
  const { puedeEditar } = useAuth()
  const [base, setBase] = useState<{ cuentas: Cuenta[]; categorias: Categoria[] } | null>(null)
  const [cuentaId, setCuentaId] = useState('')
  const [ext, setExt] = useState<Extracto[]>([])
  const [movs, setMovs] = useState<Movimiento[]>([])
  const [disp, setDisp] = useState<Disponible[]>([])
  const [chEmit, setChEmit] = useState<Cheque[]>([])
  const [oblsCta, setOblsCta] = useState<Obligacion[]>([])
  const [importar, setImportar] = useState(false)
  const [crear, setCrear] = useState<Extracto | null>(null)
  const [elegir, setElegir] = useState<Extracto | null>(null)
  const [verConciliados, setVerConciliados] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'green' | 'red' | 'amber'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const cargar = useCallback(async () => {
    const s = sb()
    try {
      const b = await cargarBase()
      setBase(b)
      const bancos = b.cuentas.filter((c) => c.tipo === 'banco' && c.activa)
      const id = cuentaId || bancos[0]?.id || ''
      if (!cuentaId && id) setCuentaId(id)
      if (!id) return
      const desde = sumarDias(hoy(), -120)
      const [e, m, d, ch, ob] = await Promise.all([
        s.from('tes_extractos').select('*').eq('cuenta_id', id).gte('fecha', desde).order('fecha', { ascending: false }).order('created_at').limit(2000),
        s.from('tes_movimientos').select(MOV_SELECT).eq('cuenta_id', id).neq('estado', 'anulado').eq('conciliado', false).gte('fecha_prevista', sumarDias(desde, -60)).order('fecha_prevista'),
        disponibilidad(hoy()),
        s.from('tes_cheques').select('*').eq('cuenta_id', id).eq('estado', 'emitido').order('fecha_pago'),
        s.from('pag_obligaciones').select('*').in('estado', ['autorizado', 'programado', 'reprogramado']).eq('cuenta_id', id),
      ])
      setChEmit((ch.data as Cheque[]) ?? [])
      setOblsCta(((ob.data as Obligacion[]) ?? []).filter((o) => Number(o.saldo) > 0))
      setExt((e.data as Extracto[]) ?? [])
      setMovs((m.data as Movimiento[]) ?? [])
      setDisp(d)
    } catch (e) {
      setMsg({ tone: 'red', text: errMsg(e) })
      setBase((x) => x ?? { cuentas: [], categorias: [] })
    }
  }, [cuentaId])

  useEffect(() => {
    if (puedeEditar) cargar()
  }, [cargar, puedeEditar])

  const pendientes = useMemo(() => ext.filter((e) => e.estado === 'pendiente').sort((a, b) => a.fecha.localeCompare(b.fecha)), [ext])
  const sugerencias = useMemo(() => {
    const usados = new Set<string>()
    const r = new Map<string, Movimiento>()
    for (const e of pendientes) {
      const m = sugerirConciliacion(e, movs, usados)
      if (m) {
        usados.add(m.id)
        r.set(e.id, m)
      }
    }
    return r
  }, [pendientes, movs])

  if (!puedeEditar) return <Empty>Tesorería es exclusiva de Administración y Gerencia.</Empty>
  if (!base) return <Spinner />
  const { cuentas, categorias } = base
  const bancos = cuentas.filter((c) => c.tipo === 'banco' && c.activa)
  const cuenta = cuentas.find((c) => c.id === cuentaId)
  if (!cuenta) return <Empty>No hay cuentas bancarias activas.</Empty>

  const realizadosSinVer = movs.filter((m) => m.estado === 'realizado')
  const previstosBanco = movs.filter((m) => m.estado !== 'realizado' && m.fecha_prevista <= hoy())
  const ultimoSaldo = ext.find((e) => e.saldo !== null)
  const saldoSistema = disp.find((d) => d.cuenta_id === cuentaId)?.saldo ?? 0
  const conciliados = ext.filter((e) => e.estado !== 'pendiente')
  const movPorId = new Map(movs.map((m) => [m.id, m]))

  async function rpc(nombre: string, args: Record<string, unknown>, ok: string) {
    setMsg(null)
    const { error } = await sb().rpc(nombre, args)
    if (error) return setMsg({ tone: 'red', text: errMsg(error) }), false
    setMsg({ tone: 'green', text: ok })
    cargar()
    return true
  }

  async function conciliarSugeridos() {
    setBusy(true)
    let ok = 0
    let err = ''
    for (const [eid, m] of Array.from(sugerencias.entries())) {
      const { error } = await sb().rpc('tes_conciliar', { p_extracto: eid, p_mov: m.id })
      if (error) err = errMsg(error)
      else ok++
    }
    setBusy(false)
    setMsg(err ? { tone: 'amber', text: `Se conciliaron ${ok}. Error en alguno: ${err}` } : { tone: 'green', text: `Se conciliaron ${ok} líneas.` })
    cargar()
  }

  async function ignorar(e: Extracto) {
    const nota = window.prompt('¿Por qué se ignora esta línea? (ej: ya está incluida en otro movimiento)')
    if (!nota?.trim()) return
    const { error } = await sb().from('tes_extractos').update({ estado: 'ignorado', nota: nota.trim() }).eq('id', e.id)
    if (error) return setMsg({ tone: 'red', text: errMsg(error) })
    cargar()
  }

  async function borrar(e: Extracto) {
    if (!window.confirm(`¿Borrar la línea "${e.descripcion}" ${fmtMoney(e.importe)}? (si se importó por error)`)) return
    const { error } = await sb().from('tes_extractos').delete().eq('id', e.id)
    if (error) return setMsg({ tone: 'red', text: errMsg(error) })
    cargar()
  }

  function exportar() {
    const fila = (e: Extracto): Celda[] => {
      const m = e.movimiento_id ? movPorId.get(e.movimiento_id) : null
      return [fmtFecha(e.fecha), e.descripcion, e.referencia ?? '', Number(e.importe), e.saldo ?? '', e.estado === 'pendiente' ? 'Sin identificar' : e.estado === 'conciliado' ? 'Conciliado' : 'Ignorado', m?.concepto ?? '', e.nota ?? '']
    }
    exportarExcel(`conciliacion-${cuenta!.codigo}-${hoy()}`, [
      {
        nombre: 'Extracto',
        filas: [['Fecha', 'Descripción', 'Referencia', 'Importe', 'Saldo', 'Estado', 'Movimiento', 'Nota'], ...ext.map(fila)],
        anchos: [12, 40, 16, 14, 14, 16, 36, 30],
      },
      {
        nombre: 'Cargado sin ver en banco',
        filas: [['Fecha', 'Concepto', 'Comprobante', 'Importe', 'Estado'], ...[...realizadosSinVer, ...previstosBanco].map((m) => [fmtFecha(m.fecha_efectiva ?? m.fecha_prevista), m.concepto, m.comprobante ?? '', firmado(m), m.estado])],
        anchos: [12, 40, 18, 14, 14],
      },
    ])
  }

  return (
    <>
      <PageHeader
        title="Bancos y conciliación"
        subtitle="Cada banco por separado. Importá el extracto y se cruza con lo cargado: lo que no aparece de un lado o del otro queda a la vista."
        actions={
          <>
            <Button variant="secondary" onClick={exportar}>
              Excel
            </Button>
            <Button onClick={() => setImportar(true)}>Importar extracto</Button>
          </>
        }
      />
      <div className="mb-4 inline-flex rounded-lg border border-slate-300 bg-white p-0.5">
        {bancos.map((b) => (
          <button key={b.id} onClick={() => setCuentaId(b.id)} className={cx('rounded-md px-4 py-1.5 text-sm font-medium', b.id === cuentaId ? 'bg-brand-700 text-white' : 'text-slate-600 hover:bg-slate-50')}>
            {b.nombre}
          </button>
        ))}
      </div>
      {msg && (
        <Alert tone={msg.tone} className="mb-4">
          {msg.text}
        </Alert>
      )}

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Saldo según el sistema" value={fmtMoney(saldoSistema)} sub="Movimientos realizados" tone="brand" />
        <Stat
          label="Saldo según el banco"
          value={ultimoSaldo ? fmtMoney(ultimoSaldo.saldo) : '—'}
          sub={ultimoSaldo ? `Extracto al ${fmtFecha(ultimoSaldo.fecha)}` : 'Importá un extracto con saldo'}
          tone="slate"
        />
        <Stat label="Extracto sin identificar" value={pendientes.length} sub={pendientes.length ? fmtMoney(pendientes.reduce((a, e) => a + Number(e.importe), 0)) : 'Todo identificado'} tone={pendientes.length ? 'amber' : 'green'} />
        <Stat label="Cargado sin ver en el banco" value={realizadosSinVer.length} sub={realizadosSinVer.length ? fmtMoney(realizadosSinVer.reduce((a, m) => a + firmado(m), 0)) : '—'} tone={realizadosSinVer.length ? 'amber' : 'green'} />
      </div>

      <Card className="mb-5" title="Débitos pendientes" subtitle="Lo que va a salir de esta cuenta y todavía no salió: cheques emitidos, transferencias programadas y pagos autorizados" pad={false}>
        {chEmit.length + oblsCta.length + movs.filter((m) => m.tipo === 'transferencia' && m.sentido === 'salida' && m.estado === 'pendiente').length === 0 ? (
          <Empty>No hay débitos pendientes.</Empty>
        ) : (
          <ul className="divide-y divide-slate-100">
            {[
              ...chEmit.map((c) => ({ id: c.id, f: c.fecha_pago, t: `${c.formato === 'echeq' ? 'E-cheq' : 'Cheque'} N° ${c.numero} · ${c.contraparte}`, b: 'Cheque emitido', imp: Number(c.importe) })),
              ...movs
                .filter((m) => m.tipo === 'transferencia' && m.sentido === 'salida' && m.estado === 'pendiente')
                .map((m) => ({ id: m.id, f: m.fecha_prevista, t: m.concepto, b: 'Transferencia programada', imp: Number(m.importe) })),
              ...oblsCta.map((o) => ({ id: o.id, f: fechaPago(o) ?? '', t: `${o.proveedor} · ${o.concepto ?? o.comprobante ?? ''}`, b: 'Pago autorizado', imp: Number(o.saldo) })),
            ]
              .sort((a, b) => (a.f || '9999').localeCompare(b.f || '9999'))
              .map((x) => (
                <li key={x.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
                  <div className="w-24 shrink-0 text-slate-600">{x.f ? fmtFecha(x.f) : 'Sin fecha'}</div>
                  <div className="min-w-0 flex-1">{x.t}</div>
                  <Badge tone="amber">{x.b}</Badge>
                  <div className="w-32 text-right font-semibold tabular-nums text-red-700">− {fmtMoney(x.imp)}</div>
                </li>
              ))}
          </ul>
        )}
      </Card>

      <Card
        title="Extracto sin identificar"
        subtitle="Débitos y créditos del banco que todavía no están unidos a un movimiento"
        pad={false}
        actions={
          sugerencias.size > 0 && (
            <Button size="sm" variant="success" onClick={conciliarSugeridos} disabled={busy}>
              Conciliar los {sugerencias.size} sugeridos
            </Button>
          )
        }
      >
        {pendientes.length === 0 ? (
          <Empty>{ext.length ? 'Todo el extracto está identificado.' : 'Importá el extracto del banco para empezar a conciliar.'}</Empty>
        ) : (
          <ul className="divide-y divide-slate-100">
            {pendientes.map((e) => {
              const sug = sugerencias.get(e.id)
              return (
                <li key={e.id} className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3">
                  <div className="w-20 shrink-0 text-sm text-slate-600">{fmtFecha(e.fecha)}</div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-slate-900">{e.descripcion}</div>
                    {e.referencia && <div className="text-xs text-slate-500">Ref. {e.referencia}</div>}
                    {sug ? (
                      <div className="mt-1 text-xs text-emerald-700">
                        Coincide con: <b>{sug.concepto}</b> · {fmtFecha(sug.fecha_efectiva ?? sug.fecha_prevista)}
                        {sug.estado !== 'realizado' && ' (al conciliar queda realizado)'}
                      </div>
                    ) : (
                      <div className="mt-1 text-xs text-amber-700">{e.importe < 0 ? 'Débito no identificado' : 'Crédito no identificado'}</div>
                    )}
                  </div>
                  <div className={cx('w-32 text-right text-sm font-semibold tabular-nums', e.importe > 0 ? 'text-emerald-700' : 'text-red-700')}>
                    {e.importe > 0 ? '+' : '−'} {fmtMoney(Math.abs(e.importe))}
                  </div>
                  <div className="flex w-full flex-wrap justify-end gap-1 sm:w-auto">
                    {sug && (
                      <Button size="sm" variant="success" onClick={() => rpc('tes_conciliar', { p_extracto: e.id, p_mov: sug.id }, 'Conciliado.')}>
                        Conciliar
                      </Button>
                    )}
                    <Button size="sm" variant="secondary" onClick={() => setElegir(e)}>
                      Elegir
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => setCrear(e)}>
                      Cargar
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => ignorar(e)}>
                      Ignorar
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => borrar(e)} aria-label="Borrar línea">
                      ✕
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      <Card className="mt-5" title="Cargado sin ver en el banco" subtitle="Movimientos de esta cuenta que no aparecen en el extracto importado" pad={false}>
        {realizadosSinVer.length + previstosBanco.length === 0 ? (
          <Empty>No hay movimientos pendientes de ver en el banco.</Empty>
        ) : (
          <ul className="divide-y divide-slate-100">
            {[...realizadosSinVer, ...previstosBanco].map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                <div className="w-20 shrink-0 text-slate-600">{fmtFecha(m.fecha_efectiva ?? m.fecha_prevista)}</div>
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{m.concepto}</div>
                  <div className="text-xs text-slate-500">{[m.contraparte, m.comprobante].filter(Boolean).join(' · ')}</div>
                </div>
                {m.estado !== 'realizado' && <Badge tone="amber">{m.cheque_id ? 'Cheque a acreditar/debitar' : 'Previsto, vencido'}</Badge>}
                <div className={cx('w-32 text-right font-semibold tabular-nums', m.sentido === 'entrada' ? 'text-emerald-700' : 'text-red-700')}>
                  {m.sentido === 'entrada' ? '+' : '−'} {fmtMoney(m.importe)}
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
          Si algo figura acá hace varios días, revisá si se cargó en la cuenta equivocada o si el banco todavía no lo procesó.
        </p>
      </Card>

      <Card
        className="mt-5"
        title={`Ya conciliado o ignorado (${conciliados.length})`}
        pad={false}
        actions={
          <Button size="sm" variant="ghost" onClick={() => setVerConciliados((v) => !v)}>
            {verConciliados ? 'Ocultar' : 'Ver'}
          </Button>
        }
      >
        {verConciliados &&
          (conciliados.length === 0 ? (
            <Empty>Nada todavía.</Empty>
          ) : (
            <ul className="divide-y divide-slate-100">
              {conciliados.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
                  <div className="w-20 shrink-0 text-slate-600">{fmtFecha(e.fecha)}</div>
                  <div className="min-w-0 flex-1">
                    {e.descripcion}
                    {e.nota && <div className="text-xs text-slate-500">{e.nota}</div>}
                  </div>
                  <Badge tone={e.estado === 'conciliado' ? 'brand' : 'slate'}>{e.estado === 'conciliado' ? 'Conciliado' : 'Ignorado'}</Badge>
                  <div className="w-28 text-right tabular-nums">{fmtMoney(e.importe)}</div>
                  <Button size="sm" variant="ghost" onClick={() => rpc('tes_desconciliar', { p_extracto: e.id }, 'Línea liberada: vuelve a quedar sin identificar.')}>
                    Deshacer
                  </Button>
                </li>
              ))}
            </ul>
          ))}
      </Card>

      <Modal open={importar} onClose={() => setImportar(false)} title={`Importar extracto · ${cuenta.nombre}`} wide>
        {importar && (
          <ImportarExtracto
            cuenta={cuenta}
            onCancel={() => setImportar(false)}
            onDone={(t) => {
              setImportar(false)
              setMsg({ tone: 'green', text: t })
              cargar()
            }}
          />
        )}
      </Modal>
      <Modal open={!!crear} onClose={() => setCrear(null)} title="Cargar movimiento desde el extracto">
        {crear && (
          <CrearDesdeExtracto
            e={crear}
            categorias={categorias}
            onCancel={() => setCrear(null)}
            onDone={() => {
              setCrear(null)
              setMsg({ tone: 'green', text: 'Movimiento cargado y conciliado.' })
              cargar()
            }}
          />
        )}
      </Modal>
      <Modal open={!!elegir} onClose={() => setElegir(null)} title="Elegir el movimiento que corresponde">
        {elegir && (
          <ElegirMovimiento
            e={elegir}
            movs={movs}
            onCancel={() => setElegir(null)}
            onElegir={async (m) => {
              if (await rpc('tes_conciliar', { p_extracto: elegir.id, p_mov: m.id }, 'Conciliado.')) setElegir(null)
            }}
          />
        )}
      </Modal>
    </>
  )
}

// ---------------------------------------------------------------------
function CrearDesdeExtracto({ e, categorias, onDone, onCancel }: { e: Extracto; categorias: Categoria[]; onDone: () => void; onCancel: () => void }) {
  const tipo = e.importe > 0 ? 'ingreso' : 'egreso'
  const sugerida = useMemo(() => {
    const d = normTxt(e.descripcion)
    const clave = /impdebcred|ley25413|impuestodebito|impuestocredito|idc/.test(d) ? 'imp_debcred' : /comision|mantenimiento|cargo|iva/.test(d) && tipo === 'egreso' ? 'comisiones' : null
    return categorias.find((c) => c.clave === clave && c.tipo === tipo)?.id ?? ''
  }, [e, categorias, tipo])
  const [categoria, setCategoria] = useState(sugerida)
  const [concepto, setConcepto] = useState(e.descripcion)
  const [contraparte, setContraparte] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault()
    if (!categoria) return setError('Elegí la categoría.')
    setBusy(true)
    const { error } = await sb().rpc('tes_crear_desde_extracto', { p_extracto: e.id, p: { categoria_id: categoria, concepto: concepto.trim(), contraparte: contraparte.trim() || null } })
    setBusy(false)
    if (error) return setError(errMsg(error))
    onDone()
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="rounded-lg bg-slate-50 p-3 text-sm">
        {fmtFecha(e.fecha)} · {e.descripcion}
        <div className={cx('mt-1 text-lg font-semibold tabular-nums', e.importe > 0 ? 'text-emerald-700' : 'text-red-700')}>{fmtMoney(e.importe)}</div>
      </div>
      <p className="text-sm text-slate-600">Se carga como {tipo} realizado en la cuenta, con la fecha del banco, y queda conciliado. Útil para débitos automáticos, comisiones, impuestos y transferencias recibidas.</p>
      <Field label="Categoría" required>
        <CategoriaSelect id="cde-cat" categorias={categorias} tipo={tipo} value={categoria} onChange={setCategoria} />
      </Field>
      <Field label="Concepto">
        <input id="cde-concepto" className={inputCls} value={concepto} onChange={(ev) => setConcepto(ev.target.value)} />
      </Field>
      <Field label={tipo === 'ingreso' ? 'De quién' : 'A quién'}>
        <input id="cde-contraparte" className={inputCls} value={contraparte} onChange={(ev) => setContraparte(ev.target.value)} />
      </Field>
      {error && <Alert tone="red">{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit" disabled={busy}>
          Cargar y conciliar
        </Button>
      </div>
    </form>
  )
}

function ElegirMovimiento({ e, movs, onElegir, onCancel }: { e: Extracto; movs: Movimiento[]; onElegir: (m: Movimiento) => void; onCancel: () => void }) {
  const [todos, setTodos] = useState(false)
  const entrada = e.importe > 0
  const lista = movs
    .filter((m) => (m.sentido === 'entrada') === entrada)
    .filter((m) => todos || Math.abs(Number(m.importe) - Math.abs(e.importe)) < 0.005)
    .sort((a, b) => Math.abs(new Date(a.fecha_efectiva ?? a.fecha_prevista).getTime() - new Date(e.fecha).getTime()) - Math.abs(new Date(b.fecha_efectiva ?? b.fecha_prevista).getTime() - new Date(e.fecha).getTime()))
  return (
    <div className="space-y-3">
      <div className="rounded-lg bg-slate-50 p-3 text-sm">
        {fmtFecha(e.fecha)} · {e.descripcion} · <b className="tabular-nums">{fmtMoney(e.importe)}</b>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="h-4 w-4 accent-brand-700" checked={todos} onChange={(ev) => setTodos(ev.target.checked)} />
        Mostrar también los de otro importe
      </label>
      {lista.length === 0 ? (
        <Empty>No hay movimientos sin conciliar con ese importe. Usá &quot;Cargar&quot; para crearlo.</Empty>
      ) : (
        <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
          {lista.map((m) => {
            const igual = Math.abs(Number(m.importe) - Math.abs(e.importe)) < 0.005
            return (
              <li key={m.id}>
                <button
                  type="button"
                  disabled={!igual}
                  onClick={() => onElegir(m)}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="w-20 text-slate-600">{fmtFecha(m.fecha_efectiva ?? m.fecha_prevista)}</span>
                  <span className="min-w-0 flex-1 truncate">{m.concepto}</span>
                  <span className="tabular-nums">{fmtMoney(m.importe)}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {todos && <p className="text-xs text-slate-500">Solo se puede conciliar con el mismo importe. Si el banco cobró distinto, corregí el movimiento o cargá la diferencia aparte.</p>}
      <div className="flex justify-end">
        <Button variant="secondary" onClick={onCancel}>
          Cerrar
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
type Columna = 'fecha' | 'descripcion' | 'referencia' | 'debito' | 'credito' | 'importe' | 'saldo'
const COLUMNAS: { k: Columna; label: string; claves: RegExp }[] = [
  { k: 'fecha', label: 'Fecha', claves: /^fecha|^fec/ },
  { k: 'descripcion', label: 'Descripción', claves: /desc|concepto|detalle|movimiento|leyenda/ },
  { k: 'referencia', label: 'Referencia', claves: /refer|comprob|nro|numero|cheque/ },
  { k: 'debito', label: 'Débito', claves: /debito|debe|egreso/ },
  { k: 'credito', label: 'Crédito', claves: /credito|haber|ingreso/ },
  { k: 'importe', label: 'Importe (con signo)', claves: /^importe|^monto/ },
  { k: 'saldo', label: 'Saldo', claves: /saldo/ },
]

type Linea = { fecha: string; descripcion: string; referencia: string | null; importe: number; saldo: number | null }

function ImportarExtracto({ cuenta, onDone, onCancel }: { cuenta: Cuenta; onDone: (msg: string) => void; onCancel: () => void }) {
  const [filas, setFilas] = useState<unknown[][] | null>(null)
  const [cab, setCab] = useState(0)
  const [map, setMap] = useState<Partial<Record<Columna, number>>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [archivo, setArchivo] = useState('')

  async function onFile(ev: ChangeEvent<HTMLInputElement>) {
    const f = ev.target.files?.[0]
    if (!f) return
    setError(null)
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await f.arrayBuffer(), { cellDates: false })
      const raw = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: true, blankrows: false })
      const h = Math.max(0, raw.slice(0, 25).findIndex((r) => r.some((c) => /fecha/.test(normTxt(String(c))))))
      setFilas(raw)
      setCab(h)
      setMap(detectar(raw[h] ?? []))
      setArchivo(f.name)
    } catch (e) {
      setError('No pude leer el archivo. Probá exportarlo del homebanking como Excel o CSV. ' + errMsg(e))
    }
  }

  const lineas = useMemo<Linea[]>(() => {
    if (!filas) return []
    const out: Linea[] = []
    for (const r of filas.slice(cab + 1)) {
      const fecha = map.fecha !== undefined ? parseFechaExtracto(r[map.fecha]) : null
      if (!fecha) continue
      let imp: number | null = null
      if (map.importe !== undefined) imp = parseImporte(r[map.importe])
      else {
        const d = map.debito !== undefined ? parseImporte(r[map.debito]) : null
        const c = map.credito !== undefined ? parseImporte(r[map.credito]) : null
        imp = (c ? Math.abs(c) : 0) - (d ? Math.abs(d) : 0)
      }
      if (!imp) continue
      out.push({
        fecha,
        descripcion: String(map.descripcion !== undefined ? r[map.descripcion] : '').trim() || '(sin descripción)',
        referencia: map.referencia !== undefined ? String(r[map.referencia] ?? '').trim() || null : null,
        importe: Math.round(imp * 100) / 100,
        saldo: map.saldo !== undefined ? parseImporte(r[map.saldo]) : null,
      })
    }
    return out
  }, [filas, cab, map])

  async function guardar() {
    setError(null)
    if (!lineas.length) return setError('No encontré líneas con fecha e importe. Revisá qué columna es cada cosa.')
    setBusy(true)
    try {
      const vistos = new Map<string, number>()
      const rows = lineas.map((l) => {
        const k = `${l.fecha}|${l.importe.toFixed(2)}|${normTxt(l.descripcion).slice(0, 40)}|${l.referencia ?? ''}|${l.saldo ?? ''}`
        const n = (vistos.get(k) ?? 0) + 1
        vistos.set(k, n)
        return { cuenta_id: cuenta.id, ...l, huella: `${k}#${n}`, lote: archivo.slice(0, 80) }
      })
      const desde = rows.reduce((a, r) => (r.fecha < a ? r.fecha : a), rows[0].fecha)
      const { data: ex, error: e1 } = await sb().from('tes_extractos').select('huella').eq('cuenta_id', cuenta.id).gte('fecha', desde)
      if (e1) throw e1
      const ya = new Set(((ex as { huella: string }[]) ?? []).map((x) => x.huella))
      const nuevas = rows.filter((r) => !ya.has(r.huella))
      for (let i = 0; i < nuevas.length; i += 500) {
        const { error } = await sb().from('tes_extractos').insert(nuevas.slice(i, i + 500))
        if (error) throw error
      }
      onDone(`Se importaron ${nuevas.length} líneas${rows.length - nuevas.length ? ` (${rows.length - nuevas.length} ya estaban y se saltearon)` : ''}. Revisá las sugerencias de conciliación.`)
    } catch (e) {
      setError(errMsg(e))
    }
    setBusy(false)
  }

  const cabecera = filas?.[cab] ?? []
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Bajá el extracto de <b>{cuenta.nombre}</b> desde el homebanking (Excel o CSV) y subilo acá. Si importás dos veces el mismo período, las líneas repetidas se saltean.
      </p>
      <input id="ext-file" type="file" accept=".xlsx,.xls,.csv,.txt" onChange={onFile} className="block w-full text-sm" />
      {filas && (
        <>
          <div className="grid gap-2 sm:grid-cols-4">
            <Field label="Fila de títulos">
              <select className={compactCls} value={cab} onChange={(e) => (setCab(Number(e.target.value)), setMap(detectar(filas[Number(e.target.value)] ?? [])))}>
                {filas.slice(0, 25).map((r, i) => (
                  <option key={i} value={i}>
                    {i + 1}: {r.slice(0, 3).map(String).join(' · ').slice(0, 30)}
                  </option>
                ))}
              </select>
            </Field>
            {COLUMNAS.map((c) => (
              <Field key={c.k} label={c.label}>
                <select
                  className={compactCls}
                  value={map[c.k] ?? ''}
                  onChange={(e) => setMap({ ...map, [c.k]: e.target.value === '' ? undefined : Number(e.target.value) })}
                >
                  <option value="">—</option>
                  {cabecera.map((h, i) => (
                    <option key={i} value={i}>
                      {String(h) || `Columna ${i + 1}`}
                    </option>
                  ))}
                </select>
              </Field>
            ))}
          </div>
          <p className="text-xs text-slate-500">Si el banco trae una sola columna de importe con signo, elegí &quot;Importe&quot;. Si trae Débito y Crédito separados, elegí esas dos.</p>
          <div className="max-h-64 overflow-auto rounded-lg border border-slate-200">
            <table className="w-full text-sm">
              <tbody>
                {lineas.slice(0, 50).map((l, i) => (
                  <tr key={i} className="border-b border-slate-100">
                    <td className="whitespace-nowrap px-2 py-1">{fmtFecha(l.fecha)}</td>
                    <td className="px-2 py-1">{l.descripcion}</td>
                    <td className={cx('whitespace-nowrap px-2 py-1 text-right tabular-nums', l.importe > 0 ? 'text-emerald-700' : 'text-red-700')}>{fmtMoney(l.importe)}</td>
                    <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums text-slate-500">{l.saldo !== null ? fmtMoney(l.saldo) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-sm text-slate-600">
            {lineas.length} líneas · créditos {fmtMoney(lineas.filter((l) => l.importe > 0).reduce((a, l) => a + l.importe, 0))} · débitos{' '}
            {fmtMoney(lineas.filter((l) => l.importe < 0).reduce((a, l) => a - l.importe, 0))}
            {lineas.length > 50 && ' (se muestran las primeras 50)'}
          </p>
        </>
      )}
      {error && <Alert tone="red">{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancelar
        </Button>
        <Button onClick={guardar} disabled={busy || !lineas.length}>
          {busy ? 'Importando…' : `Importar ${lineas.length || ''} líneas`}
        </Button>
      </div>
    </div>
  )
}

function detectar(cab: unknown[]): Partial<Record<Columna, number>> {
  const m: Partial<Record<Columna, number>> = {}
  cab.forEach((h, i) => {
    const t = normTxt(String(h))
    if (!t) return
    for (const c of COLUMNAS) {
      if (m[c.k] === undefined && c.claves.test(t)) {
        m[c.k] = i
        break
      }
    }
  })
  if (m.debito !== undefined || m.credito !== undefined) delete m.importe
  return m
}
