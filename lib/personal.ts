// Personal y novedades: vacaciones según LCT, feriados, cumpleaños y eventos del calendario.
import { diffDias, sumarDias } from './utils'

export interface Empleado {
  id: string
  nombre: string
  apellido: string
  cuil: string | null
  puesto: string | null
  area: string | null
  fecha_ingreso: string
  fecha_nacimiento: string | null
  telefono: string | null
  email: string | null
  emergencia_nombre: string | null
  emergencia_telefono: string | null
  emergencia_vinculo: string | null
  dias_vacaciones_manual: number | null
  activo: boolean
  fecha_baja: string | null
  observaciones: string | null
  created_at: string
  updated_at: string
}

export type TipoNovedad = 'vacaciones' | 'licencia' | 'permiso' | 'reunion' | 'feriado' | 'otro'
export type EstadoNovedad = 'pendiente' | 'aprobado' | 'rechazado'

export interface Novedad {
  id: string
  empleado_id: string | null
  tipo: TipoNovedad
  titulo: string | null
  fecha_desde: string
  fecha_hasta: string
  hora: string | null
  estado: EstadoNovedad
  observaciones: string | null
  motivo_rechazo: string | null
  aprobado_at: string | null
  created_at: string
  empleado?: Pick<Empleado, 'nombre' | 'apellido'> | null
  aprobador?: { nombre: string } | null
}

/** Tipos que se ven en el calendario. "cumple" y "feriado_nac" se generan solos. */
export type TipoEvento = TipoNovedad | 'cumple' | 'feriado_nac'

// Paleta validada (colores distinguibles también con daltonismo). Siempre acompañada de etiqueta.
export const TIPOS: Record<TipoEvento, { label: string; color: string; corto: string }> = {
  vacaciones: { label: 'Vacaciones', color: '#0d9488', corto: 'Vac' },
  licencia: { label: 'Licencia', color: '#7c3aed', corto: 'Lic' },
  permiso: { label: 'Permiso', color: '#d97706', corto: 'Per' },
  reunion: { label: 'Reunión', color: '#2563eb', corto: 'Reu' },
  feriado_nac: { label: 'Feriado', color: '#dc2626', corto: 'Fer' },
  feriado: { label: 'Feriado / no laborable propio', color: '#dc2626', corto: 'Fer' },
  cumple: { label: 'Cumpleaños', color: '#c026d3', corto: 'Cum' },
  otro: { label: 'Otro', color: '#65a30d', corto: 'Otr' },
}
/** Tipos que se pueden cargar a mano. */
export const TIPOS_CARGA: TipoNovedad[] = ['vacaciones', 'licencia', 'permiso', 'reunion', 'feriado', 'otro']
/** Tipos para los filtros del calendario (feriado propio y nacional se filtran juntos). */
export const TIPOS_FILTRO: TipoEvento[] = ['vacaciones', 'licencia', 'permiso', 'reunion', 'feriado_nac', 'cumple', 'otro']

export const ESTADO_NOV: Record<EstadoNovedad, { label: string; tone: 'amber' | 'green' | 'slate' }> = {
  pendiente: { label: 'Pendiente', tone: 'amber' },
  aprobado: { label: 'Aprobado', tone: 'green' },
  rechazado: { label: 'Rechazado', tone: 'slate' },
}

// ---------------------------------------------------------------------
// Feriados nacionales (Argentina). Agregá los de cada año acá; los propios
// de la empresa se cargan como novedad tipo "feriado".
// ---------------------------------------------------------------------
export const FERIADOS: Record<number, [string, string][]> = {
  2026: [
    ['01-01', 'Año Nuevo'],
    ['02-16', 'Carnaval'],
    ['02-17', 'Carnaval'],
    ['03-23', 'Día no laborable con fines turísticos'],
    ['03-24', 'Día Nacional de la Memoria por la Verdad y la Justicia'],
    ['04-02', 'Día del Veterano y de los Caídos en la Guerra de Malvinas'],
    ['04-03', 'Viernes Santo'],
    ['05-01', 'Día del Trabajador'],
    ['05-25', 'Día de la Revolución de Mayo'],
    ['06-15', 'Paso a la Inmortalidad de Güemes'],
    ['06-20', 'Paso a la Inmortalidad de Belgrano'],
    ['07-09', 'Día de la Independencia'],
    ['07-10', 'Día no laborable con fines turísticos'],
    ['08-17', 'Paso a la Inmortalidad de San Martín'],
    ['10-12', 'Día del Respeto a la Diversidad Cultural'],
    ['11-23', 'Día de la Soberanía Nacional'],
    ['12-07', 'Día no laborable con fines turísticos'],
    ['12-08', 'Inmaculada Concepción de María'],
    ['12-25', 'Navidad'],
  ],
}

