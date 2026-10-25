'use client'

import { useEffect, useMemo, useState } from 'react'
import type { Producto } from '@/lib/types'
import { fmtMoney } from '@/lib/utils'
import { SIN_CATEGORIA, categoriaDe, categorias, normTexto, subrubrosPorCategoria } from '@/lib/catalogo'
import { Badge, Card, Empty, Spinner, Table, compactCls, cx, inputCls, td, th } from './ui'

const SIN_SUB = '__sin__'

/** Lista del catálogo con filtros (activos, categoría, sub rubro y búsqueda). */
export function ListaProductos({
  productos,
  puedeEditar,
  onEditar,
}: {
  productos: Producto[] | null
  puedeEditar: boolean
  onEditar: (p: Producto) => void
}) {
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('todas')
  const [sub, setSub] = useState('todos')
  const [verActivos, setVerActivos] = useState(true)
  const [verInactivos, setVerInactivos] = useState(false)

  const cats = useMemo(() => categorias(productos ?? []), [productos])
  const subsPorCat = useMemo(() => subrubrosPorCategoria(productos ?? []), [productos])
  const subs = cat === 'todas' ? [] : subsPorCat[cat] ?? []
  const haySinSub = cat !== 'todas' && (productos ?? []).some((p) => categoriaDe(p) === cat && !p.subcategoria)

  // El sub rubro depende de la categoría: al cambiarla se vuelve a "todos"
  useEffect(() => setSub('todos'), [cat])

  const conteo = useMemo(() => {
    const l = productos ?? []
    return { activos: l.filter((p) => p.activo).length, inactivos: l.filter((p) => !p.activo).length }
  }, [productos])

  const lista = useMemo(() => {
    let l = productos ?? []
    l = l.filter((p) => (p.activo ? verActivos : verInactivos))
    if (cat !== 'todas') l = l.filter((p) => categoriaDe(p) === cat)
    if (cat !== 'todas' && sub !== 'todos') l = l.filter((p) => (sub === SIN_SUB ? !p.subcategoria : p.subcategoria === sub))
    const t = normTexto(q.trim())
    if (t) {
      l = l.filter((p) =>
        [p.nombre, p.codigo, p.descripcion, p.medida, p.categoria, p.subcategoria].some((x) => x && normTexto(x).includes(t)),
      )
    }
    return l
  }, [productos, verActivos, verInactivos, cat, sub, q])

  const chip = (on: boolean) =>
    cx('rounded-full border px-3 py-1 text-xs font-medium', on ? 'border-brand-700 bg-brand-700 text-white' : 'border-slate-300 text-slate-600 hover:border-brand-400')

  return (
    <Card
      pad={false}
      title={
        <div className="flex flex-wrap items-center gap-1.5">
          <button className={chip(verActivos)} onClick={() => setVerActivos((v) => !v)}>
            {verActivos ? '✓ ' : ''}Activos {conteo.activos}
          </button>
          <button className={chip(verInactivos)} onClick={() => setVerInactivos((v) => !v)}>
            {verInactivos ? '✓ ' : ''}Inactivos {conteo.inactivos}
          </button>
          <select className={`${compactCls} ml-1 py-1 text-xs`} value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="todas">Todas las categorías</option>
            {cats.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          {cat !== 'todas' && subs.length > 0 && (
            <select className={`${compactCls} py-1 text-xs`} value={sub} onChange={(e) => setSub(e.target.value)} aria-label="Sub rubro">
              <option value="todos">Todos los sub rubros</option>
              {subs.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
              {haySinSub && <option value={SIN_SUB}>Sin sub rubro</option>}
            </select>
          )}
        </div>
      }
      actions={<input className={`${inputCls} w-64`} placeholder="Buscar nombre, código, medida…" value={q} onChange={(e) => setQ(e.target.value)} />}
    >
      {!productos ? (
        <Spinner />
      ) : lista.length === 0 ? (
        <Empty>
          {productos.length === 0
            ? 'Todavía no hay productos. Cargalos uno por uno o importá el Excel (bajá la plantilla para ver las columnas).'
            : !verActivos && !verInactivos
              ? 'Elegí activos, inactivos o los dos.'
              : 'Sin resultados.'}
        </Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <th className={`${th} w-16`}>Foto</th>
              <th className={th}>Producto</th>
              <th className={th}>Código</th>
              <th className={th}>Categoría</th>
              <th className={th}>Sub rubro</th>
              <th className={th}>Medida</th>
              <th className={`${th} text-right`}>Precio</th>
              <th className={th}>Estado</th>
            </tr>
          </thead>
          <tbody>
            {lista.map((p) => (
              <tr
                key={p.id}
                className={cx(puedeEditar && 'cursor-pointer hover:bg-brand-50/40', !p.activo && 'opacity-60')}
                onClick={() => puedeEditar && onEditar(p)}
              >
                <td className={`${td} py-1.5`}>
                  <div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-md border border-slate-200 bg-white">
                    {p.imagen_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.imagen_url} alt="" loading="lazy" className="h-full w-full object-contain" />
                    ) : (
                      <span className="text-[10px] text-slate-300">sin foto</span>
                    )}
                  </div>
                </td>
                <td className={td}>
                  <div className="font-medium text-slate-900">{p.nombre}</div>
                  {p.descripcion && <div className="line-clamp-1 text-xs text-slate-500">{p.descripcion}</div>}
                </td>
                <td className={`${td} whitespace-nowrap font-mono text-xs text-slate-600`}>{p.codigo || '—'}</td>
                <td className={`${td} text-xs`}>{p.categoria || <span className="text-slate-400">{SIN_CATEGORIA.toLowerCase()}</span>}</td>
                <td className={`${td} text-xs`}>{p.subcategoria || <span className="text-slate-400">—</span>}</td>
                <td className={`${td} text-xs`}>{p.medida || '—'}</td>
                <td className={`${td} whitespace-nowrap text-right tabular-nums`}>
                  {p.precio != null ? fmtMoney(p.precio) : <span className="text-slate-400">—</span>}
                </td>
                <td className={td}>{p.activo ? <Badge tone="green">Activo</Badge> : <Badge>Inactivo</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {productos && lista.length > 0 && (
        <div className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
          {lista.length} de {productos.length} productos · {lista.filter((p) => !p.imagen_url).length} sin foto
        </div>
      )}
    </Card>
  )
}
