'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { errMsg } from '@/lib/supabase'
import type { Producto } from '@/lib/types'
import { fmtFecha, hoy } from '@/lib/utils'
import { SIN_SUBRUBRO, achicarImagen, categoriaDe, categorias as listarCategorias, cmpSubrubro, normTexto } from '@/lib/catalogo'
import { CatalogoHojas, POR_HOJA, paginar } from './CatalogoHojas'
import { Button, Card, Field, cx, inputCls } from './ui'

/** Opciones + vista previa de las hojas. Separado para poder usarlo con datos de ejemplo. */
const claveSub = (c: string, sub: string | null | undefined) => `${c}\u0000${sub ?? ''}`

export function ArmarCatalogo({ productos }: { productos: Producto[] }) {
  const todas = useMemo(() => listarCategorias(productos), [productos])
  const [sel, setSel] = useState<string[]>(todas)
  const [titulo, setTitulo] = useState<string | null>(null) // null = automático
  const [conPrecios, setConPrecios] = useState(false)
  const [conCodigo, setConCodigo] = useState(false)
  const [portada, setPortada] = useState<string | null>(null)
  const [errFoto, setErrFoto] = useState<string | null>(null)

  // Sub rubros y productos que se sacan (todo lo demás entra: así lo nuevo aparece tildado)
  const [subFuera, setSubFuera] = useState<Set<string>>(new Set())
  const [prodFuera, setProdFuera] = useState<Set<string>>(new Set())
  const [verProductos, setVerProductos] = useState(false)
  const [qProd, setQProd] = useState('')
  const [subEnTapa, setSubEnTapa] = useState(true)

  useEffect(() => setSel(todas), [todas])

  /** Sub rubros de cada categoría (null = sin sub rubro); solo las que tienen alguno. */
  const subsDe = useMemo(() => {
    const m: Record<string, (string | null)[]> = {}
    for (const c of todas) {
      const ps = productos.filter((p) => categoriaDe(p) === c)
      if (ps.some((p) => p.subcategoria)) m[c] = Array.from(new Set(ps.map((p) => p.subcategoria ?? null))).sort(cmpSubrubro)
    }
    return m
  }, [productos, todas])

  const elegidas = todas.filter((c) => sel.includes(c))
  const enSubs = productos.filter((p) => sel.includes(categoriaDe(p)) && !subFuera.has(claveSub(categoriaDe(p), p.subcategoria)))
  const incluidos = enSubs.filter((p) => !prodFuera.has(p.id))
  const catsConProductos = elegidas.filter((c) => incluidos.some((p) => categoriaDe(p) === c))
  const subsIncluidos = Array.from(new Set(incluidos.map((p) => p.subcategoria ?? null)))
  // Un solo sub rubro: se puede mostrar en la tapa, debajo del título (ej: DESCARTABLES · GASTRONÓMICOS)
  const subUnico = catsConProductos.length === 1 && subsIncluidos.length === 1 && subsIncluidos[0] ? `${catsConProductos[0]} · ${subsIncluidos[0]}` : null
  const tituloAuto = elegidas.length === 1 ? `CATÁLOGO ${elegidas[0]}` : 'CATÁLOGO'
  const tituloFinal = (titulo ?? tituloAuto).toLocaleUpperCase('es-AR')

  const toggleSub = (c: string, sub: string | null) =>
    setSubFuera((s) => {
      const n = new Set(s)
      const k = claveSub(c, sub)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })
  const toggleProd = (id: string) =>
    setProdFuera((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const tq = normTexto(qProd.trim())
  const visibles = tq
    ? enSubs.filter((p) => [p.nombre, p.codigo, p.medida, p.subcategoria].some((x) => x && normTexto(x).includes(tq)))
    : enSubs
  const marcarVisibles = (dentro: boolean) =>
    setProdFuera((s) => {
      const n = new Set(s)
      for (const p of visibles) {
        if (dentro) n.delete(p.id)
        else n.add(p.id)
      }
      return n
    })
  const hojas = paginar(incluidos, elegidas).length
  const sinPrecio = conPrecios ? incluidos.filter((p) => p.precio == null).length : 0

  useEffect(() => {
    const t = document.title
    document.title = tituloFinal.replace(/\s+/g, ' ') + ' · DE&CO'
    return () => {
      document.title = t
    }
  }, [tituloFinal])

  async function elegirPortada(file: File | undefined) {
    if (!file) return
    setErrFoto(null)
    try {
      const blob = await achicarImagen(file, 1800, 0.88)
      const url = await new Promise<string>((ok) => {
        const r = new FileReader()
        r.onload = () => ok(String(r.result))
        r.readAsDataURL(blob)
      })
      setPortada(url)
    } catch (e) {
      setErrFoto(errMsg(e))
    }
  }

  const toggle = (c: string) => setSel((s) => (s.includes(c) ? s.filter((x) => x !== c) : [...s, c]))

  return (
    <div>
      <div className="no-print mb-6">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <Link href="/catalogo" className="text-xs text-brand-700 hover:underline">
              ← Catálogo
            </Link>
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">Armar catálogo PDF</h1>
            <p className="mt-0.5 text-sm text-slate-500">
              Solo productos activos. {incluidos.length} productos · tapa + {hojas} {hojas === 1 ? 'hoja' : 'hojas'} (hasta {POR_HOJA} por hoja).
            </p>
          </div>
          <Button onClick={() => window.print()} disabled={!incluidos.length}>
            ⎙ Imprimir / Guardar PDF
          </Button>
        </div>

        <Card>
          <div className="grid gap-4 md:grid-cols-[1fr_1fr]">
            <div className="space-y-3">
              <Field label="Título de la tapa" hint="Ej: CATÁLOGO LIMPIEZA. Si lo dejás vacío se arma solo con la categoría.">
                <input className={inputCls} value={titulo ?? ''} placeholder={tituloAuto} onChange={(e) => setTitulo(e.target.value || null)} />
              </Field>
              {subUnico && (
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={subEnTapa} onChange={(e) => setSubEnTapa(e.target.checked)} /> Mostrar en la tapa, debajo del título:{' '}
                  <b className="text-xs tracking-wide">{subUnico}</b>
                </label>
              )}
              <div className="flex flex-wrap gap-4 text-sm text-slate-700">
                <label className="flex items-center gap-2">
                  <input type="radio" checked={!conPrecios} onChange={() => setConPrecios(false)} /> Sin precios
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" checked={conPrecios} onChange={() => setConPrecios(true)} /> Con precios
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={conCodigo} onChange={(e) => setConCodigo(e.target.checked)} /> Mostrar código
                </label>
              </div>
              {sinPrecio > 0 && (
                <p className="text-xs text-amber-700">
                  {sinPrecio === 1 ? '1 producto no tiene precio: sale sin precio.' : `${sinPrecio} productos no tienen precio: salen sin precio.`}
                </p>
              )}
              <div>
                <span className="mb-1 block text-xs font-medium text-slate-600">Foto de tapa (opcional)</span>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex cursor-pointer items-center rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50">
                    {portada ? 'Cambiar foto' : 'Elegir foto'}
                    <input type="file" accept="image/*" className="hidden" onChange={(e) => { elegirPortada(e.target.files?.[0]); e.target.value = '' }} />
                  </label>
                  {portada && (
                    <Button size="sm" variant="ghost" onClick={() => setPortada(null)}>
                      Quitar
                    </Button>
                  )}
                  <span className="text-xs text-slate-500">{portada ? 'Foto de fondo con la franja y el logo.' : 'Sin foto: tapa con el logo grande.'}</span>
                </div>
                {errFoto && <p className="mt-1 text-xs text-red-600">{errFoto}</p>}
              </div>
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-medium text-slate-600">Categorías a incluir</span>
                <span className="space-x-2 text-xs">
                  <button className="text-brand-700 hover:underline" onClick={() => setSel(todas)}>Todas</button>
                  <button className="text-brand-700 hover:underline" onClick={() => setSel([])}>Ninguna</button>
                </span>
              </div>
              {todas.length === 0 ? (
                <p className="text-sm text-slate-500">No hay productos activos todavía.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {todas.map((c) => {
                    const n = productos.filter((p) => categoriaDe(p) === c).length
                    const on = sel.includes(c)
                    return (
                      <button
                        key={c}
                        onClick={() => toggle(c)}
                        className={cx(
                          'rounded-full border px-3 py-1 text-xs font-medium',
                          on ? 'border-brand-700 bg-brand-700 text-white' : 'border-slate-300 text-slate-600 hover:border-brand-400',
                        )}
                      >
                        {on ? '✓ ' : ''}
                        {c} <span className="opacity-70">{n}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
          {elegidas.some((c) => subsDe[c]) && (
            <div className="mt-4 space-y-2 border-t border-slate-100 pt-3">
              <span className="block text-xs font-medium text-slate-600">Sub rubros a incluir</span>
              {elegidas
                .filter((c) => subsDe[c])
                .map((c) => (
                  <div key={c} className="flex flex-wrap items-center gap-1.5">
                    <span className="mr-1 min-w-[110px] text-xs font-semibold text-slate-700">{c}</span>
                    {subsDe[c].map((sub) => {
                      const on = !subFuera.has(claveSub(c, sub))
                      const n = productos.filter((p) => categoriaDe(p) === c && (p.subcategoria ?? null) === sub).length
                      return (
                        <button
                          key={sub ?? ''}
                          onClick={() => toggleSub(c, sub)}
                          className={cx(
                            'rounded-full border px-3 py-1 text-xs font-medium',
                            on ? 'border-teal-600 bg-teal-600 text-white' : 'border-slate-300 text-slate-600 hover:border-teal-400',
                          )}
                        >
                          {on ? '✓ ' : ''}
                          {sub ?? `Sin sub rubro (${SIN_SUBRUBRO})`} <span className="opacity-70">{n}</span>
                        </button>
                      )
                    })}
                    <span className="ml-1 space-x-2 text-xs">
                      <button className="text-brand-700 hover:underline" onClick={() => setSubFuera((s) => new Set(Array.from(s).filter((k) => !k.startsWith(c + '\u0000'))))}>
                        Todos
                      </button>
                      <button className="text-brand-700 hover:underline" onClick={() => setSubFuera((s) => new Set([...Array.from(s), ...subsDe[c].map((x) => claveSub(c, x))]))}>
                        Ninguno
                      </button>
                    </span>
                  </div>
                ))}
            </div>
          )}

          <div className="mt-4 border-t border-slate-100 pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-medium text-slate-600">
                Productos: {incluidos.length} de {enSubs.length} tildados
                {enSubs.length - incluidos.length > 0 && <span className="text-amber-700"> · {enSubs.length - incluidos.length} sacados a mano</span>}
              </span>
              <span className="flex items-center gap-3 text-xs">
                {prodFuera.size > 0 && (
                  <button className="text-brand-700 hover:underline" onClick={() => setProdFuera(new Set())}>
                    Volver a tildar todos
                  </button>
                )}
                <button className="font-medium text-brand-700 hover:underline" onClick={() => setVerProductos((v) => !v)}>
                  {verProductos ? 'Ocultar la lista ▴' : 'Elegir productos a mano ▾'}
                </button>
              </span>
            </div>
            {verProductos && (
              <div className="mt-2">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <input className={`${inputCls} w-64`} placeholder="Buscar producto, código, medida…" value={qProd} onChange={(e) => setQProd(e.target.value)} />
                  <button className="text-xs text-brand-700 hover:underline" onClick={() => marcarVisibles(true)}>
                    Tildar {tq ? 'los encontrados' : 'todos'}
                  </button>
                  <button className="text-xs text-brand-700 hover:underline" onClick={() => marcarVisibles(false)}>
                    Destildar {tq ? 'los encontrados' : 'todos'}
                  </button>
                </div>
                {visibles.length === 0 ? (
                  <p className="text-sm text-slate-500">{enSubs.length ? 'Sin resultados.' : 'Elegí al menos una categoría o sub rubro.'}</p>
                ) : (
                  <div className="max-h-80 overflow-y-auto rounded-lg border border-slate-200 p-2">
                    {gruposLista(visibles).map((g) => (
                      <div key={g.clave} className="mb-2 last:mb-0">
                        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{g.titulo}</div>
                        <div className="grid gap-x-4 gap-y-0.5 sm:grid-cols-2 lg:grid-cols-3">
                          {g.productos.map((p) => (
                            <label key={p.id} className="flex items-center gap-2 rounded px-1 py-0.5 text-sm text-slate-700 hover:bg-slate-50">
                              <input type="checkbox" checked={!prodFuera.has(p.id)} onChange={() => toggleProd(p.id)} />
                              <span className="truncate">
                                {p.nombre}
                                {p.medida && <span className="text-slate-400"> · {p.medida}</span>}
                              </span>
                            </label>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <p className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">
            En la ventana de impresión elegí <b>Guardar como PDF</b>, tamaño <b>A4</b>, márgenes <b>Ninguno</b> y tildá <b>Gráficos de fondo</b>. Funciona mejor en Chrome o Edge.
          </p>
        </Card>
      </div>

      <CatalogoHojas
        productos={incluidos}
        categorias={elegidas}
        op={{
          titulo: tituloFinal,
          subtitulo: subUnico && subEnTapa ? subUnico : null,
          conPrecios,
          conCodigo,
          portada,
          leyenda: conPrecios ? `Precios vigentes al ${fmtFecha(hoy())}` : null,
        }}
      />
    </div>
  )
}

/** Lista de productos para tildar, agrupada por categoría · sub rubro (ya viene ordenada). */
function gruposLista(ps: Producto[]) {
  const out: { clave: string; titulo: string; productos: Producto[] }[] = []
  for (const p of ps) {
    const clave = claveSub(categoriaDe(p), p.subcategoria)
    let g = out.find((x) => x.clave === clave)
    if (!g) {
      g = { clave, titulo: p.subcategoria ? `${categoriaDe(p)} · ${p.subcategoria}` : categoriaDe(p), productos: [] }
      out.push(g)
    }
    g.productos.push(p)
  }
  return out
}
