'use client'

import { Fragment, useState } from 'react'
import { sb, errMsg } from '@/lib/supabase'
import type { Perfil, Rol } from '@/lib/types'
import { POR_ROL, SECCIONES, SOLO_GERENCIA, TODAS, posiblesDelRol, seccionesEfectivas, type Grupo, type Seccion } from '@/lib/permisos'
import { Alert, Badge, Card, cx } from './ui'

type Fila = Pick<Perfil, 'id' | 'nombre' | 'email' | 'rol' | 'secciones'>

const ROL_CORTO: Record<Rol, string> = { pendiente: 'Pendiente', ventas: 'Ventas', administracion: 'Administración', gerencia: 'Gerencia' }

const GRUPOS: { grupo: Grupo; secciones: typeof SECCIONES }[] = (['General', 'Tesorería', 'Sistema'] as Grupo[]).map((g) => ({
  grupo: g,
  secciones: SECCIONES.filter((s) => s.grupo === g),
}))

const LABEL: Record<Seccion, string> = Object.fromEntries(SECCIONES.map((s) => [s.seccion, s.label])) as Record<Seccion, string>

/** Ordena como el menú y saca repetidos. */
function ordenar(lista: string[]): string[] {
  const set = new Set(lista)
  const conocidas = TODAS.filter((s) => set.has(s))
  const otras = Array.from(set).filter((s) => !(TODAS as string[]).includes(s))
  return [...conocidas, ...otras]
}

/** Por qué una casilla no se puede tocar (null = se puede). */
function bloqueo(rol: Rol, s: Seccion): string | null {
  if (rol === 'gerencia') return 'Gerencia ve todo siempre'
  if (rol === 'pendiente') return 'Primero asignale un rol'
  if (SOLO_GERENCIA.includes(s)) return 'Usuarios es solo de Gerencia'
  if (!posiblesDelRol(rol).includes(s)) return 'Para esta sección pasalo a Administración y elegí qué ve'
  return null
}

/**
 * Grilla de permisos por sección: una fila por usuario, una casilla por sección del menú.
 * Cada cambio se guarda al instante en perfiles.secciones (null = "los del rol").
 */
