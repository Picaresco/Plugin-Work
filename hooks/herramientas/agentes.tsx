import { atom, read, update } from 'claude-code'
import type {
  AgentSpawnInput,
  EngineInterface,
  ModelUsage,
  RenderElement,
  RenderInput,
  TurnCompleteReason,
  TurnStepInput,
} from 'claude-code'

import type { Agente, Tarea } from '../../types'
import { ANCHO_LINEA, conPuntos, duracion, gasto, hora, limpio, resumir } from '../util'

// El registro guarda los últimos MAX_AGENTES agentes y las tareas que los lanzaron. Los que salen de
// él, por ese tope o por `/agentes limpiar`, siguen en `retirados` para el histórico de la sesión.
const MAX_AGENTES = 200
const MAX_RETIRADOS = 5_000

// Columnas de cada parte de la línea de un agente: «✓ 12:31:05 → 12:32:47» y «  1m42s    18.420 tok».
// Con ANCHO_LINEA todo va en una línea; con ANCHO_CIFRAS, horas y cifras juntas y el agente debajo;
// con menos, cada parte en su fila.
const ANCHO_CIFRAS = 44

const MARCAS = {
  'en curso': { signo: '●', color: 'warning' },
  ok: { signo: '✓', color: 'success' },
  abortado: { signo: '✗', color: 'error' },
  error: { signo: '✗', color: 'error' },
} as const

// La forma cambia con cada campo nuevo de `Agente`: lo que dejó una versión anterior no se lee.
const agentes = atom({ plugin: 'tokens-sesion', key: 'agentes' } as const, [], { shape: 'agente-2' })
const tareas = atom({ plugin: 'tokens-sesion', key: 'tareas' } as const, [])
const retirados = atom({ plugin: 'tokens-sesion', key: 'retirados' } as const, [])

// Tokens de un agente cuya primera petición llega antes de que su arranque quede anotado.
const sueltos = new Map<string, number>()
const MAX_SUELTOS = 50

// Lo que lleva trabajado un agente: un retomado no cuenta el hueco entre sus dos tramos.
export const trabajado = (agente: Agente): number =>
  agente.ms + (agente.fin === null ? 0 : agente.fin - agente.desde)

// Lo que cambia en un agente que vuelve a trabajar desde `desde`.
const reabierto = (agente: Agente, desde: number): Pick<Agente, 'ms' | 'desde' | 'fin' | 'estado'> => ({
  ms: trabajado(agente),
  desde,
  fin: null,
  estado: 'en curso',
})

// Cambia el agente `id` si está en el registro; dice si estaba. Se decide dentro de `update`, que
// reintenta con la versión real.
async function cambiar(
  $: EngineInterface,
  id: string,
  change: (agente: Agente) => Agente,
): Promise<boolean> {
  let known = false
  await update($, agentes, list => {
    known = list.some(agente => agente.id === id)

    return known ? list.map(agente => (agente.id === id ? change(agente) : agente)) : list
  })

  return known
}

// Lo mismo para un agente que `/agentes limpiar` retiró en curso: sigue trabajando.
async function cambiarRetirado(
  $: EngineInterface,
  id: string,
  change: (agente: Agente) => Agente,
): Promise<boolean> {
  let known = false
  await update($, retirados, list => {
    known = list.some(agente => agente.id === id && agente.fin === null)

    return known
      ? list.map(agente => (agente.id === id && agente.fin === null ? change(agente) : agente))
      : list
  })

  return known
}

