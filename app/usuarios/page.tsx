'use client'

import { useCallback, useEffect, useState } from 'react'
import { sb, errMsg } from '@/lib/supabase'
import type { Perfil, Rol } from '@/lib/types'
import { fmtFechaHora } from '@/lib/utils'
import { useAuth } from '@/components/AuthProvider'
import { Alert, Badge, Empty, PageHeader, Spinner, Table, Card, compactCls, td, th } from '@/components/ui'
import { PermisosSecciones } from '@/components/PermisosSecciones'

type Fila = Perfil & { created_at: string }

const ROLES: { rol: Rol; label: string; detalle: string }[] = [
  { rol: 'pendiente', label: 'Pendiente (sin acceso)', detalle: 'No ve nada hasta que le asignes un rol' },
  { rol: 'ventas', label: 'Ventas', detalle: 'Por defecto, Clientes (consulta, alta y edición; no valida ni ve saldos), Hoja de ruta (arma, edita y marca entregas) y Catálogo. Le podés sumar Resumen (el tablero de Inicio), Cuentas a cobrar y el Reporte de los lunes en "Permisos por sección" (solo consulta y anota gestiones)' },
  { rol: 'administracion', label: 'Administración', detalle: 'Carga y gestiona todo (menos Usuarios); no autoriza pagos ni aprueba novedades. Podés limitarle las secciones en "Permisos por sección"' },
  { rol: 'gerencia', label: 'Gerencia', detalle: 'Todo, siempre (no se le pueden quitar secciones), más autorizar, aprobar y ver auditoría' },
]

export default function UsuariosPage() {
  const { esGerencia, perfil } = useAuth()
  const [usuarios, setUsuarios] = useState<Fila[] | null>(null)
  const [msg, setMsg] = useState<{ tone: 'green' | 'red'; text: string } | null>(null)

  const cargar = useCallback(async () => {
    const { data } = await sb().from('perfiles').select('*').order('created_at', { ascending: false })
    setUsuarios((data as Fila[]) ?? [])
  }, [])

  useEffect(() => {
    if (esGerencia) cargar()
  }, [esGerencia, cargar])

  if (!esGerencia) return <Empty>La administración de usuarios es exclusiva de Gerencia.</Empty>
  if (!usuarios) return <Spinner />

  const pendientes = usuarios.filter((u) => u.rol === 'pendiente')

  async function cambiar(u: Fila, rol: Rol) {
    setMsg(null)
    const { error } = await sb().from('perfiles').update({ rol }).eq('id', u.id)
    if (error) return setMsg({ tone: 'red', text: errMsg(error) })
    const label = ROLES.find((r) => r.rol === rol)?.label
    const extra =
      u.secciones && rol !== 'gerencia'
        ? ' Conserva sus permisos por sección personalizados (abajo); las secciones que no van con el rol nuevo quedan sin efecto. Si querés que use los del rol, tocá "Usar los del rol".'
        : ''
    setMsg({ tone: 'green', text: `${u.nombre || u.email}: ahora es ${label}.${extra}` })
    cargar()
  }

  return (
    <>
      <PageHeader title="Usuarios" subtitle="Quién entra a la app y qué puede hacer. Cada persona se registra sola desde la pantalla de ingreso; vos le das el acceso." />
      {msg && (
        <Alert tone={msg.tone} className="mb-4">
          {msg.text}
        </Alert>
      )}
      {pendientes.length > 0 && (
        <Alert tone="amber" className="mb-4">
          {pendientes.length === 1 ? 'Hay 1 persona esperando' : `Hay ${pendientes.length} personas esperando`} que le des acceso. Elegí su rol en la tabla.
        </Alert>
      )}
      <Card pad={false}>
        <Table>
          <thead>
            <tr>
              <th className={th}>Usuario</th>
              <th className={th}>Se registró</th>
              <th className={th}>Rol</th>
            </tr>
          </thead>
          <tbody>
            {usuarios.map((u) => (
              <tr key={u.id} className={u.rol === 'pendiente' ? 'bg-amber-50/60' : ''}>
                <td className={td}>
                  <div className="font-medium text-slate-900">
                    {u.nombre || '—'}
                    {u.id === perfil?.id && <span className="ml-2 text-xs font-normal text-slate-500">(vos)</span>}
                  </div>
                  <div className="text-xs text-slate-500">{u.email}</div>
                </td>
                <td className={`${td} whitespace-nowrap text-xs text-slate-500`}>{fmtFechaHora(u.created_at)}</td>
                <td className={td}>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      className={`${compactCls} w-56 max-w-full`}
                      value={u.rol}
                      onChange={(e) => cambiar(u, e.target.value as Rol)}
                      aria-label={`Rol de ${u.nombre || u.email}`}
                    >
                      {ROLES.map((r) => (
                        <option key={r.rol} value={r.rol}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                    {u.rol === 'pendiente' && <Badge tone="amber">Esperando acceso</Badge>}
                    {u.secciones && u.rol !== 'gerencia' && (
                      <span title="Si le cambiás el rol, conserva estas secciones elegidas a mano">
                        <Badge tone="blue">Secciones personalizadas</Badge>
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      <div className="mt-5">
        <PermisosSecciones usuarios={usuarios} yo={perfil?.id} onGuardado={(nu) => setUsuarios((us) => us?.map((x) => (x.id === nu.id ? { ...x, secciones: nu.secciones } : x)) ?? null)} />
      </div>
      <Card title="Qué puede hacer cada rol" className="mt-5">
        <ul className="space-y-1.5 text-sm">
          {ROLES.map((r) => (
            <li key={r.rol}>
              <b>{r.label}:</b> <span className="text-slate-600">{r.detalle}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-slate-500">Para sacarle el acceso a alguien, pasalo a &quot;Pendiente&quot;. Siempre tiene que quedar al menos un usuario de Gerencia. Cambiar el rol no borra los permisos por sección personalizados.</p>
      </Card>
    </>
  )
}
