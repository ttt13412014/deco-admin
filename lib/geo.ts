// Ubicación de direcciones y ordenado automático de rutas (sin API pagas).

export type Coord = { lat: number; lng: number }

/** "-31.41,-64.18" → {lat,lng}; cualquier otra cosa → null */
export function parseCoords(s: string | null | undefined): Coord | null {
  const m = (s || '').trim().match(/^(-?\d{1,2}(?:\.\d+)?)\s*[,; ]\s*(-?\d{1,3}(?:\.\d+)?)$/)
  if (!m) return null
  const lat = Number(m[1])
  const lng = Number(m[2])
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
  return { lat, lng }
}

/** Distancia en km en línea recta. */
export function km(a: Coord, b: Coord): number {
  const R = 6371
  const r = Math.PI / 180
  const dLat = (b.lat - a.lat) * r
  const dLng = (b.lng - a.lng) * r
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** Factor para pasar de línea recta a distancia por calle (aprox. ciudad/ruta en Córdoba). */
export const FACTOR_CALLE = 1.3
/** Velocidad media estimada de reparto (km/h) y minutos por parada. */
export const VEL_KMH = 35
export const MIN_POR_PARADA = 10

// ---------------------------------------------------------------------
// Geocodificación con OpenStreetMap (Nominatim): gratis, 1 consulta por segundo.
// Se guarda en caché del navegador y en la base (clientes.lat/lng) para no repetir.
// ---------------------------------------------------------------------
const CACHE_KEY = 'deco_geo_cache_v1'
let ultima = 0

function leerCache(): Record<string, Coord | null> {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}')
  } catch {
    return {}
  }
}
function guardarCache(k: string, v: Coord | null) {
  try {
    const c = leerCache()
    c[k] = v
    localStorage.setItem(CACHE_KEY, JSON.stringify(c))
  } catch {}
}

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function nominatim(q: string): Promise<Coord | null> {
  const dt = Date.now() - ultima
  if (dt < 1100) await espera(1100 - dt)
  ultima = Date.now()
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ar&accept-language=es&q=${encodeURIComponent(q)}`
  const r = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!r.ok) throw new Error(`Geocodificación: ${r.status}`)
  const j = (await r.json()) as { lat: string; lon: string }[]
  return j[0] ? { lat: Number(j[0].lat), lng: Number(j[0].lon) } : null
}

/**
 * Devuelve las coordenadas de una dirección. Si no la encuentra exacta,
 * prueba sin el número de calle y después solo la localidad (marca aprox=true).
 */
export async function geocodificar(direccion: string): Promise<(Coord & { aprox?: boolean }) | null> {
  const directa = parseCoords(direccion)
  if (directa) return directa
  const k = direccion.trim().toLowerCase()
  const cache = leerCache()
  if (k in cache) return cache[k]

  let res: (Coord & { aprox?: boolean }) | null = await nominatim(direccion)
  if (!res) {
    const partes = direccion.split(',').map((x) => x.trim()).filter(Boolean)
    if (partes.length > 1) {
      // Sin la calle: solo localidad/provincia → ubicación aproximada
      const loc = await nominatim(partes.slice(1).join(', '))
      if (loc) res = { ...loc, aprox: true }
    }
  }
  guardarCache(k, res)
  return res
}

// ---------------------------------------------------------------------
// Ordenado: vecino más cercano + mejora 2-opt (saca cruces del recorrido)
// ---------------------------------------------------------------------

/**
 * Devuelve el orden (índices de `puntos`) que minimiza el recorrido
 * saliendo de `origen` y, si `volver`, regresando a él.
 */
export function optimizarOrden(origen: Coord, puntos: Coord[], volver: boolean): number[] {
  const n = puntos.length
  if (n <= 1) return puntos.map((_, i) => i)
  const nodos = [origen, ...puntos] // 0 = depósito
  const D = nodos.map((a) => nodos.map((b) => km(a, b)))
  const largo = (r: number[]) => {
    let t = D[0][r[0]]
    for (let i = 1; i < r.length; i++) t += D[r[i - 1]][r[i]]
    return volver ? t + D[r[r.length - 1]][0] : t
  }

  // Pocas paradas: se prueban todas las combinaciones (resultado exacto)
  if (n <= 8) {
    const ids = puntos.map((_, i) => i + 1)
    let mejor = ids
    let dMejor = largo(ids)
    const usado = new Array(n + 1).fill(false)
    const actual: number[] = []
    const probar = (parcial: number) => {
      if (parcial >= dMejor) return
      if (actual.length === n) {
        const tot = volver ? parcial + D[actual[n - 1]][0] : parcial
        if (tot < dMejor) (dMejor = tot), (mejor = [...actual])
        return
      }
      const prev = actual.length ? actual[actual.length - 1] : 0
      for (const j of ids) {
        if (usado[j]) continue
        usado[j] = true
        actual.push(j)
        probar(parcial + D[prev][j])
        actual.pop()
        usado[j] = false
      }
    }
    probar(0)
    return mejor.map((x) => x - 1)
  }

  // 1) Vecino más cercano: siempre el próximo cliente más cerca del actual
  const libres = new Set(puntos.map((_, i) => i + 1))
  const ruta: number[] = [0]
  let actual = 0
  while (libres.size) {
    let mejor = -1
    let dMejor = Infinity
    for (const j of libres) if (D[actual][j] < dMejor) (dMejor = D[actual][j]), (mejor = j)
    ruta.push(mejor)
    libres.delete(mejor)
    actual = mejor
  }
  if (volver) ruta.push(0)

  // 2) 2-opt: si invertir un tramo acorta el recorrido, se invierte
  const fin = volver ? ruta.length - 1 : ruta.length
  let mejoro = true
  let vueltas = 0
  while (mejoro && vueltas++ < 200) {
    mejoro = false
    for (let i = 1; i < fin - 1; i++) {
      for (let k = i + 1; k < fin; k++) {
        const a = ruta[i - 1]
        const b = ruta[i]
        const c = ruta[k]
        const d = k + 1 < ruta.length ? ruta[k + 1] : -1
        const antes = D[a][b] + (d >= 0 ? D[c][d] : 0)
        const despues = D[a][c] + (d >= 0 ? D[b][d] : 0)
        if (despues + 1e-9 < antes) {
          ruta.splice(i, k - i + 1, ...ruta.slice(i, k + 1).reverse())
          mejoro = true
        }
      }
    }
  }
  // 3) Or-opt: probar mover cada parada a otro lugar del recorrido
  let r = ruta.filter((x) => x !== 0)
  let d0 = largo(r)
  let cambio = true
  let pasadas = 0
  while (cambio && pasadas++ < 50) {
    cambio = false
    for (let i = 0; i < r.length; i++) {
      const sin = [...r.slice(0, i), ...r.slice(i + 1)]
      for (let k = 0; k <= sin.length; k++) {
        if (k === i) continue
        const cand = [...sin.slice(0, k), r[i], ...sin.slice(k)]
        const dc = largo(cand)
        if (dc + 1e-9 < d0) {
          r = cand
          d0 = dc
          cambio = true
          break
        }
      }
    }
  }
  return r.map((x) => x - 1)
}

/** Km estimados por calle de un recorrido ya ordenado. */
export function distanciaRuta(origen: Coord, puntos: Coord[], volver: boolean): number {
  if (!puntos.length) return 0
  let t = km(origen, puntos[0])
  for (let i = 1; i < puntos.length; i++) t += km(puntos[i - 1], puntos[i])
  if (volver) t += km(puntos[puntos.length - 1], origen)
  return t * FACTOR_CALLE
}

export function tiempoEstimado(kmCalle: number, paradas: number): string {
  const min = Math.round((kmCalle / VEL_KMH) * 60 + paradas * MIN_POR_PARADA)
  const h = Math.floor(min / 60)
  return h ? `${h} h ${min % 60} min` : `${min} min`
}
