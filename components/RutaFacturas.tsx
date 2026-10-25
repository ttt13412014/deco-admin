'use client'

import { useEffect, useRef, useState } from 'react'
import type { ClienteRuta } from '@/lib/rutas'
import { clientePorFactura } from '@/lib/rutas'
import {
  comprobanteDesdeLectura, etiquetaComprobante, parsearNumeroAR, restaTipo,
  type ComprobanteRuta, type LecturaFactura,
} from '@/lib/factura-pdf'
import { GRUPOS_TIPO_VENTA, TIPOS_VENTA, tipoVentaAfip, type TipoVenta } from '@/lib/comprobantes'
import { leerFacturaPdf } from '@/lib/pdf-texto'
import { fmtCuit, fmtFecha, fmtMoney } from '@/lib/utils'
import { Badge, Button, cx, inputCls } from '@/components/ui'

const num = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const fmtNum = (n: number) => num.format(n)

// ---------------------------------------------------------------------
/** Campo de monto con formato argentino (1.234,56). Acepta negativos (nota de crédito). */
export function MontoInput({
  valor,
  onCambio,
  className,
  placeholder = 'Monto factura $',
  disabled,
}: {
  valor: number | null | undefined
  onCambio: (n: number | null) => void
  className?: string
  placeholder?: string
  disabled?: boolean
}) {
  const [txt, setTxt] = useState(valor == null ? '' : fmtNum(valor))
  const foco = useRef(false)
  useEffect(() => {
    if (!foco.current) setTxt(valor == null ? '' : fmtNum(valor))
  }, [valor])
  const invalido = txt.trim() !== '' && parsearNumeroAR(txt) == null
  return (
    <input
      className={cx(inputCls, 'text-right tabular-nums', invalido && 'border-red-400 bg-red-50', valor != null && valor < 0 && 'text-red-700', className)}
      value={txt}
      inputMode="decimal"
      placeholder={placeholder}
      title="Monto de la factura. Para una nota de crédito poné el monto con signo menos (ej: -12.100,00)."
      disabled={disabled}
      onFocus={() => (foco.current = true)}
      onBlur={() => {
        foco.current = false
        setTxt(valor == null ? '' : fmtNum(valor))
      }}
      onChange={(e) => {
        setTxt(e.target.value)
        if (!e.target.value.trim()) return onCambio(null)
        const n = parsearNumeroAR(e.target.value)
        if (n != null) onCambio(n)
      }}
    />
  )
}

