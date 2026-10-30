import { expect, mock, test } from 'claude-code/testing'
import type { AgentSpawnInput, On, SessionRateLimit, TurnUsage } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { NOW, REPUESTO_MS, conBorrado, limpiar, medir, shown, usage } from './apoyo'

// El fondo de la cadena: lo que el motor haría debajo del mod, y lo que el mod le pidió.
const world = ($: Engine, on: On, stored: Record<string, unknown> = {}) => {
  const clock = mock.clock(on, { now: NOW })
  // El almacén del mod, con lo que otra sesión dejó guardado o guarde después.
  const store: Record<string, unknown> = { ...stored }
  const opened: string[] = []
  const closed: string[] = []
  // Los paneles abiertos, lo que el motor recibió al arrancar cada agente y el esfuerzo de cada petición.
  const panes = new Set<string>()
  const spawns: AgentSpawnInput[] = []
  const steps: (string | number | undefined)[] = []
  // Las herramientas que el mod registra.
  const tools: string[] = []
  // Lo que el mod escribe en el proyecto.
  const writes: { path: string; text: string }[] = []
  // Las consultas sobre la propia conversación (los latidos de la caché) y los comandos que el mod lanza.
  const forks: string[] = []
  const ran: string[] = []
  const state = {
    cost: null as TurnUsage | null,
    index: 0,
    // Lo que el motor responde al arrancar un agente: su id, o una negativa.
    next: 'a1' as string | null,
    // El esfuerzo con el que el motor lanza cada petición: ninguno si el modelo no lo admite.
    effort: undefined as 'high' | undefined,
    // Los agentes que el motor lista: [id, tipo].
    listed: [] as [string, string][],
    // Las herramientas de lista de tareas que el motor ofrece al modelo, y el id de la próxima que cree.
    builtin: ['TodoWrite'] as string[],
    taskId: '1',
    // Lo que el motor sabe de la sesión: cuándo empezó, sus turnos, su coste y los límites del plan.
    started: 0,
    turns: 0,
    usd: undefined as number | undefined,
    limits: [] as SessionRateLimit[],
    // Lo que un latido lee de caché: 0 es que ya no estaba.
    forkRead: 0,
    // Lo que el motor tarda en escribir un fichero, y las consultas de /usage que le llegan.
    alEscribir: undefined as (() => Promise<void>) | undefined,
    corridas: 0,
    // Averías a la carta. Las que dicen `Roto` o `Negada` contestan `{ deny }`, como un fallo de verdad.
    listaRota: false,
    ventanaNegada: undefined as string | undefined,
    registroRoto: undefined as string | undefined,
    claveRota: undefined as string | undefined,
  }

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  // Lo que pide la banda del mismo mod al arrancar: sin lector de CPU ni consulta de /usage.
  on('session.usage', () => {
    if ((state as any).usoRoto) throw new Error('session.usage: roto')

    return {
      value: {
        startedAt: state.started,
        context: { window: 1_000_000, tokens: 0 },
        rateLimits: state.limits,
        ...(state.usd === undefined ? {} : { cost: { usd: state.usd } }),
      },
    }
  })
  on('session.turns', () => ({ value: state.turns }))
  on('session.root', () => ({ value: '/proyecto' }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('fs.write', async (_$, e) => {
    await state.alEscribir?.()
    // El motor entrega la ruta ya resuelta contra el directorio de trabajo: se guarda desde `.claude/`.
    const path = e.path.replaceAll('\\', '/')
    writes.push({ path: path.slice(Math.max(0, path.indexOf('.claude/'))), text: e.text })

    return { value: undefined }
  })
  // Como el motor: compacta, lanza PostCompact con el resumen y devuelve lo que queda.
  on('session.compact', async () => {
    await $.classic.PostCompact({ trigger: 'auto', compact_summary: 'RESUMEN' })

    return { messages: [{ role: 'user' as const, text: 'hola', toolUses: [] }], tokensBefore: 650_000, tokensAfter: 40_000 }
  })
  on('classic.PostCompact', () => ({}))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('settings.read', () => ({ value: {} }))
  on('env.get', () => ({ value: undefined }))
  on('env.set', () => ({ value: state.ventanaNegada === undefined ? {} : { deny: state.ventanaNegada } }))
  on('process.spawn', async function* () {
    throw new Error('spawn powershell.exe ENOENT')
  })
  on('process.run', () => {
    state.corridas += 1

    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('tool.list', () => {
    if (state.listaRota) return { deny: 'tool.list roto' } as never

    return { value: ['Read', ...state.builtin].map(name => ({ name, description: '', mcp: false })) }
  })
  on('tool.register', (_$, e) => {
    tools.push(e.name)
    ;((state as any).specs ??= []).push(e)

    return { value: { tool: `mcp__tokens-sesion__${e.name}` } }
  })
  // Como el motor: cada herramienta devuelve su registro.
  on('tool.call', (_$, e) =>
    e.tool === 'TaskCreate'
      ? { result: { task: { id: state.taskId, subject: e.subject } } }
      : e.tool === 'TaskUpdate' && (state as any).updateFalla
        ? ({ result: { success: false, taskId: e.taskId, updatedFields: [], error: (state as any).updateFalla } } as never)
        : ({ result: {} } as never),
  )
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'x', scope: 'shared' as const }] }))
  on('command.register', (_$, e) =>
    state.registroRoto === e.name ? ({ deny: 'register roto' } as never) : { value: { command: e.name } },
  )
  on('command.run', (_$, e) => {
    ran.push(e.command)

    return { text: '' }
  })
  on('model.fork', (_$, e) => {
    forks.push(e.prompt)

    return {
      value: {
        isAnswered: true as const,
        text: 'ok',
        usage: {
          input_tokens: 14,
          output_tokens: 4,
          cache_read_input_tokens: state.forkRead,
          cache_creation_input_tokens: 36,
        },
      },
    }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.message', () => ({}))
  on('turn.step', async function* (_$, e) {
    steps.push(e.effort)
    await (state as any).durante?.()

    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: state.cost,
    }
  })
  on('agent.spawn', (_$, e) => {
    spawns.push(e)

    return state.next === null ? { deny: 'no' } : { model: 'claude-haiku-5-5', agentId: state.next }
  })
  on('agent.offer', () => ({ isOffered: true }))
  on('agent.list', () => ({
    value: state.listed.map(([id, type]) => ({ id, type, description: '', status: 'running' as const })),
  }))
  on('store.get', (_$, e) => {
    if ((state as any).lecturaRota) throw new Error('store.get: roto')
    if (state.claveRota === e.key) return { deny: 'store.get roto' } as never

    return { value: store[e.key] }
  })
  on('store.set', (_$, e) => {
    if ((state as any).almacenRoto) return { deny: 'store.set: lock' } as never
    store[e.key] = e.value

    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [...panes].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })),
  }))
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    panes.add(e.id)

    return { value: (state as any).abre ?? { isPlaced: true as const } }
  })
  on('ui.close', (_$, e) => {
    closed.push(e.id)
    panes.delete(e.id)

    return { value: undefined }
  })

  return {
    clock,
    store,
    opened,
    closed,
    spawns,
    steps,
    tools,
    writes,
    forks,
    ran,
    state,
    // Acaba un turno del hilo principal.
    turn: () =>
      $.turn.complete({ answer: '', durationMs: 0, isAborted: false, turnId: 't', reason: 'answer' }),
    // El modelo anota su lista de tareas entera: [texto, estado] por paso.
    todo: (list: [string, 'pending' | 'in_progress' | 'completed'][], agentId?: string) =>
      $.tool.call({
        tool: 'TodoWrite',
        todos: list.map(([content, status]) => ({ content, status, activeForm: content })),
        ...(agentId === undefined ? {} : { agentId }),
      }),
    // Deja que el mod acabe lo que tenga entre manos.
    settle: () => clock.settle(),
    start: (isInteractive = true) =>
      $.session.start({ cwd: '.', surface: isInteractive ? 'terminal' : null, isInteractive }),
    // La persona envía un prompt: empieza una tarea.
    prompt: (text: string) => $.turn.start({ text, turnId: `t${state.index++}` }),
    // El modelo lanza un agente, al que el motor da el id `id` (o lo rechaza con `null`).
    spawn: (id: string | null, input: Partial<AgentSpawnInput> = {}) => {
      state.next = id

      return $.agent.spawn({
        tool_use_id: 'tu',
        prompt: 'haz algo',
        description: 'buscar hooks',
        subagentType: 'Explore',
        provider: { plugin: 'engine', tier: 'core' },
        parentModel: 'claude-opus-5-5',
        background: false,
        fork: false,
        ...input,
      })
    },
    // Una petición al modelo que cuesta `cost`, del hilo principal o de un agente.
    ask: async (cost: TurnUsage | null, agentId?: string) => {
      state.cost = cost
      const stream = $.turn.step({
        turnId: 't',
        index: state.index++,
        model: 'claude-haiku-5-5',
        messageCount: 1,
        ...(state.effort === undefined ? {} : { effort: state.effort }),
        ...(agentId === undefined ? {} : { agentId }),
      })

      for await (const _chunk of stream) {
        // sin trozos: solo importa el resultado
      }

      await stream.result
    },
    // El agente `agentId` acaba su turno.
    end: (agentId: string, reason: 'answer' | 'aborted' | 'error' = 'answer') =>
      $.turn.complete({
        answer: '',
        durationMs: 0,
        isAborted: reason === 'aborted',
        turnId: 't',
        agentId,
        reason,
      }),
    slash: (args: string) =>
      $.command.run({
        command: 'agentes',
        args,
        origin: { kind: 'composer' },
        presentation: { isFullscreen: true, columns: 160 },
      }),
  }
}

