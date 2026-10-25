'use client'

import { useState } from 'react'
import { sb, errMsg } from '@/lib/supabase'
import { faltantesCliente, soloDigitos, validarCuitDni } from '@/lib/utils'
import { normalizarUbicacion } from '@/lib/rutas'
import { aMin, camposDeVentanas, deMin, parsearHorarios } from '@/lib/horarios'
import { Alert, Button, td, th } from './ui'
import { useAuth } from './AuthProvider'

const normH = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '')

const normNombre = (s: string) =>
  (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '')

const ALIAS: Record<string, string> = {
  razonsocial: 'razon_social', nombre: 'razon_social', cliente: 'razon_social', nombrecompleto: 'razon_social', razon: 'razon_social',
  cuit: 'cuit_dni', dni: 'cuit_dni', cuitdni: 'cuit_dni', cuitodni: 'cuit_dni', documento: 'cuit_dni',
  condicioniva: 'condicion_iva', iva: 'condicion_iva', condicionfrentealiva: 'condicion_iva',
  tipofactura: 'tipo_factura', factura: 'tipo_factura', formatodefacturacion: 'tipo_factura',
  contacto: 'contacto_nombre', nombrecontacto: 'contacto_nombre', nombredecontacto: 'contacto_nombre',
  telefono: 'telefono', tel: 'telefono', celular: 'telefono', whatsapp: 'telefono',
  email: 'email', mail: 'email', correo: 'email',
  direccion: 'direccion', domicilio: 'direccion', direccioncompleta: 'direccion', calle: 'direccion', domiciliodeentrega: 'direccion',
  localidad: 'localidad', ciudad: 'localidad',
  provincia: 'provincia',
  ubicacion: 'ubicacion', coordenadas: 'ubicacion', maps: 'ubicacion', linkmaps: 'ubicacion', ubicacionmaps: 'ubicacion', googlemaps: 'ubicacion', latlng: 'ubicacion',
  horarios: 'horarios', horario: 'horarios', horariosdeatencion: 'horarios',
  abre: 'horario_desde', apertura: 'horario_desde', horariodesde: 'horario_desde', desde: 'horario_desde',
  cierra: 'horario_hasta', cierre: 'horario_hasta', horariohasta: 'horario_hasta', hasta: 'horario_hasta',
  mediopago: 'medio_pago_preferido', mediodepago: 'medio_pago_preferido', mediopagopreferido: 'medio_pago_preferido',
  observaciones: 'observaciones', obs: 'observaciones',
}

/** Campos que se completan en clientes ya existentes (solo si vienen con dato). */
const ACTUALIZABLES = [
  'direccion', 'localidad', 'provincia', 'ubicacion', 'telefono', 'contacto_nombre', 'email', 'horarios',
  'horario_desde', 'horario_hasta', 'horario2_desde', 'horario2_hasta',
]

/** "14", "14:00", "14.30" o una hora de Excel (0,5833) → "14:00". */
function hora(v: string | null | undefined): string | null {
  const t = String(v ?? '').trim().replace('.', ':').replace(/\s*hs?$/i, '')
  if (!t) return null
  const n = Number(t.replace(',', '.'))
  if (Number.isFinite(n) && n > 0 && n < 1) return deMin(Math.round(n * 24 * 60))
  const m = aMin(t)
  return m == null ? null : deMin(m)
}

function condIva(v: string): string | null {
  const n = normH(v)
  if (!n) return null
  if (n.includes('inscrip') || n === 'ri') return 'Responsable Inscripto'
  if (n.includes('mono')) return 'Monotributista'
  if (n.includes('exent')) return 'Exento'
  if (n.includes('consum') || n === 'cf') return 'Consumidor Final'
  return null
}

function tipoFact(v: string): string | null {
  if (/presup/i.test(String(v)) || /^\s*(p|x)\s*$/i.test(String(v))) return 'Presupuesto'
  const m = String(v).toUpperCase().match(/\b([ABE])\b|^([ABE])$/)
  return m ? m[1] || m[2] : null
}

type Fila = Record<string, string | null> & { _error?: string; _completo?: boolean; _existe?: string }

const PLANTILLA = [
  {
    'Razón social': 'Metalúrgica Ejemplo SA',
    CUIT: '30-71234567-1',
    'Condición IVA': 'Responsable Inscripto',
    'Tipo factura': 'A', // A, B, E o Presupuesto
    Contacto: 'Juan Pérez',
    Teléfono: '351 555-1234',
    Email: 'compras@ejemplo.com',
    Dirección: 'Av. Colón 1234',
    Localidad: 'Córdoba',
    Provincia: 'Córdoba',
    Ubicación: '',
    Horarios: 'Lun a Vie 8 a 17',
    'Medio de pago': 'Transferencia',
    Observaciones: '',
  },
]

