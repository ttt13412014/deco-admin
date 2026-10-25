'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Evento } from '@/lib/personal'
import { sb, errMsg } from '@/lib/supabase'
import { fmtFecha, hoy, sumarDias } from '@/lib/utils'
import {
  ESTADO_NOV, Empleado, MESES, Novedad, TIPOS, TIPOS_FILTRO, TipoEvento, antiguedad, armarEventos, ausentesEl, cumpleDe,
  diasCorridos, diasHabiles, edadEn, eventosPorDia, eventosPorRango, feriadosDe, fmtCuil, nombreEmp, saldoVacaciones,
} from '@/lib/personal'
import { generarICS } from '@/lib/ics'
import { generarCSV, generarXLSX } from '@/lib/xlsx-lite'
import { Periodo, canvasA, descargar, dibujarCalendario, lunesDe, nombrePeriodo, numeroSemana, pdfConImagen, rangoPeriodo } from '@/lib/calendario-export'
import { useAuth } from '@/components/AuthProvider'
import { CalendarioAnual, EmpleadoForm, Etiqueta, ListaEventosDia, NovedadForm } from '@/components/Personal'
import { Alert, Badge, Button, Card, Empty, Modal, PageHeader, Spinner, Stat, Table, compactCls, cx, td, th } from '@/components/ui'

type Tab = 'resumen' | 'personal' | 'novedades' | 'calendario'

