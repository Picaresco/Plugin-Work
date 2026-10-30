import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, SessionCompactInput } from 'claude-code'

import type { Cache } from '../../types'
import {
  aislar,
  conPuntos,
  duracion,
  enviado,
  esInteractiva,
  horaCorta,
  motivo,
  resumir,
} from '../util'
import { leerContexto, sumarCompactacion } from './contador'

// El motor guarda en caché la conversación ya enviada: mientras dura, cada petición la relee casi
// gratis; si caduca, la siguiente la reescribe entera a precio de escritura. Con el ajuste activado
// y la sesión en reposo, el mod hace poco antes de que caduque una consulta mínima sobre la propia
// conversación (`$.model.fork`: lee la caché y renueva su plazo sin dejar nada en la conversación).
// Es la regla del alquiler de esquís: se paga el «alquiler» (un latido por hora) hasta que lo
// pagado iguala lo que cuesta «comprar» (compactar, o dejarla caducar); entonces se hace lo más
// barato de esas dos cosas y se para. Así, en una sesión a la que no se vuelve se pierde como mucho
// lo que habría costado una caducidad.
const CLAVE_CACHE = 'cacheViva'
const TTL_LARGO_MS = 60 * 60_000
const TTL_CORTO_MS = 5 * 60_000
// El latido sale con este margen antes de que caduque; el plazo cuenta desde que empieza la petición.
const MARGEN_MS = 8 * 60_000
const HOLGURA_MS = 20_000
const REINTENTO_MS = 3 * 60_000
// El reposo del motor no sale antes de los 54 minutos: esto no es una pausa si no pasan estos.
const PAUSA_MS = 50 * 60_000
// Como mucho estos latidos por pausa, salga lo que salga la cuenta.
const MAX_LATIDOS = 12
// Por debajo de este contexto no se compacta: no hay nada que ganar.
const MIN_COMPACTAR = 150_000
// Lo que se estima que ocupa el resumen de una compactación y el contexto que deja.
const RESUMEN_TOKENS = 15_000
const TRAS_COMPACTAR = 45_000
// Precios en veces el de un token de entrada: escribir la caché de una hora, un token de salida
// y leer la caché según el modelo.
const PRECIO_ESCRITURA = 2
const PRECIO_SALIDA = 5
const precioLectura = (modelo: string): number =>
  /fable-5-1|mythos-5-1/i.test(modelo) ? 0.025 : /opus-5-5/i.test(modelo) ? 0.05 : 0.1
const LATIDO = 'Responde solo con la palabra: ok'
// Un acierto es leer de caché al menos esta parte de lo enviado.
const ACIERTO = 0.5
// Lo que se lee en la conversación cuando la caché viva frena la compactación en reposo del motor.
const VETO = 'La caché viva sigue manteniendo la conversación en esta pausa.'

const cache = atom({ plugin: 'tokens-sesion', key: 'cache' } as const, {
  viva: false,
  ttl: 'sin confirmar',
  ultima: null,
  latidos: 0,
  leido: 0,
  nota: null,
})

// El temporizador del próximo latido, si hay uno en marcha, y el testigo: cambia con cada parada,
// y lo que seguía en vuelo con el anterior ya no escribe nada.
let cancelarLatido: (() => void) | null = null
let latidoEnVuelo = false
let testigo = 0
// Lo que envió la petición anterior: el acierto se mide contra eso, no contra lo que se añade ahora.
let enviadosAntes = 0
// Con un turno del hilo principal en marcha no hay pausa que cubrir.
let enTurno = false
// Tras compactar o cambiar de modelo, el siguiente fallo de caché no dice nada de su duración.
let prefijoNuevo = true
let modeloAnterior = ''
// Lo que se sabe de la duración: `$.state` no sobrevive a /clear, y la caché sigue durando lo mismo.
let ttlConocido: Cache['ttl'] = 'sin confirmar'
// Las compactaciones vistas, y si la que corre la ha pedido este módulo.
let compactadas = 0
let compactandoYo = false