// Las líneas del panel, cada una con el texto de sus trozos seguido.
const lines = async ($: Engine, bodyColumns = 48): Promise<string[]> => {
  const ui = await $.ui.mount({
    plugin: 'tokens-sesion',
    component: 'Pane',
    requestId: 'agentes',
    surface: 'terminal',
    props: {
      title: 'Agentes',
      isFocused: false,
      bodyColumns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  })
  const root = await ui.find({ key: 'cuerpo' })
  const drawn = (root?.children ?? []).map(shown)
  await ui.unmount()

  return drawn
}

// La pestaña Enrutadores tal como se dibuja.
const routes = async <P extends 'terminal' | 'mobile'>($: Engine, surface: P, bodyColumns = 48) => {
  await $.command.run({
    command: 'agentes',
    args: 'rutas',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

  return $.ui.mount({
    plugin: 'tokens-sesion',
    component: 'Pane',
    requestId: 'agentes',
    surface,
    props: {
      title: 'Agentes',
      isFocused: false,
      bodyColumns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  })
}

// La pestaña Tareas tal como se dibuja, línea a línea.
const plan = async ($: Engine, bodyColumns = 48): Promise<string[]> => {
  await $.command.run({
    command: 'agentes',
    args: 'tareas',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

  return lines($, bodyColumns)
}

// La pestaña Sesión tal como se dibuja, línea a línea.
const session = async ($: Engine): Promise<string[]> => {
  await $.command.run({
    command: 'agentes',
    args: 'sesion',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

  return lines($)
}

// ---------------------------------------------------------------------------------------------
// Lo que debe seguir en pie tras /clear, entre sesiones y ante datos raros: cada prueba nació de un fallo real.
// ---------------------------------------------------------------------------------------------

test('tras /clear las rutas guardadas siguen enrutando', async ($, on) => {
  const b = conBorrado(on)
  const w = world($, on, {
    rutas: { Explore: { modelo: 'haiku', esfuerzo: 'low' }, Plan: { modelo: 'opus', esfuerzo: 'high' } },
    cacheViva: true,
    umbral: 850_000,
  })
  await w.start()
  await w.prompt('antes')
  await w.spawn('a1')
  expect(w.spawns.at(-1)?.model).toBe('haiku')

  await limpiar($, b)
  // session.measure y turn.start, lo que corre tras /clear, tampoco lo reponen.
  await medir($)
  await w.prompt('despues')
  await w.spawn('a2')
  expect(w.spawns.at(-1)?.model).toBe('haiku')
})

test('tras /resume las rutas guardadas siguen enrutando', async ($, on) => {
  const b = conBorrado(on)
  const w = world($, on, { rutas: { Explore: { modelo: 'haiku', esfuerzo: 'low' } } })
  await w.start()
  await limpiar($, b, 'resume')
  await medir($)
  await w.prompt('despues')
  await w.spawn('a2')
  expect(w.spawns.at(-1)?.model).toBe('haiku')
})

test('tras /clear la caché viva sigue activa si el almacén dice que sí', async ($, on) => {
  const b = conBorrado(on)
  const w = world($, on, { cacheViva: true })
  await w.start()
  await limpiar($, b)
  await medir($)
  expect(await session($)).toContain('Plan         empieza cuando se confirme que dura 1 hora')
})

test('tras /clear tocar un selector no pisa la tabla común', async ($, on) => {
  const b = conBorrado(on)
  const w = world($, on, {
    rutas: { Explore: { modelo: 'haiku', esfuerzo: 'low' }, Plan: { modelo: 'opus', esfuerzo: 'high' } },
  })
  await w.start()
  await limpiar($, b)
  await medir($)
  const ui = await routes($, 'terminal')
  await ui.select({ key: 'modelo:general-purpose', value: 'sonnet' })
  await w.settle()
  await ui.unmount()

  expect(Object.keys(w.store.rutas as object).sort()).toEqual(['Explore', 'Plan', 'general-purpose'])
})

test('lo que otra sesión guardó no se pierde al cambiar una fila aquí', async ($, on) => {
  const w = world($, on, { rutas: { Plan: { modelo: 'sonnet', esfuerzo: 'heredar' } } })
  await w.start()
  // Otra sesion, abierta a la vez, guarda Explore en el almacen comun.
  w.store.rutas = {
    Plan: { modelo: 'sonnet', esfuerzo: 'heredar' },
    Explore: { modelo: 'haiku', esfuerzo: 'heredar' },
  }
  const ui = await routes($, 'terminal')
  await ui.select({ key: 'modelo:Plan', value: 'opus' })
  await w.settle()
  await ui.unmount()

  expect(w.store.rutas).toEqual({
    Plan: { modelo: 'opus', esfuerzo: 'heredar' },
    Explore: { modelo: 'haiku', esfuerzo: 'heredar' },
  })
})

test('desactivar la caché viva en otra sesión para los latidos de esta', async ($, on) => {
  const w = world($, on, { cacheViva: true })
  w.state.forkRead = 500_000
  await w.start()
  await confirmarCache(w, 500_000)
  w.store.cacheViva = false
  await medir($)
  await w.clock.advance(53 * 60_000)
  expect(w.forks).toEqual([])
})

const confirmarCache = async (w: ReturnType<typeof world>, contexto: number) => {
  await w.ask(usage(10, 5, contexto, 0))
  await w.clock.advance(10 * 60_000)
  await w.ask(usage(10, 5, 0, contexto))
}

test('una fila en heredar hereda aunque Los demás tenga ruta', async ($, on) => {
  const w = world($, on, {
    rutas: {
      '*': { modelo: 'sonnet', esfuerzo: 'high' },
      Explore: { modelo: 'haiku', esfuerzo: 'low' },
    },
  })
  await w.start()
  await w.prompt('tarea')
  const ui = await routes($, 'terminal')
  await ui.select({ key: 'modelo:Explore', value: 'heredar' })
  await ui.select({ key: 'esfuerzo:Explore', value: 'heredar' })
  await w.settle()
  // La tabla ensena heredar y heredar...
  expect((await ui.find({ key: 'modelo:Explore' }))?.props.value).toBe('heredar')
  expect((await ui.find({ key: 'esfuerzo:Explore' }))?.props.value).toBe('heredar')
  await ui.unmount()
  // ...y el agente debe correr con lo que pida la llamada, no con Los demas.
  await w.spawn('a1', { model: 'opus' })
  expect(w.spawns.at(-1)?.model).toBe('opus')
})

test('tras /clear la marca sigue en el umbral guardado', async ($, on) => {
  const b = conBorrado(on)
  const w = world($, on, { umbral: 850_000 })
  await w.start()
  await limpiar($, b)
  await w.clock.advance(REPUESTO_MS)
  const drawn = await session($)
  expect(drawn.find(line => line.startsWith('Contexto'))).toContain('850.000')
})

test('tras /clear el panel cerrado no se reabre', async ($, on) => {
  const b = conBorrado(on)
  const w = world($, on)
  await w.start()
  await w.prompt('tarea')
  await w.spawn('a1')
  await w.settle()
  await w.slash('cerrar')
  const antes = w.opened.length
  await limpiar($, b)
  await medir($)
  await w.prompt('otra')
  await w.spawn('a2')
  await w.settle()
  expect(w.opened).toHaveLength(antes)
})

test('tras /clear se conserva la duración confirmada de la caché', async ($, on) => {
  const b = conBorrado(on)
  const w = world($, on)
  await w.start()
  await confirmarCache(w, 500_000)
  expect(await session($)).toContain('Duración     1 hora')
  await limpiar($, b)
  await w.clock.advance(REPUESTO_MS)
  expect(await session($)).toContain('Duración     1 hora')
})

test('tras /clear los tipos ya vistos conservan su fila', async ($, on) => {
  const b = conBorrado(on)
  const w = world($, on)
  await w.start()
  await w.prompt('tarea')
  await w.spawn('a1', { subagentType: 'mi-agente' })
  await limpiar($, b)
  await w.clock.advance(REPUESTO_MS)
  const ui = await routes($, 'terminal')
  expect(await ui.find({ key: 'modelo:mi-agente' })).toBeDefined()
  await ui.unmount()
})

test('tras /clear la pestaña elegida sigue siendo la misma', async ($, on) => {
  const b = conBorrado(on)
  const w = world($, on)
  await w.start()
  await w.todo([['Paso', 'pending']])
  await w.slash('tareas')
  await limpiar($, b)
  await w.clock.advance(REPUESTO_MS)
  expect((await lines($))[0]).toBe('Sin plan todavía.')
})

test('tras /clear el histórico se nombra por el /clear, no por su primera escritura', async ($, on) => {
  const b = conBorrado(on)
  const w = world($, on)
  await w.start()
  await w.clock.advance(60_000)
  await limpiar($, b)
  const clear = w.clock.now()
  await w.clock.advance(600_000)
  await w.prompt('otra')
  await w.spawn('a2')
  await w.end('a2')
  await w.settle()
  const sello = new Date(clear).toISOString().slice(0, 19).replace(/[T:]/g, '-')
  expect(w.writes.at(-1)?.path).toBe(`.claude/historial/sesion-${sello}.md`)
})

test('un agente retomado sale en curso desde que se retoma', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.prompt('primera')
  await w.spawn('a1')
  await w.ask(usage(1_000, 0, 0, 0), 'a1')
  await w.clock.advance(60_000)
  await w.end('a1')
  await w.clock.advance(2 * 3_600_000)
  await w.spawn('a1', { prompt: 'sigue', resume: { agentId: 'a1' } })
  // Ya trabaja, aunque su primera peticion no haya acabado.
  expect((await lines($))[2]).toContain('● ')
})

test('la duración de un retomado no incluye el hueco', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.prompt('primera')
  await w.spawn('a1')
  await w.ask(usage(1_000, 0, 0, 0), 'a1')
  await w.clock.advance(60_000)
  await w.end('a1')
  await w.clock.advance(2 * 3_600_000)
  await w.spawn('a1', { prompt: 'sigue', resume: { agentId: 'a1' } })
  await w.ask(usage(500, 0, 0, 0), 'a1')
  await w.clock.advance(60_000)
  await w.end('a1')
  expect((await lines($))[2]).toContain('2m00s')
})

test('un agente retomado sin línea en el registro aparece en el panel', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.prompt('primera')
  await w.spawn('a1')
  await w.end('a1')
  await w.slash('limpiar')
  await w.prompt('segunda')
  await w.spawn('a1', { prompt: 'sigue', resume: { agentId: 'a1' } })
  await w.ask(usage(5_000, 0, 0, 0), 'a1')
  expect((await lines($)).join('\n')).toContain('5.000 tok')
})

test('los agentes de un workflow caen todos en la tarea que lo lanzó', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.prompt('lanza el workflow')
  await w.spawn('a1', { workflow: { runId: 'wf_1', agentIndex: 1 }, description: 'primero' })
  await w.prompt('sigo con otra cosa')
  await w.spawn('a2', { workflow: { runId: 'wf_1', agentIndex: 2 }, description: 'segundo' })
  const texto = (await lines($)).join('\n')
  expect(texto).toContain('Tarea 1')
  expect(texto).not.toContain('Tarea 2')
})

test('un agente lanzado por otro en segundo plano cae en la tarea de su padre', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.prompt('lanza el padre')
  await w.spawn('p1', { background: true })
  await w.prompt('sigo con otra cosa')
  await w.spawn('h1', { parentAgentId: 'p1', description: 'hijo' })
  const texto = (await lines($)).join('\n')
  expect(texto).not.toContain('Tarea 2')
})

test('un tipo llamado constructor va por Los demás', async ($, on) => {
  const w = world($, on, { rutas: { '*': { modelo: 'sonnet', esfuerzo: 'heredar' } } })
  await w.start()
  await w.prompt('tarea')
  await w.spawn('a1', { subagentType: 'otro', model: 'opus' })
  expect(w.spawns.at(-1)?.model).toBe('sonnet')
  await w.spawn('a2', { subagentType: 'constructor', model: 'opus' })
  expect(w.spawns.at(-1)?.model).toBe('sonnet')
})

test('sin Los demás un tipo constructor conserva el modelo que pide la llamada', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.prompt('tarea')
  await w.spawn('a1', { subagentType: 'constructor', model: 'opus' })
  expect(w.spawns.at(-1)?.model).toBe('opus')
})

test('el esfuerzo de un tipo constructor no se borra', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.prompt('tarea')
  w.state.effort = 'high'
  await w.spawn('a1', { subagentType: 'constructor' })
  await w.ask(usage(100, 0, 0, 0), 'a1')
  expect(w.steps.at(-1)).toBe('high')
})

test('elegir modelo para la fila constructor queda guardado', async ($, on) => {
  const w = world($, on, { rutas: { '*': { modelo: 'sonnet', esfuerzo: 'heredar' } } })
  await w.start()
  await w.prompt('tarea')
  await w.spawn('a1', { subagentType: 'constructor' })
  const ui = await routes($, 'terminal')
  await ui.select({ key: 'modelo:constructor', value: 'haiku' })
  await w.settle()
  await ui.unmount()
  expect(Object.keys(w.store.rutas as object)).toContain('constructor')
})

test('el selector de la fila constructor enseña un valor', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.prompt('tarea')
  await w.spawn('a1', { subagentType: 'constructor' })
  const ui = await routes($, 'terminal')
  expect((await ui.find({ key: 'modelo:constructor' }))?.props.value).toBe('heredar')
  await ui.unmount()
})

