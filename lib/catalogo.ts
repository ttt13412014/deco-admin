// Catálogo de productos: fotos (achicar y subir), categorías, plantilla e importación de Excel/CSV.
import { sb } from './supabase'
import type { Producto } from './types'

export const BUCKET = 'productos'
export const SIN_CATEGORIA = 'SIN CATEGORÍA'

/** Colores de la marca (sacados del catálogo de ejemplo). */
export const MARCA = { teal: '#0097b2', gris: '#545454', verde: '#56bb44' } as const

/** "  limpieza  " → "LIMPIEZA" (así "Limpieza" y "LIMPIEZA" quedan en la misma categoría). */
export function normCategoria(s: string | null | undefined): string | null {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t ? t.toLocaleUpperCase('es-AR') : null
}

export const categoriaDe = (p: Pick<Producto, 'categoria'>) => p.categoria || SIN_CATEGORIA

/** Los productos sin sub rubro, dentro de una categoría que sí tiene sub rubros, salen al final como "OTROS". */
export const SIN_SUBRUBRO = 'OTROS'
/** Mismo criterio que la categoría: mayúsculas y sin espacios de más. */
export const normSubrubro = normCategoria

/** Compara sub rubros: alfabético y los vacíos al final. */
export function cmpSubrubro(a: string | null | undefined, b: string | null | undefined) {
  if (!a && !b) return 0
  if (!a) return 1
  if (!b) return -1
  return a.localeCompare(b, 'es')
}

/** Sub rubros (sin vacíos) de cada categoría, en orden alfabético. */
export function subrubrosPorCategoria(ps: Pick<Producto, 'categoria' | 'subcategoria'>[]): Record<string, string[]> {
  const m: Record<string, Set<string>> = {}
  for (const p of ps) {
    if (!p.subcategoria) continue
    ;(m[categoriaDe(p)] ??= new Set()).add(p.subcategoria)
  }
  const out: Record<string, string[]> = {}
  for (const [c, set] of Object.entries(m)) out[c] = Array.from(set).sort((a, b) => a.localeCompare(b, 'es'))
  return out
}

/** Categorías en orden alfabético (la "sin categoría" al final). */
export function categorias(ps: Pick<Producto, 'categoria'>[]): string[] {
  const set = new Set(ps.map(categoriaDe))
  return Array.from(set).sort((a, b) => (a === SIN_CATEGORIA ? 1 : b === SIN_CATEGORIA ? -1 : a.localeCompare(b, 'es')))
}

/** Orden del catálogo: categoría, sub rubro (los vacíos al final), orden, nombre. */
export function ordenar<T extends Pick<Producto, 'categoria' | 'subcategoria' | 'orden' | 'nombre'>>(ps: T[]): T[] {
  const cats = categorias(ps)
  return [...ps].sort(
    (a, b) =>
      cats.indexOf(categoriaDe(a)) - cats.indexOf(categoriaDe(b)) ||
      cmpSubrubro(a.subcategoria, b.subcategoria) ||
      (a.orden ?? 0) - (b.orden ?? 0) ||
      a.nombre.localeCompare(b.nombre, 'es'),
  )
}

export const normTexto = (s: string) =>
  (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')

// ---------- Fotos ----------

/**
 * Achica la foto en el navegador: lado mayor de 1000 px como máximo, JPG ~85 %,
 * fondo blanco (las PNG con transparencia quedan sobre blanco, como en el catálogo).
 */
export async function achicarImagen(file: File, max = 1000, calidad = 0.85): Promise<Blob> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((ok, mal) => {
      const i = new Image()
      i.onload = () => ok(i)
      i.onerror = () => mal(new Error('No pude leer la imagen. Probá con un JPG o PNG.'))
      i.src = url
    })
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight))
    const w = Math.max(1, Math.round(img.naturalWidth * k))
    const h = Math.max(1, Math.round(img.naturalHeight * k))
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d')
    if (!ctx) throw new Error('El navegador no permite procesar la imagen.')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, w, h)
    const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, 'image/jpeg', calidad))
    if (!blob) throw new Error('No pude comprimir la imagen.')
    return blob
  } finally {
    URL.revokeObjectURL(url)
  }
}

const slug = (s: string) =>
  normTexto(s)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'producto'

