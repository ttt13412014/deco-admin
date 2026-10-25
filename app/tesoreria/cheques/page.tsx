'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { sb, errMsg } from '@/lib/supabase'
import { fmtFecha, fmtMoney, hoy, sumarDias } from '@/lib/utils'
import { Categoria, Cheque, Cuenta, ESTADO_CHEQUE, EstadoCheque, Movimiento, cargarBase, diasHasta, normTxt } from '@/lib/tesoreria'
import { useAuth } from '@/components/AuthProvider'
import { ACCIONES_CHEQUE, ANCHOS_CHQ, AccionCheque, ChequeAccionForm, ChequeEditarForm, MovimientoForm, accionesPosibles, chequeEditable, exportarExcel, filasCheques } from '@/components/Tesoreria'
import { Alert, Badge, Button, Card, Empty, Modal, PageHeader, Spinner, Stat, Table, cx, compactCls, td, th } from '@/components/ui'

const ACTIVOS: EstadoCheque[] = ['en_cartera', 'depositado', 'emitido']

export default function ChequesPage() {
  const { puedeEditar, esGerencia } = useAuth()
  const [base, setBase] = useState<{ cuentas: Cuenta[]; categorias: Categoria[] } | null>(null)
  const [cheques, setCheques] = useState<Cheque[] | null>(null)
  const [pagosAut, setPagosAut] = useState<Movimiento[]>([])
  const [sentido, setSentido] = useState<'recibido' | 'emitido'>('recibido')
  const [filtro, setFiltro] = useState<'activos' | 'todos' | EstadoCheque>('activos')
  const [texto, setTexto] = useState('')
  const [accion, setAccion] = useState<{ c: Cheque; a: AccionCheque } | null>(null)
  const [nuevo, setNuevo] = useState(false)
  const [editar, setEditar] = useState<Cheque | null>(null)
  const [msg, setMsg] = useState<{ tone: 'green' | 'red'; text: string } | null>(null)

  const cargar = useCallback(async () => {
    const s = sb()
    try {
      const [b, c, p] = await Promise.all([
        cargarBase(),
        s.from('tes_cheques').select('*').or(`estado.in.(en_cartera,depositado,emitido),fecha_pago.gte.${sumarDias(hoy(), -180)}`).order('fecha_pago').limit(3000),
        s.from('tes_movimientos').select('*').eq('tipo', 'egreso').eq('estado', 'autorizado').is('cheque_id', null).order('fecha_prevista'),
      ])
      setBase(b)
      setCheques((c.data as Cheque[]) ?? [])
      setPagosAut((p.data as Movimiento[]) ?? [])
    } catch (e) {
      setMsg({ tone: 'red', text: errMsg(e) })
      setCheques([])
      setBase((x) => x ?? { cuentas: [], categorias: [] })
    }
  }, [])

  useEffect(() => {
    if (puedeEditar) cargar()
  }, [cargar, puedeEditar])

  const lista = useMemo(() => {
    const t = normTxt(texto)
    return (cheques ?? [])
      .filter((c) => c.sentido === sentido)
      .filter((c) => (filtro === 'activos' ? ACTIVOS.includes(c.estado) : filtro === 'todos' ? true : c.estado === filtro))
      .filter((c) => !t || normTxt([c.numero, c.contraparte, c.banco, c.cuit, c.endosado_a].join(' ')).includes(t))
  }, [cheques, sentido, filtro, texto])

  if (!puedeEditar) return <Empty>Tesorería es exclusiva de Administración y Gerencia.</Empty>
  if (!base || !cheques) return <Spinner />
  const { cuentas, categorias } = base
  const ref = hoy()
  const suma = (xs: Cheque[]) => xs.reduce((a, c) => a + Number(c.importe), 0)
  const cartera = cheques.filter((c) => c.sentido === 'recibido' && c.estado === 'en_cartera')
  const depositados = cheques.filter((c) => c.sentido === 'recibido' && c.estado === 'depositado')
  const emitidos = cheques.filter((c) => c.sentido === 'emitido' && c.estado === 'emitido')
  const semana = cheques.filter((c) => ACTIVOS.includes(c.estado) && c.fecha_pago <= sumarDias(ref, 7))
  const nombreCuenta = (id: string | null) => cuentas.find((c) => c.id === id)?.nombre ?? '—'
  const estados = (Object.keys(ESTADO_CHEQUE) as EstadoCheque[]).filter((e) => (sentido === 'recibido' ? !['emitido', 'debitado'].includes(e) : ['emitido', 'debitado', 'rechazado', 'anulado'].includes(e)))

  return (
    <>
      <PageHeader
        title="Cheques"
        subtitle="Físicos y e-cheq. Los recibidos no son plata disponible hasta que se acreditan; los emitidos se descuentan del banco cuando se debitan."
        actions={
          <>
            <Button variant="secondary" onClick={() => exportarExcel(`cheques-${ref}`, [{ nombre: 'Cheques', filas: filasCheques(lista, cuentas), anchos: ANCHOS_CHQ }])}>
              Excel
            </Button>
            {(sentido === 'recibido' || esGerencia) && <Button onClick={() => setNuevo(true)}>{sentido === 'recibido' ? '+ Cheque recibido' : '+ Cheque emitido'}</Button>}
          </>
        }
      />
      {msg && (
        <Alert tone={msg.tone} className="mb-4">
          {msg.text}
        </Alert>
      )}

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="En cartera" value={fmtMoney(suma(cartera))} sub={`${cartera.length} cheques · no disponible`} tone="amber" onClick={() => (setSentido('recibido'), setFiltro('en_cartera'))} />
        <Stat label="Depositados" value={fmtMoney(suma(depositados))} sub={`${depositados.length} esperando acreditación`} tone="brand" onClick={() => (setSentido('recibido'), setFiltro('depositado'))} />
        <Stat label="Emitidos sin debitar" value={fmtMoney(suma(emitidos))} sub={`${emitidos.length} comprometidos`} tone="red" onClick={() => (setSentido('emitido'), setFiltro('emitido'))} />
        <Stat label="Próximos 7 días" value={semana.length} sub={`+ ${fmtMoney(suma(semana.filter((c) => c.sentido === 'recibido')))} · − ${fmtMoney(suma(semana.filter((c) => c.sentido === 'emitido')))}`} tone="slate" />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5">
          {(['recibido', 'emitido'] as const).map((s) => (
            <button
              key={s}
              onClick={() => (setSentido(s), setFiltro('activos'))}
              className={cx('rounded-md px-4 py-1.5 text-sm font-medium', sentido === s ? 'bg-brand-700 text-white' : 'text-slate-600 hover:bg-slate-50')}
            >
              {s === 'recibido' ? 'Recibidos' : 'Emitidos'}
            </button>
          ))}
        </div>
        <select id="chq-filtro" className={compactCls} value={filtro} onChange={(e) => setFiltro(e.target.value as typeof filtro)} aria-label="Estado">
          <option value="activos">Pendientes</option>
          <option value="todos">Todos</option>
          {estados.map((e) => (
            <option key={e} value={e}>
              {ESTADO_CHEQUE[e].label}
            </option>
          ))}
        </select>
        <input id="chq-buscar" className={`${compactCls} min-w-[12rem] flex-1`} placeholder="Buscar número, cliente, proveedor, CUIT…" value={texto} onChange={(e) => setTexto(e.target.value)} />
      </div>

      <Card pad={false}>
        {lista.length === 0 ? (
          <Empty>{sentido === 'recibido' ? 'No hay cheques recibidos en esta vista. Los cobros con cheque se cargan desde Cobranzas o con "+ Cheque recibido".' : 'No hay cheques emitidos en esta vista. Se emiten desde un pago autorizado → Pagar → Cheque.'}</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <th className={th}>Fecha de pago</th>
                <th className={th}>Cheque</th>
                <th className={th}>{sentido === 'recibido' ? 'Cliente / librador' : 'Proveedor'}</th>
                <th className={`${th} text-right`}>Importe</th>
                <th className={th}>Cuenta</th>
                <th className={th}>Estado</th>
                <th className={th}></th>
              </tr>
            </thead>
            <tbody>
              {lista.map((c) => {
                const activo = ACTIVOS.includes(c.estado)
                const vencido = activo && c.fecha_pago < ref
                return (
                  <tr key={c.id} className={cx(!activo && 'text-slate-500')}>
                    <td className={`${td} whitespace-nowrap`}>
                      {fmtFecha(c.fecha_pago)}
                      {activo && <div className={cx('text-xs', vencido ? 'font-medium text-red-600' : 'text-slate-500')}>{diasHasta(c.fecha_pago)}</div>}
                    </td>
                    <td className={td}>
                      <div className="font-medium">
                        {c.formato === 'echeq' ? 'E-cheq' : 'Físico'} N° {c.numero}
                      </div>
                      <div className="text-xs text-slate-500">
                        {[c.banco, c.fecha_emision ? `emitido ${fmtFecha(c.fecha_emision)}` : null].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td className={td}>
                      {c.contraparte}
                      {c.cuit && <div className="text-xs text-slate-500">{c.cuit}</div>}
                      {c.endosado_a && <div className="text-xs text-slate-500">Endosado a {c.endosado_a}</div>}
                      {c.motivo && <div className="text-xs text-red-600">{c.motivo}</div>}
                    </td>
                    <td className={`${td} whitespace-nowrap text-right font-semibold tabular-nums`}>{fmtMoney(c.importe)}</td>
                    <td className={`${td} whitespace-nowrap text-sm`}>
                      {nombreCuenta(c.cuenta_id)}
                      {c.fecha_efectiva && <div className="text-xs text-slate-500">{fmtFecha(c.fecha_efectiva)}</div>}
                    </td>
                    <td className={td}>
                      <Badge tone={ESTADO_CHEQUE[c.estado].tone}>{ESTADO_CHEQUE[c.estado].label}</Badge>
                    </td>
                    <td className={`${td} text-right`}>
                      <div className="flex flex-wrap justify-end gap-1">
                        {accionesPosibles(c).map((a) => (
                          <Button key={a} size="sm" variant={a === 'acreditar' || a === 'debitar' ? 'success' : a === 'anular' || a === 'rechazar' ? 'ghost' : 'secondary'} onClick={() => setAccion({ c, a })}>
                            {ACCIONES_CHEQUE[a].label}
                          </Button>
                        ))}
                        {chequeEditable(c) && (
                          <Button size="sm" variant="ghost" onClick={() => setEditar(c)}>
                            Editar
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
      {lista.length > 0 && (
        <p className="mt-2 text-sm text-slate-600">
          {lista.length} cheques · total {fmtMoney(suma(lista))}
        </p>
      )}

      <Modal open={!!accion} onClose={() => setAccion(null)} title={accion ? `${ACCIONES_CHEQUE[accion.a].label} · cheque N° ${accion.c.numero}` : ''}>
        {accion && (
          <ChequeAccionForm
            cheque={accion.c}
            accion={accion.a}
            cuentas={cuentas}
            categorias={categorias}
            pagosAutorizados={pagosAut}
            onCancel={() => setAccion(null)}
            onDone={(t) => {
              setAccion(null)
              setMsg({ tone: 'green', text: t })
              cargar()
            }}
          />
        )}
      </Modal>
      <Modal open={!!editar} onClose={() => setEditar(null)} title={editar ? `Editar cheque emitido N° ${editar.numero}` : ''} wide>
        {editar && (
          <ChequeEditarForm
            cheque={editar}
            cuentas={cuentas}
            onCancel={() => setEditar(null)}
            onDone={(t) => {
              setEditar(null)
              setMsg({ tone: 'green', text: t })
              cargar()
            }}
          />
        )}
      </Modal>
      <Modal open={nuevo} onClose={() => setNuevo(false)} title={sentido === 'recibido' ? 'Cheque recibido' : 'Pago con cheque'} wide>
        {nuevo && (
          <>
            {sentido === 'recibido' && (
              <Alert tone="blue" className="mb-4">
                Si es el pago de una factura, cargalo desde <b>Cobranzas → Registrar cobro</b> así baja la deuda del cliente. Acá van los cheques que no corresponden a una factura cargada.
              </Alert>
            )}
            <MovimientoForm
              cuentas={cuentas}
              categorias={categorias}
              preset={{ tipo: sentido === 'recibido' ? 'ingreso' : 'egreso', medio: 'echeq', previsto: true }}
              onCancel={() => setNuevo(false)}
              onSaved={(t) => {
                setNuevo(false)
                setMsg({ tone: 'green', text: t })
                cargar()
              }}
            />
          </>
        )}
      </Modal>
    </>
  )
}
