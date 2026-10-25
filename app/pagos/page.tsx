'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { sb, errMsg } from '@/lib/supabase'
import { fmtFecha, fmtMoney, hoy, sumarDias } from '@/lib/utils'
import { Categoria, Cuenta, cargarBase, diasHasta, normTxt } from '@/lib/tesoreria'
import { ESTADO_OBL, EstadoObl, Obligacion, PRIORIDAD, TIPO_OBL, TipoObl, abierta, fechaPago, ordenarObligaciones, pagable, situacion } from '@/lib/pagos'
import { useAuth } from '@/components/AuthProvider'
import { DetalleObligacion, EstadoObligacion, OBL_SELECT, ObligacionForm, PagoObligacionForm } from '@/components/Pagos'
import { ImportarPagar } from '@/components/Importador'
import { exportarExcel } from '@/components/Tesoreria'
import { Alert, Badge, Button, Card, Empty, Modal, PageHeader, Spinner, Stat, Table, compactCls, cx, td, th } from '@/components/ui'
import type { Celda } from '@/lib/xlsx-lite'

type Filtro = 'abiertas' | 'decidir' | 'a_pagar' | 'vencidas' | 'parciales' | 'todas' | EstadoObl

export default function PagosPage() {
  const { puedeEditar, esGerencia } = useAuth()
  const [obls, setObls] = useState<Obligacion[] | null>(null)
  const [base, setBase] = useState<{ cuentas: Cuenta[]; categorias: Categoria[] }>({ cuentas: [], categorias: [] })
  const [filtro, setFiltro] = useState<Filtro>('abiertas')
  const [tipo, setTipo] = useState<'' | TipoObl>('')
  const [texto, setTexto] = useState('')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [nueva, setNueva] = useState(false)
  const [editar, setEditar] = useState<Obligacion | null>(null)
  const [pagar, setPagar] = useState<Obligacion | null>(null)
  const [detalle, setDetalle] = useState<string | null>(null)
  const [importar, setImportar] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'green' | 'red' | 'amber'; text: string } | null>(null)
  const ref = hoy()

  const cargar = useCallback(async () => {
    try {
      const [b, o] = await Promise.all([
        cargarBase(),
        sb().from('pag_obligaciones').select(OBL_SELECT).or(`estado.not.in.(pagado,cancelado),updated_at.gte.${sumarDias(ref, -120)}`).limit(5000),
      ])
      if (o.error) throw o.error
      setBase(b)
      setObls(((o.data as Obligacion[]) ?? []).sort(ordenarObligaciones))
    } catch (e) {
      setMsg({ tone: 'red', text: errMsg(e) })
      setObls([])
    }
  }, [ref])

  useEffect(() => {
    if (puedeEditar) cargar()
  }, [cargar, puedeEditar])

  const lista = useMemo(() => {
    const t = normTxt(texto)
    return (obls ?? []).filter((o) => {
      const s = situacion(o, ref)
      const ok =
        filtro === 'abiertas'
          ? abierta(o)
          : filtro === 'decidir'
            ? o.estado === 'pendiente_decision' || o.estado === 'pendiente_revision'
            : filtro === 'a_pagar'
              ? pagable(o)
              : filtro === 'vencidas'
                ? s.vencido
                : filtro === 'parciales'
                  ? s.parcial
                  : filtro === 'todas'
                    ? true
                    : o.estado === filtro
      return ok && (!tipo || o.tipo === tipo) && (!t || normTxt([o.proveedor, o.concepto, o.comprobante, o.cuit].join(' ')).includes(t))
    })
  }, [obls, filtro, tipo, texto, ref])

  if (!puedeEditar) return <Empty>Cuentas a pagar es de Administración y Gerencia.</Empty>
  if (!obls) return <Spinner />
  const { cuentas, categorias } = base
  const ab = obls.filter(abierta)
  const suma = (xs: Obligacion[]) => xs.reduce((a, o) => a + Number(o.saldo), 0)
  const vencidas = ab.filter((o) => situacion(o, ref).vencido)
  const decidir = ab.filter((o) => o.estado === 'pendiente_decision' || o.estado === 'pendiente_revision')
  const semana = ab.filter((o) => pagable(o) && (fechaPago(o) ?? '9999') <= sumarDias(ref, 7))
  const sinFecha = ab.filter((o) => !fechaPago(o))

  async function cambiarEstado(o: Obligacion, estado: EstadoObl, extra: Record<string, unknown> = {}) {
    setMsg(null)
    const { error } = await sb().from('pag_obligaciones').update({ estado, ...extra }).eq('id', o.id)
    if (error) return setMsg({ tone: 'red', text: errMsg(error) })
    setMsg({ tone: 'green', text: `${o.proveedor}: ${ESTADO_OBL[estado].label.toLowerCase()}.` })
    cargar()
  }
  async function programar(o: Obligacion) {
    const f = window.prompt('Fecha en que se va a pagar (AAAA-MM-DD):', fechaPago(o) ?? ref)
    if (!f || !/^\d{4}-\d{2}-\d{2}$/.test(f)) return
    setMsg(null)
    const s = sb()
    const { error } = await s.rpc('pag_cambiar_fecha', { p_obl: o.id, p_fecha: f, p_motivo: 'Programado por Gerencia' })
    if (error) return setMsg({ tone: 'red', text: errMsg(error) })
    const { error: e2 } = await s.from('pag_obligaciones').update({ estado: 'programado' }).eq('id', o.id)
    if (e2) return setMsg({ tone: 'red', text: errMsg(e2) })
    setMsg({ tone: 'green', text: `Programado para el ${fmtFecha(f)}.` })
    cargar()
  }
  async function cambiarFecha(o: Obligacion) {
    const f = window.prompt('Nueva fecha estimada de pago (AAAA-MM-DD). Vacío = sin fecha:', fechaPago(o) ?? '')
    if (f === null) return
    if (f && !/^\d{4}-\d{2}-\d{2}$/.test(f)) return setMsg({ tone: 'red', text: 'Fecha inválida (AAAA-MM-DD).' })
    const motivo = window.prompt('Motivo del cambio:')
    if (!motivo?.trim()) return
    const { error } = await sb().rpc('pag_cambiar_fecha', { p_obl: o.id, p_fecha: f || null, p_motivo: motivo.trim() })
    if (error) return setMsg({ tone: 'red', text: errMsg(error) })
    setMsg({ tone: 'green', text: 'Fecha cambiada. Queda en el historial y el flujo de fondos la mueve.' })
    cargar()
  }
  async function cancelar(o: Obligacion) {
    const m = window.prompt(`Motivo de la cancelación de "${o.proveedor}":`)
    if (!m?.trim()) return
    cambiarEstado(o, 'cancelado', { motivo: m.trim() })
  }
  async function autorizarSeleccion() {
    setMsg(null)
    const ids = Array.from(sel)
    const { error } = await sb().from('pag_obligaciones').update({ estado: 'autorizado' }).in('id', ids)
    if (error) return setMsg({ tone: 'red', text: errMsg(error) })
    setSel(new Set())
    setMsg({ tone: 'green', text: `Se autorizaron ${ids.length}.` })
    cargar()
  }

  function exportar() {
    const nc = (id: string | null) => cuentas.find((c) => c.id === id)?.nombre ?? ''
    const filas: Celda[][] = [
      ['Proveedor', 'CUIT', 'Tipo', 'Concepto', 'Comprobante', 'Cuota', 'Vencimiento', 'Vencimiento original', 'Fecha estimada', 'Importe', 'Pagado', 'Saldo', 'Prioridad', 'Estado', 'Vencido', 'Cuenta prevista', 'Origen', 'Observaciones'],
      ...lista.map((o) => [
        o.proveedor,
        o.cuit ?? '',
        TIPO_OBL[o.tipo],
        o.concepto ?? '',
        o.comprobante ?? '',
        o.cuotas ? `${o.cuota}/${o.cuotas}` : '',
        o.vencimiento ? fmtFecha(o.vencimiento) : '',
        o.vencimiento_original ? fmtFecha(o.vencimiento_original) : '',
        o.fecha_estimada_pago ? fmtFecha(o.fecha_estimada_pago) : '',
        Number(o.importe),
        Number(o.pagado) + Number(o.ajuste_previo),
        Number(o.saldo),
        PRIORIDAD[o.prioridad].label,
        ESTADO_OBL[o.estado].label,
        situacion(o, ref).vencido ? 'Sí' : '',
        nc(o.cuenta_id),
        o.origen === 'sintesys' ? 'Sintesys' : 'Manual',
        o.observaciones ?? '',
      ]),
    ]
    exportarExcel(`cuentas-a-pagar-${ref}`, [{ nombre: 'Cuentas a pagar', filas, anchos: [26, 13, 18, 30, 18, 7, 12, 12, 12, 14, 14, 14, 9, 20, 8, 16, 9, 30] }])
  }

  const FILTROS: [Filtro, string, number?][] = [
    ['abiertas', 'Pendientes', ab.length],
    ['decidir', 'Para decidir', decidir.length],
    ['a_pagar', 'Autorizadas a pagar', ab.filter(pagable).length],
    ['vencidas', 'Vencidas', vencidas.length],
    ['parciales', 'Pago parcial', ab.filter((o) => situacion(o, ref).parcial).length],
    ['pagado', 'Pagadas'],
    ['cancelado', 'Canceladas'],
  ]
  const seleccionables = lista.filter((o) => o.estado === 'pendiente_decision')

  return (
    <>
      <PageHeader
        title="Cuentas a pagar"
        subtitle="Obligaciones de Sintesys y cargadas a mano. Los dueños deciden qué se paga; Administración registra el pago y su comprobante. Nada se paga solo."
        actions={
          <>
            <Button variant="secondary" onClick={exportar}>
              Excel
            </Button>
            <Button variant="secondary" onClick={() => setImportar(true)}>
              Importar Sintesys
            </Button>
            <Button onClick={() => setNueva(true)}>+ Obligación</Button>
          </>
        }
      />
      {msg && (
        <Alert tone={msg.tone} className="mb-4">
          {msg.text}
        </Alert>
      )}

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Total pendiente" value={fmtMoney(suma(ab))} sub={`${ab.length} obligaciones${sinFecha.length ? ` · ${sinFecha.length} sin fecha` : ''}`} tone="brand" onClick={() => setFiltro('abiertas')} />
        <Stat label="Vencido" value={fmtMoney(suma(vencidas))} sub={`${vencidas.length} obligaciones`} tone={vencidas.length ? 'red' : 'slate'} onClick={() => setFiltro('vencidas')} />
        <Stat label="Para decidir" value={fmtMoney(suma(decidir))} sub={`${decidir.length} esperan a los dueños`} tone={decidir.length ? 'amber' : 'slate'} onClick={() => setFiltro('decidir')} />
        <Stat label="A pagar · 7 días" value={fmtMoney(suma(semana))} sub={`${semana.length} autorizadas`} tone="green" onClick={() => setFiltro('a_pagar')} />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {FILTROS.map(([k, l, n]) => (
          <button
            key={k}
            onClick={() => setFiltro(k)}
            className={cx('rounded-full border px-3 py-1.5 text-xs font-medium', filtro === k ? 'border-brand-700 bg-brand-700 text-white' : 'border-slate-300 bg-white text-slate-600 hover:border-brand-400')}
          >
            {l}
            {n !== undefined && <span className="ml-1.5 opacity-70">{n}</span>}
          </button>
        ))}
        <select id="pag-tipo" className={compactCls} value={tipo} onChange={(e) => setTipo(e.target.value as typeof tipo)} aria-label="Tipo">
          <option value="">Todos los tipos</option>
          {(Object.keys(TIPO_OBL) as TipoObl[]).map((t) => (
            <option key={t} value={t}>
              {TIPO_OBL[t]}
            </option>
          ))}
        </select>
        <input id="pag-buscar" className={`${compactCls} min-w-[12rem] flex-1`} placeholder="Buscar proveedor, concepto, comprobante…" value={texto} onChange={(e) => setTexto(e.target.value)} />
      </div>

      {esGerencia && sel.size > 0 && (
        <Alert tone="blue" className="mb-3">
          {sel.size} seleccionadas · {fmtMoney(lista.filter((o) => sel.has(o.id)).reduce((a, o) => a + Number(o.saldo), 0))}{' '}
          <Button size="sm" variant="success" className="ml-2" onClick={autorizarSeleccion}>
            Autorizar seleccionadas
          </Button>
        </Alert>
      )}

      <Card pad={false} title={`${lista.length} obligaciones · ${fmtMoney(suma(lista))}`}>
        {lista.length === 0 ? (
          <Empty>{obls.length ? 'No hay obligaciones en esta vista.' : 'Todavía no hay obligaciones. Importá el Excel de Sintesys o cargalas a mano.'}</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                {esGerencia && (
                  <th className={th}>
                    <input
                      type="checkbox"
                      aria-label="Seleccionar todas"
                      className="h-4 w-4 accent-brand-700"
                      checked={seleccionables.length > 0 && seleccionables.every((o) => sel.has(o.id))}
                      onChange={(e) => setSel(e.target.checked ? new Set(seleccionables.map((o) => o.id)) : new Set())}
                    />
                  </th>
                )}
                <th className={th}>Fecha</th>
                <th className={th}>A quién / concepto</th>
                <th className={th}>Prioridad</th>
                <th className={`${th} text-right`}>Saldo</th>
                <th className={th}>Estado</th>
                <th className={th}></th>
              </tr>
            </thead>
            <tbody>
              {lista.map((o) => {
                const f = fechaPago(o)
                const s = situacion(o, ref)
                return (
                  <tr key={o.id} className={cx(!abierta(o) && 'text-slate-500')}>
                    {esGerencia && (
                      <td className={td}>
                        {o.estado === 'pendiente_decision' && (
                          <input
                            type="checkbox"
                            aria-label={`Seleccionar ${o.proveedor}`}
                            className="h-4 w-4 accent-brand-700"
                            checked={sel.has(o.id)}
                            onChange={(e) => {
                              const n = new Set(sel)
                              e.target.checked ? n.add(o.id) : n.delete(o.id)
                              setSel(n)
                            }}
                          />
                        )}
                      </td>
                    )}
                    <td className={`${td} whitespace-nowrap`}>
                      {f ? fmtFecha(f) : <span className="text-amber-700">Sin fecha</span>}
                      {f && abierta(o) && <div className={cx('text-xs', s.vencido ? 'font-medium text-red-600' : 'text-slate-500')}>{diasHasta(f)}</div>}
                      {o.fecha_estimada_pago && o.vencimiento && o.fecha_estimada_pago !== o.vencimiento && <div className="text-[11px] text-slate-400">vence {fmtFecha(o.vencimiento)}</div>}
                    </td>
                    <td className={td}>
                      <button className="text-left font-medium text-slate-900 hover:underline" onClick={() => setDetalle(o.id)}>
                        {o.proveedor}
                      </button>
                      <div className="text-xs text-slate-500">
                        {[TIPO_OBL[o.tipo], o.concepto, o.comprobante, o.cuotas ? `cuota ${o.cuota}/${o.cuotas}` : null, o.origen === 'sintesys' ? 'Sintesys' : null].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td className={td}>
                      <Badge tone={PRIORIDAD[o.prioridad].tone}>{PRIORIDAD[o.prioridad].label}</Badge>
                    </td>
                    <td className={`${td} whitespace-nowrap text-right tabular-nums`}>
                      <div className="font-semibold">{fmtMoney(o.saldo)}</div>
                      {Number(o.saldo) !== Number(o.importe) && <div className="text-xs text-slate-500">de {fmtMoney(o.importe)}</div>}
                    </td>
                    <td className={td}>
                      <EstadoObligacion o={o} />
                    </td>
                    <td className={`${td} text-right`}>
                      <div className="flex flex-wrap justify-end gap-1">
                        {o.estado === 'pendiente_revision' && (
                          <Button size="sm" variant="secondary" onClick={() => cambiarEstado(o, 'pendiente_decision')}>
                            Revisada
                          </Button>
                        )}
                        {esGerencia && (o.estado === 'pendiente_decision' || o.estado === 'pendiente_revision') && (
                          <>
                            <Button size="sm" variant="success" onClick={() => cambiarEstado(o, 'autorizado')}>
                              Autorizar
                            </Button>
                            <Button size="sm" variant="secondary" onClick={() => programar(o)}>
                              Programar
                            </Button>
                          </>
                        )}
                        {pagable(o) && (
                          <Button size="sm" onClick={() => setPagar(o)}>
                            Pagar
                          </Button>
                        )}
                        {abierta(o) && (
                          <Button size="sm" variant="ghost" onClick={() => cambiarFecha(o)}>
                            Fecha
                          </Button>
                        )}
                        {abierta(o) && (
                          <Button size="sm" variant="ghost" onClick={() => setEditar(o)}>
                            Editar
                          </Button>
                        )}
                        {esGerencia && abierta(o) && Number(o.pagado) === 0 && (
                          <Button size="sm" variant="ghost" onClick={() => cancelar(o)}>
                            Cancelar
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <Modal open={nueva} onClose={() => setNueva(false)} title="Nueva obligación" wide>
        {nueva && (
          <ObligacionForm
            cuentas={cuentas}
            categorias={categorias}
            onCancel={() => setNueva(false)}
            onSaved={(t) => {
              setNueva(false)
              setMsg({ tone: 'green', text: t })
              cargar()
            }}
          />
        )}
      </Modal>
      <Modal open={!!editar} onClose={() => setEditar(null)} title="Editar obligación" wide>
        {editar && (
          <ObligacionForm
            inicial={editar}
            cuentas={cuentas}
            categorias={categorias}
            onCancel={() => setEditar(null)}
            onSaved={(t) => {
              setEditar(null)
              setMsg({ tone: 'green', text: t })
              cargar()
            }}
          />
        )}
      </Modal>
      <Modal open={!!pagar} onClose={() => setPagar(null)} title="Registrar pago">
        {pagar && (
          <PagoObligacionForm
            o={pagar}
            cuentas={cuentas}
            onCancel={() => setPagar(null)}
            onDone={(t) => {
              setPagar(null)
              setMsg({ tone: 'green', text: t })
              cargar()
            }}
          />
        )}
      </Modal>
      <Modal open={!!detalle} onClose={() => setDetalle(null)} title="Detalle de la obligación" wide>
        {detalle && <DetalleObligacion id={detalle} cuentas={cuentas} onChanged={cargar} />}
      </Modal>
      <Modal open={importar} onClose={() => setImportar(false)} title="Importar cuentas a pagar de Sintesys" wide>
        {importar && (
          <ImportarPagar
            onCancel={() => {
              setImportar(false)
              cargar()
            }}
            onDone={(t) => {
              setImportar(false)
              setMsg({ tone: 'green', text: t })
              cargar()
            }}
          />
        )}
      </Modal>
    </>
  )
}
