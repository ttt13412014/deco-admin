'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { sb } from '@/lib/supabase'
import type { Factura } from '@/lib/types'
import { disponibilidad } from '@/lib/tesoreria'
import { ESTADO_COB, EstadoCob, plural, esLunes, estadoCobranza, fmtFecha, fmtFechaLarga, fmtMoney, hoy, sumarDias } from '@/lib/utils'
import { useAuth } from '@/components/AuthProvider'
import { FACTURA_SELECT, Importe, TipoBadge } from '@/components/Cobranzas'
import { saldoFirmado, sumaFirmada, vencidoNeto } from '@/lib/comprobantes'
import { Alert, Badge, Card, Empty, PageHeader, Spinner, Stat, Table, td, th } from '@/components/ui'

type Datos = {
  facturas: Factura[]
  conAviso: Set<string>
  pendientesValidar: number
  jornadaHoy: { estado: string } | null
  jornadaAbiertaAnterior: { fecha: string } | null
  diferencias: { fecha: string; cuenta: string; diferencia: number; justificacion: string | null }[]
  disponible: number | null
  chequesVencidos: number
  extractoPend: number
  porAutorizar: { n: number; total: number }
  novedadesPend: number
  respaldoDias: number | null
  usuariosPend: number
  pagosParaHoy: number
  informados: number
  promesasInc: number
}

