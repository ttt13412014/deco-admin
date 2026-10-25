/* eslint-disable @next/next/no-img-element */
// Hojas A4 del catálogo (tapa + páginas de productos), con el estilo del catálogo de DE&CO.
// Se imprimen con el "Guardar como PDF" del navegador (ver app/catalogo/imprimir).
import type { Producto } from '@/lib/types'
import { fmtMoney } from '@/lib/utils'
import { MARCA, SIN_SUBRUBRO, categoriaDe, cmpSubrubro, normTexto } from '@/lib/catalogo'

export const POR_HOJA = 12 // 3 columnas × 4 filas, como el catálogo de ejemplo

export interface OpcionesCatalogo {
  titulo: string
  conPrecios: boolean
  conCodigo: boolean
  /** Foto de fondo de la tapa (opcional). */
  portada: string | null
  /** Texto chico de la tapa (ej: "Precios vigentes al 23/10/2026"). */
  leyenda: string | null
  /** Debajo del título, cuando el catálogo es de un solo sub rubro (ej: "DESCARTABLES · GASTRONÓMICOS"). */
  subtitulo?: string | null
}

/** Un tramo de un sub rubro dentro de una hoja (cont = viene de la hoja anterior). */
export type Grupo = { sub: string; cont: boolean; productos: Producto[] }
/** grupos = null: la categoría no tiene sub rubros y la hoja es la grilla de siempre (3 × 4). */
type Pagina = { categoria: string; productos: Producto[]; grupos: Grupo[] | null }

// Hoja con sub rubros: filas de 3 productos y un subtítulo chico antes de cada sub rubro.
// Alto útil 267 mm = 4 filas de 60 mm + hasta 3 subtítulos de 9 mm.
const ALTO_UTIL = 267
const ALTO_FILA = 60
const ALTO_SUB = 9

/**
 * Cada categoría arranca en una hoja nueva. Sin sub rubros: se corta cada 12 productos.
 * Con sub rubros: se agrupan (alfabético, los sin sub rubro al final como "OTROS"), cada sub rubro
 * empieza en una fila nueva con su subtítulo y, si sigue en la hoja siguiente, se repite el subtítulo.
 */
export function paginar(productos: Producto[], cats: string[]): Pagina[] {
  const out: Pagina[] = []
  for (const c of cats) {
    const ps = productos.filter((p) => categoriaDe(p) === c)
    if (!ps.length) continue
    if (!ps.some((p) => p.subcategoria)) {
      for (let i = 0; i < ps.length; i += POR_HOJA) out.push({ categoria: c, productos: ps.slice(i, i + POR_HOJA), grupos: null })
      continue
    }
    const subs = Array.from(new Set(ps.map((p) => p.subcategoria ?? null))).sort(cmpSubrubro)
    let hoja: Pagina | null = null
    let usado = 0
    for (const s of subs) {
      const nombre = s ?? SIN_SUBRUBRO
      const delSub = ps.filter((p) => (p.subcategoria ?? null) === s)
      let grupo: Grupo | null = null
      for (let i = 0; i < delSub.length; i += 3) {
        const fila = delSub.slice(i, i + 3)
        const nuevoGrupo = !grupo
        const alto = ALTO_FILA + (nuevoGrupo ? ALTO_SUB : 0)
        if (!hoja || usado + alto > ALTO_UTIL + 0.01) {
          hoja = { categoria: c, productos: [], grupos: [] }
          out.push(hoja)
          usado = 0
          grupo = null
        }
        if (!grupo) {
          grupo = { sub: nombre, cont: i > 0, productos: [] }
          hoja.grupos!.push(grupo)
          usado += ALTO_SUB
        }
        grupo.productos.push(...fila)
        hoja.productos.push(...fila)
        usado += ALTO_FILA
      }
    }
  }
  return out
}

export const CSS_CATALOGO = `
.cat-root { font-family: 'Open Sans', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; color: ${MARCA.gris}; }
.cat-hoja { position: relative; width: 210mm; height: 297mm; overflow: hidden; background: #fff; margin: 0 auto 10mm;
  box-shadow: 0 1px 3px rgba(15,23,42,.12), 0 8px 24px rgba(15,23,42,.08);
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
@page { size: A4; margin: 0; }
@media print {
  html, body { background: #fff !important; }
  .cat-hoja { margin: 0; box-shadow: none; break-after: page; page-break-after: always; }
  .cat-hoja:last-child { break-after: auto; page-break-after: auto; }
  main > div { max-width: none !important; }
}
`

function Seguinos({ blanco }: { blanco?: boolean }) {
  return (
    <span style={{ fontWeight: 700, letterSpacing: '0.01em' }}>
      <span style={{ color: MARCA.verde }}>Seguinos en </span>
      <span style={{ color: blanco ? '#fff' : MARCA.gris }}>/descartablesycosas</span>
    </span>
  )
}

