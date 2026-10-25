'use client'

/**
 * Lanzador de íconos estilo Odoo: la pantalla de inicio después del login ('/').
 * Una grilla de tarjetas blancas con un ícono plano de colores y el nombre de la
 * sección abajo, sobre un fondo lavanda. Muestra SOLO las secciones que recibe
 * (AppFrame/app/page.tsx le pasan menuDe(perfil): rol + Usuarios → Permisos por sección).
 */

import Link from 'next/link'
import type { ReactNode } from 'react'
import type { ItemMenu, Seccion } from '@/lib/permisos'

// Paleta DE&CO + acentos
const T = '#0097b2' // teal DE&CO
const G = '#545454' // gris DE&CO
const V = '#56bb44' // verde DE&CO
const P = '#7c4d9e' // violeta
const O = '#f7931e' // naranja
const R = '#ec5b7f' // rosa
const Y = '#fbbf24' // amarillo
const A = '#4fd1c5' // aguamarina

const ICONOS: Record<Seccion, ReactNode> = {
  inicio: (
    <>
      <rect x="4" y="6" width="40" height="36" rx="5" fill={T} />
      <rect x="9" y="12" width="13" height="11" rx="2.5" fill="#fff" opacity=".9" />
      <rect x="26" y="12" width="13" height="5" rx="2" fill={Y} />
      <rect x="26" y="19" width="9" height="4" rx="2" fill="#fff" opacity=".6" />
      <rect x="9" y="28" width="5" height="9" rx="1.5" fill={V} />
      <rect x="16.5" y="31" width="5" height="6" rx="1.5" fill={O} />
      <rect x="26" y="27" width="13" height="10" rx="2.5" fill={P} />
      <path d="M12 20.5l3-3.5 2.5 2 3-4" stroke={T} strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  clientes: (
    <>
      <circle cx="31" cy="15" r="7" fill={T} />
      <path d="M19 40c0-8 5.5-13 12-13s12 5 12 13z" fill={T} />
      <circle cx="18" cy="18" r="8" fill={P} />
      <path d="M4 42c0-9 6.3-14.5 14-14.5S32 33 32 42z" fill={P} opacity=".92" />
    </>
  ),
  cobranzas: (
    <>
      <rect x="4" y="12" width="32" height="22" rx="4" fill={V} />
      <circle cx="20" cy="23" r="5.5" fill="#fff" opacity=".55" />
      <circle cx="33" cy="31" r="11" fill={Y} />
      <path d="M33 24.5v13M36.2 27.4c-.7-1-1.9-1.5-3.2-1.5-1.8 0-3 .9-3 2.2 0 3.2 6.4 1.6 6.4 4.8 0 1.4-1.4 2.3-3.4 2.3-1.4 0-2.7-.6-3.4-1.6" stroke={G} strokeWidth="2" fill="none" strokeLinecap="round" />
    </>
  ),
  reporte: (
    <>
      <rect x="8" y="5" width="28" height="38" rx="4" fill={P} />
      <rect x="14" y="26" width="5" height="11" rx="1.5" fill={Y} />
      <rect x="21.5" y="19" width="5" height="18" rx="1.5" fill={A} />
      <rect x="29" y="12" width="5" height="25" rx="1.5" fill={O} opacity=".95" />
      <rect x="13" y="10" width="11" height="3" rx="1.5" fill="#fff" opacity=".6" />
    </>
  ),
  rutas: (
    <>
      <path d="M9 38c8-9 17 1 22-8 3-5-1-8 3-13" stroke={T} strokeWidth="5" fill="none" strokeLinecap="round" opacity=".85" />
      <circle cx="9" cy="38" r="5.5" fill={V} />
      <circle cx="9" cy="38" r="2.2" fill="#fff" />
      <path d="M34 3c-5.5 0-10 4.3-10 9.6C24 19.5 34 29 34 29s10-9.5 10-16.4C44 7.3 39.5 3 34 3z" fill={R} />
      <circle cx="34" cy="12.5" r="3.8" fill="#fff" />
    </>
  ),
  catalogo: (
    <>
      <path d="M4 10c6-2 13-2 20 2v30c-7-4-14-4-20-2z" fill={O} />
      <path d="M44 10c-6-2-13-2-20 2v30c7-4 14-4 20-2z" fill={T} />
      <path d="M24 12v30" stroke="#fff" strokeWidth="1.5" opacity=".7" />
      <rect x="9" y="17" width="10" height="3" rx="1.5" fill="#fff" opacity=".7" />
      <rect x="29" y="17" width="10" height="3" rx="1.5" fill="#fff" opacity=".7" />
      <rect x="29" y="23" width="7" height="3" rx="1.5" fill="#fff" opacity=".7" />
    </>
  ),
  personal: (
    <>
      <rect x="5" y="9" width="38" height="30" rx="5" fill={A} />
      <rect x="5" y="9" width="38" height="8" rx="4" fill={T} />
      <circle cx="17" cy="25" r="4.5" fill={G} />
      <path d="M10 35c0-4.5 3-7 7-7s7 2.5 7 7z" fill={G} />
      <rect x="27" y="23" width="12" height="3" rx="1.5" fill="#fff" />
      <rect x="27" y="29" width="8" height="3" rx="1.5" fill="#fff" opacity=".8" />
      <rect x="20" y="5" width="8" height="8" rx="2" fill={Y} />
    </>
  ),
  tesoreria: (
    <>
      <rect x="4" y="20" width="40" height="22" rx="4" fill={G} />
      <rect x="9" y="6" width="22" height="17" rx="2" fill={V} transform="rotate(-8 20 14)" />
      <circle cx="20" cy="14" r="3.5" fill="#fff" opacity=".55" />
      <rect x="4" y="27" width="40" height="5" fill={T} />
      <circle cx="35" cy="37" r="2.5" fill={Y} />
    </>
  ),
  caja: (
    <>
      <path d="M24 5a19 19 0 0 0 0 38z" fill={Y} />
      <path d="M24 5a19 19 0 0 1 0 38z" fill={P} />
      <circle cx="24" cy="24" r="13" fill="#fff" opacity=".9" />
      <path d="M24 15v9l6 4" stroke={G} strokeWidth="3.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="24" cy="24" r="2" fill={G} />
    </>
  ),
  movimientos: (
    <>
      <path d="M15 42V14H7l11-11 11 11h-8v28z" fill={V} />
      <path d="M33 6v28h8L30 45 19 34h8V6z" fill={R} opacity=".9" />
    </>
  ),
  bancos: (
    <>
      <path d="M24 3 4 14v4h40v-4z" fill={T} />
      <rect x="8" y="20" width="5" height="16" rx="1" fill={G} />
      <rect x="17" y="20" width="5" height="16" rx="1" fill={G} />
      <rect x="26" y="20" width="5" height="16" rx="1" fill={G} opacity=".8" />
      <rect x="4" y="37" width="30" height="5" rx="1.5" fill={G} />
      <circle cx="36" cy="34" r="10" fill={V} />
      <path d="m31.5 34 3 3 6-6" stroke="#fff" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  cheques: (
    <>
      <rect x="3" y="12" width="40" height="24" rx="4" fill={Y} />
      <rect x="8" y="18" width="14" height="3" rx="1.5" fill={G} opacity=".6" />
      <path d="M8 30c3-3 5 2 8-1s4 1 7-1" stroke={G} strokeWidth="2" fill="none" strokeLinecap="round" />
      <path d="M40 4l5 5-17 17-7 2 2-7z" fill={P} />
      <path d="M36 8l5 5" stroke="#fff" strokeWidth="1.5" opacity=".6" />
    </>
  ),
  pagos: (
    <>
      <path d="M8 4h22l8 8v32H8z" fill={R} />
      <path d="M30 4v8h8z" fill="#fff" opacity=".5" />
      <rect x="13" y="18" width="14" height="3" rx="1.5" fill="#fff" opacity=".75" />
      <rect x="13" y="24" width="10" height="3" rx="1.5" fill="#fff" opacity=".75" />
      <circle cx="35" cy="35" r="10" fill={O} />
      <path d="M30 35h9m-3.5-4 4 4-4 4" stroke="#fff" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  flujo: (
    <>
      <path d="M4 30c7-10 12-2 19-9s12-12 21-8v31H4z" fill={T} />
      <path d="M4 36c8-6 13 0 20-5s12-7 20-4v17H4z" fill={V} opacity=".9" />
      <path d="M4 41c9-3 15 1 22-1s11-3 18-2v6H4z" fill={P} opacity=".9" />
    </>
  ),
  categorias: (
    <>
      <path d="M4 8h16l20 20-14 14L6 22z" fill={O} />
      <path d="M14 4h14l18 18-12 12" fill="none" stroke={P} strokeWidth="4" strokeLinejoin="round" />
      <circle cx="12" cy="15" r="3.5" fill="#fff" />
    </>
  ),
  respaldo: (
    <>
      <path d="M13 34a9 9 0 0 1-1-18 12 12 0 0 1 23 2 8 8 0 0 1 0 16z" fill={T} />
      <rect x="20.5" y="18" width="7" height="15" rx="1.5" fill={V} />
      <path d="M15 31h18l-9 11z" fill={V} />
    </>
  ),
  usuarios: (
    <>
      <path d="M24 3 6 9v12c0 11 8 19 18 24 10-5 18-13 18-24V9z" fill={P} />
      <path d="M24 3v42c10-5 18-13 18-24V9z" fill={R} opacity=".85" />
      <circle cx="24" cy="19" r="5.5" fill="#fff" />
      <path d="M14.5 33c1-5.5 5-8 9.5-8s8.5 2.5 9.5 8z" fill="#fff" />
    </>
  ),
}


/** Ícono de una sección (svg 48×48). */
export function IconoSeccion({ seccion, className = 'h-9 w-9' }: { seccion: Seccion; className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden>
      {ICONOS[seccion]}
    </svg>
  )
}

/** Botón chico de "volver al lanzador" (grilla de 3×3 puntos). */
export function IconoGrilla({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden>
      {[2, 8, 14].flatMap((y) => [2, 8, 14].map((x) => <rect key={`${x}-${y}`} x={x - 1.6} y={y - 1.6} width="3.2" height="3.2" rx="0.8" />))}
    </svg>
  )
}

export type LauncherProps = {
  /** Secciones que ve la persona, en orden (Resumen primero). */
  items: ItemMenu[]
  nombre: string
  rolLabel: string
  onSignOut?: () => void
}

export function AppLauncher({ items, nombre, rolLabel, onSignOut }: LauncherProps) {
  const inicial = (nombre.trim()[0] || '?').toUpperCase()
  return (
    <div
      className="relative min-h-screen overflow-hidden"
      style={{ background: 'linear-gradient(135deg, #d9d7ea 0%, #e3e1ef 38%, #ecebf3 62%, #efeef4 100%)' }}
    >
      {/* Diagonales suaves como en el fondo de Odoo */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'linear-gradient(135deg, transparent 0 46%, rgba(255,255,255,.28) 46% 72%, transparent 72%), linear-gradient(135deg, transparent 0 78%, rgba(255,255,255,.22) 78%)',
        }}
      />

      {/* Barra superior */}
      <header className="relative z-10 flex items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo_deco_redondo.png" alt="DE&CO" className="h-8 w-8 shrink-0 rounded-full shadow-sm" />
          <div className="leading-tight">
            <div className="text-[13px] font-bold tracking-tight text-[#3f3f46]">DE&amp;CO</div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-[#0097b2]">Administración</div>
          </div>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 text-right leading-tight">
            <div className="max-w-[40vw] truncate text-xs font-medium text-slate-700 sm:max-w-[260px]">{nombre}</div>
            <div className="text-[10px] text-slate-500">{rolLabel}</div>
          </div>
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#56bb44] text-xs font-semibold text-white shadow-sm">{inicial}</span>
          {onSignOut && (
            <button
              onClick={onSignOut}
              className="shrink-0 rounded-md px-2 py-1 text-xs text-slate-600 ring-1 ring-slate-400/40 transition hover:bg-white/60 hover:text-slate-900"
            >
              Salir
            </button>
          )}
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-[720px] px-3 pb-16 pt-8 sm:pt-14">
        {items.length ? (
          <ul className="grid grid-cols-4 gap-x-1 gap-y-7 sm:grid-cols-6 sm:gap-y-9">
            {items.map((a) => (
              <li key={a.seccion}>
                <Link href={a.href} className="group flex flex-col items-center gap-2 rounded-lg px-1 py-1 outline-none">
                  <span className="flex h-[56px] w-[56px] items-center justify-center rounded-[10px] bg-white shadow-[0_1px_2px_rgba(30,30,60,.08),0_3px_8px_rgba(30,30,60,.10)] transition duration-150 group-hover:-translate-y-0.5 group-hover:shadow-[0_2px_4px_rgba(30,30,60,.10),0_8px_18px_rgba(30,30,60,.14)] group-focus-visible:ring-2 group-focus-visible:ring-[#0097b2]">
                    <IconoSeccion seccion={a.seccion} className="h-[36px] w-[36px]" />
                  </span>
                  <span className="line-clamp-2 max-w-[92px] text-center text-[12px] leading-tight text-[#3f3f46]">{a.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <div className="mx-auto mt-6 max-w-sm rounded-xl bg-white/80 p-6 text-center text-sm text-slate-600 shadow-sm">
            Todavía no tenés ninguna sección habilitada. Pedile a Gerencia que te las habilite en Usuarios → Permisos por sección.
          </div>
        )}
      </main>
    </div>
  )
}
