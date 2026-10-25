import { createClient, SupabaseClient } from '@supabase/supabase-js'

let client: SupabaseClient | null = null

/** Cliente de Supabase (navegador). Se crea una sola vez. */
export function sb(): SupabaseClient {
  if (!client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (!url || !key) throw new Error('Faltan NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY')
    client = createClient(url, key)
  }
  return client
}

/** Traduce errores técnicos a algo legible. Los mensajes de las reglas (A01, A05, A06) pasan tal cual. */
export function errMsg(e: unknown): string {
  const m = (e as { message?: string })?.message ?? String(e)
  if (m.includes('row-level security')) return 'No tenés permiso para hacer esto con tu rol.'
  if (m.includes('duplicate key') && m.includes('cuit_dni')) return 'Ya existe un cliente con ese CUIT/DNI.'
  if (m.includes('duplicate key') && m.includes('tipo_comprobante')) return 'Ya existe un comprobante con ese tipo y número.'
  if (m.includes('duplicate key') && m.includes('tes_categorias')) return 'Ya existe esa categoría en ese rubro.'
  if (m.includes('duplicate key') && m.includes('tes_extractos')) return 'Esa línea del extracto ya estaba importada.'
  if (m.includes('duplicate key') && m.includes('tes_jornadas')) return 'Ya existe la jornada de ese día.'
  if (m.includes('duplicate key') && m.includes('fecha')) return 'Ya existe una caja para esa fecha.'
  if (m.includes('invalid input syntax for type numeric')) return 'Hay un importe mal escrito.'
  if (m.includes('novedades_check1')) return 'Esa novedad necesita un empleado.'
  if (m.includes('novedades_check')) return 'La fecha "hasta" no puede ser anterior a "desde".'
  if (m.includes('duplicate key') && m.includes('cuil')) return 'Ya existe un empleado con ese CUIL.'
  if (m.includes('duplicate key') && m.includes('productos_codigo')) return 'Ya existe un producto con ese código.'
  if (m.includes('productos_precio_chk')) return 'El precio no puede ser negativo.'
  if (m.includes('Invalid login credentials')) return 'Email o contraseña incorrectos.'
  return m
}
