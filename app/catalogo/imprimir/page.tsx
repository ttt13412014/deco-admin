'use client'

import { useEffect, useState } from 'react'
import { errMsg, sb } from '@/lib/supabase'
import type { Producto } from '@/lib/types'
import { ordenar } from '@/lib/catalogo'
import { ArmarCatalogo } from '@/components/ArmarCatalogo'
import { Alert, Spinner } from '@/components/ui'

export default function ImprimirCatalogoPage() {
  const [productos, setProductos] = useState<Producto[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    sb()
      .from('productos')
      .select('*')
      .eq('activo', true)
      .then(({ data, error }) => {
        if (error) setError(errMsg(error))
        setProductos(ordenar((data as Producto[]) ?? []))
      })
  }, [])

  if (error) return <Alert tone="red">No pude leer el catálogo: {error}</Alert>
  if (!productos) return <Spinner />
  return <ArmarCatalogo productos={productos} />
}
