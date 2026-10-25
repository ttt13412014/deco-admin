'use client'

import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { sb, errMsg } from '@/lib/supabase'
import type { HojaRuta, Parada } from '@/lib/types'
import { copiar, fmtFecha, fmtFechaHora, fmtFechaLarga, fmtMoney, hoy, waLink } from '@/lib/utils'
import {
  ClienteRuta, ESTADO_HOJA, ESTADO_PARADA, FORMAS_PAGO, LineaRapida, MAX_WAYPOINTS, clientePorFactura, estadoParada, labelFormaPago, linksMaps,
  horaAR, mensajeEnCamino, mensajeLinkChofer, norm, paradaDesdeCliente, parsearCargaRapida, textoChofer, totalesCobro, totalesRuta, urlChofer,
} from '@/lib/rutas'
import {
  HORA_SALIDA_DEFAULT, Llegada, MIN_POR_PARADA, Ventana, aMin, deMin, estimarLlegadas, fmtVentanas, hhmm, ordenarConHorarios,
  ordenarSoloPorHorario, ventanasDe,
} from '@/lib/horarios'
import { MARCA_PENDIENTE, MarcarParada, ResumenMarca, type Marca } from '@/components/MarcarParada'
import { comprobanteDesdeLectura, etiquetaComprobante, sumaComprobantes, type ComprobanteRuta } from '@/lib/factura-pdf'
import { leerFacturaPdf } from '@/lib/pdf-texto'
import { CargaFacturas, ComprobanteParaRuta, ListaComprobantes, MontoInput } from '@/components/RutaFacturas'
import { Coord, distanciaRuta, geocodificar, tiempoEstimado } from '@/lib/geo'
import { useAuth } from '@/components/AuthProvider'
import { BotonWhatsappInforme, InformeRuta } from '@/components/InformeRuta'
import { Alert, Badge, Button, Card, Empty, Field, PageHeader, Spinner, cx, inputCls } from '@/components/ui'

type P = Parada & { _k: string }
type Datos = Pick<
  HojaRuta,
  'fecha' | 'nombre' | 'chofer' | 'chofer_telefono' | 'origen' | 'volver_origen' | 'observaciones' | 'hora_salida' | 'min_por_parada' | 'token_chofer' | 'finalizada_at' | 'finalizada_por'
> & {
  id?: string
  estado: HojaRuta['estado']
  created_at?: string
}

const ORIGEN_KEY = 'deco_origen_ruta'
const key = () => Math.random().toString(36).slice(2)
const leerOrigen = () => {
  try {
    return localStorage.getItem(ORIGEN_KEY) ?? ''
  } catch {
    return ''
  }
}

const CLIENTE_SELECT = 'id,razon_social,cuit_dni,direccion,localidad,provincia,ubicacion,telefono,contacto_nombre,lat,lng,horarios,horario_desde,horario_hasta,horario2_desde,horario2_hasta'
/** Lo que marca el chofer: se refresca solo y no lo pisa el "Guardar" de la hoja. */
const CAMPOS_ENTREGA =
  'id,entregado,entregado_at,nota_entrega,resultado,motivo,monto_cobrado,forma_pago,marcado_at,marcado_por,devolucion_detalle,devolucion_motivo,devolucion_monto'
const SIN_ENTREGA = {
  entregado: false, entregado_at: null, nota_entrega: null, resultado: null, motivo: null, monto_cobrado: null, forma_pago: null,
  marcado_at: null, marcado_por: null, llegada_estimada: null, devolucion_detalle: null, devolucion_motivo: null, devolucion_monto: null,
} as const
const num = (v: unknown) => (v == null || v === '' ? null : Number(v))
const AUTO_KEY = 'deco_ruta_auto'
const leerAuto = () => {
  try {
    return localStorage.getItem(AUTO_KEY) !== '0'
  } catch {
    return true
  }
}

