'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { sb } from '@/lib/supabase'
import type { HojaRuta } from '@/lib/types'
import { fmtFecha, fmtMoney, hoy } from '@/lib/utils'
import { ESTADO_HOJA, fechaAR, horaAR, totalesRuta } from '@/lib/rutas'
import { useAuth } from '@/components/AuthProvider'
import { Badge, Button, Card, Empty, PageHeader, Spinner, Table, td, th } from '@/components/ui'

type Fila = HojaRuta & { paradas: { entregado: boolean; bultos: number | null; monto_factura?: number | null; monto_cobrado?: number | null; resultado?: 'entregado' | 'no_entregado' | null }[] }

export default function RutasPage() {
  const { puedeArmarRutas } = useAuth()
  const router = useRouter()
  const [hojas, setHojas] = useState<Fila[] | null>(null)
  const [conMontos, setConMontos] = useState(false)

  useEffect(() => {
    const traer = (campos: string) =>
      sb()
        .from('hojas_ruta')
        .select(`*, paradas:hoja_ruta_paradas(${campos})`)
        .order('fecha', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(60)
    ;(async () => {
      // Con montos de factura si ya se corrió la migración 09; si no, como antes
      const r0 = await traer('entregado,bultos,monto_factura,monto_cobrado,resultado')
      const r = r0.error ? await traer('entregado,bultos,monto_factura') : r0
      if (!r.error) {
        setConMontos(true)
        return setHojas((r.data as unknown as Fila[]) ?? [])
      }
      const { data } = await traer('entregado,bultos')
      setHojas((data as unknown as Fila[]) ?? [])
    })()
  }, [])

  const ref = hoy()
  const terminadasHoy = (hojas ?? []).filter((h) => h.finalizada_at && fechaAR(h.finalizada_at) === ref)

  return (
    <>
      <PageHeader
        title="Hojas de ruta"
        subtitle="Elegí los clientes, qué lleva cada uno, y la app arma el recorrido en Google Maps."
        actions={
          puedeArmarRutas && (
            <Link href="/rutas/nueva">
              <Button>+ Nueva hoja de ruta</Button>
            </Link>
          )
        }
      />
      {terminadasHoy.length > 0 && (
        <div className="mb-4 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          <div className="font-semibold">✅ {terminadasHoy.length === 1 ? 'Un chofer terminó el recorrido hoy' : `${terminadasHoy.length} recorridos terminados hoy`}</div>
          <div className="mt-1 flex flex-wrap gap-2">
            {terminadasHoy.map((h) => (
              <Link key={h.id} href={`/rutas/${h.id}`} className="rounded-md bg-white px-2 py-1 font-medium text-emerald-800 ring-1 ring-emerald-300 hover:bg-emerald-100">
                {h.nombre || h.chofer || 'Reparto'} · {horaAR(h.finalizada_at)} · ver informe →
              </Link>
            ))}
          </div>
        </div>
      )}
      <Card pad={false}>
        {!hojas ? (
          <Spinner />
        ) : hojas.length === 0 ? (
          <Empty>
            Todavía no armaste ninguna hoja de ruta.
            <br />
            Tip: primero importá tus clientes con dirección en <Link href="/clientes" className="text-brand-700 underline">Clientes → Importar Excel</Link>.
          </Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <th className={th}>Fecha</th>
                <th className={th}>Reparto</th>
                <th className={th}>Chofer</th>
                <th className={`${th} text-right`}>Paradas</th>
                {conMontos && <th className={`${th} text-right`}>Facturas</th>}
                <th className={th}>Estado</th>
              </tr>
            </thead>
            <tbody>
              {hojas.map((h) => {
                const ok = h.paradas.filter((p) => p.entregado).length
                const no = h.paradas.filter((p) => !p.entregado && p.resultado === 'no_entregado').length
                const cobrado = Math.round(h.paradas.reduce((a, p) => a + (Number(p.monto_cobrado) || 0), 0) * 100) / 100
                const bultos = h.paradas.reduce((a, p) => a + (p.bultos ?? 0), 0)
                const finHoy = !!h.finalizada_at && fechaAR(h.finalizada_at) === ref
                return (
                  <tr key={h.id} className={`cursor-pointer hover:bg-brand-50/40 ${finHoy ? 'bg-emerald-50/70' : ''}`} onClick={() => router.push(`/rutas/${h.id}`)}>
                    <td className={`${td} whitespace-nowrap`}>
                      {fmtFecha(h.fecha)}
                      {h.fecha === ref && <span className="ml-1.5 text-xs font-medium text-brand-700">hoy</span>}
                    </td>
                    <td className={td}>
                      <div className="font-medium text-slate-900">{h.nombre || 'Sin nombre'}</div>
                      <div className="text-xs text-slate-500">Sale de {h.origen}</div>
                    </td>
                    <td className={td}>{h.chofer || '—'}</td>
                    <td className={`${td} text-right tabular-nums`}>
                      {ok}/{h.paradas.length}
                      {no > 0 && <div className="text-xs text-red-700">{no} sin entregar</div>}
                      {bultos > 0 && <div className="text-xs text-slate-500">{bultos} bultos</div>}
                    </td>
                    {conMontos && (
                      <td className={`${td} text-right tabular-nums`}>
                        {(() => {
                          const t = totalesRuta(h.paradas)
                          return t.conMonto ? fmtMoney(t.total) : <span className="text-slate-400">—</span>
                        })()}
                        {cobrado > 0 && <div className="text-xs text-emerald-700">cobrado {fmtMoney(cobrado)}</div>}
                      </td>
                    )}
                    <td className={td}>
                      <Badge tone={ESTADO_HOJA[h.estado].tone}>{ESTADO_HOJA[h.estado].label}</Badge>
                      {h.finalizada_at && (
                        <div className={`mt-1 text-xs ${finHoy ? 'font-semibold text-emerald-800' : 'text-emerald-700'}`}>
                          ✅ Terminada {h.finalizada_por === 'chofer' || !h.finalizada_por ? 'por el chofer' : ''}
                          {finHoy ? ` hoy ${horaAR(h.finalizada_at)}` : ''} · <span className="underline">ver informe</span>
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  )
}
