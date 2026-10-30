import { atom, read, update } from 'claude-code'
import type {
  AgentSpawnInput,
  EngineInterface,
  On,
  RenderElement,
  RenderInput,
  TurnStepInput,
} from 'claude-code'

import type { Agente, Ruta } from '../../types'
import { aislarAhora, conPuntos } from '../util'

// Lo que se puede elegir para cada tipo de agente. El modelo es un alias: el motor lo resuelve a
// su versión actual al arrancar el agente. HEREDAR deja lo que el motor decida.
const HEREDAR = 'heredar'
const MODELOS = [HEREDAR, 'haiku', 'sonnet', 'opus', 'fable'] as const
const ESFUERZOS = [HEREDAR, 'low', 'medium', 'high', 'xhigh', 'max'] as const
type Esfuerzo = Exclude<(typeof ESFUERZOS)[number], typeof HEREDAR>
const SIN_RUTA: Ruta = { modelo: HEREDAR, esfuerzo: HEREDAR }
// La fila de los tipos que no tienen la suya.
const RESTO = '*'
// Los tipos del motor, que tienen fila aunque aún no se hayan ofrecido al modelo.
const TIPOS = ['Explore', 'Plan', 'general-purpose', 'claude', 'claude-code-guide'] as const
// Un fork hereda siempre el modelo y el esfuerzo de quien lo lanza.
const FORK = 'fork'
const RECOMENDADAS: Record<string, Ruta> = {
  Explore: { modelo: 'haiku', esfuerzo: 'low' },
  Plan: { modelo: 'opus', esfuerzo: 'high' },
  'general-purpose': { modelo: 'sonnet', esfuerzo: 'medium' },
  'claude-code-guide': { modelo: 'haiku', esfuerzo: 'low' },
}
// La tabla se guarda en el almacén del mod, común a todas las sesiones y proyectos del usuario.
const CLAVE = 'rutas'
// Columnas del nombre del tipo, y desde cuántas el nombre y sus selectores van en una fila.
const ANCHO_TIPO = 18
const ANCHO_RUTA = 44
// Cómo se llama esta herramienta en la lista de fallos de la pestaña Sesión.
const FALLO = 'Enrutadores'

const rutas = atom({ plugin: 'tokens-sesion', key: 'rutas' } as const, {})
// Los tipos de agente que el motor ha ofrecido al modelo o ha arrancado en la sesión.
const tipos = atom({ plugin: 'tokens-sesion', key: 'tipos' } as const, [])
// Los mismos, en el módulo: `$.state` no sobrevive a /clear.
let vistos: string[] = []

const esModelo = (value: unknown): value is string =>
  typeof value === 'string' && (MODELOS as readonly string[]).includes(value)

const esEsfuerzo = (value: unknown): value is string =>
  typeof value === 'string' && (ESFUERZOS as readonly string[]).includes(value)

const enHeredar = (ruta: Ruta): boolean => ruta.modelo === HEREDAR && ruta.esfuerzo === HEREDAR

// Lo guardado puede venir de otra versión del mod: solo vale lo que se puede elegir hoy. Una fila
// entera en heredar sobra, salvo que exista la de los demás: entonces es una excepción a ella.
const validas = (stored: unknown): Record<string, Ruta> => {
  if (typeof stored !== 'object' || stored === null) {
    return {}
  }

  const filas: [string, Ruta][] = []

  for (const [tipo, ruta] of Object.entries(stored)) {
    const { modelo, esfuerzo } = (ruta ?? {}) as Partial<Ruta>

    if (esModelo(modelo) && esEsfuerzo(esfuerzo)) {
      filas.push([tipo, { modelo, esfuerzo }])
    }
  }

  const hayResto = filas.some(([tipo]) => tipo === RESTO)
  const excepciones = filas.some(([tipo, ruta]) => tipo !== RESTO && enHeredar(ruta))

  return Object.fromEntries(
    filas.filter(
      ([tipo, ruta]) => !enHeredar(ruta) || (hayResto && (tipo !== RESTO || excepciones)),
    ),
  )
}

// La fila de un tipo. Se mira que sea propia: un tipo puede llamarse como algo de Object.prototype.
const filaDe = (table: Record<string, Ruta>, tipo: string): Ruta | undefined =>
  Object.hasOwn(table, tipo) ? table[tipo] : undefined

