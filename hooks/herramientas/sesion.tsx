import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import type { Agente, Compactacion, Paso } from '../../types'
import {
  aislarAhora,
  colorUso,
  conPuntos,
  cuando,
  duracion,
  enProyecto,
  esInteractiva,
  fecha,
  hora,
  leerFallos,
  pct,
  sello,
  vigente,
} from '../util'
import type { Limite } from '../util'
import { leerAgentes, leerRetirados, leerTareas, trabajado } from './agentes'
import { colorDe } from './banda'
import { alternarCache, leerCache, lineasCache } from './cache'
import { leerEfectivo } from './compactado'
import { leerContexto, leerDeAgentes, leerGastados } from './contador'
import { leerCincoHoras, leerPorModelo, leerSemana } from './limites'
import { leerPasos, leerPasosRetirados } from './tareas'

// El histórico es un Markdown por sesión en el proyecto, reescrito al acabar cada turno desde todo
// lo que pasó en ella: el plan de tareas, también los anteriores, los agentes de cada tarea y las
// compactaciones. Solo en sesiones interactivas.
const CARPETA_HISTORICO = '.claude/historial'
// Lo que llega del motor y de PostCompact de una misma compactación se junta si llega así de seguido.
const MISMA_COMPACTACION_MS = 120_000
const MAX_COMPACTACIONES = 50

const compactaciones = atom({ plugin: 'tokens-sesion', key: 'compactaciones' } as const, [])
// Cuándo empezó el histórico de esta conversación (da nombre a su fichero) y dónde se guardó, con su
// ruta entera: el directorio de trabajo puede moverse y el fichero no debe repartirse por carpetas.
const nacida = atom({ plugin: 'tokens-sesion', key: 'nacida' } as const, null)
const historico = atom({ plugin: 'tokens-sesion', key: 'historico' } as const, null)

// Cuándo empezó la conversación nueva: `$.state` no sobrevive a /clear.
let nacidaNueva: number | null = null
// La raíz donde nace el histórico: un worktree puede borrarse con lo que tenga dentro.
let raizFija: string | null = null
// Una escritura en marcha, y si le ha llegado algo nuevo que escribir.
let escribiendo = false
let otraVez = false
// Cambia al acabar la conversación: lo que seguía en vuelo ya no escribe. Hasta reponer, nada se escribe.
let conversacion = 0
let pausado = false

export const pausarHistorico = (): void => {
  conversacion += 1
  pausado = true
}

// Una compactación llega en dos avisos (lo que midió el motor y el fichero del resumen), en cualquier orden.
export async function anotarCompactacion(
  $: EngineInterface,
  dato: Partial<Omit<Compactacion, 'hora'>>,
): Promise<void> {
  const now = await $.clock.now()
  const campos = Object.keys(dato) as (keyof typeof dato)[]

  await update($, compactaciones, list => {
    const ultima = list.at(-1)
    const cabe =
      ultima !== undefined &&
      now - ultima.hora < MISMA_COMPACTACION_MS &&
      campos.every(campo => ultima[campo] === null)

    return cabe
      ? [...list.slice(0, -1), { ...ultima, ...dato }]
      : [...list, { hora: now, antes: null, despues: null, fichero: null, ...dato }]
  })
}

