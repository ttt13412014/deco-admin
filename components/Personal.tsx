'use client'

import { FormEvent, useMemo, useState } from 'react'
import { sb, errMsg } from '@/lib/supabase'
import { fmtFecha, hoy } from '@/lib/utils'
import {
  Empleado, Evento, MESES, Novedad, TIPOS, TIPOS_CARGA, TipoNovedad, celdasMes, diaSemana, diasCorridos, diasHabiles,
  nombreEmp, saldoVacaciones, vacacionesLCT, validarCuil,
} from '@/lib/personal'
import { linkGoogle } from '@/lib/ics'
import { useAuth } from './AuthProvider'
import { Alert, Button, Field, cx, inputCls } from './ui'

export const AREAS = ['Administración', 'Ventas', 'Depósito', 'Taller / Producción', 'Mantenimiento', 'Logística', 'Gerencia']

export function Etiqueta({ tipo, children }: { tipo: keyof typeof TIPOS; children?: React.ReactNode }) {
  const c = TIPOS[tipo].color
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium" style={{ background: `${c}1a`, color: c }}>
      <span className="h-2 w-2 rounded-full" style={{ background: c }} aria-hidden />
      {children ?? TIPOS[tipo].label}
    </span>
  )
}

// ---------------------------------------------------------------------
// Alta / edición de empleado
// ---------------------------------------------------------------------
type FormEmp = Omit<Empleado, 'id' | 'created_at' | 'updated_at'>
const vacio: FormEmp = {
  nombre: '', apellido: '', cuil: '', puesto: '', area: '', fecha_ingreso: hoy(), fecha_nacimiento: '', telefono: '', email: '',
  emergencia_nombre: '', emergencia_telefono: '', emergencia_vinculo: '', dias_vacaciones_manual: null, activo: true, fecha_baja: null, observaciones: '',
}

