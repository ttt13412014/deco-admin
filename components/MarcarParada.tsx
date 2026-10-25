'use client'

import { useState } from 'react'
import type { FormaPago, Parada } from '@/lib/types'
import { ESTADO_PARADA, FORMAS_PAGO, MOTIVOS_DEVOLUCION, MOTIVOS_NO_ENTREGA, estadoParada, labelFormaPago, type EstadoParada } from '@/lib/rutas'
import { parsearNumeroAR } from '@/lib/factura-pdf'
import { fmtMoney } from '@/lib/utils'
import { Badge, cx, inputCls } from './ui'

export interface Marca {
  resultado: EstadoParada
  motivo: string | null
  monto_cobrado: number | null
  forma_pago: FormaPago | null
  nota: string | null
  devolucion_detalle: string | null
  devolucion_motivo: string | null
  devolucion_monto: number | null
}

type P = Pick<
  Parada,
  | 'entregado' | 'resultado' | 'motivo' | 'monto_cobrado' | 'forma_pago' | 'nota_entrega' | 'monto_factura' | 'marcado_at' | 'marcado_por' | 'entregado_at'
  | 'devolucion_detalle' | 'devolucion_motivo' | 'devolucion_monto'
>

/** Marca vacía para volver una parada a pendiente. */
export const MARCA_PENDIENTE: Marca = {
  resultado: 'pendiente', motivo: null, monto_cobrado: null, forma_pago: null, nota: null,
  devolucion_detalle: null, devolucion_motivo: null, devolucion_monto: null,
}