export default function Resumen() {
  const { perfil, puedeEditar, esGerencia, puedeVer } = useAuth()
  // Cada bloque del tablero aparece solo si la persona ve esa sección (Usuarios → Permisos por sección)
  const verCob = puedeVer('cobranzas') || puedeVer('reporte')
  const verTes = puedeEditar && (['tesoreria', 'caja', 'movimientos', 'bancos', 'cheques'] as const).some((x) => puedeVer(x))
  const verPagos = puedeEditar && puedeVer('pagos')
  const verPersonal = puedeEditar && puedeVer('personal')
  const verClientes = puedeVer('clientes')
  const router = useRouter()
  const [d, setD] = useState<Datos | null>(null)
  const ref = hoy()

  useEffect(() => {
    ;(async () => {
      const s = sb()
      const desde = new Date(Date.now() - 15 * 86400000).toISOString()
      const nada = Promise.resolve({ data: null, count: null })
      const [f, g, c] = await Promise.all([
        verCob ? s.from('facturas').select(FACTURA_SELECT).eq('estado', 'pendiente').order('fecha_vencimiento') : nada,
        verCob ? s.from('gestiones_cobranza').select('factura_id').gte('created_at', desde).in('tipo', ['aviso_preventivo', 'aviso_vencimiento', 'aviso_atraso']) : nada,
        verClientes ? s.from('clientes').select('id', { count: 'exact', head: true }).eq('estado', 'pendiente') : nada,
      ])
      let jornadaHoy: Datos['jornadaHoy'] = null
      let jornadaAbiertaAnterior: Datos['jornadaAbiertaAnterior'] = null
      let diferencias: Datos['diferencias'] = []
      let disponible: number | null = null
      let chequesVencidos = 0
      let extractoPend = 0
      let porAutorizar = { n: 0, total: 0 }
      let informados = 0
      let promesasInc = 0
      let pagosParaHoy = 0
      let novedadesPend = 0
      let respaldoDias: number | null = null
      let usuariosPend = 0
      try {
        const u = localStorage.getItem('deco_ultimo_respaldo')
        respaldoDias = u ? Math.floor((Date.now() - new Date(u).getTime()) / 86400000) : -1
      } catch {}
      if (verTes) {
        const [h, a, dif, disp, cv, ep] = await Promise.all([
          s.from('tes_jornadas').select('estado').eq('fecha', ref).maybeSingle(),
          s.from('tes_jornadas').select('fecha').lt('fecha', ref).eq('estado', 'abierta').order('fecha').limit(1).maybeSingle(),
          s
            .from('tes_jornada_saldos')
            .select('diferencia, justificacion, cuenta:tes_cuentas(nombre), jornada:tes_jornadas!inner(fecha, estado)')
            .neq('diferencia', 0)
            .gte('jornada.fecha', sumarDias(ref, -30)),
          disponibilidad(ref).catch(() => null),
          s.from('tes_cheques').select('id', { count: 'exact', head: true }).in('estado', ['en_cartera', 'depositado', 'emitido']).lt('fecha_pago', ref),
          s.from('tes_extractos').select('id', { count: 'exact', head: true }).eq('estado', 'pendiente'),
        ])
        jornadaHoy = (h.data as { estado: string }) ?? null
        jornadaAbiertaAnterior = (a.data as { fecha: string }) ?? null
        type FilaDif = { diferencia: number; justificacion: string | null; cuenta: { nombre: string } | null; jornada: { fecha: string } | null }
        diferencias = ((dif.data as unknown as FilaDif[]) ?? [])
          .filter((x) => x.jornada)
          .map((x) => ({ fecha: x.jornada!.fecha, cuenta: x.cuenta?.nombre ?? '', diferencia: Number(x.diferencia), justificacion: x.justificacion }))
          .sort((x, y) => y.fecha.localeCompare(x.fecha))
        disponible = disp ? disp.reduce((t, x) => t + x.saldo, 0) : null
        chequesVencidos = cv.count ?? 0
        extractoPend = ep.count ?? 0
      }
      if (puedeEditar) {
        const [ob, pi, pr] = await Promise.all([
          s.from('pag_obligaciones').select('estado,saldo,vencimiento,fecha_estimada_pago').not('estado', 'in', '(pagado,cancelado)'),
          s.from('cob_pagos_informados').select('id', { count: 'exact', head: true }).eq('estado', 'pendiente_validacion'),
          s.from('cob_promesas').select('id', { count: 'exact', head: true }).eq('estado', 'pendiente').lt('fecha_promesa', ref),
        ])
        const obs = ((ob.data as { estado: string; saldo: number; vencimiento: string | null; fecha_estimada_pago: string | null }[]) ?? []).filter((o) => Number(o.saldo) > 0)
        const dec = obs.filter((o) => o.estado === 'pendiente_decision' || o.estado === 'pendiente_revision')
        porAutorizar = { n: dec.length, total: dec.reduce((a, x) => a + Number(x.saldo), 0) }
        pagosParaHoy = obs.filter((o) => ['autorizado', 'programado', 'reprogramado'].includes(o.estado) && (o.fecha_estimada_pago ?? o.vencimiento ?? '9999') <= ref).length
        informados = pi.count ?? 0
        promesasInc = pr.count ?? 0
        const np = await s.from('novedades').select('id', { count: 'exact', head: true }).eq('estado', 'pendiente')
        novedadesPend = np.count ?? 0
        const up = await s.from('perfiles').select('id', { count: 'exact', head: true }).eq('rol', 'pendiente')
        usuariosPend = up.count ?? 0
      }
      setD({
        facturas: (f.data as Factura[]) ?? [],
        conAviso: new Set(((g.data as { factura_id: string }[]) ?? []).map((x) => x.factura_id)),
        pendientesValidar: c.count ?? 0,
        jornadaHoy,
        jornadaAbiertaAnterior,
        diferencias,
        disponible,
        chequesVencidos,
        extractoPend,
        porAutorizar,
        pagosParaHoy,
        informados,
        promesasInc,
        novedadesPend,
        respaldoDias,
        usuariosPend,
      })
    })()
  }, [puedeEditar, verCob, verTes, verClientes, ref])

  const k = useMemo(() => {
    const r: Record<EstadoCob, { n: number; total: number; sinAviso: number }> = {
      al_dia: { n: 0, total: 0, sinAviso: 0 },
      por_vencer: { n: 0, total: 0, sinAviso: 0 },
      vence_hoy: { n: 0, total: 0, sinAviso: 0 },
      atrasado: { n: 0, total: 0, sinAviso: 0 },
      atraso_prolongado: { n: 0, total: 0, sinAviso: 0 },
      credito: { n: 0, total: 0, sinAviso: 0 },
      cobrado: { n: 0, total: 0, sinAviso: 0 },
      imputada: { n: 0, total: 0, sinAviso: 0 },
      anulada: { n: 0, total: 0, sinAviso: 0 },
    }
    for (const f of d?.facturas ?? []) {
      const e = estadoCobranza(f, ref)
      r[e].n++
      r[e].total += saldoFirmado(f)
      if (!d!.conAviso.has(f.id)) r[e].sinAviso++
    }
    return r
  }, [d, ref])

  if (!d) return <Spinner />

  // Con signo: las notas de crédito y "anula presupuesto" restan
  const total = sumaFirmada(d.facturas)
  // Lo vencido, descontando las notas de crédito a favor de cada cliente
  const vencido = vencidoNeto(d.facturas, (f) => ['atrasado', 'atraso_prolongado'].includes(estadoCobranza(f, ref)))
  const urgentes = d.facturas
    .map((f) => ({ f, e: estadoCobranza(f, ref) }))
    .filter((x) => x.e !== 'al_dia' && x.e !== 'credito')
    .slice(0, 10)

  const tareas: { tone: 'red' | 'amber' | 'blue'; text: React.ReactNode; href: string }[] = []
  if (verTes && d.jornadaAbiertaAnterior)
    tareas.push({ tone: 'red', text: <>Cerrar la jornada del <b>{fmtFecha(d.jornadaAbiertaAnterior.fecha)}</b> (sigue abierta)</>, href: `/tesoreria/jornada?fecha=${d.jornadaAbiertaAnterior.fecha}` })
  if (verTes && !d.jornadaHoy) tareas.push({ tone: 'amber', text: 'Abrir la jornada de hoy (efectivo, Galicia y Macro)', href: '/tesoreria/jornada' })
  if (verTes && d.chequesVencidos)
    tareas.push({ tone: 'amber', text: <>Confirmar <b>{d.chequesVencidos}</b> {plural(d.chequesVencidos, 'cheque vencido', 'cheques vencidos')} sin acreditar o debitar</>, href: '/tesoreria/cheques' })
  if (verTes && d.extractoPend)
    tareas.push({ tone: 'blue', text: <>Identificar <b>{d.extractoPend}</b> {plural(d.extractoPend, 'línea', 'líneas')} del extracto bancario</>, href: '/tesoreria/bancos' })
  if (k.por_vencer.sinAviso)
    tareas.push({ tone: 'amber', text: <>Enviar <b>{k.por_vencer.sinAviso}</b> {plural(k.por_vencer.sinAviso, 'aviso preventivo', 'avisos preventivos')} (vencen en ≤72 hs)</>, href: '/cobranzas?f=por_vencer' })
  if (k.vence_hoy.sinAviso)
    tareas.push({ tone: 'amber', text: <>Avisar <b>{k.vence_hoy.sinAviso}</b> {plural(k.vence_hoy.sinAviso, 'vencimiento', 'vencimientos')} de hoy</>, href: '/cobranzas?f=vence_hoy' })
  if (k.atrasado.n) tareas.push({ tone: 'red', text: <>Registrar e informar <b>{k.atrasado.n}</b> {plural(k.atrasado.n, 'atraso', 'atrasos')} a Ventas y Gerencia</>, href: '/cobranzas?f=atrasado' })
  if (k.atraso_prolongado.n)
    tareas.push({ tone: 'red', text: <>Escalar <b>{k.atraso_prolongado.n}</b> {plural(k.atraso_prolongado.n, 'atraso prolongado', 'atrasos prolongados')} a Gerencia</>, href: '/cobranzas?f=atraso_prolongado' })
  if (esGerencia && verPagos && d.porAutorizar.n)
    tareas.push({ tone: 'amber', text: <>Decidir <b>{d.porAutorizar.n}</b> {plural(d.porAutorizar.n, 'pago', 'pagos')} por {fmtMoney(d.porAutorizar.total)} (A08)</>, href: '/pagos' })
  if (verPagos && d.pagosParaHoy)
    tareas.push({ tone: 'red', text: <>Registrar <b>{d.pagosParaHoy}</b> {plural(d.pagosParaHoy, 'pago autorizado', 'pagos autorizados')} para hoy o atrasados</>, href: '/pagos' })
  if (verCob && d.informados)
    tareas.push({ tone: 'amber', text: <>Validar <b>{d.informados}</b> {plural(d.informados, 'pago informado', 'pagos informados')} por clientes</>, href: '/cobranzas' })
  if (verCob && d.promesasInc)
    tareas.push({ tone: 'red', text: <>Seguir <b>{d.promesasInc}</b> {plural(d.promesasInc, 'promesa de pago incumplida', 'promesas de pago incumplidas')}</>, href: '/cobranzas?f=promesas' })
  if (esGerencia && verPersonal && d.novedadesPend)
    tareas.push({ tone: 'amber', text: <>Aprobar <b>{d.novedadesPend}</b> {plural(d.novedadesPend, 'novedad', 'novedades')} de personal (vacaciones, licencias, permisos)</>, href: '/personal' })
  if (esGerencia && d.usuariosPend)
    tareas.push({ tone: 'amber', text: <>Dar acceso a <b>{d.usuariosPend}</b> {plural(d.usuariosPend, 'usuario nuevo', 'usuarios nuevos')}</>, href: '/usuarios' })
  if (puedeEditar && puedeVer('respaldo') && d.respaldoDias !== null && (d.respaldoDias < 0 || d.respaldoDias >= 7))
    tareas.push({ tone: 'blue', text: d.respaldoDias < 0 ? <>Hacer el primer <b>respaldo</b> de los datos</> : <>Hacer un <b>respaldo</b> (el último fue hace {d.respaldoDias} días)</>, href: '/respaldo' })
  if (verClientes && d.pendientesValidar) tareas.push({ tone: 'blue', text: <>Validar <b>{d.pendientesValidar}</b> {plural(d.pendientesValidar, 'cliente pendiente', 'clientes pendientes')} (A01)</>, href: '/clientes' })

  const dot = { red: 'bg-red-500', amber: 'bg-amber-400', blue: 'bg-sky-500' }

  return (
    <>
      <PageHeader title={`Hola${perfil?.nombre ? `, ${perfil.nombre}` : ''}`} subtitle={<span className="capitalize">{fmtFechaLarga(ref)}</span>} />

      {esLunes(ref) && puedeVer('reporte') && (
        <Alert tone="blue" className="mb-5">
          <b>Es lunes:</b> recopilá el estado de cuenta de clientes con saldo deudor y comunicalo (A05 §3).{' '}
          <Link href="/cobranzas/reporte" className="font-medium underline">
            Abrir reporte
          </Link>
        </Alert>
      )}

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {verCob && (
        <>
        <Stat
          label="Por cobrar"
          value={fmtMoney(total)}
          sub={k.credito.n ? `${d.facturas.length} comprobantes · incluye ${fmtMoney(k.credito.total)} de NC` : `${d.facturas.length} comprobantes`}
          tone="brand"
          onClick={() => router.push('/cobranzas')}
        />
        <Stat label="Vencido" value={fmtMoney(vencido)} sub={`${k.atrasado.n + k.atraso_prolongado.n} comprobantes`} tone="red" onClick={() => router.push('/cobranzas?f=atrasado')} />
        <Stat
          label="Vence ≤72 hs"
          value={fmtMoney(k.por_vencer.total + k.vence_hoy.total)}
          sub={`${k.por_vencer.n + k.vence_hoy.n} comprobantes`}
          tone="amber"
          onClick={() => router.push('/cobranzas?f=por_vencer')}
        />
        </>
        )}
        {verTes ? (
          <Stat
            label="Disponible hoy"
            value={d.disponible === null ? '—' : fmtMoney(d.disponible)}
            sub={d.jornadaHoy ? (d.jornadaHoy.estado === 'cerrada' ? 'Jornada cerrada' : 'Jornada abierta') : 'Jornada sin abrir'}
            tone={d.jornadaHoy?.estado === 'cerrada' ? 'green' : d.jornadaHoy ? 'amber' : 'slate'}
            onClick={() => router.push('/tesoreria')}
          />
        ) : verClientes ? (
          <Stat label="Clientes a validar" value={d.pendientesValidar} tone="slate" onClick={() => router.push('/clientes')} />
        ) : null}
      </div>

      <div className="grid gap-5 lg:grid-cols-5">
        <Card title="Para hacer hoy" className={verCob ? 'lg:col-span-2' : 'lg:col-span-5'}>
          {tareas.length === 0 ? (
            <p className="py-6 text-center text-sm text-emerald-700">Todo al día. 👌</p>
          ) : (
            <ul className="space-y-1">
              {tareas.map((t, i) => (
                <li key={i}>
                  <Link href={t.href} className="flex items-start gap-3 rounded-lg px-2 py-2 text-sm hover:bg-slate-50">
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot[t.tone]}`} />
                    <span className="flex-1">{t.text}</span>
                    <span className="text-slate-400">›</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {verCob && (
        <Card title="Vencimientos a atender" pad={false} className="lg:col-span-3">
          {urgentes.length === 0 ? (
            <Empty>Nada vencido ni por vencer en las próximas 72 hs.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th className={th}>Cliente</th>
                  <th className={th}>Vence</th>
                  <th className={`${th} text-right`}>Saldo</th>
                  <th className={th}>Estado</th>
                </tr>
              </thead>
              <tbody>
                {urgentes.map(({ f, e }) => (
                  <tr key={f.id} className="cursor-pointer hover:bg-brand-50/40" onClick={() => router.push(`/clientes/${f.cliente_id}`)}>
                    <td className={td}>
                      <div className="font-medium">{f.cliente?.razon_social}</div>
                      <div className="text-xs text-slate-500">
                        <TipoBadge f={f} corto /> {f.numero}
                      </div>
                    </td>
                    <td className={`${td} whitespace-nowrap`}>{fmtFecha(f.fecha_vencimiento)}</td>
                    <td className={`${td} text-right tabular-nums`}>
                      <Importe n={saldoFirmado(f)} />
                    </td>
                    <td className={td}>
                      <Badge tone={ESTADO_COB[e].tone}>{ESTADO_COB[e].label}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        )}
      </div>

      {esGerencia && (
        <Card title="Control de Gerencia · diferencias de cierre (últimos 30 días)" className="mt-5" pad={false}>
          {d.diferencias.length === 0 ? (
            <Empty>Sin diferencias en los cierres.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th className={th}>Fecha</th>
                  <th className={th}>Cuenta</th>
                  <th className={`${th} text-right`}>Diferencia</th>
                  <th className={th}>Justificación</th>
                </tr>
              </thead>
              <tbody>
                {d.diferencias.map((c, i) => (
                  <tr key={i}>
                    <td className={td}>{fmtFecha(c.fecha)}</td>
                    <td className={td}>{c.cuenta}</td>
                    <td className={`${td} text-right font-semibold tabular-nums text-red-600`}>{fmtMoney(c.diferencia)}</td>
                    <td className={`${td} text-sm`}>{c.justificacion}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}
    </>
  )
}
