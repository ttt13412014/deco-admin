'use client'

import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { sb } from '@/lib/supabase'
import type { Perfil } from '@/lib/types'
import { seccionesEfectivas, type Seccion } from '@/lib/permisos'

interface AuthCtx {
  session: Session | null
  perfil: Perfil | null
  loading: boolean
  puedeEditar: boolean
  esGerencia: boolean
  /** Rol Ventas (por defecto: Clientes, Hoja de ruta y Catálogo; Gerencia puede habilitarle más secciones). */
  esVentas: boolean
  /** Alta / edición / importación de clientes (Ventas, Administración, Gerencia). */
  puedeCargarClientes: boolean
  /** Armar y editar hojas de ruta (Ventas, Administración, Gerencia). */
  puedeArmarRutas: boolean
  /** Cargar, editar, importar y borrar productos del catálogo (Ventas, Administración, Gerencia). */
  puedeEditarCatalogo: boolean
  /** Secciones que ve (rol + lo que marcó Gerencia en Usuarios → Permisos por sección). */
  secciones: Set<Seccion>
  puedeVer: (s: Seccion) => boolean
  signOut: () => Promise<void>
}

const Ctx = createContext<AuthCtx>({
  session: null,
  perfil: null,
  loading: true,
  puedeEditar: false,
  esGerencia: false,
  esVentas: false,
  puedeCargarClientes: false,
  puedeArmarRutas: false,
  puedeEditarCatalogo: false,
  secciones: new Set(),
  puedeVer: () => false,
  signOut: async () => {},
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [perfil, setPerfil] = useState<Perfil | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const s = sb()
    s.auth.getSession().then(({ data }) => {
      setSession(data.session)
      if (!data.session) setLoading(false)
    })
    const { data: sub } = s.auth.onAuthStateChange((_e, ses) => {
      setSession(ses)
      if (!ses) {
        setPerfil(null)
        setLoading(false)
      }
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  const uid = session?.user.id
  useEffect(() => {
    if (!uid) return
    sb()
      .from('perfiles')
      .select('*')
      .eq('id', uid)
      .single()
      .then(({ data }) => {
        setPerfil((data as Perfil) ?? null)
        setLoading(false)
      })
  }, [uid])

  const rol = perfil?.rol
  const secciones = useMemo(() => seccionesEfectivas(perfil), [perfil])
  return (
    <Ctx.Provider
      value={{
        session,
        perfil,
        loading,
        puedeEditar: rol === 'administracion' || rol === 'gerencia',
        esGerencia: rol === 'gerencia',
        esVentas: rol === 'ventas',
        puedeCargarClientes: rol === 'administracion' || rol === 'gerencia' || rol === 'ventas',
        puedeArmarRutas: rol === 'administracion' || rol === 'gerencia' || rol === 'ventas',
        puedeEditarCatalogo: rol === 'administracion' || rol === 'gerencia' || rol === 'ventas',
        secciones,
        puedeVer: (x: Seccion) => secciones.has(x),
        signOut: async () => {
          await sb().auth.signOut()
        },
      }}
    >
      {children}
    </Ctx.Provider>
  )
}

export const useAuth = () => useContext(Ctx)
