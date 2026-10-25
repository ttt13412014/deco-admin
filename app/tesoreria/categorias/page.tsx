'use client'

import { FormEvent, useCallback, useEffect, useState } from 'react'
import { sb, errMsg } from '@/lib/supabase'
import { Categoria, cargarBase, normTxt, porRubro } from '@/lib/tesoreria'
import { useAuth } from '@/components/AuthProvider'
import { Alert, Badge, Button, Card, Empty, Field, Modal, PageHeader, Spinner, cx, inputCls } from '@/components/ui'

type Tipo = 'ingreso' | 'egreso'

export default function CategoriasPage() {
  const { puedeEditar, esGerencia } = useAuth()
  const [cats, setCats] = useState<Categoria[] | null>(null)
  const [tipo, setTipo] = useState<Tipo>('egreso')
  const [inactivas, setInactivas] = useState(false)
  const [editar, setEditar] = useState<Categoria | 'nueva' | null>(null)
  const [pegar, setPegar] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'green' | 'red'; text: string } | null>(null)

  const cargar = useCallback(async () => {
    try {
      setCats((await cargarBase()).categorias)
    } catch (e) {
      setMsg({ tone: 'red', text: errMsg(e) })
      setCats([])
    }
  }, [])

  useEffect(() => {
    if (puedeEditar) cargar()
  }, [cargar, puedeEditar])

  if (!puedeEditar) return <Empty>Tesorería es exclusiva de Administración y Gerencia.</Empty>
  if (!cats) return <Spinner />

  async function cambiar(c: Categoria, cambios: Partial<Categoria>) {
    setMsg(null)
    const { error } = await sb().from('tes_categorias').update(cambios).eq('id', c.id)
    if (error) return setMsg({ tone: 'red', text: errMsg(error) })
    cargar()
  }

  const grupos = porRubro(cats, tipo, inactivas)
  const listo = (t: string) => {
    setEditar(null)
    setPegar(false)
    setMsg({ tone: 'green', text: t })
    cargar()
  }

  return (
    <>
      <PageHeader
        title="Categorías y rubros"
        subtitle="Los mismos conceptos que usás en el Excel. Cada movimiento lleva rubro y categoría, y los reportes se agrupan así."
        actions={
          <>
            <Button variant="secondary" onClick={() => setPegar(true)}>
              Pegar lista del Excel
            </Button>
            <Button onClick={() => setEditar('nueva')}>+ Categoría</Button>
          </>
        }
      />
      {msg && (
        <Alert tone={msg.tone} className="mb-4">
          {msg.text}
        </Alert>
      )}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5">
          {(['egreso', 'ingreso'] as const).map((t) => (
            <button key={t} onClick={() => setTipo(t)} className={cx('rounded-md px-4 py-1.5 text-sm font-medium', tipo === t ? 'bg-brand-700 text-white' : 'text-slate-600 hover:bg-slate-50')}>
              {t === 'egreso' ? 'Egresos' : 'Ingresos'}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4 accent-brand-700" checked={inactivas} onChange={(e) => setInactivas(e.target.checked)} />
          Mostrar desactivadas
        </label>
      </div>
      {tipo === 'egreso' && (
        <Alert tone="blue" className="mb-4">
          <b>Pide autorización</b>: el pago se carga como previsto y Gerencia lo autoriza antes de pagar (A08). Las de gasto menor (combustible, librería…) se pueden pagar directo con comprobante.
          {!esGerencia && ' Solo Gerencia puede cambiar qué categorías piden autorización.'}
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {grupos.map(([rubro, cs]) => (
          <Card key={rubro} title={rubro} pad={false}>
            <ul className="divide-y divide-slate-100">
              {cs.map((c) => (
                <li key={c.id} className={cx('flex flex-wrap items-center gap-2 px-4 py-2 text-sm', !c.activa && 'opacity-50')}>
                  <span className="min-w-0 flex-1">
                    {c.nombre}
                    {c.clave && <span className="ml-2 text-[11px] text-slate-400">usa el sistema</span>}
                  </span>
                  {tipo === 'egreso' && (
                    <button
                      type="button"
                      disabled={!esGerencia}
                      onClick={() => cambiar(c, { requiere_autorizacion: !c.requiere_autorizacion })}
                      className="disabled:cursor-default"
                      title={esGerencia ? 'Cambiar' : undefined}
                    >
                      <Badge tone={c.requiere_autorizacion ? 'amber' : 'slate'}>{c.requiere_autorizacion ? 'Pide autorización' : 'Pago directo'}</Badge>
                    </button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setEditar(c)}>
                    Editar
                  </Button>
                  {!c.clave && (
                    <Button size="sm" variant="ghost" onClick={() => cambiar(c, { activa: !c.activa })}>
                      {c.activa ? 'Desactivar' : 'Activar'}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
      <p className="mt-3 text-xs text-slate-500">Las categorías no se borran para no perder el historial: se desactivan y dejan de aparecer al cargar.</p>

      <Modal open={!!editar} onClose={() => setEditar(null)} title={editar === 'nueva' ? 'Nueva categoría' : 'Editar categoría'}>
        {editar && <CategoriaForm inicial={editar === 'nueva' ? null : editar} tipo={tipo} rubros={Array.from(new Set(cats.filter((c) => c.tipo === tipo).map((c) => c.rubro)))} esGerencia={esGerencia} onCancel={() => setEditar(null)} onSaved={listo} />}
      </Modal>
      <Modal open={pegar} onClose={() => setPegar(false)} title="Pegar categorías desde el Excel" wide>
        {pegar && <PegarLista cats={cats} tipoInicial={tipo} esGerencia={esGerencia} onCancel={() => setPegar(false)} onSaved={listo} />}
      </Modal>
    </>
  )
}

function CategoriaForm({ inicial, tipo, rubros, esGerencia, onSaved, onCancel }: { inicial: Categoria | null; tipo: Tipo; rubros: string[]; esGerencia: boolean; onSaved: (t: string) => void; onCancel: () => void }) {
  const t = inicial?.tipo ?? tipo
  const [rubro, setRubro] = useState(inicial?.rubro ?? '')
  const [nombre, setNombre] = useState(inicial?.nombre ?? '')
  const [aut, setAut] = useState(inicial?.requiere_autorizacion ?? t === 'egreso')
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!rubro.trim() || !nombre.trim()) return setError('Completá rubro y nombre.')
    const datos = { rubro: rubro.trim(), nombre: nombre.trim(), requiere_autorizacion: t === 'egreso' ? aut : false }
    const q = inicial ? sb().from('tes_categorias').update(datos).eq('id', inicial.id) : sb().from('tes_categorias').insert({ ...datos, tipo: t, orden: 100 })
    const { error } = await q
    if (error) return setError(errMsg(error))
    onSaved(inicial ? 'Categoría actualizada.' : 'Categoría creada.')
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <p className="text-sm text-slate-600">{t === 'egreso' ? 'Categoría de egreso' : 'Categoría de ingreso'}</p>
      <Field label="Rubro" required hint="Agrupa varias categorías: Proveedores, Impuestos, Servicios…">
        <input id="cat-rubro" className={inputCls} value={rubro} onChange={(e) => setRubro(e.target.value)} list="rubros" />
        <datalist id="rubros">
          {rubros.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
      </Field>
      <Field label="Categoría" required>
        <input id="cat-nombre" className={inputCls} value={nombre} onChange={(e) => setNombre(e.target.value)} />
      </Field>
      {t === 'egreso' && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4 accent-brand-700" checked={aut} disabled={!esGerencia} onChange={(e) => setAut(e.target.checked)} />
          Pide autorización de Gerencia antes de pagar
          {!esGerencia && <span className="text-xs text-slate-500">(solo Gerencia lo cambia)</span>}
        </label>
      )}
      {error && <Alert tone="red">{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit">Guardar</Button>
      </div>
    </form>
  )
}

function PegarLista({ cats, tipoInicial, esGerencia, onSaved, onCancel }: { cats: Categoria[]; tipoInicial: Tipo; esGerencia: boolean; onSaved: (t: string) => void; onCancel: () => void }) {
  const [tipo, setTipo] = useState<Tipo>(tipoInicial)
  const [texto, setTexto] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const existentes = new Set(cats.filter((c) => c.tipo === tipo).map((c) => `${normTxt(c.rubro)}|${normTxt(c.nombre)}`))
  const vistos = new Set<string>()
  const filas = texto
    .split(/\r?\n/)
    .map((l) => l.split(/\t|;|\|/).map((x) => x.trim()))
    .filter((p) => p.some(Boolean))
    .map((p) => (p.length >= 2 ? { rubro: p[0], nombre: p[1] } : { rubro: 'Sin rubro', nombre: p[0] }))
    .filter((f) => f.nombre && !/^categor/i.test(f.nombre))
    .map((f) => {
      const k = `${normTxt(f.rubro)}|${normTxt(f.nombre)}`
      const dup = existentes.has(k) || vistos.has(k)
      vistos.add(k)
      return { ...f, dup }
    })
  const nuevas = filas.filter((f) => !f.dup)

  async function guardar() {
    setBusy(true)
    setError(null)
    const { error } = await sb()
      .from('tes_categorias')
      .insert(nuevas.map((f, i) => ({ tipo, rubro: f.rubro, nombre: f.nombre, requiere_autorizacion: tipo === 'egreso', orden: 100 + i })))
    setBusy(false)
    if (error) return setError(errMsg(error))
    onSaved(`Se agregaron ${nuevas.length} categorías.`)
  }

  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-lg border border-slate-300 p-0.5">
        {(['egreso', 'ingreso'] as const).map((t) => (
          <button key={t} type="button" onClick={() => setTipo(t)} className={cx('rounded-md px-3 py-1.5 text-sm font-medium', tipo === t ? 'bg-brand-700 text-white' : 'text-slate-600')}>
            {t === 'egreso' ? 'Egresos' : 'Ingresos'}
          </button>
        ))}
      </div>
      <p className="text-sm text-slate-600">
        Copiá del Excel dos columnas, <b>Rubro</b> y <b>Categoría</b>, y pegalas acá (una por renglón). Si pegás una sola columna van al rubro &quot;Sin rubro&quot;. Las que ya existen se saltean.
      </p>
      <textarea id="pegar-texto" className={`${inputCls} font-mono text-xs`} rows={10} value={texto} onChange={(e) => setTexto(e.target.value)} placeholder={'Proveedores\tRepuestos importados\nServicios\tAlarma y monitoreo'} />
      {filas.length > 0 && (
        <div className="max-h-48 overflow-y-auto rounded-lg border border-slate-200 text-sm">
          {filas.map((f, i) => (
            <div key={i} className={cx('flex gap-2 border-b border-slate-100 px-3 py-1', f.dup && 'text-slate-400 line-through')}>
              <span className="w-40 shrink-0 text-slate-500">{f.rubro}</span>
              <span>{f.nombre}</span>
            </div>
          ))}
        </div>
      )}
      {tipo === 'egreso' && <p className="text-xs text-slate-500">Se crean pidiendo autorización. Después Gerencia puede marcar las de gasto menor como pago directo.</p>}
      {error && <Alert tone="red">{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancelar
        </Button>
        <Button onClick={guardar} disabled={busy || !nuevas.length}>
          Agregar {nuevas.length || ''}
        </Button>
      </div>
    </div>
  )
}