export function feriadosDe(anio: number): { fecha: string; nombre: string }[] {
  return (FERIADOS[anio] ?? []).map(([md, n]) => ({ fecha: `${anio}-${md}`, nombre: n }))
}

// ---------------------------------------------------------------------
// Vacaciones (LCT art. 150 y 153)
// ---------------------------------------------------------------------
const UTC = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}
export const diaSemana = (iso: string) => UTC(iso).getUTCDay() // 0 = domingo

export function diasCorridos(desde: string, hasta: string): number {
  return diffDias(hasta, desde) + 1
}

/** Días hábiles (lunes a viernes, sin feriados nacionales ni propios). */
export function diasHabiles(desde: string, hasta: string, feriadosExtra: Set<string> = new Set()): number {
  let n = 0
  for (let f = desde; f <= hasta; f = sumarDias(f, 1)) {
    const d = diaSemana(f)
    const anio = Number(f.slice(0, 4))
    if (d === 0 || d === 6) continue
    if (feriadosExtra.has(f) || (FERIADOS[anio] ?? []).some(([md]) => `${anio}-${md}` === f)) continue
    n++
  }
  return n
}

/** Años de antigüedad cumplidos al 31/12 del año. */
export function antiguedad(ingreso: string, anio: number): number {
  // Al 31/12 ya pasó cualquier aniversario del año: alcanza con restar años
  return Math.max(0, anio - Number(ingreso.slice(0, 4)))
}

/**
 * Días de vacaciones que corresponden por LCT en el año:
 * hasta 5 años: 14 · 5 a 10: 21 · 10 a 20: 28 · más de 20: 35 (días corridos).
 * Si no trabajó al menos la mitad de los días hábiles del año: 1 día cada 20 trabajados.
 */
export function vacacionesLCT(ingreso: string, anio: number): { dias: number; regla: string } {
  if (Number(ingreso.slice(0, 4)) > anio) return { dias: 0, regla: 'Ingresó después de ese año' }
  const ant = antiguedad(ingreso, anio)
  if (Number(ingreso.slice(0, 4)) === anio) {
    const habilesAnio = diasHabiles(`${anio}-01-01`, `${anio}-12-31`)
    const trabajados = diasHabiles(ingreso, `${anio}-12-31`)
    if (trabajados < habilesAnio / 2) {
      const d = Math.floor(trabajados / 20)
      return { dias: d, regla: `Proporcional: 1 día cada 20 hábiles trabajados (${trabajados})` }
    }
  }
  if (ant < 5) return { dias: 14, regla: 'Antigüedad menor a 5 años' }
  if (ant < 10) return { dias: 21, regla: 'Antigüedad de 5 a 10 años' }
  if (ant < 20) return { dias: 28, regla: 'Antigüedad de 10 a 20 años' }
  return { dias: 35, regla: 'Antigüedad mayor a 20 años' }
}

export interface SaldoVacaciones {
  asignados: number
  regla: string
  manual: boolean
  usufructuados: number
  solicitados: number // pendientes de aprobación
  saldo: number
}

/** Saldo de vacaciones del año. Cuenta los días corridos de cada período por su fecha de inicio. */
export function saldoVacaciones(e: Empleado, novedades: Novedad[], anio: number): SaldoVacaciones {
  const lct = vacacionesLCT(e.fecha_ingreso, anio)
  const asignados = e.dias_vacaciones_manual ?? lct.dias
  const vac = novedades.filter((n) => n.empleado_id === e.id && n.tipo === 'vacaciones' && Number(n.fecha_desde.slice(0, 4)) === anio)
  const usufructuados = vac.filter((n) => n.estado === 'aprobado').reduce((a, n) => a + diasCorridos(n.fecha_desde, n.fecha_hasta), 0)
  const solicitados = vac.filter((n) => n.estado === 'pendiente').reduce((a, n) => a + diasCorridos(n.fecha_desde, n.fecha_hasta), 0)
  return {
    asignados,
    regla: e.dias_vacaciones_manual != null ? 'Cargado a mano' : lct.regla,
    manual: e.dias_vacaciones_manual != null,
    usufructuados,
    solicitados,
    saldo: asignados - usufructuados,
  }
}

// ---------------------------------------------------------------------
// Eventos del calendario
// ---------------------------------------------------------------------
export interface Evento {
  id: string
  tipo: TipoEvento
  titulo: string
  desde: string
  hasta: string
  empleado_id: string | null
  empleado: string | null
  estado: EstadoNovedad
  hora?: string | null
  detalle?: string | null
}

export const nombreEmp = (e: Pick<Empleado, 'nombre' | 'apellido'>) => `${e.nombre} ${e.apellido}`

export function cumpleDe(nacimiento: string, anio: number): string {
  const md = nacimiento.slice(5)
  if (md === '02-29') {
    const bisiesto = (anio % 4 === 0 && anio % 100 !== 0) || anio % 400 === 0
    return `${anio}-${bisiesto ? '02-29' : '02-28'}`
  }
  return `${anio}-${md}`
}