// Lo que cuesta cada salida con `contexto` tokens, en tokens a precio de entrada, y lo que se decide:
// cuántos latidos como mucho y qué se hace después.
const planCache = (
  contexto: number,
  modelo: string,
  sePuede = true,
): { veces: number; final: 'compactar' | 'caducar' } => {
  const lectura = precioLectura(modelo)
  const latido = contexto * lectura
  const caducar = contexto * (PRECIO_ESCRITURA - lectura)
  const compactar =
    contexto * lectura + RESUMEN_TOKENS * PRECIO_SALIDA + TRAS_COMPACTAR * PRECIO_ESCRITURA
  const final =
    sePuede && contexto >= MIN_COMPACTAR && compactar < caducar ? 'compactar' : 'caducar'
  const tope = final === 'compactar' ? compactar : caducar

  return { veces: latido <= 0 ? 0 : Math.min(MAX_LATIDOS, Math.floor(tope / latido)), final }
}

const pausaDe = (latidos: number): string => duracion(latidos * (TTL_LARGO_MS - MARGEN_MS))

export const pararLatido = (): void => {
  testigo += 1
  cancelarLatido?.()
  cancelarLatido = null
}

// Programa el próximo latido para poco antes de que caduque la caché, si toca mantenerla.
export async function armarLatido($: EngineInterface): Promise<void> {
  pararLatido()
  const mio = testigo
  const estado = await read($, cache)

  if (!esInteractiva() || !estado.viva || estado.ttl !== '1h' || estado.ultima === null) {
    return
  }

  const espera = estado.ultima + TTL_LARGO_MS - MARGEN_MS - (await $.clock.now())

  if (mio !== testigo) {
    return
  }

  const timer = $.clock.after(Math.max(1_000, espera), () => {
    void aislar('Caché', latirConAviso($))
  })
  cancelarLatido = () => timer.cancel()
}

// Lo que falle en un latido se queda en la nota de la pestaña Sesión.
async function latirConAviso($: EngineInterface): Promise<void> {
  const mio = testigo
  latidoEnVuelo = true

  try {
    await latir($, mio)
  } catch (error) {
    if (mio === testigo) {
      const nota = resumir(`La caché no se pudo mantener: ${motivo(error)}`)
      await update($, cache, now => ({ ...now, nota }))
    }
  } finally {
    latidoEnVuelo = false
  }
}

// Compactar sin que nadie lo pida, solo donde el motor también lo haría. Si no se puede saber, no.
async function sePuedeCompactar($: EngineInterface): Promise<boolean> {
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })

    return (
      context.breakdown?.isAutoCompactEnabled !== false &&
      (await $.settings.read({ key: 'idleCompaction' })) !== false
    )
  } catch {
    return false
  }
}

async function latir($: EngineInterface, mio: number): Promise<void> {
  cancelarLatido = null
  const estado = await read($, cache)

  if (!estado.viva || estado.ttl !== '1h' || estado.ultima === null || enTurno) {
    return
  }

  const inicio = await $.clock.now()

  if (inicio - estado.ultima >= TTL_LARGO_MS - HOLGURA_MS) {
    await update($, cache, now => ({ ...now, nota: 'La caché caducó antes de poder mantenerla.' }))

    return
  }

  const tokens = (await leerContexto($)) ?? 0
  const { veces, final } = planCache(tokens, await $.session.model(), await sePuedeCompactar($))

  if (estado.latidos < veces) {
    const reply = await $.model.fork({ prompt: LATIDO })

    if ('usage' in reply && reply.usage) {
      await sumarCompactacion($, undefined, reply.usage)
    }

    if (mio !== testigo) {
      return
    }

    const leido = 'usage' in reply ? (reply.usage?.cache_read_input_tokens ?? 0) : 0

    // Decide lo leído: un fork que acaba sin texto también renueva la caché.
    if (leido >= tokens * ACIERTO) {
      await update($, cache, now => ({
        ...now,
        ultima: inicio,
        latidos: now.latidos + 1,
        leido: now.leido + leido,
        nota: `Mantenida a las ${horaCorta(inicio)} (${now.latidos + 1} de ${veces} en esta pausa).`,
      }))
      await armarLatido($)

      return
    }

    // Un fallo de la API no dice nada de la caché: se reintenta mientras quede plazo.
    if (!reply.isAnswered && (reply.reason === 'api-error' || reply.reason === 'aborted')) {
      if (inicio + REINTENTO_MS < estado.ultima + TTL_LARGO_MS - HOLGURA_MS) {
        const timer = $.clock.after(REINTENTO_MS, () => {
          void aislar('Caché', latirConAviso($))
        })
        cancelarLatido = () => timer.cancel()
        await update($, cache, now => ({
          ...now,
          nota: 'No se pudo mantener la caché: se reintenta.',
        }))

        return
      }

      if (final === 'compactar') {
        await compactarEnPausa($, estado.latidos + 1, inicio)

        return
      }

      await update($, cache, now => ({
        ...now,
        nota: 'No se pudo mantener la caché: la consulta falló.',
      }))

      return
    }

    // Respondió y no leyó nada: la duración que se creía ya no vale hasta volver a confirmarla.
    ttlConocido = 'sin confirmar'
    await update($, cache, now => ({
      ...now,
      ttl: ttlConocido,
      nota: 'La caché ya no estaba: no se sigue manteniendo en esta pausa.',
    }))

    return
  }

  if (final === 'compactar') {
    await compactarEnPausa($, estado.latidos + 1, inicio)

    return
  }

  await update($, cache, now => ({
    ...now,
    nota: `Tras ${pausaDe(now.latidos + 1)} de pausa sale más barato dejarla caducar: no se mantiene más.`,
  }))
}

