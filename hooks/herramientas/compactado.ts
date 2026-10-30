import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import { anotarFallo, conPuntos, enProyecto, motivo, quitarFallo, sello } from '../util'

// El umbral se cambia arrastrando la marca de la barra (o con el comando) y se guarda en el
// almacén del mod, el mismo para todas las sesiones y proyectos del usuario; 0 lo quita y el motor
// compacta por su cuenta.
// Por debajo de UMBRAL_MIN el contexto vuelve a llenarse nada más compactar y el motor aborta el turno.
const COMANDO = 'tokens-compact'
const UMBRAL = 650_000
export const UMBRAL_MIN = 200_000
const UMBRAL_MAX = 950_000

// Quien compacta es el motor: lo hace solo, también a mitad de un turno, cuando el contexto llega
// a su ventana de compactado menos lo que reserva, o al porcentaje de CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
// si queda por debajo. El mod pone la ventana que deja ese punto en el umbral del usuario.
const VENTANA_MIN = 100_000
const VENTANA_MAX = 1_000_000
const RESERVA_SALIDA = 20_000
const RESERVA_RESUMEN = 13_000

const CARPETA = '.claude/resumenes'
const INSTRUCCIONES =
  'Resumen exhaustivo para continuar la sesión sin perder nada. Conserva todos los puntos: ' +
  'el objetivo y cada petición del usuario, las decisiones tomadas y su porqué, los ficheros ' +
  'creados o modificados con sus rutas, los comandos y resultados relevantes, los errores y ' +
  'cómo se resolvieron, las tareas pendientes y el paso exacto por el que se iba.'

// El umbral que quiere el usuario, y el que rige en esta sesión con su modelo y su entorno.
const umbral = atom({ plugin: 'tokens-sesion', key: 'umbral' } as const, UMBRAL)
const efectivo = atom({ plugin: 'tokens-sesion', key: 'efectivo' } as const, UMBRAL)
const maximo = atom({ plugin: 'tokens-sesion', key: 'maximo' } as const, UMBRAL_MAX)
// Las veces que no se pudo guardar lo soltado en la barra: así sabe que debe devolver la marca.
const rechazos = atom({ plugin: 'tokens-sesion', key: 'rechazos' } as const, 0)

// Si el motor tiene el compactado automático apagado (/config) no hay ventana que valga, y si una
// política le niega al mod la variable, por qué.
let autoApagado = false
let negado: string | null = null

const vale = (value: unknown): value is number =>
  value === 0 ||
  (typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= UMBRAL_MIN &&
    value <= UMBRAL_MAX)

// Lo que escribe la persona: «850000», «850.000» o «850 000». Sin ningún dígito delante no es un número.
const leerNumero = (text: string): number =>
  /^\d[\d.\s_]*$/.test(text) ? Number(text.replace(/[.\s_]/g, '')) : NaN

// `rige` es el umbral de esta sesión; queda por debajo del pedido cuando el modelo o el entorno no dan más.
const estado = (limite: number, rige: number, motor: number): string =>
  autoApagado
    ? 'El compactado automático está apagado en Claude Code (/config): no se compacta solo.'
    : limite === 0
      ? `Sin umbral propio: el motor compacta por su cuenta a los ${conPuntos(motor)} tokens. Pon el del mod con /${COMANDO} ${UMBRAL}.`
      : `Compactado automático al llegar el contexto a ${conPuntos(rige)} tokens` +
        (rige < limite ? ` (el tope de esta sesión; pedidos ${conPuntos(limite)})` : '') +
        ', también a mitad de una tarea. Cámbialo arrastrando la marca ┃ de la barra.'

// El porcentaje de CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, si el motor lo va a tener en cuenta.
const porcentaje = (text: string | undefined): number | null => {
  const value = text === undefined ? NaN : parseFloat(text)

  return value > 0 && value <= 100 ? value : null
}

// Los tokens de contexto con los que el motor compacta para una ventana: su misma cuenta.
const umbralDe = (ventana: number, pct: number | null): number => {
  const util = ventana - RESERVA_SALIDA
  const base = util - RESERVA_RESUMEN

  return pct === null ? base : Math.min(Math.floor((util * pct) / 100), base)
}

// La ventana más pequeña con la que el motor compacta en `limite` o más.
const ventanaDe = (limite: number, pct: number | null): number => {
  const base = limite + RESERVA_SALIDA + RESERVA_RESUMEN
  const porPct = pct === null ? 0 : Math.ceil((limite * 100) / pct) + RESERVA_SALIDA

  return Math.min(VENTANA_MAX, Math.max(VENTANA_MIN, base, porPct))
}

// Guarda el resumen de una compactación en el proyecto. Si no se puede, sigue en la conversación:
// se avisa y ya está. Devuelve el fichero, o null si no hay.
export async function guardarResumen($: EngineInterface, text: string): Promise<string | null> {
  if (text.trim() === '') {
    return null
  }

  try {
    const file = `${CARPETA}/resumen-${sello(await $.clock.now())}.md`
    await $.fs.write(enProyecto(await $.session.root(), file), text)
    quitarFallo('Resumen')
    $.ui.toast(`Resumen de la sesión guardado en ${file}`)

    return file
  } catch (error) {
    const aviso = `No se pudo guardar el resumen: ${motivo(error)}`
    anotarFallo('Resumen', aviso)
    $.ui.toast(aviso)

    return null
  }
}