for (const raro of ['constructor', 'toString', '__proto__']) {
  test(`un estado ${raro} responde No guardado`, async ($, on) => {
    const w = world($, on)
    w.state.builtin = []
    await w.start()
    const done = await $.tool.call({
      tool: 'mcp__tokens-sesion__plan',
      pasos: [{ texto: 'Paso', estado: raro }],
    } as never)
    expect((done as { result: string }).result).toContain('No guardado')
  })

  test(`un estado ${raro} no deja Tareas sin dibujar`, async ($, on) => {
    const w = world($, on)
    w.state.builtin = []
    await w.start()
    await $.tool.call({
      tool: 'mcp__tokens-sesion__plan',
      pasos: [{ texto: 'Paso', estado: raro }],
    } as never)
    expect((await plan($)).length).toBeGreaterThan(0)
  })
}

test('un estado __proto__ no llega al histórico', async ($, on) => {
  const w = world($, on)
  w.state.builtin = []
  await w.start()
  await $.tool.call({
    tool: 'mcp__tokens-sesion__plan',
    pasos: [{ texto: 'Paso', estado: '__proto__' }],
  } as never)
  await w.turn()
  await w.settle()
  expect(w.writes.at(-1)?.text ?? '').not.toContain('[object Object]')
})

test('un estado que no vale no estropea el panel, y /agentes limpiar deja el plan vacío', async ($, on) => {
  const w = world($, on)
  w.state.builtin = []
  await w.start()
  await $.tool.call({
    tool: 'mcp__tokens-sesion__plan',
    pasos: [{ texto: 'Paso', estado: 'constructor' }],
  } as never)
  await w.slash('rutas')
  expect((await lines($)).length).toBeGreaterThan(0)
  await w.slash('limpiar')
  expect((await plan($))[0]).toBe('Sin plan todavía.')
})

