'use client'

import type { Parada } from '@/lib/types'
import { fmtFechaLarga, fmtMoney } from '@/lib/utils'
import { ESTADO_PARADA, FORMAS_PAGO, estadoParada, horaAR, textoInformeRuta, totalesCobro, waInformeRuta } from '@/lib/rutas'
import { cx } from '@/components/ui'

type HojaInforme = { fecha: string; nombre: string | null; chofer: string | null; finalizada_at?: string | null; finalizada_por?: string | null }

/** Botón verde "Mandar por WhatsApp" con el resumen del informe (se elige el contacto en WhatsApp). */
export function BotonWhatsappInforme({ h, paradas, className, grande }: { h: HojaInforme; paradas: Parada[]; className?: string; grande?: boolean }) {
  return (
    <a
      href={waInformeRuta(textoInformeRuta(h, paradas))}
      target="_blank"
      rel="noreferrer"
      className={cx(
        'flex items-center justify-center rounded-lg bg-emerald-600 font-semibold text-white shadow-sm hover:bg-emerald-700',
        grande ? 'px-4 py-3.5 text-base' : 'px-3.5 py-2 text-sm',
        className,
      )}
    >
      📲 Mandar informe por WhatsApp
    </a>
  )
}

/**
 * Informe de la ruta: entregados, parciales, no entregados (con motivo), cobrado por forma de pago,
 * devoluciones y hora en que se terminó. Lo ven la oficina (hoja de ruta) y el chofer (al terminar).
 * `impreso` = versión en blanco y negro para la impresora.
 */
export function InformeRuta({ h, paradas, impreso, children }: { h: HojaInforme; paradas: Parada[]; impreso?: boolean; children?: React.ReactNode }) {
  const t = totalesCobro(paradas)
  const porEstado = (e: ReturnType<typeof estadoParada>) => paradas.filter((p) => estadoParada(p) === e)
  const parciales = porEstado('parcial')
  const noEnt = porEstado('no_entregado')
  const pend = porEstado('pendiente')
  const devs = paradas.filter((p) => p.devolucion_detalle)
  const caja = impreso ? 'border border-black p-2' : 'rounded-lg bg-white p-2 ring-1 ring-slate-200'
  const titulo = impreso ? 'mb-1 text-xs font-bold uppercase' : 'mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500'

  return (
    <div className={cx('space-y-3 text-sm', impreso && 'text-black')}>
      {impreso && (
        <div className="border-b-2 border-black pb-2">
          <div className="text-lg font-bold">DE&amp;CO · Informe de la ruta{h.nombre ? ` – ${h.nombre}` : ''}</div>
          <div className="capitalize">
            {fmtFechaLarga(h.fecha)}
            {h.chofer ? ` · Chofer: ${h.chofer}` : ''}
          </div>
        </div>
      )}
      {h.finalizada_at && (
        <div className={impreso ? 'font-semibold' : 'font-medium text-emerald-800'}>
          ✅ Terminada a las {horaAR(h.finalizada_at)}
          {h.finalizada_por && h.finalizada_por !== 'chofer' ? ` (la cerró ${h.finalizada_por})` : ' por el chofer'}
        </div>
      )}

      <dl className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
        {(
          [
            ['Entregados', t.entregadas, 'text-emerald-700'],
            ['Parciales', t.parciales, 'text-amber-700'],
            ['No entregados', t.noEntregadas, 'text-red-700'],
            ['Sin marcar', t.pendientes, 'text-slate-500'],
          ] as const
        ).map(([l, n, c]) => (
          <div key={l} className={caja}>
            <dt className="text-[11px] uppercase tracking-wide text-slate-500">{l}</dt>
            <dd className={cx('text-xl font-bold tabular-nums', !impreso && n > 0 && c)}>{n}</dd>
          </div>
        ))}
      </dl>

      {(noEnt.length > 0 || parciales.length > 0 || pend.length > 0) && (
        <div className={caja}>
          {noEnt.length > 0 && (
            <>
              <div className={titulo}>{ESTADO_PARADA.no_entregado.icono} No entregados</div>
              <ul className="mb-2 space-y-0.5">
                {noEnt.map((p, i) => (
                  <li key={i}>
                    <b>{p.destino}</b>
                    {p.motivo ? <span className={impreso ? '' : 'text-red-700'}> – {p.motivo}</span> : ''}
                  </li>
                ))}
              </ul>
            </>
          )}
          {parciales.length > 0 && (
            <>
              <div className={titulo}>{ESTADO_PARADA.parcial.icono} Entregas parciales</div>
              <ul className="mb-2 space-y-0.5">
                {parciales.map((p, i) => (
                  <li key={i}>
                    <b>{p.destino}</b>
                    {p.motivo ? <span className={impreso ? '' : 'text-amber-800'}> – faltó: {p.motivo}</span> : ''}
                  </li>
                ))}
              </ul>
            </>
          )}
          {pend.length > 0 && (
            <>
              <div className={titulo}>⏳ Quedaron sin marcar</div>
              <ul className="space-y-0.5">
                {pend.map((p, i) => (
                  <li key={i}>{p.destino}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <div className={caja}>
        <div className={titulo}>Cobrado</div>
        <dl className="space-y-0.5">
          {FORMAS_PAGO.filter((f) => t.porForma[f.k]).map((f) => (
            <div key={f.k} className="flex justify-between">
              <dt>{f.label}</dt>
              <dd className="tabular-nums">{fmtMoney(t.porForma[f.k])}</dd>
            </div>
          ))}
          {t.porForma.sin_forma > 0 && (
            <div className="flex justify-between">
              <dt>Sin forma de pago</dt>
              <dd className="tabular-nums">{fmtMoney(t.porForma.sin_forma)}</dd>
            </div>
          )}
          <div className={cx('flex justify-between border-t pt-1 font-bold', impreso ? 'border-black' : 'border-slate-200 text-emerald-800')}>
            <dt>Total cobrado</dt>
            <dd className="tabular-nums">{fmtMoney(t.cobrado)}</dd>
          </div>
          {t.porForma.efectivo > 0 && (
            <div className="flex justify-between text-xs">
              <dt>Efectivo a rendir</dt>
              <dd className="tabular-nums">{fmtMoney(t.porForma.efectivo)}</dd>
            </div>
          )}
        </dl>
      </div>

      <div className={caja}>
        <div className={titulo}>
          ↩ Devoluciones{devs.length ? ` (${devs.length})` : ''}
          {t.devuelto ? ` · ${fmtMoney(t.devuelto)}` : ''}
        </div>
        {devs.length === 0 ? (
          <p className="text-slate-500">Sin devoluciones.</p>
        ) : (
          <table className="w-full text-left">
            <thead>
              <tr className="text-[11px] uppercase text-slate-500">
                <th className="py-0.5 pr-2 font-medium">Cliente</th>
                <th className="py-0.5 pr-2 font-medium">Qué devolvió</th>
                <th className="py-0.5 pr-2 font-medium">Motivo</th>
                <th className="py-0.5 text-right font-medium">Monto</th>
              </tr>
            </thead>
            <tbody>
              {devs.map((p, i) => (
                <tr key={i} className={impreso ? 'border-t border-black' : 'border-t border-slate-100'}>
                  <td className="py-1 pr-2 font-medium">{p.destino}</td>
                  <td className="py-1 pr-2">{p.devolucion_detalle}</td>
                  <td className="py-1 pr-2">{p.devolucion_motivo || '—'}</td>
                  <td className="py-1 text-right tabular-nums">{p.devolucion_monto != null ? fmtMoney(p.devolucion_monto) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {children}
    </div>
  )
}
