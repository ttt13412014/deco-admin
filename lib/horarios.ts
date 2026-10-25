// Horarios de atención de los clientes y orden de la ruta respetando esos horarios.
import { Coord, FACTOR_CALLE, MIN_POR_PARADA, VEL_KMH, km, optimizarOrden } from './geo'

/** Un horario de atención en minutos desde las 00:00 (ej: 14:00–17:00 → 840–1020). */
export type Ventana = { desde: number; hasta: number }

export const HORA_SALIDA_DEFAULT = '09:00'
export { MIN_POR_PARADA }

/** "9:30", "09:30:00" → 570. Cualquier otra cosa → null. */
export function aMin(s: string | null | undefined): number | null {
  const m = String(s ?? '').trim().match(/^(\d{1,2})(?::(\d{2}))?(?::\d{2})?$/)
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2] ?? 0)
  if (h > 24 || mi > 59 || (h === 24 && mi > 0)) return null
  return h * 60 + mi
}

/** 570 → "09:30" */
export function deMin(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return ''
  const t = Math.round(n)
  const h = Math.floor(t / 60)
  return `${String(h).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

/** "09:30:00" → "09:30" (para inputs type=time). */
export const hhmm = (s: string | null | undefined) => (s ? deMin(aMin(s)) : '')

export interface HorarioCampos {
  horario_desde?: string | null
  horario_hasta?: string | null
  horario2_desde?: string | null
  horario2_hasta?: string | null
}

/** Horarios cargados en el cliente (0, 1 o 2), ordenados. */
export function ventanasDe(c: HorarioCampos | null | undefined): Ventana[] {
  if (!c) return []
  const out: Ventana[] = []
  const par = (a?: string | null, b?: string | null) => {
    const d = aMin(a)
    const h = aMin(b)
    if (d == null && h == null) return
    const v = { desde: d ?? 0, hasta: h ?? 24 * 60 }
    if (v.hasta > v.desde) out.push(v)
  }
  par(c.horario_desde, c.horario_hasta)
  par(c.horario2_desde, c.horario2_hasta)
  return out.sort((a, b) => a.desde - b.desde)
}

export function fmtVentanas(vs: Ventana[]): string {
  return vs.map((v) => `${deMin(v.desde)} a ${deMin(v.hasta)}`).join(' y ')
}

/**
 * Lee el texto libre de "Horarios de atención" y saca hasta 2 franjas:
 * "Lun a Vie 8:30 a 17:00" → 08:30–17:00 · "8 a 12 y 14 a 18hs" → 08:00–12:00 y 14:00–18:00.
 */
export function parsearHorarios(texto: string | null | undefined): Ventana[] {
  const t = String(texto ?? '')
    .toLowerCase()
    .replace(/(\d)\s*hs?\b\.?/g, '$1 ')
    .replace(/\bhoras?\b/g, ' ')
  const re = /(\d{1,2})(?:[:.](\d{2}))?\s*(?:a|-|–|al|hasta)\s*(\d{1,2})(?:[:.](\d{2}))?(?![\d/])/g
  const out: Ventana[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(t)) && out.length < 2) {
    const d = Number(m[1]) * 60 + Number(m[2] ?? 0)
    let h = Number(m[3]) * 60 + Number(m[4] ?? 0)
    if (Number(m[1]) > 24 || Number(m[3]) > 24) continue
    // "14 a 6" no tiene sentido; "8 a 1" (de la tarde) tampoco: se descarta
    if (h <= d && Number(m[3]) < 12) h += 12 * 60
    if (h > d && h <= 24 * 60) out.push({ desde: d, hasta: h })
  }
  return out.sort((a, b) => a.desde - b.desde)
}

/** Ventanas → campos del cliente (time "HH:MM" o null). */
export function camposDeVentanas(vs: Ventana[]): Required<HorarioCampos> {
  return {
    horario_desde: vs[0] ? deMin(vs[0].desde) : null,
    horario_hasta: vs[0] ? deMin(vs[0].hasta) : null,
    horario2_desde: vs[1] ? deMin(vs[1].desde) : null,
    horario2_hasta: vs[1] ? deMin(vs[1].hasta) : null,
  }
}

// ---------------------------------------------------------------------
// Cronograma: a qué hora llega a cada parada
// ---------------------------------------------------------------------
export const minViaje = (a: Coord, b: Coord) => ((km(a, b) * FACTOR_CALLE) / VEL_KMH) * 60

export interface Llegada {
  /** Hora estimada de llegada (min desde 00:00); null si no se puede calcular (sin ubicación). */
  llegada: number | null
  /** Hora en que empieza a atender (si llega antes de que abra, espera). */
  inicio: number | null
  espera: number
  /** Llega cuando ya cerró (o entre dos horarios sin poder esperar). */
  fuera: boolean
  ventanas: Ventana[]
}

/** Llegada a una parada: si llega antes de que abra espera; si llega después de que cierre, queda "fuera". */
function atender(llegada: number, vs: Ventana[]): { inicio: number; espera: number; tarde: number } {
  if (!vs.length) return { inicio: llegada, espera: 0, tarde: 0 }
  for (const v of vs) {
    if (llegada <= v.hasta) {
      const inicio = Math.max(llegada, v.desde)
      return { inicio, espera: inicio - llegada, tarde: 0 }
    }
  }
  return { inicio: llegada, espera: 0, tarde: llegada - vs[vs.length - 1].hasta }
}

export function estimarLlegadas(
  origen: Coord | null,
  paradas: { lat: number | null; lng: number | null; ventanas: Ventana[] }[],
  salida: number,
  minParada: number,
): Llegada[] {
  let t = salida
  let pos: Coord | null = origen
  return paradas.map((p) => {
    const aqui = p.lat != null && p.lng != null ? { lat: p.lat, lng: p.lng } : null
    if (!pos || !aqui) {
      // Sin ubicación no se sabe cuánto tarda: se cuenta solo el tiempo de la parada
      t += minParada
      return { llegada: null, inicio: null, espera: 0, fuera: false, ventanas: p.ventanas }
    }
    const llegada = t + minViaje(pos, aqui)
    const a = atender(llegada, p.ventanas)
    t = a.inicio + minParada
    pos = aqui
    return { llegada, inicio: a.inicio, espera: a.espera, fuera: a.tarde > 0, ventanas: p.ventanas }
  })
}

// ---------------------------------------------------------------------
// Ordenar respetando horarios
// ---------------------------------------------------------------------
type Nodo = { pos: Coord; ventanas: Ventana[] }

/**
 * Costo de un orden: lo que se llega tarde pesa muchísimo (no se puede llegar
 * a un cliente cerrado), después la hora a la que termina el reparto (viaje + esperas).
 */
function costo(orden: number[], origen: Coord, nodos: Nodo[], salida: number, minParada: number, volver: boolean): number {
  let t = salida
  let pos = origen
  let tarde = 0
  let fuera = 0
  for (const i of orden) {
    const n = nodos[i]
    const a = atender(t + minViaje(pos, n.pos), n.ventanas)
    if (a.tarde > 0) (tarde += a.tarde), fuera++
    t = a.inicio + minParada
    pos = n.pos
  }
  if (volver) t += minViaje(pos, origen)
  return fuera * 100000 + tarde * 100 + t
}

/** Siempre al que se puede atender más temprano (llegando + esperando que abra); empate: el más cerca. */
function golosoHorarios(origen: Coord, nodos: Nodo[], salida: number, minParada: number): number[] {
  const libres = new Set(nodos.map((_, i) => i))
  const out: number[] = []
  let t = salida
  let pos = origen
  while (libres.size) {
    let mejor = -1
    let clave = Infinity
    for (const j of libres) {
      const viaje = minViaje(pos, nodos[j].pos)
      const a = atender(t + viaje, nodos[j].ventanas)
      // Si cierra pronto, conviene ir antes: se adelanta a los que cierran en menos de 1 h
      const cierre = nodos[j].ventanas.find((v) => v.hasta >= t + viaje)?.hasta ?? Infinity
      const urgente = cierre - (t + viaje) < 60 ? -30 : 0
      const k = (a.tarde > 0 ? 10000 + a.tarde : 0) + a.inicio + urgente + viaje * 0.01
      if (k < clave) (clave = k), (mejor = j)
    }
    const n = nodos[mejor]
    const a = atender(t + minViaje(pos, n.pos), n.ventanas)
    t = a.inicio + minParada
    pos = n.pos
    out.push(mejor)
    libres.delete(mejor)
  }
  return out
}

/** Mejora un orden moviendo cada parada a otro lugar o intercambiando pares, mientras baje el costo. */
function mejorar(orden: number[], f: (o: number[]) => number): number[] {
  let r = [...orden]
  let c = f(r)
  let cambio = true
  let pasadas = 0
  while (cambio && pasadas++ < 40) {
    cambio = false
    for (let i = 0; i < r.length; i++) {
      const sin = [...r.slice(0, i), ...r.slice(i + 1)]
      for (let k = 0; k <= sin.length; k++) {
        if (k === i) continue
        const cand = [...sin.slice(0, k), r[i], ...sin.slice(k)]
        const cc = f(cand)
        if (cc + 1e-6 < c) {
          r = cand
          c = cc
          cambio = true
          break
        }
      }
    }
    for (let i = 0; i < r.length; i++) {
      for (let k = i + 1; k < r.length; k++) {
        const cand = [...r]
        ;[cand[i], cand[k]] = [cand[k], cand[i]]
        const cc = f(cand)
        if (cc + 1e-6 < c) (r = cand), (c = cc), (cambio = true)
      }
    }
  }
  return r
}

/**
 * Orden de las paradas (índices) respetando los horarios de atención.
 * Sin ningún horario cargado es igual al orden por distancia de siempre.
 */
export function ordenarConHorarios(origen: Coord, nodos: Nodo[], salida: number, minParada: number, volver: boolean): number[] {
  const n = nodos.length
  const porDistancia = optimizarOrden(origen, nodos.map((x) => x.pos), volver)
  if (n <= 1 || !nodos.some((x) => x.ventanas.length)) return porDistancia
  const f = (o: number[]) => costo(o, origen, nodos, salida, minParada, volver)

  if (n <= 8) {
    // Pocas paradas: se prueban todas las combinaciones
    let mejor = porDistancia
    let cMejor = f(mejor)
    const usado = new Array(n).fill(false)
    const actual: number[] = []
    const probar = () => {
      if (actual.length === n) {
        const c = f(actual)
        if (c < cMejor) (cMejor = c), (mejor = [...actual])
        return
      }
      for (let j = 0; j < n; j++) {
        if (usado[j]) continue
        usado[j] = true
        actual.push(j)
        probar()
        actual.pop()
        usado[j] = false
      }
    }
    probar()
    return mejor
  }

  const candidatos = [porDistancia, golosoHorarios(origen, nodos, salida, minParada)].map((o) => mejorar(o, f))
  return candidatos.reduce((a, b) => (f(b) < f(a) ? b : a))
}

/** Sin mapa: ordena por hora de apertura (los que no tienen horario quedan donde estaban, al principio). */
export function ordenarSoloPorHorario<T>(items: T[], ventanas: (x: T) => Ventana[]): T[] {
  return items
    .map((x, i) => ({ x, i, d: ventanas(x)[0]?.desde ?? -1 }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map((y) => y.x)
}
