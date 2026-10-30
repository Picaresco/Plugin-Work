import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  On,
  PromptComposeResult,
  RenderElement,
  RenderInput,
} from 'claude-code'

import type { Paso } from '../../types'
import { aislar, ANCHO_LINEA, duracion, horaCorta, leerFallos, resumir } from '../util'

// ---------------------------------------------------------------------------------------------
// Pestaña Tareas: los pasos del plan que Claude lleva durante el trabajo, con lo que tardó cada uno.
// ---------------------------------------------------------------------------------------------
// Salen de la lista de tareas del motor (TodoWrite, o TaskCreate y TaskUpdate). Donde el modelo no
// tiene ninguna de las dos, el mod le da una herramienta propia y le pide en el prompt que la use.
const PLAN = 'plan'
const PLAN_COMPLETO = 'mcp__tokens-sesion__plan'
const SECCION_PLAN = 'tokens-sesion:plan'
const TEXTO_PLAN = [
  '# Plan de la tarea',
  `En un trabajo de tres pasos o más, llama a ${PLAN_COMPLETO} con la lista completa de pasos antes de empezar,`,
  'y otra vez cada vez que un paso cambie de estado (pendiente, en_curso, hecho): la persona lo sigue en un panel.',
  'Un solo paso en_curso a la vez; márcalo hecho en cuanto acabe, no al final. Pasos cortos, en imperativo.',
  'No la uses para una pregunta ni para un cambio de un solo paso.',
].join('\n')
const MAX_PASOS = 200
const MAX_RETIRADOS = 5_000
// Cómo se llama esta herramienta en la lista de fallos de la pestaña Sesión.
export const FALLO_PLAN = 'Plan'
const ESTADOS_PASO = {
  hecho: { signo: '✓', color: 'success' },
  'en curso': { signo: '●', color: 'warning' },
  pendiente: { signo: '○', color: 'inactive' },
} as const
// Columnas de la barra de avance, y de la cola de cada paso: « 12:31 → 12:45  14m05s».
const BARRA_PASOS = 20
const COLA_PASO = 23

const pasos = atom({ plugin: 'tokens-sesion', key: 'pasos' } as const, [])
// Lo que ya salió del plan: el panel enseña el de ahora y el histórico, todos.
const pasosRetirados = atom({ plugin: 'tokens-sesion', key: 'pasosRetirados' } as const, [])

// El paso al entrar en `estado`: el tiempo que cuenta es el que pasa en curso, sumado si vuelve a estarlo.
const mover = (paso: Paso, estado: Paso['estado'], now: number): Paso => {
  if (paso.estado === estado) {
    return paso
  }

  const ms = paso.desde === null ? paso.ms : paso.ms + (now - paso.desde)

  if (estado === 'en curso') {
    return { ...paso, estado, inicio: paso.inicio ?? now, desde: now, fin: null }
  }

  return { ...paso, estado, ms, desde: null, fin: estado === 'hecho' ? now : null }
}

const pasoNuevo = (id: string, texto: string): Paso => ({
  id,
  texto,
  estado: 'pendiente',
  inicio: null,
  fin: null,
  ms: 0,
  desde: null,
})

// La lista entera llega de una vez: cada paso conserva sus tiempos si sigue con el mismo texto, y
// el que ya no está sale del plan.
const sincronizar = (
  list: readonly Paso[],
  nuevos: readonly { texto: string; estado: Paso['estado'] }[],
  now: number,
): { plan: Paso[]; fuera: Paso[] } => {
  const libres = [...list]
  const plan = nuevos.slice(0, MAX_PASOS).map((nuevo, n) => {
    const i = libres.findIndex(paso => paso.texto === nuevo.texto)
    const previo = i < 0 ? pasoNuevo(`p${now}-${n}`, nuevo.texto) : libres.splice(i, 1)[0]!

    return mover(previo, nuevo.estado, now)
  })

  return { plan, fuera: libres }
}

// Los pasos que `/agentes limpiar` quitó: si el modelo vuelve a nombrarlos, son los mismos.
let limpiados = new Set<string>()

