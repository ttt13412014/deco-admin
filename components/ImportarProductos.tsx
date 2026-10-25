'use client'

import { useState } from 'react'
import { errMsg, sb } from '@/lib/supabase'
import { fmtMoney } from '@/lib/utils'
import { ENCABEZADOS, descargarPlantilla, leerArchivo, type Columna, type FilaImport } from '@/lib/catalogo'
import { Alert, Badge, Button, Table, cx, td, th } from './ui'

export function ImportarProductos({ onDone }: { onDone: (resumen: string) => void }) {
  const [filas, setFilas] = useState<FilaImport[] | null>(null)
  const [columnas, setColumnas] = useState<Columna[]>([])
  const [archivo, setArchivo] = useState('')
  const [ignoradas, setIgnoradas] = useState<string[]>([])
  const [respetarOrden, setRespetarOrden] = useState(true)
  const [busy, setBusy] = useState(false)
  const [progreso, setProgreso] = useState('')
  const [msg, setMsg] = useState<{ tone: 'red' | 'amber'; text: string } | null>(null)

  async function leer(file: File) {
    setMsg(null)
    setFilas(null)
    try {
      const r = await leerArchivo(file)
      if (!r.columnas.includes('codigo') || !r.columnas.includes('nombre')) {
        return setMsg({ tone: 'red', text: 'No encontré las columnas “codigo” y “nombre”. Revisá los encabezados (usá la plantilla).' })
      }
      if (!r.filas.length) return setMsg({ tone: 'red', text: 'El archivo no tiene filas con productos.' })
      const { data, error } = await sb().from('productos').select('codigo').not('codigo', 'is', null)
      if (error) throw error
      const existentes = new Set((data ?? []).map((x: { codigo: string }) => x.codigo))
      for (const f of r.filas) f.existe = existentes.has(f.codigo)
      // Si el Excel es casi todo nuevo (la carga inicial), se respeta su orden; si es una actualización, no se toca
      const ok = r.filas.filter((f) => !f.error)
      setRespetarOrden(ok.filter((f) => !f.existe).length >= ok.filter((f) => f.existe).length)
      setFilas(r.filas)
      setColumnas(r.columnas)
      setIgnoradas(r.ignoradas)
      setArchivo(file.name)
    } catch (e) {
      setMsg({ tone: 'red', text: errMsg(e) })
    }
  }

  const validas = filas?.filter((f) => !f.error) ?? []
  const nuevos = validas.filter((f) => !f.existe).length
  const actualizados = validas.length - nuevos
  const conError = (filas?.length ?? 0) - validas.length

  async function importar() {
    if (!validas.length) return
    setBusy(true)
    setMsg(null)
    // Solo se mandan las columnas que trae el archivo: lo demás (y la foto si viene vacía) no se toca
    const datos = validas.map((f, i) => {
      const d: Record<string, unknown> = { codigo: f.codigo, nombre: f.nombre }
      for (const c of columnas) {
        if (c === 'codigo' || c === 'nombre') continue
        if (c === 'imagen_url' && !f.imagen_url) continue
        d[c] = f[c]
      }
      if (respetarOrden) d.orden = (i + 1) * 10
      return d
    })
    // Cada tanda tiene que traer las mismas columnas (si no, el upsert pisaría la foto con vacío):
    // primero las filas con link de imagen y después las que no lo traen
    const tandas = [datos.filter((d) => 'imagen_url' in d), datos.filter((d) => !('imagen_url' in d))]
    let hechos = 0
    for (const tanda of tandas) {
      for (let i = 0; i < tanda.length; i += 200) {
        const lote = tanda.slice(i, i + 200)
        setProgreso(`Guardando productos ${hechos + 1}–${hechos + lote.length} de ${datos.length}…`)
        const { error } = await sb().from('productos').upsert(lote, { onConflict: 'codigo' })
        if (error) {
          setBusy(false)
          setProgreso('')
          return setMsg({ tone: 'red', text: errMsg(error) + (hechos ? ` (ya se habían guardado ${hechos})` : '') })
        }
        hechos += lote.length
      }
    }
    setBusy(false)
    setProgreso('')
    setFilas(null)
    onDone(`Importación lista: ${nuevos} productos nuevos y ${actualizados} actualizados.${conError ? ` ${conError} filas con error no se importaron.` : ''}`)
  }

  const conPrecio = columnas.includes('precio')
  const conSub = columnas.includes('subcategoria')

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Subí un Excel o CSV con una fila por producto y estas columnas: <b>{ENCABEZADOS.join(', ')}</b> (subrubro e imagen_url son opcionales). Si el código ya existe, el producto se
        actualiza; si no, se crea. Las columnas que no vengan en el archivo no se tocan, y si la imagen viene vacía se mantiene la foto que ya tenía.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex cursor-pointer items-center rounded-lg bg-brand-700 px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-800">
          Elegir archivo…
          <input
            type="file"
            accept=".xlsx,.xls,.csv,.ods"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) leer(file)
              e.target.value = ''
            }}
          />
        </label>
        <Button variant="secondary" onClick={descargarPlantilla}>
          Descargar plantilla
        </Button>
        {archivo && <span className="text-xs text-slate-500">{archivo}</span>}
      </div>

      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}

      {filas && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone="green">{nuevos} nuevos</Badge>
            <Badge tone="blue">{actualizados} se actualizan</Badge>
            {conError > 0 && <Badge tone="red">{conError} con error</Badge>}
            {ignoradas.length > 0 && <span className="text-xs text-slate-500">Columnas ignoradas: {ignoradas.join(', ')}</span>}
          </div>
          {!conSub && (
            <p className="text-xs text-slate-500">El archivo no trae la columna <b>subrubro</b>: cada producto que ya existe mantiene el sub rubro que tenía.</p>
          )}
          <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-slate-200">
            <Table>
              <thead className="sticky top-0">
                <tr>
                  <th className={th}>Fila</th>
                  <th className={th}>Código</th>
                  <th className={th}>Producto</th>
                  <th className={th}>Categoría</th>
                  {conSub && <th className={th}>Sub rubro</th>}
                  <th className={th}>Medida</th>
                  {conPrecio && <th className={`${th} text-right`}>Precio</th>}
                  <th className={th}>Foto</th>
                  <th className={th}></th>
                </tr>
              </thead>
              <tbody>
                {filas.map((f) => (
                  <tr key={f.fila} className={cx(f.error && 'bg-red-50/60')}>
                    <td className={`${td} text-xs text-slate-400`}>{f.fila}</td>
                    <td className={`${td} whitespace-nowrap font-mono text-xs`}>{f.codigo || '—'}</td>
                    <td className={`${td} min-w-[180px]`}>
                      <div className="font-medium text-slate-900">{f.nombre || '—'}</div>
                      {f.descripcion && <div className="text-xs text-slate-500">{f.descripcion}</div>}
                    </td>
                    <td className={`${td} text-xs`}>{f.categoria || '—'}</td>
                    {conSub && <td className={`${td} text-xs`}>{f.subcategoria || <span className="text-slate-400">—</span>}</td>}
                    <td className={`${td} text-xs`}>{f.medida || '—'}</td>
                    {conPrecio && <td className={`${td} whitespace-nowrap text-right tabular-nums`}>{f.precio != null ? fmtMoney(f.precio) : <span className="text-slate-400">—</span>}</td>}
                    <td className={`${td} text-xs`}>{f.imagen_url ? '✓ link' : <span className="text-slate-400">—</span>}</td>
                    <td className={`${td} whitespace-nowrap`}>
                      {f.error ? (
                        <span className="text-xs font-medium text-red-700">{f.error}</span>
                      ) : f.existe ? (
                        <Badge tone="blue">Actualiza</Badge>
                      ) : (
                        <Badge tone="green">Nuevo</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={respetarOrden} onChange={(e) => setRespetarOrden(e.target.checked)} />
            Ordenar el catálogo como viene en el Excel (cambia el orden de los productos importados)
          </label>
          <div className="flex items-center justify-end gap-3">
            {progreso && <span className="text-xs text-slate-500">{progreso}</span>}
            <Button variant="secondary" onClick={() => setFilas(null)} disabled={busy}>
              Cancelar
            </Button>
            <Button onClick={importar} disabled={busy || !validas.length}>
              {busy ? 'Importando…' : `Importar ${validas.length} productos`}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
