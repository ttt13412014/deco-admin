'use client'

import { FormEvent, useCallback, useEffect, useState } from 'react'
import { sb, errMsg } from '@/lib/supabase'
import { fmtFecha, fmtFechaHora, fmtMoney, hoy, parseMonto } from '@/lib/utils'
import { fechasRepetidas } from '@/lib/flujo'
import { Categoria, Cuenta, MEDIOS, MEDIOS_CARGA, Medio, Movimiento, etiquetaMov } from '@/lib/tesoreria'
import { ESTADO_OBL, Obligacion, PRIORIDAD, Prioridad, TIPO_OBL, TipoObl, fechaPago, situacion } from '@/lib/pagos'
import { useAuth } from './AuthProvider'
import { CamposCheque, CategoriaSelect, CuentaSelect, DatosCheque, chequeVacio, cuentaPorMedio } from './Tesoreria'
import { Alert, Badge, Button, Field, Spinner, cx, inputCls } from './ui'

export const OBL_SELECT = '*, decisor:perfiles!decidido_por(nombre)'

export function EstadoObligacion({ o }: { o: Obligacion }) {
  const s = situacion(o)
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Badge tone={ESTADO_OBL[o.estado].tone}>{ESTADO_OBL[o.estado].label}</Badge>
      {s.vencido && <Badge tone="red">Vencido</Badge>}
      {s.parcial && <Badge tone="blue">Parcialmente pagado</Badge>}
    </div>
  )
}

