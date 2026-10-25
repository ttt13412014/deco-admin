'use client'

import { ChangeEvent, ReactNode, useEffect, useMemo, useState } from 'react'
import { sb, errMsg } from '@/lib/supabase'
import { fmtFecha, fmtMoney } from '@/lib/utils'
import { normTxt } from '@/lib/tesoreria'
import {
  Campo, ClienteRef, Coincidencia, Fila, buscarCliente, claveObligacion, detectarCabecera, detectarColumnas, extraerFilas, fecha, leerPlanilla, num,
  separarComprobante, soloDig, txt,
} from '@/lib/importar'
import { Alert, Badge, Button, Field, compactCls, cx } from './ui'

// ---------------------------------------------------------------------
// Paso 1: archivo → columnas → filas
// ---------------------------------------------------------------------
export function LectorPlanilla({ campos, children }: { campos: Campo[]; children: (filas: Fila[], archivo: string) => ReactNode }) {
  const [rows, setRows] = useState<unknown[][] | null>(null)
  const [cab, setCab] = useState(0)
  const [map, setMap] = useState<Record<string, number | undefined>>({})
  const [archivo, setArchivo] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    setError(null)
    try {
      const r = await leerPlanilla(f)
      if (!r.length) throw new Error('La planilla está vacía.')
      const h = detectarCabecera(r, campos)
      setRows(r)
      setCab(h)
      setMap(detectarColumnas(r[h] ?? [], campos))
      setArchivo(f.name)
    } catch (err) {
      setError('No pude leer el archivo. Exportalo de Sintesys como Excel (.xlsx o .xls) o CSV. ' + errMsg(err))
    }
  }

  const filas = useMemo(() => (rows ? extraerFilas(rows, cab, map) : []), [rows, cab, map])
  const faltan = campos.filter((c) => c.requerido && map[c.k] === undefined)
  const cabecera = rows?.[cab] ?? []

  return (
    <div className="space-y-4">
      <input id="imp-file" type="file" accept=".xlsx,.xls,.csv,.txt" onChange={onFile} className="block w-full text-sm" />
      {error && <Alert tone="red">{error}</Alert>}
      {rows && (
        <>
          <details open={faltan.length > 0} className="rounded-lg border border-slate-200 p-3">
            <summary className="cursor-pointer text-sm font-medium">
              Columnas del archivo {faltan.length ? <span className="text-red-600">· falta elegir {faltan.map((f) => f.label).join(', ')}</span> : <span className="text-emerald-700">· reconocidas</span>}
            </summary>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              <Field label="Fila de títulos">
                <select className={compactCls} value={cab} onChange={(e) => (setCab(Number(e.target.value)), setMap(detectarColumnas(rows[Number(e.target.value)] ?? [], campos)))}>
                  {rows.slice(0, 25).map((r, i) => (
                    <option key={i} value={i}>
                      {i + 1}: {r.slice(0, 3).map(String).join(' · ').slice(0, 32)}
                    </option>
                  ))}
                </select>
              </Field>
              {campos.map((c) => (
                <Field key={c.k} label={c.label} required={c.requerido} hint={c.ayuda}>
                  <select id={`col-${c.k}`} className={compactCls} value={map[c.k] ?? ''} onChange={(e) => setMap({ ...map, [c.k]: e.target.value === '' ? undefined : Number(e.target.value) })}>
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
          </details>
          {faltan.length === 0 && children(filas, archivo)}
        </>
      )}
    </div>
  )
}

type Resultado = { nuevas: number; actualizadas: number; sin_cambios: number; saldadas: number; errores: { fila: number; comprobante: string; error: string }[] }

function ResultadoImportacion({ r }: { r: Resultado }) {
  return (
    <Alert tone={r.errores.length ? 'amber' : 'green'}>
      <div>
        <b>{r.nuevas}</b> nuevas · <b>{r.actualizadas}</b> actualizadas · <b>{r.sin_cambios}</b> sin cambios
        {r.saldadas ? ` · ${r.saldadas} saldadas (no se cargan)` : ''}.
      </div>
      {r.errores.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-xs">
          {r.errores.slice(0, 20).map((e, i) => (
            <li key={i}>
              Fila {e.fila} {e.comprobante}: {e.error}
            </li>
          ))}
        </ul>
      )}
    </Alert>
  )
}

// ---------------------------------------------------------------------
// Cuentas a cobrar (Sintesys)
// ---------------------------------------------------------------------
export const CAMPOS_COBRAR: Campo[] = [
  { k: 'cliente', label: 'Cliente', claves: /cliente|razonsocial|nombre|denominacion/, requerido: true },
  { k: 'cuit', label: 'CUIT', claves: /cuit|cuil|documento|nrodoc/ },
  { k: 'tipo', label: 'Tipo de comprobante', claves: /^tipo|^tipocomp|^tcomp/, ayuda: 'Si viene junto con el número, dejalo vacío' },
  { k: 'numero', label: 'Número / Comprobante', claves: /^numero|^nro|comprobante|^comp/, requerido: true },
  { k: 'emision', label: 'Fecha de emisión', claves: /emision|^fecha$|fechacomp|fechafac/ },
  { k: 'vencimiento', label: 'Vencimiento', claves: /venc/ },
  { k: 'importe', label: 'Importe original', claves: /^importe|^total|^monto|original/, requerido: true },
  { k: 'saldo', label: 'Saldo pendiente', claves: /saldo|pendiente|adeudado/ },
  { k: 'vendedor', label: 'Vendedor', claves: /vendedor|vend/ },
]

type FilaCobrar = { fila: number; nombre: string; cuit: string; tipo: string; numero: string; emision: string | null; venc: string | null; importe: number | null; saldo: number | null; negativo: boolean; vendedor: string; error?: string }

export function ImportarCobrar({ onDone, onCancel }: { onDone: (msg: string) => void; onCancel: () => void }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        Exportá de Sintesys el listado de <b>comprobantes pendientes de cobro</b> (cuentas corrientes de clientes) en Excel y subilo acá. Revisás antes de confirmar. Si lo
        volvés a subir actualizado, no se duplica nada: se actualizan saldo y vencimiento, y se conservan las gestiones.
      </p>
      <LectorPlanilla campos={CAMPOS_COBRAR}>{(filas, archivo) => <PreviaCobrar filas={filas} archivo={archivo} onDone={onDone} onCancel={onCancel} />}</LectorPlanilla>
    </div>
  )
}