test('una tarea con carácter de control y sin agentes no molesta', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.prompt('mira \u001b[31mrojo\u001b[0m')
  await w.prompt('otra')
  await w.spawn('a1')
  await w.settle()
  expect((await lines($)).length).toBeGreaterThan(0)
})

test('un carácter de control en el texto de la tarea no deja el panel sin dibujar', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.prompt('mira \u001b[31mrojo\u001b[0m')
  await w.spawn('a1')
  await w.settle()
  expect((await lines($)).length).toBeGreaterThan(0)
})

test('un carácter de control en la descripción de un agente no deja el panel sin dibujar', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.prompt('tarea')
  await w.spawn('a1', { description: 'buscar \u0007 algo' })
  await w.settle()
  expect((await lines($)).length).toBeGreaterThan(0)
})

test('un carácter de control en un paso del plan no deja Tareas sin dibujar', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.todo([['paso \u0008 raro', 'in_progress']])
  expect((await plan($)).length).toBeGreaterThan(0)
})

test('un prompt largo cortado en medio de un emoji no deja el panel sin dibujar', async ($, on) => {
  const w = world($, on)
  await w.start()
  // resumir corta en la unidad 299: parte el par sustituto del emoji.
  await w.prompt(`${'a'.repeat(298)}\u{1F600}${'b'.repeat(20)}`)
  await w.spawn('a1')
  await w.settle()
  expect((await lines($)).length).toBeGreaterThan(0)
})

test('la herramienta del plan pide no quedar detrás de ToolSearch', async ($, on) => {
  const w = world($, on)
  w.state.builtin = []
  await w.start()
  const specs = (w.state as any).specs as { name: string; isDeferred?: boolean }[]
  expect(specs.find(spec => spec.name === 'plan')?.isDeferred).toBe(false)
})

test('si falla el almacén la interfaz no enseña lo que no quedó guardado', async ($, on) => {
  const w = world($, on, {})
  await w.start()
  await w.prompt('tarea')
  const ui = await routes($, 'terminal')
  ;(w.state as any).almacenRoto = true
  await ui.select({ key: 'modelo:Explore', value: 'haiku' })
  await w.settle()
  expect((await ui.find({ key: 'modelo:Explore' }))?.props.value).toBe('heredar')
  await ui.unmount()
})

test('si falla el almacén la marca vuelve a su sitio', async ($, on) => {
  const w = world($, on, {})
  await w.start()
  const ui = await $.ui.mount({
    plugin: 'tokens-sesion',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 10,
      bodyColumns: 120,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
  })
  const barra = async () =>
    (await ui.findAll({ type: 'Text', in: 'deslizador' })).map(cell => cell.text).join('')
  const antes = await barra()
  ;(w.state as any).almacenRoto = true
  await ui.pointer({ type: 'down', x: 26, y: 0, button: 'left' })
  await ui.pointer({ type: 'move', x: 30, y: 0, button: 'left' })
  await ui.pointer({ type: 'up', x: 30, y: 0, button: 'left' })
  await w.settle()
  expect(await barra()).toBe(antes)
  await ui.unmount()
})

test('un TaskUpdate rechazado no marca hecha la tarea', async ($, on) => {
  const w = world($, on)
  await w.start()
  w.state.taskId = '7'
  await $.tool.call({ tool: 'TaskCreate', subject: 'Migrar', description: 'x' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '7', status: 'in_progress' })
  ;(w.state as any).updateFalla = 'Bloqueado por el hook TaskCompleted'
  await $.tool.call({ tool: 'TaskUpdate', taskId: '7', status: 'completed' })
  expect((await plan($))[0]).toContain('0/1')
})

test('un TaskUpdate de una tarea inexistente no crea un paso fantasma', async ($, on) => {
  const w = world($, on)
  await w.start()
  ;(w.state as any).updateFalla = 'Task not found'
  await $.tool.call({ tool: 'TaskUpdate', taskId: '99', status: 'in_progress' })
  expect((await plan($))[0]).toBe('Sin plan todavía.')
})

test('un agente de workflow no crea fila en Enrutadores', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.prompt('tarea')
  await w.spawn('a1', { subagentType: 'workflow-subagent', workflow: { runId: 'wf_1', agentIndex: 1 } })
  const ui = await routes($, 'terminal')
  expect(await ui.find({ key: 'modelo:workflow-subagent' })).toBeUndefined()
  await ui.unmount()
})

