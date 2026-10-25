'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { sb, errMsg } from '@/lib/supabase'
import type { Cliente, Factura } from '@/lib/types'
import { ESTADO_CLIENTE, ESTADO_COB, estadoCobranza, faltantesCliente, fmtCuit, fmtTipoFactura, fmtFecha, fmtFechaHora, fmtMoney, hoy } from '@/lib/utils'
import { useAuth } from '@/components/AuthProvider'
import { ClienteForm } from '@/components/ClienteForm'
import { FacturaDetalle, FacturaForm, Importe, TipoBadge } from '@/components/Cobranzas'
import { esCredito, montoFirmado, saldoFirmado, sumaFirmada, vencidoNeto } from '@/lib/comprobantes'
import { Alert, Badge, Button, Card, Empty, Modal, PageHeader, Spinner, Stat, Table, td, th } from '@/components/ui'

type ClienteFull = Cliente & { creador?: { nombre: string } | null; editor?: { nombre: string } | null }

export default function ClienteDetallePage() {
  const { id } = useParams<{ id: string }>()
  const { puedeEditar, puedeCargarClientes, puedeVer, loading } = useAuth()
  // Cuenta corriente y saldos (datos financieros): solo quien ve Cuentas a cobrar
  const verFinanzas = puedeVer('cobranzas')
  const [c, setC] = useState<ClienteFull | null>(null)
  const [facturas, setFacturas] = useState<Factura[]>([])
  const [editar, setEditar] = useState(false)
  const [nuevaFactura, setNuevaFactura] = useState(false)
  const [detalle, setDetalle] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ tone: 'green' | 'red'; text: string } | null>(null)
  const [noExiste, setNoExiste] = useState(false)

  const cargar = useCallback(async () => {
    const s = sb()
    const [a, b] = await Promise.all([
      s.from('clientes').select('*, creador:perfiles!created_by(nombre), editor:perfiles!updated_by(nombre)').eq('id', id).maybeSingle(),
      verFinanzas
        ? s.from('facturas').select('*').eq('cliente_id', id).order('fecha_emision', { ascending: false }).limit(100)
        : Promise.resolve({ data: [] as Factura[] }),
    ])
    if (!a.data) setNoExiste(true)
    setC(a.data as ClienteFull)
    setFacturas((b.data as Factura[]) ?? [])
  }, [id, verFinanzas])

  useEffect(() => {
    if (!loading) cargar()
  }, [cargar, loading])

  if (noExiste) return <Empty>Cliente no encontrado.</Empty>
  if (!c) return <Spinner />

  const pend = facturas.filter((f) => f.estado === 'pendiente')
  // Con signo: notas de crédito y "anula presupuesto" restan; lo vencido descuenta los créditos a favor
  const saldo = sumaFirmada(pend)
  const vencido = vencidoNeto(pend, (f) => ['atrasado', 'atraso_prolongado'].includes(estadoCobranza(f)))
  const creditos = pend.filter(esCredito)
  const faltan = faltantesCliente(c)

  async function cambiarEstado(estado: 'activo' | 'inhabilitado') {
    let observaciones = c!.observaciones
    if (estado === 'inhabilitado') {
      const m = window.prompt('Motivo de la inhabilitación (queda registrado):')
      if (!m) return
      observaciones = [c!.observaciones, `Inhabilitado ${fmtFecha(hoy())}: ${m}`].filter(Boolean).join('\n')
    }
    const { error } = await sb().from('clientes').update({ estado, observaciones }).eq('id', c!.id)
    if (error) return setMsg({ tone: 'red', text: errMsg(error) })
    setMsg({ tone: 'green', text: estado === 'activo' ? 'Cliente habilitado para facturación.' : 'Cliente inhabilitado.' })
    cargar()
  }

  const Dato = ({ l, v }: { l: string; v?: string | null }) => (
    <div>
      <dt className="text-xs text-slate-500">{l}</dt>
      <dd className="text-sm text-slate-900">{v || <span className="text-amber-700">Falta</span>}</dd>
    </div>
  )

  return (
    <>
      <div className="mb-2 text-sm">
        <Link href="/clientes" className="text-brand-700 hover:underline">
          ← Clientes
        </Link>
      </div>
      <PageHeader
        title={c.razon_social}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={ESTADO_CLIENTE[c.estado].tone}>{ESTADO_CLIENTE[c.estado].label}</Badge>
            <span className="tabular-nums">{fmtCuit(c.cuit_dni)}</span>
          </span>
        }
        actions={
          !puedeEditar ? (
            puedeCargarClientes && <Button onClick={() => setEditar(true)}>Editar datos</Button>
          ) : (
            <>
              {c.estado !== 'activo' && (
                <Button variant="success" onClick={() => cambiarEstado('activo')} disabled={faltan.length > 0} title={faltan.length ? `Faltan: ${faltan.join(', ')}` : ''}>
                  Validar y habilitar
                </Button>
              )}
              {c.estado === 'activo' && (
                <>
                  <Button variant="secondary" onClick={() => cambiarEstado('inhabilitado')}>
                    Inhabilitar
                  </Button>
                  <Button variant="secondary" onClick={() => setNuevaFactura(true)}>
                    + Comprobante
                  </Button>
                </>
              )}
              <Button onClick={() => setEditar(true)}>Editar datos</Button>
            </>
          )
        }
      />

      {msg && (
        <Alert tone={msg.tone} className="mb-4">
          {msg.text}
        </Alert>
      )}
      {c.estado !== 'activo' && faltan.length > 0 && (
        <Alert tone="amber" className="mb-4">
          No facturable. Faltan datos obligatorios (A01): <b>{faltan.join(', ')}</b>.
        </Alert>
      )}

      {verFinanzas && (
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat
          label={saldo < 0 ? 'Saldo a favor del cliente' : 'Saldo pendiente'}
          value={fmtMoney(saldo)}
          tone="brand"
          sub={creditos.length ? `${pend.length} comprobantes · ${creditos.length} NC sin imputar` : `${pend.length} comprobantes`}
        />
        <Stat label="Vencido" value={fmtMoney(vencido)} tone={vencido > 0 ? 'red' : 'green'} />
        <Stat label="Medio de pago preferido" value={<span className="text-base">{c.medio_pago_preferido || '—'}</span>} />
      </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Datos del cliente" className={verFinanzas ? 'lg:col-span-1' : 'lg:col-span-3'}>
          <dl className="grid grid-cols-1 gap-3">
            <Dato l="Condición IVA" v={c.condicion_iva} />
            <Dato l="Formato de facturación" v={fmtTipoFactura(c.tipo_factura)} />
            <Dato l="Contacto" v={c.contacto_nombre} />
            <Dato l="Teléfono" v={c.telefono} />
            <Dato l="Email" v={c.email} />
            <Dato l="Dirección" v={[c.direccion, c.localidad].filter(Boolean).join(', ') || null} />
            <Dato l="Horarios" v={c.horarios} />
            {c.observaciones && (
              <div>
                <dt className="text-xs text-slate-500">Observaciones</dt>
                <dd className="whitespace-pre-line text-sm">{c.observaciones}</dd>
              </div>
            )}
          </dl>
          <div className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">
            Alta: {fmtFechaHora(c.created_at)} · {c.creador?.nombre ?? '—'}
            <br />
            Última actualización: {fmtFechaHora(c.updated_at)} · {c.editor?.nombre ?? '—'}
          </div>
        </Card>

        {verFinanzas && (
        <Card title="Cuenta corriente" pad={false} className="lg:col-span-2">
          {facturas.length === 0 ? (
            <Empty>Sin comprobantes registrados.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th className={th}>Comprobante</th>
                  <th className={th}>Emisión</th>
                  <th className={th}>Vence</th>
                  <th className={`${th} text-right`}>Monto</th>
                  <th className={`${th} text-right`}>Saldo</th>
                  <th className={th}>Estado</th>
                </tr>
              </thead>
              <tbody>
                {facturas.map((f) => {
                  const e = estadoCobranza(f)
                  return (
                    <tr key={f.id} className="cursor-pointer hover:bg-brand-50/40" onClick={() => setDetalle(f.id)}>
                      <td className={`${td} whitespace-nowrap`}>
                        <TipoBadge f={f} /> <span className="text-slate-500">{f.numero}</span>
                      </td>
                      <td className={td}>{fmtFecha(f.fecha_emision)}</td>
                      <td className={td}>{esCredito(f) ? '—' : fmtFecha(f.fecha_vencimiento)}</td>
                      <td className={`${td} text-right tabular-nums`}>
                        <Importe n={montoFirmado(f)} />
                      </td>
                      <td className={`${td} text-right font-medium tabular-nums`}>
                        <Importe n={saldoFirmado(f)} />
                      </td>
                      <td className={td}>
                        <Badge tone={ESTADO_COB[e].tone}>{ESTADO_COB[e].label}</Badge>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </Table>
          )}
        </Card>
        )}
      </div>

      <Modal open={editar} onClose={() => setEditar(false)} title="Editar cliente" wide>
        <ClienteForm
          inicial={c}
          onCancel={() => setEditar(false)}
          onSaved={() => {
            setEditar(false)
            setMsg({ tone: 'green', text: 'Datos actualizados (queda registrada fecha y responsable).' })
            cargar()
          }}
        />
      </Modal>

      <Modal open={nuevaFactura} onClose={() => setNuevaFactura(false)} title={`Nuevo comprobante · ${c.razon_social}`}>
        <FacturaForm
          clienteId={c.id}
          onCancel={() => setNuevaFactura(false)}
          onSaved={() => {
            setNuevaFactura(false)
            setMsg({ tone: 'green', text: 'Comprobante registrado.' })
            cargar()
          }}
        />
      </Modal>

      <Modal open={!!detalle} onClose={() => setDetalle(null)} title="Detalle de cobranza" wide>
        {detalle && <FacturaDetalle facturaId={detalle} onChanged={cargar} />}
      </Modal>
    </>
  )
}