// Compacta y dice cómo fue. Un /compact que no compacta no siempre rechaza: suele resolver con un
// texto que lo explica, así que lo que manda es si la compactación ha llegado a verse.
async function compactarEnPausa(
  $: EngineInterface,
  latidos: number,
  inicio: number,
): Promise<void> {
  const antes = compactadas
  let porque = ''
  compactandoYo = true

  try {
    porque = (await $.command.run({ command: 'compact', args: '' })).text ?? ''
  } catch (error) {
    porque = motivo(error)
  } finally {
    compactandoYo = false
  }

  const nota =
    compactadas > antes
      ? `Tras ${pausaDe(latidos)} de pausa salía más barato compactar: compactada a las ${horaCorta(inicio)}.`
      : resumir(`No se pudo compactar: ${porque}`)
  await update($, cache, now => ({ ...now, nota }))
}

// Cada petición del hilo principal dice cuánto dura la caché (si acertó tras un hueco de más de
// cinco minutos, es la de una hora) y reinicia la cuenta de la pausa.
export async function observarCache(
  $: EngineInterface,
  inicio: number,
  usage: ModelUsage & { model?: string },
): Promise<void> {
  const enviados = enviado(usage)
  const base = enviadosAntes > 0 ? Math.min(enviadosAntes, enviados) : enviados
  const acierto = enviados > 0 && usage.cache_read_input_tokens >= base * ACIERTO
  enviadosAntes = enviados
  const modelo = usage.model ?? ''
  const fiable = !prefijoNuevo && modelo === modeloAnterior
  prefijoNuevo = false
  modeloAnterior = modelo

  await update($, cache, now => {
    const hueco = now.ultima === null ? 0 : inicio - now.ultima
    const largo = hueco > TTL_CORTO_MS + HOLGURA_MS
    const ttl =
      largo && acierto
        ? '1h'
        : largo && !acierto && fiable && hueco < TTL_LARGO_MS - MARGEN_MS
          ? '5m'
          : now.ttl
    // Lo que pasó en la pausa se sigue leyendo durante la primera petición tras ella.
    const trasPausa = now.latidos > 0 || now.ultima === null || hueco >= TTL_LARGO_MS - MARGEN_MS
    ttlConocido = ttl

    return { ...now, ttl, ultima: inicio, latidos: 0, nota: trasPausa ? now.nota : null }
  })
  await armarLatido($)
}

export async function fijarCache($: EngineInterface, viva: boolean): Promise<void> {
  await $.store.set(CLAVE_CACHE, viva)
  await update($, cache, now => ({ ...now, viva, nota: null }))
  await armarLatido($)
}

export async function alternarCache($: EngineInterface): Promise<void> {
  await fijarCache($, !(await read($, cache)).viva)
}