// Pone la ventana del proceso. Una política puede negarse de dos formas: contestando o rechazando.
async function ponerVentana($: EngineInterface, valor: string | undefined): Promise<string | null> {
  try {
    const { deny } = await $.env.set('CLAUDE_CODE_AUTO_COMPACT_WINDOW', valor)

    return deny ?? null
  } catch (error) {
    return motivo(error)
  }
}

// Lleva el umbral al motor: la ventana de compactado de este proceso, sin tocar los ajustes del usuario.
async function aplicar($: EngineInterface): Promise<void> {
  const limite = await read($, umbral)
  const pct = porcentaje(await $.env.get('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'))
  // El motor nunca compacta más tarde de lo que da la ventana del modelo.
  const modelo = Math.min(VENTANA_MAX, (await $.session.usage()).context.window)
  const tope = Math.max(UMBRAL_MIN, Math.min(UMBRAL_MAX, umbralDe(modelo, pct)))
  await update($, maximo, () => tope)
  const ventana = limite === 0 ? undefined : ventanaDe(limite, pct)
  negado = await ponerVentana($, ventana === undefined ? undefined : String(ventana))

  if (negado === null) {
    quitarFallo('Ventana')
  } else {
    anotarFallo('Ventana', negado)
  }

  if (autoApagado || limite === 0) {
    await update($, efectivo, () => 0)

    return
  }

  // Si la variable sigue como estaba, rige lo que dé la que hay.
  const puesta =
    negado === null ? ventana : Number(await $.env.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW'))
  const rige = Number.isFinite(puesta) ? (puesta ?? modelo) : modelo
  await update($, efectivo, () =>
    Math.min(negado === null ? limite : UMBRAL_MAX, umbralDe(Math.min(rige, modelo), pct)),
  )
}

// El umbral guardado manda sobre el de la sesión: otra sesión pudo cambiarlo.
export async function cargar($: EngineInterface): Promise<void> {
  const saved = await $.store.get('umbral')
  const limite = vale(saved) ? saved : UMBRAL
  await update($, umbral, () => limite)

  // Apagado sigue mirando: encenderlo en /config no avisa.
  if (autoApagado) {
    await mirarAuto($)
  }

  await aplicar($)
}

// Mira si el motor compacta solo. No hace falta en cada medida: cambia con /config, no con el trabajo.
async function mirarAuto($: EngineInterface): Promise<void> {
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    autoApagado = context.breakdown?.isAutoCompactEnabled === false
    quitarFallo('Desglose')
  } catch (error) {
    anotarFallo('Desglose', error)
  }
}

// Primero se aplica y solo si el motor lo admite se guarda: lo guardado rige en todas las sesiones.
async function fijar($: EngineInterface, limite: number): Promise<void> {
  const anterior = await read($, umbral)
  await mirarAuto($)
  await update($, umbral, () => limite)
  await aplicar($)

  if (negado !== null) {
    const motivo = negado
    await update($, umbral, () => anterior)
    await aplicar($)
    throw new Error(motivo)
  }

  try {
    await $.store.set('umbral', limite)
  } catch (error) {
    await update($, umbral, () => anterior)
    await aplicar($)
    throw error
  }
}

export async function leerEfectivo($: EngineInterface): Promise<number> {
  return read($, efectivo)
}

export async function leerMaximo($: EngineInterface): Promise<number> {
  return read($, maximo)
}

export async function leerRechazos($: EngineInterface): Promise<number> {
  return read($, rechazos)
}

// Las instrucciones que lleva cada compactación, sin repetirlas si ya venían.
export const conInstrucciones = (instructions: string | undefined): string =>
  instructions?.includes(INSTRUCCIONES)
    ? instructions
    : [instructions, INSTRUCCIONES].filter(Boolean).join('\n\n')

export async function arrancarCompactado($: EngineInterface): Promise<void> {
  await $.command.register({
    name: COMANDO,
    description: 'Umbral de tokens de contexto con el que se compacta la sesión',
    argumentHint: '[tokens | 0]',
    immediate: true,
  })
  await mirarAuto($)
  await cargar($)
}

export function registrarCompactado(on: On): void {
  on('command.run', { command: 'tokens-compact' }, async ($, e) => {
    const typed = e.args.trim()

    try {
      if (typed === '') {
        await mirarAuto($)
        await cargar($)
      } else {
        const value = leerNumero(typed)

        if (!vale(value)) {
          return {
            text: `«${typed}» no vale: un número de ${conPuntos(UMBRAL_MIN)} a ${conPuntos(UMBRAL_MAX)}, o 0 para dejar el del motor.`,
          }
        }

        await fijar($, value)
      }
    } catch (error) {
      return { text: `No se pudo cambiar el umbral: ${motivo(error)}` }
    }

    const pct = porcentaje(await $.env.get('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'))
    const modelo = Math.min(VENTANA_MAX, (await $.session.usage()).context.window)

    return { text: estado(await read($, umbral), await read($, efectivo), umbralDe(modelo, pct)) }
  })

  // La barra avisa de dónde se soltó la marca. Viene de código: se comprueba como cualquier entrada.
  on('ui.message', async ($, e, next) => {
    const data = e.data

    if (typeof data === 'object' && data !== null && 'umbral' in data) {
      const limite = data.umbral

      if (limite !== 0 && vale(limite)) {
        try {
          await fijar($, limite)
          const rige = await read($, efectivo)
          $.ui.toast(
            autoApagado
              ? estado(limite, rige, 0)
              : `Compactado automático a los ${conPuntos(rige)} tokens de contexto`,
          )
        } catch (error) {
          await update($, rechazos, veces => veces + 1)
          $.ui.toast(`No se pudo cambiar el umbral: ${motivo(error)}`)
        }
      }
    }

    return next(e)
  })
}