export function PermisosSecciones({
  usuarios,
  yo,
  onGuardado,
  demo = false,
}: {
  usuarios: Fila[]
  yo?: string
  onGuardado?: (u: Fila) => void
  /** Vista previa sin base de datos (no guarda). */
  demo?: boolean
}) {
  const [filas, setFilas] = useState<Fila[]>(usuarios)
  const [prevUsuarios, setPrevUsuarios] = useState(usuarios)
  const [guardando, setGuardando] = useState<string | null>(null)
  const [ok, setOk] = useState<{ id: string; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Si el padre recarga (por ejemplo, cambió un rol), tomamos los datos nuevos
  if (usuarios !== prevUsuarios) {
    setPrevUsuarios(usuarios)
    setFilas(usuarios)
  }

  async function guardar(u: Fila, secciones: string[] | null, aviso: string) {
    setError(null)
    setOk(null)
    const antes = filas
    const nueva = { ...u, secciones: secciones === null ? null : ordenar(secciones) }
    setFilas((fs) => fs.map((f) => (f.id === u.id ? nueva : f)))
    if (demo) {
      setOk({ id: u.id, text: aviso })
      return
    }
    setGuardando(u.id)
    const { error: e } = await sb().from('perfiles').update({ secciones: nueva.secciones }).eq('id', u.id)
    setGuardando(null)
    if (e) {
      setFilas(antes)
      setError(`${u.nombre || u.email}: no se pudo guardar. ${errMsg(e)}`)
      return
    }
    setOk({ id: u.id, text: aviso })
    onGuardado?.(nueva)
  }

  function lista(u: Fila): string[] {
    return u.secciones ?? (POR_ROL[u.rol] as string[])
  }

  function alternar(u: Fila, s: Seccion, marcar: boolean) {
    const base = lista(u).filter((x) => x !== s)
    guardar(u, marcar ? [...base, s] : base, `${quien(u)}: ${marcar ? 'ahora ve' : 'ya no ve'} ${LABEL[s]}. Guardado.`)
  }

  const quien = (u: Fila) => u.nombre || u.email || 'Usuario'

  return (
    <Card
      title="Permisos por sección"
      subtitle="Marcá qué secciones del menú ve cada usuario. Se guarda solo, al instante. Lo que no ve, tampoco lo puede consultar por otro lado."
      pad={false}
    >
      {(error || ok) && (
        <div className="border-b border-slate-100 px-4 py-3">
          {error ? <Alert tone="red">{error}</Alert> : <Alert tone="green">✓ {ok!.text}</Alert>}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 text-left text-sm">
          <thead>
            <tr>
              <th rowSpan={2} className="sticky left-0 z-10 min-w-[16rem] border-b border-slate-200 bg-slate-50 px-3 py-2 align-bottom text-xs font-medium uppercase tracking-wide text-slate-500">
                Usuario
              </th>
              {GRUPOS.map((g) => (
                <th
                  key={g.grupo}
                  colSpan={g.secciones.length}
                  className="border-b border-l border-slate-200 bg-slate-50 px-2 py-1.5 text-center text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500"
                >
                  {g.grupo}
                </th>
              ))}
            </tr>
            <tr>
              {GRUPOS.map((g) =>
                g.secciones.map((s, i) => (
                  <th key={s.seccion} className={cx('h-36 w-9 border-b border-slate-200 bg-slate-50 px-1 pb-2 align-bottom', i === 0 && 'border-l')}>
                    <span className="mx-auto block rotate-180 whitespace-nowrap text-xs font-medium text-slate-600 [writing-mode:vertical-rl]">{s.label}</span>
                  </th>
                )),
              )}
            </tr>
          </thead>
          <tbody>
            {filas.map((u) => {
              const ver = seccionesEfectivas(u)
              const bloqueada = u.rol === 'gerencia' || u.rol === 'pendiente'
              const posibles = posiblesDelRol(u.rol).filter((s) => !SOLO_GERENCIA.includes(s))
              const fuera = (u.secciones ?? []).filter((s) => !(posibles as string[]).includes(s) && !SOLO_GERENCIA.includes(s as Seccion))
              return (
                <tr key={u.id} className={cx('group', bloqueada ? 'bg-slate-50/70' : 'hover:bg-brand-50/30')}>
                  <td className={cx('sticky left-0 z-10 border-b border-slate-100 px-3 py-2.5 align-top', bloqueada ? 'bg-slate-50' : 'bg-white group-hover:bg-brand-50')}>
                    <div className="font-medium text-slate-900">
                      {quien(u)}
                      {u.id === yo && <span className="ml-1.5 text-xs font-normal text-slate-500">(vos)</span>}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                      <span>{ROL_CORTO[u.rol]}</span>
                      {u.rol === 'gerencia' ? (
                        <Badge tone="brand">🔒 Ve todo</Badge>
                      ) : u.rol === 'pendiente' ? (
                        <Badge tone="amber">Sin acceso</Badge>
                      ) : u.secciones ? (
                        <Badge tone="blue">Personalizado</Badge>
                      ) : (
                        <Badge>Los del rol</Badge>
                      )}
                      {guardando === u.id && <span className="text-slate-400">Guardando…</span>}
                      {ok?.id === u.id && guardando !== u.id && <span className="text-emerald-600">✓ Guardado</span>}
                    </div>
                    {!bloqueada && (
                      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                        <button
                          className="font-medium text-brand-700 hover:underline disabled:opacity-40"
                          disabled={guardando === u.id}
                          onClick={() => guardar(u, [...posibles, ...fuera], `${quien(u)}: ahora ve todas las secciones de su rol. Guardado.`)}
                        >
                          Todas
                        </button>
                        <button
                          className="font-medium text-brand-700 hover:underline disabled:opacity-40"
                          disabled={guardando === u.id}
                          onClick={() => guardar(u, fuera, `${quien(u)}: no ve ninguna sección. Guardado.`)}
                        >
                          Ninguna
                        </button>
                        <button
                          className="font-medium text-brand-700 hover:underline disabled:opacity-40"
                          disabled={guardando === u.id || u.secciones == null}
                          title="Vuelve a lo que trae su rol"
                          onClick={() => guardar(u, null, `${quien(u)}: vuelve a usar los permisos de ${ROL_CORTO[u.rol]}. Guardado.`)}
                        >
                          Usar los del rol
                        </button>
                      </div>
                    )}
                    {u.rol === 'pendiente' && u.secciones && <div className="mt-1 text-xs text-slate-500">Tiene secciones guardadas: se aplican cuando le asignes un rol.</div>}
                  </td>
                  {GRUPOS.map((g) =>
                    g.secciones.map((s, i) => {
                      const motivo = bloqueo(u.rol, s.seccion)
                      const marcada = ver.has(s.seccion)
                      return (
                        <td key={s.seccion} className={cx('border-b border-slate-100 px-1 py-2.5 text-center align-middle', i === 0 && 'border-l border-l-slate-200')} title={motivo ?? s.label}>
                          <input
                            type="checkbox"
                            className={cx('h-4 w-4 rounded border-slate-300 accent-brand-700', motivo ? 'cursor-not-allowed opacity-50' : 'cursor-pointer')}
                            checked={marcada}
                            disabled={!!motivo || guardando === u.id}
                            onChange={(e) => alternar(u, s.seccion, e.target.checked)}
                            aria-label={`${quien(u)} ve ${s.label}`}
                          />
                        </td>
                      )
                    }),
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="space-y-1 border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
        <p>
          <b>Los del rol</b>: si nunca le tocaste las casillas, ve lo que trae su rol (Ventas: Clientes, Hoja de ruta y Catálogo; Administración: todo menos Usuarios). Apenas marcás o
          desmarcás algo, pasa a <b>Personalizado</b>. Con <b>Usar los del rol</b> vuelve a lo de antes.
        </p>
        <p>
          <b>Gerencia</b> ve todo siempre (incluido Usuarios), así nunca te quedás afuera. A <b>Ventas</b> le podés habilitar Resumen (el tablero), Cuentas a cobrar y el Reporte de los lunes (solo para
          consultar y anotar gestiones); para Tesorería, Personal o Respaldo pasalo a Administración y elegí qué secciones ve.
        </p>
        <p>Si le cambiás el rol a alguien, conserva sus secciones personalizadas; las que no van con el rol nuevo quedan guardadas pero sin efecto.</p>
      </div>
    </Card>
  )
}