// Lo que sale del plan se guarda para el histórico, y si estaba en curso ya no lo está.
async function retirarPasos($: EngineInterface, fuera: readonly Paso[]): Promise<void> {
  if (fuera.length === 0) {
    return
  }

  const now = await $.clock.now()
  const cerrados = fuera.map(paso =>
    mover(paso, paso.estado === 'en curso' ? 'pendiente' : paso.estado, now),
  )
  await update($, pasosRetirados, list => [...list, ...cerrados].slice(-MAX_RETIRADOS))
}

async function ponerPlan(
  $: EngineInterface,
  nuevos: readonly { texto: string; estado: Paso['estado'] }[],
): Promise<void> {
  const now = await $.clock.now()
  const textos = new Set(nuevos.map(nuevo => nuevo.texto))
  let vuelven: Paso[] = []
  await update($, pasosRetirados, list => {
    vuelven = list.filter(paso => limpiados.has(paso.id) && textos.has(paso.texto))

    return list.filter(paso => !vuelven.includes(paso))
  })
  let fuera: Paso[] = []
  await update($, pasos, list => {
    const hecho = sincronizar([...list, ...vuelven], nuevos, now)
    fuera = hecho.fuera

    return hecho.plan
  })
  await retirarPasos($, fuera)
}

const ESTADOS_MOTOR: Record<string, Paso['estado']> = {
  pending: 'pendiente',
  in_progress: 'en curso',
  completed: 'hecho',
  pendiente: 'pendiente',
  en_curso: 'en curso',
  hecho: 'hecho',
}

// Se mira que la clave sea propia: el estado lo escribe el modelo, y podría ser `constructor`.
const estadoDe = (value: string): Paso['estado'] | undefined =>
  Object.hasOwn(ESTADOS_MOTOR, value) ? ESTADOS_MOTOR[value] : undefined

// Lo que llega a la herramienta propia lo escribe el modelo: se comprueba antes de guardarlo.
const leerPlan = (value: unknown): { texto: string; estado: Paso['estado'] }[] | null => {
  if (!Array.isArray(value)) {
    return null
  }

  const list: { texto: string; estado: Paso['estado'] }[] = []

  for (const item of value) {
    const { texto, estado } = (item ?? {}) as { texto?: unknown; estado?: unknown }
    const known = typeof estado === 'string' ? estadoDe(estado) : undefined

    if (typeof texto !== 'string' || texto.trim() === '' || known === undefined) {
      return null
    }

    list.push({ texto: resumir(texto), estado: known })
  }

  return list
}

// Donde el modelo no tiene lista de tareas del motor, se le da la herramienta del plan.
async function ofrecerPlan($: EngineInterface): Promise<void> {
  const names = (await $.tool.list()).map(tool => tool.name)

  if (names.includes('TodoWrite') || names.includes('TaskCreate')) {
    return
  }

  await $.tool.register({
    name: PLAN,
    description:
      'Guarda el plan de la tarea en curso para que la persona lo siga en un panel: la lista completa de pasos, cada uno con su estado. Llámala al empezar un trabajo de varios pasos y cada vez que un paso cambie de estado.',
    // A la vista del modelo: el prompt le pide usarla, y detrás de ToolSearch le costaría una petición más.
    isDeferred: false,
    inputSchema: {
      type: 'object',
      properties: {
        pasos: {
          type: 'array',
          description: 'Todos los pasos del plan, en orden; sustituye a la lista anterior.',
          items: {
            type: 'object',
            properties: {
              texto: { type: 'string', description: 'El paso, corto y en imperativo.' },
              estado: { type: 'string', enum: ['pendiente', 'en_curso', 'hecho'] },
            },
            required: ['texto', 'estado'],
          },
        },
      },
      required: ['pasos'],
    },
  })
}

