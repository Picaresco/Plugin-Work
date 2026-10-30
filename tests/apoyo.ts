import { mock } from 'claude-code/testing'
import type { On, TurnUsage } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// Lo que comparten las pruebas de los distintos ficheros. Las de siempre definen su propio `world`,
// a la medida de lo que prueban; para una herramienta nueva, `mundo` da el punto de partida.

// 2026-10-10 10:00:00 UTC
export const NOW = Date.UTC(2026, 9, 10, 10, 0, 0)
export const MIN = 60_000

// Lo que gasta una petición al modelo.
export const usage = (
  input: number,
  output: number,
  cacheWrite: number,
  cacheRead: number,
): TurnUsage => ({
  model: 'test',
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: cacheWrite,
  cache_read_input_tokens: cacheRead,
})

// El texto de un hijo tal como se dibuja: una cadena, o un elemento con los suyos.
export const shown = (child: unknown): string =>
  typeof child === 'string'
    ? child
    : ((child as { children?: unknown[] } | null)?.children ?? []).map(shown).join('')

// Un $.state que se puede borrar, como hace eKr() al final de session.end en 2.1.314
// (`e.values.setState(r => r.size === 0 ? r : new Map)`, conservando el suelo de versiones). El kit
// no lo hace: sin esto, /clear y /resume no se parecen a lo que pasa de verdad.
export const conBorrado = (on: On) => {
  // Un gancho que corre dentro de cada `state.set`, para meter un suceso a mitad de un reinicio.
  const ganchos: { alPoner?: (key: string) => Promise<void> } = {}
  const values = new Map<string, { value: unknown; version: number }>()
  let suelo = 0
  const clave = (e: { plugin: string; key: string; id?: string }) => `${e.plugin}\0${e.key}\0${e.id ?? ''}`

  on('state.get', (_$, e) => {
    const held = values.get(clave(e as never))

    return { value: held === undefined ? { value: undefined, version: 0 } : held } as never
  })
  on('state.set', async (_$, e) => {
    await ganchos.alPoner?.((e as { key: string }).key)
    const k = clave(e as never)
    const held = values.get(k)
    const actual = held?.version ?? 0
    const pedido = (e as { ifVersion?: number }).ifVersion

    if (pedido !== undefined && pedido !== actual) {
      return { value: { isSet: false, version: actual } } as never
    }

    suelo = Math.max(suelo, actual) + 1
    values.set(k, { value: (e as { value: unknown }).value, version: suelo })

    return { value: { isSet: true, version: suelo } } as never
  })

  return {
    ganchos,
    borrar: () => {
      for (const one of values.values()) suelo = Math.max(suelo, one.version)
      values.clear()
    },
    // Lo que dejó en la sesión una versión anterior del mod.
    sembrar: (key: string, value: unknown) => {
      values.set(clave({ plugin: 'tokens-sesion', key }), { value, version: 1 })
    },
  }
}

// Lo que el motor hace en un /clear: session.end y, al acabar, el borrado.
export const limpiar = async (
  $: Engine,
  borrado: { borrar: () => void },
  reason: 'clear' | 'resume' = 'clear',
) => {
  await $.session.end({ reason, sessionId: 's', resume: { id: 's' } })
  borrado.borrar()
}

// Una medida del contexto, como la que lanza el motor tras cada respuesta.
export const medir = ($: Engine, tokens = 1_000) =>
  $.session.measure({
    context: { window: 1_000_000, tokens },
    rateLimits: [],
    changed: ['context'],
  } as never)

// Lo que tarda el mod en reponer lo borrado cuando no llega antes un turno.
export const REPUESTO_MS = 3_000

// El fondo de la cadena, con lo que el mod pide para arrancar y poco más. Lo que falte falla en
// silencio dentro del `aislar` de quien lo pidió: en duda, mira Fallos en la pestaña Sesión.
export const mundo = ($: Engine, on: On, guardado: Record<string, unknown> = {}) => {
  const clock = mock.clock(on, { now: NOW })
  // El almacén del mod, con lo que otra sesión dejó guardado o guarde después.
  const store: Record<string, unknown> = { ...guardado }
  const panes = new Set<string>()
  const toasts: string[] = []
  const comandos: { name: string; immediate?: boolean }[] = []
  // Lo que falla debajo del mod, con `{ deny }`: un hook de prueba que lanza quedaría saltado.
  const roto = { lectura: false, escritura: false, herramienta: false }

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 1_000_000, tokens: 0 }, rateLimits: [] },
  }))
  on('session.turns', () => ({ value: 0 }))
  on('session.root', () => ({ value: '/proyecto' }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('settings.read', () => ({ value: {} }))
  on('env.get', () => ({ value: undefined }))
  on('env.set', () => ({ value: {} }))
  on('fs.write', () => ({ value: undefined }))
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
  on('tool.list', () => ({ value: [] }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__tokens-sesion__${e.name}` } }))
  on('tool.call', () => (roto.herramienta ? ({ deny: 'no' } as never) : ({ result: {} } as never)))
  on('prompt.compose', () => ({ sections: [] }))
  on('command.register', (_$, e) => {
    comandos.push(e)

    return { value: { command: e.name } }
  })
  on('command.run', () => ({ text: '' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('agent.offer', () => ({ isOffered: true }))
  on('agent.list', () => ({ value: [] }))
  on('store.get', (_$, e) =>
    roto.lectura ? ({ deny: 'store.get: lock' } as never) : { value: store[e.key] },
  )
  on('store.set', (_$, e) => {
    if (roto.escritura) {
      return { deny: 'store.set: lock' } as never
    }

    store[e.key] = e.value

    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [...panes].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })),
  }))
  on('ui.open', (_$, e) => {
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
    toasts,
    comandos,
    roto,
    settle: () => clock.settle(),
    start: () => $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true }),
    prompt: (text: string) => $.turn.start({ text, turnId: 't0' }),
    // El modelo llama a una herramienta, desde el hilo principal o desde un subagente.
    llamar: (tool: string, agentId?: string) =>
      $.tool.call({ tool, ...(agentId === undefined ? {} : { agentId }) } as never),
    // Un comando tal como lo escribe la persona.
    slash: (command: string, args = '') =>
      $.command.run({
        command,
        args,
        origin: { kind: 'composer' },
        presentation: { isFullscreen: true, columns: 160 },
      }) as Promise<{ text?: string }>,
  }
}

// El panel tal como se dibuja, en la pestaña elegida. `ui.unmount()` antes de volver a montarlo.
export const panel = ($: Engine) =>
  $.ui.mount({
    plugin: 'tokens-sesion',
    component: 'Pane',
    requestId: 'agentes',
    surface: 'terminal',
    props: {
      title: 'Agentes',
      isFocused: false,
      bodyColumns: 48,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  })