export default function HojaRutaPage() {
  const { id } = useParams<{ id: string }>()
  const esNueva = id === 'nueva'
  const router = useRouter()
  const { puedeEditar, puedeArmarRutas, puedeCargarClientes, perfil } = useAuth()

  const [h, setH] = useState<Datos | null>(null)
  const [paradas, setParadas] = useState<P[]>([])
  const [clientes, setClientes] = useState<ClienteRuta[]>([])
  const [dirty, setDirty] = useState(false)
  const [tab, setTab] = useState<'buscar' | 'rapida' | 'facturas' | 'manual'>('rapida')
  /** null = verificando; false = falta correr la migración 09 (los montos no se pueden guardar). */
  const [montosOk, setMontosOk] = useState<boolean | null>(null)
  const [msg, setMsg] = useState<{ tone: 'green' | 'red' | 'amber' | 'blue'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [noExiste, setNoExiste] = useState(false)
  const [ordenando, setOrdenando] = useState<string | null>(null)
  const [autoOrden, setAutoOrden] = useState(true)
  const [aprox, setAprox] = useState<Set<string>>(new Set())
  const [origenPos, setOrigenPos] = useState<{ dir: string; pos: Coord | null } | null>(null)
  const [marcando, setMarcando] = useState<string | null>(null)
  const [linkBusy, setLinkBusy] = useState(false)
  const [finBusy, setFinBusy] = useState(false)
  /** Qué sale por la impresora: la hoja de ruta o el informe de la ruta. */
  const [impresion, setImpresion] = useState<'hoja' | 'informe'>('hoja')

  useEffect(() => setAutoOrden(leerAuto()), [])
  useEffect(() => {
    const f = () => setImpresion('hoja')
    window.addEventListener('afterprint', f)
    return () => window.removeEventListener('afterprint', f)
  }, [])

  const cargar = useCallback(async () => {
    const s = sb()
    const [cl, chk] = await Promise.all([
      s.from('clientes').select(CLIENTE_SELECT).neq('estado', 'inhabilitado').order('razon_social'),
      // ¿Ya se corrió la migración 09 (montos de factura)?
      s.from('hoja_ruta_paradas').select('monto_factura,comprobantes').limit(1),
    ])
    setClientes((cl.data as ClienteRuta[]) ?? [])
    setMontosOk(!(chk.error && /monto_factura|comprobantes|column|42703|PGRST20/i.test(`${chk.error.code} ${chk.error.message}`)))

    const copiarDe = esNueva ? new URLSearchParams(window.location.search).get('copiar') : null
    const buscar = esNueva ? copiarDe : id
    if (!buscar) {
      setH({
        fecha: hoy(), nombre: '', chofer: '', chofer_telefono: '', origen: leerOrigen(), volver_origen: true, observaciones: '', estado: 'borrador',
        hora_salida: HORA_SALIDA_DEFAULT, min_por_parada: MIN_POR_PARADA, token_chofer: null, finalizada_at: null, finalizada_por: null,
      })
      setParadas([])
      return
    }
    const { data } = await s.from('hojas_ruta').select('*, paradas:hoja_ruta_paradas(*)').eq('id', buscar).maybeSingle()
    if (!data) return setNoExiste(true)
    const hr0 = data as HojaRuta
    const hr: HojaRuta = {
      ...hr0,
      hora_salida: hhmm(hr0.hora_salida) || HORA_SALIDA_DEFAULT,
      min_por_parada: hr0.min_por_parada ?? MIN_POR_PARADA,
    }
    const ps = [...(hr.paradas ?? [])]
      .sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0))
      .map((p) => ({
        ...p,
        monto_factura: num(p.monto_factura),
        monto_cobrado: num(p.monto_cobrado),
        devolucion_monto: num(p.devolucion_monto),
        llegada_estimada: hhmm(p.llegada_estimada) || null,
        comprobantes: Array.isArray(p.comprobantes) ? p.comprobantes : [],
      }))
    if (copiarDe) {
      setH({ ...hr, id: undefined, fecha: hoy(), estado: 'borrador', token_chofer: null, finalizada_at: null, finalizada_por: null })
      // Las facturas son de otro día: la copia arranca sin montos ni entregas
      setParadas(ps.map((p) => ({ ...p, ...SIN_ENTREGA, id: undefined, monto_factura: null, comprobantes: [], _k: key() })))
      setDirty(true)
      setMsg({ tone: 'blue', text: 'Copia de una hoja anterior. Revisá qué lleva cada uno, cargá las facturas del día y guardá.' })
    } else {
      setH(hr)
      setParadas(ps.map((p) => ({ ...p, _k: p.id ?? key() })))
      setDirty(false)
    }
  }, [id, esNueva])

  useEffect(() => {
    cargar()
  }, [cargar])

  // Avisar si se va con cambios sin guardar
  useEffect(() => {
    if (!dirty) return
    const f = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', f)
    return () => window.removeEventListener('beforeunload', f)
  }, [dirty])

  const tramos = useMemo(
    () => (h?.origen.trim() && paradas.some((p) => p.direccion.trim()) ? linksMaps(h.origen, paradas.filter((p) => p.direccion.trim()).map((p) => p.direccion), h.volver_origen) : []),
    [h?.origen, h?.volver_origen, paradas],
  )

  // Horario de atención de cada parada (del cliente)
  const ventanasCli = useMemo(() => new Map(clientes.map((c) => [c.id, ventanasDe(c)])), [clientes])
  const ventanasP = useCallback((p: Parada): Ventana[] => (p.cliente_id ? ventanasCli.get(p.cliente_id) ?? [] : []), [ventanasCli])

  // Ubica el depósito (queda en caché) para estimar la hora de llegada a cada parada
  const hayUbicadas = paradas.some((p) => p.lat != null && p.lng != null)
  useEffect(() => {
    const dir = h?.origen.trim()
    if (!dir || !hayUbicadas || origenPos?.dir === h?.origen) return
    let vivo = true
    const t = setTimeout(() => {
      geocodificar(dir)
        .catch(() => null)
        .then((pos) => vivo && setOrigenPos({ dir: h!.origen, pos }))
    }, 800)
    return () => {
      vivo = false
      clearTimeout(t)
    }
  }, [h?.origen, hayUbicadas, origenPos?.dir]) // eslint-disable-line react-hooks/exhaustive-deps

  const salidaMin = aMin(h?.hora_salida) ?? aMin(HORA_SALIDA_DEFAULT)!
  const minParada = h?.min_por_parada ?? MIN_POR_PARADA
  const llegadas: Llegada[] = useMemo(
    () =>
      estimarLlegadas(
        origenPos && h && origenPos.dir === h.origen ? origenPos.pos : null,
        paradas.map((p) => ({ lat: p.lat, lng: p.lng, ventanas: ventanasP(p) })),
        salidaMin,
        minParada,
      ),
    [origenPos, h, paradas, ventanasP, salidaMin, minParada],
  )

  /** Trae lo que marcó el chofer (sin tocar lo que se está editando). */
  const refrescarEntregas = useCallback(async () => {
    if (!h?.id) return
    const s = sb()
    const [{ data }, { data: hd }] = await Promise.all([
      s.from('hoja_ruta_paradas').select(CAMPOS_ENTREGA).eq('hoja_id', h.id),
      s.from('hojas_ruta').select('estado,finalizada_at,finalizada_por').eq('id', h.id).maybeSingle(),
    ])
    if (!data) return
    const porId = new Map((data as Parada[]).map((x) => [x.id, x]))
    setParadas((ps) =>
      ps.map((p) => {
        const x = p.id ? porId.get(p.id) : undefined
        return x ? { ...p, ...x, monto_cobrado: num(x.monto_cobrado), devolucion_monto: num(x.devolucion_monto) } : p
      }),
    )
    if (hd) {
      const d = hd as Pick<HojaRuta, 'estado' | 'finalizada_at' | 'finalizada_por'>
      setH((x) => (x ? { ...x, estado: d.estado, finalizada_at: d.finalizada_at ?? null, finalizada_por: d.finalizada_por ?? null } : x))
    }
  }, [h?.id])

  useEffect(() => {
    if (!h?.id) return
    const t = setInterval(() => document.visibilityState === 'visible' && refrescarEntregas(), 30000)
    return () => clearInterval(t)
  }, [h?.id, refrescarEntregas])

  if (noExiste) return <Empty>Hoja de ruta no encontrada.</Empty>
  if (!h) return <Spinner />

  const editable = puedeArmarRutas
  const guardada = !!h.id
  const setDato = <K extends keyof Datos>(k: K, v: Datos[K]) => {
    setH((p) => (p ? { ...p, [k]: v } : p))
    setDirty(true)
  }
  const setParada = (k: string, cambios: Partial<P>) => {
    setParadas((ps) => ps.map((p) => (p._k === k ? { ...p, ...cambios } : p)))
    setDirty(true)
  }
  const mover = (i: number, d: -1 | 1) => {
    setParadas((ps) => {
      const n = [...ps]
      const j = i + d
      if (j < 0 || j >= n.length) return ps
      ;[n[i], n[j]] = [n[j], n[i]]
      return n
    })
    setDirty(true)
  }
  const quitar = (k: string) => {
    setParadas((ps) => ps.filter((p) => p._k !== k))
    setDirty(true)
  }
  const agregar = (nuevas: Parada[]) => {
    const lista = [...paradas, ...nuevas.map((p) => ({ ...p, _k: key() }))]
    setParadas(lista)
    setDirty(true)
    if (autoOrden && lista.length > 1) ordenarAuto(lista)
  }

  /** Ubica cada dirección en el mapa y arma el orden más corto: el más cercano primero. */
  async function ordenarAuto(lista: P[] = paradas) {
    if (!h) return
    setMsg(null)
    if (!h.origen.trim()) return setMsg({ tone: 'red', text: 'Cargá el punto de salida (depósito) para ordenar la ruta.' })
    const geo = async (dir: string) => {
      try {
        return await geocodificar(dir)
      } catch {
        return null
      }
    }
    setOrdenando('Ubicando el depósito…')
    const origen = origenPos?.dir === h.origen ? origenPos.pos : await geo(h.origen)
    setOrigenPos({ dir: h.origen, pos: origen })
    const conHorario = lista.filter((p) => ventanasP(p).length).length
    if (!origen) {
      setOrdenando(null)
      if (conHorario) {
        // Sin mapa: al menos que nadie quede antes de su horario
        setParadas(ordenarSoloPorHorario(lista, ventanasP))
        setDirty(true)
        return setMsg({ tone: 'amber', text: 'No pude ubicar el depósito, así que ordené solo por horario de atención (los que abren más tarde, al final). Revisá el orden.' })
      }
      return setMsg({ tone: 'red', text: 'No pude ubicar la dirección del depósito. Probá escribirla más completa o pegá sus coordenadas (ej: -31.4135, -64.1811).' })
    }
    const nuevaAprox = new Set(aprox)
    const ubicadas: P[] = []
    const pendientes = lista.filter((p) => (p.lat == null || p.lng == null) && p.direccion.trim())
    let i = 0
    for (const p of lista) {
      if (p.lat != null && p.lng != null) {
        ubicadas.push(p)
        continue
      }
      if (!p.direccion.trim()) {
        ubicadas.push(p)
        continue
      }
      i++
      setOrdenando(`Ubicando direcciones ${i} de ${pendientes.length}…`)
      const pos = await geo(p.direccion)
      if (pos) {
        if (pos.aprox) nuevaAprox.add(p._k)
        ubicadas.push({ ...p, lat: pos.lat, lng: pos.lng })
        // Se guarda en el cliente para no volver a buscarla (solo si es exacta)
        if (p.cliente_id && puedeCargarClientes && !pos.aprox) {
          sb().from('clientes').update({ lat: pos.lat, lng: pos.lng }).eq('id', p.cliente_id).then(() => {})
        }
      } else ubicadas.push(p)
    }
    const conPos = ubicadas.filter((p) => p.lat != null && p.lng != null)
    const sinPos = ubicadas.filter((p) => p.lat == null || p.lng == null)
    const orden = ordenarConHorarios(
      origen,
      conPos.map((p) => ({ pos: { lat: p.lat!, lng: p.lng! }, ventanas: ventanasP(p) })),
      salidaMin,
      minParada,
      h.volver_origen,
    )
    const final = [...orden.map((j) => conPos[j]), ...ordenarSoloPorHorario(sinPos, ventanasP)]
    const fuera = estimarLlegadas(origen, final.map((p) => ({ lat: p.lat, lng: p.lng, ventanas: ventanasP(p) })), salidaMin, minParada)
      .map((l, j) => (l.fuera ? final[j].destino : null))
      .filter(Boolean)
    setParadas(final)
    setAprox(nuevaAprox)
    setDirty(true)
    setOrdenando(null)
    const kmT = distanciaRuta(origen, orden.map((j) => ({ lat: conPos[j].lat!, lng: conPos[j].lng! })), h.volver_origen)
    setMsg({
      tone: sinPos.length || fuera.length ? 'amber' : 'green',
      text:
        (conHorario
          ? `Ruta ordenada por cercanía respetando los horarios de atención (salida ${deMin(salidaMin)}): ${conPos.length} paradas · ≈ ${Math.round(kmT)} km.`
          : `Ruta ordenada del más cercano al más lejano: ${conPos.length} paradas · ≈ ${Math.round(kmT)} km · ≈ ${tiempoEstimado(kmT, conPos.length)}.`) +
        (fuera.length ? ` Ojo: no llega en horario a ${fuera.join(', ')}. Probá salir antes o sacar alguna parada.` : '') +
        (sinPos.length ? ` No pude ubicar ${sinPos.length} (quedaron al final): cargales la ubicación en la ficha del cliente.` : '') +
        (nuevaAprox.size ? ' Algunas quedaron con ubicación aproximada (por localidad).' : ''),
    })
  }
  const ordenarPorLocalidad = () => {
    const loc = (p: P) => {
      const c = clientes.find((x) => x.id === p.cliente_id)
      return norm(c?.localidad ?? p.direccion.split(',').slice(-2, -1)[0] ?? '')
    }
    setParadas((ps) => [...ps].sort((a, b) => loc(a).localeCompare(loc(b)) || norm(a.direccion).localeCompare(norm(b.direccion))))
    setDirty(true)
  }

  const yaCargado = (lista: P[], c: ComprobanteRuta) =>
    !!c.numero && lista.some((p) => (p.comprobantes ?? []).some((x) => x.numero === c.numero && x.tipo === c.tipo && (x.letra ?? '') === (c.letra ?? '')))

  /** Suma un comprobante a una parada. Si la parada solo tenía un monto a mano, lo reemplaza. */
  const conComprobante = (p: P, c: ComprobanteRuta): P => {
    const cs = [...(p.comprobantes ?? []), c]
    return { ...p, comprobantes: cs, monto_factura: (p.comprobantes ?? []).length ? Math.round(((p.monto_factura ?? 0) + c.monto) * 100) / 100 : sumaComprobantes(cs) }
  }

  /** Comprobantes leídos de PDF (pestaña "Facturas PDF"): van a la parada del cliente o a una nueva. */
  function aplicarComprobantes(items: ComprobanteParaRuta[]) {
    let lista = [...paradas]
    let nuevas = 0
    let sumados = 0
    const repetidos: string[] = []
    for (const it of items) {
      if (yaCargado(lista, it.comp)) {
        repetidos.push(etiquetaComprobante(it.comp))
        continue
      }
      let idx = it.clienteId
        ? lista.findIndex((p) => p.cliente_id === it.clienteId && !p.entregado)
        : lista.findIndex((p) => !p.cliente_id && norm(p.destino) === norm(it.nombre))
      if (idx < 0 && it.clienteId) idx = lista.findIndex((p) => p.cliente_id === it.clienteId)
      if (idx >= 0) {
        lista[idx] = conComprobante(lista[idx], it.comp)
        sumados++
        continue
      }
      const c = it.clienteId ? clientes.find((x) => x.id === it.clienteId) : undefined
      const base: Parada = c
        ? paradaDesdeCliente(c)
        : {
            cliente_id: null, destino: it.nombre, direccion: '', telefono: null, que_lleva: null, bultos: null, observaciones: null,
            ...SIN_ENTREGA, lat: null, lng: null, monto_factura: null, comprobantes: [],
          }
      lista = [...lista, conComprobante({ ...base, _k: key() }, it.comp)]
      nuevas++
    }
    setParadas(lista)
    setDirty(true)
    const partes = [
      nuevas && `${nuevas} ${nuevas === 1 ? 'parada nueva' : 'paradas nuevas'}`,
      sumados && `${sumados} ${sumados === 1 ? 'comprobante sumado' : 'comprobantes sumados'} a paradas que ya estaban`,
    ].filter(Boolean)
    setMsg({
      tone: repetidos.length ? 'amber' : 'green',
      text:
        (partes.length ? `Listo: ${partes.join(' y ')}. ` : '') +
        (repetidos.length ? `Ya estaban cargados (no los sumé de nuevo): ${repetidos.join(', ')}. ` : '') +
        (partes.length ? 'Revisá y guardá.' : ''),
    })
    if (nuevas && autoOrden && lista.length > 1) ordenarAuto(lista)
  }

  /** "📎 Factura PDF" dentro de una parada. */
  async function adjuntarAParada(k: string, files: File[]) {
    setMsg(null)
    const avisos: string[] = []
    let lista = paradas
    for (const f of files) {
      const r = await leerFacturaPdf(f)
      const l = r.lectura
      if (!l) {
        avisos.push(`${f.name}: ${r.error}`)
        continue
      }
      const comp = comprobanteDesdeLectura(l, f.name)
      if (!comp) {
        avisos.push(`${f.name}: ${l.avisos.join(' ') || 'no encontré el importe total.'} Cargá el monto a mano.`)
        continue
      }
      if (yaCargado(lista, comp)) {
        avisos.push(`${etiquetaComprobante(comp)} ya estaba cargado.`)
        continue
      }
      const p = lista.find((x) => x._k === k)
      if (!p) return
      const m = clientePorFactura(l, clientes)
      if (p.cliente_id && m.elegido && m.elegido !== p.cliente_id) {
        avisos.push(`Ojo: ${etiquetaComprobante(comp)} parece ser de ${clientes.find((c) => c.id === m.elegido)?.razon_social ?? l.razonSocial}, no de ${p.destino}. Lo cargué igual: si no va, quitalo.`)
      } else if (p.cliente_id && !m.elegido && l.razonSocial && norm(l.razonSocial) !== norm(p.destino)) {
        avisos.push(`${etiquetaComprobante(comp)} está a nombre de "${l.razonSocial}". Fijate que sea de ${p.destino}.`)
      }
      if (l.tipo === 'desconocido') avisos.push(`${f.name}: no reconocí si es factura o nota de crédito; lo tomé como factura.`)
      for (const a of l.avisos) if (/importe|total le/i.test(a)) avisos.push(`${etiquetaComprobante(comp)}: ${a}`)
      lista = lista.map((x) => (x._k === k ? conComprobante(x, comp) : x))
    }
    setParadas(lista)
    if (lista !== paradas) setDirty(true)
    const p = lista.find((x) => x._k === k)
    setMsg(
      avisos.length
        ? { tone: 'amber', text: avisos.join(' ') }
        : { tone: 'green', text: `Factura cargada en ${p?.destino}: total de la parada ${fmtMoney(p?.monto_factura)}. Acordate de guardar.` },
    )
  }
  const quitarComprobante = (k: string, i: number) => {
    setParadas((ps) =>
      ps.map((p) => {
        if (p._k !== k) return p
        const cs = [...(p.comprobantes ?? [])]
        const [c] = cs.splice(i, 1)
        const resto = Math.round(((p.monto_factura ?? 0) - (c?.monto ?? 0)) * 100) / 100
        return { ...p, comprobantes: cs, monto_factura: cs.length ? resto : resto === 0 ? null : resto }
      }),
    )
    setDirty(true)
  }

  const totales = totalesRuta(paradas)
  const sinMonto = paradas.filter((p) => p.monto_factura == null).length
  const sinDireccion = paradas.filter((p) => !p.direccion.trim()).length
  const todasUbicadas = paradas.length > 0 && paradas.every((p) => p.lat != null && p.lng != null)
  const kmEstimado =
    origenPos?.pos && origenPos.dir === h.origen && todasUbicadas
      ? distanciaRuta(origenPos.pos, paradas.map((p) => ({ lat: p.lat!, lng: p.lng! })), h.volver_origen)
      : null
  const bultos = paradas.reduce((a, p) => a + (p.bultos ?? 0), 0)
  const entregadas = paradas.filter((p) => p.entregado).length
  const cobro = totalesCobro(paradas)
  const fueraHorario = llegadas.filter((l) => l.fuera).length

  async function guardar() {
    if (!h) return
    setMsg(null)
    if (!h.origen.trim()) return setMsg({ tone: 'red', text: 'Indicá el punto de salida (depósito).' })
    if (!paradas.length) return setMsg({ tone: 'red', text: 'Agregá al menos una parada.' })
    if (sinDireccion) return setMsg({ tone: 'red', text: `Hay ${sinDireccion} parada(s) sin dirección.` })
    const sinMigracion = montosOk === false && paradas.some((p) => p.monto_factura != null || (p.comprobantes ?? []).length)
    if (
      sinMigracion &&
      !window.confirm(
        'Los montos de factura todavía no se pueden guardar: falta actualizar la base de datos (migración 09).\n\n¿Guardo la hoja igual, SIN los montos?',
      )
    )
      return
    setBusy(true)
    const { data, error } = await sb().rpc('guardar_hoja_ruta', {
      p_hoja: {
        id: h.id ?? null,
        fecha: h.fecha,
        nombre: h.nombre?.trim() || null,
        chofer: h.chofer?.trim() || null,
        chofer_telefono: h.chofer_telefono?.trim() || null,
        origen: h.origen.trim(),
        volver_origen: h.volver_origen,
        observaciones: h.observaciones?.trim() || null,
        hora_salida: h.hora_salida || null,
        min_por_parada: h.min_por_parada ?? null,
      },
      // Cada parada viaja con su id: así conserva lo que ya marcó el chofer
      p_paradas: paradas.map(({ _k, orden: _o, ...p }, i) => ({
        ...p,
        id: p.id ?? null,
        monto_factura: p.monto_factura ?? null,
        comprobantes: p.comprobantes ?? [],
        // Si todavía no se pudo ubicar el depósito, queda la estimación anterior
        llegada_estimada: deMin(llegadas[i]?.inicio) || (origenPos?.pos ? null : p.llegada_estimada ?? null),
      })),
    })
    setBusy(false)
    if (error) return setMsg({ tone: 'red', text: errMsg(error) })
    try {
      localStorage.setItem(ORIGEN_KEY, h.origen.trim())
    } catch {}
    setDirty(false)
    setMsg(
      sinMigracion
        ? { tone: 'amber', text: 'Hoja de ruta guardada, pero sin los montos de factura (falta correr la migración 09 en Supabase).' }
        : { tone: 'green', text: 'Hoja de ruta guardada.' },
    )
    if (!guardada || esNueva) router.replace(`/rutas/${data as string}`)
    else cargar()
  }

  /** La oficina marca una parada (ej: el chofer avisó por teléfono). No pisa lo que se está editando. */
  async function marcarEntrega(p: P, m: Marca): Promise<string | null> {
    if (!p.id) return 'Guardá la hoja primero.'
    const pend = m.resultado === 'pendiente'
    const entrego = m.resultado === 'entregado' || m.resultado === 'parcial'
    const ahora = new Date().toISOString()
    const { data, error } = await sb()
      .from('hoja_ruta_paradas')
      .update({
        resultado: pend ? null : m.resultado,
        entregado: entrego,
        entregado_at: entrego ? p.entregado_at ?? ahora : null,
        motivo: m.resultado === 'no_entregado' || m.resultado === 'parcial' ? m.motivo : null,
        devolucion_detalle: pend ? null : m.devolucion_detalle,
        devolucion_motivo: pend || !m.devolucion_detalle ? null : m.devolucion_motivo,
        devolucion_monto: pend || !m.devolucion_detalle ? null : m.devolucion_monto,
        monto_cobrado: pend ? null : m.monto_cobrado,
        forma_pago: pend || !m.monto_cobrado ? null : m.forma_pago,
        nota_entrega: pend ? null : m.nota,
        marcado_at: pend ? null : ahora,
        marcado_por: pend ? null : perfil?.nombre || 'oficina',
      })
      .eq('id', p.id)
      .select(CAMPOS_ENTREGA)
      .maybeSingle()
    if (error) return errMsg(error)
    if (!data) return 'Esa parada cambió. Actualizá la página.'
    setParadas((ps) => ps.map((x) => (x.id === p.id ? { ...x, ...(data as Partial<P>), monto_cobrado: num((data as Parada).monto_cobrado), devolucion_monto: num((data as Parada).devolucion_monto) } : x)))
    setMarcando(null)
    refrescarEntregas()
    return null
  }

  async function pedirLink(renovar = false) {
    if (!h?.id) return
    if (renovar && !window.confirm('Se genera un link nuevo y el anterior deja de funcionar. ¿Seguimos?')) return
    setLinkBusy(true)
    const { data, error } = await sb().rpc('link_chofer_hoja', { p_hoja: h.id, p_renovar: renovar })
    setLinkBusy(false)
    if (error) return setMsg({ tone: 'red', text: errMsg(error) })
    setH((x) => (x ? { ...x, token_chofer: data as string } : x))
    setMsg({ tone: 'green', text: renovar ? 'Link nuevo generado. Mandáselo al chofer: el anterior ya no anda.' : 'Link del chofer listo. Mandáselo por WhatsApp.' })
  }

  /** Da la hoja por terminada desde la oficina (si el chofer no tocó "Terminé") o la reabre. */
  async function finalizar(terminada: boolean) {
    if (!h?.id) return
    const pend = paradas.filter((p) => estadoParada(p) === 'pendiente').length
    const pregunta = terminada
      ? `¿Dar el recorrido por terminado?${pend ? `\n\nOjo: quedan ${pend} parada(s) sin marcar.` : ''}`
      : '¿Reabrir la hoja? Se saca la marca de "terminada" y el chofer puede volver a terminarla.'
    if (!window.confirm(pregunta)) return
    setFinBusy(true)
    const { error } = await sb().rpc('hoja_ruta_finalizar', { p_hoja: h.id, p_terminada: terminada })
    setFinBusy(false)
    if (error) return setMsg({ tone: 'red', text: errMsg(error) })
    await refrescarEntregas()
    setMsg({ tone: 'green', text: terminada ? 'Recorrido dado por terminado. Abajo está el informe.' : 'Hoja reabierta.' })
  }

  function imprimirInforme() {
    setImpresion('informe')
    setTimeout(() => window.print(), 50)
  }

  async function eliminar() {
    if (!h?.id || !window.confirm('¿Eliminar esta hoja de ruta?')) return
    const { error } = await sb().from('hojas_ruta').delete().eq('id', h.id)
    if (error) return setMsg({ tone: 'red', text: errMsg(error) })
    router.push('/rutas')
  }

  const paradasConDir = paradas.filter((p) => p.direccion.trim())
  const link = h.token_chofer ? urlChofer(h.token_chofer) : null
  const texto = textoChofer(h, paradasConDir, tramos, { link, horario: (p) => fmtVentanas(ventanasP(p)) })
  const linkWa = link ? waLink(h.chofer_telefono, mensajeLinkChofer(h, link)) ?? `https://wa.me/?text=${encodeURIComponent(mensajeLinkChofer(h, link))}` : null
  const linkChofer = h.chofer_telefono ? waLink(h.chofer_telefono, texto) : `https://wa.me/?text=${encodeURIComponent(texto)}`

  return (
    <>
      <div className="print:hidden">
        <div className="mb-2 text-sm">
          <Link href="/rutas" className="text-brand-700 hover:underline">
            ← Hojas de ruta
          </Link>
        </div>
        <PageHeader
          title={esNueva ? 'Nueva hoja de ruta' : h.nombre || `Hoja de ruta ${fmtFecha(h.fecha)}`}
          subtitle={
            <span className="flex flex-wrap items-center gap-2">
              {guardada && <Badge tone={ESTADO_HOJA[h.estado].tone}>{ESTADO_HOJA[h.estado].label}</Badge>}
              {guardada && h.finalizada_at && <Badge tone="green">✅ Terminada {h.finalizada_por === 'chofer' || !h.finalizada_por ? 'por el chofer' : ''} {horaAR(h.finalizada_at)}</Badge>}
              <span className="capitalize">{fmtFechaLarga(h.fecha)}</span>
              {dirty && <span className="text-xs font-medium text-amber-700">· Cambios sin guardar</span>}
            </span>
          }
          actions={
            <>
              {guardada && editable && (
                <Link href={`/rutas/nueva?copiar=${h.id}`}>
                  <Button variant="secondary">Duplicar</Button>
                </Link>
              )}
              <Button variant="secondary" onClick={() => window.print()} disabled={!paradas.length}>
                Imprimir
              </Button>
              {editable && (
                <Button onClick={guardar} disabled={busy}>
                  {busy ? 'Guardando…' : 'Guardar'}
                </Button>
              )}
            </>
          }
        />

        {msg && (
          <Alert tone={msg.tone} className="mb-4">
            {msg.text}
          </Alert>
        )}

        <div className="grid gap-5 lg:grid-cols-3">
          <div className="min-w-0 space-y-5 lg:col-span-2">
            {guardada && h.finalizada_at && (
              <Card
                title="📋 Informe de la ruta"
                subtitle={h.finalizada_por === 'chofer' || !h.finalizada_por ? 'El chofer tocó “Terminé el recorrido”.' : `La cerró ${h.finalizada_por} desde la oficina.`}
                className="border-emerald-300 ring-1 ring-emerald-200"
              >
                <InformeRuta h={h} paradas={paradas}>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <BotonWhatsappInforme h={h} paradas={paradas} />
                    <Button variant="secondary" onClick={imprimirInforme}>
                      🖨️ Imprimir informe
                    </Button>
                    {editable && (
                      <Button variant="ghost" onClick={() => finalizar(false)} disabled={finBusy}>
                        ↺ Reabrir hoja
                      </Button>
                    )}
                  </div>
                </InformeRuta>
              </Card>
            )}
            <Card title="Datos del reparto">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Fecha">
                  <input className={inputCls} type="date" value={h.fecha} onChange={(e) => setDato('fecha', e.target.value)} disabled={!editable} />
                </Field>
                <Field label="Nombre del reparto">
                  <input className={inputCls} value={h.nombre ?? ''} onChange={(e) => setDato('nombre', e.target.value)} placeholder="Ej: Zona norte" disabled={!editable} />
                </Field>
                <Field label="Chofer">
                  <input className={inputCls} value={h.chofer ?? ''} onChange={(e) => setDato('chofer', e.target.value)} disabled={!editable} />
                </Field>
                <Field label="WhatsApp del chofer" hint="Para mandarle la hoja con un toque">
                  <input className={inputCls} value={h.chofer_telefono ?? ''} onChange={(e) => setDato('chofer_telefono', e.target.value)} inputMode="tel" disabled={!editable} />
                </Field>
                <Field label="Sale de (depósito)" required className="sm:col-span-2" hint="Se recuerda para la próxima. Dirección o coordenadas.">
                  <input className={inputCls} value={h.origen} onChange={(e) => setDato('origen', e.target.value)} placeholder="Ej: Av. Circunvalación 1234, Córdoba" disabled={!editable} />
                </Field>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="h-4 w-4 accent-brand-700" checked={h.volver_origen} onChange={(e) => setDato('volver_origen', e.target.checked)} disabled={!editable} />
                  Volver al depósito al final
                </label>
                <Field label="Observaciones generales" className="sm:col-span-2">
                  <input className={inputCls} value={h.observaciones ?? ''} onChange={(e) => setDato('observaciones', e.target.value)} disabled={!editable} />
                </Field>
                <Field label="Sale a las" hint="Para ordenar según el horario de cada cliente">
                  <input className={inputCls} type="time" value={h.hora_salida ?? ''} onChange={(e) => setDato('hora_salida', e.target.value || null)} disabled={!editable} />
                </Field>
                <Field label="Minutos por parada" hint="Tiempo estimado para descargar en cada cliente">
                  <input
                    className={inputCls}
                    inputMode="numeric"
                    value={h.min_por_parada ?? ''}
                    onChange={(e) => setDato('min_por_parada', e.target.value === '' ? null : Math.min(240, Math.max(0, parseInt(e.target.value) || 0)))}
                    disabled={!editable}
                  />
                </Field>
              </div>
            </Card>

            {editable && (
              <Card
                title="Agregar paradas"
                actions={
                  <div className="inline-flex rounded-lg border border-slate-300 p-0.5">
                    {(
                      [
                        ['rapida', 'Pegar lista'],
                        ['buscar', 'Buscar cliente'],
                        ['facturas', 'Facturas PDF'],
                        ['manual', 'Otra dirección'],
                      ] as const
                    ).map(([k, l]) => (
                      <button
                        key={k}
                        onClick={() => setTab(k)}
                        className={cx('rounded-md px-3 py-1 text-xs font-medium', tab === k ? 'bg-brand-700 text-white' : 'text-slate-600 hover:bg-slate-50')}
                      >
                        {l}
                      </button>
                    ))}
                  </div>
                }
              >
                {tab === 'rapida' && <CargaRapida clientes={clientes} onAgregar={agregar} />}
                {tab === 'buscar' && <BuscarCliente clientes={clientes} yaAgregados={new Set(paradas.map((p) => p.cliente_id ?? ''))} onAgregar={agregar} />}
                {tab === 'facturas' && <CargaFacturas clientes={clientes} onAplicar={aplicarComprobantes} />}
                {tab === 'manual' && <ParadaManual onAgregar={agregar} />}
              </Card>
            )}

            <Card
              title={`Paradas (${paradas.length})`}
              subtitle={paradas.length > 1 ? 'Google Maps sigue este orden. Reordená con las flechas.' : undefined}
              actions={
                <div className="flex flex-wrap gap-2">
                  {guardada && (
                    <Button size="sm" variant="ghost" onClick={refrescarEntregas} title="Traer lo que marcó el chofer">
                      ↻ Actualizar entregas
                    </Button>
                  )}
                  {editable && paradas.length > 2 && (
                    <Button size="sm" variant="secondary" onClick={ordenarPorLocalidad}>
                      Agrupar por localidad
                    </Button>
                  )}
                </div>
              }
              pad={false}
            >
              {montosOk === false && (
                <Alert tone="amber" className="m-4">
                  Los montos de factura se pueden cargar y ver, pero <b>todavía no se guardan</b>: falta actualizar la base de datos (migración 09). Pedile a quien administra el sistema que la corra.
                </Alert>
              )}
              {paradas.length === 0 ? (
                <Empty>Sin paradas todavía. Pegá la lista de clientes y qué lleva cada uno.</Empty>
              ) : (
                <ol className="divide-y divide-slate-100">
                  {paradas.map((p, i) => (
                    <ParadaItem
                      key={p._k}
                      p={p}
                      aprox={aprox.has(p._k)}
                      i={i}
                      total={paradas.length}
                      editable={editable}
                      puedeMarcar={guardada && !!p.id && puedeArmarRutas}
                      ventanas={ventanasP(p)}
                      llegada={llegadas[i]}
                      marcando={marcando === p._k}
                      onMarcando={(v) => setMarcando(v ? p._k : null)}
                      onChange={(c) => setParada(p._k, c)}
                      onMover={(d) => mover(i, d)}
                      onQuitar={() => quitar(p._k)}
                      onEntrega={(m) => marcarEntrega(p, m)}
                      onAdjuntar={(files) => adjuntarAParada(p._k, files)}
                      onQuitarComprobante={(j) => quitarComprobante(p._k, j)}
                    />
                  ))}
                </ol>
              )}
              {totales.conMonto > 0 && (
                <div className="flex flex-wrap items-baseline justify-between gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3 text-sm">
                  <span className="text-slate-600">
                    Total facturas de la hoja
                    {sinMonto > 0 && <span className="text-xs text-amber-700"> · {sinMonto} sin monto</span>}
                  </span>
                  <span className="text-base font-semibold tabular-nums">{fmtMoney(totales.total)}</span>
                </div>
              )}
              {cobro.cobrado > 0 && (
                <div className="flex flex-wrap items-baseline justify-between gap-2 border-t border-slate-200 bg-emerald-50/60 px-4 py-3 text-sm">
                  <span className="text-slate-600">Total cobrado por el chofer</span>
                  <span className="text-base font-semibold tabular-nums text-emerald-800">{fmtMoney(cobro.cobrado)}</span>
                </div>
              )}
            </Card>
          </div>

          <div className="min-w-0">
            <Card title="Recorrido" className="lg:sticky lg:top-6">
              {editable && paradas.length > 1 && (
                <div className="mb-4 space-y-2 rounded-lg border border-brand-200 bg-brand-50 p-3">
                  <Button className="w-full" onClick={() => ordenarAuto()} disabled={!!ordenando}>
                    {ordenando ?? '⚡ Ordenar ruta automática'}
                  </Button>
                  <p className="text-xs text-brand-800">
                    Arranca por el cliente más cercano al depósito, después el más cercano a ese, y corrige cruces del recorrido. Respeta el horario de atención de
                    cada cliente según la hora de salida ({h.hora_salida || HORA_SALIDA_DEFAULT}): si abre a las 14:00 no lo pone primero.
                  </p>
                  <label className="flex items-center gap-2 text-xs text-brand-900">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-brand-700"
                      checked={autoOrden}
                      onChange={(e) => {
                        setAutoOrden(e.target.checked)
                        try {
                          localStorage.setItem(AUTO_KEY, e.target.checked ? '1' : '0')
                        } catch {}
                      }}
                    />
                    Ordenar solo cada vez que agrego clientes
                  </label>
                </div>
              )}
              {fueraHorario > 0 && (
                <Alert tone="amber" className="mb-3">
                  {fueraHorario} parada(s) con llegada estimada fuera del horario del cliente (marcadas en la lista). Probá “Ordenar ruta automática”, cambiá la hora de
                  salida o movelas a mano.
                </Alert>
              )}
              {kmEstimado != null && (
                <div className="mb-3 flex items-baseline justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm">
                  <span className="text-slate-500">Estimado</span>
                  <span className="font-semibold tabular-nums">
                    ≈ {Math.round(kmEstimado)} km · {tiempoEstimado(kmEstimado, paradas.length)}
                  </span>
                </div>
              )}
              <dl className="mb-4 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-slate-50 p-2">
                  <dt className="text-[11px] uppercase tracking-wide text-slate-500">Paradas</dt>
                  <dd className="text-lg font-semibold">{paradas.length}</dd>
                </div>
                <div className="rounded-lg bg-slate-50 p-2">
                  <dt className="text-[11px] uppercase tracking-wide text-slate-500">Bultos</dt>
                  <dd className="text-lg font-semibold">{bultos || '—'}</dd>
                </div>
                <div className="rounded-lg bg-slate-50 p-2">
                  <dt className="text-[11px] uppercase tracking-wide text-slate-500">Entregadas</dt>
                  <dd className="text-lg font-semibold">
                    {entregadas}/{paradas.length}
                  </dd>
                  {cobro.parciales > 0 && <dd className="text-[11px] font-medium text-amber-700">{cobro.parciales} parcial(es)</dd>}
                  {cobro.noEntregadas > 0 && <dd className="text-[11px] font-medium text-red-700">{cobro.noEntregadas} sin entregar</dd>}
                </div>
              </dl>

              <div className="mb-4 rounded-lg border border-slate-200 p-3 text-sm">
                <div className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">Facturas de la hoja (caja del chofer)</div>
                {totales.conMonto === 0 ? (
                  <p className="text-xs text-slate-500">Cargá el monto de cada factura (a mano o subiendo el PDF) para ver el total.</p>
                ) : (
                  <dl className="space-y-0.5">
                    <div className="flex justify-between">
                      <dt className="text-slate-600">Facturas</dt>
                      <dd className="tabular-nums">{fmtMoney(totales.facturas)}</dd>
                    </div>
                    {totales.notas !== 0 && (
                      <div className="flex justify-between text-red-700">
                        <dt>Notas de crédito</dt>
                        <dd className="tabular-nums">{fmtMoney(totales.notas)}</dd>
                      </div>
                    )}
                    <div className="flex justify-between border-t border-slate-200 pt-1 font-semibold">
                      <dt>Total</dt>
                      <dd className="tabular-nums">{fmtMoney(totales.total)}</dd>
                    </div>
                    {entregadas > 0 && (
                      <div className="flex justify-between text-xs text-emerald-700">
                        <dt>Ya entregado</dt>
                        <dd className="tabular-nums">{fmtMoney(totales.entregado)}</dd>
                      </div>
                    )}
                    {sinMonto > 0 && <p className="pt-1 text-xs text-amber-700">{sinMonto} parada(s) sin monto cargado.</p>}
                  </dl>
                )}
                {cobro.devoluciones > 0 && (
                  <div className="mt-3 flex justify-between border-t border-slate-200 pt-2 text-violet-800">
                    <span>
                      ↩ Devoluciones ({cobro.devoluciones} {cobro.devoluciones === 1 ? 'cliente' : 'clientes'})
                    </span>
                    <span className="tabular-nums">{cobro.devuelto ? fmtMoney(cobro.devuelto) : 'sin monto'}</span>
                  </div>
                )}
                {cobro.cobrado > 0 && (
                  <dl className="mt-3 space-y-0.5 border-t border-slate-200 pt-2">
                    <div className="flex justify-between font-semibold text-emerald-800">
                      <dt>Cobrado por el chofer</dt>
                      <dd className="tabular-nums">{fmtMoney(cobro.cobrado)}</dd>
                    </div>
                    {FORMAS_PAGO.filter((f) => cobro.porForma[f.k]).map((f) => (
                      <div key={f.k} className="flex justify-between text-xs text-slate-600">
                        <dt>{f.label}</dt>
                        <dd className="tabular-nums">{fmtMoney(cobro.porForma[f.k])}</dd>
                      </div>
                    ))}
                    {cobro.porForma.efectivo > 0 && (
                      <div className="flex justify-between border-t border-slate-200 pt-1 font-semibold">
                        <dt>Efectivo a rendir</dt>
                        <dd className="tabular-nums">{fmtMoney(cobro.porForma.efectivo)}</dd>
                      </div>
                    )}
                  </dl>
                )}
              </div>

              <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50/50 p-3 text-sm">
                <div className="mb-1 text-[11px] uppercase tracking-wide text-emerald-800">📱 Link para el chofer</div>
                {!guardada ? (
                  <p className="text-xs text-slate-600">Guardá la hoja para generar el link.</p>
                ) : !link ? (
                  <>
                    <p className="mb-2 text-xs text-slate-600">
                      El chofer lo abre en el celular (sin usuario ni contraseña), ve las paradas en orden y marca cada una como entregada o no, con el motivo y lo que
                      cobró. Lo ves acá al instante.
                    </p>
                    {editable && (
                      <Button className="w-full" variant="success" onClick={() => pedirLink()} disabled={linkBusy}>
                        {linkBusy ? 'Generando…' : 'Generar link del chofer'}
                      </Button>
                    )}
                  </>
                ) : (
                  <div className="space-y-2">
                    <a
                      href={linkWa ?? '#'}
                      target="_blank"
                      rel="noreferrer"
                      className="flex w-full items-center justify-center rounded-lg bg-emerald-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-700"
                    >
                      Mandar link por WhatsApp{h.chofer ? ` a ${h.chofer}` : ''}
                    </a>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        className="flex-1"
                        onClick={async () => {
                          await copiar(link)
                          setMsg({ tone: 'green', text: 'Link del chofer copiado.' })
                        }}
                      >
                        Copiar link
                      </Button>
                      <a href={link} target="_blank" rel="noreferrer" className="flex-1">
                        <Button size="sm" variant="secondary" className="w-full">
                          Ver como chofer
                        </Button>
                      </a>
                    </div>
                    {editable && (
                      <button onClick={() => pedirLink(true)} disabled={linkBusy} className="text-xs text-slate-500 hover:text-red-600">
                        Generar link nuevo (el anterior deja de andar)
                      </button>
                    )}
                    <p className="text-[11px] text-slate-500">Funciona hasta 7 días después de la fecha del reparto. No lo compartas fuera del chofer.</p>
                  </div>
                )}
              </div>

              {guardada && editable && !h.finalizada_at && paradas.length > 0 && (
                <div className="mb-4">
                  <Button variant="secondary" className="w-full" onClick={() => finalizar(true)} disabled={finBusy}>
                    🏁 Dar recorrido por terminado
                  </Button>
                  <p className="mt-1 text-[11px] text-slate-500">Lo hace el chofer desde su link al terminar. Usalo si él no pudo.</p>
                </div>
              )}

              {sinDireccion > 0 && (
                <Alert tone="amber" className="mb-3">
                  {sinDireccion} parada(s) sin dirección: no entran en el recorrido.
                </Alert>
              )}
              {!h.origen.trim() && (
                <Alert tone="amber" className="mb-3">
                  Cargá el punto de salida para armar el recorrido.
                </Alert>
              )}

              {tramos.length > 0 && (
                <div className="space-y-2">
                  {tramos.map((t) => (
                    <a
                      key={t.numero}
                      href={t.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#1a73e8] px-3.5 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-[#1765cc]"
                    >
                      Abrir en Google Maps{tramos.length > 1 ? ` · tramo ${t.numero}` : ''}
                    </a>
                  ))}
                  {tramos.length > 1 && (
                    <p className="text-xs text-slate-500">Google Maps acepta hasta {MAX_WAYPOINTS} paradas por link, por eso se divide en tramos encadenados.</p>
                  )}
                  <a
                    href={linkChofer ?? '#'}
                    target="_blank"
                    rel="noreferrer"
                    className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-3.5 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-emerald-700"
                  >
                    Mandar al chofer por WhatsApp
                  </a>
                  <Button
                    variant="secondary"
                    className="w-full"
                    onClick={async () => {
                      await copiar(texto)
                      setMsg({ tone: 'green', text: 'Hoja de ruta copiada. Pegala donde quieras.' })
                    }}
                  >
                    Copiar texto de la hoja
                  </Button>
                </div>
              )}

              {guardada && dirty && <p className="mt-3 text-xs text-amber-700">Hay cambios sin guardar en la hoja.</p>}
              {/* Eliminar: solo Administración y Gerencia */}
              {guardada && puedeEditar && (
                <button onClick={eliminar} className="mt-4 text-xs text-slate-400 hover:text-red-600">
                  Eliminar hoja de ruta
                </button>
              )}
            </Card>
          </div>
        </div>
      </div>

      {impresion === 'informe' ? (
        <div className="hidden print:block">
          <InformeRuta h={h} paradas={paradas} impreso />
        </div>
      ) : (
        <HojaImpresa h={h} paradas={paradas} llegadas={llegadas} ventanasP={ventanasP} />
      )}
    </>
  )
}