function PreviaCobrar({ filas, archivo, onDone, onCancel }: { filas: Fila[]; archivo: string; onDone: (m: string) => void; onCancel: () => void }) {
  const [clientes, setClientes] = useState<ClienteRef[] | null>(null)
  const [existentes, setExistentes] = useState<Map<string, { saldo: number; saldo_sintesys: number | null; fecha_vencimiento: string }>>(new Map())
  const [eleccion, setEleccion] = useState<Record<string, string>>({}) // nombre normalizado → cliente_id | 'nuevo'
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<Resultado | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    ;(async () => {
      const s = sb()
      const [c, f] = await Promise.all([
        s.from('clientes').select('id,razon_social,cuit_dni').limit(5000),
        s.from('facturas').select('tipo_comprobante,numero,saldo,saldo_sintesys,fecha_vencimiento').limit(20000),
      ])
      setClientes((c.data as ClienteRef[]) ?? [])
      setExistentes(new Map(((f.data as { tipo_comprobante: string; numero: string; saldo: number; saldo_sintesys: number | null; fecha_vencimiento: string }[]) ?? []).map((x) => [`${x.tipo_comprobante}|${x.numero}`, x])))
    })()
  }, [])

  const datos = useMemo<FilaCobrar[]>(
    () =>
      filas.map((f) => {
        const comp = f.tipo !== undefined && txt(f.tipo) ? { tipo: txt(f.tipo), numero: txt(f.numero) } : separarComprobante(txt(f.numero))
        const importe = num(f.importe)
        const saldo = f.saldo !== undefined && txt(f.saldo) !== '' ? num(f.saldo) : importe
        const r: FilaCobrar = {
          fila: f._fila,
          nombre: txt(f.cliente),
          cuit: soloDig(f.cuit),
          tipo: comp.tipo,
          numero: comp.numero,
          emision: fecha(f.emision),
          venc: fecha(f.vencimiento),
          importe: importe === null ? null : Math.abs(importe),
          saldo: saldo === null ? null : Math.abs(saldo),
          // Sintesys exporta las notas de crédito con importe negativo: se guardan positivas y la base las clasifica como NC
          negativo: (importe ?? 0) < 0,
          vendedor: txt(f.vendedor),
        }
        if (!r.nombre) r.error = 'sin cliente'
        else if (!r.numero) r.error = 'sin número'
        else if (!r.importe) r.error = 'sin importe'
        return r
      }),
    [filas],
  )

  const coincidencias = useMemo(() => {
    const m = new Map<string, { nombre: string; cuit: string; c: Coincidencia; n: number }>()
    if (!clientes) return m
    for (const d of datos) {
      if (d.error) continue
      const k = d.cuit || normTxt(d.nombre)
      const x = m.get(k)
      if (x) x.n++
      else m.set(k, { nombre: d.nombre, cuit: d.cuit, c: buscarCliente(d.nombre, d.cuit, clientes), n: 1 })
    }
    return m
  }, [datos, clientes])

  if (!clientes) return <p className="text-sm text-slate-500">Revisando clientes y comprobantes existentes…</p>

  const validas = datos.filter((d) => !d.error)
  const estado = (d: FilaCobrar) => {
    const e = existentes.get(`${d.tipo}|${d.numero}`)
    if (!e) return (d.saldo ?? 0) <= 0 ? 'saldada' : 'nueva'
    return Number(e.saldo_sintesys ?? NaN) === d.saldo && e.fecha_vencimiento === (d.venc ?? e.fecha_vencimiento) ? 'igual' : 'actualiza'
  }
  const cuenta = { nueva: 0, actualiza: 0, igual: 0, saldada: 0 } as Record<string, number>
  validas.forEach((d) => cuenta[estado(d)]++)
  const dudosos = Array.from(coincidencias.entries()).filter(([, v]) => v.c.tipo === 'parecido' || v.c.tipo === 'nuevo')
  const conDif = validas.filter((d) => {
    const e = existentes.get(`${d.tipo}|${d.numero}`)
    return e && d.saldo !== null && Math.abs(Number(e.saldo) - d.saldo) > 0.004
  })

  async function confirmar() {
    setBusy(true)
    setError(null)
    const payload = validas.map((d) => {
      const k = d.cuit || normTxt(d.nombre)
      const co = coincidencias.get(k)!
      const el = eleccion[k] ?? (co.c.cliente ? co.c.cliente.id : 'nuevo')
      return {
        fila: d.fila,
        tipo_comprobante: d.tipo,
        numero: d.numero,
        fecha_emision: d.emision,
        fecha_vencimiento: d.venc,
        monto: d.importe,
        saldo: d.saldo,
        negativo: d.negativo,
        vendedor: d.vendedor || null,
        cliente_id: el === 'nuevo' ? null : el,
        cliente_nuevo: { razon_social: d.nombre, cuit: d.cuit },
      }
    })
    try {
      let tot: Resultado = { nuevas: 0, actualizadas: 0, sin_cambios: 0, saldadas: 0, errores: [] }
      for (let i = 0; i < payload.length; i += 400) {
        const { data, error } = await sb().rpc('cob_importar_sintesys', { p_filas: payload.slice(i, i + 400), p_archivo: archivo })
        if (error) throw error
        const r = data as Resultado
        tot = { nuevas: tot.nuevas + r.nuevas, actualizadas: tot.actualizadas + r.actualizadas, sin_cambios: tot.sin_cambios + r.sin_cambios, saldadas: tot.saldadas + (r.saldadas ?? 0), errores: [...tot.errores, ...r.errores] }
      }
      setRes(tot)
      if (!tot.errores.length) onDone(`Importación lista: ${tot.nuevas} nuevas, ${tot.actualizadas} actualizadas, ${tot.sin_cambios} sin cambios.`)
    } catch (e) {
      setError(errMsg(e))
    }
    setBusy(false)
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 text-sm">
        <Badge tone="green">{cuenta.nueva} nuevas</Badge>
        <Badge tone="blue">{cuenta.actualiza} se actualizan</Badge>
        <Badge tone="slate">{cuenta.igual} sin cambios</Badge>
        {cuenta.saldada > 0 && <Badge tone="slate">{cuenta.saldada} saldadas (se saltean)</Badge>}
        {datos.length - validas.length > 0 && <Badge tone="red">{datos.length - validas.length} con error</Badge>}
      </div>
      {conDif.length > 0 && (
        <Alert tone="amber">
          {conDif.length} comprobantes tienen en Sintesys un saldo distinto al de la app. No se cambia solo: después de importar los vas a ver marcados en Cobranzas para registrar el cobro o ajustarlo con motivo.
        </Alert>
      )}
      {dudosos.length > 0 && (
        <div className="rounded-lg border border-slate-200">
          <div className="border-b border-slate-100 px-3 py-2 text-sm font-medium">Clientes para revisar ({dudosos.length})</div>
          <ul className="max-h-56 divide-y divide-slate-100 overflow-y-auto">
            {dudosos.map(([k, v]) => (
              <li key={k} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <b>{v.nombre}</b> {v.cuit && <span className="text-xs text-slate-500">{v.cuit}</span>}
                  <span className="text-xs text-slate-500"> · {v.n} comp.</span>
                  {v.c.tipo === 'parecido' && <span className="block text-xs text-amber-700">Parecido a {v.c.cliente?.razon_social} ({Math.round(v.c.score * 100)}%)</span>}
                </span>
                <select className={compactCls} value={eleccion[k] ?? (v.c.cliente ? v.c.cliente.id : 'nuevo')} onChange={(e) => setEleccion({ ...eleccion, [k]: e.target.value })} aria-label={`Cliente para ${v.nombre}`}>
                  <option value="nuevo">Crear cliente nuevo (pendiente)</option>
                  {v.c.cliente && <option value={v.c.cliente.id}>Es {v.c.cliente.razon_social}</option>}
                  {clientes
                    .filter((c) => c.id !== v.c.cliente?.id)
                    .slice(0, 400)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.razon_social}
                      </option>
                    ))}
                </select>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="max-h-64 overflow-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <tbody>
            {datos.slice(0, 60).map((d) => {
              const est = d.error ? 'error' : estado(d)
              return (
                <tr key={d.fila} className={cx('border-b border-slate-100', d.error && 'text-red-700')}>
                  <td className="px-2 py-1 text-xs text-slate-400">{d.fila}</td>
                  <td className="px-2 py-1">{d.nombre}</td>
                  <td className="whitespace-nowrap px-2 py-1">
                    {d.tipo} {d.numero}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1">{d.venc ? fmtFecha(d.venc) : '—'}</td>
                  <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums">{d.saldo !== null ? fmtMoney(d.saldo) : ''}</td>
                  <td className="px-2 py-1 text-xs">{d.error ?? ({ nueva: 'Nueva', actualiza: 'Actualiza', igual: 'Igual', saldada: 'Saldada' } as Record<string, string>)[est]}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {datos.length > 60 && <p className="text-xs text-slate-500">Se muestran las primeras 60 de {datos.length}.</p>}
      {error && <Alert tone="red">{error}</Alert>}
      {res && <ResultadoImportacion r={res} />}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          {res ? 'Cerrar' : 'Cancelar'}
        </Button>
        {!res && (
          <Button onClick={confirmar} disabled={busy || !validas.length}>
            {busy ? 'Importando…' : `Confirmar ${validas.length} comprobantes`}
          </Button>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// Cuentas a pagar (Sintesys)
// ---------------------------------------------------------------------
export const CAMPOS_PAGAR: Campo[] = [
  { k: 'proveedor', label: 'Proveedor', claves: /proveedor|razonsocial|nombre|acreedor|denominacion/, requerido: true },
  { k: 'cuit', label: 'CUIT', claves: /cuit|cuil|documento/ },
  { k: 'comprobante', label: 'Comprobante', claves: /comprobante|^numero|^nro|^comp|factura/, requerido: true },
  { k: 'concepto', label: 'Concepto / detalle', claves: /concepto|detalle|descrip|observ/ },
  { k: 'emision', label: 'Fecha de emisión', claves: /emision|^fecha$|fechacomp/ },
  { k: 'vencimiento', label: 'Vencimiento', claves: /venc/ },
  { k: 'importe', label: 'Importe original', claves: /^importe|^total|^monto|original/, requerido: true },
  { k: 'saldo', label: 'Saldo pendiente', claves: /saldo|pendiente|adeudado/ },
]

export function ImportarPagar({ onDone, onCancel }: { onDone: (msg: string) => void; onCancel: () => void }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        Exportá de Sintesys las <b>cuentas a pagar / comprobantes de proveedores pendientes</b> en Excel. Entran como <i>Pendiente de revisión</i>. Si lo volvés a subir, no se
        duplica: se actualizan saldo y vencimiento.
      </p>
      <LectorPlanilla campos={CAMPOS_PAGAR}>{(filas, archivo) => <PreviaPagar filas={filas} archivo={archivo} onDone={onDone} onCancel={onCancel} />}</LectorPlanilla>
    </div>
  )
}

function PreviaPagar({ filas, archivo, onDone, onCancel }: { filas: Fila[]; archivo: string; onDone: (m: string) => void; onCancel: () => void }) {
  const [claves, setClaves] = useState<Set<string> | null>(null)
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<Resultado | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    sb()
      .from('pag_obligaciones')
      .select('clave')
      .not('clave', 'is', null)
      .limit(20000)
      .then(({ data }: { data: { clave: string }[] | null }) => setClaves(new Set((data ?? []).map((x) => x.clave))))
  }, [])

  const datos = useMemo(
    () =>
      filas.map((f) => {
        const importe = num(f.importe)
        const saldo = f.saldo !== undefined && txt(f.saldo) !== '' ? num(f.saldo) : importe
        const d = {
          fila: f._fila,
          proveedor: txt(f.proveedor),
          cuit: soloDig(f.cuit),
          comprobante: txt(f.comprobante),
          concepto: txt(f.concepto),
          emision: fecha(f.emision),
          venc: fecha(f.vencimiento),
          importe: importe === null ? null : Math.abs(importe),
          saldo: saldo === null ? null : Math.abs(saldo),
          clave: '',
          error: undefined as string | undefined,
        }
        d.clave = claveObligacion(d.proveedor, d.cuit, d.comprobante)
        if (!d.proveedor) d.error = 'sin proveedor'
        else if (!d.comprobante) d.error = 'sin comprobante'
        else if (!d.importe) d.error = 'sin importe'
        return d
      }),
    [filas],
  )
  if (!claves) return <p className="text-sm text-slate-500">Revisando lo que ya está cargado…</p>
  const validas = datos.filter((d) => !d.error)
  const nuevas = validas.filter((d) => !claves.has(d.clave) && (d.saldo ?? 0) > 0)
  const ya = validas.filter((d) => claves.has(d.clave))

  async function confirmar() {
    setBusy(true)
    setError(null)
    try {
      const payload = validas.map((d) => ({ fila: d.fila, clave: d.clave, proveedor: d.proveedor, cuit: d.cuit, comprobante: d.comprobante, concepto: d.concepto || null, fecha_emision: d.emision, vencimiento: d.venc, importe: d.importe, saldo: d.saldo }))
      let tot: Resultado = { nuevas: 0, actualizadas: 0, sin_cambios: 0, saldadas: 0, errores: [] }
      for (let i = 0; i < payload.length; i += 400) {
        const { data, error } = await sb().rpc('pag_importar_sintesys', { p_filas: payload.slice(i, i + 400), p_archivo: archivo })
        if (error) throw error
        const r = data as Resultado
        tot = { nuevas: tot.nuevas + r.nuevas, actualizadas: tot.actualizadas + r.actualizadas, sin_cambios: tot.sin_cambios + r.sin_cambios, saldadas: tot.saldadas + (r.saldadas ?? 0), errores: [...tot.errores, ...r.errores] }
      }
      setRes(tot)
      if (!tot.errores.length) onDone(`Importación lista: ${tot.nuevas} nuevas, ${tot.actualizadas} actualizadas, ${tot.sin_cambios} sin cambios.`)
    } catch (e) {
      setError(errMsg(e))
    }
    setBusy(false)
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 text-sm">
        <Badge tone="green">{nuevas.length} nuevas</Badge>
        <Badge tone="blue">{ya.length} ya cargadas (se actualizan)</Badge>
        {datos.length - validas.length > 0 && <Badge tone="red">{datos.length - validas.length} con error</Badge>}
      </div>
      <div className="max-h-64 overflow-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <tbody>
            {datos.slice(0, 60).map((d) => (
              <tr key={d.fila} className={cx('border-b border-slate-100', d.error && 'text-red-700')}>
                <td className="px-2 py-1 text-xs text-slate-400">{d.fila}</td>
                <td className="px-2 py-1">{d.proveedor}</td>
                <td className="whitespace-nowrap px-2 py-1">{d.comprobante}</td>
                <td className="whitespace-nowrap px-2 py-1">{d.venc ? fmtFecha(d.venc) : '—'}</td>
                <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums">{d.saldo !== null ? fmtMoney(d.saldo) : ''}</td>
                <td className="px-2 py-1 text-xs">{d.error ?? (claves.has(d.clave) ? 'Ya cargada' : (d.saldo ?? 0) <= 0 ? 'Saldada' : 'Nueva')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <Alert tone="red">{error}</Alert>}
      {res && <ResultadoImportacion r={res} />}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          {res ? 'Cerrar' : 'Cancelar'}
        </Button>
        {!res && (
          <Button onClick={confirmar} disabled={busy || !validas.length}>
            {busy ? 'Importando…' : `Confirmar ${validas.length} comprobantes`}
          </Button>
        )}
      </div>
    </div>
  )
}