/** Sube la foto (ya achicada) al bucket público y devuelve la URL pública. */
export async function subirImagen(blob: Blob, nombre: string): Promise<string> {
  const path = `${slug(nombre)}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.jpg`
  const { error } = await sb().storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg', cacheControl: '31536000', upsert: false })
  if (error) throw error
  return sb().storage.from(BUCKET).getPublicUrl(path).data.publicUrl
}

/** Si la URL es de nuestro bucket, devuelve la ruta del archivo (para borrarlo al reemplazar la foto). */
export function rutaEnBucket(url: string | null | undefined): string | null {
  if (!url) return null
  const m = url.match(/\/storage\/v1\/object\/public\/productos\/(.+?)(\?|$)/)
  return m ? decodeURIComponent(m[1]) : null
}

export async function borrarImagen(url: string | null | undefined) {
  const p = rutaEnBucket(url)
  if (p) await sb().storage.from(BUCKET).remove([p])
}

// ---------- Plantilla e importación ----------

export const COLUMNAS = ['codigo', 'nombre', 'descripcion', 'categoria', 'subcategoria', 'medida', 'precio', 'imagen_url'] as const
export type Columna = (typeof COLUMNAS)[number]

/** Encabezado de cada columna en la plantilla (la base guarda el sub rubro en "subcategoria"). */
export const ENCABEZADO: Record<Columna, string> = {
  codigo: 'codigo', nombre: 'nombre', descripcion: 'descripcion', categoria: 'categoria', subcategoria: 'subrubro',
  medida: 'medida', precio: 'precio', imagen_url: 'imagen_url',
}
export const ENCABEZADOS = COLUMNAS.map((c) => ENCABEZADO[c])

const ALIAS: Record<string, Columna> = {
  codigo: 'codigo', cod: 'codigo', code: 'codigo', sku: 'codigo', articulo: 'codigo', codigoarticulo: 'codigo', codigoproducto: 'codigo',
  nombre: 'nombre', producto: 'nombre', articulonombre: 'nombre', nombreproducto: 'nombre', detalle: 'nombre',
  descripcion: 'descripcion', desc: 'descripcion', observaciones: 'descripcion',
  categoria: 'categoria', rubro: 'categoria', familia: 'categoria', linea: 'categoria',
  // "subrubro", "sub_rubro", "sub rubro", "Sub-rubro", "subcategoria", "sub categoría"
  subrubro: 'subcategoria', subcategoria: 'subcategoria', subfamilia: 'subcategoria',
  medida: 'medida', medidas: 'medida', presentacion: 'medida', medidapresentacion: 'medida', tamano: 'medida', tamanio: 'medida', capacidad: 'medida',
  precio: 'precio', precios: 'precio', preciounitario: 'precio', preciolista: 'precio', importe: 'precio', pvp: 'precio',
  imagenurl: 'imagen_url', imagen: 'imagen_url', foto: 'imagen_url', fotourl: 'imagen_url', urlimagen: 'imagen_url', url: 'imagen_url', link: 'imagen_url',
}
const normH = (s: string) => normTexto(String(s)).replace(/[^a-z0-9]/g, '')

export const PLANTILLA: Record<Columna, string | number>[] = [
  { codigo: 'LIM-001', nombre: 'Escobillón Irizar', descripcion: 'Cerdas plásticas, base reforzada', categoria: 'LIMPIEZA', subcategoria: 'PISOS', medida: '30 cm', precio: 4500, imagen_url: '' },
  { codigo: 'LIM-002', nombre: 'Trapo de piso Julieta', descripcion: '', categoria: 'LIMPIEZA', subcategoria: 'PISOS', medida: '50x60', precio: '', imagen_url: '' },
  { codigo: 'DES-001', nombre: 'Vaso térmico', descripcion: 'Con tapa', categoria: 'DESCARTABLES', subcategoria: 'GASTRONÓMICOS', medida: '240 cc', precio: 95, imagen_url: '' },
  { codigo: 'ENV-001', nombre: 'Botella PET', descripcion: 'Con tapa', categoria: 'ENVASES PLÁSTICOS', subcategoria: '', medida: '500 cc', precio: 380.5, imagen_url: '' },
]

