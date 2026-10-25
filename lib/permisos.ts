import type { Perfil, Rol } from './types'

/**
 * Permisos por sección (migración 18).
 *
 * Cada ítem del menú es una "sección" con una clave fija. Gerencia elige en
 * Usuarios → "Permisos por sección" qué secciones ve cada persona; eso queda en
 * perfiles.secciones. Si la lista es null, la persona usa lo que trae su rol.
 *
 * La base de datos aplica la MISMA regla (public.puede_ver / puede_ver_alguna),
 * así que esta lista y la de supabase/migracion_18_permisos_por_seccion.sql
 * tienen que coincidir.
 */
export type Seccion =
  | 'inicio'
  | 'clientes'
  | 'cobranzas'
  | 'reporte'
  | 'rutas'
  | 'catalogo'
  | 'personal'
  | 'tesoreria'
  | 'caja'
  | 'movimientos'
  | 'bancos'
  | 'cheques'
  | 'pagos'
  | 'flujo'
  | 'categorias'
  | 'respaldo'
  | 'usuarios'

export type Grupo = 'General' | 'Tesorería' | 'Sistema'

export type ItemMenu = { href: string; label: string; icon: string; code?: string; seccion: Seccion; grupo: Grupo }

/** Menú de la app, en orden. Es la fuente de la lista de secciones. */
export const MENU: ItemMenu[] = [
  // La sección sigue llamándose 'inicio' (base de datos y permisos), pero el tablero ahora vive en /resumen:
  // '/' es el lanzador de íconos (components/AppLauncher.tsx), que ve cualquiera con acceso.
  { href: '/resumen', label: 'Resumen', icon: '◧', seccion: 'inicio', grupo: 'General' },
  { href: '/clientes', label: 'Clientes', icon: '◉', code: 'A01', seccion: 'clientes', grupo: 'General' },
  { href: '/cobranzas', label: 'Cuentas a cobrar', icon: '$', code: 'A05', seccion: 'cobranzas', grupo: 'General' },
  { href: '/cobranzas/reporte', label: 'Reporte de los lunes', icon: '≡', code: 'A05', seccion: 'reporte', grupo: 'General' },
  { href: '/rutas', label: 'Hoja de ruta', icon: '➜', seccion: 'rutas', grupo: 'General' },
  { href: '/catalogo', label: 'Catálogo', icon: '▦', seccion: 'catalogo', grupo: 'General' },
  { href: '/personal', label: 'Personal', icon: '◎', seccion: 'personal', grupo: 'General' },
  { href: '/tesoreria', label: 'Caja y Bancos', icon: '◈', seccion: 'tesoreria', grupo: 'Tesorería' },
  { href: '/tesoreria/jornada', label: 'Apertura y cierre', icon: '▣', code: 'A06', seccion: 'caja', grupo: 'Tesorería' },
  { href: '/tesoreria/movimientos', label: 'Movimientos', icon: '⇅', seccion: 'movimientos', grupo: 'Tesorería' },
  { href: '/tesoreria/bancos', label: 'Bancos y conciliación', icon: '⌂', seccion: 'bancos', grupo: 'Tesorería' },
  { href: '/tesoreria/cheques', label: 'Cheques', icon: '✎', seccion: 'cheques', grupo: 'Tesorería' },
  { href: '/pagos', label: 'Cuentas a pagar', icon: '⇲', seccion: 'pagos', grupo: 'Tesorería' },
  { href: '/flujo', label: 'Flujo de fondos', icon: '≈', code: 'A08', seccion: 'flujo', grupo: 'Tesorería' },
  { href: '/tesoreria/categorias', label: 'Categorías', icon: '#', seccion: 'categorias', grupo: 'Tesorería' },
  { href: '/respaldo', label: 'Respaldo', icon: '⇩', seccion: 'respaldo', grupo: 'Sistema' },
  { href: '/usuarios', label: 'Usuarios', icon: '⚙', seccion: 'usuarios', grupo: 'Sistema' },
]