export async function dibujarTareas(
  $: EngineInterface,
  e: RenderInput<'Pane'>,
): Promise<RenderElement> {
  const { Box, Text } = $.ui.resolve(e)
  const list = await read($, pasos)
  const ancho = e.props.bodyColumns

  if (list.length === 0) {
    const fallo = leerFallos().find(one => one.donde === FALLO_PLAN)

    return (
      <Box key="cuerpo" flexDirection="column">
        <Text dimColor>Sin plan todavía.</Text>
        {fallo === undefined ? (
          <Text dimColor wrap="wrap">
            Aparece cuando Claude reparte el trabajo en pasos.
          </Text>
        ) : (
          <Text color="error" wrap="wrap">
            {`No se pudo ofrecer el plan a Claude: ${fallo.texto}`}
          </Text>
        )}
      </Box>
    )
  }

  const hechos = list.filter(paso => paso.estado === 'hecho').length
  const enCurso = list.filter(paso => paso.estado === 'en curso').length
  const pendientes = list.length - hechos - enCurso
  const total = list.reduce((sum, paso) => sum + paso.ms, 0)
  const llenas = Math.round((hechos / list.length) * BARRA_PASOS)
  const filas: RenderElement[] = [
    <Text>
      <Text color="success">{'█'.repeat(llenas)}</Text>
      <Text dimColor>{'░'.repeat(BARRA_PASOS - llenas)}</Text>
      <Text bold>{` ${hechos}/${list.length}`}</Text>
      {total > 0 ? ` · ${duracion(total)}` : ''}
    </Text>,
    <Text wrap="wrap">
      <Text color="success">{`✓ ${hechos} hechas`}</Text>
      {' · '}
      <Text color="warning">{`● ${enCurso} en curso`}</Text>
      {' · '}
      <Text color="inactive">{`○ ${pendientes} pendientes`}</Text>
    </Text>,
    <Text> </Text>,
  ]

  for (const paso of list) {
    const marca = ESTADOS_PASO[paso.estado]
    const tiempo =
      paso.estado === 'hecho'
        ? paso.inicio === null
          ? `hecho ${horaCorta(paso.fin ?? 0)}`
          : `${horaCorta(paso.inicio)} → ${horaCorta(paso.fin ?? 0)}  ${duracion(paso.ms).padStart(6)}`
        : paso.estado === 'en curso'
          ? `${horaCorta(paso.inicio ?? 0)} → en curso${paso.ms > 0 ? `  +${duracion(paso.ms)}` : ''}`
          : paso.ms > 0
            ? `pausado  ${duracion(paso.ms)}`
            : ''
    const texto = (
      <Text
        color={marca.color}
        bold={paso.estado === 'en curso'}
        strikethrough={paso.estado === 'hecho'}
        wrap="wrap"
      >
        {paso.texto}
      </Text>
    )

    // Con sitio, el paso y su tiempo en una fila; sin él, el tiempo debajo.
    if (ancho >= ANCHO_LINEA) {
      filas.push(
        <Box flexDirection="row">
          <Text color={marca.color}>{`${marca.signo} `}</Text>
          <Box flexGrow={1} flexShrink={1}>
            {texto}
          </Box>
          <Text dimColor>{` ${tiempo.padStart(COLA_PASO)}`}</Text>
        </Box>,
      )
      continue
    }

    filas.push(
      <Box flexDirection="row">
        <Text color={marca.color}>{`${marca.signo} `}</Text>
        <Box flexGrow={1} flexShrink={1}>
          {texto}
        </Box>
      </Box>,
    )

    if (tiempo !== '') {
      filas.push(<Text dimColor>{`  ${tiempo}`}</Text>)
    }
  }

  return (
    <Box key="cuerpo" flexDirection="column">
      {filas}
    </Box>
  )
}

