import { expect, mock, test } from 'claude-code/testing'
import type {
  CommandSpec,
  On,
  SessionRateLimit,
  TurnUsage,
} from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { usage } from './apoyo'

// La barra, la marca y los límites del plan: cada prueba nació de un fallo real.
const VENTANA = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'
const PORCENTAJE = 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'
const NOW = Date.UTC(2026, 9, 8, 0, 5, 12)

const props = (bodyColumns: number, maxRows = 10) => ({
  hasSurvey: false,
  isWorking: false,
  maxRows,
  bodyColumns,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
})

const world = (
  $: Engine,
  on: On,
  stored: Record<string, unknown> = {},
  variables: Record<string, string> = {},
) => {
  const clock = mock.clock(on, { now: NOW })
  const store: Record<string, unknown> = { ...stored }
  const env: Record<string, string | undefined> = { ...variables }
  const toasts: string[] = []
  const registered: string[] = []
  const specs: CommandSpec[] = []
  const writes: string[] = []
  const state = {
    cost: null as TurnUsage | null,
    index: 0,
    context: undefined as number | undefined,
    window: 1_000_000,
    reader: false,
    limits: [] as SessionRateLimit[],
    model: 'claude-opus-5-5',
    usageText: null as string | null,
    // Averias a la carta.
    runRejects: false,
    storeBroken: false,
    envDeny: null as string | null,
    envHookDeny: null as string | null,
    autoCompactOff: false,
    // El motor no da el desglose del contexto (una conexión remota), y rechaza lo que se guarda.
    sinDesglose: false,
    storeSetDeny: false,
    turns: 0,
  }
  const spawned: string[][] = []
  const ran: string[][] = []

  on('process.spawn', async function* (_$, e) {
    spawned.push([...e.argv])
    throw new Error('spawn powershell.exe ENOENT')
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
  on('session.usage', (_$, e) => {
    if (state.sinDesglose && (e as { breakdown?: unknown }).breakdown !== undefined) {
      throw new Error("the context breakdown isn't available over this remote connection")
    }

    return {
      value: {
        startedAt: 0,
        context: {
          window: state.window,
          tokens: state.context,
          ...(state.autoCompactOff ? { breakdown: { isAutoCompactEnabled: false } } : {}),
        },
        rateLimits: state.limits,
      },
    } as never
  })
  on('session.turns', () => ({ value: state.turns }))
  on('session.root', () => ({ value: '/proyecto' }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.model', () => ({ value: state.model }))
  on('settings.read', () => ({ value: {} }))
  on('process.run', (_$, e) => {
    ran.push([...e.argv])

    if (state.runRejects) {
      throw new Error('timed out after 30000ms')
    }

    return {
      value: {
        exitCode: state.usageText === null ? 1 : 0,
        stdout: state.usageText ?? '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('command.run', () => ({ text: '' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => {
    registered.push(e.name)
    specs.push(e)

    return { value: { command: e.name } }
  })
  on('store.get', (_$, e) => {
    if (state.storeBroken) {
      throw new Error('tokens-sesion: store file x.json is malformed (Unexpected token)')
    }

    return { value: store[e.key] }
  })
  on('store.set', (_$, e) => {
    if (state.storeSetDeny) return { deny: 'store.set: lock' } as never
    store[e.key] = e.value

    return { value: undefined }
  })
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('env.set', (_$, e) => {
    if (state.envHookDeny !== null) {
      return { deny: state.envHookDeny }
    }

    if (state.envDeny !== null) {
      return { value: { deny: state.envDeny } }
    }

    env[e.name] = e.value

    return { value: {} }
  })
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('ui.message', () => ({}))
  on('ui.fault', () => ({}))
  on('classic.PostModelSwitch', () => ({}))
  on('fs.write', (_$, e) => {
    writes.push(e.path)

    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(JSON.stringify(e))

    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('tool.list', () => ({ value: [] }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__tokens-sesion__${e.name}` } }))

  return {
    env,
    store,
    toasts,
    registered,
    specs,
    writes,
    spawned,
    ran,
    clock,
    state,
    start: (isInteractive = true) =>
      $.session.start({ cwd: '.', surface: isInteractive ? 'terminal' : null, isInteractive }),
    slash: (args: string) =>
      $.command.run({
        command: 'tokens-compact',
        args,
        origin: { kind: 'composer' },
        presentation: { isFullscreen: true, columns: 120 },
      }),
    agentes: (args: string) =>
      $.command.run({
        command: 'agentes',
        args,
        origin: { kind: 'composer' },
        presentation: { isFullscreen: true, columns: 160 },
      }),
    ask: async (cost: TurnUsage | null, agentId?: string) => {
      state.cost = cost
      const stream = $.turn.step({
        turnId: 't',
        index: state.index++,
        model: state.model,
        messageCount: 1,
        ...(agentId === undefined ? {} : { agentId }),
      })

      for await (const _chunk of stream) {
        // sin trozos
      }

      await stream.result
    },
    measure: (tokens: number | undefined) =>
      $.session.measure({
        context: { window: state.window, tokens },
        rateLimits: state.limits,
        changed: ['context', 'rateLimits'],
      }),
  }
}

const mount = ($: Engine, bodyColumns = 120, maxRows = 10) =>
  $.ui.mount({
    plugin: 'tokens-sesion',
    component: 'AbovePrompt',
    props: props(bodyColumns, maxRows),
    surface: 'terminal',
  })

type Band = Awaited<ReturnType<typeof mount>>

const bar = async (ui: Band): Promise<string> =>
  (await ui.findAll({ type: 'Text', in: 'deslizador' })).map(cell => cell.text).join('')

const texts = async (ui: Band): Promise<string[]> =>
  (await ui.findAll({ type: 'Text' })).map(text => text.text)

const clic = async (ui: Band, x: number) => {
  await ui.pointer({ type: 'down', x, y: 0, button: 'left' })
  await ui.pointer({ type: 'up', x, y: 0, button: 'left' })
}

const DEFECTO = (store: Record<string, unknown>) => store.umbral ?? 650_000

const report = (fable: number, resets = 'Oct 9, 10pm') =>
  [
    'Current week (all models): 81% used · resets Oct 9, 10pm (Europe/Madrid)',
    `Current week (Fable): ${fable}% used · resets ${resets} (Europe/Madrid)`,
  ].join('\n')

test('/agentes y /tokens-compact se ejecutan sin esperar a que acabe el turno', async ($, on) => {
  const { specs, start } = world($, on)

  await start()
  const inmediatos = specs.filter(spec => spec.immediate).map(spec => spec.name)
  expect(inmediatos).toContain('tokens-compact')
  expect(inmediatos).toContain('agentes')
})

test('un clic en la marca sin moverla no cambia el umbral: modelo de 200k', async ($, on) => {
  const { start, state, store } = world($, on, { umbral: 650_000 })

  state.window = 200_000
  await start()
  const ui = await mount($)
  await clic(ui, 6)
  await ui.unmount()
  expect(store.umbral).toBe(650_000)
})

test('un clic en la marca sin moverla no cambia el umbral: barra de 10 celdas', async ($, on) => {
  const { slash, start, store } = world($, on)

  await start()
  await slash('850000')
  const ui = await mount($, 54)
  await clic(ui, 8)
  await ui.unmount()
  expect(store.umbral).toBe(850_000)
})

test('un clic en la marca sin moverla no cambia el umbral: umbral entre dos celdas', async ($, on) => {
  const { slash, start, store } = world($, on)

  await start()
  await slash('660000')
  const ui = await mount($)
  await clic(ui, 26)
  await ui.unmount()
  expect(store.umbral).toBe(660_000)
})

test('un clic en la marca sin moverla no cambia el umbral: con CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', async ($, on) => {
  const { slash, start, store } = world($, on, {}, { [PORCENTAJE]: '80' })

  await start()
  await slash('900000')
  const ui = await mount($)
  await clic(ui, 31)
  await ui.unmount()
  expect(store.umbral).toBe(900_000)
})

test('un clic en la marca sin moverla no cambia el umbral: 14 celdas y modelo de 200k', async ($, on) => {
  const { start, state, store } = world($, on, { umbral: 650_000 })

  state.window = 200_000
  await start()
  const ui = await mount($, 58)
  await clic(ui, 2)
  await ui.unmount()
  expect(store.umbral).toBe(650_000)
})

test('la marca vuelve a su celda si /tokens-compact devuelve el umbral tras un arrastre', async ($, on) => {
  const { env, slash, start } = world($, on)

  await start()
  const ui = await mount($)
  await ui.pointer({ type: 'down', x: 26, y: 0, button: 'left' })
  await ui.pointer({ type: 'move', x: 30, y: 0, button: 'left' })
  await ui.pointer({ type: 'up', x: 30, y: 0, button: 'left' })
  await slash('650000')
  const drawn = await bar(ui)
  await ui.unmount()
  expect(env[VENTANA]).toBe('683000')
  expect(drawn.indexOf('┃')).toBe(26)
})

test('un clic con un modelo pequeño deja la marca donde rige el umbral', async ($, on) => {
  const { start, state } = world($, on, { umbral: 650_000 })

  state.window = 200_000
  await start()
  const ui = await mount($)
  await clic(ui, 6)
  const drawn = await bar(ui)
  await ui.unmount()
  // Rige 167.000: la celda 6.
  expect(drawn.indexOf('┃')).toBe(6)
})

test('un fallo pasajero de /usage no congela el límite por modelo: al reintentar vuelve', async ($, on) => {
  const { ask, clock, ran, start, state } = world($, on)

  state.model = 'claude-fable-5-1'
  state.usageText = report(12)
  state.limits = [{ kind: 'seven_day', percentUsed: 81 }]
  await start()
  await clock.settle()
  let ui = await mount($)
  expect((await texts(ui)).join('|')).toContain('Semana Fable: 12% usado')
  await ui.unmount()

  state.runRejects = true
  await clock.advance(5 * 60_000)
  await ask(usage(1_000, 0, 0, 0))
  await clock.settle()
  expect(ran).toHaveLength(2)

  // El fallo paso: una hora despues /usage ya dice 99 %.
  state.runRejects = false
  state.usageText = report(99)
  await clock.advance(60 * 60_000)
  await ask(usage(1_000, 0, 0, 0))
  await clock.settle()
  ui = await mount($)
  const band = (await texts(ui)).join('|')
  await ui.unmount()
  expect(band).toContain('Semana Fable: 99% usado')
})

test('una salida con error de /usage tampoco apaga el límite por modelo', async ($, on) => {
  const { ask, clock, start, state } = world($, on)

  state.model = 'claude-fable-5-1'
  state.usageText = report(12)
  state.limits = [{ kind: 'seven_day', percentUsed: 81 }]
  await start()
  await clock.settle()

  state.usageText = null
  await clock.advance(5 * 60_000)
  await ask(usage(1_000, 0, 0, 0))
  await clock.settle()

  state.usageText = report(99)
  await clock.advance(60 * 60_000)
  await ask(usage(1_000, 0, 0, 0))
  await clock.settle()
  const ui = await mount($)
  const band = (await texts(ui)).join('|')
  await ui.unmount()
  expect(band).toContain('Semana Fable: 99% usado')
})

test('si una política niega la ventana no se anuncia un umbral que no se aplicó', async ($, on) => {
  const { env, slash, start, state } = world($, on, {}, { [VENTANA]: '683000' })

  await start()
  state.envDeny = 'held by the organization'
  const text = (await slash('400000')).text
  expect(env[VENTANA]).toBe('683000')
  expect(text).not.toContain('400.000')
})

test('si un hook niega la ventana tampoco se guarda el umbral', async ($, on) => {
  const { slash, start, state, store } = world($, on, {}, { [VENTANA]: '683000' })

  await start()
  state.envHookDeny = 'env (managed): CLAUDE_CODE_AUTO_COMPACT_WINDOW is not for plugins outside policy to change'
  expect((await slash('400000')).text).toContain('No se pudo cambiar el umbral')
  expect(store.umbral).toBeUndefined()
})

test('un hook que niega la ventana al arrancar no se lleva el resto del arranque', async ($, on) => {
  const { registered, spawned, start, state } = world($, on, {}, { [VENTANA]: '683000' })

  state.envHookDeny = 'env (managed): CLAUDE_CODE_AUTO_COMPACT_WINDOW is not for plugins outside policy to change'
  await start()
  expect(registered).toContain('tokens-compact')
  expect(registered).toContain('agentes')
  expect(spawned.some(argv => argv[0] === 'powershell.exe')).toBe(true)
})

test('sin compactado automático no hay marca', async ($, on) => {
  const { slash, start, state } = world($, on)

  state.autoCompactOff = true
  await start()
  expect((await slash('')).text).toContain('apagado')
  const ui = await mount($)
  const drawn = await bar(ui)
  await ui.unmount()
  expect(drawn).not.toContain('┃')
})

test('un fallo al arrancar una herramienta no se lleva a las demás', async ($, on) => {
  const { clock, ran, registered, spawned, start, state } = world($, on)

  state.storeBroken = true
  await start()
  await clock.settle()
  expect(registered).toContain('tokens-compact')
  expect(registered).toContain('agentes')
  expect(spawned.some(argv => argv[0] === 'powershell.exe')).toBe(true)
  expect(ran.filter(argv => argv.includes('/usage'))).toHaveLength(1)
})

test('/tokens-compact 0 dice la verdad: quita el umbral y el motor sigue compactando', async ($, on) => {
  const { env, slash, start } = world($, on)

  await start()
  const text = (await slash('0')).text
  expect(env[VENTANA]).toBeUndefined()
  expect(text).not.toContain('desactivado')
})

test('un arrastre que perdió su up no sigue al ratón, y el clic siguiente lo descarta', async ($, on) => {
  const { start, store } = world($, on)

  await start()
  const ui = await mount($)
  await ui.pointer({ type: 'down', x: 26, y: 0, button: 'left' })
  await ui.pointer({ type: 'move', x: 30, y: 0, button: 'left' })
  await ui.pointer({ type: 'move', x: 12, y: 0 })
  const drawn = await bar(ui)
  await clic(ui, 12)
  await ui.unmount()
  expect(drawn).not.toContain('300.000')
  expect(DEFECTO(store)).toBe(650_000)
})

test('un move en el mismo fotograma que el up no rearma el arrastre', async ($, on) => {
  const { start, store } = world($, on)

  await start()
  const ui = await mount($)
  await ui.pointer({ type: 'down', x: 26, y: 0, button: 'left' })
  await ui.pointer({ type: 'move', x: 30, y: 0, button: 'left' })
  // Sin esperar entre uno y otro.
  await Promise.all([
    ui.pointer({ type: 'up', x: 30, y: 0, button: 'left' }),
    ui.pointer({ type: 'move', x: 12, y: 0 }),
  ])
  const after = await bar(ui)
  await ui.pointer({ type: 'move', x: 14, y: 0 })
  const hover = await bar(ui)
  await clic(ui, 12)
  await ui.unmount()
  expect(after.indexOf('┃')).toBe(30)
  expect(hover.indexOf('┃')).toBe(30)
  expect(store.umbral).toBe(750_000)
})

test('un clic rápido, con down y up en el mismo fotograma, no deja el arrastre vivo', async ($, on) => {
  const { start, store } = world($, on)

  await start()
  const ui = await mount($)
  await Promise.all([
    ui.pointer({ type: 'down', x: 26, y: 0, button: 'left' }),
    ui.pointer({ type: 'up', x: 26, y: 0, button: 'left' }),
  ])
  const after = await bar(ui)
  await ui.pointer({ type: 'move', x: 12, y: 0 })
  const hover = await bar(ui)
  await clic(ui, 12)
  await ui.unmount()
  expect(after.indexOf('┃')).toBe(26)
  expect(hover).not.toContain('300.000')
  expect(DEFECTO(store)).toBe(650_000)
})

test('el up que sintetiza el terminal confirma lo enseñado, no la x del ratón', async ($, on) => {
  const { start, store } = world($, on)

  await start()
  const ui = await mount($)
  await ui.pointer({ type: 'down', x: 26, y: 0, button: 'left' })
  await ui.pointer({ type: 'move', x: 30, y: 0, button: 'left' })
  // handlePointerHover: releasePointerCapture(unreported) y luego el move sin boton.
  await ui.pointer({ type: 'up', x: 12, y: 0, button: 'left' })
  await ui.pointer({ type: 'move', x: 12, y: 0 })
  const drawn = await bar(ui)
  await ui.unmount()
  expect(drawn.indexOf('┃')).toBe(30)
  expect(store.umbral).toBe(750_000)
})

test('tras /model la marca pasa al tope del modelo nuevo sin esperar a un turno', async ($, on) => {
  const { start, state } = world($, on)

  await start()
  state.window = 200_000
  state.model = 'claude-haiku-4-5'
  await $.classic.PostModelSwitch({
    from_model: 'claude-opus-5-5',
    to_model: 'claude-haiku-4-5',
    requested_model: 'haiku',
    source: 'command',
    context_tokens: 300_000,
  } as never)
  const ui = await mount($)
  const drawn = await bar(ui)
  await ui.unmount()
  // Rige 167.000: la celda 6.
  expect(drawn.indexOf('┃')).toBe(6)
})

test('el límite Current week (Sonnet only) se asocia a un modelo Sonnet', async ($, on) => {
  const { clock, start, state } = world($, on)

  state.model = 'claude-sonnet-5-5'
  state.usageText = [
    'Current session: 35% used · resets 5am (Europe/Madrid)',
    'Current week (all models): 28% used · resets Oct 9, 10pm (Europe/Madrid)',
    'Current week (Sonnet only): 70% used · resets Oct 9, 10pm (Europe/Madrid)',
  ].join('\n')
  state.limits = [{ kind: 'seven_day', percentUsed: 28 }]
  await start()
  await clock.settle()
  const ui = await mount($)
  const band = (await texts(ui)).join('|')
  await ui.unmount()
  expect(band).toContain('70%')
})

test('/tokens-compact con solo signos no vale por 0', async ($, on) => {
  const { slash, start, store } = world($, on, { umbral: 700_000 })

  await start()

  for (const typed of ['.', '_', '...', '. _']) {
    store.umbral = 700_000
    const text = (await slash(typed)).text
    expect(text, typed).toContain('no vale')
    expect(store.umbral, typed).toBe(700_000)
  }
})

test('en una barra estrecha la cifra del arrastre sale entera: 14 celdas', async ($, on) => {
  const { start } = world($, on)

  await start()
  const ui = await mount($, 58)
  await ui.pointer({ type: 'down', x: 9, y: 0, button: 'left' })
  await ui.pointer({ type: 'move', x: 6, y: 0, button: 'left' })
  const drawn = await bar(ui)
  await ui.unmount()
  expect(drawn).toContain('429.000')
})

test('en una barra estrecha la cifra del arrastre sale entera: 10 celdas', async ($, on) => {
  const { start } = world($, on)

  await start()
  const ui = await mount($, 54)
  await ui.pointer({ type: 'down', x: 6, y: 0, button: 'left' })
  const drawn = await bar(ui)
  await ui.unmount()
  expect(drawn).toContain('600.000')
})

test('pasada la renovación, la banda deja de enseñar el porcentaje viejo', async ($, on) => {
  const { clock, measure, start, state } = world($, on)

  state.limits = [
    { kind: 'seven_day', percentUsed: 98, resetsAt: new Date(NOW + 3_600_000).toISOString() },
  ]
  await start()
  await measure(1_000)
  await clock.advance(2 * 3_600_000)
  const ui = await mount($)
  const band = (await texts(ui)).join('|')
  await ui.unmount()
  expect(band).not.toContain('98% usado')
})

// El kit no lanza `ui.fault`: lo que hace la banda con un fallo de la barra no se puede probar aquí.

test('la misma cifra de límite sale igual en la banda y en la pestaña Sesión', async ($, on) => {
  const { agentes, measure, start, state } = world($, on)

  state.limits = [{ kind: 'seven_day', percentUsed: 85.4 }]
  await start()
  await measure(1_000)
  const ui = await mount($)
  const label = (await ui.findAll({ type: 'Text' })).find(text => text.text.startsWith('Semana'))
  await ui.unmount()
  await agentes('sesion')
  const pane = await $.ui.mount({
    plugin: 'tokens-sesion',
    component: 'Pane',
    requestId: 'agentes',
    surface: 'terminal',
    props: {
      title: 'Agentes',
      isFocused: false,
      bodyColumns: 60,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  })
  const fila = (await pane.findAll({ type: 'Text' })).find(text => text.text.includes('85 % usado'))
  await pane.unmount()
  expect(fila?.props.color).toBe(label?.props.color)
})

test('un arrastre vivo y un clic lejos lo cancelan sin guardar, y la marca vuelve', async ($, on) => {
  const { clock, start, store } = world($, on)

  await start()
  const ui = await mount($)
  const antes = await bar(ui)
  await ui.pointer({ type: 'down', x: 26, y: 0, button: 'left' })
  await ui.pointer({ type: 'move', x: 30, y: 0, button: 'left' })
  // El up se perdió: llega otro down lejos de la marca.
  await ui.pointer({ type: 'down', x: 5, y: 0, button: 'left' })
  await ui.pointer({ type: 'up', x: 5, y: 0, button: 'left' })
  await clock.settle()
  expect(await bar(ui)).toBe(antes)
  expect(store.umbral).toBeUndefined()
  await ui.unmount()
})

test('un arrastre vivo y un nuevo agarre en la marca: el up sin moverse no guarda', async ($, on) => {
  const { clock, start, store } = world($, on)

  await start()
  const ui = await mount($)
  await ui.pointer({ type: 'down', x: 26, y: 0, button: 'left' })
  await ui.pointer({ type: 'move', x: 30, y: 0, button: 'left' })
  await ui.pointer({ type: 'down', x: 26, y: 0, button: 'left' })
  await ui.pointer({ type: 'up', x: 26, y: 0, button: 'left' })
  await clock.settle()
  expect(store.umbral).toBeUndefined()
  await ui.unmount()
})

test('si no se puede guardar lo soltado, la marca vuelve y el arrastre siguiente sí se guarda', async ($, on) => {
  const { clock, start, state, store } = world($, on)

  await start()
  const ui = await mount($)
  state.storeSetDeny = true
  await ui.pointer({ type: 'down', x: 26, y: 0, button: 'left' })
  await ui.pointer({ type: 'move', x: 30, y: 0, button: 'left' })
  await ui.pointer({ type: 'up', x: 30, y: 0, button: 'left' })
  await clock.settle()
  state.storeSetDeny = false
  const antes = await bar(ui)
  // Tras el rechazo la marca está en su sitio y se puede volver a arrastrar.
  await ui.pointer({ type: 'down', x: 26, y: 0, button: 'left' })
  await ui.pointer({ type: 'move', x: 30, y: 0, button: 'left' })
  await ui.pointer({ type: 'up', x: 30, y: 0, button: 'left' })
  await clock.settle()
  expect(store.umbral).toBe(750_000)
  expect(await bar(ui)).not.toBe(antes)
  await ui.unmount()
})

test('agarrar al lado de la marca y soltar en la marca no cambia el umbral', async ($, on) => {
  const { clock, start, store } = world($, on, { umbral: 660_000 })

  await start()
  const ui = await mount($)
  await ui.pointer({ type: 'down', x: 27, y: 0, button: 'left' })
  await ui.pointer({ type: 'move', x: 26, y: 0, button: 'left' })
  await ui.pointer({ type: 'up', x: 26, y: 0, button: 'left' })
  await clock.settle()
  expect(store.umbral).toBe(660_000)
  await ui.unmount()
})

test('si el compactado automático se apaga a mitad de sesión, soltar la marca lo dice y guarda el umbral', async ($, on) => {
  const { clock, start, state, store, toasts } = world($, on)

  await start()
  state.autoCompactOff = true
  const ui = await mount($)
  await ui.pointer({ type: 'down', x: 26, y: 0, button: 'left' })
  await ui.pointer({ type: 'move', x: 30, y: 0, button: 'left' })
  await ui.pointer({ type: 'up', x: 30, y: 0, button: 'left' })
  await ui.unmount()
  await clock.settle()
  expect(toasts.join('|')).toContain('El compactado automático está apagado')
  expect(store.umbral).toBe(750_000)
})

test('si el compactado automático se enciende a mitad de sesión, la marca vuelve con la medida siguiente', async ($, on) => {
  const { env, measure, start, state } = world($, on)

  state.autoCompactOff = true
  await start()
  let ui = await mount($)
  expect(await bar(ui)).not.toContain('┃')
  await ui.unmount()

  state.autoCompactOff = false
  await measure(4)
  ui = await mount($)
  const drawn = await bar(ui)
  await ui.unmount()
  expect(drawn.indexOf('┃')).toBe(26)
  expect(env[VENTANA]).toBe('683000')
})

test('si el motor no da el desglose del contexto, el umbral se cambia igualmente', async ($, on) => {
  const { env, slash, start, state, store } = world($, on)

  state.sinDesglose = true
  await start()
  expect(env[VENTANA]).toBe('683000')
  expect((await slash('700000')).text).toContain('al llegar el contexto a 700.000 tokens')
  expect(store.umbral).toBe(700_000)
  expect(env[VENTANA]).toBe('733000')
})
