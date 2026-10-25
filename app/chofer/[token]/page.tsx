'use client'

import { useParams } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { sb, errMsg } from '@/lib/supabase'
import type { FormaPago, Parada } from '@/lib/types'
import { fmtFechaLarga, fmtMoney, waLink } from '@/lib/utils'
import { ESTADO_PARADA, FORMAS_PAGO, MAX_WAYPOINTS, estadoParada, totalesCobro, totalesRuta, type EstadoParada } from '@/lib/rutas'
import { etiquetaComprobante, type ComprobanteRuta } from '@/lib/factura-pdf'
import { fmtVentanas, ventanasDe, type HorarioCampos } from '@/lib/horarios'
import { MARCA_PENDIENTE, MarcarParada, ResumenMarca, type Marca } from '@/components/MarcarParada'
import { cx } from '@/components/ui'
import { BotonWhatsappInforme, InformeRuta } from '@/components/InformeRuta'

type ParadaChofer = Parada & HorarioCampos & { id: string; horarios?: string | null }
interface HojaChofer {
  fecha: string
  nombre: string | null
  chofer: string | null
  origen: string
  volver_origen: boolean
  observaciones: string | null
  estado: string
  hora_salida: string | null
  /** Migración 16: cuándo tocó "Terminé el recorrido". */
  finalizada_at?: string | null
  finalizada_por?: string | null
  paradas: ParadaChofer[]
}
type Pendiente = { parada: string; marca: Marca; ts: number }

const esErrorDeRed = (m: string) => (typeof navigator !== 'undefined' && !navigator.onLine) || /failed to fetch|network|load failed|fetch/i.test(m)

/** Lo que el chofer marcó sin señal: se guarda en el celular y se manda cuando vuelve. */
function useCola(token: string) {
  const k = `deco_chofer_cola_${token.slice(0, 12)}`
  const leer = useCallback((): Pendiente[] => {
    try {
      return JSON.parse(localStorage.getItem(k) || '[]')
    } catch {
      return []
    }
  }, [k])
  const escribir = useCallback(
    (c: Pendiente[]) => {
      try {
        if (c.length) localStorage.setItem(k, JSON.stringify(c))
        else localStorage.removeItem(k)
      } catch {}
    },
    [k],
  )
  return useMemo(() => ({ leer, escribir }), [leer, escribir])
}

function aplicar(p: ParadaChofer, m: Marca): ParadaChofer {
  const pend = m.resultado === 'pendiente'
  return {
    ...p,
    resultado: pend ? null : (m.resultado as 'entregado' | 'parcial' | 'no_entregado'),
    entregado: m.resultado === 'entregado' || m.resultado === 'parcial',
    motivo: m.resultado === 'no_entregado' || m.resultado === 'parcial' ? m.motivo : null,
    devolucion_detalle: pend ? null : m.devolucion_detalle,
    devolucion_motivo: pend || !m.devolucion_detalle ? null : m.devolucion_motivo,
    devolucion_monto: pend || !m.devolucion_detalle ? null : m.devolucion_monto,
    monto_cobrado: pend ? null : m.monto_cobrado,
    forma_pago: pend || !m.monto_cobrado ? null : m.forma_pago,
    nota_entrega: pend ? null : m.nota,
    marcado_at: pend ? null : new Date().toISOString(),
  }
}