const rutaDe = (table: Record<string, Ruta>, tipo: string): Ruta =>
  filaDe(table, tipo) ?? filaDe(table, RESTO) ?? SIN_RUTA

// Dos cambios seguidos se hacen uno detrás de otro: cada uno lee lo que dejó el anterior.
let colaRutas: Promise<unknown> = Promise.resolve()

async function escribirRutas(
  $: EngineInterface,
  change: (table: Record<string, Ruta>) => Record<string, Ruta>,
): Promise<void> {
  const table = validas(change(validas(await $.store.get(CLAVE))))
  await $.store.set(CLAVE, table)
  await update($, rutas, () => table)
}

// La tabla es común a todas las sesiones: el cambio se hace sobre lo guardado, no sobre la copia de
// esta sesión, que otra pudo dejar atrás.
async function guardarRutas(
  $: EngineInterface,
  change: (table: Record<string, Ruta>) => Record<string, Ruta>,
): Promise<void> {
  const turno = colaRutas.then(() => escribirRutas($, change))
  colaRutas = turno.catch(() => undefined)
  await turno
}

// El esfuerzo que la tabla da al agente `id`. Su primera petición puede salir antes de que su
// arranque quede anotado: entonces el tipo se le pregunta al motor, que no lista los de un workflow.
async function esfuerzoDe(
  $: EngineInterface,
  id: string,
  agente: Agente | undefined,
): Promise<string> {
  if (agente?.hereda) {
    return HEREDAR
  }

  const tipo = agente?.tipo ?? (await $.agent.list()).find(one => one.id === id)?.type

  return tipo === undefined || tipo === FORK ? HEREDAR : rutaDe(await read($, rutas), tipo).esfuerzo
}

// Antes del borrado: tras una recarga la variable está vacía y el estado no.
export async function recordarTipos($: EngineInterface): Promise<void> {
  vistos = [...new Set([...vistos, ...(await read($, tipos))])]
}

// Apunta un tipo de agente para que tenga fila en la tabla.
export async function apuntar($: EngineInterface, tipo: string): Promise<void> {
  if (tipo === FORK || vistos.includes(tipo)) {
    return
  }

  vistos = [...vistos, tipo]
  await update($, tipos, list => (list.includes(tipo) ? list : [...list, tipo]))
}

// La tabla guardada manda sobre la de la sesión: otra sesión pudo cambiarla, y `$.state` no
// sobrevive a /clear, que también se lleva las filas de los tipos ya vistos.
export async function cargarRutas($: EngineInterface): Promise<void> {
  const stored = validas(await $.store.get(CLAVE))
  await update($, rutas, () => stored)
  await update($, tipos, list => [...new Set([...list, ...vistos])])
}

// El arranque de un agente con el modelo de la tabla, que manda sobre el que pida la llamada; un
// fork y los agentes de un workflow heredan.
export async function conModelo($: EngineInterface, e: AgentSpawnInput): Promise<AgentSpawnInput> {
  const modelo = rutaDe(await read($, rutas), e.subagentType).modelo

  return modelo === HEREDAR || e.fork || e.workflow !== undefined ? e : { ...e, model: modelo }
}

// La petición tal como debe salir: con el esfuerzo de la tabla si es de un agente y el modelo lo admite.
export async function enrutarPaso(
  $: EngineInterface,
  e: TurnStepInput,
  agente: Agente | undefined,
): Promise<TurnStepInput> {
  const id = e.agentId

  if (id === undefined || e.effort === undefined) {
    return e
  }

  const esfuerzo = await esfuerzoDe($, id, agente)

  return esfuerzo === HEREDAR ? e : { ...e, effort: esfuerzo as Esfuerzo }
}

