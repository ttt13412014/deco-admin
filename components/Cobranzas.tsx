'use client'

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { sb, errMsg } from '@/lib/supabase'
import type { Cliente, Cobro, Factura, Gestion, TipoGestion } from '@/lib/types'
import {
  ESTADO_COB, MEDIOS_PAGO, PLAZO_CC_DEFAULT, TIPO_GESTION,
  copiar, estadoCobranza, fmtFecha, fmtFechaHora, fmtMoney, gestionPorEstado, hoy,
  mensajeCobranza, parseMonto, sumarDias, waLink,
} from '@/lib/utils'
import { Cuenta, Medio, cargarBase } from '@/lib/tesoreria'
import { GRUPOS_TIPO_VENTA, TIPOS_VENTA, TipoVenta, esCredito, infoTipo, montoFirmado, saldoFirmado } from '@/lib/comprobantes'
import { useAuth } from './AuthProvider'
import { CamposCheque, CuentaSelect, DatosCheque, chequeVacio, cuentaPorMedio } from './Tesoreria'
import { SeguimientoFactura } from './CobranzasExtra'
import { Alert, Badge, Button, Field, Spinner, inputCls } from './ui'

export const FACTURA_SELECT = '*, cliente:clientes(id,razon_social,contacto_nombre,telefono,cuit_dni)'

/** Tipo de comprobante bien visible (las NC y anula presupuesto en rojo: restan). */
export function TipoBadge({ f, corto }: { f: Pick<Factura, 'tipo' | 'tipo_comprobante' | 'signo'>; corto?: boolean }) {
  const t = infoTipo(f)
  const original = f.tipo_comprobante && f.tipo_comprobante !== t.label ? ` (cargado como "${f.tipo_comprobante}")` : ''
  return (
    <span title={`${t.label}${t.oficial ? '' : ' · en negro'}${t.signo < 0 ? ' · resta' : ' · suma'}${original}`}>
      <Badge tone={t.tone}>
        {t.signo < 0 ? '− ' : ''}
        {corto ? t.corto : t.label}
      </Badge>
    </span>
  )
}

/** Importe con signo: las notas de crédito se muestran en rojo y con menos. */
export function Importe({ n, className }: { n: number; className?: string }) {
  return <span className={[className, n < 0 ? 'text-red-700' : ''].filter(Boolean).join(' ')}>{fmtMoney(n)}</span>
}

// ---------------------------------------------------------------------
// Nueva factura (registro inicial A05: fecha, vencimiento, medio acordado)
// ---------------------------------------------------------------------
type ClienteMin = Pick<Cliente, 'id' | 'razon_social' | 'cuit_dni' | 'tipo_factura' | 'medio_pago_preferido'>