test('un agente que queda anotado durante su primera petición recibe sus tokens', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.prompt('tarea')
  w.state.effort = 'high'
  w.state.listed = [['a1', 'Explore']]
  // Como el motor: la primera peticion del agente sale antes de que acabe agent.spawn,
  // y el arranque acaba con la peticion en vuelo.
  ;(w.state as any).durante = async () => {
    ;(w.state as any).durante = undefined
    await w.spawn('a1')
  }
  await w.ask(usage(32_300, 0, 0, 0), 'a1')
  await w.settle()
  expect((await lines($))[2]).toContain('32.300 tok')
})

test('sin esfuerzo la misma secuencia también cuadra', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.prompt('tarea')
  w.state.listed = [['a1', 'Explore']]
  ;(w.state as any).durante = async () => {
    ;(w.state as any).durante = undefined
    await w.spawn('a1')
  }
  await w.ask(usage(32_300, 0, 0, 0), 'a1')
  await w.settle()
  expect((await lines($))[2]).toContain('32.300 tok')
})

test('el panel cerrado no se reabre en la sesión siguiente', async ($, on) => {
  const b = conBorrado(on)
  const w = world($, on)
  await w.start()
  await w.prompt('tarea')
  await w.spawn('a1')
  await w.settle()
  await w.slash('cerrar')
  const antes = w.opened.length
  // Sesion nueva: estado vacio y session.start otra vez.
  b.borrar()
  await w.start()
  await w.prompt('otra')
  await w.spawn('a2')
  await w.settle()
  expect(w.opened).toHaveLength(antes)
})

test('en pantalla principal el panel no se abre solo', async ($, on) => {
  const w = world($, on)
  await w.start()
  // La banda lo sabe: el terminal dice false en la pantalla principal.
  const ui = await $.ui.mount({
    plugin: 'tokens-sesion',
    component: 'AbovePrompt',
    surface: 'terminal',
    viewport: { columns: 150, rows: 40, isFullscreen: false },
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 10,
      bodyColumns: 150,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
  } as never)
  await ui.unmount()
  await w.prompt('tarea')
  await w.spawn('a1')
  await w.settle()
  expect(w.opened).toEqual([])
})

test('/agentes da el motivo real cuando el panel no se coloca', async ($, on) => {
  const w = world($, on)
  await w.start()
  ;(w.state as any).abre = { isPlaced: false, reason: 'no-surface: nothing draws in a -p run' }
  const text = (await w.slash('')).text
  expect(text).not.toContain('ensanchar')
  expect(text).toContain('no-surface')
})

test('/agentes sesión con tilde abre la pestaña', async ($, on) => {
  const w = world($, on)
  await w.start()
  const text = (await w.slash('sesión')).text
  expect(text).not.toContain('Uso:')
})

test('/agentes agentes vuelve a la pestaña Agentes', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.slash('rutas')
  const text = (await w.slash('agentes')).text
  expect(text).not.toContain('Uso:')
})

test('un fallo de una herramienta no se lleva a las demás y sale en Fallos hasta que vuelve a ir bien', async ($, on) => {
  const w = world($, on, { rutas: { Explore: { modelo: 'haiku', esfuerzo: 'low' } } })
  await w.start()
  ;(w.state as any).lecturaRota = true
  await medir($, 5_000)
  const roto = await session($)
  // El contexto no depende del almacén: sigue al día. Lo que falló se dice.
  expect(roto.find(line => line.startsWith('Contexto'))).toContain('5.000')
  expect(roto).toContain('Fallos')
  expect(roto.some(line => line.startsWith('Enrutadores'))).toBe(true)

  ;(w.state as any).lecturaRota = false
  await medir($, 6_000)
  expect(await session($)).not.toContain('Fallos')
  await w.prompt('tarea')
  await w.spawn('a1')
  expect(w.spawns.at(-1)?.model).toBe('haiku')
})

test('una pestaña que no se puede dibujar no se lleva el panel', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.slash('sesion')
  ;(w.state as any).usoRoto = true
  expect((await lines($))[0]).toContain('No se pudo dibujar esta pestaña')
  await w.slash('tareas')
  expect((await lines($))[0]).toBe('Sin plan todavía.')
})

test('los agentes que dejó en la sesión una versión anterior del mod no se leen', async ($, on) => {
  const b = conBorrado(on)
  const w = world($, on)
  b.sembrar('agentes', [{ id: 'viejo', tipo: 'Explore', inicio: NOW, fin: NOW, estado: 'ok', tarea: 1, tokens: 1 }])
  await w.start()
  expect((await lines($))[0]).toBe('Sin agentes todavía.')
})

test('/agentes limpiar vacía el panel y la tarea en curso conserva su número', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.prompt('primera')
  await w.spawn('a1')
  await w.slash('limpiar')
  expect((await lines($))[0]).toBe('Sin agentes todavía.')
  await w.spawn('a2')
  expect((await lines($))[0]).toContain('Tarea 1')
  await w.prompt('segunda')
  await w.spawn('a3')
  expect((await lines($))[0]).toContain('Tarea 2')
})

// ---------------------------------------------------------------------------------------------
// /clear con el borrado de `$.state` de verdad: lo repuesto no se pierde aunque los temporizadores
// y los hooks de debajo lleguen en otro orden.
// ---------------------------------------------------------------------------------------------

// Lo escrito en el histórico, por orden.
const historiales = (w: ReturnType<typeof world>) => w.writes.filter(one => one.path.includes('/historial/'))

test('si el temporizador salta antes de que el motor borre, tras /clear las rutas siguen enrutando', async ($, on) => {
  const b = conBorrado(on)
  const w = world($, on, {
    rutas: { Explore: { modelo: 'haiku', esfuerzo: 'low' } },
    panelOculto: true,
    umbral: 850_000,
  })
  await w.start()
  await w.slash('sesion')
  // El hook del mod acaba, pero el de telemetría de debajo sigue con su POST: el borrado llega después.
  await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } })
  await w.clock.advance(3_000)
  b.borrar()
  await w.clock.advance(5_000)
  await w.prompt('después')
  await w.spawn('a2')
  await w.settle()
  expect(w.spawns.at(-1)?.model).toBe('haiku')
})

test('si el temporizador salta antes de que el motor borre, una medida no reabre el panel cerrado', async ($, on) => {
  const b = conBorrado(on)
  const w = world($, on, { panelOculto: true })
  await w.start()
  await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } })
  await w.clock.advance(3_000)
  b.borrar()
  await w.clock.advance(5_000)
  await medir($)
  await w.prompt('después')
  await w.spawn('a2')
  await w.settle()
  expect(w.opened).toEqual([])
})

test('con dos /clear seguidos, lo repuesto no se pierde', async ($, on) => {
  const b = conBorrado(on)
  const w = world($, on, { rutas: { Explore: { modelo: 'haiku', esfuerzo: 'low' } } })
  await w.start()
  await limpiar($, b)
  await w.clock.advance(1_900)
  // El hook del segundo acaba a los 1,9 s del primero; la cadena sigue 200 ms en la telemetría.
  await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } })
  await w.clock.advance(200)
  b.borrar()
  await w.clock.advance(5_000)
  await w.prompt('después')
  await w.spawn('a2')
  await w.settle()
  expect(w.spawns.at(-1)?.model).toBe('haiku')
})