export default function ChoferPage() {
  const { token } = useParams<{ token: string }>()
  const [h, setH] = useState<HojaChofer | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [abierta, setAbierta] = useState<{ id: string; inicial?: EstadoParada } | null>(null)
  const [verTodas, setVerTodas] = useState(false)
  const [aviso, setAviso] = useState<string | null>(null)
  const [enCola, setEnCola] = useState(0)
  const cola = useCola(token)
  const enviando = useRef(false)
  const [terminando, setTerminando] = useState(false)

  const enviar = useCallback(
    async (id: string, m: Marca) =>
      sb().rpc('chofer_marcar', {
        p_token: token,
        p_parada: id,
        p_resultado: m.resultado,
        p_motivo: m.motivo,
        p_monto_cobrado: m.monto_cobrado,
        p_forma_pago: m.forma_pago,
        p_nota: m.nota,
        p_devolucion_detalle: m.devolucion_detalle,
        p_devolucion_motivo: m.devolucion_motivo,
        p_devolucion_monto: m.devolucion_monto,
      }),
    [token],
  )

  /** Manda lo que quedó guardado sin señal. */
  const vaciarCola = useCallback(async () => {
    if (enviando.current) return
    const c = cola.leer()
    if (!c.length) return setEnCola(0)
    enviando.current = true
    const quedan: Pendiente[] = []
    for (const it of c) {
      const { error } = await enviar(it.parada, it.marca)
      if (error && esErrorDeRed(error.message)) quedan.push(it)
      // Si la base lo rechaza (ej: parada borrada) se descarta: no tiene sentido reintentar
    }
    cola.escribir(quedan)
    setEnCola(quedan.length)
    enviando.current = false
    if (!quedan.length && c.length) setAviso('Listo: se guardó todo lo que marcaste sin señal.')
  }, [cola, enviar])

  const cargar = useCallback(async () => {
    await vaciarCola()
    const { data, error } = await sb().rpc('chofer_hoja', { p_token: token })
    if (error) {
      if (esErrorDeRed(error.message)) return setAviso('Sin conexión: mostrando lo último que se cargó.')
      return setError(errMsg(error))
    }
    const hoja = data as HojaChofer
    // Lo que sigue en la cola (sin señal) se muestra como ya marcado
    const c = cola.leer()
    hoja.paradas = (hoja.paradas ?? []).map((p) => {
      const ult = c.filter((x) => x.parada === p.id).pop()
      return ult ? aplicar(p, ult.marca) : { ...p, monto_factura: p.monto_factura == null ? null : Number(p.monto_factura), monto_cobrado: p.monto_cobrado == null ? null : Number(p.monto_cobrado) }
    })
    setH(hoja)
    setError(null)
  }, [token, vaciarCola, cola])

  useEffect(() => {
    cargar()
    const t = setInterval(() => document.visibilityState === 'visible' && cargar(), 60000)
    const vis = () => document.visibilityState === 'visible' && cargar()
    const online = () => cargar()
    document.addEventListener('visibilitychange', vis)
    window.addEventListener('online', online)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', vis)
      window.removeEventListener('online', online)
    }
  }, [cargar])

  async function marcar(p: ParadaChofer, m: Marca): Promise<string | null> {
    const { error } = await enviar(p.id, m)
    if (error && !esErrorDeRed(error.message)) return errMsg(error)
    if (error) {
      cola.escribir([...cola.leer(), { parada: p.id, marca: m, ts: Date.now() }])
      setEnCola(cola.leer().length)
      setAviso('Sin señal: lo dejé guardado en el celular y se manda solo cuando vuelva la conexión.')
    } else setAviso(m.resultado === 'pendiente' ? `${p.destino}: vuelve a estar pendiente.` : `${ESTADO_PARADA[m.resultado].icono} ${p.destino}: ${ESTADO_PARADA[m.resultado].label.toLowerCase()}${m.monto_cobrado ? ` · cobrado ${fmtMoney(m.monto_cobrado)}` : ''}${m.devolucion_detalle ? ' · con devolución' : ''}.`)
    setH((x) => (x ? { ...x, paradas: x.paradas.map((y) => (y.id === p.id ? aplicar(y, m) : y)) } : x))
    setAbierta(null)
    return null
  }

  /** "Terminé el recorrido": marca la hoja como terminada y muestra el informe. */
  async function terminar() {
    if (!h) return
    const faltan = (h.paradas ?? []).filter((p) => estadoParada(p) === 'pendiente').length
    if (faltan && !window.confirm(`Todavía quedan ${faltan} ${faltan === 1 ? 'parada sin marcar' : 'paradas sin marcar'}.\n\n¿Terminás el recorrido igual?`)) return
    setTerminando(true)
    await vaciarCola()
    if (cola.leer().length) {
      setTerminando(false)
      return setAviso('Sin señal: primero tienen que enviarse las marcas guardadas en el celular. Probá de nuevo cuando tengas conexión.')
    }
    const { data, error } = await sb().rpc('chofer_finalizar', { p_token: token })
    setTerminando(false)
    if (error) return setAviso(esErrorDeRed(error.message) ? 'Sin señal: no se pudo avisar que terminaste. Probá de nuevo cuando tengas conexión.' : errMsg(error))
    setH((x) => (x ? { ...x, finalizada_at: (data as string) ?? new Date().toISOString(), finalizada_por: x.finalizada_por ?? 'chofer', estado: 'completada' } : x))
    setAviso(null)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const paradas = useMemo(() => h?.paradas ?? [], [h])
  const pendientes = paradas.filter((p) => estadoParada(p) === 'pendiente')
  const siguiente = pendientes[0]?.id
  const tc = totalesCobro(paradas)
  const tr = totalesRuta(paradas)
  const hechas = paradas.length - pendientes.length

  // Recorrido de lo que falta, saliendo desde donde está el chofer (Maps usa la ubicación actual)
  const linkFaltan = useMemo(() => {
    const dirs = pendientes.map((p) => p.direccion).filter((d) => d?.trim()).slice(0, MAX_WAYPOINTS + 1)
    if (!dirs.length) return null
    const dest = dirs[dirs.length - 1]
    const wps = dirs.slice(0, -1)
    let url = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}&travelmode=driving`
    if (wps.length) url += `&waypoints=${wps.map(encodeURIComponent).join('%7C')}`
    return { url, cuantas: dirs.length }
  }, [pendientes])

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
        <div className="max-w-sm rounded-xl bg-white p-6 text-center shadow">
          <div className="text-xl font-bold text-slate-900">DE&amp;CO · Reparto</div>
          <p className="mt-3 text-slate-700">{error}</p>
          <button onClick={() => cargar()} className="mt-4 rounded-lg bg-brand-700 px-4 py-2 font-medium text-white">
            Reintentar
          </button>
        </div>
      </div>
    )
  }
  if (!h) return <div className="flex min-h-screen items-center justify-center text-slate-500">Cargando reparto…</div>

  const lista = verTodas ? paradas : paradas.filter((p) => estadoParada(p) === 'pendiente' || p.id === abierta?.id)

  return (
    <div className="min-h-screen bg-slate-100 pb-28">
      <header className="sticky top-0 z-10 bg-brand-900 px-4 pb-3 pt-3 text-white shadow">
        <div className="flex items-baseline justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-lg font-bold">{h.nombre || 'Reparto'}</div>
            <div className="text-xs capitalize text-brand-200">
              {fmtFechaLarga(h.fecha)}
              {h.chofer ? ` · ${h.chofer}` : ''}
              {h.hora_salida ? ` · sale ${h.hora_salida}` : ''}
            </div>
          </div>
          <button onClick={() => cargar()} className="shrink-0 rounded-md px-2 py-1 text-xs ring-1 ring-white/30" aria-label="Actualizar">
            ↻ Actualizar
          </button>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/20">
          <div className="h-full bg-emerald-400 transition-all" style={{ width: `${paradas.length ? (hechas / paradas.length) * 100 : 0}%` }} />
        </div>
        <div className="mt-1 flex justify-between text-xs text-brand-100">
          <span>
            {hechas}/{paradas.length} hechas · {tc.entregadas} entregadas{tc.parciales ? ` · ${tc.parciales} parciales` : ''}{tc.noEntregadas ? ` · ${tc.noEntregadas} sin entregar` : ''}{tc.devoluciones ? ` · ${tc.devoluciones} con devolución` : ''}
          </span>
          <span className="font-semibold tabular-nums">Cobrado {fmtMoney(tc.cobrado)}</span>
        </div>
      </header>

      <main className="mx-auto max-w-xl space-y-3 px-3 pt-3">
        {aviso && <div className="rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900">{aviso}</div>}
        {enCola > 0 && <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">{enCola} marca(s) esperando señal para enviarse.</div>}
        {h.finalizada_at && (
          <section className="rounded-xl bg-emerald-50 p-4 shadow-sm ring-2 ring-emerald-400">
            <div className="text-center">
              <div className="text-3xl">🏁</div>
              <div className="mt-1 text-lg font-bold text-emerald-900">¡Recorrido terminado!</div>
              <div className="text-sm text-emerald-800">La oficina ya ve el informe. Si querés, mandalo también por WhatsApp.</div>
            </div>
            <BotonWhatsappInforme h={h} paradas={paradas} grande className="mt-3 w-full" />
            <div className="mt-3">
              <InformeRuta h={h} paradas={paradas} />
            </div>
            <p className="mt-3 text-center text-xs text-emerald-800">Si te equivocaste en algo, tocá “Todas” y corregí: la oficina lo ve al instante.</p>
          </section>
        )}
        {h.observaciones && <div className="rounded-lg bg-white px-3 py-2 text-sm text-slate-700 shadow-sm">📝 {h.observaciones}</div>}

        {linkFaltan && (
          <a
            href={linkFaltan.url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center justify-center rounded-xl bg-[#1a73e8] px-4 py-3 text-base font-semibold text-white shadow"
          >
            🗺️ Recorrido de lo que falta{linkFaltan.cuantas < pendientes.length ? ` (próximas ${linkFaltan.cuantas})` : ''}
          </a>
        )}

        <div className="flex rounded-lg bg-white p-1 text-sm shadow-sm">
          <button onClick={() => setVerTodas(false)} className={cx('flex-1 rounded-md py-2 font-medium', !verTodas ? 'bg-brand-700 text-white' : 'text-slate-600')}>
            Faltan ({pendientes.length})
          </button>
          <button onClick={() => setVerTodas(true)} className={cx('flex-1 rounded-md py-2 font-medium', verTodas ? 'bg-brand-700 text-white' : 'text-slate-600')}>
            Todas ({paradas.length})
          </button>
        </div>

        {!lista.length && !h.finalizada_at && (
          <div className="rounded-xl bg-emerald-50 p-6 text-center text-emerald-800">
            <div className="text-3xl">🎉</div>
            <div className="mt-2 font-semibold">¡Marcaste todas las paradas!</div>
            <div className="mt-1 text-sm">Cobrado: {fmtMoney(tc.cobrado)}. Revisá en “Todas” y tocá <b>Terminé el recorrido</b>.</div>
          </div>
        )}

        {lista.map((p) => {
          const e = estadoParada(p)
          const vs = ventanasDe(p)
          const abiertaAca = abierta?.id === p.id
          const comps = (p.comprobantes ?? []) as ComprobanteRuta[]
          const tel = p.telefono?.replace(/[^\d+]/g, '')
          const wa = waLink(p.telefono, `Hola, te escribe el chofer de DE&CO. Estoy llegando con tu pedido.`)
          return (
            <article
              key={p.id}
              className={cx(
                'rounded-xl bg-white shadow-sm ring-1',
                p.id === siguiente ? 'ring-2 ring-brand-600' : e === 'entregado' ? 'ring-emerald-200' : e === 'parcial' ? 'ring-amber-300' : e === 'no_entregado' ? 'ring-red-200' : 'ring-slate-200',
              )}
            >
              <div className="p-4">
                <div className="flex items-start gap-3">
                  <span
                    className={cx(
                      'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-base font-bold text-white',
                      e === 'entregado' ? 'bg-emerald-600' : e === 'parcial' ? 'bg-amber-500' : e === 'no_entregado' ? 'bg-red-600' : 'bg-brand-700',
                    )}
                  >
                    {e === 'pendiente' ? p.orden : ESTADO_PARADA[e].icono}
                  </span>
                  <div className="min-w-0 flex-1">
                    {p.id === siguiente && <div className="text-[11px] font-semibold uppercase tracking-wide text-brand-700">Siguiente</div>}
                    <div className="text-lg font-semibold leading-tight text-slate-900">{p.destino}</div>
                    <div className="mt-0.5 text-sm text-slate-600">📍 {p.direccion}</div>
                    {(vs.length > 0 || p.llegada_estimada) && (
                      <div className="mt-1 flex flex-wrap gap-2 text-xs">
                        {vs.length > 0 && <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-900">🕑 Atiende {fmtVentanas(vs)}</span>}
                        {p.llegada_estimada && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">Llegada ≈ {p.llegada_estimada}</span>}
                      </div>
                    )}
                  </div>
                </div>

                {(p.que_lleva || p.bultos) && (
                  <div className="mt-3 text-sm text-slate-800">
                    📦 {p.que_lleva}
                    {p.bultos ? ` (${p.bultos} ${p.bultos === 1 ? 'bulto' : 'bultos'})` : ''}
                  </div>
                )}
                {p.observaciones && <div className="mt-1 text-sm text-amber-800">⚠️ {p.observaciones}</div>}
                {p.monto_factura != null && (
                  <div className="mt-2 rounded-lg bg-slate-50 px-3 py-2">
                    <div className="flex items-baseline justify-between">
                      <span className="text-sm text-slate-600">{p.monto_factura < 0 ? 'Nota de crédito' : 'A cobrar'}</span>
                      <span className={cx('text-lg font-bold tabular-nums', p.monto_factura < 0 ? 'text-red-700' : 'text-slate-900')}>{fmtMoney(p.monto_factura)}</span>
                    </div>
                    {comps.length > 0 && <div className="text-xs text-slate-500">{comps.map((c) => etiquetaComprobante(c)).join(' · ')}</div>}
                  </div>
                )}

                <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
                  <a
                    href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(p.direccion)}&travelmode=driving`}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-lg border border-slate-300 py-2 text-center font-medium text-brand-800"
                  >
                    Cómo llegar
                  </a>
                  {tel ? (
                    <a href={`tel:${tel}`} className="rounded-lg border border-slate-300 py-2 text-center font-medium text-brand-800">
                      Llamar
                    </a>
                  ) : (
                    <span className="rounded-lg border border-slate-200 py-2 text-center text-slate-300">Sin teléfono</span>
                  )}
                  {wa ? (
                    <a href={wa} target="_blank" rel="noreferrer" className="rounded-lg border border-emerald-300 py-2 text-center font-medium text-emerald-700">
                      WhatsApp
                    </a>
                  ) : (
                    <span className="rounded-lg border border-slate-200 py-2 text-center text-slate-300">WhatsApp</span>
                  )}
                </div>

                {e !== 'pendiente' && !abiertaAca && (
                  <div className="mt-3 space-y-2">
                    <ResumenMarca p={p} />
                    <div className="flex gap-2">
                      <button onClick={() => setAbierta({ id: p.id })} className="flex-1 rounded-lg border border-slate-300 py-2 text-sm font-medium text-slate-700">
                        Corregir
                      </button>
                      <button
                        onClick={() => {
                          if (window.confirm('¿Volver a dejarla pendiente?'))
                            marcar(p, MARCA_PENDIENTE).then((err) => err && setAviso(err))
                        }}
                        className="flex-1 rounded-lg border border-slate-300 py-2 text-sm font-medium text-slate-500"
                      >
                        Deshacer
                      </button>
                    </div>
                  </div>
                )}

                {e === 'pendiente' && !abiertaAca && (
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button onClick={() => setAbierta({ id: p.id, inicial: 'entregado' })} className="rounded-lg bg-emerald-600 py-3.5 text-base font-semibold text-white">
                      ✓ Entregado
                    </button>
                    <button onClick={() => setAbierta({ id: p.id, inicial: 'no_entregado' })} className="rounded-lg bg-red-600 py-3.5 text-base font-semibold text-white">
                      ✗ No entregado
                    </button>
                  </div>
                )}
              </div>
              {abiertaAca && (
                <div className="border-t border-slate-100 bg-slate-50 p-3">
                  <MarcarParada p={p} inicial={abierta?.inicial} grande onGuardar={(m) => marcar(p, m)} onCancelar={() => setAbierta(null)} />
                </div>
              )}
            </article>
          )
        })}

        {!h.finalizada_at && paradas.length > 0 && (
          <div className="pt-2">
            <button
              onClick={terminar}
              disabled={terminando}
              className={cx(
                'w-full rounded-xl px-4 py-4 text-lg font-bold text-white shadow disabled:opacity-60',
                pendientes.length ? 'bg-slate-700' : 'bg-emerald-600',
              )}
            >
              {terminando ? 'Enviando…' : '🏁 Terminé el recorrido'}
            </button>
            <p className="mt-1 text-center text-xs text-slate-500">
              {pendientes.length ? `Quedan ${pendientes.length} sin marcar: te voy a preguntar antes.` : 'Le avisa a la oficina y arma el informe del reparto.'}
            </p>
          </div>
        )}
      </main>

      <footer className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white/95 px-4 py-2 text-sm shadow-[0_-2px_8px_rgba(0,0,0,0.05)] backdrop-blur">
        <div className="mx-auto flex max-w-xl items-baseline justify-between gap-3">
          <div className="text-slate-600">
            {tr.conMonto > 0 && <div>A cobrar: <b className="tabular-nums text-slate-900">{fmtMoney(tr.total)}</b></div>}
            <div className="text-xs">
              {FORMAS_PAGO.filter((f) => tc.porForma[f.k as FormaPago]).map((f) => `${f.label} ${fmtMoney(tc.porForma[f.k as FormaPago])}`).join(' · ') || 'Todavía no cobraste nada'}
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs text-slate-500">Cobrado</div>
            <div className="text-lg font-bold tabular-nums text-emerald-700">{fmtMoney(tc.cobrado)}</div>
          </div>
        </div>
      </footer>
    </div>
  )
}