export function FacturaForm({ clienteId, onSaved, onCancel }: { clienteId?: string; onSaved: () => void; onCancel: () => void }) {
  const [clientes, setClientes] = useState<ClienteMin[]>([])
  const [buscar, setBuscar] = useState('')
  const [cliente, setCliente] = useState(clienteId ?? '')
  const [tipo, setTipo] = useState<TipoVenta>('factura_a')
  const [numero, setNumero] = useState('')
  const [emision, setEmision] = useState(hoy())
  const [condicion, setCondicion] = useState<'Contado' | 'Cuenta corriente'>('Cuenta corriente')
  const [venc, setVenc] = useState(sumarDias(hoy(), PLAZO_CC_DEFAULT))
  const [monto, setMonto] = useState('')
  const [medio, setMedio] = useState('Transferencia')
  const [obs, setObs] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    sb()
      .from('clientes')
      .select('id,razon_social,cuit_dni,tipo_factura,medio_pago_preferido')
      .eq('estado', 'activo')
      .order('razon_social')
      .then(({ data }) => setClientes((data as ClienteMin[]) ?? []))
  }, [])

  const sel = clientes.find((c) => c.id === cliente)
  useEffect(() => {
    if (!sel) return
    const letra = sel.tipo_factura === 'A' ? 'a' : sel.tipo_factura === 'B' ? 'b' : null
    if (letra) setTipo((t) => (TIPOS_VENTA[t].oficial ? (`${TIPOS_VENTA[t].clase}_${letra}` as TipoVenta) : t))
    else if (sel.tipo_factura === 'Presupuesto')
      setTipo((t) => (TIPOS_VENTA[t].oficial ? (TIPOS_VENTA[t].clase === 'nota_credito' ? 'anula_presupuesto' : 'presupuesto') : t))
    if (sel.medio_pago_preferido) setMedio(sel.medio_pago_preferido)
  }, [sel])

  const filtrados = useMemo(() => {
    const q = buscar.toLowerCase().trim()
    if (!q) return clientes
    return clientes.filter((c) => c.razon_social.toLowerCase().includes(q) || (c.cuit_dni ?? '').includes(q.replace(/\D/g, '') || '§'))
  }, [buscar, clientes])

  const info = TIPOS_VENTA[tipo]
  const credito = info.signo < 0

  function cambiarCondicion(c: 'Contado' | 'Cuenta corriente') {
    setCondicion(c)
    setVenc(c === 'Contado' ? emision : sumarDias(emision, PLAZO_CC_DEFAULT))
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const m = parseMonto(monto)
    if (!cliente) return setError('Elegí el cliente.')
    if (!(m > 0)) return setError('Monto inválido.')
    if (!numero.trim()) return setError('Cargá el número del comprobante.')
    if (!credito && venc < emision) return setError('El vencimiento no puede ser anterior a la emisión.')
    setBusy(true)
    const { error } = await sb().from('facturas').insert({
      cliente_id: cliente,
      tipo,
      tipo_comprobante: info.label,
      numero: numero.trim(),
      fecha_emision: emision,
      // Una nota de crédito no vence: es saldo a favor desde que se emite
      fecha_vencimiento: credito ? emision : venc,
      condicion_venta: condicion,
      medio_pago_acordado: credito ? 'No aplica' : medio,
      monto: m,
      observaciones: obs.trim() || null,
    })
    setBusy(false)
    if (error) return setError(errMsg(error))
    onSaved()
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Alert tone="blue">
        Antes de registrar (A03): cliente validado, pedido cerrado (V05), condiciones de venta definidas y OK de pago o condición habilitada.
      </Alert>
      {!clienteId && (
        <Field label="Cliente" required hint="Solo aparecen clientes activos (validados por A01).">
          <input className={`${inputCls} mb-2`} placeholder="Buscar por nombre o CUIT…" value={buscar} onChange={(e) => setBuscar(e.target.value)} />
          <select className={inputCls} value={cliente} onChange={(e) => setCliente(e.target.value)} required size={Math.min(6, Math.max(3, filtrados.length + 1))}>
            <option value="">— Elegir —</option>
            {filtrados.map((c) => (
              <option key={c.id} value={c.id}>
                {c.razon_social}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Tipo de comprobante" required hint={credito ? 'Resta del saldo del cliente y de los totales.' : info.oficial ? 'Suma al saldo del cliente.' : 'En negro: suma al saldo del cliente.'}>
          <select id="fac-tipo" className={inputCls} value={tipo} onChange={(e) => setTipo(e.target.value as TipoVenta)}>
            {GRUPOS_TIPO_VENTA.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.tipos.map((t) => (
                  <option key={t} value={t}>
                    {TIPOS_VENTA[t].label} {TIPOS_VENTA[t].signo < 0 ? '(−)' : '(+)'}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>
        <Field label="Número" required>
          <input id="fac-numero" className={inputCls} value={numero} onChange={(e) => setNumero(e.target.value)} placeholder="0001-00001234" required />
        </Field>
        <Field label="Fecha de emisión" required>
          <input className={inputCls} type="date" value={emision} onChange={(e) => setEmision(e.target.value)} required />
        </Field>
        {!credito && (
        <Field label="Condición de venta" required>
          <select className={inputCls} value={condicion} onChange={(e) => cambiarCondicion(e.target.value as 'Contado' | 'Cuenta corriente')}>
            <option>Cuenta corriente</option>
            <option>Contado</option>
          </select>
        </Field>
        )}
        {!credito && (
        <Field label="Vencimiento" required>
          <input className={inputCls} type="date" value={venc} onChange={(e) => setVenc(e.target.value)} required />
        </Field>
        )}
        <Field label="Monto total" required hint={credito ? 'Poné el importe sin signo: se resta solo.' : undefined}>
          <input id="fac-monto" className={inputCls} value={monto} onChange={(e) => setMonto(e.target.value)} inputMode="decimal" placeholder="0,00" required />
        </Field>
        {!credito && (
        <Field label="Medio de pago acordado" required>
          <select className={inputCls} value={medio} onChange={(e) => setMedio(e.target.value)}>
            {MEDIOS_PAGO.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </Field>
        )}
        <Field label="Observaciones">
          <input className={inputCls} value={obs} onChange={(e) => setObs(e.target.value)} />
        </Field>
      </div>
      {credito && (
        <Alert tone="amber">
          {info.label}: no se cobra, queda como <b>crédito a favor</b> del cliente y resta de su saldo. Después la podés imputar contra una factura pendiente desde el detalle.
        </Alert>
      )}
      {error && <Alert tone="red">{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? 'Guardando…' : `Registrar ${info.label.toLowerCase()}`}
        </Button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------
// Registrar cobro (A05 §4) + ingreso automático en caja (A06)
// ---------------------------------------------------------------------
const MEDIO_TES: Record<string, Medio> = { Efectivo: 'efectivo', Transferencia: 'transferencia', Cheque: 'cheque', 'E-cheq': 'echeq', Tarjeta: 'tarjeta' }

export function CobroForm({ factura, onSaved, onCancel }: { factura: Factura; onSaved: (msg: string) => void; onCancel: () => void }) {
  const [fecha, setFecha] = useState(hoy())
  const [monto, setMonto] = useState(String(factura.saldo).replace('.', ','))
  const [medio, setMedio] = useState(MEDIO_TES[factura.medio_pago_acordado] ? factura.medio_pago_acordado : 'Transferencia')
  const [ref, setRef] = useState('')
  const [obs, setObs] = useState('')
  const [cuentas, setCuentas] = useState<Cuenta[]>([])
  const [cuenta, setCuenta] = useState('')
  const [cheque, setCheque] = useState<DatosCheque>(chequeVacio())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const medioTes = MEDIO_TES[medio] ?? 'transferencia'
  const esCheque = medioTes === 'cheque' || medioTes === 'echeq'

  useEffect(() => {
    cargarBase()
      .then((b) => {
        setCuentas(b.cuentas)
        setCuenta((c) => c || cuentaPorMedio(b.cuentas, medioTes, ''))
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const m = parseMonto(monto)
  const parcial = m > 0 && m < Number(factura.saldo)
  const otroMedio = medio !== factura.medio_pago_acordado && factura.medio_pago_acordado !== 'Sin informar'

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!(m > 0)) return setError('Monto inválido.')
    if (m > Number(factura.saldo)) return setError(`El monto supera el saldo (${fmtMoney(factura.saldo)}).`)
    if (!cuenta) return setError('Elegí la cuenta donde entra el cobro.')
    if (esCheque && (!cheque.numero.trim() || !cheque.fecha_pago)) return setError('Cargá número y fecha de pago del cheque.')
    setBusy(true)
    const s = sb()
    const { error } = await s.rpc('tes_registrar_cobro', {
      p: {
        factura_id: factura.id,
        fecha,
        monto: m,
        medio: medioTes,
        cuenta_id: cuenta,
        referencia: ref.trim() || null,
        observaciones: obs.trim() || null,
        cheque: esCheque ? { numero: cheque.numero.trim(), banco: cheque.banco.trim(), fecha_emision: cheque.fecha_emision, fecha_pago: cheque.fecha_pago, cuit: cheque.cuit.trim() } : null,
      },
    })
    if (error) {
      setBusy(false)
      return setError(errMsg(error))
    }

    // A05 §5: casos a escalar
    const avisos: string[] = []
    if (parcial) avisos.push(`Pago parcial de ${fmtMoney(m)} (saldo restante ${fmtMoney(Number(factura.saldo) - m)})`)
    if (otroMedio) avisos.push(`Medio de pago distinto al acordado: ${medio} (acordado: ${factura.medio_pago_acordado})`)
    if (avisos.length) {
      await s.from('gestiones_cobranza').insert({ factura_id: factura.id, cliente_id: factura.cliente_id, tipo: 'escalado_gerencia', nota: avisos.join('. ') })
    }

    const nombreCuenta = cuentas.find((c) => c.id === cuenta)?.nombre ?? 'la cuenta'
    let msg = esCheque
      ? `Cobro registrado. El cheque queda en cartera: suma a ${nombreCuenta} cuando se acredite.`
      : `Cobro registrado e ingresado en ${nombreCuenta} (Tesorería).`
    if (avisos.length) msg += ' Se escaló a Gerencia (A05 §5).'
    setBusy(false)
    onSaved(msg)
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-lg border border-emerald-200 bg-emerald-50/50 p-4">
      <div className="text-sm font-semibold text-emerald-900">Registrar cobro · saldo {fmtMoney(factura.saldo)}</div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Fecha de cobro" required>
          <input id="cob-fecha" className={inputCls} type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} required />
        </Field>
        <Field label="Monto" required>
          <input id="cob-monto" className={inputCls} value={monto} onChange={(e) => setMonto(e.target.value)} inputMode="decimal" required />
        </Field>
        <Field label="Medio de pago" required>
          <select
            id="cob-medio"
            className={inputCls}
            value={medio}
            onChange={(e) => {
              setMedio(e.target.value)
              setCuenta(cuentaPorMedio(cuentas, MEDIO_TES[e.target.value] ?? 'transferencia', cuenta))
            }}
          >
            {Object.keys(MEDIO_TES).map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </Field>
        <Field label={esCheque ? 'Se deposita en' : 'Entra en'} required>
          <CuentaSelect id="cob-cuenta" cuentas={cuentas} value={cuenta} onChange={setCuenta} vacio={cuentas.length ? undefined : 'Cargando…'} />
        </Field>
        <Field label="Referencia / comprobante" hint="N° transferencia, recibo">
          <input id="cob-ref" className={inputCls} value={ref} onChange={(e) => setRef(e.target.value)} />
        </Field>
        <Field label="Observaciones">
          <input id="cob-obs" className={inputCls} value={obs} onChange={(e) => setObs(e.target.value)} />
        </Field>
      </div>
      {esCheque && <CamposCheque value={cheque} onChange={setCheque} />}
      {(parcial || otroMedio) && (
        <Alert tone="amber">
          {parcial && <div>Pago parcial: según A05 §5 se escala a Gerencia.</div>}
          {otroMedio && <div>Medio distinto al acordado ({factura.medio_pago_acordado}): se escala a Gerencia.</div>}
        </Alert>
      )}
      <p className="text-xs text-slate-600">Se registra una sola vez: baja la deuda del cliente y queda como ingreso en Tesorería (caja o banco). Si el cheque se rechaza, la deuda vuelve.</p>
      {error && <Alert tone="red">{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit" variant="success" disabled={busy}>
          {busy ? 'Guardando…' : 'Confirmar cobro'}
        </Button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------
// Detalle de un comprobante: estado, avisos, gestiones y cobros
// ---------------------------------------------------------------------
export function FacturaDetalle({ facturaId, onChanged }: { facturaId: string; onChanged: () => void }) {
  const { puedeEditar, esGerencia } = useAuth()
  const [f, setF] = useState<Factura | null>(null)
  const [cobros, setCobros] = useState<Cobro[]>([])
  const [gestiones, setGestiones] = useState<Gestion[]>([])
  const [cobrando, setCobrando] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'green' | 'red' | 'amber'; text: string } | null>(null)
  const [gTipo, setGTipo] = useState<TipoGestion>('respuesta_cliente')
  const [gNota, setGNota] = useState('')
  const [nuevoVenc, setNuevoVenc] = useState('')
  const [motivo, setMotivo] = useState('')

  const cargar = useCallback(async () => {
    const s = sb()
    const [a, b, c] = await Promise.all([
      s.from('facturas').select(FACTURA_SELECT).eq('id', facturaId).single(),
      s.from('cobros').select('*, autor:perfiles!created_by(nombre)').eq('factura_id', facturaId).order('fecha'),
      s.from('gestiones_cobranza').select('*, autor:perfiles!created_by(nombre)').eq('factura_id', facturaId).order('created_at', { ascending: false }),
    ])
    setF(a.data as Factura)
    setCobros((b.data as Cobro[]) ?? [])
    setGestiones((c.data as Gestion[]) ?? [])
  }, [facturaId])

  useEffect(() => {
    cargar()
  }, [cargar])

  if (!f) return <Spinner />
  const credito = esCredito(f)
  const est = estadoCobranza(f)
  const meta = ESTADO_COB[est]
  const texto = mensajeCobranza(f, est)
  const link = waLink(f.cliente?.telefono, texto)

  async function registrarGestion(tipo: TipoGestion, nota: string | null) {
    const { error } = await sb().from('gestiones_cobranza').insert({ factura_id: f!.id, cliente_id: f!.cliente_id, tipo, nota })
    if (error) setMsg({ tone: 'red', text: errMsg(error) })
    await cargar()
    onChanged()
  }

  async function enviarWhatsApp() {
    if (!link) return
    window.open(link, '_blank')
    await registrarGestion(gestionPorEstado(est), 'Enviado por WhatsApp')
    setMsg({ tone: 'green', text: 'Aviso registrado.' })
  }

  async function cambiarVenc() {
    if (!nuevoVenc || !motivo.trim()) return setMsg({ tone: 'red', text: 'Indicá nueva fecha y motivo.' })
    const { error } = await sb().from('facturas').update({ fecha_vencimiento: nuevoVenc }).eq('id', f!.id)
    if (error) return setMsg({ tone: 'red', text: errMsg(error) })
    await registrarGestion('otro', `Gerencia cambió el vencimiento de ${fmtFecha(f!.fecha_vencimiento)} a ${fmtFecha(nuevoVenc)}. Motivo: ${motivo.trim()}`)
    setNuevoVenc('')
    setMotivo('')
    setMsg({ tone: 'green', text: 'Vencimiento actualizado.' })
  }

  async function anular() {
    const m = window.prompt('Motivo de la anulación:')
    if (!m) return
    const { error } = await sb().from('facturas').update({ estado: 'anulada' }).eq('id', f!.id)
    if (error) return setMsg({ tone: 'red', text: errMsg(error) })
    await registrarGestion('otro', `Anulada por Gerencia. Motivo: ${m}`)
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs text-slate-500">{f.cliente?.razon_social}</div>
          <div className="flex flex-wrap items-center gap-2 text-lg font-semibold">
            <TipoBadge f={f} /> {f.numero}
          </div>
          <div className="mt-1 text-sm text-slate-600">
            {credito ? (
              <>Emitida {fmtFecha(f.fecha_emision)} · resta del saldo del cliente</>
            ) : (
              <>
                Emitida {fmtFecha(f.fecha_emision)} · Vence <b>{fmtFecha(f.fecha_vencimiento)}</b> · {f.condicion_venta} · {f.medio_pago_acordado}
              </>
            )}
          </div>
        </div>
        <div className="text-right">
          <Badge tone={meta.tone}>{meta.label}</Badge>
          <div className="mt-1 text-xl font-semibold tabular-nums">
            <Importe n={saldoFirmado(f)} />
          </div>
          <div className="text-xs text-slate-500">de {fmtMoney(montoFirmado(f))}</div>
        </div>
      </div>

      {meta.accion && <Alert tone={est === 'al_dia' ? 'green' : 'amber'}>{meta.accion}</Alert>}
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}

      {!credito && (
        <SeguimientoFactura
          f={f}
          onChanged={async () => {
            await cargar()
            onChanged()
          }}
        />
      )}

      {credito && f.estado === 'pendiente' && puedeEditar && (
        <ImputarCreditoForm
          credito={f}
          onDone={async (m) => {
            setMsg({ tone: 'green', text: m })
            await cargar()
            onChanged()
          }}
        />
      )}

      {f.estado === 'pendiente' && !credito && (
        <div className="space-y-2">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Mensaje sugerido</div>
          <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700">{texto}</div>
          <div className="flex flex-wrap gap-2">
            {link ? (
              <Button variant="success" onClick={enviarWhatsApp}>
                Enviar por WhatsApp
              </Button>
            ) : (
              <span className="text-xs text-slate-500">El cliente no tiene teléfono cargado.</span>
            )}
            <Button
              variant="secondary"
              onClick={async () => {
                await copiar(texto)
                setMsg({ tone: 'green', text: 'Mensaje copiado.' })
              }}
            >
              Copiar mensaje
            </Button>
            {puedeEditar && !cobrando && (
              <Button onClick={() => setCobrando(true)}>Registrar cobro</Button>
            )}
          </div>
        </div>
      )}

      {cobrando && (
        <CobroForm
          factura={f}
          onCancel={() => setCobrando(false)}
          onSaved={async (m) => {
            setCobrando(false)
            setMsg({ tone: 'green', text: m })
            await cargar()
            onChanged()
          }}
        />
      )}

      <div className="grid gap-5 md:grid-cols-2">
        <div>
          <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Gestiones</h4>
          <form
            className="mb-3 flex flex-col gap-2"
            onSubmit={async (e) => {
              e.preventDefault()
              if (!gNota.trim()) return
              await registrarGestion(gTipo, gNota.trim())
              setGNota('')
            }}
          >
            <select className={inputCls} value={gTipo} onChange={(e) => setGTipo(e.target.value as TipoGestion)}>
              {Object.entries(TIPO_GESTION).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <div className="flex gap-2">
              <input className={inputCls} placeholder="Ej: dice que paga el viernes por transferencia" value={gNota} onChange={(e) => setGNota(e.target.value)} />
              <Button type="submit" variant="secondary">
                Agregar
              </Button>
            </div>
          </form>
          <ul className="space-y-2">
            {gestiones.length === 0 && <li className="text-sm text-slate-500">Sin gestiones registradas.</li>}
            {gestiones.map((g) => (
              <li key={g.id} className="rounded-lg border border-slate-100 p-2 text-sm">
                <div className="flex justify-between gap-2 text-xs text-slate-500">
                  <span className="font-medium text-slate-700">{TIPO_GESTION[g.tipo]}</span>
                  <span>
                    {fmtFechaHora(g.created_at)} · {g.autor?.nombre ?? '—'}
                  </span>
                </div>
                {g.nota && <div className="mt-0.5">{g.nota}</div>}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">{credito ? 'Imputaciones' : 'Cobros e imputaciones'}</h4>
          <ul className="space-y-2">
            {cobros.length === 0 && <li className="text-sm text-slate-500">{credito ? 'Sin imputar todavía.' : 'Sin cobros.'}</li>}
            {cobros.map((c) => (
              <li key={c.id} className="flex justify-between gap-2 rounded-lg border border-slate-100 p-2 text-sm">
                <div>
                  <div className="font-medium">
                    {fmtFecha(c.fecha)} · {c.medio_pago}
                  </div>
                  <div className="text-xs text-slate-500">
                    {c.referencia ? `Ref. ${c.referencia} · ` : ''}
                    {c.autor?.nombre ?? '—'}
                  </div>
                </div>
                <div className="font-semibold tabular-nums">{fmtMoney(c.monto)}</div>
              </li>
            ))}
          </ul>

          {esGerencia && f.estado === 'pendiente' && (
            <div className="mt-5 space-y-2 rounded-lg border border-slate-200 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Solo Gerencia</div>
              <div className="flex flex-wrap gap-2">
                <input className={`${inputCls} w-auto`} type="date" value={nuevoVenc} onChange={(e) => setNuevoVenc(e.target.value)} />
                <input className={`${inputCls} min-w-0 flex-1`} placeholder="Motivo / autorización" value={motivo} onChange={(e) => setMotivo(e.target.value)} />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={cambiarVenc}>
                  Cambiar vencimiento
                </Button>
                <Button size="sm" variant="danger" onClick={anular}>
                  Anular comprobante
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// Imputar una nota de crédito / anula presupuesto contra una factura del cliente
// ---------------------------------------------------------------------
export function ImputarCreditoForm({ credito, onDone }: { credito: Factura; onDone: (msg: string) => void }) {
  const [facturas, setFacturas] = useState<Factura[] | null>(null)
  const [destino, setDestino] = useState('')
  const [monto, setMonto] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    sb()
      .from('facturas')
      .select('*')
      .eq('cliente_id', credito.cliente_id)
      .eq('estado', 'pendiente')
      .order('fecha_vencimiento')
      .then(({ data }) => {
        const fs = ((data as Factura[]) ?? []).filter((x) => !esCredito(x))
        setFacturas(fs)
        if (fs[0]) {
          setDestino(fs[0].id)
          setMonto(String(Math.min(Number(credito.saldo), Number(fs[0].saldo))).replace('.', ','))
        }
      })
  }, [credito.cliente_id, credito.saldo])

  const sel = facturas?.find((x) => x.id === destino)
  const maximo = sel ? Math.min(Number(credito.saldo), Number(sel.saldo)) : 0

  async function imputar(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const m = parseMonto(monto)
    if (!sel) return setError('Elegí la factura.')
    if (!(m > 0) || m > maximo + 0.004) return setError(`Importe inválido: podés imputar hasta ${fmtMoney(maximo)}.`)
    setBusy(true)
    const { error } = await sb().rpc('cob_imputar_credito', { p_credito: credito.id, p_factura: sel.id, p_monto: m })
    setBusy(false)
    if (error) return setError(errMsg(error))
    onDone(`Se imputaron ${fmtMoney(m)} contra ${infoTipo(sel).label} ${sel.numero}. No entra plata a Caja.`)
  }

  if (!facturas) return <Spinner />
  if (!facturas.length)
    return <Alert tone="blue">El cliente no tiene facturas pendientes para imputar este crédito. Igual ya resta de su saldo.</Alert>
  return (
    <form onSubmit={imputar} className="space-y-3 rounded-lg border border-sky-200 bg-sky-50/50 p-4">
      <div className="text-sm font-semibold text-sky-900">Imputar crédito · disponible {fmtMoney(credito.saldo)}</div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Contra" required className="sm:col-span-2">
          <select
            id="imp-factura"
            className={inputCls}
            value={destino}
            onChange={(e) => {
              setDestino(e.target.value)
              const x = facturas.find((y) => y.id === e.target.value)
              if (x) setMonto(String(Math.min(Number(credito.saldo), Number(x.saldo))).replace('.', ','))
            }}
          >
            {facturas.map((x) => (
              <option key={x.id} value={x.id}>
                {infoTipo(x).label} {x.numero} · vence {fmtFecha(x.fecha_vencimiento)} · saldo {fmtMoney(x.saldo)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Importe" required>
          <input id="imp-monto" className={inputCls} value={monto} onChange={(e) => setMonto(e.target.value)} inputMode="decimal" />
        </Field>
      </div>
      <p className="text-xs text-slate-600">Baja el saldo de los dos comprobantes. No es un cobro: no entra plata a Caja ni a Bancos.</p>
      {error && <Alert tone="red">{error}</Alert>}
      <div className="flex justify-end">
        <Button type="submit" disabled={busy}>
          {busy ? 'Imputando…' : 'Imputar'}
        </Button>
      </div>
    </form>
  )
}
