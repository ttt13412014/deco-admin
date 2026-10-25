'use client'

import { FormEvent, useState } from 'react'
import { sb, errMsg } from '@/lib/supabase'
import type { Cliente } from '@/lib/types'
import { CONDICIONES_IVA, MEDIOS_PAGO, TIPOS_FACTURA, faltantesCliente, fmtTipoFactura, soloDigitos, validarCuitDni } from '@/lib/utils'
import { normalizarUbicacion } from '@/lib/rutas'
import { camposDeVentanas, fmtVentanas, hhmm, parsearHorarios, ventanasDe } from '@/lib/horarios'
import { Alert, Button, Field, inputCls } from './ui'
import { useAuth } from './AuthProvider'

type Form = Omit<Cliente, 'id' | 'created_at' | 'created_by' | 'updated_at' | 'updated_by' | 'lat' | 'lng'>

const vacio: Form = {
  razon_social: '',
  cuit_dni: '',
  condicion_iva: null,
  tipo_factura: null,
  contacto_nombre: '',
  telefono: '',
  email: '',
  direccion: '',
  localidad: '',
  provincia: 'Córdoba',
  ubicacion: '',
  horarios: '',
  horario_desde: null,
  horario_hasta: null,
  horario2_desde: null,
  horario2_hasta: null,
  medio_pago_preferido: null,
  estado: 'pendiente',
  observaciones: '',
}

const HORA_KEYS = ['horario_desde', 'horario_hasta', 'horario2_desde', 'horario2_hasta'] as const

function tipoSugerido(cond: string | null): string | null {
  if (!cond) return null
  return cond === 'Responsable Inscripto' ? 'A' : 'B'
}

