'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { fmtFecha, fmtMoney, hoy, sumarDias } from '@/lib/utils'
import { DiaProy, ItemProy, Proyeccion, nivelSaldo } from '@/lib/flujo'
import { ESTADO_MOV, MEDIOS, Movimiento, etiquetaMov } from '@/lib/tesoreria'
import { ESTADO_OBL } from '@/lib/pagos'
import type { AccionMov } from './Tesoreria'
import { useAuth } from './AuthProvider'
import { Badge, Button, cx } from './ui'


const DIAS_CORTOS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb']
const diaSemana = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return DIAS_CORTOS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
}
export const fmtCorto = (n: number) => {
  const a = Math.abs(n)
  const s = a >= 1e6 ? `${(a / 1e6).toLocaleString('es-AR', { maximumFractionDigits: 1 })} M` : a >= 1e3 ? `${Math.round(a / 1e3).toLocaleString('es-AR')} k` : `${Math.round(a)}`
  return (n < 0 ? '−$ ' : '$ ') + s
}

// ---------------------------------------------------------------------
// Gráfico del saldo proyectado (área + línea, cero y colchón como referencia)
// ---------------------------------------------------------------------
function useAncho<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [w, setW] = useState(800)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

export function SaldoChart({ proy, colchon, seleccionado, onDia }: { proy: Proyeccion; colchon: number; seleccionado: string | null; onDia: (f: string) => void }) {
  const [ref, W] = useAncho<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const H = 230
  const pad = { l: 64, r: 12, t: 14, b: 28 }
  const dias = proy.dias
  const vals = [proy.saldoInicial, ...dias.map((d) => d.saldo), 0, colchon]
  let lo = Math.min(...vals)
  let hi = Math.max(...vals)
  if (hi === lo) hi = lo + 1
  const span = hi - lo
  lo -= span * 0.08
  hi += span * 0.08
  const x = (i: number) => pad.l + (dias.length <= 1 ? 0 : (i / (dias.length - 1)) * (W - pad.l - pad.r))
  const y = (v: number) => pad.t + ((hi - v) / (hi - lo)) * (H - pad.t - pad.b)
  const ticks = useMemo(() => {
    const raw = (hi - lo) / 4
    const p = Math.pow(10, Math.floor(Math.log10(Math.abs(raw) || 1)))
    const paso = [1, 2, 2.5, 5, 10].map((k) => k * p).find((k) => k >= raw) ?? raw
    const out: number[] = []
    for (let v = Math.ceil(lo / paso) * paso; v <= hi; v += paso) out.push(Math.round(v))
    return out
  }, [lo, hi])
  const linea = dias.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.saldo).toFixed(1)}`).join(' ')
  const area = `${linea} L${x(dias.length - 1).toFixed(1)},${y(Math.max(lo, Math.min(0, hi))).toFixed(1)} L${x(0).toFixed(1)},${y(Math.max(lo, Math.min(0, hi))).toFixed(1)} Z`
  const y0 = y(0)
  const cada = Math.ceil(dias.length / Math.max(2, Math.floor((W - pad.l) / 64)))

  function mover(e: React.PointerEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect()
    const px = ((e.clientX - r.left) / r.width) * W
    const i = Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (dias.length - 1))
    setHover(Math.max(0, Math.min(dias.length - 1, i)))
  }
  const hd = hover != null ? dias[hover] : null

  return (
    <div ref={ref} className="relative w-full select-none">
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        className="block touch-none"
        onPointerMove={mover}
        onPointerLeave={() => setHover(null)}
        onClick={() => hd && onDia(hd.fecha)}
        role="img"
        aria-label={`Saldo proyectado: mínimo ${fmtMoney(proy.minimo.saldo)} el ${fmtFecha(proy.minimo.fecha)}, final ${fmtMoney(proy.saldoFinal)}`}
      >
        <defs>
          <clipPath id="sobre-cero">
            <rect x={0} y={0} width={W} height={Math.max(0, y0)} />
          </clipPath>
          <clipPath id="bajo-cero">
            <rect x={0} y={y0} width={W} height={Math.max(0, H - y0)} />
          </clipPath>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="#e2e8f0" strokeWidth={1} />
            <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="#64748b" className="tabular-nums">
              {fmtCorto(t)}
            </text>
          </g>
        ))}
        <path d={area} fill="#357a7c" fillOpacity={0.14} clipPath="url(#sobre-cero)" />
        <path d={area} fill="#dc2626" fillOpacity={0.16} clipPath="url(#bajo-cero)" />
        {lo < 0 && hi > 0 && <line x1={pad.l} x2={W - pad.r} y1={y0} y2={y0} stroke="#475569" strokeWidth={1} />}
        {colchon > 0 && colchon > lo && colchon < hi && (
          <g>
            <line x1={pad.l} x2={W - pad.r} y1={y(colchon)} y2={y(colchon)} stroke="#d97706" strokeWidth={1} strokeDasharray="4 4" />
            <text x={W - pad.r} y={y(colchon) - 4} textAnchor="end" fontSize={11} fill="#92400e">
              colchón
            </text>
          </g>
        )}
        <path d={linea} fill="none" stroke="#245153" strokeWidth={2} clipPath="url(#sobre-cero)" strokeLinejoin="round" />
        <path d={linea} fill="none" stroke="#b91c1c" strokeWidth={2} clipPath="url(#bajo-cero)" strokeLinejoin="round" />
        {dias.map((d, i) =>
          d.saldo < 0 && (dias[i - 1]?.saldo ?? 0) >= 0 ? <circle key={d.fecha} cx={x(i)} cy={y(d.saldo)} r={4.5} fill="#b91c1c" stroke="#fff" strokeWidth={2} /> : null,
        )}
        {seleccionado && dias.findIndex((d) => d.fecha === seleccionado) >= 0 && (
          <line
            x1={x(dias.findIndex((d) => d.fecha === seleccionado))}
            x2={x(dias.findIndex((d) => d.fecha === seleccionado))}
            y1={pad.t}
            y2={H - pad.b}
            stroke="#245153"
            strokeOpacity={0.18}
            strokeWidth={4}
          />
        )}
        {dias.map((d, i) =>
          i % cada === 0 ? (
            <text key={d.fecha} x={x(i)} y={H - 8} textAnchor={i === 0 ? 'start' : 'middle'} fontSize={11} fill="#64748b">
              {i === 0 ? 'hoy' : `${d.fecha.slice(8)}/${d.fecha.slice(5, 7)}`}
            </text>
          ) : null,
        )}
        {hd && hover != null && (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} stroke="#94a3b8" strokeWidth={1} />
            <circle cx={x(hover)} cy={y(hd.saldo)} r={5} fill={hd.saldo < 0 ? '#b91c1c' : '#245153'} stroke="#fff" strokeWidth={2} />
          </g>
        )}
      </svg>
      {hd && hover != null && (
        <div
          className="pointer-events-none absolute top-2 z-10 w-52 rounded-lg border border-slate-200 bg-white p-2.5 text-xs shadow-lg"
          style={{ left: Math.min(Math.max(0, x(hover) + 12), W - 214) }}
        >
          <div className="font-medium capitalize text-slate-900">
            {diaSemana(hd.fecha)} {fmtFecha(hd.fecha)}
          </div>
          {hd.ingresos > 0 && <div className="mt-1 flex justify-between text-emerald-700"><span>Entra</span><span className="tabular-nums">{fmtMoney(hd.ingresos)}</span></div>}
          {hd.egresos > 0 && <div className="flex justify-between text-red-700"><span>Sale</span><span className="tabular-nums">{fmtMoney(hd.egresos)}</span></div>}
          <div className="mt-1 flex justify-between border-t border-slate-100 pt-1 font-semibold">
            <span>Saldo</span>
            <span className={cx('tabular-nums', hd.saldo < 0 ? 'text-red-700' : 'text-slate-900')}>{fmtMoney(hd.saldo)}</span>
          </div>
          {hd.items.length > 0 && <div className="mt-1 text-slate-500">{hd.items.length} movimiento(s) · clic para ver</div>}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------
// Calendario mensual con saldo por día
// ---------------------------------------------------------------------
export function Calendario({
  proy,
  colchon,
  mes,
  seleccionado,
  onDia,
}: {
  proy: Proyeccion
  colchon: number
  mes: string // YYYY-MM-01
  seleccionado: string | null
  onDia: (f: string) => void
}) {
  const porFecha = useMemo(() => new Map(proy.dias.map((d) => [d.fecha, d])), [proy])
  const [y, m] = mes.split('-').map(Number)
  const primero = new Date(Date.UTC(y, m - 1, 1)).getUTCDay()
  const offset = primero === 0 ? 6 : primero - 1
  const diasMes = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const celdas: (string | null)[] = [...Array(offset).fill(null), ...Array.from({ length: diasMes }, (_, i) => `${mes.slice(0, 8)}${String(i + 1).padStart(2, '0')}`)]
  while (celdas.length % 7) celdas.push(null)
  const ref = hoy()

  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[540px] grid-cols-7 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 text-xs">
        {['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].map((d) => (
          <div key={d} className="bg-slate-50 px-2 py-1.5 text-center font-medium uppercase tracking-wide text-slate-500">
            {d}
          </div>
        ))}
        {celdas.map((f, i) => {
          if (!f) return <div key={i} className="min-h-[86px] bg-slate-50/60" />
          const d = porFecha.get(f)
          const pasado = f < ref
          const nivel = d ? nivelSaldo(d.saldo, colchon) : 'ok'
          return (
            <button
              key={f}
              type="button"
              disabled={!d}
              onClick={() => d && onDia(f)}
              className={cx(
                'relative min-h-[86px] p-1.5 text-left transition focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600',
                !d ? 'bg-white text-slate-300' : nivel === 'negativo' ? 'bg-red-50 hover:bg-red-100' : nivel === 'bajo' ? 'bg-amber-50 hover:bg-amber-100' : 'bg-white hover:bg-brand-50',
                seleccionado === f && 'ring-2 ring-inset ring-brand-600',
              )}
            >
              <div className="flex items-center justify-between">
                <span className={cx('font-medium', f === ref ? 'flex h-5 w-5 items-center justify-center rounded-full bg-brand-700 text-white' : pasado ? 'text-slate-300' : 'text-slate-700')}>
                  {Number(f.slice(8))}
                </span>
                {d && d.items.length > 0 && <span className="text-[10px] text-slate-400">{d.items.length} mov.</span>}
              </div>
              {d && (
                <div className="mt-1 space-y-0.5 tabular-nums">
                  {d.ingresos > 0 && <div className="truncate text-emerald-700">+{fmtCorto(d.ingresos).replace('$ ', '$')}</div>}
                  {d.egresos > 0 && <div className="truncate text-red-700">−{fmtCorto(d.egresos).replace('$ ', '$')}</div>}
                  <div className={cx('truncate font-semibold', nivel === 'negativo' ? 'text-red-700' : nivel === 'bajo' ? 'text-amber-800' : 'text-slate-800')}>
                    {nivel === 'negativo' && '⚠ '}
                    {fmtCorto(d.saldo)}
                  </div>
                </div>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// Fila de un movimiento previsto con sus acciones
// ---------------------------------------------------------------------
export function ItemFila({ it, onAccion }: { it: ItemProy; onAccion: (accion: AccionMov, m: Movimiento) => void }) {
  const { esGerencia } = useAuth()
  const m = it.ref
  const egreso = it.tipo === 'egreso'
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-2.5">
      <span className={cx('mt-1 h-2 w-2 shrink-0 rounded-full', egreso ? 'bg-red-500' : 'bg-emerald-500')} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-slate-900">{it.concepto}</div>
        <div className="text-xs text-slate-500">
          {[it.contraparte, it.categoria, m ? MEDIOS[m.medio] : null, it.prioridad && it.prioridad !== 'media' ? `prioridad ${it.prioridad}` : null].filter(Boolean).join(' · ')}
          {it.atrasado && <span className="ml-1 font-medium text-red-600">· atrasado (era {fmtFecha(it.fechaOriginal)})</span>}
        </div>
      </div>
      <div className="flex flex-col items-end gap-1">
        <span className={cx('text-sm font-semibold tabular-nums', egreso ? 'text-red-700' : 'text-emerald-700')}>
          {egreso ? '−' : '+'} {fmtMoney(it.monto)}
        </span>
        {it.origen === 'cobranza' ? (
          <Badge tone="brand">Factura a cobrar</Badge>
        ) : it.origen === 'obligacion' && it.obl ? (
          <Badge tone={ESTADO_OBL[it.obl.estado].tone}>{ESTADO_OBL[it.obl.estado].label}</Badge>
        ) : it.origen === 'simulacion' ? (
          <Badge tone="orange">Simulación</Badge>
        ) : it.interno ? (
          <Badge tone="blue">Transferencia propia</Badge>
        ) : (
          m && <Badge tone={ESTADO_MOV[m.estado].tone}>{etiquetaMov(m)}</Badge>
        )}
      </div>
      {it.origen === 'obligacion' && (
        <div className="flex w-full justify-end pl-5">
          <Link href="/pagos" className="text-xs font-medium text-brand-700 hover:underline">
            Decidir / pagar en Cuentas a pagar →
          </Link>
        </div>
      )}
      {m && !it.interno && (
        <div className="flex w-full flex-wrap justify-end gap-1.5 pl-5">
          {egreso && m.estado === 'pendiente' && esGerencia && (
            <Button size="sm" variant="success" onClick={() => onAccion('autorizar', m)}>
              Autorizar
            </Button>
          )}
          {egreso && m.estado === 'pendiente' && !esGerencia && <span className="self-center text-xs text-amber-700">Esperando autorización de Gerencia</span>}
          {m.cheque_id && <span className="self-center text-xs text-slate-500">Se resuelve desde Cheques</span>}
          {!m.cheque_id && ((egreso && m.estado === 'autorizado') || (!egreso && m.estado === 'pendiente')) && (
            <Button size="sm" onClick={() => onAccion('ejecutar', m)}>
              {egreso ? 'Pagar' : 'Cobrar'}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => onAccion('editar', m)}>
            Editar
          </Button>
          {!m.cheque_id && !m.cobro_id && (
            <Button size="sm" variant="ghost" onClick={() => onAccion('anular', m)}>
              Anular
            </Button>
          )}
        </div>
      )}
    </li>
  )
}

export function DiaResumen({ d, colchon }: { d: DiaProy; colchon: number }) {
  const nivel = nivelSaldo(d.saldo, colchon)
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <div className="font-semibold capitalize text-slate-900">
        {diaSemana(d.fecha)} {fmtFecha(d.fecha)}
        {d.fecha === hoy() && <span className="ml-2 text-xs font-medium text-brand-700">hoy</span>}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-sm tabular-nums">
        {d.ingresos > 0 && <span className="whitespace-nowrap text-emerald-700">+ {fmtMoney(d.ingresos)}</span>}
        {d.egresos > 0 && <span className="whitespace-nowrap text-red-700">− {fmtMoney(d.egresos)}</span>}
        <span className={cx('whitespace-nowrap font-semibold', nivel === 'negativo' ? 'text-red-700' : nivel === 'bajo' ? 'text-amber-800' : 'text-slate-900')}>
          Saldo {fmtMoney(d.saldo)}
        </span>
      </div>
    </div>
  )
}

export const manana = () => sumarDias(hoy(), 1)