// El histórico entero, en Markdown.
const textoHistorico = (datos: {
  inicio: number
  now: number
  proyecto: string
  modelo: string
  turnos: number | null
  total: number
  agentesTok: number
  usd: number | null
  pasos: readonly Paso[]
  pasados: readonly Paso[]
  agentes: readonly Agente[]
  tareas: readonly { n: number; inicio: number; texto: string }[]
  compactaciones: readonly Compactacion[]
  leido: number
}): string => {
  const celda = (text: string): string => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ')
  const tablaPasos = (list: readonly Paso[]): string[] => [
    '| Estado | Paso | Inicio | Fin | Duración |',
    '|---|---|---|---|---|',
    ...list.map(
      paso =>
        `| ${paso.estado} | ${celda(paso.texto)} | ${paso.inicio === null ? '' : hora(paso.inicio)} | ${paso.fin === null ? '' : hora(paso.fin)} | ${paso.ms > 0 ? duracion(paso.ms) : ''} |`,
    ),
  ]
  const lines = [
    `# Sesión del ${fecha(datos.inicio)}`,
    '',
    `- Proyecto: ${datos.proyecto}`,
    `- Modelo: ${datos.modelo}`,
    `- Duración: ${duracion(datos.now - datos.inicio)} (hasta las ${hora(datos.now)})`,
    ...(datos.turnos === null ? [] : [`- Turnos: ${datos.turnos}`]),
    `- Tokens gastados: ${conPuntos(datos.total)} (hilo principal ${conPuntos(Math.max(0, datos.total - datos.agentesTok))}, agentes ${conPuntos(datos.agentesTok)})`,
    ...(datos.usd === null ? [] : [`- Coste a precio de API: ${datos.usd.toFixed(2)} $`]),
    `- Compactaciones: ${datos.compactaciones.length}`,
    ...(datos.leido > 0 ? [`- Caché mantenida en las pausas: ${conPuntos(datos.leido)} tokens leídos`] : []),
  ]

  if (datos.pasos.length > 0) {
    const hechos = datos.pasos.filter(paso => paso.estado === 'hecho').length
    lines.push(
      '',
      `## Plan de tareas (${hechos} de ${datos.pasos.length} hechas)`,
      '',
      ...tablaPasos(datos.pasos),
    )
  }

  if (datos.pasados.length > 0) {
    lines.push('', '## Planes anteriores', '', ...tablaPasos(datos.pasados))
  }

  if (datos.agentes.length > 0) {
    lines.push('', '## Agentes')

    for (const n of [...new Set(datos.agentes.map(agente => agente.tarea))].sort((a, b) => a - b)) {
      const suyos = datos.agentes.filter(agente => agente.tarea === n)
      const cabecera = datos.tareas.find(tarea => tarea.n === n)
      const total = suyos.reduce((sum, agente) => sum + agente.tokens, 0)
      lines.push(
        '',
        cabecera
          ? `### Tarea ${n} · ${hora(cabecera.inicio)} · ${conPuntos(total)} tok`
          : `### Antes de la primera tarea · ${conPuntos(total)} tok`,
        ...(cabecera && cabecera.texto !== '' ? ['', `> ${cabecera.texto}`] : []),
        '',
        '| Estado | Inicio | Fin | Duración | Tokens | Agente | Encargo | Modelo | Esfuerzo |',
        '|---|---|---|---|---|---|---|---|---|',
        ...suyos.map(
          agente =>
            `| ${agente.estado} | ${hora(agente.inicio)} | ${agente.fin === null ? '' : hora(agente.fin)} | ${agente.fin === null ? '' : duracion(trabajado(agente))} | ${conPuntos(agente.tokens)} | ${celda(agente.nombre === null ? agente.tipo : `${agente.nombre} (${agente.tipo})`)} | ${celda(agente.descripcion)} | ${agente.modelo.replace(/^claude-/, '')} | ${agente.esfuerzo ?? ''} |`,
        ),
      )
    }
  }

  if (datos.compactaciones.length > 0) {
    lines.push(
      '',
      '## Compactaciones',
      '',
      ...datos.compactaciones.map(
        one =>
          `- ${hora(one.hora)}` +
          (one.antes === null || one.despues === null
            ? ''
            : ` · ${conPuntos(one.antes)} → ${conPuntos(one.despues)} tokens`) +
          (one.fichero === null ? '' : ` · ${one.fichero}`),
      ),
    )
  }

  return `${lines.join('\n')}\n`
}