// ---------------------------------------------------------------------
function ParadaItem({
  p,
  aprox,
  i,
  total,
  editable,
  puedeMarcar,
  ventanas,
  llegada,
  marcando,
  onMarcando,
  onChange,
  onMover,
  onQuitar,
  onEntrega,
  onAdjuntar,
  onQuitarComprobante,
}: {
  p: P
  aprox: boolean
  i: number
  total: number
  editable: boolean
  puedeMarcar: boolean
  ventanas: Ventana[]
  llegada?: Llegada
  marcando: boolean
  onMarcando: (v: boolean) => void
  onChange: (c: Partial<P>) => void
  onMover: (d: -1 | 1) => void
  onQuitar: () => void
  onEntrega: (m: Marca) => Promise<string | null>
  onAdjuntar: (files: File[]) => Promise<void>
  onQuitarComprobante: (i: number) => void
}) {
  const [leyendo, setLeyendo] = useState(false)
  const comps = p.comprobantes ?? []
  const aviso = waLink(p.telefono, mensajeEnCamino(p))
  const ver = p.direccion.trim() ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.direccion)}` : null
  const est = estadoParada(p)
  return (
    <li className={cx('flex gap-3 px-4 py-3', est === 'entregado' && 'bg-emerald-50/50', est === 'parcial' && 'bg-amber-50/60', est === 'no_entregado' && 'bg-red-50/50')}>
      <div className="flex flex-col items-center gap-1">
        <span
          className={cx(
            'flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold text-white',
            est === 'entregado' ? 'bg-emerald-600' : est === 'parcial' ? 'bg-amber-500' : est === 'no_entregado' ? 'bg-red-600' : 'bg-brand-700',
          )}
          title={est === 'pendiente' ? undefined : `Parada ${i + 1}`}
        >
          {est === 'pendiente' ? i + 1 : ESTADO_PARADA[est].icono}
        </span>
        {editable && (
          <>
            <button onClick={() => onMover(-1)} disabled={i === 0} className="text-xs text-slate-400 hover:text-slate-700 disabled:opacity-20" aria-label="Subir">
              ▲
            </button>
            <button onClick={() => onMover(1)} disabled={i === total - 1} className="text-xs text-slate-400 hover:text-slate-700 disabled:opacity-20" aria-label="Bajar">
              ▼
            </button>
          </>
        )}
      </div>

      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="font-medium text-slate-900">
              {p.cliente_id ? (
                <Link href={`/clientes/${p.cliente_id}`} className="hover:text-brand-700">
                  {p.destino}
                </Link>
              ) : (
                p.destino
              )}
            </div>
            {p.telefono && <div className="text-xs text-slate-500">📞 {p.telefono}</div>}
            {(ventanas.length > 0 || llegada?.inicio != null) && (
              <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs">
                {ventanas.length > 0 && <span className="font-medium text-amber-800">🕑 Atiende {fmtVentanas(ventanas)}</span>}
                {llegada?.inicio != null && (
                  <span className={llegada.fuera ? 'font-semibold text-red-700' : 'text-slate-500'}>
                    {llegada.fuera
                      ? `⚠ llega ≈ ${deMin(llegada.llegada)}, fuera de horario`
                      : `llega ≈ ${deMin(llegada.inicio)}${llegada.espera >= 5 ? ` (espera ${Math.round(llegada.espera)} min a que abra)` : ''}`}
                  </span>
                )}
              </div>
            )}
            {aprox && <div className="text-xs text-amber-700">Ubicación aproximada (solo por localidad)</div>}
            {editable && p.direccion.trim() && p.lat == null && <div className="text-xs text-slate-400">Sin ubicar en el mapa</div>}
          </div>
          <div className="flex items-center gap-3 text-xs">
            {ver && (
              <a href={ver} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">
                Ver en Maps
              </a>
            )}
            {aviso && (
              <a href={aviso} target="_blank" rel="noreferrer" className="text-emerald-700 hover:underline">
                Avisar al cliente
              </a>
            )}
            {editable && (
              <button onClick={onQuitar} className="text-slate-400 hover:text-red-600">
                Quitar
              </button>
            )}
          </div>
        </div>

        {editable ? (
          <div className="grid gap-2 sm:grid-cols-6">
            <input
              className={cx(inputCls, 'sm:col-span-6', !p.direccion.trim() && 'border-amber-400 bg-amber-50')}
              value={p.direccion}
              onChange={(e) => onChange({ direccion: e.target.value, lat: null, lng: null })}
              placeholder="Dirección, localidad (o coordenadas)"
            />
            <input className={cx(inputCls, 'sm:col-span-3')} value={p.que_lleva ?? ''} onChange={(e) => onChange({ que_lleva: e.target.value })} placeholder="Qué lleva" />
            <input
              className={cx(inputCls, 'sm:col-span-1')}
              value={p.bultos ?? ''}
              onChange={(e) => onChange({ bultos: e.target.value === '' ? null : Math.max(0, parseInt(e.target.value) || 0) })}
              placeholder="Bultos"
              inputMode="numeric"
            />
            <MontoInput className="sm:col-span-2" valor={p.monto_factura} onCambio={(n) => onChange({ monto_factura: n })} />
            <input className={cx(inputCls, 'sm:col-span-6')} value={p.observaciones ?? ''} onChange={(e) => onChange({ observaciones: e.target.value })} placeholder="Observaciones (horario, cobrar, retirar…)" />
            <div className="flex flex-wrap items-center gap-2 sm:col-span-6">
              <ListaComprobantes comprobantes={comps} onQuitar={onQuitarComprobante} />
              <label className={cx('cursor-pointer text-xs text-brand-700 hover:underline', leyendo && 'pointer-events-none opacity-50')}>
                {leyendo ? 'Leyendo PDF…' : '📎 Factura PDF'}
                <input
                  type="file"
                  accept="application/pdf,.pdf"
                  multiple
                  className="hidden"
                  onChange={async (e) => {
                    const files = Array.from(e.target.files ?? [])
                    e.target.value = ''
                    if (!files.length) return
                    setLeyendo(true)
                    try {
                      await onAdjuntar(files)
                    } finally {
                      setLeyendo(false)
                    }
                  }}
                />
              </label>
              {p.monto_factura != null && p.monto_factura < 0 && <span className="text-xs text-red-700">Nota de crédito: resta</span>}
            </div>
          </div>
        ) : (
          <div className="space-y-0.5 text-sm">
            <div className="text-slate-600">📍 {p.direccion}</div>
            {(p.que_lleva || p.bultos) && (
              <div>
                📦 {p.que_lleva}
                {p.bultos ? ` (${p.bultos} bultos)` : ''}
              </div>
            )}
            {p.observaciones && <div className="text-amber-800">⚠️ {p.observaciones}</div>}
            {p.monto_factura != null && (
              <div className={cx('font-medium tabular-nums', p.monto_factura < 0 && 'text-red-700')}>💲 {fmtMoney(p.monto_factura)}</div>
            )}
            <ListaComprobantes comprobantes={comps} />
          </div>
        )}

        {puedeMarcar && !marcando && (
          <div className="flex flex-wrap items-center gap-2">
            {est === 'pendiente' ? <span className="text-xs text-slate-400">Pendiente</span> : <ResumenMarca p={p} />}
            <button onClick={() => onMarcando(true)} className="text-xs font-medium text-brand-700 hover:underline">
              {est === 'pendiente' ? 'Marcar entrega / cobro' : 'Corregir'}
            </button>
            {est !== 'pendiente' && (
              <button
                onClick={async () => {
                  if (!window.confirm(`¿Dejar ${p.destino} como pendiente otra vez?`)) return
                  const err = await onEntrega(MARCA_PENDIENTE)
                  if (err) window.alert(err)
                }}
                className="text-xs text-slate-400 hover:text-red-600"
              >
                Dejar pendiente
              </button>
            )}
          </div>
        )}
        {!puedeMarcar && est !== 'pendiente' && <ResumenMarca p={p} />}
        {puedeMarcar && marcando && <MarcarParada p={p} onGuardar={onEntrega} onCancelar={() => onMarcando(false)} />}
      </div>
    </li>
  )
}

// ---------------------------------------------------------------------
function CargaRapida({ clientes, onAgregar }: { clientes: ClienteRuta[]; onAgregar: (p: Parada[]) => void }) {
  const [texto, setTexto] = useState('')
  const [lineas, setLineas] = useState<LineaRapida[] | null>(null)
  const porId = useMemo(() => new Map(clientes.map((c) => [c.id, c])), [clientes])

  const set = (i: number, c: Partial<LineaRapida>) => setLineas((ls) => (ls ? ls.map((l, j) => (j === i ? { ...l, ...c } : l)) : ls))
  const listas = (lineas ?? []).filter((l) => l.elegido)

  function agregar() {
    onAgregar(listas.map((l) => paradaDesdeCliente(porId.get(l.elegido)!, l.queLleva, l.bultos)))
    const faltan = (lineas ?? []).filter((l) => !l.elegido)
    setLineas(faltan.length ? faltan : null)
    setTexto(faltan.map((l) => l.linea).join('\n'))
  }

  if (!lineas) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          Escribí o pegá una línea por cliente: <b>cliente - qué lleva</b>. Si ponés &quot;3 bultos&quot; se cuentan solos.
        </p>
        <textarea
          className={cx(inputCls, 'font-mono')}
          rows={6}
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          placeholder={'Metalúrgica Norte - 2 rodamientos 6205 y 1 correa (2 bultos)\nTornillo - caja de bulones\nAgro Pampa: motor reductor, 1 bulto'}
        />
        <div className="flex justify-end">
          <Button onClick={() => setLineas(parsearCargaRapida(texto, clientes))} disabled={!texto.trim()}>
            Buscar clientes
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {lineas.map((l, i) => {
          const sinMatch = !l.elegido
          return (
            <div key={i} className={cx('grid gap-2 rounded-lg border p-2 sm:grid-cols-12', sinMatch ? 'border-amber-300 bg-amber-50' : 'border-slate-200')}>
              <div className="text-xs text-slate-500 sm:col-span-12">“{l.linea}”</div>
              <select className={cx(inputCls, 'sm:col-span-5')} value={l.elegido} onChange={(e) => set(i, { elegido: e.target.value })}>
                <option value="">{l.candidatos.length ? '— Elegí el cliente —' : '— No encontré el cliente —'}</option>
                {l.candidatos.length > 0 && (
                  <optgroup label="Sugeridos">
                    {l.candidatos.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.razon_social}
                        {c.localidad ? ` (${c.localidad})` : ''}
                      </option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="Todos los clientes">
                  {clientes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.razon_social}
                    </option>
                  ))}
                </optgroup>
              </select>
              <input className={cx(inputCls, 'sm:col-span-5')} value={l.queLleva} onChange={(e) => set(i, { queLleva: e.target.value })} placeholder="Qué lleva" />
              <input
                className={cx(inputCls, 'sm:col-span-2')}
                value={l.bultos ?? ''}
                onChange={(e) => set(i, { bultos: e.target.value === '' ? null : parseInt(e.target.value) || 0 })}
                placeholder="Bultos"
                inputMode="numeric"
              />
              {l.elegido && !porId.get(l.elegido)?.direccion && !porId.get(l.elegido)?.ubicacion && (
                <div className="text-xs text-amber-700 sm:col-span-12">Este cliente no tiene dirección cargada: vas a tener que escribirla en la parada.</div>
              )}
            </div>
          )
        })}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={() => setLineas(null)}>
          Volver a editar
        </Button>
        <Button onClick={agregar} disabled={!listas.length}>
          Agregar {listas.length} {listas.length === 1 ? 'parada' : 'paradas'}
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
function BuscarCliente({ clientes, yaAgregados, onAgregar }: { clientes: ClienteRuta[]; yaAgregados: Set<string>; onAgregar: (p: Parada[]) => void }) {
  const [q, setQ] = useState('')
  const res = useMemo(() => {
    const t = norm(q)
    if (!t) return []
    return clientes.filter((c) => norm(`${c.razon_social} ${c.localidad ?? ''} ${c.contacto_nombre ?? ''}`).includes(t)).slice(0, 8)
  }, [q, clientes])
  return (
    <div className="space-y-2">
      <input className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por nombre, localidad o contacto…" autoFocus />
      {q && res.length === 0 && <p className="text-sm text-slate-500">Sin resultados.</p>}
      <ul className="divide-y divide-slate-100">
        {res.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-2 py-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{c.razon_social}</div>
              <div className="truncate text-xs text-slate-500">
                {[c.direccion, c.localidad].filter(Boolean).join(', ') || (c.ubicacion ? `📍 ${c.ubicacion}` : <span className="text-amber-700">Sin dirección</span>)}
              </div>
            </div>
            <Button
              size="sm"
              variant={yaAgregados.has(c.id) ? 'secondary' : 'primary'}
              onClick={() => {
                onAgregar([paradaDesdeCliente(c)])
                setQ('')
              }}
            >
              {yaAgregados.has(c.id) ? 'Agregar otra vez' : 'Agregar'}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------------
function ParadaManual({ onAgregar }: { onAgregar: (p: Parada[]) => void }) {
  const [destino, setDestino] = useState('')
  const [direccion, setDireccion] = useState('')
  const [telefono, setTelefono] = useState('')
  const [queLleva, setQueLleva] = useState('')
  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (!destino.trim() || !direccion.trim()) return
        onAgregar([
          {
            cliente_id: null,
            destino: destino.trim(),
            direccion: direccion.trim(),
            telefono: telefono.trim() || null,
            que_lleva: queLleva.trim() || null,
            bultos: null,
            observaciones: null,
            entregado: false,
            entregado_at: null,
            nota_entrega: null,
            lat: null,
            lng: null,
            monto_factura: null,
            comprobantes: [],
          },
        ])
        setDestino('')
        setDireccion('')
        setTelefono('')
        setQueLleva('')
      }}
    >
      <Field label="Destino" required hint="Ej: Andreani sucursal, proveedor, banco">
        <input className={inputCls} value={destino} onChange={(e) => setDestino(e.target.value)} required />
      </Field>
      <Field label="Dirección o coordenadas" required>
        <input className={inputCls} value={direccion} onChange={(e) => setDireccion(e.target.value)} required />
      </Field>
      <Field label="Teléfono">
        <input className={inputCls} value={telefono} onChange={(e) => setTelefono(e.target.value)} />
      </Field>
      <Field label="Qué lleva / qué hacer">
        <input className={inputCls} value={queLleva} onChange={(e) => setQueLleva(e.target.value)} />
      </Field>
      <div className="flex justify-end sm:col-span-2">
        <Button type="submit">Agregar parada</Button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------
function HojaImpresa({ h, paradas, llegadas, ventanasP }: { h: Datos; paradas: P[]; llegadas: Llegada[]; ventanasP: (p: Parada) => Ventana[] }) {
  const t = totalesRuta(paradas)
  const c = totalesCobro(paradas)
  const conMontos = t.conMonto > 0
  const algoMarcado = c.entregadas + c.parciales + c.noEntregadas > 0
  const hora = (iso?: string | null) => (iso ? new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Argentina/Cordoba' }) : '')
  const linea = '$ ____________'
  const cell = 'border border-black px-1.5 py-2 align-top'
  return (
    <div className="hidden text-black print:block">
      <div className="mb-3 flex items-end justify-between border-b-2 border-black pb-2">
        <div>
          <div className="text-lg font-bold">DE&amp;CO · Hoja de ruta{h.nombre ? ` – ${h.nombre}` : ''}</div>
          <div className="text-sm capitalize">{fmtFechaLarga(h.fecha)}</div>
        </div>
        <div className="text-right text-sm">
          <div>Chofer: {h.chofer || '________________'}</div>
          <div>Sale de: {h.origen}{h.hora_salida ? ` · ${h.hora_salida} h` : ''}</div>
        </div>
      </div>
      {h.observaciones && <p className="mb-2 text-sm">Obs.: {h.observaciones}</p>}
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr>
            {['#', 'Cliente', 'Dirección', 'Teléfono', 'Bultos', ...(conMontos ? ['A cobrar'] : []), 'Monto cobrado', 'Recibió / firma', 'Hora'].map((x) => (
              <th key={x} className="border border-black px-1.5 py-1 text-left">
                {x}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {paradas.map((p, i) => {
            const e = estadoParada(p)
            const vs = ventanasP(p)
            const l = llegadas[i]
            return (
              <tr key={p._k} className="break-inside-avoid">
                <td className={`${cell} font-bold`}>{i + 1}</td>
                <td className={`${cell} font-semibold`}>
                  {p.destino}
                  {vs.length > 0 && <div className="text-[9px] font-normal">Atiende {fmtVentanas(vs)}</div>}
                  {l?.inicio != null && <div className="text-[9px] font-normal">Llega ≈ {deMin(l.inicio)}{l.fuera ? ' (fuera de horario)' : ''}</div>}
                </td>
                <td className={cell}>
                  {p.direccion}
                  {p.observaciones && <div className="mt-1 italic">⚠ {p.observaciones}</div>}
                </td>
                <td className={cell}>{p.telefono}</td>
                <td className={`${cell} text-center`}>{p.bultos ?? ''}</td>
                {conMontos && (
                  <td className={`${cell} whitespace-nowrap text-right tabular-nums`}>
                    {p.monto_factura != null ? fmtMoney(p.monto_factura) : ''}
                    {(p.comprobantes ?? []).map((cp, j) => (
                      <div key={j} className="text-[9px]">
                        {etiquetaComprobante(cp)}
                      </div>
                    ))}
                  </td>
                )}
                <td className={`${cell} w-28 whitespace-nowrap`}>
                  {p.monto_cobrado != null ? (
                    <>
                      <div className="text-right font-semibold tabular-nums">{fmtMoney(p.monto_cobrado)}</div>
                      {p.forma_pago && <div className="text-right text-[9px]">{labelFormaPago(p.forma_pago)}</div>}
                    </>
                  ) : e === 'no_entregado' ? (
                    ''
                  ) : (
                    <>
                      <div className="pt-2">$ __________</div>
                      <div className="mt-1 text-[9px]">☐ Ef. ☐ Transf. ☐ Ch.</div>
                    </>
                  )}
                </td>
                <td className={`${cell} w-32`}>
                  {e === 'entregado' && <div className="text-[10px]">✓ Entregado{p.nota_entrega ? ` · ${p.nota_entrega}` : ''}</div>}
                  {e === 'parcial' && (
                    <div className="text-[10px] font-semibold">
                      ◐ Entrega parcial{p.motivo ? `: ${p.motivo}` : ''}
                      {p.nota_entrega ? <span className="font-normal"> · {p.nota_entrega}</span> : ''}
                    </div>
                  )}
                  {e === 'no_entregado' && <div className="text-[10px] font-semibold">✗ No entregado{p.motivo ? `: ${p.motivo}` : ''}</div>}
                </td>
                <td className={`${cell} w-12 text-[10px]`}>{e !== 'pendiente' ? hora(p.marcado_at ?? p.entregado_at) : ''}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="mt-2 text-right text-xs">
        Total bultos: {paradas.reduce((a, p) => a + (p.bultos ?? 0), 0)} · {paradas.length} paradas{h.volver_origen ? ` · Regreso: ${h.origen}` : ''}
      </div>

      <div className="mt-3 flex break-inside-avoid justify-end">
        <table className="border-collapse text-sm">
          <tbody>
            {conMontos && (
              <tr>
                <td className="border border-black px-2 py-1">Total a cobrar{t.notas !== 0 ? ` (fact. ${fmtMoney(t.facturas)} · NC ${fmtMoney(t.notas)})` : ''}</td>
                <td className="w-40 border border-black px-2 py-1 text-right font-bold tabular-nums">{fmtMoney(t.total)}</td>
              </tr>
            )}
            <tr>
              <td className="border border-black px-2 py-1">Total cobrado</td>
              <td className="border border-black px-2 py-1 text-right font-bold tabular-nums">{algoMarcado || c.cobrado ? fmtMoney(c.cobrado) : linea}</td>
            </tr>
            {(['efectivo', 'transferencia', 'cheque'] as const).map((k) => (
              <tr key={k}>
                <td className="border border-black px-2 py-1 pl-5 text-xs">{labelFormaPago(k)}</td>
                <td className="border border-black px-2 py-1 text-right text-xs tabular-nums">{c.porForma[k] ? fmtMoney(c.porForma[k]) : algoMarcado ? '—' : linea}</td>
              </tr>
            ))}
            <tr>
              <td className="border border-black px-2 py-1">Efectivo a rendir (efectivo cobrado)</td>
              <td className="border border-black px-2 py-1 text-right font-bold tabular-nums">{algoMarcado || c.porForma.efectivo ? fmtMoney(c.porForma.efectivo) : linea}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="mt-8 flex justify-between text-xs">
        <span>Firma chofer: ______________________</span>
        <span>Recibió la plata (oficina): ______________________</span>
      </div>
    </div>
  )
}
