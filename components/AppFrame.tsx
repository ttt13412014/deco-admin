'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { ReactNode, useEffect, useState } from 'react'
import { useAuth } from './AuthProvider'
import { cx, Spinner } from './ui'
import { IconoGrilla } from './AppLauncher'
import { LANZADOR, menuDe, rutaPermitida } from '@/lib/permisos'

export const ROL_LABEL = { administracion: 'Administración', ventas: 'Ventas', gerencia: 'Gerencia', pendiente: 'Sin acceso' } as const

export function AppFrame({ children }: { children: ReactNode }) {
  const { session, perfil, loading, signOut } = useAuth()
  const pathname = usePathname()
  const router = useRouter()
  const [menu, setMenu] = useState(false)
  const esLogin = pathname === '/login'
  // Pantalla del chofer: entra con el link secreto de la hoja, sin usuario
  const esChofer = pathname.startsWith('/chofer/')

  useEffect(() => {
    if (!loading && !session && !esLogin && !esChofer) router.replace('/login')
  }, [loading, session, esLogin, esChofer, router])

  useEffect(() => setMenu(false), [pathname])

  // Cada uno ve solo sus secciones (rol + Usuarios → Permisos por sección).
  // '/' es el lanzador de íconos (app/page.tsx), que muestra solo esas secciones.
  const permitida = rutaPermitida(perfil, pathname)

  if (esLogin || esChofer) return <>{children}</>
  if (loading || !session) return <Spinner />

  // Se registró pero Gerencia todavía no le dio acceso
  if (!perfil || perfil.rol === 'pendiente') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-brand-950 px-4">
        <div className="w-full max-w-sm rounded-xl bg-white p-6 text-center shadow-xl">
          <div className="text-2xl font-bold text-slate-900">DE&amp;CO</div>
          <h1 className="mt-4 text-lg font-semibold text-slate-900">Tu cuenta está esperando acceso</h1>
          <p className="mt-2 text-sm text-slate-600">
            Ya estás registrado como <b>{session.user.email}</b>. Pedile a Gerencia que entre en <b>Usuarios</b> y te asigne un rol. Después volvé a ingresar.
          </p>
          <div className="mt-5 flex justify-center gap-2">
            <button onClick={() => window.location.reload()} className="rounded-lg border border-slate-300 px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
              Ya me dieron acceso
            </button>
            <button onClick={signOut} className="rounded-lg bg-brand-700 px-3.5 py-2 text-sm font-medium text-white hover:bg-brand-800">
              Cerrar sesión
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Lanzador: pantalla completa, sin barra lateral (como Odoo); trae su propia barra superior
  if (pathname === LANZADOR) return <>{children}</>

  const activo = (href: string) =>
    href === '/' ? pathname === '/' : pathname === href || (pathname.startsWith(href + '/') && href !== '/cobranzas' && href !== '/tesoreria')
  const nav = menuDe(perfil)
  const atajos = nav.slice(0, 3)

  return (
    <div className="min-h-screen lg:flex">
      {/* Barra superior mobile */}
      <div className="sticky top-0 z-30 flex items-center justify-between border-b print:hidden border-brand-900 bg-brand-950 px-4 py-3 text-white lg:hidden">
        <div className="flex items-center gap-3">
          <Link href={LANZADOR} aria-label="Inicio: todas las secciones" title="Inicio: todas las secciones" className="rounded-md p-1.5 text-brand-200 ring-1 ring-white/20 hover:bg-white/10 hover:text-white">
            <IconoGrilla />
          </Link>
          <Link href={LANZADOR}><Logo /></Link>
        </div>
        <button onClick={() => setMenu((m) => !m)} className="rounded-md px-2 py-1 text-sm ring-1 ring-white/20">
          {menu ? 'Cerrar' : 'Menú'}
        </button>
      </div>

      <aside
        className={cx(
          'z-20 flex-col bg-brand-950 text-brand-100 lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-60 lg:shrink-0',
          menu ? 'flex' : 'hidden',
        )}
      >
        <div className="hidden items-center justify-between px-5 py-5 lg:flex">
          <Link href={LANZADOR}><Logo /></Link>
          <Link href={LANZADOR} aria-label="Inicio: todas las secciones" title="Inicio: todas las secciones" className="rounded-md p-1.5 text-brand-300 ring-1 ring-white/15 hover:bg-white/10 hover:text-white">
            <IconoGrilla />
          </Link>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-3 lg:py-0">
          <Link href={LANZADOR} className="mb-1 flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-brand-200 transition hover:bg-white/5 hover:text-white">
            <span className="flex w-4 justify-center text-brand-400"><IconoGrilla className="h-3.5 w-3.5" /></span>
            <span className="flex-1">Inicio</span>
          </Link>
          {nav.map((n, i) => (
            <div key={n.href}>
            {n.grupo !== 'General' && n.grupo !== nav[i - 1]?.grupo && (
              <div className="px-3 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-[0.18em] text-brand-400">{n.grupo}</div>
            )}
            <Link
              href={n.href}
              className={cx(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition',
                activo(n.href) ? 'bg-white/10 font-medium text-white' : 'text-brand-200 hover:bg-white/5 hover:text-white',
              )}
            >
              <span className="w-4 text-center text-brand-400">{n.icon}</span>
              <span className="flex-1">{n.label}</span>
              {n.code && <span className="text-[10px] tracking-wider text-brand-400">{n.code}</span>}
            </Link>
            </div>
          ))}
        </nav>
        <div className="border-t border-white/10 px-5 py-4 text-sm">
          <div className="font-medium text-white">{perfil?.nombre || session.user.email}</div>
          <div className="text-xs text-brand-300">{perfil ? ROL_LABEL[perfil.rol] : '—'}</div>
          <button onClick={signOut} className="mt-2 text-xs text-brand-300 underline-offset-2 hover:text-white hover:underline">
            Cerrar sesión
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-6xl">
          {permitida ? (
            children
          ) : (
            <div className="mx-auto mt-10 max-w-md rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm">
              <h1 className="text-lg font-semibold text-slate-900">No tenés acceso a esta sección</h1>
              <p className="mt-2 text-sm text-slate-600">
                {atajos.length
                  ? 'Gerencia elige qué secciones ve cada usuario (en Usuarios → Permisos por sección). Estas son las tuyas:'
                  : 'Todavía no tenés ninguna sección habilitada. Pedile a Gerencia que te las habilite en Usuarios → Permisos por sección.'}
              </p>
              {atajos.length > 0 && (
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  {atajos.map((n, i) => (
                    <Link
                      key={n.href}
                      href={n.href}
                      className={
                        i === 0
                          ? 'rounded-lg bg-brand-700 px-3.5 py-2 text-sm font-medium text-white hover:bg-brand-800'
                          : 'rounded-lg border border-slate-300 px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50'
                      }
                    >
                      {n.label}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}

function Logo() {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-lg font-bold tracking-tight text-white">DE&amp;CO</span>
      <span className="text-xs uppercase tracking-[0.2em] text-brand-400">Admin</span>
    </div>
  )
}
