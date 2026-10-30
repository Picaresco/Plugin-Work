import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderElement, RenderInput } from 'claude-code'

import { aislar, anotarFallo, esInteractiva, motivo, quitarFallo, resumir } from '../util'
import { dibujarAgentes, leerAgentes, limpiarAgentes } from './agentes'
import { enPantallaPrincipal } from './banda'
import { fijarCache } from './cache'
import { dibujarRutas } from './rutas'
import { dibujarSesion } from './sesion'
import { dibujarTareas, limpiarPasos } from './tareas'

// Un solo panel con pestañas: arriba, un botón por cada una; debajo, la elegida. `nombres` es lo que
// se escribe tras /agentes para ir a ella, y el primero es el que se enseña. Una pestaña nueva es
// una fila aquí, su `case` en `dibujarPestana` y su id en el contrato (`pestana`).
const PANEL = 'agentes'
const TITULO = 'Agentes'
const PESTANAS = [
  { id: 'agentes', titulo: 'Agentes', tecla: '1', nombres: ['agentes'] },
  { id: 'tareas', titulo: 'Tareas', tecla: '2', nombres: ['tareas'] },
  { id: 'enrutadores', titulo: 'Enrutadores', tecla: '3', nombres: ['rutas', 'enrutadores'] },
  { id: 'sesion', titulo: 'Sesión', tecla: '4', nombres: ['sesion'] },
] as const
type Pestana = (typeof PESTANAS)[number]['id']
const COMANDO_AGENTES = 'agentes'
// La primera pestaña es la que abre /agentes a secas.
const DESTINOS = PESTANAS.slice(1).map(({ nombres }) => nombres[0])
const PISTA = `[${[...DESTINOS, 'cache si|no', 'cerrar', 'limpiar'].join(' | ')}]`
const USO = `Uso: /agentes (abre el panel), ${DESTINOS.map(destino => `/agentes ${destino}`).join(', ')} (lo abren en esa pestaña), /agentes cache si|no, /agentes cerrar, /agentes limpiar.`
// Lo que el panel pide de ancho al acoplarse.
const COLUMNAS = 48
// Se guarda: un panel cerrado a mano sigue cerrado en las sesiones siguientes.
const CLAVE_OCULTO = 'panelOculto'

// La persona cerró el panel: no vuelve a abrirse solo hasta que lo pida con el comando.
const oculto = atom({ plugin: 'tokens-sesion', key: 'oculto' } as const, false)
const pestana = atom({ plugin: 'tokens-sesion', key: 'pestana' } as const, 'agentes')

// La pestaña elegida, en el módulo: `$.state` no sobrevive a /clear.
let ultimaPestana: Pestana | null = null

// Lo que escribe la persona, sin mayúsculas ni tildes: «Sesión» vale por «sesion», «caché sí» por «cache si».
const normalizado = (text: string): string =>
  text.trim().toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')

async function abrir($: EngineInterface) {
  return $.ui.open({ id: PANEL, title: TITULO, columns: COLUMNAS })
}

async function elegir($: EngineInterface, id: Pestana): Promise<void> {
  ultimaPestana = id
  await update($, pestana, () => id)
}

async function ocultar($: EngineInterface, valor: boolean): Promise<void> {
  await update($, oculto, () => valor)
  await aislar('Panel', $.store.set(CLAVE_OCULTO, valor), 'ocultar')
}

// El motor solo deja llegar `$` a una función importada llamada por su nombre, no por una tabla: por
// eso un `switch` y no un campo de PESTANAS. Sin su `case`, `tsc` da error y la pestaña lo dice.
async function dibujarPestana(
  $: EngineInterface,
  e: RenderInput<'Pane'>,
  id: Pestana,
): Promise<RenderElement> {
  switch (id) {
    case 'agentes':
      return dibujarAgentes($, e)
    case 'tareas':
      return dibujarTareas($, e)
    case 'enrutadores':
      return dibujarRutas($, e, await leerAgentes($))
    case 'sesion':
      return dibujarSesion($, e)
  }

  const falta: never = id
  throw new Error(`no tiene dibujo: ${String(falta)}`)
}

// Antes del borrado: tras una recarga la variable está vacía y el estado no.
export async function recordarPestana($: EngineInterface): Promise<void> {
  ultimaPestana = await read($, pestana)
}