export function Tapa({ op, categorias }: { op: OpcionesCatalogo; categorias: string[] }) {
  const titulo = (op.titulo || 'CATÁLOGO').toLocaleUpperCase('es-AR')
  const banner = (
    <div
      style={{ position: 'absolute', left: 0, right: 0, top: '14mm', minHeight: '26mm', background: op.portada ? 'rgba(0,151,178,.92)' : MARCA.teal }}
      className="flex items-center justify-center px-[12mm] py-[4mm]"
    >
      <div style={{ textAlign: 'center' }}>
        <h1 style={{ color: '#fff', fontWeight: 800, fontSize: titulo.length > 22 ? '24pt' : '30pt', letterSpacing: '0.04em', lineHeight: 1.1, textAlign: 'center' }}>{titulo}</h1>
        {op.subtitulo && (
          <div style={{ color: '#fff', fontWeight: 700, fontSize: '12pt', letterSpacing: '0.14em', marginTop: '2mm', opacity: 0.95 }}>{op.subtitulo.toLocaleUpperCase('es-AR')}</div>
        )}
      </div>
    </div>
  )

  if (op.portada) {
    return (
      <section className="cat-hoja">
        <img src={op.portada} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
        {banner}
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: '14mm' }} className="flex flex-col items-center gap-[4mm]">
          <div style={{ width: '36mm', height: '36mm', borderRadius: '50%', background: '#fff', boxShadow: '0 2mm 6mm rgba(0,0,0,.25)' }} className="flex items-center justify-center">
            <img src="/logo_deco_redondo.png" alt="DE&CO" style={{ width: '31mm', height: '31mm' }} />
          </div>
          <div style={{ background: 'rgba(255,255,255,.94)', borderRadius: '99px', padding: '1.5mm 5mm', fontSize: '10pt' }}>
            <Seguinos />
          </div>
        </div>
      </section>
    )
  }

  // Sin foto: tapa gráfica con el logo grande y los colores de la marca
  return (
    <section className="cat-hoja">
      {/* Círculos de fondo (marca de agua) */}
      <div style={{ position: 'absolute', right: '-55mm', top: '40mm', width: '150mm', height: '150mm', borderRadius: '50%', background: MARCA.teal, opacity: 0.07 }} />
      <div style={{ position: 'absolute', left: '-40mm', top: '150mm', width: '95mm', height: '95mm', borderRadius: '50%', border: `3mm solid ${MARCA.verde}`, opacity: 0.12 }} />
      {banner}
      <div style={{ position: 'absolute', left: 0, right: 0, top: '78mm' }} className="flex flex-col items-center">
        <img src="/logo_deco_texto.png" alt="DE&CO · Descartables y Cosas" style={{ width: '150mm' }} />
        <div style={{ width: '40mm', height: '1.2mm', background: MARCA.verde, borderRadius: '1mm', marginTop: '12mm' }} />
        {categorias.length > 0 && (
          <div style={{ marginTop: '9mm', maxWidth: '160mm', textAlign: 'center', fontSize: '11pt', fontWeight: 700, letterSpacing: '0.12em', lineHeight: 1.9 }}>
            {categorias.map((c, i) => (
              <span key={c} style={{ whiteSpace: 'nowrap' }}>
                {i > 0 && <span style={{ color: MARCA.teal, margin: '0 3mm' }}>•</span>}
                {c}
              </span>
            ))}
          </div>
        )}
      </div>
      {/* Pie: franja teal en diagonal + gris */}
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '62mm', background: MARCA.teal, clipPath: 'polygon(0 38%, 100% 0, 100% 100%, 0 100%)' }} />
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '22mm', background: MARCA.gris }} className="flex items-center justify-between px-[14mm]">
        <span style={{ fontSize: '11pt' }}>
          <Seguinos blanco />
        </span>
        {op.leyenda && <span style={{ color: '#fff', fontSize: '9pt', fontWeight: 600 }}>{op.leyenda}</span>}
      </div>
    </section>
  )
}

/** Agrega la medida debajo del nombre solo si el nombre no la tiene ya (ej: "Trapo de piso 50x60"). */
function medidaAparte(p: Producto) {
  if (!p.medida) return null
  return normTexto(p.nombre).replace(/\s/g, '').includes(normTexto(p.medida).replace(/\s/g, '')) ? null : p.medida
}