type Existente = { id: string; cuit_dni: string | null; razon_social: string }

export function ImportarClientes({ onDone }: { onDone: (resumen: string) => void }) {
  const [filas, setFilas] = useState<Fila[] | null>(null)
  const { puedeEditar } = useAuth()
  const [habilitarCompletos, setHabilitarCompletos] = useState(false)
  const [actualizar, setActualizar] = useState(true)
  const [busy, setBusy] = useState(false)
  const [progreso, setProgreso] = useState('')
  const [msg, setMsg] = useState<{ tone: 'red' | 'green' | 'amber'; text: string } | null>(null)

  async function descargarPlantilla() {
    const XLSX = await import('xlsx')
    const ws = XLSX.utils.json_to_sheet(PLANTILLA)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Clientes')
    XLSX.writeFile(wb, 'plantilla_clientes_DECO.xlsx')
  }

  async function leer(file: File) {
    setMsg(null)
    const XLSX = await import('xlsx')
    const wb = XLSX.read(await file.arrayBuffer())
    const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false })

    const { data: ex, error } = await sb().from('clientes').select('id,cuit_dni,razon_social')
    if (error) return setMsg({ tone: 'red', text: errMsg(error) })
    const porCuit = new Map<string, string>()
    const porNombre = new Map<string, string>()
    for (const c of (ex as Existente[]) ?? []) {
      if (c.cuit_dni) porCuit.set(c.cuit_dni, c.id)
      porNombre.set(normNombre(c.razon_social), c.id)
    }

    const out: Fila[] = []
    for (const r of raw) {
      const f: Fila = {}
      for (const [k, v] of Object.entries(r)) {
        const campo = ALIAS[normH(k)]
        if (campo && !f[campo]) f[campo] = String(v ?? '').trim() || null
      }
      if (!f.razon_social && !f.cuit_dni) continue
      f.condicion_iva = condIva(f.condicion_iva ?? '')
      f.tipo_factura = tipoFact(f.tipo_factura ?? '') ?? (f.condicion_iva === 'Responsable Inscripto' ? 'A' : f.condicion_iva ? 'B' : null)
      f.cuit_dni = soloDigitos(f.cuit_dni ?? '') || null
      if (f.ubicacion) f.ubicacion = normalizarUbicacion(f.ubicacion) || null
      // Horario para ordenar la ruta: columnas Abre/Cierra o, si no, leído del texto de Horarios
      f.horario_desde = hora(f.horario_desde)
      f.horario_hasta = hora(f.horario_hasta)
      if (!f.horario_desde && !f.horario_hasta) Object.assign(f, camposDeVentanas(parsearHorarios(f.horarios)))
      for (const k of ['horario_desde', 'horario_hasta', 'horario2_desde', 'horario2_hasta']) if (!f[k]) delete f[k]
      if (!f.razon_social) f._error = 'Falta razón social'
      else if (f.cuit_dni) {
        const v = validarCuitDni(f.cuit_dni)
        if (!v.ok) f._error = `CUIT/DNI: ${v.msg}`
      }
      f._existe = (f.cuit_dni && porCuit.get(f.cuit_dni)) || porNombre.get(normNombre(f.razon_social ?? '')) || undefined
      f._completo = faltantesCliente(f as never).length === 0
      out.push(f)
    }
    if (!out.length) setMsg({ tone: 'red', text: 'No encontré filas con razón social o CUIT. Revisá los encabezados (usá la plantilla).' })
    setFilas(out)
  }

  async function importar() {
    if (!filas) return
    setBusy(true)
    setMsg(null)
    const validas = filas.filter((f) => !f._error)
    const vistos = new Set<string>()
    const nuevos = validas
      .filter((f) => {
        if (f._existe) return false
        const k = f.cuit_dni || normNombre(f.razon_social ?? '')
        if (vistos.has(k)) return false
        vistos.add(k)
        return true
      })
      .map(({ _error, _completo, _existe, ...f }) => ({ ...f, estado: puedeEditar && habilitarCompletos && _completo ? 'activo' : 'pendiente' }))

    for (let i = 0; i < nuevos.length; i += 200) {
      setProgreso(`Creando clientes ${i + 1}–${Math.min(i + 200, nuevos.length)} de ${nuevos.length}…`)
      const { error } = await sb().from('clientes').insert(nuevos.slice(i, i + 200))
      if (error) {
        setBusy(false)
        setProgreso('')
        return setMsg({ tone: 'red', text: errMsg(error) })
      }
    }

    let actualizados = 0
    let errores = 0
    if (actualizar) {
      const upd = validas.filter((f) => f._existe)
      for (let i = 0; i < upd.length; i += 10) {
        setProgreso(`Actualizando direcciones ${i + 1}–${Math.min(i + 10, upd.length)} de ${upd.length}…`)
        const res = await Promise.all(
          upd.slice(i, i + 10).map((f) => {
            const cambios: Record<string, string> = {}
            for (const k of ACTUALIZABLES) if (f[k]) cambios[k] = f[k] as string
            if (!Object.keys(cambios).length) return Promise.resolve({ error: null, skip: true })
            return sb().from('clientes').update(cambios).eq('id', f._existe as string).then((r) => ({ error: r.error, skip: false }))
          }),
        )
        for (const r of res) if (r.error) errores++
        else if (!r.skip) actualizados++
      }
    }
    setBusy(false)
    setProgreso('')
    setFilas(null)
    const conError = filas.length - validas.length
    onDone(
      `Nuevos: ${nuevos.length}. ${actualizar ? `Existentes actualizados: ${actualizados}. ` : ''}Con error: ${conError + errores}.`,
    )
  }

  const existentes = filas?.filter((f) => f._existe && !f._error).length ?? 0
  const nuevosN = filas?.filter((f) => !f._existe && !f._error).length ?? 0

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Subí un Excel o CSV con una fila por cliente. Los encabezados se reconocen solos (Razón social, CUIT, Dirección, Localidad, Provincia, Ubicación, Teléfono,
        Contacto, Email, Horarios…). Del texto de Horarios (ej: “8 a 12 y 14 a 18”) se toma solo el horario para ordenar la ruta. El CUIT/DNI es opcional. En “Tipo factura” podés poner A, B, E o Presupuesto.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex cursor-pointer items-center rounded-lg bg-brand-700 px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-800">
          Elegir archivo…
          <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => e.target.files?.[0] && leer(e.target.files[0])} />
        </label>
        <Button variant="secondary" onClick={descargarPlantilla}>
          Descargar plantilla
        </Button>
      </div>

      {filas && filas.length > 0 && (
        <>
          <div className="max-h-72 overflow-auto rounded-lg border border-slate-200">
            <table className="w-full text-left text-xs">
              <thead>
                <tr>
                  <th className={th}>Razón social</th>
                  <th className={th}>CUIT/DNI</th>
                  <th className={th}>Dirección</th>
                  <th className={th}>Teléfono</th>
                  <th className={th}>Acción</th>
                </tr>
              </thead>
              <tbody>
                {filas.map((f, i) => (
                  <tr key={i} className={f._error ? 'bg-red-50' : ''}>
                    <td className={td}>{f.razon_social}</td>
                    <td className={td}>{f.cuit_dni ?? '—'}</td>
                    <td className={td}>{[f.direccion, f.localidad].filter(Boolean).join(', ') || (f.ubicacion ? `📍 ${f.ubicacion}` : <span className="text-amber-700">Sin dirección</span>)}</td>
                    <td className={td}>{f.telefono ?? '—'}</td>
                    <td className={td}>
                      {f._error ? (
                        <span className="text-red-700">{f._error}</span>
                      ) : f._existe ? (
                        <span className="text-sky-700">Ya existe → {actualizar ? 'actualizar' : 'omitir'}</span>
                      ) : (
                        <span className="text-emerald-700">Nuevo</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="space-y-2">
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-brand-700" checked={actualizar} onChange={(e) => setActualizar(e.target.checked)} />
              <span>
                Completar dirección, teléfono y contacto de los clientes que ya existen ({existentes})
                <span className="block text-xs text-slate-500">Solo pisa los campos que vienen con dato en el Excel. No toca CUIT, IVA ni estado.</span>
              </span>
            </label>
            {puedeEditar ? (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-brand-700" checked={habilitarCompletos} onChange={(e) => setHabilitarCompletos(e.target.checked)} />
              <span>
                Habilitar para facturación los nuevos que tienen todos los datos completos
                <span className="block text-xs text-slate-500">Si no, entran como <i>pendientes</i> y se validan uno por uno (A01). Para armar rutas no hace falta habilitarlos.</span>
              </span>
            </label>
            ) : (
              <p className="text-xs text-slate-500">Los clientes nuevos entran como <i>pendientes</i>; Administración los valida (A01). Para armar rutas no hace falta.</p>
            )}
          </div>
          {progreso && <Alert tone="blue">{progreso}</Alert>}
          <div className="flex justify-end">
            <Button onClick={importar} disabled={busy || nuevosN + (actualizar ? existentes : 0) === 0}>
              {busy ? 'Importando…' : `Importar (${nuevosN} nuevos${actualizar ? `, ${existentes} a actualizar` : ''})`}
            </Button>
          </div>
        </>
      )}
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
    </div>
  )
}
