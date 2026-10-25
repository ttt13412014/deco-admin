'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Spinner } from '@/components/ui'

// La caja diaria ahora es la apertura y cierre de Tesorería (efectivo + Galicia + Macro).
export default function CajaPage() {
  const router = useRouter()
  useEffect(() => router.replace('/tesoreria/jornada'), [router])
  return <Spinner />
}
