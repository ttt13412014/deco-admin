'use client'

import { FormEvent, useCallback, useEffect, useState } from 'react'
import { sb, errMsg } from '@/lib/supabase'
import type { Factura } from '@/lib/types'
import { esCredito } from '@/lib/comprobantes'
import { fmtFecha, fmtFechaHora, fmtMoney, hoy, parseMonto } from '@/lib/utils'
import { Cuenta, MEDIOS, Medio, cargarBase } from '@/lib/tesoreria'
import { useAuth } from './AuthProvider'
import { CamposCheque, CuentaSelect, DatosCheque, chequeVacio, cuentaPorMedio } from './Tesoreria'
import { Alert, Badge, Button, Field, cx, inputCls } from './ui'

export interface Promesa {
  id: string
  cliente_id: string
  factura_id: string | null
  fecha_promesa: string
  monto: number | null
  nota: string | null
  estado: 'pendiente' | 'cumplida' | 'cancelada'
  created_at: string
  autor?: { nombre: string } | null
}

export interface PagoInformado {
  id: string
  cliente_id: string
  factura_id: string | null
  fecha: string
  monto: number
  medio: Medio
  referencia: string | null
  nota: string | null
  estado: 'pendiente_validacion' | 'confirmado' | 'rechazado'
  motivo: string | null
  created_at: string
  cliente?: { razon_social: string } | null
  autor?: { nombre: string } | null
}

export const MEDIOS_INFORMADOS: Medio[] = ['transferencia', 'deposito', 'efectivo', 'cheque', 'echeq', 'tarjeta']
export const promesaIncumplida = (p: Promesa, ref = hoy()) => p.estado === 'pendiente' && p.fecha_promesa < ref