test('si falla la lectura al reponer tras /clear, la medida siguiente lo repone y el panel cerrado sigue cerrado', async ($, on) => {
  const b = conBorrado(on)
  const w = world($, on, { panelOculto: true })
  await w.start()
  await limpiar($, b)
  ;(w.state as any).lecturaRota = true
  await w.clock.advance(REPUESTO_MS)
  ;(w.state as any).lecturaRota = false
  await medir($)
  await w.prompt('después')
  await w.spawn('a2')
  await w.settle()
  expect(w.opened).toEqual([])
})

test('tras recargar el mod, /clear conserva la pestaña que había en el estado', async ($, on) => {
  const b = conBorrado(on)
  const w = world($, on)
  // Lo que queda en $.state tras una recarga: el módulo recién cargado tiene sus copias vacías.
  b.sembrar('pestana', 'sesion')
  await w.start()
  await limpiar($, b)
  await w.clock.advance(REPUESTO_MS)
  expect((await lines($)).join('\n')).toContain('Modelo')
})

test('tras recargar el mod, /clear conserva la duración confirmada de la caché', async ($, on) => {
  const b = conBorrado(on)
  const w = world($, on)
  b.sembrar('cache', { viva: true, ttl: '1h', ultima: null, latidos: 0, leido: 0, nota: null })
  await w.start()
  await limpiar($, b)
  await w.clock.advance(REPUESTO_MS)
  expect(await session($)).toContain('Duración     1 hora')
})

test('tras recargar el mod, /clear conserva la fila de los tipos ya vistos', async ($, on) => {
  const b = conBorrado(on)
  const w = world($, on)
  b.sembrar('tipos', ['mi-tipo'])
  await w.start()
  await limpiar($, b)
  await w.clock.advance(REPUESTO_MS)
  const ui = await routes($, 'terminal')
  const fila = await ui.find({ key: 'modelo:mi-tipo' })
  await ui.unmount()
  expect(fila).toBeDefined()
})

test('con una petición entre la recarga y el /clear, la duración confirmada sobrevive', async ($, on) => {
  const b = conBorrado(on)
  const w = world($, on)
  b.sembrar('cache', { viva: true, ttl: '1h', ultima: null, latidos: 0, leido: 0, nota: null })
  await w.start()
  await w.ask(usage(10, 1, 0, 100))
  await limpiar($, b)
  await w.clock.advance(REPUESTO_MS)
  expect(await session($)).toContain('Duración     1 hora')
})

test('un agente de fondo que sigue trabajando tras /clear sigue en la pestaña Sesión con lo que gasta', async ($, on) => {
  const b = conBorrado(on)
  const w = world($, on)
  await w.start()
  await w.prompt('tarea vieja')
  await w.spawn('fondo', { background: true })
  w.state.listed = [['fondo', 'Explore']]
  await w.ask(usage(1_000, 0, 0, 0), 'fondo')
  await limpiar($, b)
  await w.clock.advance(REPUESTO_MS)
  await w.ask(usage(50_000, 0, 0, 0), 'fondo')
  await w.end('fondo')
  await w.settle()
  const drawn = await session($)
  expect(drawn).toContain('Agentes      1 · 0 en curso')
  expect(drawn).toContain('  agentes    50.000 (100 %)')
})

test('un agente de fondo que sobrevive a /clear lleva su cierre al histórico nuevo y deja el viejo con «en curso»', async ($, on) => {
  const b = conBorrado(on)
  const w = world($, on)
  await w.start()
  await w.prompt('tarea vieja')
  await w.spawn('fondo', { background: true })
  w.state.listed = [['fondo', 'Explore']]
  await w.ask(usage(1_000, 0, 0, 0), 'fondo')
  await w.turn()
  await w.settle()
  const viejo = historiales(w).at(-1)!
  expect(viejo.text).toContain('| en curso |')
  const escritasAntes = w.writes.length
  // Los ficheros se nombran por la hora: que el /clear no caiga en el mismo segundo que el primero.
  await w.clock.advance(5_000)
  await limpiar($, b)
  await w.clock.advance(REPUESTO_MS)
  await w.ask(usage(50_000, 0, 0, 0), 'fondo')
  // En la conversación nueva el agente sigue con su fila, en curso.
  expect(await session($)).toContain('Agentes      1 · 1 en curso')
  await w.end('fondo')
  await w.settle()
  const nuevo = historiales(w).at(-1)!
  // Lo que escribe al acabar va a un fichero nuevo, con su cierre; el de la conversación anterior no se toca.
  expect(nuevo.path).not.toBe(viejo.path)
  expect(nuevo.text).toContain('| ok |')
  expect(nuevo.text).not.toContain('| en curso |')
  expect(nuevo.text).toContain('50.000')
  expect(w.writes.slice(escritasAntes).filter(one => one.path === viejo.path)).toEqual([])
})

test('lo que gasta un agente de fondo entre el /clear y su reposición va a su fila', async ($, on) => {
  const b = conBorrado(on)
  const w = world($, on)
  await w.start()
  await w.prompt('tarea vieja')
  await w.spawn('fondo', { background: true })
  w.state.listed = [['fondo', 'Explore']]
  await limpiar($, b)
  // Visto en una sesión real: su primera petición acabó en esos dos segundos.
  await w.ask(usage(46_000, 0, 0, 0), 'fondo')
  await w.clock.advance(REPUESTO_MS)
  await w.ask(usage(4_000, 0, 0, 0), 'fondo')
  await w.end('fondo')
  await w.settle()
  expect(historiales(w).at(-1)!.text).toContain('| 50.000 |')
})

test('una escritura del histórico en vuelo durante /clear no deja el fichero viejo a la conversación nueva', async ($, on) => {
  const b = conBorrado(on)
  const w = world($, on)
  await w.start()
  await w.prompt('tarea vieja')
  await w.spawn('fondo', { background: true })
  await w.ask(usage(1_000, 0, 0, 0), 'fondo')
  await w.spawn('otro', { background: true })
  await w.end('otro')
  await w.settle()
  const viejo = w.writes.at(-1)!.path
  // El segundo agente acaba y su escritura se queda en el disco mientras llega el /clear.
  let soltar = () => {}
  const puerta = new Promise<void>(resolve => {
    soltar = resolve
  })
  w.state.alEscribir = () => puerta
  const fin = w.end('fondo')
  await w.clock.advance(5_000)
  w.state.alEscribir = undefined
  await limpiar($, b)
  soltar()
  await fin
  await w.settle()
  await w.clock.advance(REPUESTO_MS)
  // Conversación nueva con su propio agente.
  await w.prompt('tarea nueva')
  await w.spawn('nuevo')
  await w.end('nuevo')
  await w.settle()
  const ultimo = w.writes.at(-1)!
  expect(ultimo.path).not.toBe(viejo)
  expect(ultimo.text).toContain('tarea nueva')
})

test('si un agente acaba entre dos pasos del reinicio de /clear, el fichero viejo no se vacía', async ($, on) => {
  const b = conBorrado(on)
  const w = world($, on)
  await w.start()
  await w.prompt('tarea vieja')
  await w.spawn('a1')
  await w.ask(usage(1_000, 0, 0, 0), 'a1')
  await w.end('a1')
  await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'hola', toolUses: [] }] })
  await w.turn()
  await w.settle()
  expect(historiales(w).at(-1)!.text).toContain('buscar hooks')
  // Mientras session.end reinicia los pasos, un agente de fondo acaba: turn.complete llama a historiar.
  let vez = 0
  b.ganchos.alPoner = async key => {
    if (key === 'pasosRetirados' && vez === 0) {
      vez = 1
      await w.end('otro')
    }
  }
  await limpiar($, b)
  await w.settle()
  expect(historiales(w).at(-1)!.text).toContain('buscar hooks')
})