export async function dibujarAgentes(
  $: EngineInterface,
  e: RenderInput<'Pane'>,
): Promise<RenderElement> {
  const { Box, Text } = $.ui.resolve(e)
  const list = await read($, agentes)
  const cabeceras = await read($, tareas)
  const ancho = e.props.bodyColumns

  if (list.length === 0) {
    return (
      <Box key="cuerpo" flexDirection="column">
        <Text dimColor>Sin agentes todavía.</Text>
      </Box>
    )
  }

  const filas: RenderElement[] = []
  // La tarea más reciente arriba; dentro de cada una, los agentes por orden de arranque.
  const numeros = [...new Set(list.map(agente => agente.tarea))].sort((a, b) => b - a)

  for (const n of numeros) {
    const suyos = list.filter(agente => agente.tarea === n)
    const cabecera = cabeceras.find(tarea => tarea.n === n)
    const total = suyos.reduce((sum, agente) => sum + agente.tokens, 0)
    const cuantos = suyos.length === 1 ? '1 agente' : `${suyos.length} agentes`

    if (filas.length > 0) {
      filas.push(<Text> </Text>)
    }

    filas.push(
      <Text bold wrap="wrap">
        {cabecera ? `Tarea ${n} · ${hora(cabecera.inicio)}` : 'Antes de la primera tarea'}
        {` · ${cuantos} · ${conPuntos(total)} tok`}
      </Text>,
    )

    if (cabecera && cabecera.texto !== '') {
      filas.push(
        <Text dimColor italic wrap="wrap">
          {cabecera.texto}
        </Text>,
      )
    }

    for (const agente of suyos) {
      const marca = MARCAS[agente.estado]
      const horas = ` ${hora(agente.inicio)} → ${agente.fin === null ? 'en curso' : hora(agente.fin)}`
      const tiempo = agente.fin === null ? '' : duracion(trabajado(agente))
      const cifras = `${tiempo.padStart(7)} ${conPuntos(agente.tokens).padStart(9)} tok`
      const quien = [
        agente.nombre === null ? agente.tipo : `${agente.nombre} (${agente.tipo})`,
        agente.descripcion,
        agente.modelo.replace(/^claude-/, ''),
        agente.esfuerzo ?? '',
      ]
        .filter(part => part !== '')
        .join(' · ')
      const cabeza = (
        <Text>
          <Text color={marca.color}>{marca.signo}</Text>
          {horas}
        </Text>
      )

      // En una sola línea solo si cabe entera; si no, el agente va debajo, en las líneas que necesite.
      if (ancho >= ANCHO_LINEA && ancho >= ANCHO_CIFRAS + 2 + quien.length) {
        filas.push(
          <Text>
            {cabeza}
            {`  ${cifras}  `}
            <Text dimColor>{quien}</Text>
          </Text>,
        )
        continue
      }

      if (ancho >= ANCHO_CIFRAS) {
        filas.push(
          <Text>
            {cabeza}
            {`  ${cifras}`}
          </Text>,
        )
      } else {
        filas.push(cabeza, <Text>{`  ${cifras.trimStart()}`}</Text>)
      }

      filas.push(
        <Box flexDirection="row">
          <Text>{'  '}</Text>
          <Box flexGrow={1} flexShrink={1}>
            <Text dimColor wrap="wrap">
              {quien}
            </Text>
          </Box>
        </Box>,
      )
    }
  }

  return <Box key="cuerpo" flexDirection="column">{filas}</Box>
}

// Cada petición de un agente suma a su línea; si ya había acabado es que sigue trabajando: no todo
// lo que despierta a un agente pasa por agent.spawn (un compañero de equipo con un mensaje).
export async function contarPaso(
  $: EngineInterface,
  sent: TurnStepInput,
  usage: ModelUsage | null | undefined,
): Promise<void> {
  const id = sent.agentId

  if (id === undefined || !usage) {
    return
  }

  const spent = gasto(usage)
  const now = await $.clock.now()
  const known = await cambiar($, id, agente => ({
    ...agente,
    ...(agente.fin === null ? {} : reabierto(agente, now)),
    tokens: agente.tokens + spent,
    esfuerzo: sent.effort === undefined ? null : String(sent.effort),
  }))

  const sumado =
    known || (await cambiarRetirado($, id, agente => ({ ...agente, tokens: agente.tokens + spent })))

  if (!sumado) {
    // Los ids que nunca arrancan como agente (una skill bifurcada, memoria) no se acumulan.
    if (sueltos.size >= MAX_SUELTOS) {
      sueltos.clear()
    }

    sueltos.set(id, (sueltos.get(id) ?? 0) + spent)
  }
}

export async function leerAgentes($: EngineInterface): Promise<Agente[]> {
  return read($, agentes)
}

export async function leerRetirados($: EngineInterface): Promise<Agente[]> {
  return read($, retirados)
}

export async function leerTareas($: EngineInterface): Promise<Tarea[]> {
  return read($, tareas)
}

export async function agenteDe($: EngineInterface, id: string): Promise<Agente | undefined> {
  return (await read($, agentes)).find(one => one.id === id)
}

// Cada prompt del hilo principal es una tarea; se guardan solo las que lanzaron algún agente.
export async function abrirTarea($: EngineInterface, texto: string): Promise<void> {
  const inicio = await $.clock.now()
  const conocidos = [...(await read($, agentes)), ...(await read($, retirados))]
  const usadas = new Set(conocidos.map(agente => agente.tarea))
  await update($, tareas, list => [
    ...list.filter(tarea => usadas.has(tarea.n)),
    { n: (list.at(-1)?.n ?? 0) + 1, inicio, texto: resumir(texto) },
  ])
}

// La tarea de un agente: la de quien lo lanzó o la de su workflow, que puede seguir corriendo con
// otro prompt por medio; si no, la del último prompt.
async function tareaDe($: EngineInterface, e: AgentSpawnInput): Promise<number> {
  const list = await read($, agentes)
  const padre = list.find(one => one.id === e.parentAgentId)
  const hermano = list.find(one => one.runId !== null && one.runId === e.workflow?.runId)

  return padre?.tarea ?? hermano?.tarea ?? (await read($, tareas)).at(-1)?.n ?? 0
}

