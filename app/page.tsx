'use client'

import { AppLauncher } from '@/components/AppLauncher'
import { useAuth } from '@/components/AuthProvider'
import { ROL_LABEL } from '@/components/AppFrame'
import { menuDe } from '@/lib/permisos'

/** Inicio: lanzador de íconos con las secciones que ve la persona. El tablero de antes está en /resumen. */
export default function Inicio() {
  const { session, perfil, signOut } = useAuth()
  return (
    <AppLauncher
      items={menuDe(perfil)}
      nombre={perfil?.nombre || session?.user.email || ''}
      rolLabel={perfil ? ROL_LABEL[perfil.rol] : ''}
      onSignOut={signOut}
    />
  )
}