// El histórico tal como va, si hay algo que contar.
async function escribirHistorico($: EngineInterface): Promise<void> {
  const mia = conversacion
  // Escribir renueva la foto de `$.state`: un `next` lento pudo dejarla atrás.
  await update($, nacida, born => born)
  const lista = await leerAgentes($)
  const retirados = await leerRetirados($)
  const plan = await leerPasos($)
  const pasados = await leerPasosRetirados($)
  const hechas = await read($, compactaciones)

  if (lista.length + retirados.length + plan.length + pasados.length + hechas.length === 0) {
    return
  }

  const now = await $.clock.now()
  const inicio = (await read($, nacida)) ?? now

  if (mia !== conversacion) {
    return
  }

  await update($, nacida, () => inicio)
  const usage = await $.session.usage()
  const proyecto = raizFija ?? (await $.session.root())
  const file =
    (await read($, historico)) ??
    enProyecto(proyecto, `${CARPETA_HISTORICO}/sesion-${sello(inicio)}.md`)
  const texto = textoHistorico({
    inicio,
    now,
    proyecto,
    modelo: await $.session.model(),
    turnos: await $.session.turns().catch(() => null),
    total: await leerGastados($),
    agentesTok: await leerDeAgentes($),
    usd: usage.cost?.usd ?? null,
    pasos: plan,
    pasados,
    agentes: [...retirados, ...lista],
    tareas: await leerTareas($),
    compactaciones: hechas,
    leido: (await leerCache($)).leido,
  })

  if (mia !== conversacion) {
    return
  }

  await $.fs.write(file, texto)

  if (mia === conversacion) {
    await update($, historico, () => file)
  }
}

// Reescribe el histórico de la sesión. El fichero se escribe entero y sin temporal: dos escrituras
// a la vez se pisarían, así que la que llega con otra en marcha se hace al acabar aquella.
export async function historiar($: EngineInterface): Promise<void> {
  if (!esInteractiva() || pausado) {
    return
  }

  if (escribiendo) {
    otraVez = true

    return
  }

  escribiendo = true

  let fallo: unknown

  do {
    otraVez = false

    try {
      await escribirHistorico($)
      fallo = undefined
    } catch (error) {
      fallo = error
    }
  } while (otraVez && !pausado)

  escribiendo = false

  if (fallo !== undefined) {
    throw fallo
  }
}

// Al arrancar o recargar el mod la conversación sigue: su histórico conserva el nombre.
export async function arrancarSesion($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  raizFija = await $.session.root()
  await update($, nacida, born => born ?? now)
}

// Una conversación nueva (/clear, o al retomar otra) empieza su histórico de cero.
export async function reiniciarHistorico($: EngineInterface): Promise<void> {
  await update($, compactaciones, () => [])
  const now = await $.clock.now()
  nacidaNueva = now
  raizFija = await $.session.root()
  await update($, nacida, () => now)
  await update($, historico, () => null)
}

// Tras el borrado de `$.state`: el histórico sigue llamándose por el /clear, no por su primera escritura.
export async function reponerHistorico($: EngineInterface): Promise<void> {
  const born = nacidaNueva
  pausado = false

  if (born !== null) {
    await update($, nacida, value => value ?? born)
  }
}