export async function dibujarRutas(
  $: EngineInterface,
  e: RenderInput<'Pane'>,
  list: readonly Agente[],
): Promise<RenderElement> {
  const table = await read($, rutas)
  const vistos = await read($, tipos)
  const ancho = e.props.bodyColumns
  const nombres = [
    ...new Set([...TIPOS, ...vistos, ...Object.keys(table).filter(tipo => tipo !== RESTO)]),
    RESTO,
  ]
  // Lo gastado por los agentes de la sesión, por el modelo con el que corrieron.
  const gastos = new Map<string, number>()

  for (const agente of list) {
    const modelo = agente.modelo.replace(/^claude-/, '')
    gastos.set(modelo, (gastos.get(modelo) ?? 0) + agente.tokens)
  }

  const pie =
    gastos.size === 0
      ? 'Sin agentes todavía.'
      : [...gastos].map(([modelo, tokens]) => `${modelo} ${conPuntos(tokens)}`).join(' · ')

  // Donde no hay selectores la tabla se lee, y se cambia desde un terminal o el escritorio.
  if (e.surface === 'mobile') {
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box key="cuerpo" flexDirection="column">
        <Text bold>Modelo y esfuerzo por tipo de agente</Text>
        {nombres.map(tipo => (
          <Text>
            {`${tipo === RESTO ? 'Los demás' : tipo}: ${rutaDe(table, tipo).modelo} · ${rutaDe(table, tipo).esfuerzo}`}
          </Text>
        ))}
        <Text dimColor>{`Tokens por modelo: ${pie}`}</Text>
      </Box>
    )
  }

  const { Box, Text, Select, Button } = $.ui.resolve(e)
  const enFila = ancho >= ANCHO_RUTA
  const filas: RenderElement[] = []

  for (const tipo of nombres) {
    // Cada fila enseña lo que tiene puesto, no lo que le llega de la de los demás.
    const ruta = filaDe(table, tipo) ?? SIN_RUTA
    const nombre = tipo === RESTO ? 'Los demás' : tipo
    const corto =
      nombre.length > ANCHO_TIPO ? `${nombre.slice(0, ANCHO_TIPO - 1)}…` : nombre.padEnd(ANCHO_TIPO)
    const elegir = (campo: keyof Ruta) => (value: string) => {
      void aislarAhora(
        $,
        FALLO,
        guardarRutas($, now => ({
          ...now,
          [tipo]: { ...(filaDe(now, tipo) ?? SIN_RUTA), [campo]: value },
        })),
        'guardar-rutas',
      )
    }

    filas.push(
      <Box flexDirection={enFila ? 'row' : 'column'}>
        <Text bold={tipo === RESTO} wrap="truncate-end">
          {enFila ? `${corto} ` : nombre}
        </Text>
        <Box flexDirection="row" marginLeft={enFila ? 0 : 2}>
          <Select
            key={`modelo:${tipo}`}
            options={MODELOS.map(value => ({ value }))}
            value={ruta.modelo}
            onSelect={elegir('modelo')}
          />
          <Text> </Text>
          <Select
            key={`esfuerzo:${tipo}`}
            options={ESFUERZOS.map(value => ({ value }))}
            value={ruta.esfuerzo}
            onSelect={elegir('esfuerzo')}
          />
        </Box>
      </Box>,
    )
  }

  return (
    <Box key="cuerpo" flexDirection="column">
      <Text bold>Modelo y esfuerzo por tipo de agente</Text>
      {enFila && <Text dimColor>{`${'Tipo'.padEnd(ANCHO_TIPO)} Modelo y esfuerzo`}</Text>}
      {filas}
      <Text> </Text>
      <Text dimColor wrap="wrap">
        Un fork y los agentes de un workflow heredan siempre.
      </Text>
      <Box flexDirection="row" marginTop={1}>
        <Button
          key="recomendadas"
          label="Recomendados"
          onPress={() => {
            void aislarAhora($, FALLO, guardarRutas($, () => RECOMENDADAS), 'guardar-rutas')
          }}
        />
        <Text> </Text>
        <Button
          key="heredar"
          label="Todo heredar"
          onPress={() => {
            void aislarAhora($, FALLO, guardarRutas($, () => ({})), 'guardar-rutas')
          }}
        />
      </Box>
      <Text> </Text>
      <Text dimColor>Tokens por modelo en la sesión</Text>
      <Text wrap="wrap">{pie}</Text>
    </Box>
  )
}

export function registrarRutas(on: On): void {
  // Cada tipo que el motor ofrece al modelo tiene su fila en la tabla.
  on('agent.offer', async ($, e, next) => {
    await apuntar($, e.agent)

    return next(e)
  })
}