const hora = (iso?: string | null) => (iso ? new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Argentina/Cordoba' }) : '')

/** Resumen de lo marcado: "✓ Entregado 10:32 · Cobró $ 12.000 (Efectivo) · Recibió: Juan" */
export function ResumenMarca({ p, className }: { p: P; className?: string }) {
  const e = estadoParada(p)
  if (e === 'pendiente') return null
  const cuando = hora(p.marcado_at ?? p.entregado_at)
  return (
    <div className={cx('flex flex-wrap items-center gap-x-2 gap-y-1 text-sm', className)}>
      <Badge tone={ESTADO_PARADA[e].tone}>
        {ESTADO_PARADA[e].icono} {ESTADO_PARADA[e].label}
        {cuando ? ` ${cuando}` : ''}
      </Badge>
      {e === 'no_entregado' && p.motivo && <span className="text-red-700">Motivo: {p.motivo}</span>}
      {e === 'parcial' && p.motivo && <span className="text-amber-800">Faltó: {p.motivo}</span>}
      {p.monto_cobrado != null && (
        <span className="font-medium tabular-nums text-emerald-800">
          Cobró {fmtMoney(p.monto_cobrado)}
          {p.forma_pago ? ` (${labelFormaPago(p.forma_pago)})` : ''}
        </span>
      )}
      {p.nota_entrega && <span className="text-slate-600">· {e !== 'no_entregado' ? 'Recibió: ' : ''}{p.nota_entrega}</span>}
      {p.devolucion_detalle && (
        <span className="rounded bg-violet-50 px-1.5 py-0.5 text-violet-800">
          ↩ Devolvió: {p.devolucion_detalle}
          {p.devolucion_motivo ? ` (${p.devolucion_motivo})` : ''}
          {p.devolucion_monto != null ? ` · ${fmtMoney(p.devolucion_monto)}` : ''}
        </span>
      )}
      {p.marcado_por && <span className="text-xs text-slate-400">· marcó {p.marcado_por}</span>}
    </div>
  )
}

/**
 * Formulario para marcar una parada (lo usan el chofer desde el celular y la oficina desde la hoja).
 * `grande` = botones y letras grandes para el celular.
 */
export function MarcarParada({
  p,
  inicial,
  grande,
  onGuardar,
  onCancelar,
}: {
  p: P
  /** Con qué opción arranca (si el chofer ya tocó "Entregado" / "No entregado"). */
  inicial?: EstadoParada
  grande?: boolean
  onGuardar: (m: Marca) => Promise<string | null>
  onCancelar?: () => void
}) {
  const actual = estadoParada(p)
  const [res, setRes] = useState<EstadoParada>(inicial ?? (actual === 'pendiente' ? 'entregado' : actual))
  const motivoPrevio = p.motivo ?? ''
  const chipPrevio = MOTIVOS_NO_ENTREGA.find((m) => motivoPrevio === m || motivoPrevio.startsWith(`${m}: `))
  const [motivo, setMotivo] = useState<string>(chipPrevio ?? (motivoPrevio ? 'Otro' : ''))
  const [detalle, setDetalle] = useState(chipPrevio ? motivoPrevio.slice(chipPrevio.length + 2) : motivoPrevio)
  const [monto, setMonto] = useState(p.monto_cobrado != null ? String(p.monto_cobrado).replace('.', ',') : '')
  const [forma, setForma] = useState<FormaPago | null>(p.forma_pago ?? 'efectivo')
  const [nota, setNota] = useState(p.nota_entrega ?? '')
  const [faltante, setFaltante] = useState(actual === 'parcial' ? p.motivo ?? '' : '')
  const [devolvio, setDevolvio] = useState(!!p.devolucion_detalle)
  const [devDetalle, setDevDetalle] = useState(p.devolucion_detalle ?? '')
  const [devMotivo, setDevMotivo] = useState(p.devolucion_motivo ?? '')
  const [devMonto, setDevMonto] = useState(p.devolucion_monto != null ? String(p.devolucion_monto).replace('.', ',') : '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const aCobrar = p.monto_factura != null && p.monto_factura > 0 ? p.monto_factura : null
  const montoN = monto.trim() ? parsearNumeroAR(monto) : null
  const devMontoN = devMonto.trim() ? parsearNumeroAR(devMonto) : null
  const btn = grande ? 'px-2 py-3 text-base' : 'px-2.5 py-1.5 text-sm'
  const chip = (activo: boolean) =>
    cx('rounded-full border font-medium transition', grande ? 'px-3.5 py-2 text-sm' : 'px-2.5 py-1 text-xs', activo ? 'border-brand-700 bg-brand-700 text-white' : 'border-slate-300 bg-white text-slate-700')

  async function guardar() {
    setError(null)
    if (monto.trim() && (montoN == null || montoN < 0)) return setError('El monto cobrado está mal escrito.')
    let mot: string | null = null
    if (res === 'no_entregado') {
      if (!motivo) return setError('Elegí el motivo.')
      if (motivo === 'Otro' && !detalle.trim()) return setError('Escribí el motivo.')
      mot = motivo === 'Otro' ? detalle.trim() : detalle.trim() ? `${motivo}: ${detalle.trim()}` : motivo
    }
    if (res === 'parcial') mot = faltante.trim() || null
    if (devolvio) {
      if (!devDetalle.trim()) return setError('Escribí qué devolvió el cliente.')
      if (devMonto.trim() && (devMontoN == null || devMontoN < 0)) return setError('El monto de la devolución está mal escrito.')
    }
    setBusy(true)
    const err = await onGuardar({
      resultado: res,
      motivo: mot,
      monto_cobrado: montoN,
      forma_pago: montoN ? forma : null,
      nota: nota.trim() || null,
      devolucion_detalle: devolvio ? devDetalle.trim() : null,
      devolucion_motivo: devolvio ? devMotivo || null : null,
      devolucion_monto: devolvio ? devMontoN : null,
    })
    setBusy(false)
    if (err) setError(err)
  }

  return (
    <div className={cx('space-y-3 rounded-xl border border-slate-200 bg-white', grande ? 'p-4' : 'p-3')}>
      <div className="grid grid-cols-3 gap-2">
        <button
          type="button"
          onClick={() => setRes('entregado')}
          className={cx('rounded-lg font-semibold', btn, res === 'entregado' ? 'bg-emerald-600 text-white' : 'border border-emerald-300 bg-emerald-50 text-emerald-800')}
        >
          ✓ Entregado
        </button>
        <button
          type="button"
          onClick={() => setRes('parcial')}
          className={cx('rounded-lg font-semibold', btn, res === 'parcial' ? 'bg-amber-500 text-white' : 'border border-amber-300 bg-amber-50 text-amber-900')}
        >
          ◐ Parcial
        </button>
        <button
          type="button"
          onClick={() => setRes('no_entregado')}
          className={cx('rounded-lg font-semibold', btn, res === 'no_entregado' ? 'bg-red-600 text-white' : 'border border-red-300 bg-red-50 text-red-800')}
        >
          ✗ No entregado
        </button>
      </div>

      {res === 'no_entregado' && (
        <div className="space-y-2">
          <div className={cx('font-medium text-slate-700', grande ? 'text-sm' : 'text-xs')}>Motivo</div>
          <div className="flex flex-wrap gap-2">
            {MOTIVOS_NO_ENTREGA.map((m) => (
              <button key={m} type="button" className={chip(motivo === m)} onClick={() => setMotivo(m)}>
                {m}
              </button>
            ))}
          </div>
          <input
            className={cx(inputCls, grande && 'py-3 text-base')}
            value={detalle}
            onChange={(e) => setDetalle(e.target.value)}
            placeholder={motivo === 'Otro' ? 'Escribí el motivo' : 'Detalle (opcional): ej. volver a la tarde'}
            maxLength={250}
          />
        </div>
      )}

      {res === 'parcial' && (
        <input
          className={cx(inputCls, grande && 'py-3 text-base')}
          value={faltante}
          onChange={(e) => setFaltante(e.target.value)}
          placeholder="Qué faltó entregar (ej: 1 caja, no había stock)"
          maxLength={250}
        />
      )}

      <div className={cx('rounded-lg border', devolvio ? 'border-violet-300 bg-violet-50/60 p-3' : 'border-slate-200 px-3 py-2')}>
        <label className={cx('flex items-center gap-2 font-medium text-slate-700', grande ? 'text-base' : 'text-sm')}>
          <input type="checkbox" className={cx('accent-violet-600', grande ? 'h-5 w-5' : 'h-4 w-4')} checked={devolvio} onChange={(e) => setDevolvio(e.target.checked)} />
          ↩ Devolvió mercadería
        </label>
        {devolvio && (
          <div className="mt-2 space-y-2">
            <input
              className={cx(inputCls, grande && 'py-3 text-base')}
              value={devDetalle}
              onChange={(e) => setDevDetalle(e.target.value)}
              placeholder="Qué devolvió y cuánto (ej: 2 rodamientos 6205)"
              maxLength={250}
            />
            <div className="flex flex-wrap gap-2">
              {MOTIVOS_DEVOLUCION.map((m) => (
                <button key={m} type="button" className={chip(devMotivo === m)} onClick={() => setDevMotivo(devMotivo === m ? '' : m)}>
                  {m}
                </button>
              ))}
            </div>
            <input
              className={cx(inputCls, 'text-right tabular-nums', grande && 'py-3 text-base', devMonto.trim() && devMontoN == null && 'border-red-400 bg-red-50')}
              value={devMonto}
              onChange={(e) => setDevMonto(e.target.value)}
              inputMode="decimal"
              placeholder="Monto de lo devuelto $ (opcional)"
            />
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div className={cx('flex flex-wrap items-baseline justify-between gap-2 font-medium text-slate-700', grande ? 'text-sm' : 'text-xs')}>
          <span>Monto cobrado {res === 'no_entregado' && <span className="font-normal text-slate-500">(si igual cobró algo)</span>}</span>
          {aCobrar != null && <span className="font-normal text-slate-500">A cobrar: {fmtMoney(aCobrar)}</span>}
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            className={cx(inputCls, 'flex-1 text-right tabular-nums', grande && 'py-3 text-lg', monto.trim() && montoN == null && 'border-red-400 bg-red-50')}
            value={monto}
            onChange={(e) => setMonto(e.target.value)}
            inputMode="decimal"
            placeholder="$ 0"
          />
          {aCobrar != null && res !== 'no_entregado' && (
            <button type="button" className={chip(montoN === aCobrar)} onClick={() => setMonto(String(aCobrar).replace('.', ','))}>
              Todo
            </button>
          )}
          <button type="button" className={chip(monto.trim() === '0')} onClick={() => setMonto('0')}>
            No cobró
          </button>
        </div>
        {!!montoN && (
          <div className="flex flex-wrap gap-2">
            {FORMAS_PAGO.map((f) => (
              <button key={f.k} type="button" className={chip(forma === f.k)} onClick={() => setForma(f.k)}>
                {f.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <input
        className={cx(inputCls, grande && 'py-3 text-base')}
        value={nota}
        onChange={(e) => setNota(e.target.value)}
        placeholder={res === 'no_entregado' ? 'Comentario (opcional)' : 'Quién recibió (opcional)'}
        maxLength={250}
      />

      {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <div className="flex gap-2">
        {onCancelar && (
          <button type="button" onClick={onCancelar} className={cx('flex-1 rounded-lg border border-slate-300 bg-white font-medium text-slate-700', btn)}>
            Cancelar
          </button>
        )}
        <button type="button" onClick={guardar} disabled={busy} className={cx('flex-[2] rounded-lg bg-brand-700 font-semibold text-white disabled:opacity-50', btn)}>
          {busy ? 'Guardando…' : 'Confirmar'}
        </button>
      </div>
    </div>
  )
}
