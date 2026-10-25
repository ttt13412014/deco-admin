// Exportación a iCalendar (.ics): se importa en Google Calendar, Outlook o el celular.
import type { Evento } from './personal'
import { sumarDias } from './utils'

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
const fechaICS = (iso: string) => iso.replace(/-/g, '')

/** Corta líneas a 75 octetos como pide el estándar (RFC 5545). */
function plegar(linea: string): string {
  const enc = new TextEncoder()
  if (enc.encode(linea).length <= 75) return linea
  const out: string[] = []
  let actual = ''
  for (const ch of linea) {
    if (enc.encode(actual + ch).length > (out.length ? 74 : 75)) {
      out.push(actual)
      actual = ''
    }
    actual += ch
  }
  out.push(actual)
  return out.join('\r\n ')
}

export function generarICS(eventos: Evento[], opts: { nombre: string; cumplesRecurrentes?: boolean; dominio?: string }): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const dom = opts.dominio ?? 'deco-admin'
  const L: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//DE&CO//Personal//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(opts.nombre)}`,
    'X-WR-TIMEZONE:America/Argentina/Cordoba',
  ]
  const vistos = new Set<string>()
  for (const e of eventos) {
    // Los cumpleaños van una sola vez y se repiten cada año
    const uid = e.tipo === 'cumple' && opts.cumplesRecurrentes ? `cumple-${e.empleado_id}@${dom}` : `${e.id}@${dom}`
    if (vistos.has(uid)) continue
    vistos.add(uid)
    L.push('BEGIN:VEVENT')
    L.push(`UID:${uid}`)
    L.push(`DTSTAMP:${stamp}`)
    L.push(`DTSTART;VALUE=DATE:${fechaICS(e.desde)}`)
    L.push(`DTEND;VALUE=DATE:${fechaICS(sumarDias(e.hasta, 1))}`)
    L.push(`SUMMARY:${esc(e.estado === 'pendiente' ? `${e.titulo} (pendiente)` : e.titulo)}`)
    const desc = [e.hora ? `Hora: ${e.hora}` : '', e.detalle ?? ''].filter(Boolean).join('\n')
    if (desc) L.push(`DESCRIPTION:${esc(desc)}`)
    L.push(`CATEGORIES:${esc(e.tipo)}`)
    L.push('TRANSP:TRANSPARENT')
    if (e.tipo === 'cumple' && opts.cumplesRecurrentes) L.push('RRULE:FREQ=YEARLY')
    L.push('END:VEVENT')
  }
  L.push('END:VCALENDAR')
  return L.map(plegar).join('\r\n') + '\r\n'
}

/** Link para agregar un evento suelto a Google Calendar. */
export function linkGoogle(e: Evento): string {
  const p = new URLSearchParams({
    action: 'TEMPLATE',
    text: e.titulo,
    dates: `${fechaICS(e.desde)}/${fechaICS(sumarDias(e.hasta, 1))}`,
    details: [e.hora ? `Hora: ${e.hora}` : '', e.detalle ?? ''].filter(Boolean).join('\n'),
  })
  return `https://calendar.google.com/calendar/render?${p.toString()}`
}