test('una escritura pendiente del histórico al llegar /clear no vacía el fichero viejo', async ($, on) => {
  const b = conBorrado(on)
  const w = world($, on)
  await w.start()
  await w.prompt('tarea vieja')
  await w.spawn('a1')
  await w.ask(usage(1_000, 0, 0, 0), 'a1')
  await w.end('a1')
  await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'hola', toolUses: [] }] })
  await w.turn()
  await w.settle()
  expect(historiales(w).length).toBeGreaterThan(0)
  // Una escritura en el disco; otra se queda pendiente y llega el /clear.
  let soltar = () => {}
  const puerta = new Promise<void>(resolve => {
    soltar = resolve
  })
  w.state.alEscribir = () => puerta
  const fin1 = w.end('x1')
  const fin2 = w.end('x2')
  await w.clock.advance(100)
  w.state.alEscribir = undefined
  await limpiar($, b)
  soltar()
  await fin1
  await fin2
  await w.settle()
  expect(historiales(w).at(-1)!.text).toContain('buscar hooks')
})

test('/clear no borra el aviso de que el plan no se pudo ofrecer', async ($, on) => {
  const b = conBorrado(on)
  const w = world($, on)
  w.state.listaRota = true
  await w.start()
  expect((await plan($)).join('\n')).toContain('No se pudo ofrecer el plan')
  await limpiar($, b)
  await w.clock.advance(REPUESTO_MS)
  expect((await plan($)).join('\n')).toContain('No se pudo ofrecer el plan')
})

test('un histórico escrito con la forma de agente de otra versión no pierde sus filas al seguir', async ($, on) => {
  const b = conBorrado(on)
  const w = world($, on)
  const fila = {
    id: 'viejo',
    tipo: 'Explore',
    nombre: null,
    descripcion: 'encargo-viejo',
    modelo: 'claude-haiku-5-5',
    tarea: 1,
    inicio: NOW,
    fin: NOW + 1000,
    estado: 'ok',
    tokens: 7000,
    esfuerzo: null,
    hereda: false,
  }
  b.sembrar('agentes', [fila])
  b.sembrar('tareas', [{ n: 1, inicio: NOW, texto: 'tarea' }])
  b.sembrar('gastados', 7000)
  b.sembrar('deAgentes', 7000)
  b.sembrar('nacida', NOW - 60_000)
  b.sembrar('historico', '/proyecto/.claude/historial/sesion-X.md')
  await w.start()
  await w.prompt('sigue')
  await w.todo([['Paso', 'in_progress']])
  await w.turn()
  await w.settle()
  expect(historiales(w).at(-1)!.text).toContain('encargo-viejo')
})

// Cuántas veces se lanza /usage con una lectura que falla seguido: una por reposición, no una por medida.
test('con una lectura que falla desde que se repuso tras /clear, las medidas no lanzan /usage cada vez', async ($, on) => {
  const b = conBorrado(on)
  const w = world($, on)
  await w.start()
  await w.settle()
  await limpiar($, b)
  await w.clock.advance(REPUESTO_MS)
  await w.settle()
  ;(w.state as any).lecturaRota = true
  const antes = w.state.corridas

  for (let i = 0; i < 5; i += 1) {
    await w.clock.advance(1_000)
    await medir($)
    await w.settle()
  }

  ;(w.state as any).lecturaRota = false
  expect(w.state.corridas - antes).toBeLessThanOrEqual(1)
})

test('con una lectura que falla desde el propio /clear, las medidas no lanzan /usage cada vez', async ($, on) => {
  const b = conBorrado(on)
  const w = world($, on)
  await w.start()
  await w.settle()
  ;(w.state as any).lecturaRota = true
  await limpiar($, b)
  await w.clock.advance(REPUESTO_MS)
  await w.settle()
  const antes = w.state.corridas

  for (let i = 0; i < 5; i += 1) {
    await w.clock.advance(1_000)
    await medir($)
    await w.settle()
  }

  ;(w.state as any).lecturaRota = false
  expect(w.state.corridas - antes).toBeLessThanOrEqual(1)
})

// ---------------------------------------------------------------------------------------------
// Fallos: lo que se rompe debajo del mod sale en la pestaña Sesión y no se lleva el resto.
// ---------------------------------------------------------------------------------------------

// La pestaña montada en `surface`, con los hijos tal como se dibujan.
const montar = ($: Engine, surface: 'terminal' | 'desktop' | 'vscode' | 'mobile' = 'terminal') =>
  $.ui.mount({
    plugin: 'tokens-sesion',
    component: 'Pane',
    requestId: 'agentes',
    surface,
    props: {
      title: 'Agentes',
      isFocused: false,
      bodyColumns: 80,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  } as never)

type Montada = Awaited<ReturnType<typeof montar>>

const cuerpo = async (ui: Montada): Promise<string[]> =>
  ((await ui.find({ key: 'cuerpo' }))?.children ?? []).map(shown)

// Un hook de prueba que lanza queda saltado: para que `$.state` rechace hay que contestar `{ deny }`.
const roturas = (on: On) => {
  const claves = new Set<string>()
  on('state.set', (_$, e, next) => {
    if (claves.has((e as { key: string }).key)) {
      return { deny: `state.set roto: ${(e as { key: string }).key}` } as never
    }

    return next(e)
  })
  on('state.get', (_$, e, next) => {
    if (claves.has(`get:${(e as { key: string }).key}`)) {
      return { deny: `state.get roto: ${(e as { key: string }).key}` } as never
    }

    return next(e)
  })

  return claves
}

// El fallo que dice `texto`, tal como sale en Fallos: tras la cabecera.
const enFallos = (drawn: string[], texto: string): boolean => {
  const desde = drawn.indexOf('Fallos')

  return desde >= 0 && drawn.slice(desde).some(line => line.includes(texto))
}

test('un fallo al anotar un agente sigue en Fallos tras un paso del hilo principal', async ($, on) => {
  const claves = roturas(on)
  const w = world($, on)
  await w.start()
  await w.prompt('tarea')
  claves.add('agentes')
  await w.spawn('a1')
  claves.delete('agentes')
  expect(enFallos(await session($), 'state.set roto: agentes')).toBe(true)
  await w.ask(usage(10, 5, 0, 0))
  expect(enFallos(await session($), 'state.set roto: agentes')).toBe(true)
})

test('el comando /tokens-compact que no se registró sigue en Fallos tras una medida', async ($, on) => {
  const w = world($, on)
  w.state.registroRoto = 'tokens-compact'
  await w.start()
  await w.settle()
  w.state.registroRoto = undefined
  expect(enFallos(await session($), 'register roto')).toBe(true)
  await medir($, 5_000)
  expect(enFallos(await session($), 'register roto')).toBe(true)
})

test('con /agentes sin registrar, el panel se abre solo y el motivo sale en Fallos, antes y después del primer agente', async ($, on) => {
  const w = world($, on)
  w.state.registroRoto = 'agentes'
  await w.start()
  await w.settle()
  w.state.registroRoto = undefined
  expect(enFallos(await session($), 'register roto')).toBe(true)
  await w.prompt('tarea')
  await w.spawn('a1')
  await w.settle()
  expect(w.opened).toContain('agentes')
  expect(enFallos(await session($), 'register roto')).toBe(true)
  // Y con el panel ya abierto, la persona lo ve al pulsar la pestaña.
  const ui = await montar($)
  await ui.press({ key: 'pestana:sesion' })
  await w.settle()
  const drawn = await cuerpo(ui)
  await ui.unmount()
  expect(enFallos(drawn, 'register roto')).toBe(true)
})

test('un fallo al leer la caché viva al arrancar llega a Fallos', async ($, on) => {
  const w = world($, on, { cacheViva: true })
  w.state.claveRota = 'cacheViva'
  await w.start()
  await w.settle()
  w.state.claveRota = undefined
  expect(enFallos(await session($), 'store.get roto')).toBe(true)
})

test('un fallo del enrutado al lanzar un agente llega a Fallos y el agente sale sin la ruta', async ($, on) => {
  const claves = roturas(on)
  const w = world($, on, { rutas: { Explore: { modelo: 'haiku', esfuerzo: 'low' } } })
  await w.start()
  await w.prompt('tarea')
  claves.add('get:rutas')
  await w.spawn('a1')
  claves.delete('get:rutas')
  await w.settle()
  expect(w.spawns.at(-1)?.model).toBeUndefined()
  expect(enFallos(await session($), 'state.get roto: rutas')).toBe(true)
})

test('/agentes cache si con el almacén roto lo dice y sale en Fallos', async ($, on) => {
  const w = world($, on)
  await w.start()
  ;(w.state as any).almacenRoto = true
  const respuesta = await w.slash('cache si')
  ;(w.state as any).almacenRoto = false
  expect(respuesta.text).toContain('No se pudo')
  expect(enFallos(await session($), 'store.set: lock')).toBe(true)
})

test('un fallo al guardar el plan sale en Fallos', async ($, on) => {
  const claves = roturas(on)
  const w = world($, on)
  await w.start()
  claves.add('pasos')
  await w.todo([['Paso', 'in_progress']])
  claves.delete('pasos')
  expect(enFallos(await session($), 'state.set roto: pasos')).toBe(true)
})

test('con la pestaña Sesión abierta, el fallo del botón Mantenerla se ve sin otro redibujo', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.slash('sesion')
  const ui = await montar($)
  ;(w.state as any).almacenRoto = true
  await ui.press({ key: 'cache-viva' })
  await w.settle()
  const drawn = await cuerpo(ui)
  await ui.unmount()
  ;(w.state as any).almacenRoto = false
  expect(enFallos(drawn, 'store.set: lock')).toBe(true)
})