// Un agente que acaba de arrancar entra en el registro.
export async function anotarAgente(
  $: EngineInterface,
  e: AgentSpawnInput,
  id: string,
  modelo: string,
  inicio: number,
): Promise<void> {
  const agente: Agente = {
    id,
    tipo: e.subagentType,
    nombre: e.name === undefined ? null : limpio(e.name),
    descripcion: limpio(e.description),
    modelo,
    tarea: await tareaDe($, e),
    inicio,
    fin: null,
    estado: 'en curso',
    tokens: 0,
    esfuerzo: null,
    hereda: e.fork || e.workflow !== undefined,
    ms: 0,
    desde: inicio,
    runId: e.workflow?.runId ?? null,
  }
  let fuera: Agente[] = []
  await update($, agentes, list => {
    const todos = [...list.filter(one => one.id !== id), agente]
    fuera = todos.slice(0, -MAX_AGENTES)

    return todos.slice(-MAX_AGENTES)
  })
  await retirar($, fuera)
  const antes = sueltos.get(id)

  if (antes !== undefined) {
    sueltos.delete(id)
    await cambiar($, id, one => ({ ...one, tokens: one.tokens + antes }))
  }
}

// Un agente retomado sigue en su línea y en su tarea, y está trabajando desde ya. Si ya no está en
// el registro vuelve a entrar.
export async function retomarAgente(
  $: EngineInterface,
  e: AgentSpawnInput,
  id: string,
  modelo: string,
  inicio: number,
): Promise<void> {
  const known = await cambiar($, id, agente => ({ ...agente, ...reabierto(agente, inicio) }))

  if (!known) {
    await anotarAgente($, e, id, modelo, inicio)
  }
}

export async function cerrarAgente(
  $: EngineInterface,
  id: string,
  reason: TurnCompleteReason,
): Promise<void> {
  const fin = await $.clock.now()
  const estado = reason === 'answer' ? 'ok' : reason === 'aborted' ? 'abortado' : 'error'
  const cierre = (agente: Agente): Agente => ({ ...agente, fin, estado })

  if (!(await cambiar($, id, cierre))) {
    await cambiarRetirado($, id, cierre)
  }
}

async function retirar($: EngineInterface, fuera: readonly Agente[]): Promise<void> {
  if (fuera.length > 0) {
    await update($, retirados, list => [...list, ...fuera].slice(-MAX_RETIRADOS))
  }
}

// `/agentes limpiar`: el panel se vacía, pero lo que ya pasó sigue en el histórico. La numeración
// de las tareas continúa, y el turno en curso conserva la suya.
export async function limpiarAgentes($: EngineInterface): Promise<void> {
  let fuera: Agente[] = []
  await update($, agentes, list => {
    fuera = list

    return []
  })
  await retirar($, fuera)
  sueltos.clear()
}

// Lo que dejó una versión anterior no se lee como agentes, pero sigue en el histórico.
export async function migrarAgentes($: EngineInterface): Promise<void> {
  const { value } = await $.state.get({ plugin: 'tokens-sesion', key: 'agentes' } as const)

  if (!Array.isArray(value) || value.length === 0) {
    return
  }

  const viejos = (value as unknown as Agente[]).map(agente => ({
    ...agente,
    ms: agente.ms ?? 0,
    desde: agente.desde ?? agente.inicio,
    runId: agente.runId ?? null,
  }))
  await update($, retirados, list => [...list, ...viejos].slice(-MAX_RETIRADOS))
  await update($, agentes, () => [])
}

// Los agentes en curso al acabar la conversación: los de fondo siguen vivos tras /clear.
let deFondo: Agente[] = []

export async function reponerAgentes($: EngineInterface): Promise<void> {
  if (deFondo.length === 0) {
    return
  }

  const vivos = await $.agent.list()
  const siguen = deFondo.filter(agente =>
    vivos.some(one => one.id === agente.id && one.status === 'running'),
  )
  deFondo = []

  // Lo que gastaron mientras tanto, sin fila donde sumar, está en `sueltos`.
  if (siguen.length > 0) {
    await update($, agentes, list => [
      ...siguen
        .filter(agente => !list.some(one => one.id === agente.id))
        .map(agente => ({ ...agente, tokens: sueltos.get(agente.id) ?? 0 })),
      ...list,
    ])
    siguen.forEach(agente => sueltos.delete(agente.id))
  }
}

// Una conversación nueva empieza de cero.
export async function reiniciarAgentes($: EngineInterface): Promise<void> {
  deFondo = (await read($, agentes))
    .filter(agente => agente.estado === 'en curso')
    .map(agente => ({ ...agente, tarea: 0, tokens: 0 }))
  await update($, agentes, () => [])
  await update($, retirados, () => [])
  await update($, tareas, () => [])
  sueltos.clear()
}