// ---------------------------------------------------------------------
/** Chips con las facturas / notas de crédito adjuntadas a una parada. */
export function ListaComprobantes({ comprobantes, onQuitar }: { comprobantes: ComprobanteRuta[]; onQuitar?: (i: number) => void }) {
  if (!comprobantes.length) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {comprobantes.map((c, i) => (
        <span
          key={i}
          title={[c.razon_social, c.cuit && `CUIT/DNI ${fmtCuit(c.cuit)}`, c.fecha && fmtFecha(c.fecha), c.archivo].filter(Boolean).join(' · ')}
          className={cx(
            'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs ring-1 ring-inset',
            restaTipo(c.tipo) ? 'bg-red-50 text-red-700 ring-red-600/20' : 'bg-slate-50 text-slate-700 ring-slate-500/20',
          )}
        >
          🧾 {etiquetaComprobante(c)} · <b className="tabular-nums">{fmtMoney(c.monto)}</b>
          {onQuitar && (
            <button onClick={() => onQuitar(i)} className="ml-0.5 text-slate-400 hover:text-red-600" aria-label="Quitar comprobante">
              ×
            </button>
          )}
        </span>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------
export interface ComprobanteParaRuta {
  clienteId: string // '' = sin cliente
  nombre: string // razón social leída (para paradas sin cliente)
  comp: ComprobanteRuta
}

interface FilaPdf {
  archivo: string
  lectura: LecturaFactura | null
  error: string | null
  tipo: TipoVenta
  clienteId: string
  candidatos: ClienteRuta[]
  porCuit: boolean
  monto: number | null // siempre positivo: el signo lo pone el tipo
  incluir: boolean
}

/** "Agregar paradas → Facturas PDF": sube varios PDF, los lee y deja revisar antes de cargarlos. */
export function CargaFacturas({ clientes, onAplicar }: { clientes: ClienteRuta[]; onAplicar: (items: ComprobanteParaRuta[]) => void }) {
  const [filas, setFilas] = useState<FilaPdf[] | null>(null)
  const [leyendo, setLeyendo] = useState<string | null>(null)
  const [arrastrando, setArrastrando] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  async function leer(files: File[]) {
    if (!files.length) return
    const nuevas: FilaPdf[] = []
    for (let i = 0; i < files.length; i++) {
      setLeyendo(`Leyendo ${i + 1} de ${files.length}…`)
      const r = await leerFacturaPdf(files[i])
      const l = r.lectura
      const m = l ? clientePorFactura(l, clientes) : { elegido: '', candidatos: [], porCuit: false }
      const tipo: TipoVenta = l ? l.tipoVenta ?? tipoVentaAfip(l.tipo, l.letra) : 'factura_a'
      nuevas.push({
        archivo: r.archivo,
        lectura: l,
        error: r.error,
        tipo,
        clienteId: m.elegido,
        candidatos: m.candidatos,
        porCuit: m.porCuit,
        monto: l?.total ?? null,
        incluir: !r.error && l?.total != null,
      })
    }
    setLeyendo(null)
    setFilas((prev) => [...(prev ?? []), ...nuevas])
  }

  const set = (i: number, c: Partial<FilaPdf>) => setFilas((fs) => (fs ? fs.map((f, j) => (j === i ? { ...f, ...c } : f)) : fs))
  const listas = (filas ?? []).filter((f) => f.incluir && f.monto != null)
  // Facturas, notas de débito y presupuestos suman; notas de crédito y anula presupuesto restan
  const firmado = (f: FilaPdf) => TIPOS_VENTA[f.tipo].signo * Math.abs(f.monto ?? 0)
  const suma = listas.reduce((a, f) => a + firmado(f), 0)

  function cargar() {
    const items: ComprobanteParaRuta[] = []
    for (const f of listas) {
      const base: LecturaFactura = f.lectura ?? {
        tipo: 'factura', tipoVenta: 'factura_a', letra: null, codigo: null, numero: null, fecha: null, razonSocial: null,
        cuitReceptor: null, dniReceptor: null, cuits: [], total: null, monto: null, avisos: [],
      }
      const info = TIPOS_VENTA[f.tipo]
      const letra = base.tipoVenta === f.tipo ? base.letra : info.letra
      const comp = comprobanteDesdeLectura({ ...base, tipo: info.clase, tipoVenta: f.tipo, letra }, f.archivo, firmado(f))
      if (comp) items.push({ clienteId: f.clienteId, nombre: base.razonSocial || f.archivo.replace(/\.pdf$/i, ''), comp })
    }
    onAplicar(items)
    const quedan = (filas ?? []).filter((f) => !listas.includes(f) && !f.error)
    setFilas(quedan.length ? quedan : null)
  }

  const zona = (
    <label
      onDragOver={(e) => {
        e.preventDefault()
        setArrastrando(true)
      }}
      onDragLeave={() => setArrastrando(false)}
      onDrop={(e) => {
        e.preventDefault()
        setArrastrando(false)
        leer(Array.from(e.dataTransfer.files))
      }}
      className={cx(
        'flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-6 text-center text-sm',
        arrastrando ? 'border-brand-600 bg-brand-50' : 'border-slate-300 hover:border-brand-400 hover:bg-slate-50',
      )}
    >
      <span className="text-2xl">🧾</span>
      <span className="font-medium text-slate-700">{leyendo ?? 'Elegí o arrastrá los PDF de las facturas'}</span>
      <span className="text-xs text-slate-500">Podés subir varios juntos. Leo el cliente y el importe total; facturas, notas de débito y presupuestos suman; notas de crédito y anula presupuesto restan.</span>
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        className="hidden"
        disabled={!!leyendo}
        onChange={(e) => {
          leer(Array.from(e.target.files ?? []))
          e.target.value = ''
        }}
      />
    </label>
  )

  if (!filas) return <div className="space-y-2">{zona}<p className="text-xs text-slate-500">El PDF se lee en esta compu, no se sube a ningún lado.</p></div>

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {filas.map((f, i) => {
          const l = f.lectura
          const ignorado = !!f.error
          return (
            <div
              key={i}
              className={cx(
                'space-y-2 rounded-lg border p-2',
                ignorado ? 'border-slate-200 bg-slate-50 opacity-70' : !f.clienteId || f.monto == null ? 'border-amber-300 bg-amber-50' : 'border-slate-200',
              )}
            >
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate font-medium text-slate-700">📄 {f.archivo}</span>
                {l && (
                  <span className="flex flex-wrap items-center gap-1.5 text-slate-500">
                    <Badge tone={TIPOS_VENTA[f.tipo].tone}>
                      {TIPOS_VENTA[f.tipo].label}
                      {l.letra && l.letra !== TIPOS_VENTA[f.tipo].letra && TIPOS_VENTA[f.tipo].letra ? ` (${l.letra})` : ''}
                    </Badge>
                    {l.numero && <span>Nº {l.numero}</span>}
                    {l.fecha && <span>· {fmtFecha(l.fecha)}</span>}
                  </span>
                )}
              </div>
              {f.error ? (
                <div className="text-xs text-red-700">{f.error}</div>
              ) : (
                <>
                  {l && (l.razonSocial || l.cuitReceptor || l.dniReceptor) && (
                    <div className="text-xs text-slate-600">
                      Leí: <b>{l.razonSocial ?? 'sin nombre'}</b>
                      {(l.cuitReceptor || l.dniReceptor) && ` · ${l.cuitReceptor ? 'CUIT' : 'DNI'} ${fmtCuit(l.cuitReceptor ?? l.dniReceptor)}`}
                      {f.clienteId && f.porCuit && <span className="text-emerald-700"> · cliente encontrado por {l.cuitReceptor ? 'CUIT' : 'DNI'}</span>}
                    </div>
                  )}
                  {l?.avisos.map((a) => (
                    <div key={a} className="text-xs text-amber-700">
                      {a}
                    </div>
                  ))}
                  <div className="grid gap-2 sm:grid-cols-12">
                    <select className={cx(inputCls, 'sm:col-span-3')} value={f.tipo} onChange={(e) => set(i, { tipo: e.target.value as TipoVenta })}>
                      {GRUPOS_TIPO_VENTA.map((g) => (
                        <optgroup key={g.label} label={g.label}>
                          {g.tipos.map((t) => (
                            <option key={t} value={t}>
                              {TIPOS_VENTA[t].label} ({TIPOS_VENTA[t].signo > 0 ? '+' : '−'})
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                    <select className={cx(inputCls, 'sm:col-span-5')} value={f.clienteId} onChange={(e) => set(i, { clienteId: e.target.value })}>
                      <option value="">{f.candidatos.length ? '— Elegí el cliente —' : '— Sin cliente (parada nueva) —'}</option>
                      {f.candidatos.length > 0 && (
                        <optgroup label="Sugeridos">
                          {f.candidatos.map((c) => (
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
                    <MontoInput className="sm:col-span-3" valor={f.monto} onCambio={(n) => set(i, n == null ? { monto: null } : { monto: Math.abs(n), incluir: true })} placeholder="Importe total $" />
                    <label className="flex items-center justify-center gap-1 text-xs sm:col-span-1" title="Incluir">
                      <input type="checkbox" className="h-4 w-4 accent-brand-700" checked={f.incluir} onChange={(e) => set(i, { incluir: e.target.checked })} />
                      <span className="sm:hidden">Incluir</span>
                    </label>
                  </div>
                  {f.incluir && !f.clienteId && (
                    <div className="text-xs text-amber-700">Sin cliente: se agrega como parada nueva y le vas a tener que cargar la dirección.</div>
                  )}
                </>
              )}
            </div>
          )
        })}
      </div>
      {zona}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm text-slate-600">
          {listas.length} {listas.length === 1 ? 'comprobante' : 'comprobantes'} · suman <b className="tabular-nums">{fmtMoney(suma)}</b>
        </span>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setFilas(null)}>
            Descartar
          </Button>
          <Button onClick={cargar} disabled={!listas.length || !!leyendo}>
            Cargar a la hoja
          </Button>
        </div>
      </div>
      <p className="text-xs text-slate-500">
        Si el cliente ya está en la hoja, el comprobante se suma a esa parada; si no, se agrega una parada nueva.
      </p>
    </div>
  )
}
