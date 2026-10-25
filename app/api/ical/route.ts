// Calendario de personal por suscripción (Google Calendar → "Desde URL", Outlook, iPhone).
// Requiere en Vercel: ICAL_TOKEN (una clave larga inventada) y SUPABASE_SERVICE_ROLE_KEY.
// URL: https://TU-APP.vercel.app/api/ical?token=ICAL_TOKEN
import { createClient } from '@supabase/supabase-js'
import { armarEventos, type Empleado, type Evento, type Novedad } from '@/lib/personal'
import { generarICS } from '@/lib/ics'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get('token')
  if (!process.env.ICAL_TOKEN || !token || token !== process.env.ICAL_TOKEN) {
    return new Response('No autorizado', { status: 401 })
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return new Response('Falta configurar SUPABASE_SERVICE_ROLE_KEY', { status: 500 })

  const s = createClient(url, key, { auth: { persistSession: false } })
  const anio = Number(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Cordoba' }).slice(0, 4))
  const [e, n] = await Promise.all([
    s.from('empleados').select('*'),
    s.from('novedades').select('*').eq('estado', 'aprobado').gte('fecha_hasta', `${anio - 1}-01-01`),
  ])
  if (e.error || n.error) return new Response('Error leyendo datos', { status: 500 })

  // Solo lo aprobado; un evento que cruza de año aparece una sola vez
  const vistos = new Set<string>()
  const eventos: Evento[] = []
  for (const a of [anio - 1, anio, anio + 1]) {
    for (const ev of armarEventos(a, e.data as Empleado[], n.data as Novedad[])) {
      if (vistos.has(ev.id)) continue
      vistos.add(ev.id)
      eventos.push(ev)
    }
  }
  return new Response(generarICS(eventos, { nombre: 'DE&CO · Personal', cumplesRecurrentes: true }), {
    headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}