// Lo que dice la pestaña Sesión de la caché, línea a línea: [etiqueta, texto].
export async function lineasCache($: EngineInterface, now: number): Promise<[string, string][]> {
  const estado = await read($, cache)
  const lines: [string, string][] = [
    [
      'Duración',
      estado.ttl === '1h' ? '1 hora' : estado.ttl === '5m' ? '5 minutos' : 'sin confirmar todavía',
    ],
  ]

  if (estado.ultima !== null && estado.ttl !== 'sin confirmar') {
    const fin = estado.ultima + (estado.ttl === '1h' ? TTL_LARGO_MS : TTL_CORTO_MS)
    lines.push(['Caduca', fin > now ? `a las ${horaCorta(fin)}` : 'ya caducó'])
  }

  if (estado.viva && esInteractiva()) {
    const { veces, final } = planCache(
      (await leerContexto($)) ?? 0,
      await $.session.model(),
      await sePuedeCompactar($),
    )
    lines.push([
      'Plan',
      estado.ttl === '1h'
        ? `mantenerla hasta ${pausaDe(veces + 1)} de pausa; después, ${final === 'compactar' ? 'compactar' : 'dejarla caducar'}`
        : estado.ttl === '5m'
          ? 'con caché de 5 minutos no compensa mantenerla'
          : 'empieza cuando se confirme que dura 1 hora',
    ])
  }

  if (estado.leido > 0) {
    lines.push(['Leído', `${conPuntos(estado.leido)} tokens de caché en mantenerla`])
  }

  return lines
}

export async function leerCache($: EngineInterface): Promise<Cache> {
  return read($, cache)
}

// El ajuste guardado manda sobre el de la sesión: otra sesión pudo cambiarlo, y `$.state` no
// sobrevive a /clear. Lo mismo la duración, que aquí sí se sabía.
export async function cargarCache($: EngineInterface): Promise<void> {
  const viva = (await $.store.get(CLAVE_CACHE)) === true
  const antes = await read($, cache)
  const ttl = antes.ttl === 'sin confirmar' ? ttlConocido : antes.ttl

  if (viva === antes.viva && ttl === antes.ttl) {
    return
  }

  await update($, cache, estado => ({ ...estado, viva, ttl }))

  if (viva !== antes.viva) {
    await armarLatido($)
  }
}

// El motor compacta solo una conversación parada desde los 200.000 tokens, a los 54 minutos: no
// cuenta los latidos como actividad. Con el plan de la caché en marcha se le frena, o la pausa no
// llegaría al primer latido que paga; lo que no sea una pausa con el plan armado sigue su curso.
export async function vetaReposo(
  $: EngineInterface,
  e: SessionCompactInput,
): Promise<string | null> {
  if (
    e.agentId !== undefined ||
    e.trigger !== 'auto' ||
    enTurno ||
    compactandoYo ||
    (cancelarLatido === null && !latidoEnVuelo)
  ) {
    return null
  }

  const estado = await read($, cache)

  if (!estado.viva || estado.ttl !== '1h' || estado.ultima === null) {
    return null
  }

  const pausa = (await $.clock.now()) - estado.ultima

  return estado.latidos > 0 || pausa >= PAUSA_MS ? VETO : null
}

// El prefijo que estaba en caché ya no vale: la siguiente petición real vuelve a armar el latido.
export async function olvidarPrefijo($: EngineInterface): Promise<void> {
  pararLatido()
  prefijoNuevo = true
  await update($, cache, now => ({ ...now, ultima: null, latidos: 0 }))
}

export async function alCompactar($: EngineInterface): Promise<void> {
  compactadas += 1
  await olvidarPrefijo($)
}

// Tras /model un latido se cobraría entero: relanza el contexto sin caché y no mantiene nada.
export async function alCambiarModelo($: EngineInterface, ttl: '5m' | '1h'): Promise<void> {
  ttlConocido = ttl
  await olvidarPrefijo($)
  await update($, cache, now => ({
    ...now,
    ttl,
    nota:
      now.viva && ttl === '1h' && esInteractiva()
        ? 'El modelo cambió: la caché empieza de cero y se mantendrá desde la próxima petición.'
        : now.nota,
  }))
}

// Una conversación nueva: la cuenta de la pausa vuelve a cero y lo que se sabía del prefijo no vale.
export async function reiniciarCache($: EngineInterface): Promise<void> {
  pararLatido()
  prefijoNuevo = true
  const { ttl } = await read($, cache)

  if (ttl !== 'sin confirmar') {
    ttlConocido = ttl
  }

  await update($, cache, estado => ({ ...estado, ultima: null, latidos: 0, leido: 0, nota: null }))
}

export const entrarTurno = (): void => {
  enTurno = true
}

export const salirTurno = (): void => {
  enTurno = false
}