export async function descargarPlantilla() {
  const XLSX = await import('xlsx')
  const filas = PLANTILLA.map((f) => Object.fromEntries(COLUMNAS.map((c) => [ENCABEZADO[c], f[c]])))
  const ws = XLSX.utils.json_to_sheet(filas, { header: ENCABEZADOS })
  ws['!cols'] = [{ wch: 12 }, { wch: 32 }, { wch: 36 }, { wch: 20 }, { wch: 20 }, { wch: 12 }, { wch: 12 }, { wch: 40 }]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Productos')
  XLSX.writeFile(wb, 'plantilla_catalogo_DECO.xlsx')
}

/** "$ 1.234,50", "1234.5", 1234.5 → 1234.5 · vacío → null · inválido → NaN */
export function parsePrecio(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) / 100 : NaN
  let t = String(v).replace(/[$\s]/g, '').replace(/ars/i, '')
  if (!t) return null
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.')
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '') // 1.234 → 1234
  const n = Number(t)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN
}

export interface FilaImport {
  fila: number
  codigo: string
  nombre: string
  descripcion: string | null
  categoria: string | null
  subcategoria: string | null
  medida: string | null
  precio: number | null
  imagen_url: string | null
  error?: string
  aviso?: string
  existe?: boolean
}

export interface Lectura {
  filas: FilaImport[]
  /** Columnas reconocidas en el archivo (las que no vienen no se tocan al actualizar). */
  columnas: Columna[]
  ignoradas: string[]
}

export async function leerArchivo(file: File): Promise<Lectura> {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(await file.arrayBuffer())
  const ws = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '', raw: true, blankrows: false })
  if (!rows.length) return { filas: [], columnas: [], ignoradas: [] }

  // La fila de títulos: la primera de las 10 primeras que tenga "codigo" o "nombre"
  let cab = rows.slice(0, 10).findIndex((r) => r.some((c) => ALIAS[normH(String(c))] === 'nombre' || ALIAS[normH(String(c))] === 'codigo'))
  if (cab < 0) cab = 0
  const idx: Partial<Record<Columna, number>> = {}
  const ignoradas: string[] = []
  rows[cab].forEach((h, i) => {
    const col = ALIAS[normH(String(h))]
    if (col && idx[col] === undefined) idx[col] = i
    else if (String(h).trim()) ignoradas.push(String(h).trim())
  })
  const columnas = COLUMNAS.filter((c) => idx[c] !== undefined)

  const txt = (r: unknown[], c: Columna) => {
    const i = idx[c]
    if (i === undefined) return null
    const v = r[i]
    const s = (typeof v === 'number' ? String(v) : String(v ?? '')).replace(/\s+/g, ' ').trim()
    return s || null
  }

  const filas: FilaImport[] = []
  const vistos = new Map<string, FilaImport>()
  rows.slice(cab + 1).forEach((r, i) => {
    if (!r.some((c) => String(c ?? '').trim() !== '')) return
    const precio = idx.precio !== undefined ? parsePrecio(r[idx.precio]) : null
    const f: FilaImport = {
      fila: cab + i + 2,
      codigo: txt(r, 'codigo') ?? '',
      nombre: txt(r, 'nombre') ?? '',
      descripcion: txt(r, 'descripcion'),
      categoria: normCategoria(txt(r, 'categoria')),
      subcategoria: normSubrubro(txt(r, 'subcategoria')),
      medida: txt(r, 'medida'),
      precio: precio !== null && Number.isNaN(precio) ? null : precio,
      imagen_url: txt(r, 'imagen_url'),
    }
    if (!f.codigo) f.error = 'Falta el código'
    else if (!f.nombre) f.error = 'Falta el nombre'
    else if (precio !== null && Number.isNaN(precio)) f.error = `Precio mal escrito: “${String(r[idx.precio as number])}”`
    else if (precio !== null && precio < 0) f.error = 'El precio no puede ser negativo'
    else if (f.imagen_url && !/^https?:\/\//i.test(f.imagen_url)) f.error = 'La imagen tiene que ser un link (http…)'
    if (!f.error) {
      const k = f.codigo.toLowerCase()
      const ant = vistos.get(k)
      if (ant) {
        ant.error = `Código repetido (se usa la fila ${f.fila})`
      }
      vistos.set(k, f)
    }
    filas.push(f)
  })
  return { filas, columnas, ignoradas }
}