// ---------------------------------------------------------------------
// Alta / edición
// ---------------------------------------------------------------------
export function ObligacionForm({
  inicial,
  cuentas,
  categorias,
  preset,
  onSaved,
  onCancel,
}: {
  inicial?: Obligacion
  cuentas: Cuenta[]
  categorias: Categoria[]
  preset?: Partial<{ proveedor: string; concepto: string; importe: string; vencimiento: string; categoria_id: string; tipo: TipoObl }>
  onSaved: (msg: string) => void
  onCancel: () => void
}) {
  const { esGerencia } = useAuth()
  const ed = !!inicial
  const [tipo, setTipo] = useState<TipoObl>(inicial?.tipo ?? preset?.tipo ?? 'proveedor')
  const [proveedor, setProveedor] = useState(inicial?.proveedor ?? preset?.proveedor ?? '')
  const [cuit, setCuit] = useState(inicial?.cuit ?? '')
  const [categoria, setCategoria] = useState(inicial?.categoria_id ?? preset?.categoria_id ?? '')
  const [concepto, setConcepto] = useState(inicial?.concepto ?? preset?.concepto ?? '')
  const [comprobante, setComprobante] = useState(inicial?.comprobante ?? '')
  const [venc, setVenc] = useState(inicial?.vencimiento ?? preset?.vencimiento ?? '')
  const [estimada, setEstimada] = useState(inicial?.fecha_estimada_pago ?? '')
  const [importe, setImporte] = useState(inicial ? String(inicial.importe).replace('.', ',') : preset?.importe ?? '')
  const [prioridad, setPrioridad] = useState<Prioridad>(inicial?.prioridad ?? 'media')
  const [cuenta, setCuenta] = useState(inicial?.cuenta_id ?? cuentas.find((c) => c.pago_default)?.id ?? '')
  const [medio, setMedio] = useState(inicial?.medio_previsto ?? 'transferencia')
  const [obs, setObs] = useState(inicial?.observaciones ?? '')
  const [cuotas, setCuotas] = useState(1)
  const [cada, setCada] = useState<'mensual' | 'quincenal' | 'semanal'>('mensual')
  const [importeEs, setImporteEs] = useState<'total' | 'cuota'>('cuota')
  const [decidido, setDecidido] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const imp = parseMonto(importe)
    if (!proveedor.trim()) return setError('Indicá a quién se le paga.')
    if (!(imp > 0)) return setError('Importe inválido.')
    setBusy(true)
    const base = {
      tipo,
      proveedor: proveedor.trim(),
      cuit: cuit.replace(/\D/g, '') || null,
      categoria_id: categoria || null,
      concepto: concepto.trim() || null,
      comprobante: comprobante.trim() || null,
      prioridad,
      cuenta_id: cuenta || null,
      medio_previsto: medio,
      observaciones: obs.trim() || null,
    }
    try {
      if (ed) {
        const cambios: Record<string, unknown> = { ...base, importe: imp }
        if (venc !== (inicial!.vencimiento ?? '')) cambios.vencimiento = venc || null
        const { error } = await sb().from('pag_obligaciones').update(cambios).eq('id', inicial!.id)
        if (error) throw error
        if (estimada !== (inicial!.fecha_estimada_pago ?? '')) {
          const { error: e2 } = await sb().rpc('pag_cambiar_fecha', { p_obl: inicial!.id, p_fecha: estimada || null, p_motivo: 'Edición de la obligación' })
          if (e2) throw e2
        }
        onSaved('Obligación actualizada.')
      } else {
        const n = Math.max(1, Math.min(120, cuotas))
        const fechas = n > 1 ? fechasRepetidas(venc || hoy(), cada, n) : [venc || null]
        const impCuota = n > 1 && importeEs === 'total' ? Math.round((imp / n) * 100) / 100 : imp
        const plan = n > 1 ? crypto.randomUUID() : null
        const filas = fechas.map((f, i) => ({
          ...base,
          vencimiento: f,
          fecha_estimada_pago: n === 1 ? estimada || null : null,
          importe: n > 1 && importeEs === 'total' && i === n - 1 ? Math.round((imp - impCuota * (n - 1)) * 100) / 100 : impCuota,
          plan_id: plan,
          cuota: n > 1 ? i + 1 : null,
          cuotas: n > 1 ? n : null,
          estado: esGerencia && decidido ? 'autorizado' : 'pendiente_decision',
        }))
        const { error } = await sb().from('pag_obligaciones').insert(filas)
        if (error) throw error
        onSaved(n > 1 ? `Se cargaron ${n} cuotas.` : esGerencia && decidido ? 'Obligación cargada y autorizada.' : 'Obligación cargada. Queda pendiente de decisión de los dueños.')
      }
    } catch (err) {
      setError(errMsg(err))
    }
    setBusy(false)
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Tipo">
          <select id="obl-tipo" className={inputCls} value={tipo} onChange={(e) => setTipo(e.target.value as TipoObl)}>
            {(Object.keys(TIPO_OBL) as TipoObl[]).map((t) => (
              <option key={t} value={t}>
                {TIPO_OBL[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Categoría (para Caja y Bancos)">
          <CategoriaSelect id="obl-cat" categorias={categorias} tipo="egreso" value={categoria} onChange={setCategoria} />
        </Field>
        <Field label="A quién se le paga" required>
          <input id="obl-prov" className={inputCls} value={proveedor} onChange={(e) => setProveedor(e.target.value)} placeholder="Proveedor, AFIP/ARCA, empleados…" />
        </Field>
        <Field label="CUIT">
          <input id="obl-cuit" className={inputCls} value={cuit} onChange={(e) => setCuit(e.target.value)} inputMode="numeric" />
        </Field>
        <Field label="Concepto">
          <input id="obl-concepto" className={inputCls} value={concepto} onChange={(e) => setConcepto(e.target.value)} />
        </Field>
        <Field label="Comprobante">
          <input id="obl-comp" className={inputCls} value={comprobante} onChange={(e) => setComprobante(e.target.value)} placeholder="FC 0001-0000123" />
        </Field>
        <Field label={cuotas > 1 ? 'Vencimiento de la 1ª cuota' : 'Vencimiento'} hint={ed && !esGerencia ? 'Lo cambia Gerencia; para mover el pago usá la fecha estimada' : undefined}>
          <input id="obl-venc" type="date" className={inputCls} value={venc} onChange={(e) => setVenc(e.target.value)} disabled={ed && !esGerencia && inicial!.origen === 'sintesys'} />
        </Field>
        {cuotas === 1 && (
          <Field label="Fecha estimada de pago" hint="Si se piensa pagar otro día que el vencimiento">
            <input id="obl-estimada" type="date" className={inputCls} value={estimada} onChange={(e) => setEstimada(e.target.value)} />
          </Field>
        )}
        <Field label={cuotas > 1 ? (importeEs === 'total' ? 'Importe total' : 'Importe de cada cuota') : 'Importe'} required>
          <input id="obl-importe" className={inputCls} value={importe} onChange={(e) => setImporte(e.target.value)} inputMode="decimal" />
        </Field>
        <Field label="Prioridad">
          <select id="obl-prio" className={inputCls} value={prioridad} onChange={(e) => setPrioridad(e.target.value as Prioridad)}>
            {(Object.keys(PRIORIDAD) as Prioridad[]).map((p) => (
              <option key={p} value={p}>
                {PRIORIDAD[p].label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Se piensa pagar desde">
          <CuentaSelect id="obl-cuenta" cuentas={cuentas} value={cuenta} onChange={setCuenta} vacio="Sin definir" />
        </Field>
        <Field label="Medio previsto">
          <select id="obl-medio" className={inputCls} value={medio} onChange={(e) => setMedio(e.target.value)}>
            {MEDIOS_CARGA.map((m) => (
              <option key={m} value={m}>
                {MEDIOS[m]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Observaciones" className="sm:col-span-2">
          <input id="obl-obs" className={inputCls} value={obs} onChange={(e) => setObs(e.target.value)} />
        </Field>
        {!ed && (
          <div className="grid grid-cols-3 gap-3 sm:col-span-2">
            <Field label="Cuotas" hint="Planes de pago, sueldos, alquiler…">
              <input id="obl-cuotas" type="number" min={1} max={120} className={inputCls} value={cuotas} onChange={(e) => setCuotas(Math.max(1, Number(e.target.value) || 1))} />
            </Field>
            {cuotas > 1 && (
              <>
                <Field label="Cada">
                  <select className={inputCls} value={cada} onChange={(e) => setCada(e.target.value as typeof cada)}>
                    <option value="mensual">Mes</option>
                    <option value="quincenal">2 semanas</option>
                    <option value="semanal">Semana</option>
                  </select>
                </Field>
                <Field label="El importe es">
                  <select className={inputCls} value={importeEs} onChange={(e) => setImporteEs(e.target.value as typeof importeEs)}>
                    <option value="cuota">De cada cuota</option>
                    <option value="total">El total</option>
                  </select>
                </Field>
              </>
            )}
          </div>
        )}
      </div>
      {!ed && esGerencia && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4 accent-brand-700" checked={decidido} onChange={(e) => setDecidido(e.target.checked)} />
          Ya está decidido: cargarla autorizada
        </label>
      )}
      {!ed && !esGerencia && <Alert tone="blue">Queda pendiente de decisión. Los dueños deciden qué se paga; el sistema no autoriza ni paga nada solo.</Alert>}
      {error && <Alert tone="red">{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? 'Guardando…' : 'Guardar'}
        </Button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------
// Registrar un pago (total o parcial)
// ---------------------------------------------------------------------
export function PagoObligacionForm({ o, cuentas, onDone, onCancel }: { o: Obligacion; cuentas: Cuenta[]; onDone: (msg: string) => void; onCancel: () => void }) {
  const [importe, setImporte] = useState(String(o.saldo).replace('.', ','))
  const [medio, setMedio] = useState<Medio>((o.medio_previsto as Medio) || 'transferencia')
  const [cuenta, setCuenta] = useState(o.cuenta_id ?? cuentaPorMedio(cuentas, (o.medio_previsto as Medio) || 'transferencia', ''))
  const [fecha, setFecha] = useState(hoy())
  const [comprobante, setComprobante] = useState('')
  const [cheque, setCheque] = useState<DatosCheque>({ ...chequeVacio(), fecha_pago: fechaPago(o) && fechaPago(o)! > hoy() ? fechaPago(o)! : hoy() })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const esCheque = medio === 'cheque' || medio === 'echeq'
  const imp = parseMonto(importe)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!(imp > 0)) return setError('Importe inválido.')
    setBusy(true)
    const { error } = await sb().rpc('pag_registrar_pago', {
      p_obl: o.id,
      p: { importe: imp, medio, cuenta_id: cuenta, fecha, comprobante: comprobante.trim() || null, cheque: esCheque ? { ...cheque, numero: cheque.numero.trim() } : null },
    })
    setBusy(false)
    if (error) return setError(errMsg(error))
    const parcial = imp < Number(o.saldo) - 0.004
    onDone(
      (esCheque ? 'Cheque emitido: la deuda queda saldada y el banco se descuenta cuando se debite.' : 'Pago registrado en Caja y Bancos.') +
        (parcial ? ` Queda pendiente ${fmtMoney(Number(o.saldo) - imp)}.` : ''),
    )
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="rounded-lg bg-slate-50 p-3 text-sm">
        <div className="font-medium">
          {o.proveedor} · {o.concepto ?? o.comprobante ?? TIPO_OBL[o.tipo]}
        </div>
        <div className="text-slate-500">
          Importe {fmtMoney(o.importe)} · ya pagado {fmtMoney(Number(o.pagado) + Number(o.ajuste_previo))} · <b>saldo {fmtMoney(o.saldo)}</b>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Importe a pagar" required hint="Si es menos que el saldo, queda como pago parcial">
          <input id="po-importe" className={inputCls} value={importe} onChange={(e) => setImporte(e.target.value)} inputMode="decimal" />
        </Field>
        <Field label="Medio">
          <select
            id="po-medio"
            className={inputCls}
            value={medio}
            onChange={(e) => {
              const m = e.target.value as Medio
              setMedio(m)
              setCuenta(cuentaPorMedio(cuentas, m, cuenta))
            }}
          >
            {MEDIOS_CARGA.map((m) => (
              <option key={m} value={m}>
                {MEDIOS[m]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={esCheque ? 'Cuenta de débito' : 'Sale de'}>
          <CuentaSelect id="po-cuenta" cuentas={cuentas} value={cuenta} onChange={setCuenta} />
        </Field>
        {!esCheque && (
          <Field label="Fecha de pago">
            <input id="po-fecha" type="date" className={inputCls} value={fecha} onChange={(e) => setFecha(e.target.value)} />
          </Field>
        )}
        <Field label="Orden de pago / comprobante" required={!esCheque}>
          <input id="po-comp" className={inputCls} value={comprobante} onChange={(e) => setComprobante(e.target.value)} placeholder="OP 0152, TRF 9921…" />
        </Field>
      </div>
      {esCheque && <CamposCheque value={cheque} onChange={setCheque} emitido />}
      {error && <Alert tone="red">{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit" variant="danger" disabled={busy}>
          {busy ? 'Guardando…' : imp > 0 && imp < Number(o.saldo) - 0.004 ? 'Registrar pago parcial' : 'Registrar pago'}
        </Button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------
// Detalle: pagos, historial de fechas, cuotas
// ---------------------------------------------------------------------
type Hist = { id: number; campo: string; antes: string | null; despues: string | null; motivo: string | null; fecha: string; autor?: { nombre: string } | null }

export function DetalleObligacion({ id, cuentas, onChanged }: { id: string; cuentas: Cuenta[]; onChanged: () => void }) {
  const [o, setO] = useState<Obligacion | null>(null)
  const [pagos, setPagos] = useState<Movimiento[]>([])
  const [hist, setHist] = useState<Hist[]>([])
  const [plan, setPlan] = useState<Obligacion[]>([])
  const cargar = useCallback(async () => {
    const s = sb()
    const [a, b, c] = await Promise.all([
      s.from('pag_obligaciones').select(OBL_SELECT).eq('id', id).single(),
      s.from('tes_movimientos').select('*, autor:perfiles!created_by(nombre)').eq('obligacion_id', id).order('created_at'),
      s.from('hist_fechas').select('*, autor:perfiles!usuario(nombre)').eq('entidad', 'obligacion').eq('entidad_id', id).order('fecha'),
    ])
    const ob = a.data as Obligacion
    setO(ob)
    setPagos((b.data as Movimiento[]) ?? [])
    setHist((c.data as Hist[]) ?? [])
    if (ob?.plan_id) {
      const { data } = await s.from('pag_obligaciones').select('*').eq('plan_id', ob.plan_id).order('cuota')
      setPlan((data as Obligacion[]) ?? [])
    } else setPlan([])
  }, [id])
  useEffect(() => {
    cargar()
  }, [cargar])
  if (!o) return <Spinner />
  const nombreCuenta = (cid: string | null) => cuentas.find((c) => c.id === cid)?.nombre ?? '—'
  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <div className="text-xs text-slate-500">
            {TIPO_OBL[o.tipo]} · {o.origen === 'sintesys' ? 'Sintesys' : 'Carga manual'}
          </div>
          <div className="text-lg font-semibold">{o.proveedor}</div>
          <div className="text-slate-600">{[o.concepto, o.comprobante, o.cuotas ? `Cuota ${o.cuota}/${o.cuotas}` : null].filter(Boolean).join(' · ')}</div>
          <div className="mt-1 text-slate-600">
            Vence {fmtFecha(o.vencimiento)}
            {o.vencimiento_original && o.vencimiento_original !== o.vencimiento && <> (original {fmtFecha(o.vencimiento_original)})</>}
            {o.fecha_estimada_pago && <> · se piensa pagar el <b>{fmtFecha(o.fecha_estimada_pago)}</b></>} · desde {nombreCuenta(o.cuenta_id)}
          </div>
        </div>
        <div className="text-right">
          <EstadoObligacion o={o} />
          <div className="mt-1 text-xl font-semibold tabular-nums">{fmtMoney(o.saldo)}</div>
          <div className="text-xs text-slate-500">
            de {fmtMoney(o.importe)}
            {Number(o.ajuste_previo) > 0 && ` · ${fmtMoney(o.ajuste_previo)} pagado antes (Sintesys)`}
          </div>
          {o.saldo_sintesys !== null && Math.abs(Number(o.saldo_sintesys) - Number(o.saldo)) > 0.004 && (
            <div className="mt-1 text-xs font-medium text-amber-700">Sintesys dice saldo {fmtMoney(o.saldo_sintesys)}</div>
          )}
        </div>
      </div>
      {o.decidido_at && (
        <p className="text-xs text-slate-500">
          Decidido por {o.decisor?.nombre ?? '—'} el {fmtFechaHora(o.decidido_at)}
        </p>
      )}
      {o.motivo && <p className="text-xs text-slate-500">Motivo: {o.motivo}</p>}
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Pagos</h4>
          {pagos.length === 0 ? (
            <p className="text-slate-500">Sin pagos.</p>
          ) : (
            <ul className="space-y-2">
              {pagos.map((m) => (
                <li key={m.id} className={cx('flex justify-between gap-2 rounded-lg border border-slate-100 p-2', m.estado === 'anulado' && 'opacity-50')}>
                  <div>
                    <div className="font-medium">
                      {fmtFecha(m.fecha_efectiva ?? m.fecha_prevista)} · {MEDIOS[m.medio]} · {nombreCuenta(m.cuenta_id)}
                    </div>
                    <div className="text-xs text-slate-500">
                      {[m.comprobante, etiquetaMov(m), m.autor?.nombre].filter(Boolean).join(' · ')}
                      {m.motivo_anulacion && ` · ${m.motivo_anulacion}`}
                    </div>
                  </div>
                  <div className="font-semibold tabular-nums">{fmtMoney(m.importe)}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Historial de fechas</h4>
          {hist.length === 0 ? (
            <p className="text-slate-500">Sin cambios.</p>
          ) : (
            <ul className="space-y-1">
              {hist.map((h) => (
                <li key={h.id} className="rounded-lg border border-slate-100 p-2">
                  <div>
                    {h.campo === 'vencimiento' ? 'Vencimiento' : 'Fecha estimada'}: {h.antes ? fmtFecha(h.antes) : '—'} → <b>{h.despues ? fmtFecha(h.despues) : '—'}</b>
                  </div>
                  <div className="text-xs text-slate-500">
                    {fmtFechaHora(h.fecha)} · {h.autor?.nombre ?? '—'}
                    {h.motivo && ` · ${h.motivo}`}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {plan.length > 1 && (
        <div>
          <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Plan de pagos</h4>
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-100">
            {plan.map((p) => (
              <li key={p.id} className={cx('flex flex-wrap items-center gap-2 px-3 py-1.5', p.id === o.id && 'bg-brand-50/60')}>
                <span className="w-14 text-slate-500">
                  {p.cuota}/{p.cuotas}
                </span>
                <span className="w-24">{fmtFecha(fechaPago(p))}</span>
                <span className="flex-1">
                  <EstadoObligacion o={p} />
                </span>
                <span className="tabular-nums">{fmtMoney(p.saldo)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
