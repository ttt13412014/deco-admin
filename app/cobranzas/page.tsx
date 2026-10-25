'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { sb, errMsg } from '@/lib/supabase'
import type { Factura, TipoGestion } from '@/lib/types'
import { ESTADO_COB, EstadoCob, TIPO_GESTION, diffDias, estadoCobranza, fmtFecha, fmtMoney, hoy } from '@/lib/utils'
import { useAuth } from '@/components/AuthProvider'
import { FACTURA_SELECT, FacturaDetalle, FacturaForm, Importe, TipoBadge } from '@/components/Cobranzas'
import { CLASES_VENTA, ClaseVenta, GRUPOS_TIPO_VENTA, TIPOS_VENTA, TipoVenta, infoTipo, montoFirmado, saldoFirmado, tipoDe } from '@/lib/comprobantes'
import { ConfirmarPagoForm, PagoInformado, Promesa, promesaIncumplida } from '@/components/CobranzasExtra'
import { ImportarCobrar } from '@/components/Importador'
import { MEDIOS } from '@/lib/tesoreria'
import { Alert, Badge, Button, Card, Empty, Modal, PageHeader, Spinner, Table, compactCls, cx, td, th } from '@/components/ui'

type Filtro = 'pendientes' | EstadoCob | 'promesas' | 'sintesys' | 'no_figura'

const FILTROS: { key: Filtro; label: string }[] = [
  { key: 'pendientes', label: 'Todas pendientes' },
  { key: 'por_vencer', label: 'Vencen ≤72 hs' },
  { key: 'vence_hoy', label: 'Vencen hoy' },
  { key: 'atrasado', label: 'Atrasadas' },
  { key: 'atraso_prolongado', label: 'Atraso prolongado' },
  { key: 'al_dia', label: 'Al día' },
  { key: 'credito', label: 'Créditos a favor' },
  { key: 'promesas', label: 'Promesas incumplidas' },
  { key: 'sintesys', label: 'Distinto a Sintesys' },
  { key: 'no_figura', label: 'No figura en el último Excel' },
  { key: 'cobrado', label: 'Cobradas' },
]

type UltGestion = { factura_id: string; tipo: TipoGestion; created_at: string }