// ---------------------------------------------------------------------
export function PromesaForm({ factura, onDone, onCancel }: { factura: Factura; onDone: (m: string) => void; onCancel: () => void }) {
  const [fecha, setFecha] = useState('')
  const [monto, setMonto] = useState(String(factura.saldo).replace('.', ','))
  const [nota, setNota] = useState('')
  const [error, setError] = useState<string | null>(null)
  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!fecha) return setError('Indicá la fecha que prometió.')
    const { error } = await sb().rpc('cob_registrar_promesa', { p: { factura_id: factura.id, fecha_promesa: fecha, monto: parseMonto(monto) || null, nota: nota.trim() || null } })
    if (error) return setError(errMsg(error))
    onDone(`Promesa registrada para el ${fmtFecha(fecha)}. La fecha estimada de cobro y el flujo de fondos se movieron a ese día.`)
  }
  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-lg border border-sky-200 bg-sky-50/50 p-4">
      <div className="text-sm font-semibold text-sky-900">Promesa de pago</div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Promete pagar el" required>
          <input id="pr-fecha" type="date" className={inputCls} value={fecha} min={hoy()} onChange={(e) => setFecha(e.target.value)} />
        </Field>
        <Field label="Monto">
          <input id="pr-monto" className={inputCls} value={monto} onChange={(e) => setMonto(e.target.value)} inputMode="decimal" />
        </Field>
        <Field label="Nota">
          <input id="pr-nota" className={inputCls} value={nota} onChange={(e) => setNota(e.target.value)} placeholder="Habló con…" />
        </Field>
      </div>
      {error && <Alert tone="red">{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit">Registrar promesa</Button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------
export function InformarPagoForm({ factura, onDone, onCancel }: { factura: Factura; onDone: (m: string) => void; onCancel: () => void }) {
  const [fecha, setFecha] = useState(hoy())
  const [monto, setMonto] = useState(String(factura.saldo).replace('.', ','))
  const [medio, setMedio] = useState<Medio>('transferencia')
  const [ref, setRef] = useState('')
  const [nota, setNota] = useState('')
  const [error, setError] = useState<string | null>(null)
  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const m = parseMonto(monto)
    if (!(m > 0)) return setError('Monto inválido.')
    const { error } = await sb()
      .from('cob_pagos_informados')
      .insert({ cliente_id: factura.cliente_id, factura_id: factura.id, fecha, monto: m, medio, referencia: ref.trim() || null, nota: nota.trim() || null })
    if (error) return setError(errMsg(error))
    onDone('Pago informado registrado. Queda pendiente de validación: no baja la deuda ni entra a Caja hasta que Administración lo confirme.')
  }
  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-lg border border-amber-200 bg-amber-50/50 p-4">
      <div className="text-sm font-semibold text-amber-900">El cliente informa que pagó</div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Fecha que dice que pagó">
          <input id="pi-fecha" type="date" className={inputCls} value={fecha} onChange={(e) => setFecha(e.target.value)} />
        </Field>
        <Field label="Monto" required>
          <input id="pi-monto" className={inputCls} value={monto} onChange={(e) => setMonto(e.target.value)} inputMode="decimal" />
        </Field>
        <Field label="Medio">
          <select id="pi-medio" className={inputCls} value={medio} onChange={(e) => setMedio(e.target.value as Medio)}>
            {MEDIOS_INFORMADOS.map((m) => (
              <option key={m} value={m}>
                {MEDIOS[m]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Referencia / comprobante que mandó">
          <input id="pi-ref" className={inputCls} value={ref} onChange={(e) => setRef(e.target.value)} />
        </Field>
        <Field label="Nota" className="sm:col-span-2">
          <input id="pi-nota" className={inputCls} value={nota} onChange={(e) => setNota(e.target.value)} />
        </Field>
      </div>
      {error && <Alert tone="red">{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit">Registrar pago informado</Button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------
// Confirmar un pago informado: se imputa y entra a Caja y Bancos
// ---------------------------------------------------------------------
export function ConfirmarPagoForm({ pi, onDone, onCancel }: { pi: PagoInformado; onDone: (m: string) => void; onCancel: () => void }) {
  const [facturas, setFacturas] = useState<Factura[] | null>(null)
  const [cuentas, setCuentas] = useState<Cuenta[]>([])
  const [imp, setImp] = useState<Record<string, string>>({})
  const [medio, setMedio] = useState<Medio>(pi.medio)
  const [cuenta, setCuenta] = useState('')
  const [fecha, setFecha] = useState(pi.fecha)
  const [cheque, setCheque] = useState<DatosCheque>(chequeVacio())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const esCheque = medio === 'cheque' || medio === 'echeq'

  useEffect(() => {
    ;(async () => {
      const [{ data }, b] = await Promise.all([
        sb().from('facturas').select('*').eq('cliente_id', pi.cliente_id).eq('estado', 'pendiente').order('fecha_vencimiento'),
        cargarBase(),
      ])
      // Las notas de crédito no reciben pagos: se imputan contra facturas desde el detalle
      const fs = ((data as Factura[]) ?? []).filter((f) => !esCredito(f))
      setFacturas(fs)
      setCuentas(b.cuentas)
      setCuenta(cuentaPorMedio(b.cuentas, pi.medio, b.cuentas.find((c) => c.cobro_default)?.id ?? ''))
      // Imputación sugerida: primero la factura informada, después las más viejas
      let resto = Number(pi.monto)
      const orden = [...fs].sort((a, b) => (a.id === pi.factura_id ? -1 : b.id === pi.factura_id ? 1 : a.fecha_vencimiento.localeCompare(b.fecha_vencimiento)))
      const m: Record<string, string> = {}
      for (const f of orden) {
        if (resto <= 0) break
        const x = Math.min(resto, Number(f.saldo))
        m[f.id] = String(Math.round(x * 100) / 100).replace('.', ',')
        resto -= x
      }
      setImp(m)
    })()
  }, [pi])

  const total = Object.values(imp).reduce((a, v) => a + (parseMonto(v) || 0), 0)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const imputaciones = Object.entries(imp)
      .map(([factura_id, v]) => ({ factura_id, monto: parseMonto(v) || 0 }))
      .filter((x) => x.monto > 0)
    if (!imputaciones.length) return setError('Imputá al menos una factura.')
    setBusy(true)
    const { error } = await sb().rpc('cob_confirmar_pago', {
      p_id: pi.id,
      p: { cuenta_id: cuenta, medio, fecha, imputaciones, cheque: esCheque ? { ...cheque, numero: cheque.numero.trim() } : null },
    })
    setBusy(false)
    if (error) return setError(errMsg(error))
    onDone(`Pago confirmado: se imputaron ${fmtMoney(total)} y ${esCheque ? 'el cheque quedó en cartera' : 'entró a Caja y Bancos'}.`)
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="rounded-lg bg-slate-50 p-3 text-sm">
        <div className="font-medium">{pi.cliente?.razon_social}</div>
        <div className="text-slate-500">
          Informó {fmtMoney(pi.monto)} el {fmtFecha(pi.fecha)} por {MEDIOS[pi.medio]}
          {pi.referencia ? ` · ${pi.referencia}` : ''}
        </div>
      </div>
      <p className="text-sm text-slate-600">Confirmalo solo cuando lo veas en el banco o en Sintesys. Elegí a qué facturas se imputa:</p>
      {!facturas ? (
        <p className="text-sm text-slate-500">Cargando facturas…</p>
      ) : facturas.length === 0 ? (
        <Alert tone="amber">El cliente no tiene facturas pendientes en la app.</Alert>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {facturas.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1">
                {f.tipo_comprobante} {f.numero}
                <span className="block text-xs text-slate-500">
                  vence {fmtFecha(f.fecha_vencimiento)} · saldo {fmtMoney(f.saldo)}
                </span>
              </span>
              <input className={`${inputCls} w-36`} inputMode="decimal" value={imp[f.id] ?? ''} onChange={(e) => setImp({ ...imp, [f.id]: e.target.value })} aria-label={`Imputar a ${f.numero}`} placeholder="0" />
            </li>
          ))}
        </ul>
      )}
      <div className={cx('text-sm', total > Number(pi.monto) + 0.004 ? 'text-red-700' : 'text-slate-600')}>
        Imputado {fmtMoney(total)} de {fmtMoney(pi.monto)}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Medio">
          <select
            id="cp-medio"
            className={inputCls}
            value={medio}
            onChange={(e) => {
              const m = e.target.value as Medio
              setMedio(m)
              setCuenta(cuentaPorMedio(cuentas, m, cuenta))
            }}
          >
            {MEDIOS_INFORMADOS.map((m) => (
              <option key={m} value={m}>
                {MEDIOS[m]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={esCheque ? 'Se deposita en' : 'Entró en'}>
          <CuentaSelect id="cp-cuenta" cuentas={cuentas} value={cuenta} onChange={setCuenta} />
        </Field>
        <Field label="Fecha de acreditación">
          <input id="cp-fecha" type="date" className={inputCls} value={fecha} onChange={(e) => setFecha(e.target.value)} />
        </Field>
      </div>
      {esCheque && <CamposCheque value={cheque} onChange={setCheque} />}
      {error && <Alert tone="red">{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit" variant="success" disabled={busy || !total}>
          {busy ? 'Confirmando…' : 'Confirmar e imputar'}
        </Button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------
// Bloque de seguimiento dentro del detalle de una factura
// ---------------------------------------------------------------------
type Hist = { id: number; campo: string; antes: string | null; despues: string | null; motivo: string | null; fecha: string; autor?: { nombre: string } | null }

export function SeguimientoFactura({ f, onChanged }: { f: Factura; onChanged: () => void }) {
  const { puedeEditar } = useAuth()
  const [promesas, setPromesas] = useState<Promesa[]>([])
  const [informados, setInformados] = useState<PagoInformado[]>([])
  const [hist, setHist] = useState<Hist[]>([])
  const [modo, setModo] = useState<null | 'promesa' | 'informar'>(null)
  const [msg, setMsg] = useState<{ tone: 'green' | 'red'; text: string } | null>(null)

  const cargar = useCallback(async () => {
    const s = sb()
    const [a, b, c] = await Promise.all([
      s.from('cob_promesas').select('*, autor:perfiles!created_by(nombre)').eq('factura_id', f.id).order('created_at', { ascending: false }),
      s.from('cob_pagos_informados').select('*, autor:perfiles!created_by(nombre)').eq('factura_id', f.id).order('created_at', { ascending: false }),
      s.from('hist_fechas').select('*, autor:perfiles!usuario(nombre)').eq('entidad', 'factura').eq('entidad_id', f.id).order('fecha'),
    ])
    setPromesas((a.data as Promesa[]) ?? [])
    setInformados((b.data as PagoInformado[]) ?? [])
    setHist((c.data as Hist[]) ?? [])
  }, [f.id])
  useEffect(() => {
    cargar()
  }, [cargar, f.saldo, f.fecha_estimada_cobro])

  const listo = (t: string) => {
    setModo(null)
    setMsg({ tone: 'green', text: t })
    cargar()
    onChanged()
  }

  async function cambiarFecha() {
    const v = window.prompt('Fecha estimada de cobro (AAAA-MM-DD). Vacío = sin fecha:', f.fecha_estimada_cobro ?? '')
    if (v === null) return
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return setMsg({ tone: 'red', text: 'Fecha inválida (AAAA-MM-DD).' })
    const motivo = window.prompt('Motivo:')
    if (!motivo?.trim()) return
    const { error } = await sb().rpc('cob_cambiar_fecha', { p_factura: f.id, p_fecha: v || null, p_motivo: motivo.trim() })
    if (error) return setMsg({ tone: 'red', text: errMsg(error) })
    listo('Fecha estimada actualizada. El flujo de fondos la mueve a ese día.')
  }
  async function ajustar() {
    const v = window.prompt(`Saldo según Sintesys (hoy en la app: ${fmtMoney(f.saldo)}):`, String(f.saldo_sintesys ?? f.saldo).replace('.', ','))
    if (v === null) return
    const motivo = window.prompt('Motivo del ajuste (ej: cobrado y registrado en Sintesys, nota de crédito):')
    if (!motivo?.trim()) return
    const { error } = await sb().rpc('cob_ajustar_sintesys', { p_factura: f.id, p_saldo: parseMonto(v), p_motivo: motivo.trim() })
    if (error) return setMsg({ tone: 'red', text: errMsg(error) })
    listo('Saldo ajustado con Sintesys. No genera movimiento de caja; queda registrado en las gestiones.')
  }
  async function cumplir(p: Promesa, estado: 'cumplida' | 'cancelada') {
    const { error } = await sb().from('cob_promesas').update({ estado, cumplida_at: new Date().toISOString() }).eq('id', p.id)
    if (error) return setMsg({ tone: 'red', text: errMsg(error) })
    cargar()
  }

  const difSintesys = f.saldo_sintesys !== null && f.saldo_sintesys !== undefined && Math.abs(Number(f.saldo_sintesys) - Number(f.saldo)) > 0.004

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm">
          <span className="text-slate-500">Cobro estimado:</span> <b>{f.fecha_estimada_cobro ? fmtFecha(f.fecha_estimada_cobro) : 'sin fecha'}</b>
          {f.vencimiento_original && f.vencimiento_original !== f.fecha_vencimiento && (
            <span className="ml-2 text-xs text-slate-500">vencimiento original {fmtFecha(f.vencimiento_original)}</span>
          )}
          {f.vendedor && <span className="ml-2 text-xs text-slate-500">· vendedor {f.vendedor}</span>}
          {f.origen === 'sintesys' && <span className="ml-2 text-xs text-slate-500">· Sintesys</span>}
        </div>
        {f.estado === 'pendiente' && (
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant="secondary" onClick={cambiarFecha}>
              Fecha estimada
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setModo('promesa')}>
              Promesa de pago
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setModo('informar')}>
              Informó un pago
            </Button>
          </div>
        )}
      </div>
      {difSintesys && (
        <Alert tone="amber">
          Sintesys dice saldo <b>{fmtMoney(f.saldo_sintesys)}</b> y la app <b>{fmtMoney(f.saldo)}</b>. Si el cliente pagó, registrá el cobro (entra a Caja); si se resolvió por otro
          lado (nota de crédito, compensación),{' '}
          {puedeEditar ? (
            <button className="font-medium underline" onClick={ajustar}>
              ajustalo con motivo
            </button>
          ) : (
            'pedí que lo ajusten'
          )}
          .
        </Alert>
      )}
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {modo === 'promesa' && <PromesaForm factura={f} onCancel={() => setModo(null)} onDone={listo} />}
      {modo === 'informar' && <InformarPagoForm factura={f} onCancel={() => setModo(null)} onDone={listo} />}
      {(promesas.length > 0 || informados.length > 0 || hist.length > 0) && (
        <div className="grid gap-3 text-sm md:grid-cols-3">
          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Promesas</div>
            {promesas.length === 0 && <div className="text-slate-400">—</div>}
            {promesas.map((p) => (
              <div key={p.id} className="mb-1 rounded border border-slate-100 p-1.5">
                <div className="flex items-center justify-between gap-1">
                  <span>
                    {fmtFecha(p.fecha_promesa)} {p.monto ? `· ${fmtMoney(p.monto)}` : ''}
                  </span>
                  <Badge tone={promesaIncumplida(p) ? 'red' : p.estado === 'cumplida' ? 'green' : p.estado === 'cancelada' ? 'slate' : 'amber'}>
                    {promesaIncumplida(p) ? 'Incumplida' : p.estado === 'pendiente' ? 'Pendiente' : p.estado === 'cumplida' ? 'Cumplida' : 'Cancelada'}
                  </Badge>
                </div>
                {p.nota && <div className="text-xs text-slate-500">{p.nota}</div>}
                {p.estado === 'pendiente' && (
                  <div className="mt-1 flex gap-2 text-xs">
                    <button className="underline" onClick={() => cumplir(p, 'cumplida')}>
                      Cumplida
                    </button>
                    <button className="underline" onClick={() => cumplir(p, 'cancelada')}>
                      Descartar
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Pagos informados</div>
            {informados.length === 0 && <div className="text-slate-400">—</div>}
            {informados.map((p) => (
              <div key={p.id} className="mb-1 rounded border border-slate-100 p-1.5">
                <div className="flex items-center justify-between gap-1">
                  <span>
                    {fmtFecha(p.fecha)} · {fmtMoney(p.monto)}
                  </span>
                  <Badge tone={p.estado === 'confirmado' ? 'green' : p.estado === 'rechazado' ? 'slate' : 'amber'}>
                    {p.estado === 'pendiente_validacion' ? 'A validar' : p.estado === 'confirmado' ? 'Confirmado' : 'Rechazado'}
                  </Badge>
                </div>
                <div className="text-xs text-slate-500">{[MEDIOS[p.medio], p.referencia, p.motivo].filter(Boolean).join(' · ')}</div>
              </div>
            ))}
          </div>
          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Cambios de fechas</div>
            {hist.length === 0 && <div className="text-slate-400">—</div>}
            {hist.map((h) => (
              <div key={h.id} className="mb-1 rounded border border-slate-100 p-1.5">
                <div>
                  {h.campo === 'vencimiento' ? 'Vencimiento' : 'Cobro estimado'}: {h.antes ? fmtFecha(h.antes) : '—'} → <b>{h.despues ? fmtFecha(h.despues) : '—'}</b>
                </div>
                <div className="text-xs text-slate-500">
                  {fmtFechaHora(h.fecha)} · {h.autor?.nombre ?? '—'}
                  {h.motivo ? ` · ${h.motivo}` : ''}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
