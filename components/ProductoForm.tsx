'use client'

import { useEffect, useRef, useState } from 'react'
import { errMsg, sb } from '@/lib/supabase'
import type { Producto } from '@/lib/types'
import { achicarImagen, borrarImagen, normCategoria, normSubrubro, parsePrecio, subirImagen } from '@/lib/catalogo'
import { Alert, Button, Field, inputCls } from './ui'

type Props = {
  producto?: Producto | null
  categorias: string[]
  /** Sub rubros que ya existen en cada categoría (para sugerirlos). */
  subrubros?: Record<string, string[]>
  onCancel: () => void
  onSaved: (p: Producto, accion: 'creado' | 'guardado' | 'eliminado') => void
}

export function ProductoForm({ producto, categorias, subrubros = {}, onCancel, onSaved }: Props) {
  const p = producto
  const [f, setF] = useState({
    codigo: p?.codigo ?? '',
    nombre: p?.nombre ?? '',
    descripcion: p?.descripcion ?? '',
    categoria: p?.categoria ?? '',
    subcategoria: p?.subcategoria ?? '',
    medida: p?.medida ?? '',
    precio: p?.precio != null ? String(p.precio).replace('.', ',') : '',
    orden: String(p?.orden ?? 0),
    activo: p?.activo ?? true,
  })
  const [imagen, setImagen] = useState<string | null>(p?.imagen_url ?? null)
  const [nueva, setNueva] = useState<{ blob: Blob; url: string; kb: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [borrar, setBorrar] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => () => { if (nueva) URL.revokeObjectURL(nueva.url) }, [nueva])

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setF((x) => ({ ...x, [k]: e.target.value }))

  async function elegirFoto(file: File | undefined) {
    if (!file) return
    setErr(null)
    try {
      const blob = await achicarImagen(file)
      setNueva({ blob, url: URL.createObjectURL(blob), kb: Math.round(blob.size / 1024) })
    } catch (e) {
      setErr(errMsg(e))
    }
    if (fileRef.current) fileRef.current.value = ''
  }

  async function guardar() {
    setErr(null)
    if (!f.nombre.trim()) return setErr('Poné el nombre del producto.')
    const precio = parsePrecio(f.precio)
    if (precio !== null && (Number.isNaN(precio) || precio < 0)) return setErr('El precio está mal escrito (ej: 4500 o 4.500,50). Dejalo vacío si no tiene.')
    setBusy(true)
    try {
      let url = imagen
      if (nueva) url = await subirImagen(nueva.blob, f.nombre)
      const datos = {
        codigo: f.codigo.trim() || null,
        nombre: f.nombre.replace(/\s+/g, ' ').trim(),
        descripcion: f.descripcion.trim() || null,
        categoria: normCategoria(f.categoria),
        subcategoria: normSubrubro(f.subcategoria),
        medida: f.medida.trim() || null,
        precio,
        imagen_url: url,
        orden: Number.parseInt(f.orden, 10) || 0,
        activo: f.activo,
      }
      const q = p ? sb().from('productos').update(datos).eq('id', p.id) : sb().from('productos').insert(datos)
      const { data, error } = await q.select().single()
      if (error) throw error
      // La foto anterior ya no se usa: se borra del bucket (si era nuestra)
      if (p?.imagen_url && p.imagen_url !== url) await borrarImagen(p.imagen_url).catch(() => {})
      onSaved(data as Producto, p ? 'guardado' : 'creado')
    } catch (e) {
      setErr(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  async function eliminar() {
    if (!p) return
    setBusy(true)
    setErr(null)
    const { error } = await sb().from('productos').delete().eq('id', p.id)
    if (error) {
      setBusy(false)
      return setErr(errMsg(error))
    }
    await borrarImagen(p.imagen_url).catch(() => {})
    onSaved(p, 'eliminado')
  }

  const vista = nueva?.url ?? imagen
  const catElegida = normCategoria(f.categoria)
  const sugeridos = catElegida ? subrubros[catElegida] ?? [] : []

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-[180px_1fr]">
        <div>
          <div className="flex aspect-square items-center justify-center overflow-hidden rounded-lg border border-dashed border-slate-300 bg-slate-50">
            {vista ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={vista} alt="" className="h-full w-full object-contain" />
            ) : (
              <span className="px-3 text-center text-xs text-slate-400">Sin foto</span>
            )}
          </div>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => elegirFoto(e.target.files?.[0])} />
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()} disabled={busy}>
              {vista ? 'Cambiar foto' : 'Subir foto'}
            </Button>
            {vista && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setNueva(null)
                  setImagen(null)
                }}
              >
                Quitar
              </Button>
            )}
          </div>
          {nueva && <p className="mt-1 text-xs text-slate-500">Achicada a 1000 px · {nueva.kb} KB. Se sube al guardar.</p>}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Nombre" required className="sm:col-span-2">
            <input className={inputCls} value={f.nombre} onChange={set('nombre')} placeholder="Ej: Escobillón Irizar" autoFocus />
          </Field>
          <Field label="Código" hint="Con el código se actualiza al importar el Excel.">
            <input className={inputCls} value={f.codigo} onChange={set('codigo')} placeholder="Ej: LIM-001" />
          </Field>
          <Field label="Categoría" hint="Agrupa las páginas del catálogo.">
            <input className={inputCls} value={f.categoria} onChange={set('categoria')} list="cat-productos" placeholder="Ej: LIMPIEZA" />
            <datalist id="cat-productos">
              {categorias.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </Field>
          <Field
            label="Sub rubro"
            hint={
              sugeridos.length
                ? `Opcional. En ${catElegida}: ${sugeridos.join(', ')}.`
                : 'Opcional. Ej: en DESCARTABLES → GASTRONÓMICOS. Agrupa los productos dentro de la categoría.'
            }
          >
            <input className={inputCls} value={f.subcategoria} onChange={set('subcategoria')} list="subrubro-productos" placeholder="Ej: GASTRONÓMICOS" />
            <datalist id="subrubro-productos">
              {sugeridos.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </Field>
          <Field label="Medida / presentación">
            <input className={inputCls} value={f.medida} onChange={set('medida')} placeholder="Ej: 50x60, 500 cc, x 10 u." />
          </Field>
          <Field label="Precio" hint="Opcional. Vacío = sin precio.">
            <input className={inputCls} value={f.precio} onChange={set('precio')} inputMode="decimal" placeholder="Ej: 4.500,00" />
          </Field>
          <Field label="Orden" hint="Dentro del sub rubro / la categoría (menor = primero).">
            <input className={inputCls} value={f.orden} onChange={set('orden')} inputMode="numeric" />
          </Field>
          <Field label="Descripción" className="sm:col-span-2">
            <textarea className={inputCls} rows={2} value={f.descripcion} onChange={set('descripcion')} />
          </Field>
          <label className="flex items-center gap-2 self-center pt-4 text-sm text-slate-700">
            <input type="checkbox" checked={f.activo} onChange={(e) => setF((x) => ({ ...x, activo: e.target.checked }))} />
            Activo (aparece en el catálogo)
          </label>
        </div>
      </div>

      {err && <Alert tone="red">{err}</Alert>}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-4">
        <div>
          {p &&
            (borrar ? (
              <span className="flex items-center gap-2 text-sm text-slate-600">
                ¿Eliminar el producto?
                <Button size="sm" variant="danger" onClick={eliminar} disabled={busy}>
                  Sí, eliminar
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setBorrar(false)}>
                  No
                </Button>
              </span>
            ) : (
              <Button size="sm" variant="ghost" className="text-red-600" onClick={() => setBorrar(true)} disabled={busy}>
                Eliminar
              </Button>
            ))}
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancelar
          </Button>
          <Button onClick={guardar} disabled={busy}>
            {busy ? 'Guardando…' : p ? 'Guardar cambios' : 'Crear producto'}
          </Button>
        </div>
      </div>
    </div>
  )
}
