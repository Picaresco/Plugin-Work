import { expect, mock, test } from 'claude-code/testing'
import type { AgentSpawnInput, ModelUsage, On, SessionRateLimit, TurnUsage } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { MIN, NOW, shown, usage } from './apoyo'

// El histórico de la sesión y la caché viva: cada prueba nació de un fallo real.

// El latido sale 52 minutos despues de la ultima peticion que renovo la cache.
const LATIDO_MS = 52 * MIN

const world = ($: Engine, on: On, stored: Record<string, unknown> = {}) => {
  const clock = mock.clock(on, { now: NOW })
  const store: Record<string, unknown> = { ...stored }
  const opened: string[] = []
  const panes = new Set<string>()
  const spawns: AgentSpawnInput[] = []
  const writes: { path: string; text: string }[] = []
  // La ruta tal como llega al fondo, sin recortar.
  const raw: string[] = []
  const toasts: string[] = []
  const forks: string[] = []
  const ran: string[] = []
  const state = {
    cost: null as TurnUsage | null,
    index: 0,
    next: 'a1' as string | null,
    started: 0,
    turns: 0,
    usd: undefined as number | undefined,
    limits: [] as SessionRateLimit[],
    forkRead: 0,
    // Lo que falla debajo del mod.
    failWrite: null as RegExp | null,
    failCommand: false,
    failFork: false,
    failToolList: false,
    // Lo que responde /compact cuando no compacta: resuelve con un texto, no rechaza.
    commandText: '',
    // El siguiente fs.write del historico tarda mas que el que venga detras.
    holdHistorial: false,
    // El siguiente fork tarda 5 s en volver.
    holdFork: false,
    // Lo mismo con el tiempo que se quiera.
    forkHoldMs: 0,
    forkAnswer: null as Record<string, unknown> | null,
    compactUsage: undefined as ModelUsage | undefined,
    summary: 'RESUMEN',
    model: 'claude-opus-5-5',
    // El motor tiene apagado el compactado automático (/config), o la compactación en reposo.
    autoOff: false,
    idleOff: false,
    // La raíz del proyecto, que puede cambiar si la sesión entra en un worktree.
    raiz: '/proyecto',
    // Lo que pasa mientras el motor escribe un fichero (y lo niega) o acaba un turno: ganchos para meter un suceso a mitad.
    niega: undefined as ((path: string) => Promise<string | undefined>) | undefined,
    enCompletar: undefined as ((e: { agentId?: string }) => Promise<void>) | undefined,
  }

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: {
      startedAt: state.started,
      context: {
        window: 1_000_000,
        tokens: 0,
        ...(state.autoOff ? { breakdown: { isAutoCompactEnabled: false } as never } : {}),
      },
      rateLimits: state.limits,
      ...(state.usd === undefined ? {} : { cost: { usd: state.usd } }),
    },
  }))
  on('session.turns', () => ({ value: state.turns }))
  on('session.root', () => ({ value: state.raiz }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('fs.write', async (_$, e) => {
    const path = e.path.replaceAll('\\', '/')
    raw.push(path)
    const niega = await state.niega?.(path)

    if (niega) {
      return { deny: niega } as never
    }

    if (state.failWrite?.test(path)) {
      throw new Error('EACCES: permission denied')
    }

    if (state.holdHistorial && path.includes('/historial/')) {
      state.holdHistorial = false
      await clock.sleep(1_000)
    }

    writes.push({ path: path.slice(Math.max(0, path.indexOf('.claude/'))), text: e.text })

    return { value: undefined }
  })
  on('session.compact', async () => {
    await $.classic.PostCompact({ trigger: 'auto', compact_summary: state.summary })

    return {
      messages: [{ role: 'user' as const, text: 'hola', toolUses: [] }],
      tokensBefore: 650_000,
      tokensAfter: 40_000,
      ...(state.compactUsage === undefined ? {} : { usage: state.compactUsage }),
    }
  })
  on('classic.PostCompact', () => ({}))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.model', () => ({ value: state.model }))
  on('settings.read', () => ({ value: state.idleOff ? { idleCompaction: false } : {} }))
  on('env.get', () => ({ value: undefined }))
  on('env.set', () => ({ value: {} }))
  on('classic.PostModelSwitch', () => ({}))
  on('process.spawn', async function* () {
    throw new Error('spawn powershell.exe ENOENT')
  })
  on('process.run', () => ({
    value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('ui.toast', (_$, e) => {
    toasts.push(JSON.stringify(e))

    return { value: undefined }
  })
  on('tool.list', () => {
    if (state.failToolList) {
      throw new Error('tool.list roto')
    }

    return { value: ['Read', 'TodoWrite'].map(name => ({ name, description: '', mcp: false })) }
  })
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__tokens-sesion__${e.name}` } }))
  on('tool.call', () => ({ result: {} }) as never)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'x', scope: 'shared' as const }] }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('command.run', async (_$, e) => {
    if (state.failCommand) {
      throw new Error('host limit')
    }

    ran.push(e.command)

    // Como el motor: /compact compacta, salvo que un hook o un fallo lo impidan: entonces lo dice.
    if (e.command === 'compact' && state.commandText === '') {
      await $.session.compact({
        trigger: 'manual',
        messages: [{ role: 'user', text: 'hola', toolUses: [] }],
      })
    }

    return { text: state.commandText }
  })
  on('model.fork', async (_$, e) => {
    forks.push(e.prompt)

    if (state.failFork) {
      throw new Error('fork roto')
    }

    if (state.holdFork) {
      state.holdFork = false
      await clock.sleep(5_000)
    }

    if (state.forkHoldMs > 0) {
      const ms = state.forkHoldMs
      state.forkHoldMs = 0
      await clock.sleep(ms)
    }

    if (state.forkAnswer !== null) {
      return { value: state.forkAnswer as never }
    }

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
  on('turn.complete', async (_$, e) => {
    await state.enCompletar?.(e)

    return { text: e.answer }
  })
  on('turn.step', async function* (_$, e) {
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
  on('agent.list', () => ({ value: [] }))
  on('store.get', (_$, e) => ({ value: store[e.key] }))
  on('store.set', (_$, e) => {
    store[e.key] = e.value

    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [...panes].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })),
  }))
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    panes.add(e.id)

    return { value: { isPlaced: true as const } }
  })
  on('ui.close', (_$, e) => {
    panes.delete(e.id)

    return { value: undefined }
  })

  return {
    clock,
    store,
    opened,
    spawns,
    writes,
    raw,
    toasts,
    forks,
    ran,
    state,
    turn: () =>
      $.turn.complete({ answer: '', durationMs: 0, isAborted: false, turnId: 't', reason: 'answer' }),
    todo: (list: [string, 'pending' | 'in_progress' | 'completed'][]) =>
      $.tool.call({
        tool: 'TodoWrite',
        todos: list.map(([content, status]) => ({ content, status, activeForm: content })),
      }),
    settle: () => clock.settle(),
    start: (isInteractive = true) =>
      $.session.start({ cwd: '.', surface: isInteractive ? 'terminal' : null, isInteractive }),
    prompt: (text: string) => $.turn.start({ text, turnId: `t${state.index++}` }),
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
    ask: async (cost: TurnUsage | null, agentId?: string) => {
      state.cost = cost
      const stream = $.turn.step({
        turnId: 't',
        index: state.index++,
        model: 'claude-haiku-5-5',
        messageCount: 1,
        ...(agentId === undefined ? {} : { agentId }),
      })

      for await (const _chunk of stream) {
        // sin trozos
      }

      await stream.result
    },
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
    compact: (trigger: 'auto' | 'manual' = 'auto') =>
      $.session.compact({ trigger, messages: [{ role: 'user', text: 'hola', toolUses: [] }] }),
  }
}

const lines = async ($: Engine, bodyColumns = 120): Promise<string[]> => {
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
      scroll: { offset: 0, bodyRows: 80 },
      view: {},
    },
  })
  const root = await ui.find({ key: 'cuerpo' })
  const drawn = (root?.children ?? []).map(shown)
  await ui.unmount()

  return drawn
}

const session = async ($: Engine): Promise<string[]> => {
  await $.command.run({
    command: 'agentes',
    args: 'sesion',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

  return lines($)
}

// Dos peticiones separadas diez minutos: la segunda lee de cache, asi se confirma que dura una hora.
const confirmar = async (w: ReturnType<typeof world>, contexto: number) => {
  await w.ask(usage(10, 5, contexto, 0))
  await w.clock.advance(10 * MIN)
  await w.ask(usage(10, 5, 0, contexto))
}

const historial = (w: ReturnType<typeof world>) =>
  w.writes.findLast(write => write.path.includes('/historial/'))?.text ?? ''

// ---------------------------------------------------------------------------------------------

test('el histórico y los resúmenes van a la raíz del proyecto, se mueva o no el directorio de trabajo', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.prompt('tarea')
  await w.spawn('a1')
  await w.end('a1')
  await w.compact()
  await w.settle()

  expect(w.raw.length).toBeGreaterThan(1)

  // La raiz del proyecto es /proyecto: las dos carpetas deben colgar de ahi, se mueva o no el cwd.
  // En Windows el motor le pone la unidad delante.
  for (const path of w.raw) {
    expect(path).toMatch(/^([A-Za-z]:)?\/proyecto\/\.claude\//)
  }
})

test('/agentes limpiar vacía el panel, pero lo ya guardado sigue en el histórico', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.prompt('tarea vieja')
  await w.spawn('a1', { description: 'encargo-viejo' })
  await w.end('a1')
  expect(historial(w)).toContain('encargo-viejo')

  await w.slash('limpiar')
  await w.prompt('tarea nueva')
  await w.spawn('a2', { description: 'encargo-nuevo' })
  await w.end('a2')

  const text = historial(w)
  expect(text).toContain('encargo-nuevo')
  expect(text).toContain('encargo-viejo')
})

test('un plan nuevo no borra del histórico el anterior', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.todo([['Paso viejo', 'completed']])
  await w.turn()
  expect(historial(w)).toContain('Paso viejo')

  await w.todo([['Paso nuevo', 'in_progress']])
  await w.turn()

  const text = historial(w)
  expect(text).toContain('Paso nuevo')
  expect(text).toContain('Paso viejo')
})

test('pasados 200 agentes el histórico sigue teniéndolos todos', { timeoutMs: 60_000 }, async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.prompt('tarea')

  for (let n = 1; n <= 205; n++) {
    await w.spawn(`a${n}`, { description: `encargo-${n}.` })
    await w.ask(usage(10, 0, 0, 0), `a${n}`)
    await w.end(`a${n}`)
  }

  const text = historial(w)
  expect(text).toContain('encargo-205.')
  expect(text).toContain('agentes 2.050')
  // La cabecera cuenta los 205 agentes: la tabla tambien debe tenerlos.
  expect(text).toContain('encargo-1.')
})

test('con una compactación por medio, limpiar tampoco borra nada del histórico', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.prompt('tarea vieja')
  await w.spawn('a1', { description: 'encargo-viejo' })
  await w.end('a1')
  await w.compact()
  await w.settle()
  expect(historial(w)).toContain('encargo-viejo')

  await w.slash('limpiar')
  await w.turn()
  expect(historial(w)).toContain('encargo-viejo')
})

test('si no se puede guardar el resumen de una compactación, se avisa', async ($, on) => {
  const w = world($, on)
  await w.start()
  w.state.failWrite = /resumenes/
  await w.compact()
  await w.settle()

  const drawn = await session($)
  // Algo debe decir que el resumen no se guardo.
  expect(w.toasts.join()).toContain('No se pudo')
  expect(drawn.join('\n')).toContain('No se pudo')
})

test('lo que cuesta una compactación entra en lo gastado', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.ask(usage(1_000, 0, 0, 0))
  w.state.compactUsage = {
    input_tokens: 5_000,
    output_tokens: 15_000,
    cache_read_input_tokens: 600_000,
    cache_creation_input_tokens: 0,
  }
  await w.compact()
  await w.settle()

  expect(await session($)).toContain('Gastado      21.000')
})

test('un histórico que no se puede escribir sale en Fallos', async ($, on) => {
  const w = world($, on)
  await w.start()
  w.state.failWrite = /historial/
  await w.prompt('tarea')
  await w.spawn('a1')
  await w.end('a1')

  const drawn = await session($)
  expect(drawn.at(-1)).not.toBe('Se guarda al acabar el primer turno con tareas o agentes.')
})

test('un fallo del histórico tras un guardado bueno también sale en Fallos', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.prompt('tarea')
  await w.spawn('a1')
  await w.end('a1')
  const ruta = (await session($)).at(-1)
  expect(ruta).toContain('.claude/historial/')

  w.state.failWrite = /historial/
  await w.spawn('a2')
  await w.end('a2')
  expect((await session($)).at(-1)).not.toBe(ruta)
})

test('si no se pudo ofrecer el plan, la pestaña Tareas lo dice', async ($, on) => {
  const w = world($, on)
  w.state.failToolList = true
  await w.start()
  await w.settle()
  await w.slash('tareas')

  expect(await lines($)).not.toContain('Aparece cuando Claude reparte el trabajo en pasos.')
})

test('un /compact que no compacta deja dicho por qué', async ($, on) => {
  const w = world($, on, { cacheViva: true })
  w.state.forkRead = 500_000
  await w.start()
  await confirmar(w, 500_000)
  // Lo que devuelve la orden /compact si un PreCompact la salta o falla el resumen.
  w.state.commandText = 'Not compacted · blocked by a hook'
  await w.clock.advance(12 * LATIDO_MS)

  const drawn = (await session($)).join('\n')
  expect(w.ran).toEqual(['compact'])
  expect(drawn).toContain('0 compactaciones')
  expect(drawn).not.toContain('compactada a las')
})

test('si /compact rechaza, la nota no dice que se compactó', async ($, on) => {
  const w = world($, on, { cacheViva: true })
  w.state.forkRead = 500_000
  await w.start()
  await confirmar(w, 500_000)
  w.state.failCommand = true
  await w.clock.advance(12 * LATIDO_MS)

  const drawn = await session($)
  expect(w.ran).toEqual([])
  // No se compacto: la nota no puede decir que si.
  expect(drawn.join('\n')).toContain('0 compactaciones')
  expect(drawn.join('\n')).not.toContain('compactada a las')
})

test('si un latido falla, la nota lo dice', async ($, on) => {
  const w = world($, on, { cacheViva: true })
  await w.start()
  await confirmar(w, 500_000)
  w.state.failFork = true
  await w.clock.advance(LATIDO_MS)
  expect(w.forks).toHaveLength(1)

  const drawn = (await session($)).join('\n')
  expect(drawn).toContain('no se pudo')
})

test('tras /model no sale ningún latido: relanzaría el contexto sin caché', async ($, on) => {
  const w = world($, on, { cacheViva: true })
  await w.start()
  await confirmar(w, 500_000)
  // /model en reposo: no hay ninguna peticion que avise al mod, solo el aviso del motor.
  w.state.model = 'claude-fable-5-1'
  await $.classic.PostModelSwitch({
    from_model: 'claude-opus-5-5',
    to_model: 'claude-fable-5-1',
    requested_model: 'fable',
    source: 'command',
    context_tokens: 500_000,
    prompt_cache_warm: true,
    cache_ttl: '1h',
  } as never)
  await w.clock.advance(LATIDO_MS)

  expect(w.forks).toEqual([])
  expect((await session($)).join('\n')).toContain('El modelo cambió')
})

test('con el plan de la caché en marcha se frena la compactación en reposo del motor', async ($, on) => {
  const w = world($, on, { cacheViva: true })
  w.state.forkRead = 500_000
  await w.start()
  await confirmar(w, 500_000)
  expect(await session($)).toContain('Plan         mantenerla hasta 6h56m de pausa; después, compactar')
  await w.clock.advance(LATIDO_MS)
  expect(w.forks).toHaveLength(1)

  // Minuto 54: el temporizador del motor compacta. En la terminal: compactConversation({ instructions: '' })
  // => compactManually({ trigger: 'auto' }), fuera de un turno y con el contexto bajo el umbral.
  await w.clock.advance(2 * MIN)
  const done = await $.session.compact({
    trigger: 'auto',
    messages: [{ role: 'user', text: 'hola', toolUses: [] }],
  })

  expect(done.skip).toBeDefined()
})

test('sin terminal la caché viva no se ofrece ni se promete', async ($, on) => {
  const w = world($, on, { cacheViva: true })
  await $.session.start({ cwd: '.', surface: null, isInteractive: false })
  const answer = (await w.slash('cache si')).text ?? ''
  expect(answer).toContain('solo funciona en la terminal')
  await confirmar(w, 500_000)

  const drawn = await session($)
  expect(drawn.some(line => line.startsWith('Plan'))).toBe(false)
  expect(drawn.some(line => line.startsWith('Mantenerla'))).toBe(false)
  await w.clock.advance(3 * 60 * MIN)
  expect(w.forks).toEqual([])
})

test('/clear pone a cero lo leído por la caché viva', async ($, on) => {
  const w = world($, on, { cacheViva: true })
  w.state.forkRead = 500_000
  await w.start()
  await confirmar(w, 500_000)
  await w.clock.advance(LATIDO_MS)
  expect((await session($)).join('\n')).toContain('Leído')

  await $.session.end({ reason: 'clear', sessionId: 's', resume: {} as never })
  expect((await session($)).join('\n')).not.toContain('Leído')

  await w.prompt('otra')
  await w.spawn('a2')
  await w.end('a2')
  expect(historial(w)).not.toContain('Caché mantenida en las pausas')
})

test('dos escrituras del histórico a la vez: gana lo último', async ($, on) => {
  const w = world($, on)
  await w.start()
  // La escritura que lanza PostCompact (sin cifras) tarda mas que la de session.compact (con ellas).
  w.state.holdHistorial = true
  await w.compact()
  await w.settle()
  await w.clock.advance(1_000)
  await w.settle()

  expect(w.writes.filter(write => write.path.includes('/historial/')).length).toBeGreaterThan(1)
  expect(historial(w)).toContain('650.000 → 40.000')
})

test('dos agentes que acaban a la vez quedan los dos acabados en el histórico', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.prompt('tarea')
  await w.spawn('a1')
  await w.spawn('a2')
  w.state.holdHistorial = true
  const ends = Promise.all([w.end('a1'), w.end('a2')])
  await w.settle()
  await w.clock.advance(1_000)
  await ends
  await w.settle()

  // Los dos acabaron: la ultima escritura no puede decir que alguno sigue en curso.
  expect(historial(w)).not.toContain('| en curso |')
})

test('un resumen vacío no escribe fichero ni avisa de nada', async ($, on) => {
  const w = world($, on)
  await w.start()
  w.state.summary = ''
  await w.compact()
  await w.settle()

  expect(w.writes.filter(write => write.path.includes('/resumenes/'))).toEqual([])
  expect(w.toasts.join()).not.toContain('Resumen de la sesión guardado')
})

test('un latido que saltó durante un turno se recupera al acabar, aunque acabe sin respuesta', async ($, on) => {
  const w = world($, on, { cacheViva: true })
  w.state.forkRead = 500_000
  await w.start()
  await confirmar(w, 500_000)
  // Un turno: su primera peticion pide una herramienta que tarda mas de 52 minutos.
  await w.prompt('tarea larga')
  await w.ask(usage(10, 5, 0, 500_000))
  await w.clock.advance(LATIDO_MS)
  expect(w.forks).toEqual([])
  // Esc a los 55 minutos: el turno acaba sin ninguna peticion mas.
  await w.clock.advance(3 * MIN)
  await w.turn()
  await w.clock.advance(4 * MIN)

  // Quedaban cinco minutos de cache: alguien debe renovarla.
  expect(w.forks).toHaveLength(1)
})

test('una petición y un cambio del ajuste a la vez dejan un solo latido', async ($, on) => {
  const w = world($, on, { cacheViva: true })
  w.state.forkRead = 500_000
  await w.start()
  await confirmar(w, 500_000)
  await Promise.all([w.ask(usage(10, 5, 0, 500_000)), w.slash('cache si')])
  await w.clock.advance(LATIDO_MS)

  expect(w.forks).toHaveLength(1)
})

test('dos armados del latido que coinciden del todo dejan uno solo', async ($, on) => {
  const w = world($, on, { cacheViva: true })
  w.state.forkRead = 500_000
  await w.start()
  await confirmar(w, 500_000)
  await Promise.all([w.slash('cache si'), w.slash('cache si')])
  await w.clock.advance(LATIDO_MS)

  expect(w.forks).toHaveLength(1)
})

test('un latido en vuelo no escribe sobre la conversación nueva tras /clear', async ($, on) => {
  const w = world($, on, { cacheViva: true })
  w.state.forkRead = 500_000
  await w.start()
  await confirmar(w, 500_000)
  w.state.holdFork = true
  await w.clock.advance(LATIDO_MS)
  expect(w.forks).toHaveLength(1)

  await $.session.end({ reason: 'clear', sessionId: 's', resume: {} as never })
  await w.clock.advance(5_000)
  await w.settle()

  const drawn = (await session($)).join('\n')
  expect(drawn).not.toContain('Caduca')
  expect(drawn).not.toContain('Mantenida a las')
})

test('un latido que renovó la caché cuenta aunque acabe sin texto', async ($, on) => {
  const w = world($, on, { cacheViva: true })
  await w.start()
  await confirmar(w, 500_000)
  w.state.forkAnswer = {
    isAnswered: false,
    reason: 'empty-reply',
    usage: {
      input_tokens: 14,
      output_tokens: 4,
      cache_read_input_tokens: 500_000,
      cache_creation_input_tokens: 36,
    },
  }
  await w.clock.advance(LATIDO_MS)
  expect(w.forks).toHaveLength(1)
  expect((await session($)).join('\n')).not.toContain('la consulta falló')

  // La cache se renovo: debe haber otro latido una hora despues.
  await w.clock.advance(LATIDO_MS)
  expect(w.forks).toHaveLength(2)
})

test('tras compactar en una pausa el latido se para', async ($, on) => {
  const w = world($, on, { cacheViva: true })
  w.state.forkRead = 500_000
  await w.start()
  await confirmar(w, 500_000)
  await w.clock.advance(LATIDO_MS)
  expect(w.forks).toHaveLength(1)

  // Compacta la persona con /compact: la conversacion cacheada ya no existe.
  await w.compact('manual')
  await w.settle()
  await w.clock.advance(LATIDO_MS)

  expect(w.forks).toHaveLength(1)
})

test('el aviso de fin de pausa cuenta todas las esperas', async ($, on) => {
  const w = world($, on, { cacheViva: true })
  w.state.forkRead = 500_000
  await w.start()
  await confirmar(w, 500_000)
  await w.clock.advance(12 * LATIDO_MS)
  expect(w.ran).toEqual(['compact'])

  // Doce esperas de 52 minutos desde la ultima peticion: 10h24m.
  expect((await session($)).join('\n')).toContain('Tras 6h56m de pausa')
})

test('los planes anteriores salen en su sección del histórico, y lo que salió en curso ya no lo está', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.todo([['Paso viejo', 'in_progress']])
  await w.turn()
  await w.todo([['Paso nuevo', 'pending']])
  await w.turn()

  const text = historial(w)
  expect(text).toContain('## Planes anteriores')
  expect(text).toContain('| pendiente | Paso viejo |')
})

test('la caché viva no frena lo que no sea una pausa con su plan en marcha', async ($, on) => {
  const w = world($, on, { cacheViva: true })
  w.state.forkRead = 500_000
  await w.start()

  // Sin confirmar que dura una hora no hay plan.
  expect((await w.compact()).skip).toBeUndefined()
  await confirmar(w, 500_000)

  // Lo que pide la persona se hace.
  expect((await w.compact('manual')).skip).toBeUndefined()
  await confirmar(w, 500_000)

  // Con un turno en marcha compacta el motor porque hace falta, no por la pausa.
  await w.prompt('tarea')
  expect((await w.compact()).skip).toBeUndefined()
  await w.turn()
  await confirmar(w, 500_000)
  await w.clock.advance(54 * 60_000)
  expect((await w.compact()).skip).toBeDefined()
})

test('sin la caché viva el motor compacta en reposo como siempre', async ($, on) => {
  const w = world($, on)
  await w.start()
  await confirmar(w, 500_000)
  await w.clock.advance(LATIDO_MS)
  expect((await w.compact()).skip).toBeUndefined()
})

// ---------------------------------------------------------------------------------------------
// El histórico al limpiar y con escrituras que fallan o se cruzan.
// ---------------------------------------------------------------------------------------------

test('un agente en curso al limpiar acaba en el histórico como acabado, con todos sus tokens', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.prompt('tarea')
  await w.spawn('a1', { description: 'encargo' })
  await w.ask(usage(1_000, 0, 0, 0), 'a1')
  await w.slash('limpiar')
  await w.ask(usage(4_000, 0, 0, 0), 'a1')
  await w.end('a1')
  await w.turn()
  const text = historial(w)
  expect(text).not.toContain('| en curso |')
  expect(text).toContain('5.000 | Explore')
})

test('el turno principal no pisa con datos viejos lo que escribió un agente durante su next', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.prompt('tarea')
  await w.spawn('a1')
  await w.turn()
  // Durante el next del turno principal acaba el agente en segundo plano y escribe su histórico.
  let una = true
  w.state.enCompletar = async e => {
    if (una && e.agentId === undefined) {
      una = false
      await w.end('a1')
    }
  }
  await w.prompt('otra')
  await w.ask(usage(10, 5, 0, 0))
  await w.turn()
  await w.settle()
  expect(historial(w)).not.toContain('| en curso |')
})

test('un paso que se vuelve a anotar tras limpiar no sale dos veces en el histórico', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.todo([['Paso A', 'completed'], ['Paso B', 'in_progress']])
  await w.slash('limpiar')
  await w.todo([['Paso A', 'completed'], ['Paso B', 'completed']])
  await w.prompt('x')
  await w.turn()
  expect(historial(w).split('Paso A').length - 1).toBe(1)
})

test('si la primera escritura del histórico se rechaza, la que estaba pendiente se escribe', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.prompt('tarea')
  await w.spawn('a1')
  await w.spawn('a2')
  let primera = true
  w.state.niega = async path => {
    if (primera && path.includes('/historial/')) {
      primera = false
      await w.clock.sleep(1_000)

      return 'EBUSY: resource busy or locked'
    }

    return undefined
  }
  const ends = Promise.all([w.end('a1'), w.end('a2')])
  await w.settle()
  await w.clock.advance(1_000)
  await ends
  await w.settle()
  expect(w.writes.filter(one => one.path.includes('/historial/')).length).toBeGreaterThan(0)
  expect(historial(w)).not.toContain('| en curso |')
})

test('un fallo real del histórico no se borra porque otro guardado se quedó en cola', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.prompt('tarea')
  await w.spawn('a1')
  await w.spawn('a2')
  let veces = 0
  w.state.niega = async path => {
    if (!path.includes('/historial/')) return undefined
    veces += 1

    if (veces === 1) await w.clock.sleep(1_000)

    return 'EBUSY: resource busy or locked'
  }
  const ends = Promise.all([w.end('a1'), w.end('a2')])
  await w.settle()
  await w.clock.advance(1_000)
  await ends
  await w.settle()
  const drawn = await session($)
  expect(drawn).toContain('Fallos')
  expect(drawn.some(line => line.includes('EBUSY'))).toBe(true)
})

test('limpiar a mitad de un guardado no duplica filas en el fichero final', async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.prompt('tarea')
  await w.spawn('a1')
  await w.end('a1')
  await w.slash('limpiar')
  await w.turn()
  expect(historial(w).split('| ok |').length - 1).toBe(1)
})

test('pasadas 50 compactaciones el histórico las sigue teniendo todas', { timeoutMs: 60_000 }, async ($, on) => {
  const w = world($, on)
  await w.start()
  await w.prompt('tarea')

  for (let n = 0; n < 53; n += 1) {
    await w.compact('manual')
    await w.clock.advance(3 * MIN)
  }

  await w.turn()
  await w.settle()
  expect(historial(w)).toContain('- Compactaciones: 53')
})

test('un worktree que luego se borra no se lleva el histórico de la sesión', async ($, on) => {
  const w = world($, on)
  await w.start()
  w.state.raiz = '/proyecto/.claude/worktrees/x'
  await w.prompt('tarea')
  await w.spawn('a1')
  await w.end('a1')
  w.state.raiz = '/proyecto'
  await w.prompt('otra')
  await w.turn()
  expect(w.raw.at(-1)).toContain('/proyecto/.claude/historial/')
  expect(w.raw.at(-1)).not.toContain('/worktrees/')
})

// ---------------------------------------------------------------------------------------------
// La caché viva: pausas, latidos que fallan y compactaciones que se cruzan.
// ---------------------------------------------------------------------------------------------

// Una API que no contesta, como la contesta el motor.
const caida = {
  isAnswered: false,
  reason: 'api-error',
  status: 529,
  error: 'overloaded',
  usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
}

test('con un latido en vuelo a los 54 minutos, la compactación en reposo del motor se veta', async ($, on) => {
  const w = world($, on, { cacheViva: true })
  w.state.forkRead = 500_000
  await w.start()
  await confirmar(w, 500_000)
  await w.turn()
  w.state.forkHoldMs = 180_000
  await w.clock.advance(LATIDO_MS)
  expect(w.forks).toHaveLength(1)
  await w.clock.advance(2 * MIN)
  expect((await w.compact()).skip).toBeDefined()
})

test('un fallo pasajero del primer latido no acaba el plan de toda la pausa', async ($, on) => {
  const w = world($, on, { cacheViva: true })
  w.state.forkRead = 500_000
  await w.start()
  await confirmar(w, 500_000)
  await w.turn()
  w.state.forkAnswer = caida
  await w.clock.advance(LATIDO_MS)
  expect(w.forks).toHaveLength(1)
  w.state.forkAnswer = null
  await w.clock.advance(7 * MIN)
  expect(w.forks.length).toBeGreaterThan(1)
})

test('la nota del cambio de modelo no promete mantener la caché si esta dura 5 minutos', async ($, on) => {
  const w = world($, on, { cacheViva: true })
  await w.start()
  await confirmar(w, 500_000)
  await w.turn()
  await $.classic.PostModelSwitch({
    from_model: 'claude-opus-5-5',
    to_model: 'claude-fable-5-1',
    requested_model: 'fable',
    source: 'command',
    context_tokens: 500_000,
    prompt_cache_warm: true,
    cache_ttl: '5m',
  } as never)
  expect((await session($)).join('\n')).not.toContain('se mantendrá desde la próxima petición')
})

test('sin terminal la nota del cambio de modelo no promete mantener la caché', async ($, on) => {
  const w = world($, on, { cacheViva: true })
  await $.session.start({ cwd: '.', surface: null, isInteractive: false })
  await confirmar(w, 500_000)
  await w.turn()
  await $.classic.PostModelSwitch({
    from_model: 'claude-opus-5-5',
    to_model: 'claude-fable-5-1',
    requested_model: 'fable',
    source: 'command',
    context_tokens: 500_000,
    prompt_cache_warm: true,
    cache_ttl: '1h',
  } as never)
  expect((await session($)).join('\n')).not.toContain('se mantendrá')
})

test('entre dos turnos seguidos el compactado por umbral no se veta', async ($, on) => {
  const w = world($, on, { cacheViva: true })
  await w.start()
  await confirmar(w, 500_000)
  await w.prompt('a')
  await w.ask(usage(10, 5, 0, 500_000))
  await w.turn()
  // Prompt en cola: el turn.start del siguiente aún no ha llegado al hook y el motor ya decide compactar.
  expect((await w.compact()).skip).toBeUndefined()
})

test('un latido que no acierta la caché cuenta lo que gasta', async ($, on) => {
  const w = world($, on, { cacheViva: true })
  await w.start()
  await confirmar(w, 500_000)
  await w.turn()
  const antes = (await session($)).find(line => line.startsWith('Gastado'))
  w.state.forkAnswer = {
    isAnswered: true,
    text: 'ok',
    usage: { input_tokens: 500_000, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }
  await w.clock.advance(LATIDO_MS)
  const despues = (await session($)).find(line => line.startsWith('Gastado'))
  expect(despues).not.toBe(antes)
})

test('tras «la caché ya no estaba», un turno sin respuesta no relanza otra consulta', async ($, on) => {
  const w = world($, on, { cacheViva: true })
  w.state.forkRead = 0
  await w.start()
  await confirmar(w, 500_000)
  await w.turn()
  await w.clock.advance(LATIDO_MS)
  expect(w.forks).toHaveLength(1)
  // Vuelve, escribe y pulsa Esc antes de la respuesta: turn.complete sin usage.
  await w.clock.advance(MIN)
  await w.prompt('hola')
  await w.turn()
  await w.clock.advance(5_000)
  expect(w.forks).toHaveLength(1)
})

test('la nota de una pausa sin latidos sigue durante la primera petición tras ella', async ($, on) => {
  const w = world($, on, { cacheViva: true })
  w.state.forkRead = 0
  await w.start()
  await confirmar(w, 500_000)
  await w.turn()
  await w.clock.advance(LATIDO_MS)
  expect((await session($)).join('\n')).toContain('La caché ya no estaba')
  await w.prompt('vuelvo')
  await w.ask(usage(10, 5, 500_000, 0))
  expect((await session($)).join('\n')).toContain('La caché ya no estaba')
})

test('un acierto con mucha entrada nueva no rebaja la duración a 5 minutos', async ($, on) => {
  const w = world($, on, { cacheViva: true })
  await w.start()
  await confirmar(w, 40_000)
  await w.turn()
  expect(await session($)).toContain('Duración     1 hora')
  // Una herramienta de 6 minutos que devuelve 50.000 tokens: se lee entero lo que había en caché.
  await w.prompt('compila')
  await w.ask(usage(10, 5, 0, 40_000))
  await w.clock.advance(6 * MIN)
  await w.ask(usage(10, 5, 50_000, 40_000))
  expect(await session($)).toContain('Duración     1 hora')
})

test('un fallo pasajero del segundo latido no deja la pausa sin plan: sigue con otro latido o compacta', async ($, on) => {
  const w = world($, on, { cacheViva: true })
  w.state.forkRead = 500_000
  await w.start()
  await confirmar(w, 500_000)
  await w.turn()
  await w.clock.advance(LATIDO_MS)
  expect(w.forks).toHaveLength(1)
  // Minuto 54: se veta la compactación en reposo del motor, que ya no vuelve a intentarlo.
  await w.clock.advance(2 * MIN)
  expect((await w.compact()).skip).toBeDefined()
  w.state.forkAnswer = { ...caida, status: 429, error: 'rate_limit' }
  await w.clock.advance(50 * MIN)
  expect(w.forks).toHaveLength(2)
  w.state.forkAnswer = null
  await w.clock.advance(7 * MIN)
  expect(w.forks.length + w.ran.length).toBeGreaterThan(2)
})

test('la línea Plan y la nota de lo que se hizo dicen la misma duración y lo mismo', async ($, on) => {
  const w = world($, on, { cacheViva: true })
  w.state.forkRead = 500_000
  await w.start()
  await confirmar(w, 500_000)
  await w.turn()
  const plan = (await session($)).find(line => line.startsWith('Plan'))
  await w.clock.advance(12 * LATIDO_MS)
  const nota = (await session($)).find(line => line.startsWith('Tras'))
  const pausa = plan?.match(/hasta (\S+) de pausa; después, compactar/)?.[1]
  expect(pausa).toBeDefined()
  expect(nota).toContain(`Tras ${pausa} de pausa salía más barato compactar`)
})

test('una compactación parcial (solo PostCompact) para el latido', async ($, on) => {
  const w = world($, on, { cacheViva: true })
  w.state.forkRead = 500_000
  await w.start()
  await confirmar(w, 500_000)
  await w.turn()
  // Resumir desde aquí: el motor lanza PostCompact y no session.compact.
  await $.classic.PostCompact({ trigger: 'manual', compact_summary: 'R' })
  await w.settle()
  await w.clock.advance(LATIDO_MS)
  expect(w.forks).toHaveLength(0)
  expect((await session($)).join('\n')).not.toContain('sale más barato dejarla caducar')
})

test('un latido que no encuentra la caché no se repite pausa tras pausa', async ($, on) => {
  const w = world($, on, { cacheViva: true })
  w.state.forkRead = 0
  await w.start()
  await confirmar(w, 500_000)
  await w.turn()
  await w.clock.advance(LATIDO_MS)
  expect(w.forks).toHaveLength(1)
  await w.clock.advance(3 * 60 * MIN)
  // Vuelve: reescribe la caché entera, trabaja y se va otra vez.
  await w.prompt('vuelvo')
  await w.ask(usage(10, 5, 500_000, 0))
  await w.turn()
  await w.clock.advance(LATIDO_MS)
  expect(w.forks).toHaveLength(1)
})

test('con el compactado automático apagado la caché viva no compacta sola', async ($, on) => {
  const w = world($, on, { cacheViva: true })
  w.state.forkRead = 500_000
  w.state.autoOff = true
  await w.start()
  await confirmar(w, 500_000)
  await w.turn()
  await $.command.run({
    command: 'tokens-compact',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  await w.clock.advance(12 * LATIDO_MS)
  expect(w.ran).toEqual([])
})

test('con la API caída el latido reintenta sin bucle y acaba compactando', async ($, on) => {
  const w = world($, on, { cacheViva: true })
  await w.start()
  await confirmar(w, 500_000)
  await w.turn()
  w.state.forkAnswer = caida
  await w.clock.advance(LATIDO_MS)
  await w.clock.advance(2 * MIN)
  expect((await w.compact()).skip).toBeDefined()
  await w.clock.advance(30 * MIN)
  expect(w.forks.length).toBeLessThanOrEqual(3)
  expect(w.ran).toEqual(['compact'])
})

test('con poco contexto y la API caída, la pausa acaba en una nota sin compactar', async ($, on) => {
  const w = world($, on, { cacheViva: true })
  await w.start()
  await confirmar(w, 100_000)
  await w.turn()
  w.state.forkAnswer = caida
  await w.clock.advance(LATIDO_MS)
  await w.clock.advance(30 * MIN)
  expect(w.forks.length).toBeLessThanOrEqual(3)
  expect(w.ran).toEqual([])
  expect((await session($)).join('\n')).toContain('la consulta falló')
})

test('tras no encontrar la caché, la duración se reconfirma y el plan vuelve', async ($, on) => {
  const w = world($, on, { cacheViva: true })
  w.state.forkRead = 0
  await w.start()
  await confirmar(w, 500_000)
  await w.turn()
  await w.clock.advance(LATIDO_MS)
  expect(w.forks).toHaveLength(1)
  await w.prompt('vuelvo')
  await w.ask(usage(10, 5, 500_000, 0))
  await w.turn()
  await w.clock.advance(10 * MIN)
  await w.prompt('sigo')
  await w.ask(usage(10, 5, 0, 500_000))
  await w.turn()
  expect(await session($)).toContain('Duración     1 hora')
  w.state.forkRead = 500_000
  await w.clock.advance(LATIDO_MS)
  expect(w.forks).toHaveLength(2)
})

test('con idleCompaction en false la caché viva tampoco compacta', async ($, on) => {
  const w = world($, on, { cacheViva: true })
  w.state.forkRead = 500_000
  w.state.idleOff = true
  await w.start()
  await confirmar(w, 500_000)
  await w.turn()
  await w.clock.advance(12 * LATIDO_MS + MIN)
  expect(w.ran).toEqual([])
})