function Tarjeta({ p, op, altoFoto }: { p: Producto; op: OpcionesCatalogo; altoFoto: string }) {
  const medida = medidaAparte(p)
  return (
    <div className="flex min-h-0 flex-col items-center">
      <div style={{ height: altoFoto, width: '100%' }} className="flex items-center justify-center">
        {p.imagen_url ? (
          <img src={p.imagen_url} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
        ) : (
          <img src="/logo_deco_redondo.png" alt="" style={{ width: '18mm', opacity: 0.15 }} />
        )}
      </div>
      <div style={{ marginTop: '2.5mm', textAlign: 'center', textTransform: 'uppercase', fontWeight: 700, fontSize: '7.8pt', lineHeight: 1.25, color: MARCA.gris }}>
        {p.nombre}
        {medida && <> {medida}</>}
      </div>
      {op.conCodigo && p.codigo && <div style={{ fontSize: '6.8pt', color: '#8a8a8a', marginTop: '0.6mm' }}>Cód. {p.codigo}</div>}
      {op.conPrecios && p.precio != null && (
        <div style={{ marginTop: '1mm', color: MARCA.teal, fontWeight: 800, fontSize: '10pt' }}>{fmtMoney(p.precio)}</div>
      )}
    </div>
  )
}

export function HojaProductos({ pagina, numero, op }: { pagina: Pagina; numero: number; op: OpcionesCatalogo }) {
  return (
    <section className="cat-hoja">
      {/* Franja lateral con la categoría */}
      <div style={{ position: 'absolute', right: 0, top: 0, width: '26mm', height: '249mm', background: MARCA.teal, paddingTop: '11mm' }} className="flex items-start justify-center">
        <div
          style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', color: '#fff', fontWeight: 800, fontSize: '19pt', letterSpacing: '0.03em', whiteSpace: 'nowrap', maxHeight: '230mm', overflow: 'hidden' }}
        >
          {pagina.categoria}
        </div>
      </div>
      <div style={{ position: 'absolute', right: 0, bottom: 0, width: '26mm', height: '43mm', background: MARCA.gris }} className="flex items-center justify-center">
        <span style={{ color: '#fff', fontWeight: 800, fontSize: '28pt' }}>{numero}</span>
      </div>

      <div style={{ position: 'absolute', top: '8mm', right: '32mm', fontSize: '9.5pt' }}>
        <Seguinos />
      </div>

      {pagina.grupos ? (
        <div style={{ position: 'absolute', left: '8mm', right: '32mm', top: '20mm', bottom: '10mm' }}>
          {pagina.grupos.map((g, gi) => (
            <div key={`${g.sub}-${gi}`}>
              <div style={{ height: `${ALTO_SUB}mm`, paddingTop: '1.5mm' }} className="flex items-center gap-[3mm]">
                <span style={{ color: MARCA.teal, fontWeight: 800, fontSize: '10pt', letterSpacing: '0.08em', whiteSpace: 'nowrap' }}>
                  {g.sub}
                  {g.cont && <span style={{ color: '#9a9a9a', fontWeight: 600, fontSize: '7.5pt', letterSpacing: 0 }}> (continúa)</span>}
                </span>
                <span style={{ flex: 1, height: '0.5mm', background: MARCA.verde, opacity: 0.6, borderRadius: '1mm' }} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gridAutoRows: `${ALTO_FILA}mm`, columnGap: '5mm' }}>
                {g.productos.map((p) => (
                  <Tarjeta key={p.id} p={p} op={op} altoFoto="40mm" />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div
          style={{ position: 'absolute', left: '8mm', right: '32mm', top: '20mm', bottom: '10mm', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gridTemplateRows: 'repeat(4, 1fr)', columnGap: '5mm', rowGap: '3mm' }}
        >
          {pagina.productos.map((p) => (
            <Tarjeta key={p.id} p={p} op={op} altoFoto="42mm" />
          ))}
        </div>
      )}
    </section>
  )
}

export function CatalogoHojas({ productos, categorias, op }: { productos: Producto[]; categorias: string[]; op: OpcionesCatalogo }) {
  const paginas = paginar(productos, categorias)
  const conProductos = categorias.filter((c) => paginas.some((p) => p.categoria === c))
  // Catálogo de una sola categoría con varios sub rubros: en la tapa van los sub rubros
  const subsTapa = conProductos.length === 1 ? Array.from(new Set(paginas.flatMap((p) => (p.grupos ?? []).map((g) => g.sub)))) : []
  const enTapa = subsTapa.length > 1 ? subsTapa : conProductos
  return (
    <div className="cat-root">
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;600;700;800&display=swap" />
      <style>{CSS_CATALOGO}</style>
      <Tapa op={op} categorias={enTapa} />
      {paginas.map((pg, i) => (
        <HojaProductos key={`${pg.categoria}-${i}`} pagina={pg} numero={i + 1} op={op} />
      ))}
    </div>
  )
}