export function EmpleadoForm({ inicial, onSaved, onCancel }: { inicial?: Empleado; onSaved: (msg: string) => void; onCancel: () => void }) {
  const [f, setF] = useState<FormEmp>(() => {
    if (!inicial) return vacio
    const { id: _i, created_at: _c, updated_at: _u, ...rest } = inicial
    return { ...vacio, ...rest }
  })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof FormEmp>(k: K, v: FormEmp[K]) => setF((p) => ({ ...p, [k]: v }))
  const anio = Number(hoy().slice(0, 4))
  const lct = f.fecha_ingreso ? vacacionesLCT(f.fecha_ingreso, anio) : null
  const errCuil = f.cuil ? validarCuil(f.cuil) : null

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!f.nombre.trim() || !f.apellido.trim()) return setError('Completá nombre y apellido.')
    if (errCuil) return setError(errCuil)
    const payload = {
      ...f,
      nombre: f.nombre.trim(),
      apellido: f.apellido.trim(),
      cuil: (f.cuil ?? '').replace(/\D/g, '') || null,
      fecha_nacimiento: f.fecha_nacimiento || null,
      email: f.email?.trim() || null,
    }
    setBusy(true)
    const r = inicial ? await sb().from('empleados').update(payload).eq('id', inicial.id) : await sb().from('empleados').insert(payload)
    setBusy(false)
    if (r.error) return setError(errMsg(r.error))
    onSaved(inicial ? 'Legajo actualizado.' : `${payload.nombre} ${payload.apellido} dado de alta.`)
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-brand-700">Datos personales</legend>
        <Field label="Nombre" required>
          <input id="emp-nombre" className={inputCls} value={f.nombre} onChange={(e) => set('nombre', e.target.value)} />
        </Field>
        <Field label="Apellido" required>
          <input id="emp-apellido" className={inputCls} value={f.apellido} onChange={(e) => set('apellido', e.target.value)} />
        </Field>
        <Field label="CUIL" error={errCuil}>
          <input id="emp-cuil" className={inputCls} value={f.cuil ?? ''} onChange={(e) => set('cuil', e.target.value)} inputMode="numeric" placeholder="20-12345678-9" />
        </Field>
        <Field label="Fecha de nacimiento">
          <input id="emp-nac" className={inputCls} type="date" value={f.fecha_nacimiento ?? ''} onChange={(e) => set('fecha_nacimiento', e.target.value)} />
        </Field>
        <Field label="Teléfono">
          <input id="emp-tel" className={inputCls} value={f.telefono ?? ''} onChange={(e) => set('telefono', e.target.value)} inputMode="tel" />
        </Field>
        <Field label="Email">
          <input id="emp-email" className={inputCls} type="email" value={f.email ?? ''} onChange={(e) => set('email', e.target.value)} />
        </Field>
      </fieldset>

      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-brand-700">Puesto</legend>
        <Field label="Puesto">
          <input id="emp-puesto" className={inputCls} value={f.puesto ?? ''} onChange={(e) => set('puesto', e.target.value)} placeholder="Ej: Operario de taller" />
        </Field>
        <Field label="Área">
          <input id="emp-area" className={inputCls} list="emp-areas" value={f.area ?? ''} onChange={(e) => set('area', e.target.value)} />
          <datalist id="emp-areas">
            {AREAS.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
        </Field>
        <Field label="Fecha de ingreso" required>
          <input id="emp-ingreso" className={inputCls} type="date" value={f.fecha_ingreso} onChange={(e) => set('fecha_ingreso', e.target.value)} required />
        </Field>
      </fieldset>

      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-brand-700">Contacto de emergencia</legend>
        <Field label="Nombre">
          <input id="emp-em-nombre" className={inputCls} value={f.emergencia_nombre ?? ''} onChange={(e) => set('emergencia_nombre', e.target.value)} />
        </Field>
        <Field label="Teléfono">
          <input id="emp-em-tel" className={inputCls} value={f.emergencia_telefono ?? ''} onChange={(e) => set('emergencia_telefono', e.target.value)} inputMode="tel" />
        </Field>
        <Field label="Vínculo">
          <input id="emp-em-vinculo" className={inputCls} value={f.emergencia_vinculo ?? ''} onChange={(e) => set('emergencia_vinculo', e.target.value)} placeholder="Esposa, padre…" />
        </Field>
      </fieldset>

      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-brand-700">Vacaciones</legend>
        <Field
          label={`Días asignados ${anio}`}
          hint={lct ? `Por LCT le corresponden ${lct.dias} días corridos (${lct.regla.toLowerCase()}). Dejalo vacío para usar ese valor.` : undefined}
        >
          <input
            id="emp-vac"
            className={inputCls}
            type="number"
            min={0}
            max={60}
            value={f.dias_vacaciones_manual ?? ''}
            placeholder={lct ? String(lct.dias) : ''}
            onChange={(e) => set('dias_vacaciones_manual', e.target.value === '' ? null : Number(e.target.value))}
          />
        </Field>
        <Field label="Observaciones">
          <input id="emp-obs" className={inputCls} value={f.observaciones ?? ''} onChange={(e) => set('observaciones', e.target.value)} />
        </Field>
        {inicial && (
          <label className="flex items-center gap-2 text-sm">
            <input id="emp-activo" type="checkbox" className="h-4 w-4 accent-brand-700" checked={f.activo} onChange={(e) => set('activo', e.target.checked)} />
            Activo {!f.activo && <span className="text-xs text-slate-500">(se registra la baja con fecha de hoy)</span>}
          </label>
        )}
      </fieldset>

      {error && <Alert tone="red">{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? 'Guardando…' : inicial ? 'Guardar cambios' : 'Dar de alta'}
        </Button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------
// Carga de novedades
// ---------------------------------------------------------------------
export function NovedadForm({
  empleados,
  novedades,
  inicial,
  preset,
  onSaved,
  onCancel,
}: {
  empleados: Empleado[]
  novedades: Novedad[]
  inicial?: Novedad
  preset?: { fecha?: string; empleado_id?: string; tipo?: TipoNovedad }
  onSaved: (msg: string) => void
  onCancel: () => void
}) {
  const { esGerencia } = useAuth()
  const [tipo, setTipo] = useState<TipoNovedad>(inicial?.tipo ?? preset?.tipo ?? 'vacaciones')
  const [emp, setEmp] = useState(inicial?.empleado_id ?? preset?.empleado_id ?? '')
  const [desde, setDesde] = useState(inicial?.fecha_desde ?? preset?.fecha ?? hoy())
  const [hasta, setHasta] = useState(inicial?.fecha_hasta ?? preset?.fecha ?? hoy())
  const [hora, setHora] = useState(inicial?.hora ?? '')
  const [titulo, setTitulo] = useState(inicial?.titulo ?? '')
  const [obs, setObs] = useState(inicial?.observaciones ?? '')
  const [aprobar, setAprobar] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const activos = empleados.filter((e) => e.activo || e.id === emp)
  const general = tipo === 'reunion' || tipo === 'feriado' || tipo === 'otro'
  const empleado = empleados.find((e) => e.id === emp)
  const dias = desde && hasta && hasta >= desde ? diasCorridos(desde, hasta) : 0
  const habiles = dias ? diasHabiles(desde, hasta) : 0
  const anio = Number(desde.slice(0, 4))
  const saldo = empleado && tipo === 'vacaciones' ? saldoVacaciones(empleado, novedades.filter((n) => n.id !== inicial?.id), anio) : null
  const superpone = useMemo(
    () =>
      emp
        ? novedades.filter(
            (n) => n.id !== inicial?.id && n.empleado_id === emp && n.estado !== 'rechazado' && ['vacaciones', 'licencia', 'permiso'].includes(n.tipo) && n.fecha_desde <= hasta && n.fecha_hasta >= desde,
          )
        : [],
    [emp, novedades, inicial, desde, hasta],
  )

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!general && !emp) return setError('Elegí el empleado.')
    if (hasta < desde) return setError('La fecha "hasta" no puede ser anterior a "desde".')
    if ((tipo === 'reunion' || tipo === 'feriado' || tipo === 'otro') && !titulo.trim()) return setError('Poné un título (ej: Reunión de seguridad).')
    const payload: Record<string, unknown> = {
      tipo,
      empleado_id: emp || null,
      fecha_desde: desde,
      fecha_hasta: hasta,
      hora: hora.trim() || null,
      titulo: titulo.trim() || null,
      observaciones: obs.trim() || null,
    }
    if (!inicial && esGerencia && aprobar) payload.estado = 'aprobado'
    setBusy(true)
    const r = inicial ? await sb().from('novedades').update(payload).eq('id', inicial.id) : await sb().from('novedades').insert(payload)
    setBusy(false)
    if (r.error) return setError(errMsg(r.error))
    onSaved(
      inicial
        ? inicial.estado === 'aprobado' && !esGerencia && (desde !== inicial.fecha_desde || hasta !== inicial.fecha_hasta)
          ? 'Cambios guardados. Como cambiaron las fechas, vuelve a aprobación.'
          : 'Novedad actualizada.'
        : general || (esGerencia && aprobar)
          ? 'Novedad cargada.'
          : 'Novedad cargada. Queda pendiente de aprobación de Gerencia.',
    )
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {TIPOS_CARGA.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTipo(t)}
            className={cx('rounded-full border px-3 py-1 text-xs font-medium transition', tipo === t ? 'text-white' : 'bg-white text-slate-600 hover:border-slate-400')}
            style={tipo === t ? { background: TIPOS[t].color, borderColor: TIPOS[t].color } : { borderColor: '#cbd5e1' }}
          >
            {TIPOS[t].label}
          </button>
        ))}
      </div>
      <p className="text-xs text-slate-500">Los cumpleaños salen solos de la fecha de nacimiento de cada legajo, y los feriados nacionales ya están cargados.</p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Empleado" required={!general} className="sm:col-span-2">
          <select id="nov-emp" className={inputCls} value={emp} onChange={(e) => setEmp(e.target.value)}>
            <option value="">{general ? 'Todo el personal' : '— Elegir —'}</option>
            {activos.map((e) => (
              <option key={e.id} value={e.id}>
                {e.apellido}, {e.nombre}
                {e.puesto ? ` · ${e.puesto}` : ''}
              </option>
            ))}
          </select>
        </Field>
        {(general || tipo === 'permiso') && (
          <Field label={tipo === 'permiso' ? 'Motivo' : 'Título'} required={general} className="sm:col-span-2">
            <input
              id="nov-titulo"
              className={inputCls}
              value={titulo}
              onChange={(e) => setTitulo(e.target.value)}
              placeholder={tipo === 'reunion' ? 'Reunión de seguridad e higiene' : tipo === 'feriado' ? 'Asueto día del metalúrgico' : tipo === 'permiso' ? 'Trámite personal, examen…' : ''}
            />
          </Field>
        )}
        <Field label="Desde" required>
          <input
            id="nov-desde"
            className={inputCls}
            type="date"
            value={desde}
            onChange={(e) => {
              setDesde(e.target.value)
              if (hasta < e.target.value) setHasta(e.target.value)
            }}
          />
        </Field>
        <Field label="Hasta" required>
          <input id="nov-hasta" className={inputCls} type="date" value={hasta} min={desde} onChange={(e) => setHasta(e.target.value)} />
        </Field>
        {(tipo === 'reunion' || tipo === 'permiso') && (
          <Field label="Horario">
            <input id="nov-hora" className={inputCls} value={hora} onChange={(e) => setHora(e.target.value)} placeholder="09:00 a 10:30" />
          </Field>
        )}
        <Field label="Observaciones" className={tipo === 'reunion' || tipo === 'permiso' ? '' : 'sm:col-span-2'}>
          <input id="nov-obs" className={inputCls} value={obs} onChange={(e) => setObs(e.target.value)} placeholder={tipo === 'licencia' ? 'Ej: certificado presentado' : ''} />
        </Field>
      </div>

      {dias > 0 && (
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
          <b>{dias}</b> {dias === 1 ? 'día corrido' : 'días corridos'} · {habiles} {habiles === 1 ? 'hábil' : 'hábiles'}
          {saldo && (
            <span className="ml-2 text-slate-600">
              · saldo de vacaciones {anio}: <b className={saldo.saldo - dias < 0 ? 'text-red-700' : ''}>{saldo.saldo}</b> de {saldo.asignados} días
              {saldo.solicitados > 0 && ` (${saldo.solicitados} ya pedidos)`}
            </span>
          )}
        </div>
      )}
      {tipo === 'licencia' && <Alert tone="blue">No cargues diagnósticos ni datos de salud: alcanza con el período y si presentó certificado. En el calendario se muestra solo &quot;Licencia&quot;.</Alert>}
      {tipo === 'vacaciones' && desde && diaSemana(desde) !== 1 && (
        <Alert tone="amber">Por LCT (art. 151) las vacaciones deben empezar un lunes o el día hábil siguiente si es feriado. Revisá la fecha de inicio.</Alert>
      )}
      {saldo && dias > saldo.saldo - saldo.solicitados && (
        <Alert tone="amber">
          Pide {dias} días y le quedan {Math.max(0, saldo.saldo - saldo.solicitados)} disponibles en {anio}. Se puede cargar igual, pero Gerencia lo va a ver al aprobar.
        </Alert>
      )}
      {superpone.length > 0 && (
        <Alert tone="amber">
          Se superpone con: {superpone.map((n) => `${TIPOS[n.tipo].label} ${fmtFecha(n.fecha_desde)}–${fmtFecha(n.fecha_hasta)}`).join(', ')}.
        </Alert>
      )}
      {!inicial && esGerencia && !general && (
        <label className="flex items-center gap-2 text-sm">
          <input id="nov-aprobar" type="checkbox" className="h-4 w-4 accent-brand-700" checked={aprobar} onChange={(e) => setAprobar(e.target.checked)} />
          Cargar ya aprobada
        </label>
      )}
      {error && <Alert tone="red">{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? 'Guardando…' : inicial ? 'Guardar cambios' : 'Cargar novedad'}
        </Button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------
// Calendario anual (12 meses)
// ---------------------------------------------------------------------
const ORDEN_TIPOS = ['feriado_nac', 'feriado', 'vacaciones', 'licencia', 'permiso', 'reunion', 'cumple', 'otro'] as const

export function CalendarioAnual({
  anio,
  porDia,
  seleccionado,
  onDia,
}: {
  anio: number
  porDia: Map<string, Evento[]>
  seleccionado: string | null
  onDia: (f: string) => void
}) {
  const ref = hoy()
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
      {MESES.map((nombre, m) => {
        const celdas = celdasMes(anio, m)
        const nEventos = new Set(celdas.flatMap((f) => (f ? (porDia.get(f) ?? []).filter((e) => e.tipo !== 'feriado_nac').map((e) => e.id) : []))).size
        return (
          <section key={m} className="min-w-0 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
            <header className="mb-2 flex items-baseline justify-between">
              <h3 className="text-sm font-semibold text-slate-900">{nombre}</h3>
              {nEventos > 0 && <span className="text-xs text-slate-500">{nEventos} {nEventos === 1 ? 'evento' : 'eventos'}</span>}
            </header>
            <div className="grid grid-cols-7 gap-0.5 text-center text-[11px]">
              {['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((d, i) => (
                <div key={i} className="pb-1 font-medium text-slate-400">
                  {d}
                </div>
              ))}
              {celdas.map((f, i) => {
                if (!f) return <div key={i} />
                const evs = porDia.get(f) ?? []
                const fer = evs.find((e) => e.tipo === 'feriado_nac' || e.tipo === 'feriado')
                const finde = diaSemana(f) === 0 || diaSemana(f) === 6
                const tipos = ORDEN_TIPOS.filter((t) => t !== 'feriado_nac' && t !== 'feriado' && evs.some((e) => e.tipo === t))
                const pendiente = evs.some((e) => e.estado === 'pendiente')
                const titulo = evs.map((e) => `${e.titulo}${e.estado === 'pendiente' ? ' (pendiente)' : ''}`).join('\n')
                return (
                  <button
                    key={f}
                    type="button"
                    onClick={() => onDia(f)}
                    title={titulo ? `${fmtFecha(f)}\n${titulo}` : fmtFecha(f)}
                    aria-label={`${fmtFecha(f)}${titulo ? `: ${titulo.replace(/\n/g, ', ')}` : ''}`}
                    className={cx(
                      'relative flex aspect-square flex-col items-center justify-start rounded-md pt-0.5 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600',
                      fer ? 'bg-red-50 font-semibold text-red-700' : finde ? 'bg-slate-50 text-slate-400' : 'text-slate-700 hover:bg-brand-50',
                      seleccionado === f && 'ring-2 ring-brand-600',
                      f === ref && 'font-bold underline decoration-2 underline-offset-2',
                    )}
                  >
                    <span className="leading-5">{Number(f.slice(8))}</span>
                    {tipos.length > 0 && (
                      <span className="absolute bottom-0.5 flex gap-px">
                        {tipos.slice(0, 4).map((t) => (
                          <span
                            key={t}
                            className="h-1.5 w-1.5 rounded-full"
                            style={pendiente && evs.filter((e) => e.tipo === t).every((e) => e.estado === 'pendiente') ? { boxShadow: `inset 0 0 0 1.5px ${TIPOS[t].color}` } : { background: TIPOS[t].color }}
                          />
                        ))}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}

export function ListaEventosDia({ fecha, eventos }: { fecha: string; eventos: Evento[] }) {
  if (!eventos.length) return <p className="px-4 py-6 text-center text-sm text-slate-500">Sin eventos el {fmtFecha(fecha)}.</p>
  return (
    <ul className="divide-y divide-slate-100">
      {eventos.map((e) => (
        <li key={e.id} className="flex flex-wrap items-start justify-between gap-2 px-4 py-2.5">
          <div className="min-w-0">
            <Etiqueta tipo={e.tipo} />
            <div className="mt-1 text-sm font-medium text-slate-900">{e.titulo}</div>
            <div className="text-xs text-slate-500">
              {e.desde === e.hasta ? fmtFecha(e.desde) : `${fmtFecha(e.desde)} al ${fmtFecha(e.hasta)}`}
              {e.hora ? ` · ${e.hora}` : ''}
              {e.estado === 'pendiente' && <span className="ml-1 font-medium text-amber-700">· pendiente de aprobación</span>}
            </div>
          </div>
          <a href={linkGoogle(e)} target="_blank" rel="noreferrer" className="shrink-0 text-xs font-medium text-brand-700 hover:underline">
            + Google Calendar
          </a>
        </li>
      ))}
    </ul>
  )
}

export { nombreEmp }