export default function CobranzasPage() {
  const { puedeEditar } = useAuth()
  const [facturas, setFacturas] = useState<Factura[] | null>(null)
  const [cobradas, setCobradas] = useState<Factura[] | null>(null)
  const [ult, setUlt] = useState<Record<string, UltGestion>>({})
  const [filtro, setFiltro] = useState<Filtro>('pendientes')
  const [q, setQ] = useState('')
  const [nueva, setNueva] = useState(false)
  const [detalle, setDetalle] = useState<string | null>(null)
  const [aviso, setAviso] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [promesas, setPromesas] = useState<Promesa[]>([])
  const [informados, setInformados] = useState<PagoInformado[]>([])
  const [ultLote, setUltLote] = useState<{ id: string; created_at: string; archivo: string | null } | null>(null)
  const [vendedor, setVendedor] = useState('')
  const [tipoF, setTipoF] = useState<'' | ClaseVenta | TipoVenta>('')
  const [importar, setImportar] = useState(false)
  const [confirmar, setConfirmar] = useState<PagoInformado | null>(null)

  useEffect(() => {
    const f = new URLSearchParams(window.location.search).get('f') as Filtro | null
    if (f && FILTROS.some((x) => x.key === f)) setFiltro(f)
  }, [])

  const cargar = useCallback(async () => {
    const s = sb()
    const desde = new Date(Date.now() - 90 * 86400000).toISOString()
    const [a, g, p, i, l] = await Promise.all([
      s.from('facturas').select(FACTURA_SELECT).eq('estado', 'pendiente').order('fecha_vencimiento'),
      s.from('gestiones_cobranza').select('factura_id,tipo,created_at').gte('created_at', desde).not('factura_id', 'is', null).order('created_at', { ascending: false }),
      s.from('cob_promesas').select('*').eq('estado', 'pendiente'),
      s.from('cob_pagos_informados').select('*, cliente:clientes(razon_social), autor:perfiles!created_by(nombre)').eq('estado', 'pendiente_validacion').order('created_at'),
      s.from('imp_lotes').select('id,created_at,archivo').eq('tipo', 'cobrar').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    ])
    setFacturas((a.data as Factura[]) ?? [])
    setPromesas((p.data as Promesa[]) ?? [])
    setInformados((i.data as PagoInformado[]) ?? [])
    setUltLote((l.data as { id: string; created_at: string; archivo: string | null }) ?? null)
    const m: Record<string, UltGestion> = {}
    for (const x of (g.data as UltGestion[]) ?? []) if (!m[x.factura_id]) m[x.factura_id] = x
    setUlt(m)
  }, [])

  const cargarCobradas = useCallback(async () => {
    const { data } = await sb().from('facturas').select(FACTURA_SELECT).eq('estado', 'cobrado').order('fecha_cobro', { ascending: false }).limit(200)
    setCobradas((data as Factura[]) ?? [])
  }, [])

  useEffect(() => {
    cargar()
  }, [cargar])
  useEffect(() => {
    if (filtro === 'cobrado' && !cobradas) cargarCobradas()
  }, [filtro, cobradas, cargarCobradas])

  const ref = hoy()
  const deTipo = useCallback((f: Factura) => !tipoF || tipoDe(f) === tipoF || infoTipo(f).clase === tipoF, [tipoF])
  const conEstado = useMemo(
    () => (facturas ?? []).filter((f) => (!vendedor || (f.vendedor ?? '') === vendedor) && deTipo(f)).map((f) => ({ f, e: estadoCobranza(f, ref) })),
    [facturas, ref, vendedor, deTipo],
  )
  const vendedores = useMemo(() => Array.from(new Set((facturas ?? []).map((f) => f.vendedor).filter(Boolean) as string[])).sort(), [facturas])
  const incumplidas = useMemo(() => new Set(promesas.filter((p) => promesaIncumplida(p, ref)).map((p) => p.factura_id).filter(Boolean) as string[]), [promesas, ref])
  const difSintesys = (f: Factura) => f.saldo_sintesys !== null && f.saldo_sintesys !== undefined && Math.abs(Number(f.saldo_sintesys) - Number(f.saldo)) > 0.004
  const noFigura = (f: Factura) => !!ultLote && f.origen === 'sintesys' && f.ult_lote !== ultLote.id

  const conteo = useMemo(() => {
    const c: Record<string, { n: number; total: number }> = {}
    for (const { f, e } of conEstado) {
      c[e] ??= { n: 0, total: 0 }
      c[e].n++
      c[e].total += saldoFirmado(f)
    }
    return c
  }, [conEstado])

  const lista = useMemo(() => {
    let l = filtro === 'cobrado' ? (cobradas ?? []).filter(deTipo).map((f) => ({ f, e: estadoCobranza(f, ref) })) : conEstado
    if (filtro === 'promesas') l = l.filter((x) => incumplidas.has(x.f.id))
    else if (filtro === 'sintesys') l = l.filter((x) => difSintesys(x.f))
    else if (filtro === 'no_figura') l = l.filter((x) => noFigura(x.f))
    else if (filtro !== 'pendientes' && filtro !== 'cobrado') l = l.filter((x) => x.e === filtro)
    const t = q.toLowerCase().trim()
    if (t) l = l.filter(({ f }) => f.cliente?.razon_social.toLowerCase().includes(t) || f.numero.toLowerCase().includes(t))
    return l
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conEstado, cobradas, filtro, q, incumplidas, ultLote, deTipo, ref])

  // Con signo: las notas de crédito y "anula presupuesto" restan
  const total = lista.reduce((a, x) => a + (x.f.estado === 'cobrado' ? montoFirmado(x.f) : saldoFirmado(x.f)), 0)

  return (
    <>
      <PageHeader
        title="Cuentas a cobrar"
        subtitle="A05 · Cobranzas, seguimiento y lo que viene de Sintesys. Administración gestiona y registra; no negocia."
        actions={
          <>
            <Link href="/cobranzas/reporte">
              <Button variant="secondary">Reporte de los lunes</Button>
            </Link>
            {puedeEditar && (
              <Button variant="secondary" onClick={() => setImportar(true)}>
                Importar Sintesys
              </Button>
            )}
            {puedeEditar && <Button onClick={() => setNueva(true)}>+ Nuevo comprobante</Button>}
          </>
        }
      />

      {aviso && (
        <Alert tone="green" className="mb-4">
          {aviso}
        </Alert>
      )}
      {error && (
        <Alert tone="red" className="mb-4">
          {error}
        </Alert>
      )}
      {ultLote && (
        <p className="mb-3 text-xs text-slate-500">
          Último Excel de Sintesys: {ultLote.archivo ?? 'sin nombre'} · {fmtFecha(ultLote.created_at.slice(0, 10))}
        </p>
      )}

      {informados.length > 0 && (
        <Card className="mb-4" pad={false} title={`Pagos informados a validar (${informados.length})`} subtitle="No bajan la deuda ni entran a Caja hasta confirmarlos con el banco o Sintesys">
          <ul className="divide-y divide-slate-100">
            {informados.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{p.cliente?.razon_social}</div>
                  <div className="text-xs text-slate-500">
                    {fmtFecha(p.fecha)} · {MEDIOS[p.medio]}
                    {p.referencia ? ` · ${p.referencia}` : ''} · cargó {p.autor?.nombre ?? '—'}
                  </div>
                </div>
                <span className="font-semibold tabular-nums">{fmtMoney(p.monto)}</span>
                {puedeEditar && (
                  <div className="flex gap-1">
                    <Button size="sm" variant="success" onClick={() => setConfirmar(p)}>
                      Confirmar
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        const m = window.prompt('Motivo del rechazo (ej: no está en el banco):')
                        if (!m?.trim()) return
                        const { error } = await sb().from('cob_pagos_informados').update({ estado: 'rechazado', motivo: m.trim() }).eq('id', p.id)
                        if (error) return setError(errMsg(error))
                        cargar()
                      }}
                    >
                      Rechazar
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="mb-4 flex flex-wrap gap-2">
        {FILTROS.map((x) => {
          const c =
            x.key === 'pendientes'
              ? { n: conEstado.length }
              : x.key === 'promesas'
                ? { n: conEstado.filter(({ f }) => incumplidas.has(f.id)).length }
                : x.key === 'sintesys'
                  ? { n: conEstado.filter(({ f }) => difSintesys(f)).length }
                  : x.key === 'no_figura'
                    ? { n: conEstado.filter(({ f }) => noFigura(f)).length }
                    : conteo[x.key]
          if (['promesas', 'sintesys', 'no_figura', 'credito'].includes(x.key) && !c?.n) return null
          return (
            <button
              key={x.key}
              onClick={() => setFiltro(x.key)}
              className={cx(
                'rounded-full border px-3 py-1.5 text-xs font-medium transition',
                filtro === x.key ? 'border-brand-700 bg-brand-700 text-white' : 'border-slate-300 bg-white text-slate-600 hover:border-brand-400',
              )}
            >
              {x.label}
              {x.key !== 'cobrado' && <span className="ml-1.5 opacity-70">{c?.n ?? 0}</span>}
            </button>
          )
        })}
      </div>

      <Card
        pad={false}
        title={filtro === 'cobrado' ? 'Últimas cobradas' : `${lista.length} comprobantes · ${fmtMoney(total)}`}
        subtitle={filtro in ESTADO_COB && filtro !== 'cobrado' ? ESTADO_COB[filtro as EstadoCob].accion : undefined}
        actions={
          <>
            {vendedores.length > 0 && (
              <select className={compactCls} value={vendedor} onChange={(e) => setVendedor(e.target.value)} aria-label="Vendedor">
                <option value="">Todos los vendedores</option>
                {vendedores.map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            )}
            <select id="cob-tipo" className={compactCls} value={tipoF} onChange={(e) => setTipoF(e.target.value as typeof tipoF)} aria-label="Tipo de comprobante">
              <option value="">Todos los tipos</option>
              <optgroup label="Por clase">
                {CLASES_VENTA.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </optgroup>
              {GRUPOS_TIPO_VENTA.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.tipos.map((t) => (
                    <option key={t} value={t}>
                      {TIPOS_VENTA[t].label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <input className={`${compactCls} w-56`} placeholder="Buscar cliente o número…" value={q} onChange={(e) => setQ(e.target.value)} />
          </>
        }
      >
        {!facturas || (filtro === 'cobrado' && !cobradas) ? (
          <Spinner />
        ) : lista.length === 0 ? (
          <Empty>No hay comprobantes en esta vista.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <th className={th}>Cliente</th>
                <th className={th}>Comprobante</th>
                <th className={th}>Vencimiento</th>
                <th className={th}>Cobro estimado</th>
                <th className={`${th} text-right`}>Saldo</th>
                <th className={th}>Estado</th>
                <th className={th}>{filtro === 'cobrado' ? 'Cobrada' : 'Última gestión'}</th>
              </tr>
            </thead>
            <tbody>
              {lista.map(({ f, e }) => {
                const g = ult[f.id]
                const dias = diffDias(f.fecha_vencimiento, ref)
                const sinAviso = !g && (e === 'por_vencer' || e === 'vence_hoy' || e === 'atrasado' || e === 'atraso_prolongado')
                return (
                  <tr key={f.id} onClick={() => setDetalle(f.id)} className="cursor-pointer hover:bg-brand-50/40">
                    <td className={td}>
                      <div className="font-medium text-slate-900">{f.cliente?.razon_social}</div>
                      <div className="text-xs text-slate-500">{[f.medio_pago_acordado, f.vendedor ? `vend. ${f.vendedor}` : null].filter(Boolean).join(' · ')}</div>
                    </td>
                    <td className={`${td} whitespace-nowrap`}>
                      <TipoBadge f={f} /> <span className="text-slate-500">{f.numero}</span>
                    </td>
                    <td className={`${td} whitespace-nowrap`}>
                      {e === 'credito' || e === 'imputada' ? <span className="text-slate-400">—</span> : fmtFecha(f.fecha_vencimiento)}
                      {f.estado === 'pendiente' && e !== 'credito' && (
                        <div className={cx('text-xs', dias < 0 ? 'text-red-600' : 'text-slate-500')}>
                          {dias > 0 ? `en ${dias} ${dias === 1 ? 'día' : 'días'}` : dias === 0 ? 'hoy' : `${-dias} ${dias === -1 ? 'día' : 'días'} de atraso`}
                        </div>
                      )}
                      {f.vencimiento_original && f.vencimiento_original !== f.fecha_vencimiento && <div className="text-[11px] text-slate-400">original {fmtFecha(f.vencimiento_original)}</div>}
                    </td>
                    <td className={`${td} whitespace-nowrap text-sm`}>
                      {f.fecha_estimada_cobro ? fmtFecha(f.fecha_estimada_cobro) : <span className="text-slate-400">—</span>}
                      {incumplidas.has(f.id) && <div className="text-xs font-medium text-red-600">Promesa incumplida</div>}
                    </td>
                    <td className={`${td} text-right tabular-nums`}>
                      <div className="font-semibold">
                        <Importe n={f.estado === 'cobrado' ? montoFirmado(f) : saldoFirmado(f)} />
                      </div>
                      {f.estado === 'pendiente' && difSintesys(f) && <div className="text-xs text-amber-700">Sintesys {fmtMoney(f.saldo_sintesys)}</div>}
                      {f.estado === 'pendiente' && noFigura(f) && <div className="text-xs text-amber-700">No está en el último Excel</div>}
                    </td>
                    <td className={td}>
                      <Badge tone={ESTADO_COB[e].tone}>{ESTADO_COB[e].label}</Badge>
                    </td>
                    <td className={`${td} text-xs`}>
                      {filtro === 'cobrado' ? (
                        fmtFecha(f.fecha_cobro)
                      ) : g ? (
                        <>
                          <div>{TIPO_GESTION[g.tipo]}</div>
                          <div className="text-slate-500">{fmtFecha(g.created_at.slice(0, 10))}</div>
                        </>
                      ) : sinAviso ? (
                        <span className="font-medium text-amber-700">Sin aviso</span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <Modal open={nueva} onClose={() => setNueva(false)} title="Nuevo comprobante">
        <FacturaForm
          onCancel={() => setNueva(false)}
          onSaved={() => {
            setNueva(false)
            setAviso('Comprobante registrado.')
            cargar()
          }}
        />
      </Modal>

      <Modal open={importar} onClose={() => setImportar(false)} title="Importar cuentas a cobrar de Sintesys" wide>
        {importar && (
          <ImportarCobrar
            onCancel={() => {
              setImportar(false)
              cargar()
            }}
            onDone={(t) => {
              setImportar(false)
              setAviso(t)
              cargar()
            }}
          />
        )}
      </Modal>
      <Modal open={!!confirmar} onClose={() => setConfirmar(null)} title="Confirmar pago informado" wide>
        {confirmar && (
          <ConfirmarPagoForm
            pi={confirmar}
            onCancel={() => setConfirmar(null)}
            onDone={(t) => {
              setConfirmar(null)
              setAviso(t)
              cargar()
            }}
          />
        )}
      </Modal>

      <Modal open={!!detalle} onClose={() => setDetalle(null)} title="Detalle de cobranza" wide>
        {detalle && (
          <FacturaDetalle
            facturaId={detalle}
            onChanged={() => {
              cargar()
              setCobradas(null)
            }}
          />
        )}
      </Modal>
    </>
  )
}