/** Título que se ve en el calendario. Las licencias no muestran el motivo (dato sensible). */
export function tituloNovedad(n: Novedad, emp: string | null): string {
  const base = n.tipo === 'licencia' ? 'Licencia' : n.titulo?.trim() || TIPOS[n.tipo].label
  return emp ? `${base} · ${emp}` : base
}

export function armarEventos(anio: number, empleados: Empleado[], novedades: Novedad[]): Evento[] {
  const porId = new Map(empleados.map((e) => [e.id, e]))
  const ev: Evento[] = []
  for (const f of feriadosDe(anio)) {
    ev.push({ id: `fer-${f.fecha}`, tipo: 'feriado_nac', titulo: f.nombre, desde: f.fecha, hasta: f.fecha, empleado_id: null, empleado: null, estado: 'aprobado' })
  }
  for (const e of empleados) {
    if (!e.activo || !e.fecha_nacimiento) continue
    const f = cumpleDe(e.fecha_nacimiento, anio)
    ev.push({ id: `cum-${e.id}-${anio}`, tipo: 'cumple', titulo: `Cumpleaños · ${nombreEmp(e)}`, desde: f, hasta: f, empleado_id: e.id, empleado: nombreEmp(e), estado: 'aprobado' })
  }
  const ini = `${anio}-01-01`
  const fin = `${anio}-12-31`
  for (const n of novedades) {
    if (n.fecha_hasta < ini || n.fecha_desde > fin || n.estado === 'rechazado') continue
    const e = n.empleado_id ? porId.get(n.empleado_id) : null
    const emp = e ? nombreEmp(e) : null
    ev.push({
      id: n.id,
      tipo: n.tipo,
      titulo: tituloNovedad(n, emp),
      desde: n.fecha_desde,
      hasta: n.fecha_hasta,
      empleado_id: n.empleado_id,
      empleado: emp,
      estado: n.estado,
      hora: n.hora,
      detalle: n.tipo === 'licencia' ? null : n.observaciones,
    })
  }
  return ev
}

/** Eventos por día (YYYY-MM-DD → eventos), recortados al año. */
export function eventosPorDia(eventos: Evento[], anio: number): Map<string, Evento[]> {
  return eventosPorRango(eventos, `${anio}-01-01`, `${anio}-12-31`)
}

/** Eventos por día entre dos fechas (inclusive). */
export function eventosPorRango(eventos: Evento[], ini: string, fin: string): Map<string, Evento[]> {
  const m = new Map<string, Evento[]>()
  for (const e of eventos) {
    let f = e.desde < ini ? ini : e.desde
    const h = e.hasta > fin ? fin : e.hasta
    for (; f <= h; f = sumarDias(f, 1)) {
      const arr = m.get(f) ?? []
      arr.push(e)
      m.set(f, arr)
    }
  }
  return m
}

export const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']

/** Celdas de un mes empezando en lunes (null = relleno). */
export function celdasMes(anio: number, mes: number): (string | null)[] {
  const primero = new Date(Date.UTC(anio, mes, 1)).getUTCDay()
  const offset = primero === 0 ? 6 : primero - 1
  const dias = new Date(Date.UTC(anio, mes + 1, 0)).getUTCDate()
  const c: (string | null)[] = Array(offset).fill(null)
  for (let d = 1; d <= dias; d++) c.push(`${anio}-${String(mes + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`)
  while (c.length % 7) c.push(null)
  return c
}

/** ¿Quiénes faltan un día? (vacaciones, licencias o permisos aprobados) */
export function ausentesEl(fecha: string, novedades: Novedad[]): Novedad[] {
  return novedades.filter(
    (n) => n.estado === 'aprobado' && n.empleado_id && ['vacaciones', 'licencia', 'permiso'].includes(n.tipo) && n.fecha_desde <= fecha && n.fecha_hasta >= fecha,
  )
}

export function validarCuil(s: string): string | null {
  const d = (s || '').replace(/\D/g, '')
  if (!d) return null
  if (d.length !== 11) return 'El CUIL debe tener 11 dígitos.'
  const mult = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  let dv = 11 - (mult.reduce((a, m, i) => a + m * Number(d[i]), 0) % 11)
  if (dv === 11) dv = 0
  if (dv === 10) dv = 9
  return dv === Number(d[10]) ? null : 'El dígito verificador del CUIL no coincide.'
}

export function fmtCuil(s: string | null): string {
  const d = (s || '').replace(/\D/g, '')
  return d.length === 11 ? `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}` : s || '—'
}

export function edadEn(nacimiento: string, fecha: string): number {
  const [y, m, d] = nacimiento.split('-').map(Number)
  const [Y, M, D] = fecha.split('-').map(Number)
  return Y - y - (M < m || (M === m && D < d) ? 1 : 0)
}