export default function PersonalPage() {
  const { puedeEditar, esGerencia } = useAuth()
  const ref = hoy()
  const [anio, setAnio] = useState(Number(ref.slice(0, 4)))
  const [tab, setTab] = useState<Tab>('resumen')
  const [empleados, setEmpleados] = useState<Empleado[] | null>(null)
  const [novedades, setNovedades] = useState<Novedad[]>([])
  const [msg, setMsg] = useState<{ tone: 'green' | 'red' | 'amber' | 'blue'; text: string } | null>(null)

  const [empForm, setEmpForm] = useState<Empleado | 'nuevo' | null>(null)
  const [novForm, setNovForm] = useState<{ inicial?: Novedad; preset?: { fecha?: string; empleado_id?: string } } | null>(null)

  // filtros
  const [q, setQ] = useState('')
  const [verBajas, setVerBajas] = useState(false)
  const [fEmp, setFEmp] = useState('')
  const [fTipos, setFTipos] = useState<Set<TipoEvento>>(new Set(TIPOS_FILTRO))
  const [conPendientes, setConPendientes] = useState(true)
  const [fEstado, setFEstado] = useState<'pendiente' | 'aprobado' | 'rechazado' | 'todos'>('todos')
  const [diaSel, setDiaSel] = useState<string | null>(ref)
  const [periodo, setPeriodo] = useState<Periodo>({ tipo: 'anio' })
  const [exportando, setExportando] = useState<string | null>(null)

  const cargar = useCallback(async () => {
    const s = sb()
    const [e, n] = await Promise.all([
      s.from('empleados').select('*').order('apellido'),
      s.from('novedades').select('*').order('fecha_desde', { ascending: false }),
    ])
    setEmpleados((e.data as Empleado[]) ?? [])
    setNovedades((n.data as Novedad[]) ?? [])
  }, [])

  useEffect(() => {
    if (puedeEditar) cargar()
  }, [cargar, puedeEditar])

  const empPorId = useMemo(() => new Map((empleados ?? []).map((e) => [e.id, e])), [empleados])
  const eventos = useMemo(() => armarEventos(anio, empleados ?? [], novedades), [anio, empleados, novedades])
  const pasaFiltro = useCallback(
    (e: Evento) => {
      const t: TipoEvento = e.tipo === 'feriado' ? 'feriado_nac' : e.tipo
      if (!fTipos.has(t)) return false
      if (!conPendientes && e.estado === 'pendiente') return false
      if (fEmp && e.empleado_id && e.empleado_id !== fEmp) return false
      if (fEmp && !e.empleado_id && !['feriado_nac', 'feriado', 'reunion'].includes(e.tipo)) return false
      return true
    },
    [fTipos, conPendientes, fEmp],
  )
  const eventosFiltrados = useMemo(() => eventos.filter(pasaFiltro), [eventos, pasaFiltro])
  const porDia = useMemo(() => eventosPorDia(eventosFiltrados, anio), [eventosFiltrados, anio])

  if (!puedeEditar) return <Empty>La sección de personal es exclusiva de Administración y Gerencia.</Empty>
  if (!empleados) return <Spinner />

  const activos = empleados.filter((e) => e.activo)
  const pendientes = novedades.filter((n) => n.estado === 'pendiente')
  const vacLicPend = pendientes.filter((n) => n.tipo === 'vacaciones' || n.tipo === 'licencia')
  const permisosPend = pendientes.filter((n) => n.tipo === 'permiso')
  const mesActual = Number(ref.slice(5, 7))
  const cumplesMes = activos
    .filter((e) => e.fecha_nacimiento && Number(e.fecha_nacimiento.slice(5, 7)) === mesActual)
    .sort((a, b) => a.fecha_nacimiento!.slice(8).localeCompare(b.fecha_nacimiento!.slice(8)))
  const ausentesHoy = ausentesEl(ref, novedades)
  const proximos = armarEventos(Number(ref.slice(0, 4)), activos, novedades)
    .concat(ref.slice(5) > '11-01' ? armarEventos(Number(ref.slice(0, 4)) + 1, activos, novedades) : [])
    .filter((e) => e.hasta >= ref && e.desde <= sumarDias(ref, 30) && e.estado !== 'rechazado')
    .filter((e, i, a) => a.findIndex((x) => x.id === e.id) === i)
    .sort((a, b) => a.desde.localeCompare(b.desde))

  async function decidir(n: Novedad, estado: 'aprobado' | 'rechazado' | 'pendiente') {
    setMsg(null)
    let motivo: string | null = null
    if (estado === 'rechazado') {
      motivo = window.prompt('Motivo del rechazo:')
      if (!motivo?.trim()) return
    }
    const { error } = await sb().from('novedades').update({ estado, motivo_rechazo: motivo }).eq('id', n.id)
    if (error) return setMsg({ tone: 'red', text: errMsg(error) })
    const quien = n.empleado_id ? nombreEmp(empPorId.get(n.empleado_id)!) : 'Todo el personal'
    setMsg({ tone: estado === 'aprobado' ? 'green' : 'amber', text: `${TIPOS[n.tipo].label} de ${quien}: ${ESTADO_NOV[estado].label.toLowerCase()}.` })
    cargar()
  }

  async function borrar(n: Novedad) {
    if (!window.confirm('¿Eliminar esta novedad?')) return
    const { error } = await sb().from('novedades').delete().eq('id', n.id)
    if (error) return setMsg({ tone: 'red', text: errMsg(error) })
    cargar()
  }

  // ---------- Exportaciones ----------
  const filtrosTexto = [
    fEmp ? `Empleado: ${nombreEmp(empPorId.get(fEmp)!)}` : 'Todo el personal',
    fTipos.size < TIPOS_FILTRO.length ? `Tipos: ${[...fTipos].map((t) => TIPOS[t].label).join(', ')}` : '',
    conPendientes ? 'incluye pendientes' : 'solo aprobados',
  ]
    .filter(Boolean)
    .join(' · ')
  const sufijoDe = (p: Periodo) =>
    p.tipo === 'anio' ? `${anio}` : p.tipo === 'trimestre' ? `${anio}-T${p.q + 1}` : p.tipo === 'mes' ? `${anio}-${String(p.m + 1).padStart(2, '0')}` : `semana-${p.desde}`

  /** Eventos (filtrados) que caen dentro del período; si la semana cruza de año, suma los dos años. */
  function eventosDelPeriodo(p: Periodo): { lista: Evento[]; porDia: Map<string, Evento[]>; desde: string; hasta: string } {
    const [desde, hasta] = rangoPeriodo(p, anio)
    const anios = Array.from(new Set([Number(desde.slice(0, 4)), Number(hasta.slice(0, 4))]))
    const vistos = new Set<string>()
    const lista = anios
      .flatMap((a) => (a === anio ? eventos : armarEventos(a, empleados ?? [], novedades)))
      .filter((e) => (vistos.has(e.id) ? false : (vistos.add(e.id), true)))
      .filter(pasaFiltro)
      .filter((e) => e.hasta >= desde && e.desde <= hasta)
      .sort((a, b) => a.desde.localeCompare(b.desde))
    return { lista, porDia: eventosPorRango(lista, desde, hasta), desde, hasta }
  }

  async function exportar(formato: 'pdf' | 'png' | 'ics' | 'xlsx' | 'csv-eventos' | 'csv-vacaciones', pOverride?: Periodo) {
    const per = pOverride ?? periodo
    const sufijo = sufijoDe(per)
    const ep = eventosDelPeriodo(per)
    setExportando(formato)
    try {
      if (formato === 'pdf' || formato === 'png') {
        const cv = dibujarCalendario({ anio, periodo: per, porDia: ep.porDia, subtitulo: filtrosTexto })
        if (formato === 'png') descargar(await canvasA(cv, 'image/png'), `calendario-personal-${sufijo}.png`, 'image/png')
        else {
          const jpg = new Uint8Array(await (await canvasA(cv, 'image/jpeg', 0.9)).arrayBuffer())
          descargar(pdfConImagen(jpg, cv.width, cv.height), `calendario-personal-${sufijo}.pdf`, 'application/pdf')
        }
      } else if (formato === 'ics') {
        descargar(generarICS(ep.lista, { nombre: `DE&CO · Personal · ${nombrePeriodo(per, anio)}` }), `calendario-personal-${sufijo}.ics`, 'text/calendar')
      } else if (formato === 'xlsx') {
        descargar(generarXLSX(hojasExcel(ep.lista, per)), `personal-${sufijo}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      } else if (formato === 'csv-eventos') {
        descargar(generarCSV(filasEventos(ep.lista)), `eventos-${sufijo}.csv`, 'text/csv;charset=utf-8')
      } else {
        descargar(generarCSV(filasVacaciones()), `vacaciones-${anio}.csv`, 'text/csv;charset=utf-8')
      }
      setMsg({ tone: 'green', text: 'Archivo generado. Revisá tus descargas.' })
    } catch (e) {
      setMsg({ tone: 'red', text: `No se pudo exportar: ${errMsg(e)}` })
    }
    setExportando(null)
  }

  function filasVacaciones() {
    return [
      ['Empleado', 'CUIL', 'Puesto', 'Área', 'Ingreso', 'Antigüedad (años)', 'Días asignados', 'Criterio', 'Usufructuados', 'Pedidos sin aprobar', 'Saldo'],
      ...activos.map((e) => {
        const s = saldoVacaciones(e, novedades, anio)
        return [nombreEmp(e), fmtCuil(e.cuil), e.puesto, e.area, fmtFecha(e.fecha_ingreso), antiguedad(e.fecha_ingreso, anio), s.asignados, s.regla, s.usufructuados, s.solicitados, s.saldo]
      }),
    ]
  }
  function filasEventos(lista: Evento[]) {
    return [
      ['Tipo', 'Empleado', 'Detalle', 'Desde', 'Hasta', 'Días corridos', 'Días hábiles', 'Horario', 'Estado'],
      ...lista
        .slice()
        .sort((a, b) => a.desde.localeCompare(b.desde))
        .map((e) => [
          TIPOS[e.tipo].label,
          e.empleado ?? (e.tipo === 'feriado_nac' ? '' : 'Todo el personal'),
          e.tipo === 'licencia' ? '' : e.titulo.split(' · ')[0],
          fmtFecha(e.desde),
          fmtFecha(e.hasta),
          diasCorridos(e.desde, e.hasta),
          diasHabiles(e.desde, e.hasta),
          e.hora ?? '',
          ESTADO_NOV[e.estado].label,
        ]),
    ]
  }
  function hojasExcel(lista: Evento[], per: Periodo) {
    return [
      { nombre: `Vacaciones ${anio}`, filas: filasVacaciones(), anchos: [28, 16, 22, 18, 12, 10, 10, 34, 13, 13, 8] },
      { nombre: per.tipo === 'anio' ? `Eventos ${anio}` : per.tipo === 'semana' ? `Eventos semana ${numeroSemana(per.desde)}` : `Eventos ${sufijoDe(per)}`, filas: filasEventos(lista), anchos: [16, 26, 40, 12, 12, 10, 10, 14, 12] },
      {
        nombre: 'Legajos',
        filas: [
          ['Apellido', 'Nombre', 'CUIL', 'Puesto', 'Área', 'Ingreso', 'Nacimiento', 'Teléfono', 'Email', 'Emergencia', 'Tel. emergencia', 'Vínculo', 'Estado'],
          ...empleados!.map((e) => [
            e.apellido, e.nombre, fmtCuil(e.cuil), e.puesto, e.area, fmtFecha(e.fecha_ingreso), e.fecha_nacimiento ? fmtFecha(e.fecha_nacimiento) : '',
            e.telefono, e.email, e.emergencia_nombre, e.emergencia_telefono, e.emergencia_vinculo, e.activo ? 'Activo' : `Baja ${fmtFecha(e.fecha_baja)}`,
          ]),
        ],
        anchos: [16, 16, 16, 22, 18, 12, 12, 16, 26, 22, 16, 12, 16],
      },
      { nombre: `Feriados ${anio}`, filas: [['Fecha', 'Feriado'], ...feriadosDe(anio).map((f) => [fmtFecha(f.fecha), f.nombre])], anchos: [12, 52] },
    ]
  }

  // ---------- Vistas ----------
  const listaEmp = empleados
    .filter((e) => verBajas || e.activo)
    .filter((e) => {
      const t = q.toLowerCase().trim()
      return !t || `${e.nombre} ${e.apellido} ${e.puesto ?? ''} ${e.area ?? ''} ${e.cuil ?? ''}`.toLowerCase().includes(t)
    })
  const listaNov = novedades.filter((n) => (fEstado === 'todos' || n.estado === fEstado) && (!fEmp || n.empleado_id === fEmp))

  const NovFila = ({ n }: { n: Novedad }) => {
    const e = n.empleado_id ? empPorId.get(n.empleado_id) : null
    const dias = diasCorridos(n.fecha_desde, n.fecha_hasta)
    const s = e && n.tipo === 'vacaciones' ? saldoVacaciones(e, novedades, Number(n.fecha_desde.slice(0, 4))) : null
    return (
      <li className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Etiqueta tipo={n.tipo} />
            <span className="text-sm font-medium text-slate-900">{e ? nombreEmp(e) : 'Todo el personal'}</span>
            {n.titulo && n.tipo !== 'licencia' && <span className="text-sm text-slate-600">· {n.titulo}</span>}
          </div>
          <div className="mt-0.5 text-xs text-slate-500">
            {n.fecha_desde === n.fecha_hasta ? fmtFecha(n.fecha_desde) : `${fmtFecha(n.fecha_desde)} al ${fmtFecha(n.fecha_hasta)}`} · {dias} {dias === 1 ? 'día' : 'días'}
            {n.hora ? ` · ${n.hora}` : ''}
            {s && ` · saldo ${s.saldo}/${s.asignados}`}
            {n.observaciones && n.tipo !== 'licencia' ? ` · ${n.observaciones}` : ''}
          </div>
          {n.estado === 'rechazado' && n.motivo_rechazo && <div className="text-xs text-slate-500">Motivo: {n.motivo_rechazo}</div>}
        </div>
        <Badge tone={ESTADO_NOV[n.estado].tone}>{ESTADO_NOV[n.estado].label}</Badge>
        <div className="flex w-full flex-wrap justify-end gap-1.5 sm:w-auto">
          {esGerencia && n.estado === 'pendiente' && (
            <>
              <Button size="sm" variant="success" onClick={() => decidir(n, 'aprobado')}>
                Aprobar
              </Button>
              <Button size="sm" variant="secondary" onClick={() => decidir(n, 'rechazado')}>
                Rechazar
              </Button>
            </>
          )}
          {n.estado === 'rechazado' && (
            <Button size="sm" variant="secondary" onClick={() => decidir(n, 'pendiente')}>
              Volver a pedir
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setNovForm({ inicial: n })}>
            Editar
          </Button>
          {(n.estado !== 'aprobado' || esGerencia || n.tipo === 'reunion' || n.tipo === 'feriado') && (
            <Button size="sm" variant="ghost" onClick={() => borrar(n)}>
              Eliminar
            </Button>
          )}
        </div>
      </li>
    )
  }

  return (
    <>
      <PageHeader
        title="Personal"
        subtitle="Legajos, vacaciones, licencias, permisos y calendario anual. Administración carga; Gerencia aprueba."
        actions={
          <>
            <Button variant="secondary" onClick={() => setEmpForm('nuevo')}>
              + Empleado
            </Button>
            <Button onClick={() => setNovForm({})}>+ Novedad</Button>
          </>
        }
      />

      {msg && (
        <Alert tone={msg.tone} className="mb-4">
          {msg.text}
        </Alert>
      )}

      <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5">
          {(
            [
              ['resumen', 'Resumen'],
              ['personal', `Personal (${activos.length})`],
              ['novedades', `Novedades${pendientes.length ? ` · ${pendientes.length} por aprobar` : ''}`],
              ['calendario', 'Calendario anual'],
            ] as const
          ).map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} className={cx('rounded-md px-3 py-1.5 text-sm font-medium', tab === k ? 'bg-brand-700 text-white' : 'text-slate-600 hover:bg-slate-50')}>
              {l}
            </button>
          ))}
        </div>
        {(tab === 'personal' || tab === 'calendario') && (
          <div className="flex items-center gap-1">
            <Button variant="secondary" size="sm" onClick={() => setAnio(anio - 1)} aria-label="Año anterior">
              ‹
            </Button>
            <span className="w-14 text-center text-sm font-semibold tabular-nums">{anio}</span>
            <Button variant="secondary" size="sm" onClick={() => setAnio(anio + 1)} aria-label="Año siguiente">
              ›
            </Button>
          </div>
        )}
      </div>

      {tab === 'resumen' && (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Empleados activos" value={activos.length} sub={empleados.length > activos.length ? `${empleados.length - activos.length} de baja` : undefined} tone="brand" onClick={() => setTab('personal')} />
            <Stat label="Vacaciones y licencias pedidas" value={vacLicPend.length} sub="esperando aprobación" tone={vacLicPend.length ? 'amber' : 'slate'} onClick={() => { setFEstado('pendiente'); setTab('novedades') }} />
            <Stat label={`Cumpleaños de ${MESES[mesActual - 1].toLowerCase()}`} value={cumplesMes.length} tone="slate" />
            <Stat label="Permisos pendientes" value={permisosPend.length} tone={permisosPend.length ? 'amber' : 'slate'} onClick={() => { setFEstado('pendiente'); setTab('novedades') }} />
          </div>
          <div className="grid gap-5 lg:grid-cols-3">
            <Card title="Hoy no están" subtitle={fmtFecha(ref)} pad={false}>
              {ausentesHoy.length === 0 ? (
                <Empty>Hoy está todo el personal.</Empty>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {ausentesHoy.map((n) => (
                    <li key={n.id} className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm">
                      <span className="font-medium">{nombreEmp(empPorId.get(n.empleado_id!)!)}</span>
                      <span className="flex items-center gap-2">
                        <Etiqueta tipo={n.tipo} />
                        <span className="text-xs text-slate-500">hasta {fmtFecha(n.fecha_hasta)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Por aprobar" subtitle={esGerencia ? 'Aprobá o rechazá desde acá' : 'Las aprueba Gerencia'} pad={false}>
              {pendientes.length === 0 ? (
                <Empty>No hay novedades pendientes.</Empty>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {pendientes
                    .slice()
                    .sort((a, b) => a.fecha_desde.localeCompare(b.fecha_desde))
                    .map((n) => (
                      <NovFila key={n.id} n={n} />
                    ))}
                </ul>
              )}
            </Card>
            <Card title={`Cumpleaños de ${MESES[mesActual - 1].toLowerCase()}`} pad={false}>
              {cumplesMes.length === 0 ? (
                <Empty>Nadie cumple años este mes.</Empty>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {cumplesMes.map((e) => {
                    const f = cumpleDe(e.fecha_nacimiento!, Number(ref.slice(0, 4)))
                    return (
                      <li key={e.id} className={cx('flex items-center justify-between gap-2 px-4 py-2.5 text-sm', f === ref && 'bg-fuchsia-50')}>
                        <span>
                          <span className="font-medium">{nombreEmp(e)}</span>
                          <span className="ml-1 text-xs text-slate-500">{e.puesto}</span>
                        </span>
                        <span className="text-xs text-slate-600 tabular-nums">
                          {f === ref ? '🎂 hoy' : fmtFecha(f).slice(0, 5)} · cumple {edadEn(e.fecha_nacimiento!, f)}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </Card>
          </div>
          <Card title="Próximos 30 días" className="mt-5" pad={false}>
            {proximos.length === 0 ? (
              <Empty>No hay eventos en los próximos 30 días.</Empty>
            ) : (
              <ul className="divide-y divide-slate-100">
                {proximos.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <Etiqueta tipo={e.tipo} />
                      <span className="truncate">{e.titulo}</span>
                      {e.estado === 'pendiente' && <span className="text-xs text-amber-700">pendiente</span>}
                    </span>
                    <span className="text-xs text-slate-500 tabular-nums">
                      {e.desde === e.hasta ? fmtFecha(e.desde) : `${fmtFecha(e.desde)} al ${fmtFecha(e.hasta)}`}
                      {e.hora ? ` · ${e.hora}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      {tab === 'personal' && (
        <Card
          pad={false}
          title={`Legajos · vacaciones ${anio}`}
          subtitle="Los días asignados salen de la LCT según antigüedad, salvo que los cargues a mano en el legajo."
          actions={
            <>
              <label className="flex items-center gap-1.5 text-xs text-slate-600">
                <input id="ver-bajas" type="checkbox" className="h-3.5 w-3.5 accent-brand-700" checked={verBajas} onChange={(e) => setVerBajas(e.target.checked)} />
                Ver bajas
              </label>
              <input className={`${compactCls} w-56 max-w-full`} placeholder="Buscar nombre, puesto, CUIL…" value={q} onChange={(e) => setQ(e.target.value)} />
            </>
          }
        >
          {listaEmp.length === 0 ? (
            <Empty>{empleados.length ? 'Sin resultados.' : 'Todavía no hay empleados. Cargá el primero con "+ Empleado".'}</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th className={th}>Nombre y apellido</th>
                  <th className={th}>CUIL</th>
                  <th className={th}>Ingreso</th>
                  <th className={th}>Nacimiento</th>
                  <th className={th}>Emergencia</th>
                  <th className={`${th} text-right`}>Asignados</th>
                  <th className={`${th} text-right`}>Usados</th>
                  <th className={`${th} text-right`}>Saldo</th>
                </tr>
              </thead>
              <tbody>
                {listaEmp.map((e) => {
                  const s = saldoVacaciones(e, novedades, anio)
                  return (
                    <tr key={e.id} className={cx('cursor-pointer hover:bg-brand-50/40', !e.activo && 'opacity-60')} onClick={() => setEmpForm(e)}>
                      <td className={td}>
                        <div className="font-medium text-slate-900">
                          {e.apellido}, {e.nombre}
                          {!e.activo && <span className="ml-2 text-xs font-normal text-slate-500">baja {fmtFecha(e.fecha_baja)}</span>}
                        </div>
                        <div className="text-xs text-slate-500">{[e.puesto, e.area].filter(Boolean).join(' · ') || '—'}</div>
                      </td>
                      <td className={`${td} whitespace-nowrap tabular-nums`}>{fmtCuil(e.cuil)}</td>
                      <td className={`${td} whitespace-nowrap`}>
                        {fmtFecha(e.fecha_ingreso)}
                        <div className="text-xs text-slate-500">{antiguedad(e.fecha_ingreso, anio)} años al 31/12</div>
                      </td>
                      <td className={`${td} whitespace-nowrap`}>{e.fecha_nacimiento ? fmtFecha(e.fecha_nacimiento) : '—'}</td>
                      <td className={`${td} text-xs`}>
                        {e.emergencia_nombre ? (
                          <>
                            <div className="text-slate-800">
                              {e.emergencia_nombre}
                              {e.emergencia_vinculo ? ` (${e.emergencia_vinculo})` : ''}
                            </div>
                            <div className="text-slate-500">{e.emergencia_telefono}</div>
                          </>
                        ) : (
                          <span className="text-amber-700">Sin cargar</span>
                        )}
                      </td>
                      <td className={`${td} text-right tabular-nums`} title={s.regla}>
                        {s.asignados}
                        {s.manual && <span className="text-xs text-slate-400">*</span>}
                      </td>
                      <td className={`${td} text-right tabular-nums`}>
                        {s.usufructuados}
                        {s.solicitados > 0 && <div className="text-xs text-amber-700">+{s.solicitados} pedidos</div>}
                      </td>
                      <td className={cx(td, 'text-right font-semibold tabular-nums', s.saldo < 0 ? 'text-red-700' : s.saldo === 0 ? 'text-slate-400' : 'text-slate-900')}>{s.saldo}</td>
                    </tr>
                  )
                })}
              </tbody>
            </Table>
          )}
          <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
            Días corridos según LCT art. 150: hasta 5 años de antigüedad 14 · de 5 a 10: 21 · de 10 a 20: 28 · más de 20: 35. * = cargado a mano.
          </p>
        </Card>
      )}

      {tab === 'novedades' && (
        <Card
          pad={false}
          title={
            <div className="flex flex-wrap gap-1.5">
              {(['todos', 'pendiente', 'aprobado', 'rechazado'] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => setFEstado(k)}
                  className={cx('rounded-full border px-3 py-1 text-xs font-medium', fEstado === k ? 'border-brand-700 bg-brand-700 text-white' : 'border-slate-300 text-slate-600 hover:border-brand-400')}
                >
                  {k === 'todos' ? 'Todas' : `${ESTADO_NOV[k].label}s`}
                  {k === 'pendiente' && pendientes.length > 0 && <span className="ml-1 opacity-75">{pendientes.length}</span>}
                </button>
              ))}
            </div>
          }
          actions={
            <select className={`${compactCls} w-56 max-w-full`} value={fEmp} onChange={(e) => setFEmp(e.target.value)} aria-label="Filtrar por empleado">
              <option value="">Todos los empleados</option>
              {empleados.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.apellido}, {e.nombre}
                </option>
              ))}
            </select>
          }
        >
          {listaNov.length === 0 ? (
            <Empty>No hay novedades en esta vista.</Empty>
          ) : (
            <ul className="divide-y divide-slate-100">
              {listaNov.map((n) => (
                <NovFila key={n.id} n={n} />
              ))}
            </ul>
          )}
        </Card>
      )}

      {tab === 'calendario' && (
        <>
          <Card className="mb-4">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
              <select className={`${compactCls} w-56 max-w-full`} value={fEmp} onChange={(e) => setFEmp(e.target.value)} aria-label="Filtrar por empleado">
                <option value="">Todo el personal</option>
                {activos.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.apellido}, {e.nombre}
                  </option>
                ))}
              </select>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Tipos de evento">
                {TIPOS_FILTRO.map((t) => {
                  const on = fTipos.has(t)
                  return (
                    <button
                      key={t}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setFTipos((s) => { const n = new Set(s); if (on) n.delete(t); else n.add(t); return n })}
                      className={cx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition', on ? 'bg-white text-slate-800' : 'border-dashed bg-slate-50 text-slate-400 line-through')}
                      style={on ? { borderColor: TIPOS[t].color } : undefined}
                    >
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: on ? TIPOS[t].color : '#cbd5e1' }} aria-hidden />
                      {TIPOS[t].label}
                    </button>
                  )
                })}
              </div>
              <label className="flex items-center gap-1.5 text-sm text-slate-600">
                <input id="cal-pend" type="checkbox" className="h-4 w-4 accent-brand-700" checked={conPendientes} onChange={(e) => setConPendientes(e.target.checked)} />
                Mostrar pendientes
              </label>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
              <span className="text-sm font-medium text-slate-700">Exportar</span>
              <select
                className={`${compactCls} max-w-full`}
                aria-label="Período a exportar"
                value={periodo.tipo === 'anio' ? 'anio' : periodo.tipo === 'trimestre' ? `t${periodo.q}` : periodo.tipo === 'mes' ? `m${periodo.m}` : 'semana'}
                onChange={(e) => {
                  const v = e.target.value
                  setPeriodo(
                    v === 'anio'
                      ? { tipo: 'anio' }
                      : v === 'semana'
                        ? { tipo: 'semana', desde: lunesDe(diaSel && diaSel.startsWith(String(anio)) ? diaSel : ref.startsWith(String(anio)) ? ref : `${anio}-01-05`) }
                        : v[0] === 't'
                          ? { tipo: 'trimestre', q: Number(v.slice(1)) }
                          : { tipo: 'mes', m: Number(v.slice(1)) },
                  )
                }}
              >
                <option value="anio">Año completo {anio}</option>
                <option value="semana">Una semana…</option>
                {[0, 1, 2, 3].map((qq) => (
                  <option key={qq} value={`t${qq}`}>
                    {qq + 1}° trimestre
                  </option>
                ))}
                {MESES.map((m, i) => (
                  <option key={m} value={`m${i}`}>
                    {m}
                  </option>
                ))}
              </select>
              {periodo.tipo === 'semana' && (
                <span className="flex items-center gap-1">
                  <Button size="sm" variant="secondary" onClick={() => setPeriodo({ tipo: 'semana', desde: sumarDias(periodo.desde, -7) })} aria-label="Semana anterior">
                    ‹
                  </Button>
                  <input
                    id="exp-semana"
                    type="date"
                    className={`${compactCls} w-40`}
                    aria-label="Cualquier día de la semana a exportar"
                    value={periodo.desde}
                    onChange={(e) => e.target.value && setPeriodo({ tipo: 'semana', desde: lunesDe(e.target.value) })}
                  />
                  <Button size="sm" variant="secondary" onClick={() => setPeriodo({ tipo: 'semana', desde: sumarDias(periodo.desde, 7) })} aria-label="Semana siguiente">
                    ›
                  </Button>
                  <span className="whitespace-nowrap text-xs text-slate-600">
                    {fmtFecha(periodo.desde).slice(0, 5)} al {fmtFecha(sumarDias(periodo.desde, 6))}
                  </span>
                </span>
              )}
              <Button size="sm" onClick={() => exportar('pdf')} disabled={!!exportando}>
                {exportando === 'pdf' ? 'Generando…' : 'PDF'}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => exportar('png')} disabled={!!exportando}>
                Imagen PNG
              </Button>
              <span className="mx-1 h-5 w-px bg-slate-200" aria-hidden />
              <Button size="sm" variant="secondary" onClick={() => exportar('ics')} disabled={!!exportando} title="Para importar en Google Calendar, Outlook o el celular">
                iCal (.ics)
              </Button>
              <Button size="sm" variant="secondary" onClick={() => exportar('xlsx')} disabled={!!exportando} title="Vacaciones por empleado, eventos, legajos y feriados">
                Excel
              </Button>
              <Button size="sm" variant="ghost" onClick={() => exportar('csv-vacaciones')} disabled={!!exportando}>
                CSV vacaciones
              </Button>
              <Button size="sm" variant="ghost" onClick={() => exportar('csv-eventos')} disabled={!!exportando}>
                CSV eventos
              </Button>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Se exporta: {nombrePeriodo(periodo, anio)} con los filtros actuales (PDF, imagen, iCal, Excel y CSV de eventos). iCal: en Google Calendar → Configuración → Importar. Para que se actualice solo, ver
              “Suscripción” en el README.
            </p>
          </Card>

          <div className="grid gap-5 xl:grid-cols-4">
            <div className="min-w-0 xl:col-span-3">
              <CalendarioAnual anio={anio} porDia={porDia} seleccionado={diaSel} onDia={setDiaSel} />
            </div>
            <div className="min-w-0">
              <Card
                className="xl:sticky xl:top-6"
                pad={false}
                title={diaSel ? fmtFecha(diaSel) : 'Elegí un día'}
                actions={
                  diaSel && (
                    <Button size="sm" variant="secondary" onClick={() => setNovForm({ preset: { fecha: diaSel, empleado_id: fEmp || undefined } })}>
                      + Novedad
                    </Button>
                  )
                }
              >
                {diaSel ? <ListaEventosDia fecha={diaSel} eventos={porDia.get(diaSel) ?? []} /> : <Empty>Tocá un día del calendario.</Empty>}
                {diaSel && (
                  <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-4 py-3">
                    <span className="text-xs text-slate-500">
                      Semana {numeroSemana(diaSel)} ({fmtFecha(lunesDe(diaSel)).slice(0, 5)} al {fmtFecha(sumarDias(lunesDe(diaSel), 6)).slice(0, 5)}):
                    </span>
                    <Button size="sm" onClick={() => exportar('pdf', { tipo: 'semana', desde: lunesDe(diaSel) })} disabled={!!exportando}>
                      Descargar PDF
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => exportar('png', { tipo: 'semana', desde: lunesDe(diaSel) })} disabled={!!exportando}>
                      Imagen
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setPeriodo({ tipo: 'semana', desde: lunesDe(diaSel) })}>
                      Más formatos
                    </Button>
                  </div>
                )}
              </Card>
              <Card title="Referencias" className="mt-4">
                <ul className="space-y-1.5 text-sm">
                  {TIPOS_FILTRO.map((t) => (
                    <li key={t} className="flex items-center justify-between">
                      <Etiqueta tipo={t} />
                      <span className="tabular-nums text-xs text-slate-500">{eventosFiltrados.filter((e) => (e.tipo === 'feriado' ? 'feriado_nac' : e.tipo) === t).length}</span>
                    </li>
                  ))}
                  <li className="pt-1 text-xs text-slate-500">Punto hueco = pendiente de aprobación. Día subrayado = hoy.</li>
                </ul>
              </Card>
            </div>
          </div>
        </>
      )}

      <Modal open={!!empForm} onClose={() => setEmpForm(null)} title={empForm === 'nuevo' ? 'Alta de empleado' : 'Legajo'} wide>
        {empForm && (
          <EmpleadoForm
            inicial={empForm === 'nuevo' ? undefined : empForm}
            onCancel={() => setEmpForm(null)}
            onSaved={(t) => {
              setEmpForm(null)
              setMsg({ tone: 'green', text: t })
              cargar()
            }}
          />
        )}
      </Modal>
      <Modal open={!!novForm} onClose={() => setNovForm(null)} title={novForm?.inicial ? 'Editar novedad' : 'Nueva novedad'}>
        {novForm && (
          <NovedadForm
            empleados={empleados}
            novedades={novedades}
            inicial={novForm.inicial}
            preset={novForm.preset}
            onCancel={() => setNovForm(null)}
            onSaved={(t) => {
              setNovForm(null)
              setMsg({ tone: 'green', text: t })
              cargar()
            }}
          />
        )}
      </Modal>
    </>
  )
}

