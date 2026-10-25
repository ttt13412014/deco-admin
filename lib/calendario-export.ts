// Dibuja el calendario en un canvas (para PNG/PDF) y arma un PDF A4 apaisado sin librerías.
import { Evento, MESES, TIPOS, TipoEvento, celdasMes, diaSemana } from './personal'
import { fmtFecha, sumarDias } from './utils'

export type Periodo = { tipo: 'anio' } | { tipo: 'trimestre'; q: number } | { tipo: 'mes'; m: number } | { tipo: 'semana'; desde: string }

/** Lunes de la semana de una fecha. */
export function lunesDe(iso: string): string {
  const d = diaSemana(iso)
  return sumarDias(iso, d === 0 ? -6 : 1 - d)
}

/** Número de semana ISO (la que usan los calendarios en Argentina y Europa). */
export function numeroSemana(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  const dia = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - dia)
  const inicio = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  return Math.ceil(((t.getTime() - inicio.getTime()) / 86400000 + 1) / 7)
}

/** Primer y último día del período. */
export function rangoPeriodo(p: Periodo, anio: number): [string, string] {
  const f = (m: number, d: number) => `${anio}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  const ultimo = (m: number) => new Date(Date.UTC(anio, m + 1, 0)).getUTCDate()
  if (p.tipo === 'semana') return [p.desde, sumarDias(p.desde, 6)]
  if (p.tipo === 'mes') return [f(p.m, 1), f(p.m, ultimo(p.m))]
  if (p.tipo === 'trimestre') return [f(p.q * 3, 1), f(p.q * 3 + 2, ultimo(p.q * 3 + 2))]
  return [`${anio}-01-01`, `${anio}-12-31`]
}

export function mesesDe(p: Periodo): number[] {
  if (p.tipo === 'semana') return []
  if (p.tipo === 'anio') return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
  if (p.tipo === 'trimestre') return [p.q * 3, p.q * 3 + 1, p.q * 3 + 2]
  return [p.m]
}

export function nombrePeriodo(p: Periodo, anio: number): string {
  if (p.tipo === 'semana') return `Semana ${numeroSemana(p.desde)} · del ${fmtFecha(p.desde).slice(0, 5)} al ${fmtFecha(sumarDias(p.desde, 6))}`
  if (p.tipo === 'anio') return `Año ${anio}`
  if (p.tipo === 'trimestre') return `${p.q + 1}° trimestre ${anio} (${MESES[p.q * 3]} a ${MESES[p.q * 3 + 2]})`
  return `${MESES[p.m]} ${anio}`
}

const W = 2339 // A4 apaisado a ~200 dpi
const H = 1654
const TINTA = '#0f172a'
const GRIS = '#64748b'
const LINEA = '#cbd5e1'
const FINDE = '#f1f5f9'
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif'

const tiposDelDia = (evs: Evento[]): TipoEvento[] => {
  const orden: TipoEvento[] = ['feriado_nac', 'feriado', 'vacaciones', 'licencia', 'permiso', 'reunion', 'cumple', 'otro']
  const set = new Set<TipoEvento>(evs.map((e) => (e.tipo === 'feriado' ? 'feriado_nac' : e.tipo)))
  return orden.filter((t) => set.has(t))
}

function recortar(ctx: CanvasRenderingContext2D, s: string, max: number): string {
  if (ctx.measureText(s).width <= max) return s
  let t = s
  while (t.length > 1 && ctx.measureText(t + '…').width > max) t = t.slice(0, -1)
  return t + '…'
}

export function dibujarCalendario(opts: {
  anio: number
  periodo: Periodo
  porDia: Map<string, Evento[]>
  subtitulo?: string
}): HTMLCanvasElement {
  const { anio, periodo, porDia } = opts
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  const ctx = cv.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, W, H)
  ctx.textBaseline = 'alphabetic'

  // Encabezado
  const M = 70
  ctx.fillStyle = TINTA
  ctx.font = `700 54px ${FONT}`
  ctx.fillText(`DE&CO · Calendario de personal`, M, 105)
  ctx.font = `500 38px ${FONT}`
  ctx.fillStyle = '#245153'
  ctx.fillText(nombrePeriodo(periodo, anio), M, 158)
  ctx.font = `400 26px ${FONT}`
  ctx.fillStyle = GRIS
  ctx.textAlign = 'right'
  ctx.fillText(`Generado el ${new Date().toLocaleDateString('es-AR')}`, W - M, 105)
  if (opts.subtitulo) ctx.fillText(recortar(ctx, opts.subtitulo, 1100), W - M, 158)
  ctx.textAlign = 'left'
  ctx.strokeStyle = TINTA
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.moveTo(M, 185)
  ctx.lineTo(W - M, 185)
  ctx.stroke()

  // Leyenda
  const leyenda: TipoEvento[] = ['vacaciones', 'licencia', 'permiso', 'reunion', 'feriado_nac', 'cumple', 'otro']
  let lx = M
  const ly = H - 55
  ctx.font = `500 26px ${FONT}`
  for (const t of leyenda) {
    ctx.fillStyle = TIPOS[t].color
    ctx.fillRect(lx, ly - 22, 28, 28)
    ctx.fillStyle = TINTA
    ctx.fillText(TIPOS[t].label, lx + 40, ly)
    lx += 40 + ctx.measureText(TIPOS[t].label).width + 48
  }
  ctx.fillStyle = GRIS
  ctx.font = `400 22px ${FONT}`
  ctx.textAlign = 'right'
  ctx.fillText('Pendientes = borde punteado · Licencias sin detalle (dato reservado)', W - M, ly)
  ctx.textAlign = 'left'

  const top = 220
  const bottom = H - 110
  const meses = mesesDe(periodo)

  if (periodo.tipo === 'semana') {
    semanaGrande(ctx, periodo.desde, M, top, W - 2 * M, bottom - top, porDia)
  } else if (periodo.tipo === 'anio') {
    const cols = 4
    const rows = 3
    const gx = 40
    const gy = 30
    const mw = (W - 2 * M - gx * (cols - 1)) / cols
    const mh = (bottom - top - gy * (rows - 1)) / rows
    meses.forEach((m, i) => mesChico(ctx, anio, m, M + (i % cols) * (mw + gx), top + Math.floor(i / cols) * (mh + gy), mw, mh, porDia))
  } else {
    const n = meses.length
    const gx = 40
    const mw = (W - 2 * M - gx * (n - 1)) / n
    meses.forEach((m, i) => mesGrande(ctx, anio, m, M + i * (mw + gx), top, mw, bottom - top, porDia, n === 1 ? 5 : 3))
  }
  return cv
}

const DIAS_LARGOS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']

/** Parte un texto en renglones que entren en el ancho. */
function renglones(ctx: CanvasRenderingContext2D, s: string, max: number, maxLineas: number): string[] {
  const palabras = s.split(' ')
  const out: string[] = []
  let actual = ''
  for (const p of palabras) {
    const prueba = actual ? `${actual} ${p}` : p
    if (ctx.measureText(prueba).width <= max) actual = prueba
    else {
      if (actual) out.push(actual)
      actual = p
    }
  }
  if (actual) out.push(actual)
  if (out.length > maxLineas) {
    const r = out.slice(0, maxLineas)
    r[maxLineas - 1] = recortar(ctx, out.slice(maxLineas - 1).join(' '), max)
    return r
  }
  return out.map((l) => recortar(ctx, l, max))
}

function semanaGrande(ctx: CanvasRenderingContext2D, lunes: string, x: number, y: number, w: number, h: number, porDia: Map<string, Evento[]>) {
  const gx = 14
  const cw = (w - gx * 6) / 7
  const cabH = 92
  for (let i = 0; i < 7; i++) {
    const f = sumarDias(lunes, i)
    const cx = x + i * (cw + gx)
    const evs = (porDia.get(f) ?? []).slice().sort((a, b) => {
      const pa = a.tipo === 'feriado_nac' || a.tipo === 'feriado' ? 0 : a.tipo === 'reunion' ? 1 : 2
      const pb = b.tipo === 'feriado_nac' || b.tipo === 'feriado' ? 0 : b.tipo === 'reunion' ? 1 : 2
      return pa - pb || a.titulo.localeCompare(b.titulo)
    })
    const finde = i >= 5
    const feriado = evs.some((e) => e.tipo === 'feriado_nac' || e.tipo === 'feriado')
    // fondo de la columna
    ctx.fillStyle = feriado ? '#fef2f2' : finde ? FINDE : '#ffffff'
    ctx.fillRect(cx, y, cw, h)
    ctx.strokeStyle = LINEA
    ctx.lineWidth = 2
    ctx.strokeRect(cx, y, cw, h)
    // encabezado del día
    ctx.fillStyle = feriado ? '#b91c1c' : TINTA
    ctx.font = `700 34px ${FONT}`
    ctx.fillText(DIAS_LARGOS[diaSemana(f)], cx + 16, y + 44)
    ctx.font = `500 28px ${FONT}`
    ctx.fillStyle = feriado ? '#b91c1c' : GRIS
    ctx.fillText(fmtFecha(f), cx + 16, y + 78)
    ctx.strokeStyle = LINEA
    ctx.beginPath()
    ctx.moveTo(cx, y + cabH)
    ctx.lineTo(cx + cw, y + cabH)
    ctx.stroke()
    // eventos
    let ey = y + cabH + 12
    const maxY = y + h - 12
    const anchoTexto = cw - 40
    let mostrados = 0
    for (const e of evs) {
      ctx.font = `600 23px ${FONT}`
      const lineas = renglones(ctx, e.estado === 'pendiente' ? `${e.titulo} (pendiente)` : e.titulo, anchoTexto, 3)
      const sub = [e.hora, e.desde !== e.hasta ? `${fmtFecha(e.desde).slice(0, 5)} al ${fmtFecha(e.hasta).slice(0, 5)}` : ''].filter(Boolean).join(' · ')
      const alto = 14 + lineas.length * 29 + (sub ? 28 : 0) + 6
      if (ey + alto > maxY - 34 && mostrados < evs.length - 1) {
        ctx.fillStyle = GRIS
        ctx.font = `600 22px ${FONT}`
        ctx.fillText(`+${evs.length - mostrados} más`, cx + 16, ey + 26)
        break
      }
      const color = TIPOS[e.tipo].color
      ctx.fillStyle = color
      ctx.globalAlpha = 0.12
      ctx.fillRect(cx + 10, ey, cw - 20, alto)
      ctx.globalAlpha = 1
      ctx.fillRect(cx + 10, ey, 7, alto)
      if (e.estado === 'pendiente') {
        ctx.setLineDash([8, 6])
        ctx.strokeStyle = color
        ctx.lineWidth = 2
        ctx.strokeRect(cx + 10, ey, cw - 20, alto)
        ctx.setLineDash([])
      }
      ctx.fillStyle = TINTA
      ctx.font = `600 23px ${FONT}`
      lineas.forEach((l, k) => ctx.fillText(l, cx + 28, ey + 34 + k * 29))
      if (sub) {
        ctx.fillStyle = GRIS
        ctx.font = `400 20px ${FONT}`
        ctx.fillText(recortar(ctx, sub, anchoTexto), cx + 28, ey + 34 + lineas.length * 29 + 2)
      }
      ey += alto + 10
      mostrados++
    }
    if (!evs.length) {
      ctx.fillStyle = '#94a3b8'
      ctx.font = `400 22px ${FONT}`
      ctx.fillText('Sin novedades', cx + 16, y + cabH + 44)
    }
  }
}

function mesChico(ctx: CanvasRenderingContext2D, anio: number, m: number, x: number, y: number, w: number, h: number, porDia: Map<string, Evento[]>) {
  ctx.fillStyle = TINTA
  ctx.font = `700 30px ${FONT}`
  ctx.fillText(MESES[m], x, y + 30)
  const cab = ['L', 'M', 'M', 'J', 'V', 'S', 'D']
  const cw = w / 7
  ctx.font = `600 20px ${FONT}`
  ctx.fillStyle = GRIS
  ctx.textAlign = 'center'
  cab.forEach((c, i) => ctx.fillText(c, x + cw * i + cw / 2, y + 62))
  const celdas = celdasMes(anio, m)
  const filas = celdas.length / 7
  const y0 = y + 74
  const ch = (h - 74) / 6
  celdas.forEach((f, i) => {
    const cx = x + (i % 7) * cw
    const cy = y0 + Math.floor(i / 7) * ch
    if (!f) return
    const evs = porDia.get(f) ?? []
    const tipos = tiposDelDia(evs)
    const finde = diaSemana(f) === 0 || diaSemana(f) === 6
    const feriado = tipos.includes('feriado_nac')
    ctx.fillStyle = feriado ? '#fee2e2' : finde ? FINDE : '#ffffff'
    ctx.fillRect(cx + 1, cy + 1, cw - 2, ch - 2)
    ctx.fillStyle = feriado ? '#b91c1c' : finde ? GRIS : TINTA
    ctx.font = `${feriado ? 700 : 500} 22px ${FONT}`
    ctx.fillText(String(Number(f.slice(8))), cx + cw / 2, cy + ch * 0.48)
    // Franjas de color por tipo de evento (sin el feriado, que ya pinta la celda)
    const marcas = tipos.filter((t) => t !== 'feriado_nac').slice(0, 4)
    const sw = (cw - 10) / Math.max(1, marcas.length)
    marcas.forEach((t, k) => {
      ctx.fillStyle = TIPOS[t].color
      ctx.fillRect(cx + 5 + k * sw, cy + ch - 14, sw - 2, 8)
    })
  })
  void filas
  ctx.textAlign = 'left'
}

function mesGrande(
  ctx: CanvasRenderingContext2D,
  anio: number,
  m: number,
  x: number,
  y: number,
  w: number,
  h: number,
  porDia: Map<string, Evento[]>,
  maxLineas: number,
) {
  ctx.fillStyle = TINTA
  ctx.font = `700 36px ${FONT}`
  ctx.fillText(MESES[m], x, y + 34)
  const cab = maxLineas > 3 ? ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'] : ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']
  const cw = w / 7
  ctx.font = `600 22px ${FONT}`
  ctx.fillStyle = GRIS
  cab.forEach((c, i) => ctx.fillText(c, x + cw * i + 8, y + 72))
  const celdas = celdasMes(anio, m)
  const filas = celdas.length / 7
  const y0 = y + 86
  const ch = (h - 86) / filas
  const fs = maxLineas > 3 ? 21 : 17
  const lh = fs + 9
  celdas.forEach((f, i) => {
    const cx = x + (i % 7) * cw
    const cy = y0 + Math.floor(i / 7) * ch
    ctx.strokeStyle = LINEA
    ctx.lineWidth = 1.5
    ctx.strokeRect(cx, cy, cw, ch)
    if (!f) return
    const evs = (porDia.get(f) ?? []).slice().sort((a, b) => (a.tipo === 'feriado_nac' ? -1 : b.tipo === 'feriado_nac' ? 1 : 0))
    const finde = diaSemana(f) === 0 || diaSemana(f) === 6
    const feriado = evs.some((e) => e.tipo === 'feriado_nac' || e.tipo === 'feriado')
    if (feriado || finde) {
      ctx.fillStyle = feriado ? '#fef2f2' : FINDE
      ctx.fillRect(cx + 1, cy + 1, cw - 2, ch - 2)
    }
    ctx.fillStyle = feriado ? '#b91c1c' : TINTA
    ctx.font = `700 24px ${FONT}`
    ctx.fillText(String(Number(f.slice(8))), cx + 8, cy + 30)
    const caben = Math.max(0, Math.min(maxLineas, Math.floor((ch - 42) / lh)))
    const mostrar = evs.length > caben ? caben - 1 : caben
    evs.slice(0, Math.max(0, mostrar)).forEach((e, k) => {
      const ty = cy + 40 + k * lh
      const color = TIPOS[e.tipo].color
      ctx.fillStyle = color
      ctx.globalAlpha = 0.14
      ctx.fillRect(cx + 5, ty, cw - 10, lh - 3)
      ctx.globalAlpha = 1
      ctx.fillRect(cx + 5, ty, 6, lh - 3)
      if (e.estado === 'pendiente') {
        ctx.setLineDash([6, 4])
        ctx.strokeStyle = color
        ctx.strokeRect(cx + 5, ty, cw - 10, lh - 3)
        ctx.setLineDash([])
      }
      ctx.fillStyle = TINTA
      ctx.font = `500 ${fs}px ${FONT}`
      ctx.fillText(recortar(ctx, e.titulo, cw - 26), cx + 16, ty + fs + 1)
    })
    if (evs.length > mostrar && caben > 0) {
      ctx.fillStyle = GRIS
      ctx.font = `600 ${fs}px ${FONT}`
      ctx.fillText(`+${evs.length - Math.max(0, mostrar)} más`, cx + 12, cy + 40 + Math.max(0, mostrar) * lh + fs)
    }
  })
}

// ---------------------------------------------------------------------
// PDF de una página con la imagen JPEG del calendario (A4 apaisado)
// ---------------------------------------------------------------------
export function pdfConImagen(jpeg: Uint8Array, wPx: number, hPx: number): Uint8Array {
  const enc = new TextEncoder()
  const PW = 842
  const PH = 595
  const margen = 18
  const esc = Math.min((PW - 2 * margen) / wPx, (PH - 2 * margen) / hPx)
  const iw = wPx * esc
  const ih = hPx * esc
  const ix = (PW - iw) / 2
  const iy = (PH - ih) / 2
  const contenido = `q ${iw.toFixed(2)} 0 0 ${ih.toFixed(2)} ${ix.toFixed(2)} ${iy.toFixed(2)} cm /Im0 Do Q`
  const partes: Uint8Array[] = []
  const offsets: number[] = []
  let len = 0
  const add = (b: Uint8Array | string) => {
    const u = typeof b === 'string' ? enc.encode(b) : b
    partes.push(u)
    len += u.length
  }
  add('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')
  const obj = (n: number, cuerpo: string) => {
    offsets[n] = len
    add(`${n} 0 obj\n${cuerpo}\nendobj\n`)
  }
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`)
  offsets[4] = len
  add(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${wPx} /Height ${hPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`)
  add(jpeg)
  add('\nendstream\nendobj\n')
  obj(5, `<< /Length ${contenido.length} >>\nstream\n${contenido}\nendstream`)
  const xref = len
  add(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((n) => `${String(offsets[n]).padStart(10, '0')} 00000 n \n`).join('')}`)
  add(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  const out = new Uint8Array(len)
  let o = 0
  for (const p of partes) {
    out.set(p, o)
    o += p.length
  }
  return out
}

export async function canvasA(cv: HTMLCanvasElement, tipo: 'image/png' | 'image/jpeg', calidad = 0.92): Promise<Blob> {
  return new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('No se pudo generar la imagen'))), tipo, calidad))
}

export function descargar(datos: Blob | Uint8Array | string, nombre: string, mime: string) {
  const blob = datos instanceof Blob ? datos : new Blob([datos as BlobPart], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = nombre
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}
