import { atom, read, update } from 'claude-code'
import type { AgentSpawnInput, EngineInterface, Register, TurnStepInput } from 'claude-code'

import {
  abrirTarea,
  agenteDe,
  anotarAgente,
  cerrarAgente,
  contarPaso,
  migrarAgentes,
  reiniciarAgentes,
  reponerAgentes,
  retomarAgente,
} from './herramientas/agentes'
import { arrancarBanda, registrarBanda } from './herramientas/banda'
import {
  alCambiarModelo,
  alCompactar,
  armarLatido,
  cargarCache,
  entrarTurno,
  observarCache,
  olvidarPrefijo,
  pararLatido,
  reiniciarCache,
  salirTurno,
  vetaReposo,
} from './herramientas/cache'
import {
  arrancarCompactado,
  cargar,
  conInstrucciones,
  guardarResumen,
  registrarCompactado,
} from './herramientas/compactado'
import {
  fijarContexto,
  reiniciarContador,
  sumarCompactacion,
  sumarPaso,
} from './herramientas/contador'
import { leer } from './herramientas/equipo'
import { arrancarLimites, consultar, limitar, olvidarConsulta } from './herramientas/limites'
import {
  abrirSolo,
  arrancarPanel,
  cargarPanel,
  recordarPestana,
  registrarPanel,
} from './herramientas/panel'
import {
  apuntar,
  cargarRutas,
  conModelo,
  enrutarPaso,
  recordarTipos,
  registrarRutas,
} from './herramientas/rutas'
import {
  anotarCompactacion,
  arrancarSesion,
  historiar,
  pausarHistorico,
  reiniciarHistorico,
  reponerHistorico,
} from './herramientas/sesion'
import {
  arrancarTareas,
  conSeccionPlan,
  FALLO_PLAN,
  registrarTareas,
  reiniciarPasos,
} from './herramientas/tareas'
import { aislar, anotarFallo, fijarInteractiva, quitarFallo } from './util'

// Lo que tarda en poder reponerse lo borrado tras /clear: el motor borra `$.state` al acabar los
// hooks de session.end, que tienen 1,5 s salvo que la configuración les dé más.
const REHIDRATAR_MS = 2_000

// Si `$.state` está al día. Vive en él: el borrado la apaga solo, llegue cuando llegue, y lo que se
// reponga antes de tiempo se vuelve a reponer.
const hidratada = atom({ plugin: 'tokens-sesion', key: 'hidratada' } as const, false)
let hidratando = false

// Tras /clear o /resume el motor borra `$.state` y no vuelve a lanzar session.start: lo que no sea
// de la conversación que acaba se repone desde `$.store` y las variables de módulo.
async function rehidratar($: EngineInterface): Promise<void> {
  if (hidratando || (await read($, hidratada))) {
    return
  }

  hidratando = true

  try {
    const hechos = [
      await aislar('Compactado', cargar($)),
      await aislar('Enrutadores', cargarRutas($)),
      await aislar('Caché', cargarCache($)),
      await aislar('Panel', cargarPanel($)),
      await aislar('Histórico', reponerHistorico($), 'reponer-historico'),
      await aislar('Límites', arrancarLimites($), 'arranque-limites'),
      await aislar('Agentes', reponerAgentes($), 'reponer-agentes'),
    ]

    // Lo que falló se repite con la próxima medida o el próximo turno; la consulta de `/usage`, que
    // lanza un proceso, solo cuando todo salió bien.
    if (hechos.every(Boolean)) {
      await update($, hidratada, () => true)
      olvidarConsulta()
      void aislar('Límites', consultar($), 'consulta')
    }
  } finally {
    hidratando = false
  }
}

// La petición de un agente con el esfuerzo de su tipo; si no se puede saber, tal como venía.
async function pasoEnrutado($: EngineInterface, e: TurnStepInput): Promise<TurnStepInput> {
  if (e.agentId === undefined) {
    return e
  }

  try {
    const enrutado = await enrutarPaso($, e, await agenteDe($, e.agentId))
    quitarFallo('enrutar-paso')

    return enrutado
  } catch (error) {
    anotarFallo('Enrutadores', error, 'enrutar-paso')

    return e
  }
}