// Los hooks de la pestaña Tareas: lo que el modelo anota en su lista, solo en el hilo principal.
export function registrarTareas(on: On): void {
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)

    if (ran.deny === undefined && ran.isError !== true && e.agentId === undefined) {
      await aislar(
        'Tareas',
        ponerPlan(
          $,
          e.todos.map(todo => ({
            texto: resumir(todo.content),
            estado: estadoDe(todo.status) ?? 'pendiente',
          })),
        ),
        'poner-plan',
      )
    }

    return ran
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)

    if (ran.deny === undefined && ran.isError !== true && e.agentId === undefined) {
      const id = `t${ran.result.task.id}`
      const texto = resumir(e.subject)
      let fuera: Paso[] = []
      await update($, pasos, list => {
        const todos = [...list.filter(paso => paso.id !== id), pasoNuevo(id, texto)]
        fuera = todos.slice(0, -MAX_PASOS)

        return todos.slice(-MAX_PASOS)
      })
      await retirarPasos($, fuera)
    }

    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)

    // Sin tarea, o con un hook que no la deja cerrar, el motor contesta `success: false`.
    if (
      ran.deny === undefined &&
      ran.isError !== true &&
      ran.result.success !== false &&
      e.agentId === undefined
    ) {
      const now = await $.clock.now()
      const id = `t${e.taskId}`
      const estado = e.status
      const subject = e.subject
      let fuera: Paso[] = []
      const retirado = (await read($, pasosRetirados)).find(paso => paso.id === id)

      await update($, pasos, list => {
        if (estado === 'deleted') {
          fuera = list.filter(paso => paso.id === id)

          return list.filter(paso => paso.id !== id)
        }

        // Una tarea creada antes de cargar el mod entra aquí por primera vez.
        const known = list.some(paso => paso.id === id)
        const todos = known
          ? list
          : [...list, retirado ?? pasoNuevo(id, resumir(subject ?? `Tarea ${e.taskId}`))]

        return todos.map(paso => {
          if (paso.id !== id) {
            return paso
          }

          const renombrado = subject === undefined ? paso : { ...paso, texto: resumir(subject) }

          return estado === undefined
            ? renombrado
            : mover(renombrado, estadoDe(estado) ?? paso.estado, now)
        })
      })
      await retirarPasos($, fuera)

      if (retirado !== undefined && estado !== 'deleted') {
        await update($, pasosRetirados, list => list.filter(paso => paso.id !== id))
      }
    }

    return ran
  })

  on('tool.call', { tool: PLAN_COMPLETO }, async ($, e) => {
    const nuevos = leerPlan((e as { pasos?: unknown }).pasos)

    if (nuevos === null) {
      return {
        result:
          'No guardado: `pasos` debe ser una lista de { texto, estado }, con estado pendiente, en_curso o hecho.',
      }
    }

    if (e.agentId === undefined) {
      await ponerPlan($, nuevos)
    }

    const hechos = nuevos.filter(paso => paso.estado === 'hecho').length

    return { result: `Plan guardado: ${hechos} de ${nuevos.length} pasos hechos.` }
  })
}

export async function leerPasos($: EngineInterface): Promise<Paso[]> {
  return read($, pasos)
}

export async function leerPasosRetirados($: EngineInterface): Promise<Paso[]> {
  return read($, pasosRetirados)
}

// `/agentes limpiar`: el panel se vacía, pero lo que ya pasó sigue en el histórico.
export async function limpiarPasos($: EngineInterface): Promise<void> {
  const fuera = await read($, pasos)
  limpiados = new Set([...limpiados, ...fuera.map(paso => paso.id)])
  await retirarPasos($, fuera)
  await update($, pasos, () => [])
}

// Una conversación nueva empieza de cero.
export async function reiniciarPasos($: EngineInterface): Promise<void> {
  limpiados = new Set()
  await update($, pasos, () => [])
  await update($, pasosRetirados, () => [])
}

// El plan solo interesa donde hay alguien mirando el panel.
export async function arrancarTareas($: EngineInterface, isInteractive: boolean): Promise<void> {
  if (isInteractive) {
    await ofrecerPlan($)
  }
}

// Con la herramienta del plan disponible, el prompt le pide al modelo que la use.
export const conSeccionPlan = (
  tools: readonly string[],
  composed: PromptComposeResult,
): PromptComposeResult =>
  tools.includes(PLAN_COMPLETO)
    ? {
        sections: [
          ...composed.sections.filter(section => section.id !== SECCION_PLAN),
          { id: SECCION_PLAN, text: TEXTO_PLAN, scope: 'session' as const },
        ],
      }
    : composed
