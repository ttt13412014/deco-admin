'use client'

import { useEffect, useState } from 'react'
import { sb, errMsg } from '@/lib/supabase'
import { fmtFechaHora } from '@/lib/utils'
import { generarXLSX, type Celda } from '@/lib/xlsx-lite'
import { descargar } from '@/lib/calendario-export'
import { RESPALDO_KEY, TABLAS } from '@/lib/respaldo'
import { useAuth } from '@/components/AuthProvider'
import { Alert, Button, Card, Empty, PageHeader, Table, td, th } from '@/components/ui'


/** Trae todas las filas de una tabla de a 1000 (límite de Supabase por consulta). */
async function traerTodo(tabla: string, orden: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  const paso = 1000
  for (let desde = 0; ; desde += paso) {
    const { data, error } = await sb().from(tabla).select('*').order(orden, { ascending: true }).range(desde, desde + paso - 1)
    if (error) throw new Error(`${tabla}: ${errMsg(error)}`)
    out.push(...((data as Record<string, unknown>[]) ?? []))
    if (!data || data.length < paso) break
  }
  return out
}

function aCelda(v: unknown): Celda {
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? 'Sí' : 'No'
  if (typeof v === 'number') return v
  // Los textos quedan como texto (CUIT, CUIL, números de comprobante no pierden ceros)
  if (typeof v === 'string') return v.length > 32000 ? v.slice(0, 32000) + '…' : v
  const s = JSON.stringify(v)
  return s.length > 32000 ? s.slice(0, 32000) + '…' : s
}