export function ClienteForm({
  inicial,
  onSaved,
  onCancel,
}: {
  inicial?: Cliente
  onSaved: (c: Cliente) => void
  onCancel?: () => void
}) {
  const [f, setF] = useState<Form>(() => {
    if (!inicial) return vacio
    // Solo los campos editables (inicial puede venir de la vista con saldos)
    const out = { ...vacio } as Record<string, unknown>
    for (const k of Object.keys(vacio)) out[k] = (inicial as unknown as Record<string, unknown>)[k] ?? (vacio as unknown as Record<string, unknown>)[k]
    for (const k of HORA_KEYS) out[k] = hhmm(out[k] as string | null) || null
    return out as unknown as Form
  })
  // Validar / habilitar es de Administración y Gerencia; Ventas carga y queda pendiente (o mantiene el estado que tenía)
  const { puedeEditar } = useAuth()
  const [habilitar, setHabilitar] = useState(inicial ? inicial.estado === 'activo' : puedeEditar)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }))
  const cuit: { ok: boolean; msg?: string } = !f.cuit_dni
    ? { ok: true }
    : f.tipo_factura === 'A' && soloDigitos(f.cuit_dni).length !== 11
      ? { ok: false, msg: 'Para Factura A tiene que ser un CUIT de 11 dígitos.' }
      : validarCuitDni(f.cuit_dni)
  const faltan = faltantesCliente(f)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!cuit.ok) return setError(`CUIT/DNI: ${cuit.msg}`)
    if (f.ubicacion?.trim() && !normalizarUbicacion(f.ubicacion)) {
      return setError('No pude leer coordenadas en "Ubicación". Pegá los números (en Google Maps mantené apretado el punto y copiá las coordenadas) o un link largo que contenga @lat,lng.')
    }
    const vs = ventanasDe(f)
    for (const [d, h] of [['horario_desde', 'horario_hasta'], ['horario2_desde', 'horario2_hasta']] as const) {
      if (f[d] && f[h] && f[h]! <= f[d]!) return setError('En el horario para ordenar la ruta, la hora "hasta" tiene que ser posterior a "desde".')
    }
    if (vs.length === 2 && vs[1].desde < vs[0].hasta) return setError('Los dos horarios para ordenar la ruta se superponen.')
    if (puedeEditar && habilitar && faltan.length) {
      return setError(`Para habilitarlo faltan: ${faltan.join(', ')}. Completalos o destildá "Habilitar" para guardarlo como pendiente.`)
    }
    const estado = !puedeEditar
      ? inicial?.estado ?? 'pendiente'
      : inicial?.estado === 'inhabilitado' && !habilitar ? 'inhabilitado' : habilitar ? 'activo' : 'pendiente'
    const payload = {
      ...f,
      cuit_dni: soloDigitos(f.cuit_dni ?? '') || null,
      ubicacion: normalizarUbicacion(f.ubicacion ?? '') || null,
      estado,
      razon_social: f.razon_social.trim(),
      horario_desde: f.horario_desde || null,
      horario_hasta: f.horario_hasta || null,
      horario2_desde: f.horario2_desde || null,
      horario2_hasta: f.horario2_hasta || null,
      email: f.email?.trim() || null,
    }
    setBusy(true)
    const q = inicial
      ? sb().from('clientes').update(payload).eq('id', inicial.id).select().single()
      : sb().from('clientes').insert(payload).select().single()
    const { data, error } = await q
    setBusy(false)
    if (error) return setError(errMsg(error))
    onSaved(data as Cliente)
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-brand-700">Datos fiscales</legend>
        <Field label="Razón social / nombre completo" required className="sm:col-span-2">
          <input className={inputCls} value={f.razon_social} onChange={(e) => set('razon_social', e.target.value)} required />
        </Field>
        <Field
          label={f.tipo_factura === 'A' ? 'CUIT' : 'CUIT / DNI'}
          required={f.tipo_factura === 'A'}
          error={!cuit.ok ? cuit.msg : null}
          hint={f.tipo_factura === 'A' ? 'Obligatorio para Factura A (11 dígitos). Con o sin guiones.' : 'Opcional. Con o sin guiones.'}
        >
          <input className={inputCls} value={f.cuit_dni ?? ''} onChange={(e) => set('cuit_dni', e.target.value)} inputMode="numeric" />
        </Field>
        <Field label="Condición frente al IVA" required>
          <select
            className={inputCls}
            value={f.condicion_iva ?? ''}
            onChange={(e) => {
              const v = e.target.value || null
              setF((p) => ({ ...p, condicion_iva: v, tipo_factura: p.tipo_factura ?? tipoSugerido(v) }))
            }}
          >
            <option value="">Elegir…</option>
            {CONDICIONES_IVA.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label="Formato de facturación" required>
          <select className={inputCls} value={f.tipo_factura ?? ''} onChange={(e) => set('tipo_factura', e.target.value || null)}>
            <option value="">Elegir…</option>
            {TIPOS_FACTURA.map((t) => (
              <option key={t} value={t}>
                {fmtTipoFactura(t)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Medio de pago preferido">
          <select className={inputCls} value={f.medio_pago_preferido ?? ''} onChange={(e) => set('medio_pago_preferido', e.target.value || null)}>
            <option value="">—</option>
            {MEDIOS_PAGO.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </Field>
      </fieldset>

      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-brand-700">Contacto</legend>
        <Field label="Nombre de contacto" required>
          <input className={inputCls} value={f.contacto_nombre ?? ''} onChange={(e) => set('contacto_nombre', e.target.value)} />
        </Field>
        <Field label="Teléfono (WhatsApp)" required hint="Ej: 351 555-1234">
          <input className={inputCls} value={f.telefono ?? ''} onChange={(e) => set('telefono', e.target.value)} inputMode="tel" />
        </Field>
        <Field label="Email" required>
          <input className={inputCls} type="email" value={f.email ?? ''} onChange={(e) => set('email', e.target.value)} />
        </Field>
      </fieldset>

      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-brand-700">Datos operativos</legend>
        <Field label="Dirección completa" required className="sm:col-span-2">
          <input className={inputCls} value={f.direccion ?? ''} onChange={(e) => set('direccion', e.target.value)} />
        </Field>
        <Field label="Localidad" required>
          <input className={inputCls} value={f.localidad ?? ''} onChange={(e) => set('localidad', e.target.value)} />
        </Field>
        <Field label="Provincia">
          <input className={inputCls} value={f.provincia ?? ''} onChange={(e) => set('provincia', e.target.value)} />
        </Field>
        <Field label="Ubicación en Maps (opcional)" className="sm:col-span-2" hint="Pegá coordenadas o el link de Google Maps. Útil para rutas o zonas rurales.">
          <input className={inputCls} value={f.ubicacion ?? ''} onChange={(e) => set('ubicacion', e.target.value)} placeholder="-31.4135, -64.1811" />
        </Field>
        <Field label="Horarios de atención" required className="sm:col-span-3">
          <input
            className={inputCls}
            value={f.horarios ?? ''}
            onChange={(e) => set('horarios', e.target.value)}
            onBlur={() => {
              // Si todavía no cargó el horario para la ruta, se completa solo leyendo el texto
              if (HORA_KEYS.some((k) => f[k])) return
              const vs = parsearHorarios(f.horarios)
              if (vs.length) setF((p) => ({ ...p, ...camposDeVentanas(vs) }))
            }}
            placeholder="Lun a Vie 8 a 17"
          />
        </Field>
        <div className="rounded-lg border border-slate-200 p-3 sm:col-span-3">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-xs font-medium text-slate-600">Horario para ordenar la ruta (opcional)</span>
            {parsearHorarios(f.horarios).length > 0 && fmtVentanas(parsearHorarios(f.horarios)) !== fmtVentanas(ventanasDe(f)) && (
              <button type="button" className="text-xs text-brand-700 hover:underline" onClick={() => setF((p) => ({ ...p, ...camposDeVentanas(parsearHorarios(p.horarios)) }))}>
                Tomar del texto: {fmtVentanas(parsearHorarios(f.horarios))}
              </button>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {([['horario_desde', 'horario_hasta', 'Abre de'], ['horario2_desde', 'horario2_hasta', 'Y de (horario cortado)']] as const).map(([d, h, l]) => (
              <div key={d} className="flex items-center gap-2 text-sm">
                <span className="w-36 shrink-0 text-xs text-slate-500">{l}</span>
                <input type="time" className={inputCls} value={f[d] ?? ''} onChange={(e) => set(d, e.target.value || null)} aria-label={`${l} desde`} />
                <span className="text-xs text-slate-500">a</span>
                <input type="time" className={inputCls} value={f[h] ?? ''} onChange={(e) => set(h, e.target.value || null)} aria-label={`${l} hasta`} />
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Al ordenar la hoja de ruta, a este cliente no se lo pone antes de que abra ni después de que cierre. Dejalo vacío si recibe a cualquier hora.
          </p>
        </div>
        <Field label="Observaciones administrativas" className="sm:col-span-3">
          <textarea className={inputCls} rows={2} value={f.observaciones ?? ''} onChange={(e) => set('observaciones', e.target.value)} />
        </Field>
      </fieldset>

      {!puedeEditar ? (
        <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
          {inicial ? 'El estado del cliente no cambia.' : <>El cliente queda <i>pendiente</i> hasta que Administración lo valide (A01).</>}
        </p>
      ) : (
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-brand-700" checked={habilitar} onChange={(e) => setHabilitar(e.target.checked)} />
          <span>
            <b>Validado: habilitar para facturación</b>
            <span className="block text-xs text-slate-500">
              A01 · Paso 4. Si no está tildado queda <i>pendiente</i> y no se le puede facturar.
              {faltan.length > 0 && <span className="text-amber-700"> Faltan: {faltan.join(', ')}.</span>}
            </span>
          </span>
        </label>
      </div>
      )}

      {error && <Alert tone="red">{error}</Alert>}

      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button variant="secondary" onClick={onCancel}>
            Cancelar
          </Button>
        )}
        <Button type="submit" disabled={busy}>
          {busy ? 'Guardando…' : inicial ? 'Guardar cambios' : 'Dar de alta'}
        </Button>
      </div>
    </form>
  )
}