// Lo mismo con el modelo de un agente que arranca.
async function arranqueEnrutado($: EngineInterface, e: AgentSpawnInput): Promise<AgentSpawnInput> {
  try {
    const enrutado = await conModelo($, e)
    quitarFallo('con-modelo')

    return enrutado
  } catch (error) {
    anotarFallo('Enrutadores', error, 'con-modelo')

    return e
  }
}

// El cuadro de conexiones: cada herramienta vive en su fichero de `herramientas/`, con sus propios
// hooks en `registrar...`. Aquí solo están los eventos que comparten varias: el motor deja enganchar
// una sola vez un evento sin matcher, así que cada uno llama a lo que toca de cada herramienta.
// Cada llamada va con `aislar`, que apunta el fallo para la pestaña Sesión: una herramienta que
// falla no se lleva a las demás por delante ni le deja al motor un hook sin acabar.
export const register: Register = on => {
  registrarCompactado(on)
  registrarBanda(on)
  registrarRutas(on)
  registrarTareas(on)
  registrarPanel(on)

  on('session.start', async ($, e, next) => {
    // Lo primero: las demás miran si hay alguien delante.
    fijarInteractiva(e.isInteractive)
    await aislar('Agentes', migrarAgentes($), 'migrar-agentes')
    await aislar('Compactado', arrancarCompactado($), 'arranque-compactado')
    await aislar('Panel', arrancarPanel($), 'arranque-panel')
    await aislar('Límites', arrancarLimites($), 'arranque-limites')
    await aislar('Banda', arrancarBanda($))
    await aislar('Enrutadores', cargarRutas($))
    await aislar('Histórico', arrancarSesion($), 'arranque-historico')
    await aislar('Caché', cargarCache($))
    await aislar(FALLO_PLAN, arrancarTareas($, e.isInteractive))
    await update($, hidratada, () => true)
    const started = await next(e)

    void aislar('Caché', armarLatido($), 'latido')
    olvidarConsulta()

    // Solo donde hay alguien mirando la banda.
    if (e.isInteractive) {
      void aislar('Equipo', leer($))
      void aislar('Límites', consultar($), 'consulta')
    }

    return started
  })

  // El motor también avisa al empezar cada subagente (`agentId`): eso no es una tarea.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      entrarTurno()
      await rehidratar($)
      await aislar('Agentes', abrirTarea($, e.text), 'abrir-tarea')
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const inicio = e.agentId === undefined ? await $.clock.now() : 0
    const sent = await pasoEnrutado($, e)
    const response = yield* next(sent)
    const usage = response.usage

    if (e.agentId !== undefined) {
      await aislar('Agentes', contarPaso($, sent, usage), 'contar-paso')
    }

    if (usage) {
      await aislar('Contador', sumarPaso($, e.agentId, usage))

      if (e.agentId === undefined) {
        await aislar('Caché', observarCache($, inicio, usage), 'observar-cache')
      }
    }

    if (e.agentId === undefined) {
      void aislar('Límites', consultar($), 'consulta')
    }

    return response
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      salirTurno()
      // Un latido que saltó durante el turno se perdió: si acabó sin respuesta nadie más lo rearma.
      void aislar('Caché', armarLatido($), 'latido')
    } else {
      await aislar('Agentes', cerrarAgente($, e.agentId, e.reason), 'cerrar-agente')
    }

    const done = await next(e)
    await aislar('Histórico', historiar($))

    return done
  })

  on('agent.spawn', async ($, e, next) => {
    const inicio = await $.clock.now()

    // Un agente retomado (SendMessage) sigue en su línea y en su tarea. El motor no deja cambiarle nada.
    if (e.resume !== undefined) {
      const resumed = await next(e)

      if (resumed.agentId !== undefined) {
        await aislar(
          'Agentes',
          retomarAgente($, e, resumed.agentId, resumed.model, inicio),
          'anotar-agente',
        )
      }

      return resumed
    }

    const started = await next(await arranqueEnrutado($, e))

    if (started.agentId === undefined) {
      return started
    }

    await aislar(
      'Agentes',
      anotarAgente($, e, started.agentId, started.model, inicio),
      'anotar-agente',
    )

    // Un agente de workflow hereda siempre: una fila en la tabla no haría nada.
    if (e.workflow === undefined) {
      await aislar('Enrutadores', apuntar($, e.subagentType), 'apuntar')
    }

    await aislar('Panel', abrirSolo($), 'abrir-solo')

    return started
  })

  on('prompt.compose', async ($, e, next) => conSeccionPlan(e.tools, await next(e)))

  on('session.measure', async ($, e, next) => {
    await rehidratar($)
    const tokens = e.context.tokens

    if (tokens !== undefined) {
      await aislar('Contador', fijarContexto($, tokens))
    }

    await aislar('Límites', limitar($, e.rateLimits))
    // Otra sesión pudo cambiar lo guardado, y esta de modelo.
    await aislar('Compactado', cargar($))
    await aislar('Enrutadores', cargarRutas($))
    await aislar('Caché', cargarCache($))

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const veto = await vetaReposo($, e).catch(() => null)

    if (veto !== null) {
      return { skip: veto }
    }

    const done = await next({ ...e, instructions: conInstrucciones(e.instructions) })

    if (done.skip !== undefined) {
      return done
    }

    if (done.usage) {
      await aislar('Contador', sumarCompactacion($, e.agentId, done.usage))
    }

    if (e.agentId === undefined && e.trigger !== 'precompute') {
      const after = done.tokensAfter
      await aislar('Contador', fijarContexto($, after ?? null))
      await aislar(
        'Histórico',
        anotarCompactacion($, { antes: done.tokensBefore ?? null, despues: after ?? null }),
      )
      await aislar('Caché', alCompactar($), 'al-compactar')
      void aislar('Histórico', historiar($))
    }

    return done
  })

  on('classic.PostCompact', async ($, e, next) => {
    if (e.agent_id === undefined) {
      // Hasta la siguiente respuesta, el contexto es el que diga el motor.
      await aislar('Contador', fijarContexto($, null))
      // La compactación parcial no pasa por session.compact.
      await aislar('Caché', olvidarPrefijo($), 'al-compactar')
      const fichero = await guardarResumen($, e.compact_summary)
      await aislar('Histórico', anotarCompactacion($, { fichero }))
      void aislar('Histórico', historiar($))
    }

    return next(e)
  })

  // El modelo nuevo trae su ventana y deja atrás lo que había en caché.
  on('classic.PostModelSwitch', async ($, e, next) => {
    await aislar('Compactado', cargar($))
    await aislar('Caché', alCambiarModelo($, e.cache_ttl), 'cambio-modelo')

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    pararLatido()

    if (e.reason === 'clear' || e.reason === 'resume') {
      pausarHistorico()
      await update($, hidratada, () => false)
      await aislar('Panel', recordarPestana($), 'recordar-pestana')
      await aislar('Enrutadores', recordarTipos($), 'recordar-tipos')
      await aislar('Contador', reiniciarContador($))
      await aislar('Agentes', reiniciarAgentes($), 'reiniciar-agentes')
      await aislar('Tareas', reiniciarPasos($), 'reiniciar-pasos')
      await aislar('Histórico', reiniciarHistorico($), 'reiniciar-historico')
      await aislar('Caché', reiniciarCache($), 'reiniciar-cache')
      // Lo que corra primero repone: el temporizador, para que la banda y el panel no esperen al
      // primer turno, o ese turno, o una medida, si llegan antes.
      $.clock.after(REHIDRATAR_MS, () => {
        void rehidratar($)
      })
    }

    return next(e)
  })
}
