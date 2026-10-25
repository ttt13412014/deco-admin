'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { sb } from '@/lib/supabase'
import type { Producto } from '@/lib/types'
import { SIN_CATEGORIA, categorias, descargarPlantilla, ordenar, subrubrosPorCategoria } from '@/lib/catalogo'
import { useAuth } from '@/components/AuthProvider'
import { ProductoForm } from '@/components/ProductoForm'
import { ImportarProductos } from '@/components/ImportarProductos'
import { ListaProductos } from '@/components/ListaProductos'
import { Alert, Button, Modal, PageHeader } from '@/components/ui'

export default function CatalogoPage() {
  const { puedeEditarCatalogo } = useAuth()
  const [productos, setProductos] = useState<Producto[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editar, setEditar] = useState<Producto | 'nuevo' | null>(null)
  const [importar, setImportar] = useState(false)
  const [aviso, setAviso] = useState<string | null>(null)

  const cargar = useCallback(async () => {
    const { data, error } = await sb().from('productos').select('*').order('categoria').order('orden').order('nombre')
    if (error) setError(error.message)
    setProductos(ordenar((data as Producto[]) ?? []))
  }, [])

  useEffect(() => {
    cargar()
  }, [cargar])

  const cats = useMemo(() => categorias(productos ?? []), [productos])

  const subs = useMemo(() => subrubrosPorCategoria(productos ?? []), [productos])

  return (
    <>
      <PageHeader
        title="Catálogo"
        subtitle="Productos con foto para armar el catálogo en PDF y mandarlo a los clientes."
        actions={
          <>
            <Link href="/catalogo/imprimir" className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3.5 py-2 text-sm font-medium text-slate-700 shadow-sm ring-1 ring-slate-300 hover:bg-slate-50">
              ⎙ Armar catálogo PDF
            </Link>
            {puedeEditarCatalogo && (
              <>
                <Button variant="secondary" onClick={descargarPlantilla}>
                  Plantilla Excel
                </Button>
                <Button variant="secondary" onClick={() => setImportar(true)}>
                  Importar Excel
                </Button>
                <Button onClick={() => setEditar('nuevo')}>+ Nuevo producto</Button>
              </>
            )}
          </>
        }
      />

      {aviso && (
        <Alert tone="green" className="mb-4">
          {aviso}
        </Alert>
      )}
      {error && (
        <Alert tone="red" className="mb-4">
          No pude leer el catálogo: {error}
        </Alert>
      )}

      <ListaProductos productos={productos} puedeEditar={puedeEditarCatalogo} onEditar={setEditar} />

      <Modal open={editar !== null} onClose={() => setEditar(null)} title={editar === 'nuevo' ? 'Nuevo producto' : 'Editar producto'} wide>
        {editar !== null && (
          <ProductoForm
            key={editar === 'nuevo' ? 'nuevo' : editar.id}
            producto={editar === 'nuevo' ? null : editar}
            categorias={cats.filter((c) => c !== SIN_CATEGORIA)}
            subrubros={subs}
            onCancel={() => setEditar(null)}
            onSaved={(p, accion) => {
              setEditar(null)
              setAviso(`${p.nombre}: ${accion === 'creado' ? 'producto creado' : accion === 'eliminado' ? 'producto eliminado' : 'cambios guardados'}.`)
              cargar()
            }}
          />
        )}
      </Modal>

      <Modal open={importar} onClose={() => setImportar(false)} title="Importar productos desde Excel" wide>
        <ImportarProductos
          onDone={(r) => {
            setImportar(false)
            setAviso(r)
            cargar()
          }}
        />
      </Modal>
    </>
  )
}