// Lo guardado manda sobre lo de la sesión: `$.state` no sobrevive a /clear.
export async function cargarPanel($: EngineInterface): Promise<void> {
  const cerrado = (await $.store.get(CLAVE_OCULTO)) === true
  await update($, oculto, () => cerrado)

  if (ultimaPestana !== null) {
    await elegir($, ultimaPestana)
  }
}

export async function arrancarPanel($: EngineInterface): Promise<void> {
  await $.command.register({
    name: COMANDO_AGENTES,
    description: 'Panel con los agentes de cada tarea: inicio, fin, duración y tokens',
    argumentHint: PISTA,
    immediate: true,
  })
  await cargarPanel($)
}

// Con el primer agente el panel se abre solo, si hay quien lo vea y va a quedar al lado de la
// conversación: en la pantalla principal se llevaría un tercio de la altura. Si ya está abierto no
// se toca: la persona puede estar en otra pestaña.
export async function abrirSolo($: EngineInterface): Promise<void> {
  if (!esInteractiva() || enPantallaPrincipal() || (await read($, oculto))) {
    return
  }

  if (!(await $.ui.panes()).some(pane => pane.id === PANEL)) {
    void aislar('Panel', abrir($), 'abrir-solo')
  }
}

// Lo que hace /agentes con lo escrito tras él; lo que devuelve es la respuesta.
async function responder($: EngineInterface, typed: string): Promise<string> {
  if (typed === 'cerrar') {
    await ocultar($, true)
    await $.ui.close({ id: PANEL })

    return 'Panel de agentes cerrado. El registro sigue: /agentes lo vuelve a abrir.'
  }

  if (typed === 'cache si' || typed === 'cache no') {
    const viva = typed === 'cache si'

    if (viva && !esInteractiva()) {
      return 'La caché viva solo funciona en la terminal: necesita un temporizador que siga vivo durante la pausa.'
    }

    await fijarCache($, viva)

    return viva
      ? 'Caché viva activada: en las pausas se mantiene mientras sea lo más barato, y después se compacta o se deja caducar.'
      : 'Caché viva desactivada: en las pausas no se hace nada.'
  }

  if (typed === 'limpiar') {
    await limpiarPasos($)
    await limpiarAgentes($)

    return 'Registro de agentes y plan de tareas vaciados. El histórico los conserva.'
  }

  const destino = PESTANAS.find(one => (one.nombres as readonly string[]).includes(typed))

  if (typed !== '' && destino === undefined) {
    return USO
  }

  await ocultar($, false)

  if (destino !== undefined) {
    await elegir($, destino.id)
  }

  const opened = await abrir($)

  return opened.isPlaced
    ? 'Panel de agentes abierto.'
    : `El panel de agentes no se ha colocado: ${opened.reason}`
}

export function registrarPanel(on: On): void {
  on('command.run', { command: COMANDO_AGENTES }, async ($, e) => {
    const typed = normalizado(e.args)
    // Por argumento: /agentes sesion no dice nada de si /agentes cache si funciona.
    const clave = `comando ${typed}`

    try {
      const text = await responder($, typed)
      quitarFallo(clave)

      return { text }
    } catch (error) {
      anotarFallo('Panel', error, clave)

      return { text: `No se pudo: ${motivo(error)}` }
    }
  })

  on('ui.close', { id: PANEL }, async ($, e, next) => {
    if (e.origin.kind === 'person') {
      await ocultar($, true)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANEL }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const actual = await read($, pestana)
    let cuerpo: RenderElement

    // El motor cierra el panel cuyo dibujo falla: que caiga la pestaña y no todo el panel.
    try {
      cuerpo = await dibujarPestana($, e, actual)
    } catch (error) {
      cuerpo = (
        <Box key="cuerpo" flexDirection="column">
          <Text color="error" wrap="wrap">
            {resumir(`No se pudo dibujar esta pestaña: ${motivo(error)}`)}
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {PESTANAS.map(({ id, titulo, tecla }) => (
            <Button
              key={`pestana:${id}`}
              label={titulo}
              hotkey={tecla}
              variant={id === actual ? 'primary' : 'secondary'}
              dimColor={id !== actual}
              onPress={() => {
                void aislar('Panel', elegir($, id), 'elegir')
              }}
            />
          ))}
        </Box>
        <Text dimColor>{'─'.repeat(Math.max(1, e.props.bodyColumns))}</Text>
        {cuerpo}
      </Box>
    )
  })
}