test('con la pestaña Sesión abierta, una medida no esconde el fallo del botón y al arreglarse deja de verse', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.slash('sesion')
  ;(w.state as any).almacenRoto = true
  const ui = await montar($)
  await ui.press({ key: 'cache-viva' })
  await w.settle()
  await medir($, 7_000)
  expect(enFallos(await cuerpo(ui), 'store.set: lock')).toBe(true)
  ;(w.state as any).almacenRoto = false
  await ui.press({ key: 'cache-viva' })
  await w.settle()
  const despues = await cuerpo(ui)
  await ui.unmount()
  expect(despues).not.toContain('Fallos')
})

test('una política que niega la ventana al arrancar llega a Fallos', async ($, on) => {
  const w = world($, on, { umbral: 850_000 })
  w.state.ventanaNegada = 'la política fija esa variable'
  await w.start()
  await w.settle()
  expect(enFallos(await session($), 'la política fija esa variable')).toBe(true)
})

test('la tabla del selector que no se pudo guardar sigue en Fallos tras una medida', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.prompt('tarea')
  const ui = await routes($, 'terminal')
  ;(w.state as any).almacenRoto = true
  await ui.select({ key: 'modelo:Explore', value: 'haiku' })
  await w.settle()
  ;(w.state as any).almacenRoto = false
  await medir($, 1_000)
  await ui.unmount()
  expect(enFallos(await session($), 'store.set: lock')).toBe(true)
})

test('/agentes cerrar con el almacén roto: el fallo se puede ver', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.prompt('tarea')
  await w.spawn('a1')
  await w.settle()
  ;(w.state as any).almacenRoto = true
  await w.slash('cerrar')
  ;(w.state as any).almacenRoto = false
  // Otro agente con el panel cerrado: nada que abrir, y el fallo no se borra.
  await w.spawn('a2')
  await w.settle()
  const ui = await montar($)
  await ui.press({ key: 'pestana:sesion' })
  await w.settle()
  const drawn = await cuerpo(ui)
  await ui.unmount()
  expect(enFallos(drawn, 'store.set: lock')).toBe(true)
})

// ---------------------------------------------------------------------------------------------
// Datos raros y superficies.
// ---------------------------------------------------------------------------------------------

test('un tipo __proto__ tiene su fila y se guarda', async ($, on) => {
  const w = world($, on, {})
  await w.start()
  await w.prompt('tarea')
  await w.spawn('a1', { subagentType: '__proto__' })
  await w.settle()
  const ui = await routes($, 'terminal')
  const fila = await ui.find({ key: 'modelo:__proto__' })
  expect(fila?.props.value).toBe('heredar')
  await ui.select({ key: 'modelo:__proto__', value: 'haiku' })
  await w.settle()
  expect((await ui.find({ key: 'modelo:__proto__' }))?.props.value).toBe('haiku')
  await ui.unmount()
  await w.spawn('a2', { subagentType: '__proto__' })
  expect(w.spawns.at(-1)?.model).toBe('haiku')
})

test('cambiar Los demás en dos pasos no borra las excepciones', async ($, on) => {
  const w = world($, on, {
    rutas: { '*': { modelo: 'sonnet', esfuerzo: 'heredar' }, Explore: { modelo: 'heredar', esfuerzo: 'heredar' } },
  })
  await w.start()
  const ui = await routes($, 'terminal')
  // Quiere Los demás en heredar y low: toca los dos selectores, uno tras otro.
  await ui.select({ key: 'modelo:*', value: 'heredar' })
  await w.settle()
  await ui.select({ key: 'esfuerzo:*', value: 'low' })
  await w.settle()
  await ui.unmount()
  expect(Object.keys(w.store.rutas as object)).toContain('Explore')
})

test('/agentes limpiar seguido de un TaskUpdate no crea un paso con nombre inventado', async ($, on) => {
  const w = world($, on)
  await w.start()
  w.state.taskId = '7'
  await $.tool.call({ tool: 'TaskCreate', subject: 'Migrar la base', description: 'x' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '7', status: 'in_progress' })
  await w.slash('limpiar')
  await $.tool.call({ tool: 'TaskUpdate', taskId: '7', status: 'completed' })
  expect((await plan($)).join('|')).not.toContain('Tarea 7')
})

for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
  for (const tab of ['agentes', 'tareas', 'rutas', 'sesion']) {
    test(`en ${surface} la pestaña ${tab} se dibuja con datos`, async ($, on) => {
      const w = world($, on, { rutas: { Explore: { modelo: 'haiku', esfuerzo: 'low' } } })
      await w.start()
      await w.prompt('tarea')
      await w.spawn('a1')
      await w.todo([['Paso', 'in_progress']])
      await w.slash(tab)
      const ui = await montar($, surface)
      expect(await ui.find({ key: 'cuerpo' })).toBeDefined()
      await ui.unmount()
    })
  }
}
