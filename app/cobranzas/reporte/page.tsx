'use client'

import { useEffect, useMemo, useState } from 'react'
import { sb } from '@/lib/supabase'
import type { Factura } from '@/lib/types'
import { ESTADO_COB, EstadoCob, copiar, estadoCobranza, fmtFecha, fmtFechaLarga, fmtMoney, hoy } from '@/lib/utils'
import { FACTURA_SELECT, Importe, TipoBadge } from '@/components/Cobranzas'
import { etiquetaTipo, saldoFirmado } from '@/lib/comprobantes'
import { Alert, Badge, Button, Card, Empty, PageHeader, Spinner, Stat, Table, td, th } from '@/components/ui'

type Grupo = {
  cliente: string
  telefono: string | null
  facturas: { f: Factura; e: EstadoCob }[]
  total: number
  peor: EstadoCob
}

const ORDEN: EstadoCob[] = ['atraso_prolongado', 'atrasado', 'vence_hoy', 'por_vencer', 'al_dia', 'credito']

export default function ReportePage() {
  const [facturas, setFacturas] = useState<Factura[] | null>(null)
  const [copiado, setCopiado] = useState<string | null>(null)
  const ref = hoy()

  useEffect(() => {
    sb()
      .from('facturas')
      .select(FACTURA_SELECT)
      .eq('estado', 'pendiente')
      .order('fecha_vencimiento')
      .then(({ data }) => setFacturas((data as Factura[]) ?? []))
  }, [])

  const { grupos, tot } = useMemo(() => {
    const map = new Map<string, Grupo>()
    const tot: Record<EstadoCob, number> = { atraso_prolongado: 0, atrasado: 0, vence_hoy: 0, por_vencer: 0, al_dia: 0, credito: 0, cobrado: 0, imputada: 0, anulada: 0 }
    for (const f of facturas ?? []) {
      const e = estadoCobranza(f, ref)
      tot[e] += saldoFirmado(f)
      const k = f.cliente_id
      const g = map.get(k) ?? { cliente: f.cliente?.razon_social ?? '—', telefono: f.cliente?.telefono ?? null, facturas: [], total: 0, peor: 'al_dia' as EstadoCob }
      g.facturas.push({ f, e })
      g.total += saldoFirmado(f)
      if (ORDEN.indexOf(e) < ORDEN.indexOf(g.peor)) g.peor = e
      map.set(k, g)
    }
    // Solo clientes con saldo deudor (A05 §3): si las NC cubren todo, no se reportan
    const grupos = Array.from(map.values()).filter((g) => g.total > 0.004).sort((a, b) => ORDEN.indexOf(a.peor) - ORDEN.indexOf(b.peor) || b.total - a.total)
    return { grupos, tot }
  }, [facturas, ref])

  const total = Object.values(tot).reduce((a, b) => a + b, 0)

  function textoReporte(destino: 'ventas' | 'gerencia') {
    const estados: EstadoCob[] = destino === 'gerencia' ? ['atraso_prolongado', 'atrasado', 'credito'] : ['atraso_prolongado', 'atrasado', 'vence_hoy', 'por_vencer', 'credito']
    const lineas: string[] = [`*Estado de cuentas de clientes – ${fmtFechaLarga(ref)}*`, '']
    for (const est of estados) {
      const items = grupos.flatMap((g) => g.facturas.filter((x) => x.e === est).map((x) => ({ g, ...x })))
      if (!items.length) continue
      lineas.push(`*${ESTADO_COB[est].label}* (${fmtMoney(tot[est])})`)
      for (const { g, f } of items) {
        lineas.push(
          est === 'credito'
            ? `• ${g.cliente} – ${etiquetaTipo(f)} ${f.numero} – ${fmtMoney(saldoFirmado(f))} a favor (sin imputar)`
            : `• ${g.cliente} – ${etiquetaTipo(f)} ${f.numero} – ${fmtMoney(f.saldo)} – vence ${fmtFecha(f.fecha_vencimiento)}`,
        )
      }
      if (est === 'atraso_prolongado') lineas.push('  ↳ Para decisión de Gerencia. Ventas: evaluar corte de suministro según Manual Comercial cap. 2.')
      lineas.push('')
    }
    lineas.push(`Total pendiente de cobro: ${fmtMoney(total)}`)
    lineas.push('— Administración DE&CO')
    return lineas.join('\n')
  }

  async function copy(dest: 'ventas' | 'gerencia') {
    await copiar(textoReporte(dest))
    setCopiado(dest)
    setTimeout(() => setCopiado(null), 2500)
  }

  return (
    <>
      <PageHeader
        title="Reporte de los lunes"
        subtitle={`A05 §3 · Estado de cuenta de clientes con saldo deudor · ${fmtFechaLarga(ref)}`}
        actions={
          <div className="no-print flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => copy('ventas')}>
              {copiado === 'ventas' ? '✓ Copiado' : 'Copiar para Ventas'}
            </Button>
            <Button variant="secondary" onClick={() => copy('gerencia')}>
              {copiado === 'gerencia' ? '✓ Copiado' : 'Copiar para Gerencia'}
            </Button>
            <Button onClick={() => window.print()}>Imprimir / PDF</Button>
          </div>
        }
      />

      {!facturas ? (
        <Spinner />
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat label="Total a cobrar" value={fmtMoney(total)} tone="brand" sub={tot.credito ? `neto de ${fmtMoney(tot.credito)} en NC` : undefined} />
            <Stat label="Atraso prolongado" value={fmtMoney(tot.atraso_prolongado)} tone="rose" />
            <Stat label="Atrasado" value={fmtMoney(tot.atrasado)} tone="red" />
            <Stat label="Vence ≤72 hs / hoy" value={fmtMoney(tot.por_vencer + tot.vence_hoy)} tone="amber" />
            <Stat label="Al día" value={fmtMoney(tot.al_dia)} tone="green" />
          </div>

          <Alert tone="blue" className="no-print mb-5">
            Acciones del lunes: aviso preventivo 72 hs antes · informar vencimientos a Ventas · atrasos a Ventas y Gerencia · atraso prolongado a Gerencia para decidir.
            No perseguir a los clientes que están al día.
          </Alert>

          {grupos.length === 0 ? (
            <Card>
              <Empty>No hay clientes con saldo deudor. 🎉</Empty>
            </Card>
          ) : (
            <Card pad={false} title={`${grupos.length} clientes con saldo`}>
              <Table>
                <thead>
                  <tr>
                    <th className={th}>Cliente</th>
                    <th className={th}>Comprobante</th>
                    <th className={th}>Vence</th>
                    <th className={th}>Estado</th>
                    <th className={`${th} text-right`}>Saldo</th>
                  </tr>
                </thead>
                <tbody>
                  {grupos.map((g) =>
                    g.facturas.map(({ f, e }, i) => (
                      <tr key={f.id} className={i === 0 ? 'border-t-2 border-slate-200' : ''}>
                        {i === 0 && (
                          <td className={`${td} align-top`} rowSpan={g.facturas.length}>
                            <div className="font-medium text-slate-900">{g.cliente}</div>
                            <div className="text-xs text-slate-500">Total {fmtMoney(g.total)}</div>
                          </td>
                        )}
                        <td className={`${td} whitespace-nowrap`}>
                          <TipoBadge f={f} corto /> {f.numero}
                        </td>
                        <td className={`${td} whitespace-nowrap`}>{fmtFecha(f.fecha_vencimiento)}</td>
                        <td className={td}>
                          <Badge tone={ESTADO_COB[e].tone}>{ESTADO_COB[e].label}</Badge>
                        </td>
                        <td className={`${td} text-right tabular-nums`}>
                          <Importe n={saldoFirmado(f)} />
                        </td>
                      </tr>
                    )),
                  )}
                </tbody>
              </Table>
            </Card>
          )}
        </>
      )}
    </>
  )
}