/** Todas las secciones (sale del menú). */
export const SECCIONES: { seccion: Seccion; label: string; grupo: Grupo }[] = MENU.map((m) => ({ seccion: m.seccion, label: m.label, grupo: m.grupo }))
export const TODAS: Seccion[] = SECCIONES.map((s) => s.seccion)

/** Usuarios es siempre y solo de Gerencia (así nadie la puede dejar afuera). */
export const SOLO_GERENCIA: Seccion[] = ['usuarios']

/**
 * Lo que se le puede habilitar a Ventas. El resto son pantallas de trabajo de
 * Administración (cargan, cierran, pagan): para eso hay que pasarlo a Administración
 * y elegirle las secciones.
 */
export const POSIBLES_VENTAS: Seccion[] = ['inicio', 'clientes', 'cobranzas', 'reporte', 'rutas', 'catalogo']

/** Lo que ve cada rol cuando no tiene una lista propia (igual que antes de la migración 18). */
export const POR_ROL: Record<Rol, Seccion[]> = {
  pendiente: [],
  ventas: ['clientes', 'rutas', 'catalogo'],
  administracion: TODAS.filter((s) => !SOLO_GERENCIA.includes(s)),
  gerencia: TODAS,
}

/** Secciones que se le pueden marcar a alguien con ese rol. */
export function posiblesDelRol(rol: Rol): Seccion[] {
  if (rol === 'gerencia') return TODAS
  if (rol === 'administracion') return TODAS.filter((s) => !SOLO_GERENCIA.includes(s))
  if (rol === 'ventas') return POSIBLES_VENTAS
  return []
}

/** Secciones que ve de verdad una persona (rol + lista propia). Misma regla que public.secciones_efectivas(). */
export function seccionesEfectivas(perfil: Pick<Perfil, 'rol' | 'secciones'> | null | undefined): Set<Seccion> {
  if (!perfil) return new Set()
  if (perfil.rol === 'gerencia') return new Set(TODAS)
  const posibles = posiblesDelRol(perfil.rol)
  const lista = (perfil.secciones ?? POR_ROL[perfil.rol]) as string[]
  return new Set(posibles.filter((s) => lista.includes(s)))
}

/** Ruta del lanzador de íconos (pantalla de inicio después del login). */
export const LANZADOR = '/'

/** A qué sección pertenece una pantalla (la ruta más larga que coincide). null = pantalla fuera del menú. */
export function seccionDeRuta(pathname: string): Seccion | null {
  if (pathname === '/caja' || pathname.startsWith('/caja/')) return 'caja'
  let mejor: ItemMenu | null = null
  for (const m of MENU) {
    if ((pathname === m.href || pathname.startsWith(m.href + '/')) && (!mejor || m.href.length > mejor.href.length)) mejor = m
  }
  return mejor?.seccion ?? null
}

export function rutaPermitida(perfil: Pick<Perfil, 'rol' | 'secciones'> | null | undefined, pathname: string): boolean {
  if (!perfil || perfil.rol === 'pendiente') return false
  // El lanzador lo ve todo el que tiene acceso: muestra solo sus secciones
  if (pathname === LANZADOR) return true
  const s = seccionDeRuta(pathname)
  // Pantallas fuera del menú: como antes, Ventas no entra; Administración y Gerencia sí
  if (!s) return perfil.rol !== 'ventas'
  return seccionesEfectivas(perfil).has(s)
}

/** Secciones del menú que ve la persona, en orden (lo que muestran el lanzador y la barra lateral). */
export function menuDe(perfil: Pick<Perfil, 'rol' | 'secciones'> | null | undefined): ItemMenu[] {
  const ver = seccionesEfectivas(perfil)
  return MENU.filter((m) => ver.has(m.seccion))
}

/** Primera pantalla que puede ver. null = ninguna. */
export function inicioDe(perfil: Pick<Perfil, 'rol' | 'secciones'> | null | undefined): string | null {
  const ver = seccionesEfectivas(perfil)
  return MENU.find((m) => ver.has(m.seccion))?.href ?? null
}
