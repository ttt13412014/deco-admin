'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { sb, errMsg } from '@/lib/supabase'
import { fmtFecha, fmtMoney, hoy } from '@/lib/utils'
import { Categoria, Cuenta, ESTADO_MOV, EstadoMov, Movimiento, TipoMov, cargarBase, firmado, normTxt, porRubro } from '@/lib/tesoreria'
import { useAuth } from '@/components/AuthProvider'
import { ANCHOS_MOV, AccionMov, EjecutarForm, MovTabla, MovimientoForm, accionRapida, exportarExcel, filasMovimientos, primerDiaMes } from '@/components/Tesoreria'
import { Alert, Button, Card, Empty, Modal, PageHeader, Spinner, Stat, compactCls } from '@/components/ui'

const MOV_SELECT = '*, autor:perfiles!created_by(nombre)'

export default function MovimientosPage() {
  const { puedeEditar } = useAuth()
  const [base, setBase] = useState<{ cuentas: Cuenta[]; categorias: Categoria[] } | null>(null)
  const [movs, setMovs] = useState<Movimiento[] | null>(null)
  const [desde, setDesde] = useState(primerDiaMes())
  const [hasta, setHasta] = useState(hoy())
  const [porFecha, setPorFecha] = useState<'efectiva' | 'operacion'>('efectiva')
  const [cuenta, setCuenta] = useState('')
  const [tipo, setTipo] = useState<'' | TipoMov>('')
  const [estado, setEstado] = useState<'' | EstadoMov | 'activos'>('activos')
  const [categoria, setCategoria] = useState('')
  const [conc, setConc] = useState<'' | 'si' | 'no'>('')
  const [texto, setTexto] = useState('')
  const [nuevo, setNuevo] = useState(false)
  const [editar, setEditar] = useState<Movimiento | null>(null)
  const [ejecutar, setEjecutar] = useState<Movimiento | null>(null)
  const [msg, setMsg] = useState<{ tone: 'green' | 'red'; text: string } | null>(null)

  const cargar = useCallback(async () => {
    const s = sb()
    try {
      const b = await cargarBase()
      setBase(b)
      let q = s.from('tes_movimientos').select(MOV_SELECT)
      q =
        porFecha === 'operacion'
          ? q.gte('fecha', desde).lte('fecha', hasta)
          : q.or(`and(fecha_efectiva.gte.${desde},fecha_efectiva.lte.${hasta}),and(fecha_efectiva.is.null,fecha_prevista.gte.${desde},fecha_prevista.lte.${hasta})`)
      const { data, error } = await q.order('fecha_prevista', { ascending: false }).order('created_at', { ascending: false }).limit(3000)
      if (error) throw error
      setMovs((data as Movimiento[]) ?? [])
    } catch (e) {
      setMsg({ tone: 'red', text: errMsg(e) })
      setMovs([])
      setBase((x) => x ?? { cuentas: [], categorias: [] })
    }
  }, [desde, hasta, porFecha])

  useEffect(() => {
    if (puedeEditar) cargar()
  }, [cargar, puedeEditar])

  const filtrados = useMemo(() => {
    const t = normTxt(texto)
    return (movs ?? [])
      .filter((m) => !cuenta || m.cuenta_id === cuenta)
      .filter((m) => !tipo || m.tipo === tipo)
      .filter((m) => (estado === 'activos' ? m.estado !== 'anulado' : !estado || m.estado === estado))
      .filter((m) => !categoria || m.categoria_id === categoria)
      .filter((m) => !conc || (conc === 'si') === m.conciliado)
      .filter((m) => !t || normTxt([m.concepto, m.contraparte, m.comprobante, m.observaciones].join(' ')).includes(t))
      .sort((a, b) => (b.fecha_efectiva ?? b.fecha_prevista).localeCompare(a.fecha_efectiva ?? a.fecha_prevista) || b.created_at.localeCompare(a.created_at))
  }, [movs, cuenta, tipo, estado, categoria, conc, texto])

  if (!puedeEditar) return <Empty>Tesorería es exclusiva de Administración y Gerencia.</Empty>
  if (!base || !movs) return <Spinner />
  const { cuentas, categorias } = base

  const real = filtrados.filter((m) => m.estado === 'realizado')
  const ing = real.filter((m) => m.tipo === 'ingreso').reduce((a, m) => a + Number(m.importe), 0)
  const egr = real.filter((m) => m.tipo === 'egreso').reduce((a, m) => a + Number(m.importe), 0)
  const prev = filtrados.filter((m) => m.estado === 'pendiente' || m.estado === 'autorizado').reduce((a, m) => a + (m.tipo === 'transferencia' ? 0 : firmado(m)), 0)

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

  return (
    <>
      <PageHeader
        title="Movimientos"
        subtitle="Un solo registro para caja, bancos, cheques y flujo de fondos. Lo que cargás acá aparece en todos lados."
        actions={
          <>
            <Button variant="secondary" onClick={() => exportarExcel(`movimientos-${desde}-a-${hasta}`, [{ nombre: 'Movimientos', filas: filasMovimientos(filtrados, cuentas, categorias), anchos: ANCHOS_MOV }])}>
              Excel
            </Button>
            <Button onClick={() => setNuevo(true)}>+ Movimiento</Button>
          </>
        }
      />
      {msg && (
        <Alert tone={msg.tone} className="mb-4">
          {msg.text}
        </Alert>
      )}

      <div className="mb-4 flex flex-wrap items-end gap-2 text-sm">
        <select id="f-porfecha" className={compactCls} value={porFecha} onChange={(e) => setPorFecha(e.target.value as typeof porFecha)} aria-label="Tipo de fecha">
          <option value="efectiva">Fecha efectiva / prevista</option>
          <option value="operacion">Fecha de operación</option>
        </select>
        <input id="f-desde" type="date" className={compactCls} value={desde} onChange={(e) => e.target.value && setDesde(e.target.value)} aria-label="Desde" />
        <input id="f-hasta" type="date" className={compactCls} value={hasta} onChange={(e) => e.target.value && setHasta(e.target.value)} aria-label="Hasta" />
        <select id="f-cuenta" className={compactCls} value={cuenta} onChange={(e) => setCuenta(e.target.value)} aria-label="Cuenta">
          <option value="">Todas las cuentas</option>
          {cuentas.map((c) => (
            <option key={c.id} value={c.id}>
              {c.nombre}
            </option>
          ))}
        </select>
        <select id="f-tipo" className={compactCls} value={tipo} onChange={(e) => (setTipo(e.target.value as typeof tipo), setCategoria(''))} aria-label="Tipo">
          <option value="">Ingresos, egresos y transferencias</option>
          <option value="ingreso">Ingresos</option>
          <option value="egreso">Egresos</option>
          <option value="transferencia">Transferencias propias</option>
        </select>
        <select id="f-estado" className={compactCls} value={estado} onChange={(e) => setEstado(e.target.value as typeof estado)} aria-label="Estado">
          <option value="activos">Sin anulados</option>
          <option value="">Todos los estados</option>
          {(Object.keys(ESTADO_MOV) as EstadoMov[]).map((k) => (
            <option key={k} value={k}>
              {ESTADO_MOV[k].label}
            </option>
          ))}
        </select>
        <select id="f-categoria" className={compactCls} value={categoria} onChange={(e) => setCategoria(e.target.value)} aria-label="Categoría">
          <option value="">Todas las categorías</option>
          {(['ingreso', 'egreso'] as const)
            .filter((t) => !tipo || tipo === t)
            .flatMap((t) => porRubro(categorias, t, true))
            .map(([rubro, cs]) => (
              <optgroup key={rubro + cs[0].tipo} label={`${cs[0].tipo === 'ingreso' ? 'Ingreso' : 'Egreso'} · ${rubro}`}>
                {cs.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nombre}
                  </option>
                ))}
              </optgroup>
            ))}
        </select>
        <select id="f-conc" className={compactCls} value={conc} onChange={(e) => setConc(e.target.value as typeof conc)} aria-label="Conciliación">
          <option value="">Conciliado o no</option>
          <option value="si">Conciliados</option>
          <option value="no">Sin conciliar</option>
        </select>
        <input id="f-texto" className={`${compactCls} min-w-[12rem] flex-1`} placeholder="Buscar concepto, proveedor, comprobante…" value={texto} onChange={(e) => setTexto(e.target.value)} />
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Ingresos realizados" value={fmtMoney(ing)} tone="green" />
        <Stat label="Egresos realizados" value={fmtMoney(egr)} tone="red" />
        <Stat label="Resultado" value={<span className={ing - egr < 0 ? 'text-red-700' : ''}>{fmtMoney(ing - egr)}</span>} sub="Sin transferencias propias" tone="brand" />
        <Stat label="Previsto neto" value={fmtMoney(prev)} sub="Pendientes y autorizados" tone="amber" />
      </div>

      <Card pad={false} title={`${filtrados.length} ${filtrados.length === 1 ? 'movimiento' : 'movimientos'}`} subtitle={`${fmtFecha(desde)} al ${fmtFecha(hasta)}`}>
        <MovTabla movs={filtrados} cuentas={cuentas} categorias={categorias} onAccion={accion} vacio="No hay movimientos con estos filtros." />
      </Card>

      <Modal open={nuevo} onClose={() => setNuevo(false)} title="Nuevo movimiento" wide>
        {nuevo && <MovimientoForm cuentas={cuentas} categorias={categorias} onCancel={() => setNuevo(false)} onSaved={listo(() => setNuevo(false))} />}
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