const sello = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`
}

export default function RespaldoPage() {
  const { puedeEditar, esGerencia, perfil } = useAuth()
  const [conteos, setConteos] = useState<Record<string, number | null>>({})
  const [ultimo, setUltimo] = useState<string | null>(null)
  const [progreso, setProgreso] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ tone: 'green' | 'red' | 'amber'; text: string } | null>(null)

  const tablas = TABLAS.filter((t) => !t.soloGerencia || esGerencia)

  useEffect(() => {
    try {
      setUltimo(localStorage.getItem(RESPALDO_KEY))
    } catch {}
    if (!puedeEditar) return
    Promise.all(
      tablas.map(async (t) => {
        const { count, error } = await sb().from(t.tabla).select('*', { count: 'exact', head: true })
        return [t.tabla, error ? null : count ?? 0] as const
      }),
    ).then((r) => setConteos(Object.fromEntries(r)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [puedeEditar, esGerencia])

  if (!puedeEditar) return <Empty>El respaldo es exclusivo de Administración y Gerencia.</Empty>

  async function respaldar(formato: 'xlsx' | 'json') {
    setMsg(null)
    const datos: Record<string, Record<string, unknown>[]> = {}
    const fallas: string[] = []
    try {
      for (const [i, t] of tablas.entries()) {
        setProgreso(`Leyendo ${t.nombre} (${i + 1} de ${tablas.length})…`)
        try {
          datos[t.tabla] = await traerTodo(t.tabla, t.orden)
        } catch (e) {
          fallas.push(errMsg(e))
          datos[t.tabla] = []
        }
      }
      setProgreso('Armando el archivo…')
      const nombre = `respaldo-deco-${sello()}`
      if (formato === 'json') {
        const json = JSON.stringify(
          { app: 'DE&CO Admin', generado: new Date().toISOString(), por: perfil?.email ?? perfil?.nombre ?? null, tablas: datos },
          null,
          1,
        )
        descargar(json, `${nombre}.json`, 'application/json')
      } else {
        const resumen: Celda[][] = [
          ['Tabla', 'Registros'],
          ...tablas.map((t) => [t.nombre, datos[t.tabla].length]),
          [],
          ['Generado', fmtFechaHora(new Date().toISOString())],
          ['Por', perfil?.nombre ?? ''],
        ]
        const hojas = [
          { nombre: 'Resumen', filas: resumen, anchos: [28, 12] },
          ...tablas.map((t) => {
            const filas = datos[t.tabla]
            const cols = Array.from(new Set(filas.flatMap((f) => Object.keys(f))))
            return {
              nombre: t.nombre,
              filas: cols.length ? [cols, ...filas.map((f) => cols.map((c) => aCelda(f[c])))] : [['Sin registros']],
              anchos: cols.map((c) => (/id$|_por$|^created_by|^updated_by/.test(c) ? 14 : /fecha|_at$/.test(c) ? 20 : 18)),
            }
          }),
        ]
        descargar(generarXLSX(hojas), `${nombre}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      }
      const ahora = new Date().toISOString()
      try {
        localStorage.setItem(RESPALDO_KEY, ahora)
      } catch {}
      setUltimo(ahora)
      const total = Object.values(datos).reduce((a, f) => a + f.length, 0)
      setMsg(
        fallas.length
          ? { tone: 'amber', text: `Respaldo descargado (${total} registros), pero hubo tablas que no se pudieron leer: ${fallas.join(' · ')}` }
          : { tone: 'green', text: `Respaldo descargado: ${total} registros de ${tablas.length} tablas. Guardalo en un lugar seguro (Drive, pendrive).` },
      )
    } catch (e) {
      setMsg({ tone: 'red', text: `No se pudo generar el respaldo: ${errMsg(e)}` })
    }
    setProgreso(null)
  }

  const dias = ultimo ? Math.floor((Date.now() - new Date(ultimo).getTime()) / 86400000) : null

  return (
    <>
      <PageHeader title="Respaldo" subtitle="Descargá una copia de todos los datos de la app, por las dudas." />

      {msg && (
        <Alert tone={msg.tone} className="mb-4">
          {msg.text}
        </Alert>
      )}
      {dias === null ? (
        <Alert tone="amber" className="mb-4">
          Desde esta computadora todavía no se hizo ningún respaldo.
        </Alert>
      ) : dias >= 7 ? (
        <Alert tone="amber" className="mb-4">
          El último respaldo desde esta computadora fue hace {dias} días ({fmtFechaHora(ultimo)}). Conviene hacer uno por semana.
        </Alert>
      ) : (
        <Alert tone="green" className="mb-4">
          Último respaldo desde esta computadora: {fmtFechaHora(ultimo)}.
        </Alert>
      )}

      <div className="mb-5 grid gap-4 md:grid-cols-2">
        <Card title="Excel (.xlsx)" subtitle="Para mirar, filtrar o imprimir">
          <p className="mb-4 text-sm text-slate-600">
            Un archivo con una hoja por cada sección: clientes, facturas, cobros, caja, flujo de fondos, hojas de ruta, personal y más. Se abre en Excel o Google Sheets.
          </p>
          <Button onClick={() => respaldar('xlsx')} disabled={!!progreso} className="w-full">
            {progreso ?? 'Descargar todo en Excel'}
          </Button>
        </Card>
        <Card title="Respaldo completo (.json)" subtitle="Para restaurar o migrar">
          <p className="mb-4 text-sm text-slate-600">
            Copia exacta de todos los registros, con sus códigos internos. Es el archivo que sirve para volver a cargar todo en otra base si algún día hace falta.
          </p>
          <Button variant="secondary" onClick={() => respaldar('json')} disabled={!!progreso} className="w-full">
            {progreso ?? 'Descargar respaldo completo'}
          </Button>
        </Card>
      </div>

      <Card title="Qué se incluye" pad={false}>
        <Table>
          <thead>
            <tr>
              <th className={th}>Sección</th>
              <th className={`${th} text-right`}>Registros</th>
            </tr>
          </thead>
          <tbody>
            {tablas.map((t) => (
              <tr key={t.tabla}>
                <td className={td}>
                  {t.nombre}
                  {t.soloGerencia && <span className="ml-2 text-xs text-slate-500">(solo Gerencia)</span>}
                </td>
                <td className={`${td} text-right tabular-nums`}>{conteos[t.tabla] === undefined ? '…' : conteos[t.tabla] === null ? 'sin acceso' : conteos[t.tabla]}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
          El archivo tiene datos personales y de la empresa: guardalo en un lugar privado. Las contraseñas de los usuarios no se exportan (las maneja Supabase).
        </p>
      </Card>
    </>
  )
}
