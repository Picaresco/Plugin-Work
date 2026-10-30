import type { EngineInterface, ModelUsage } from 'claude-code'

// Lo que comparten las herramientas del mod: casi todo funciones puras, sin `$`. Lo único que guarda es
// si hay alguien delante, que fija el arranque de la sesión, y los fallos de las herramientas.

export const ROJO = '#ef4444'

// Cifras de uso (CPU, RAM, límites del plan): cada una con su color hasta `hasta` por ciento,
// incluido; por encima, ROJO.
const USOS = [
  { hasta: 60, color: '#22c55e' },
  { hasta: 85, color: '#facc15' },
] as const
const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'] as const
// De cada texto largo se enseña el principio; nada se corta a lo ancho: lo que no cabe sigue en la línea de abajo.
const TEXTO_TAREA = 300
// Desde este ancho de panel, un agente o un paso y sus cifras caben en una sola fila.
export const ANCHO_LINEA = 76

// Un límite del plan: el % usado y cuándo se renueva.
export type Limite = { pct: number; renueva: string | null }

let interactiva = false

export const fijarInteractiva = (valor: boolean): void => {
  interactiva = valor
}

// Si hay quien mire la banda y el panel: el arranque de la sesión lo dice.
export const esInteractiva = (): boolean => interactiva

// Una herramienta que falla no se lleva a las demás por delante: su fallo queda aquí y la pestaña
// Sesión lo enseña con el nombre de la herramienta (`donde`). Se borra cuando vuelve a ir bien lo que
// falló, que es lo que dice `clave`: trabajos distintos de una herramienta no se borran el fallo.
const MAX_FALLOS = 20
let fallos: { clave: string; donde: string; texto: string }[] = []

export const motivo = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export const anotarFallo = (donde: string, error: unknown, clave: string = donde): void => {
  const texto = resumir(motivo(error))
  fallos = [...fallos.filter(fallo => fallo.clave !== clave), { clave, donde, texto }].slice(-MAX_FALLOS)
}

export const quitarFallo = (clave: string): void => {
  fallos = fallos.filter(fallo => fallo.clave !== clave)
}

export const leerFallos = (): readonly { donde: string; texto: string }[] => fallos

// Espera un trabajo sin dejar que su fallo salga de aquí; dice si fue bien.
export async function aislar(
  donde: string,
  trabajo: Promise<unknown>,
  clave: string = donde,
): Promise<boolean> {
  try {
    await trabajo
    quitarFallo(clave)

    return true
  } catch (error) {
    anotarFallo(donde, error, clave)

    return false
  }
}

// Lo mismo para lo que pide la persona desde el panel: si falla lo ve al momento.
export async function aislarAhora(
  $: EngineInterface,
  donde: string,
  trabajo: Promise<unknown>,
  clave: string = donde,
): Promise<void> {
  if (!(await aislar(donde, trabajo, clave))) {
    $.ui.toast(`${donde}: ${fallos.find(fallo => fallo.clave === clave)?.texto ?? ''}`)
    $.ui.invalidate('ui.render')
  }
}

// Una ruta del proyecto: el directorio de trabajo puede moverse, la raíz de la sesión no.
export const enProyecto = (raiz: string, ruta: string): string =>
  `${raiz.replace(/[\\/]+$/, '')}/${ruta}`

// La caché leída no cuenta: es el mismo contexto releído en cada petición.
export const gasto = (usage: ModelUsage): number =>
  usage.input_tokens + usage.output_tokens + usage.cache_creation_input_tokens

// Lo que la petición envió al modelo: la misma medida que da `$.session.usage()`.
export const enviado = (usage: ModelUsage): number =>
  usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens

export const conPuntos = (tokens: number): string =>
  String(tokens).replace(/\B(?=(\d{3})+(?!\d))/g, '.')

export const colorUso = (pct: number): string => USOS.find(tramo => pct <= tramo.hasta)?.color ?? ROJO

// Pasada su renovación, la cifra de un límite ya no dice nada hasta que llegue otra.
export const vigente = <T extends Limite>(limit: T | null | undefined, now: number): T | null =>
  limit && (limit.renueva === null || !(Date.parse(limit.renueva) <= now)) ? limit : null

// «vie 9, 22:00», en la hora del equipo.
export const cuando = (iso: string): string | null => {
  const date = new Date(iso)

  if (Number.isNaN(date.getTime())) {
    return null
  }

  const hora = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`

  return `${DIAS[date.getDay()] ?? ''} ${date.getDate()}, ${hora}`
}

export const dos = (n: number): string => String(n).padStart(2, '0')

// La hora del equipo: el módulo ve la zona horaria del sistema.
export const hora = (ms: number): string => {
  const date = new Date(ms)

  return `${dos(date.getHours())}:${dos(date.getMinutes())}:${dos(date.getSeconds())}`
}

export const horaCorta = (ms: number): string => hora(ms).slice(0, 5)

export const duracion = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))

  if (s < 60) {
    return `${s}s`
  }

  if (s < 3600) {
    return `${Math.floor(s / 60)}m${dos(s % 60)}s`
  }

  return `${Math.floor(s / 3600)}h${dos(Math.floor((s % 3600) / 60))}m`
}

// Sin caracteres de control: uno solo en un texto hace que el motor no dibuje el panel entero.
export const limpio = (text: string): string =>
  text
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

export const resumir = (text: string): string => {
  const line = limpio(text)

  return line.length > TEXTO_TAREA ? `${line.slice(0, TEXTO_TAREA - 1)}…` : line
}

export const sello = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace(/[T:]/g, '-')

export const fecha = (ms: number): string => {
  const date = new Date(ms)

  return `${date.getFullYear()}-${dos(date.getMonth() + 1)}-${dos(date.getDate())} ${hora(ms).slice(0, 5)}`
}

export const pct = (parte: number, total: number): string =>
  total <= 0 ? '0 %' : `${Math.round((parte / total) * 100)} %`
