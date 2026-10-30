import { atom, read, update } from 'claude-code'
import type { EngineInterface, SessionRateLimit } from 'claude-code'

import { esInteractiva } from '../util'
import type { Limite } from '../util'

// Los límites del plan: el motor da el semanal (todos los modelos) y el de cinco horas.
const LIMITE_SEMANAL = 'seven_day'
// El límite semanal propio de un modelo (el de Fable, donde el plan lo tiene) no llega a los mods:
// se le pregunta a Claude Code con su `/usage`, en un proceso aparte que no carga nada del usuario
// ni guarda la sesión, y que no llama al modelo. Si algún día lo hiciera, que sea al más barato.
const CONSULTA = [
  'claude',
  '-p',
  '/usage',
  '--safe-mode',
  '--no-session-persistence',
  '--model',
  'haiku',
] as const
const CONSULTA_MS = 30_000
// Con cada respuesta del hilo principal, si la última consulta tiene ya este tiempo, se repite.
const REFRESCO_MS = 5 * 60_000
// Tras una consulta fallida se espera más cada vez: el fallo suele ser pasajero.
const ESPERAS_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000] as const
const DIA_MS = 24 * 60 * 60_000
// Las renovaciones de `/usage` se llevan al múltiplo de 5 minutos más cercano.
const REDONDEO_MS = 5 * 60_000
// «Current week (Fable): 12% used · resets Oct 9, 10pm (Europe/Madrid)»
const LINEA_USO = /^Current week \((.+?)\): (\d+(?:\.\d+)?)% used(?: · resets ([^(\n]+?))?(?: \(.*\))?\s*$/gm
const TODOS = 'all models'
const MESES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

// El límite semanal: % usado y cuándo se renueva; null hasta que el motor lo da con una respuesta.
const semana = atom({ plugin: 'tokens-sesion', key: 'semana' } as const, null)

// Los límites semanales propios de un modelo, por el nombre que les da `/usage` («Fable»).
const porModelo = atom({ plugin: 'tokens-sesion', key: 'porModelo' } as const, [])
const cincoHoras = atom({ plugin: 'tokens-sesion', key: 'cincoHoras' } as const, null)

// La consulta de los límites por modelo: cuándo fue la última, si hay una en marcha, cuántas han
// fallado seguidas y si ya no merece repetirla en esta sesión (el plan no tiene ninguno).
let consultado = 0
let consultando = false
let fallidas = 0
let sinConsulta = false

// De los límites que da el motor, el semanal; sin él (otro plan, o aún sin respuestas), nada.
export async function limitar($: EngineInterface, limits: readonly SessionRateLimit[]): Promise<void> {
  const found = limits.find(limit => limit.kind === LIMITE_SEMANAL)
  const value = found ? { pct: found.percentUsed, renueva: found.resetsAt ?? null } : null
  await update($, semana, () => value)
  const corto = limits.find(limit => limit.kind === 'five_hour')
  const cinco = corto ? { pct: corto.percentUsed, renueva: corto.resetsAt ?? null } : null
  await update($, cincoHoras, () => cinco)
}

// El instante de un «Oct 9, 10pm», un «Jan 2, 2027, 9pm» o un «4:59am» de `/usage`, que vienen en la
// hora del equipo.
const instante = (text: string, now: number): string | null => {
  const found =
    /^(?:([A-Za-z]{3})[a-z]* (\d{1,2})(?:, (\d{4}))?, )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(
      text.trim(),
    )

  if (!found) {
    return null
  }

  const hoy = new Date(now)
  const mes = found[1] === undefined ? hoy.getMonth() : MESES.indexOf(found[1].toLowerCase())

  if (mes < 0) {
    return null
  }

  const ano = found[3] === undefined ? hoy.getFullYear() : Number(found[3])
  const dia = found[2] === undefined ? hoy.getDate() : Number(found[2])
  const horas = (Number(found[4]) % 12) + (found[6]?.toLowerCase() === 'pm' ? 12 : 0)
  const date = new Date(ano, mes, dia, horas, Number(found[5] ?? 0))

  // Una renovación nunca queda atrás: sin fecha es la de mañana; con ella, la del año que viene.
  if (found[1] === undefined && date.getTime() < now) {
    date.setDate(date.getDate() + 1)
  } else if (found[3] === undefined && date.getTime() < now - DIA_MS) {
    date.setFullYear(date.getFullYear() + 1)
  }

  // `/usage` da unas veces «10pm» y otras «9:59pm» para la misma renovación.
  return new Date(Math.round(date.getTime() / REDONDEO_MS) * REDONDEO_MS).toISOString()
}

// Los límites semanales por modelo que hay en la salida de `/usage`; null si no es lo esperado.
const porModeloDe = (
  text: string,
  now: number,
): { nombre: string; pct: number; renueva: string | null }[] | null => {
  const found = [...text.matchAll(LINEA_USO)]

  if (found.length === 0) {
    return null
  }

  return found
    .filter(line => line[1]?.toLowerCase() !== TODOS)
    .map(line => ({
      nombre: line[1] ?? '',
      pct: Number(line[2]),
      renueva: line[3] === undefined ? null : instante(line[3], now),
    }))
}

// Lanza `/usage` y devuelve lo que dice; null si la consulta falló, que suele ser pasajero.
async function preguntarUso(
  $: EngineInterface,
  now: number,
): Promise<{ nombre: string; pct: number; renueva: string | null }[] | null> {
  try {
    const done = await $.process.run([...CONSULTA], { stdin: '', timeoutMs: CONSULTA_MS })

    return done.exitCode === 0 ? (porModeloDe(done.stdout, now) ?? []) : null
  } catch {
    return null
  }
}

// Pone al día los límites por modelo. Lo que falla se reintenta con más espera cada vez, y mientras
// tanto rige el límite general: una cifra vieja engaña más que ninguna. Donde el plan no tiene
// ninguno no se vuelve a preguntar.
export async function consultar($: EngineInterface): Promise<void> {
  if (!esInteractiva() || sinConsulta || consultando) {
    return
  }

  const now = await $.clock.now()
  const espera = fallidas === 0 ? REFRESCO_MS : ESPERAS_MS[Math.min(fallidas, ESPERAS_MS.length) - 1]

  if (consultado !== 0 && now - consultado < (espera ?? REFRESCO_MS)) {
    return
  }

  consultando = true
  consultado = now

  try {
    const limits = await preguntarUso($, now)
    fallidas = limits === null ? fallidas + 1 : 0
    sinConsulta = limits?.length === 0
    await update($, porModelo, () => limits ?? [])
  } finally {
    consultando = false
  }
}

export async function arrancarLimites($: EngineInterface): Promise<void> {
  // Al recargar el mod a media sesión el motor ya los tiene.
  await limitar($, (await $.session.usage()).rateLimits)
}

// Cada sesión empieza con la consulta sin hacer.
export const olvidarConsulta = (): void => {
  consultado = 0
  fallidas = 0
  sinConsulta = false
}

export async function leerSemana($: EngineInterface): Promise<Limite | null> {
  return read($, semana)
}

export async function leerCincoHoras($: EngineInterface): Promise<Limite | null> {
  return read($, cincoHoras)
}

export async function leerPorModelo(
  $: EngineInterface,
): Promise<{ nombre: string; pct: number; renueva: string | null }[]> {
  return read($, porModelo)
}
