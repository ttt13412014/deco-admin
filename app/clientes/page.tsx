'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { sb } from '@/lib/supabase'
import type { ClienteSaldo, EstadoCliente } from '@/lib/types'
import { ESTADO_CLIENTE, fmtCuit, fmtMoney } from '@/lib/utils'
import { useAuth } from '@/components/AuthProvider'
import { ClienteForm } from '@/components/ClienteForm'
import { ImportarClientes } from '@/components/ImportarClientes'
import { Alert, Badge, Button, Card, Empty, Modal, PageHeader, Spinner, Table, cx, inputCls, td, th } from '@/components/ui'

export default function ClientesPage() {
  const { puedeCargarClientes, puedeVer } = useAuth()
  // Saldos (datos financieros): solo quien ve Cuentas a cobrar (Ventas no, salvo que Gerencia se lo habilite)
  const verSaldos = puedeVer('cobranzas') || puedeVer('reporte')
  const router = useRouter()
  const [clientes, setClientes] = useState<ClienteSaldo[] | null>(null)
  const [q, setQ] = useState('')
  const [estado, setEstado] = useState<EstadoCliente | 'todos'>('todos')
  const [nuevo, setNuevo] = useState(false)
  const [importar, setImportar] = useState(false)
  const [aviso, setAviso] = useState<string | null>(null)

  const cargar = useCallback(async () => {
    const { data } = await sb().from('v_clientes_saldos').select('*').order('razon_social')
    setClientes((data as ClienteSaldo[]) ?? [])
  }, [])

  useEffect(() => {
    cargar()
  }, [cargar])

  const conteo = useMemo(() => {
    const c = { activo: 0, pendiente: 0, inhabilitado: 0 }
    for (const x of clientes ?? []) c[x.estado]++
    return c
  }, [clientes])

  const lista = useMemo(() => {
    let l = clientes ?? []
    if (estado !== 'todos') l = l.filter((c) => c.estado === estado)
    const t = q.toLowerCase().trim()
    if (t) {
      const dig = t.replace(/\D/g, '')
      l = l.filter(
        (c) =>
          c.razon_social.toLowerCase().includes(t) ||
          (dig && (c.cuit_dni ?? '').includes(dig)) ||
          (c.localidad ?? '').toLowerCase().includes(t) ||
          (c.contacto_nombre ?? '').toLowerCase().includes(t),
      )
    }
    return l
  }, [clientes, estado, q])

  return (
    <>
      <PageHeader
        title="Clientes"
        subtitle="A01 · Cliente no validado administrativamente = cliente no facturable."
        actions={
          puedeCargarClientes && (
            <>
              <Button variant="secondary" onClick={() => setImportar(true)}>
                Importar Excel
              </Button>
              <Button onClick={() => setNuevo(true)}>+ Alta de cliente</Button>
            </>
          )
        }
      />

      {aviso && (
        <Alert tone="green" className="mb-4">
          {aviso}
        </Alert>
      )}
      {conteo.pendiente > 0 && estado !== 'pendiente' && (
        <Alert tone="amber" className="mb-4">
          Hay <b>{conteo.pendiente}</b> clientes pendientes de validar.{' '}
          <button className="font-medium underline" onClick={() => setEstado('pendiente')}>
            Ver
          </button>
        </Alert>
      )}

      <Card
        pad={false}
        title={
          <div className="flex flex-wrap gap-1.5">
            {(['todos', 'activo', 'pendiente', 'inhabilitado'] as const).map((e) => (
              <button
                key={e}
                onClick={() => setEstado(e)}
                className={cx(
                  'rounded-full border px-3 py-1 text-xs font-medium',
                  estado === e ? 'border-brand-700 bg-brand-700 text-white' : 'border-slate-300 text-slate-600 hover:border-brand-400',
                )}
              >
                {e === 'todos' ? `Todos ${clientes?.length ?? ''}` : `${ESTADO_CLIENTE[e].label} ${conteo[e]}`}
              </button>
            ))}
          </div>
        }
        actions={<input className={`${inputCls} w-60`} placeholder="Buscar nombre, CUIT, localidad…" value={q} onChange={(e) => setQ(e.target.value)} />}
      >
        {!clientes ? (
          <Spinner />
        ) : lista.length === 0 ? (
          <Empty>{clientes.length === 0 ? 'Todavía no hay clientes. Cargalos uno por uno o importá un Excel.' : 'Sin resultados.'}</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
                <th className={th}>Cliente</th>
                <th className={th}>CUIT / DNI</th>
                <th className={th}>Contacto</th>
                <th className={th}>Estado</th>
                {verSaldos && <th className={`${th} text-right`}>Saldo</th>}
              </tr>
            </thead>
            <tbody>
              {lista.map((c) => (
                <tr key={c.id} className="cursor-pointer hover:bg-brand-50/40" onClick={() => router.push(`/clientes/${c.id}`)}>
                  <td className={td}>
                    <Link href={`/clientes/${c.id}`} className="font-medium text-slate-900 hover:text-brand-700" onClick={(e) => e.stopPropagation()}>
                      {c.razon_social}
                    </Link>
                    <div className="text-xs text-slate-500">
                      {[c.localidad, c.condicion_iva].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </td>
                  <td className={`${td} whitespace-nowrap tabular-nums`}>{fmtCuit(c.cuit_dni)}</td>
                  <td className={td}>
                    <div>{c.contacto_nombre || '—'}</div>
                    <div className="text-xs text-slate-500">{c.telefono}</div>
                  </td>
                  <td className={td}>
                    <Badge tone={ESTADO_CLIENTE[c.estado].tone}>{ESTADO_CLIENTE[c.estado].label}</Badge>
                  </td>
                  {verSaldos && (
                  <td className={`${td} text-right tabular-nums`}>
                    {Number(c.saldo) !== 0 ? (
                      <>
                        <div className={Number(c.saldo) < 0 ? 'font-semibold text-red-700' : 'font-semibold'} title={Number(c.saldo) < 0 ? 'Saldo a favor del cliente (notas de crédito sin imputar)' : undefined}>
                          {fmtMoney(c.saldo)}
                        </div>
                        {Number(c.vencido) > 0 && <div className="text-xs text-red-600">{fmtMoney(c.vencido)} vencido</div>}
                      </>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Modal open={nuevo} onClose={() => setNuevo(false)} title="Alta de cliente (A01)" wide>
        <ClienteForm
          onCancel={() => setNuevo(false)}
          onSaved={(c) => {
            setNuevo(false)
            setAviso(`${c.razon_social} dado de alta como ${ESTADO_CLIENTE[c.estado].label.toLowerCase()}.`)
            cargar()
          }}
        />
      </Modal>

      <Modal open={importar} onClose={() => setImportar(false)} title="Importar clientes desde Excel" wide>
        <ImportarClientes
          onDone={(r) => {
            setImportar(false)
            setAviso(r)
            cargar()
          }}
        />
      </Modal>
    </>
  )
}