export async function dibujarSesion(
  $: EngineInterface,
  e: RenderInput<'Pane'>,
): Promise<RenderElement> {
  const { Box, Text, Button } = $.ui.resolve(e)
  const now = await $.clock.now()
  const usage = await $.session.usage()
  const turnos = await $.session.turns().catch(() => null)
  const total = await leerGastados($)
  const agentesTok = Math.min(total, await leerDeAgentes($))
  const tokens = (await leerContexto($)) ?? usage.context.tokens ?? 0
  const rige = await leerEfectivo($)
  // Lo que ya se renovó no dice nada: igual que en la banda.
  const limite5 = vigente(await leerCincoHoras($), now)
  const limite7 = vigente(await leerSemana($), now)
  const propios = (await leerPorModelo($)).filter(one => vigente(one, now) !== null)
  const hechas = await read($, compactaciones)
  const file = await read($, historico)
  const raiz = await $.session.root()
  const plan = await leerPasos($)
  const lista = await leerAgentes($)
  const filas: RenderElement[] = []
  const dato = (etiqueta: string, valor: string, color?: string) =>
    filas.push(
      <Box flexDirection="row">
        <Text dimColor>{etiqueta.padEnd(13)}</Text>
        <Box flexGrow={1} flexShrink={1}>
          <Text color={color} wrap="wrap">
            {valor}
          </Text>
        </Box>
      </Box>,
    )
  const titulo = (text: string) => filas.push(<Text> </Text>, <Text bold>{text}</Text>)
  const limite = (etiqueta: string, value: Limite | null) => {
    if (value === null) {
      return
    }

    const renueva = value.renueva === null ? null : cuando(value.renueva)
    const usado = Math.round(value.pct)
    dato(
      etiqueta,
      `${usado} % usado${renueva === null ? '' : ` · se renueva ${renueva}`}`,
      colorUso(usado),
    )
  }

  filas.push(<Text bold>Sesión</Text>)

  if (usage.startedAt > 0) {
    dato('Empezó', `${fecha(usage.startedAt)} · hace ${duracion(now - usage.startedAt)}`)
  }

  dato('Modelo', (await $.session.model()).replace(/^claude-/, ''))

  if (turnos !== null) {
    dato('Turnos', String(turnos))
  }

  titulo('Tokens')
  dato(
    'Contexto',
    `${conPuntos(tokens)}${rige === 0 ? '' : ` · se compacta a los ${conPuntos(rige)}`}`,
    colorDe(tokens),
  )
  dato('Gastado', conPuntos(total))
  dato('  principal', `${conPuntos(total - agentesTok)} (${pct(total - agentesTok, total)})`)
  dato('  agentes', `${conPuntos(agentesTok)} (${pct(agentesTok, total)})`)

  if (usage.cost !== undefined) {
    // Lo que costarían esas respuestas a precio de API; con un plan de suscripción es una equivalencia.
    dato('Coste API', `${usage.cost.usd.toFixed(2)} $`)
  }

  if (limite5 !== null || limite7 !== null || propios.length > 0) {
    titulo('Límites del plan')
    limite('5 horas', limite5)
    limite('Semana', limite7)

    for (const one of propios) {
      limite(`Semana ${one.nombre}`, one)
    }
  }

  titulo('Caché')

  for (const [etiqueta, texto] of await lineasCache($, now)) {
    dato(etiqueta, texto)
  }

  const guardada = await leerCache($)

  // Mantenerla exige un temporizador que siga vivo en la pausa: solo en la terminal.
  if (esInteractiva()) {
    filas.push(
      <Box flexDirection="row">
        <Text dimColor>{'Mantenerla'.padEnd(13)}</Text>
        <Button
          key="cache-viva"
          label={guardada.viva ? 'sí' : 'no'}
          variant={guardada.viva ? 'primary' : 'secondary'}
          onPress={() => {
            void aislarAhora($, 'Caché', alternarCache($), 'alternar-cache')
          }}
        />
      </Box>,
    )
  }

  if (guardada.nota !== null) {
    filas.push(
      <Text dimColor wrap="wrap">
        {guardada.nota}
      </Text>,
    )
  }

  titulo('Trabajo')
  dato(
    'Tareas',
    plan.length === 0
      ? 'sin plan'
      : `${plan.filter(paso => paso.estado === 'hecho').length} de ${plan.length} hechas`,
  )
  dato(
    'Agentes',
    lista.length === 0
      ? 'ninguno'
      : `${lista.length} · ${lista.filter(agente => agente.estado === 'en curso').length} en curso`,
  )

  titulo(hechas.length === 1 ? '1 compactación' : `${hechas.length} compactaciones`)

  for (const one of hechas.slice(-MAX_COMPACTACIONES)) {
    dato(
      hora(one.hora),
      one.antes === null || one.despues === null
        ? 'contexto compactado'
        : `${conPuntos(one.antes)} → ${conPuntos(one.despues)}`,
    )

    if (one.fichero !== null) {
      dato('', one.fichero)
    }
  }

  titulo('Histórico')
  filas.push(
    <Text dimColor={file === null} wrap="wrap">
      {file === null
        ? 'Se guarda al acabar el primer turno con tareas o agentes.'
        : file.startsWith(enProyecto(raiz, CARPETA_HISTORICO))
          ? file.slice(file.lastIndexOf(CARPETA_HISTORICO))
          : file}
    </Text>,
  )

  const fallos = leerFallos()

  if (fallos.length > 0) {
    titulo('Fallos')

    for (const fallo of fallos) {
      dato(fallo.donde, fallo.texto, 'error')
    }
  }

  return (
    <Box key="cuerpo" flexDirection="column">
      {filas}
    </Box>
  )
}
