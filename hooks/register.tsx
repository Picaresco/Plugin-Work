import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  ModelUsage,
  On,
  Register,
  RenderElement,
  RenderInput,
  SessionRateLimit,
  TurnStepInput,
} from 'claude-code'

import type { Agente, Compactacion, Paso, Ruta } from '../types'

// Cada tramo se pinta con su color hasta `hasta` tokens de contexto, incluido; por encima del último, ROJO.
const TRAMOS = [
  { hasta: 500_000, color: '#22c55e' },
  { hasta: 650_000, color: '#a3e635' },
  { hasta: 800_000, color: '#facc15' },
  { hasta: 950_000, color: '#fb923c' },
] as const
const ROJO = '#ef4444'

// La barra va de 0 a ESCALA tokens de contexto, con una marca donde se compacta.
const ESCALA = 1_000_000
const BARRA_MAX = 40
const BARRA_MIN = 10
// Columnas que ocupan los dos textos que acompañan a la barra.
const RESERVA = 44
const MARCA = '#38bdf8'

// El umbral se cambia arrastrando la marca de la barra (o con el comando) y se guarda en el
// almacén del mod, el mismo para todas las sesiones y proyectos del usuario; 0 lo desactiva.
// Por debajo de UMBRAL_MIN el contexto vuelve a llenarse nada más compactar y el motor aborta el turno.
const COMANDO = 'tokens-compact'
const UMBRAL = 650_000
const UMBRAL_MIN = 200_000
const UMBRAL_MAX = 950_000

// Quien compacta es el motor: lo hace solo, también a mitad de un turno, cuando el contexto llega
// a su ventana de compactado menos lo que reserva, o al porcentaje de CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
// si queda por debajo. El mod pone la ventana que deja ese punto en el umbral del usuario.
const VENTANA_MIN = 100_000
const VENTANA_MAX = 1_000_000
const RESERVA_SALIDA = 20_000
const RESERVA_RESUMEN = 13_000

// Uso de CPU y RAM del equipo: una lectura cada LECTURA_S segundos, y en la banda la media de las
// MEDIA últimas, cada cifra con su color hasta `hasta` por ciento, incluido; por encima, ROJO.
const LECTURA_S = 12
const MEDIA = 5
const USOS = [
  { hasta: 60, color: '#22c55e' },
  { hasta: 85, color: '#facc15' },
] as const
// Columnas que ocupan las dos cifras cuando se muestran.
const RESERVA_USO = 22
// Un solo proceso para toda la sesión, sin comillas dobles para que cruce entero como argumento.
// Cada lectura es una línea con las décimas de % de CPU del intervalo (la «utilidad» del
// Administrador de tareas; donde no existe, el tiempo de procesador) y de memoria física en uso.
// Vigila a quien lo lanzó para no quedarse huérfano, y lo deja tras FALLOS lecturas fallidas seguidas.
const FALLOS = 5
const LECTOR = [
  "$ErrorActionPreference = 'Stop';",
  "$padre = [System.Diagnostics.Process]::GetProcessById((Get-CimInstance Win32_Process -Filter ('ProcessId=' + $PID)).ParentProcessId);",
  '$a = $null;',
  '$f = 0;',
  `while (-not $padre.HasExited -and $f -lt ${FALLOS}) {`,
  // La primera lectura llega enseguida; las demás, a su ritmo.
  '$s = 1;',
  'try {',
  "$b = Get-CimInstance Win32_PerfRawData_Counters_ProcessorInformation -Filter 'Name=''_Total''';",
  'if ($a) {',
  '$o = Get-CimInstance Win32_OperatingSystem;',
  '$base = $b.PercentProcessorUtility_Base - $a.PercentProcessorUtility_Base;',
  '$dt = $b.Timestamp_Sys100NS - $a.Timestamp_Sys100NS;',
  '$cpu = if ($base -gt 0) { ($b.PercentProcessorUtility - $a.PercentProcessorUtility) / $base }',
  'elseif ($dt -gt 0) { (1 - ($b.PercentProcessorTime - $a.PercentProcessorTime) / $dt) * 100 } else { 0 };',
  '$c = [int][math]::Round([math]::Max(0, [math]::Min(100, $cpu)) * 10);',
  '$r = [int][math]::Round((1 - $o.FreePhysicalMemory / $o.TotalVisibleMemorySize) * 1000);',
  "[Console]::Out.WriteLine([string]$c + ' ' + [string]$r);",
  `$s = ${LECTURA_S}`,
  '};',
  '$a = $b;',
  '$f = 0',
  `} catch { $f++; $s = ${LECTURA_S} };`,
  'Start-Sleep -Seconds $s',
  '}',
].join(' ')

// El límite semanal del plan (todos los modelos) va en una segunda línea, con su barra bajo la de
// contexto. RESERVA_SEMANA: las columnas de su etiqueta y de cuándo se renueva.
const LIMITE_SEMANAL = 'seven_day'
const RESERVA_SEMANA = 54
const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'] as const
// El límite semanal propio de un modelo (el de Fable, donde el plan lo tiene) no llega a los mods:
// se le pregunta a Claude Code con su `/usage`, en un proceso aparte que no carga nada del usuario
// ni guarda la sesión, y que no llama al modelo. Si algún día lo hiciera, que sea al más barato.
const CONSULTA = [
  'claude',
  '-p',
  '/usage',
  '--safe-mode',
  '--no-session-persistence',
  '--model',
  'haiku',
] as const
const CONSULTA_MS = 30_000
// Con cada respuesta del hilo principal, si la última consulta tiene ya este tiempo, se repite.
const REFRESCO_MS = 5 * 60_000
const DIA_MS = 24 * 60 * 60_000
// Las renovaciones de `/usage` se llevan al múltiplo de 5 minutos más cercano.
const REDONDEO_MS = 5 * 60_000
// «Current week (Fable): 12% used · resets Oct 9, 10pm (Europe/Madrid)»
const LINEA_USO = /^Current week \((.+?)\): (\d+(?:\.\d+)?)% used(?: · resets ([^(\n]+?))?(?: \(.*\))?\s*$/gm
const TODOS = 'all models'
const MESES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

const CARPETA = '.claude/resumenes'
const INSTRUCCIONES =
  'Resumen exhaustivo para continuar la sesión sin perder nada. Conserva todos los puntos: ' +
  'el objetivo y cada petición del usuario, las decisiones tomadas y su porqué, los ficheros ' +
  'creados o modificados con sus rutas, los comandos y resultados relevantes, los errores y ' +
  'cómo se resolvieron, las tareas pendientes y el paso exacto por el que se iba.'

const gastados = atom({ plugin: 'tokens-sesion', key: 'gastados' } as const, 0)
const contexto = atom({ plugin: 'tokens-sesion', key: 'contexto' } as const, null)
const resumen = atom({ plugin: 'tokens-sesion', key: 'resumen' } as const, null)
// El umbral que quiere el usuario, y el que rige en esta sesión con su modelo y su entorno.
const umbral = atom({ plugin: 'tokens-sesion', key: 'umbral' } as const, UMBRAL)
const efectivo = atom({ plugin: 'tokens-sesion', key: 'efectivo' } as const, UMBRAL)
const maximo = atom({ plugin: 'tokens-sesion', key: 'maximo' } as const, UMBRAL_MAX)
// La superficie no pudo con la barra que recibe el ratón: se dibuja la fija.
const sinRaton = atom({ plugin: 'tokens-sesion', key: 'sinRaton' } as const, false)
// La media de CPU y RAM en %, o null mientras no hay lecturas (otro sistema, sin lector).
const uso = atom({ plugin: 'tokens-sesion', key: 'uso' } as const, null)

// El límite semanal: % usado y cuándo se renueva; null hasta que el motor lo da con una respuesta.
const semana = atom({ plugin: 'tokens-sesion', key: 'semana' } as const, null)

// Los límites semanales propios de un modelo, por el nombre que les da `/usage` («Fable»).
const porModelo = atom({ plugin: 'tokens-sesion', key: 'porModelo' } as const, [])

// Las últimas lecturas del lector, en décimas de %, y si hay uno en marcha.
let lecturas: { cpu: number; ram: number }[] = []
let leyendo = false
// La consulta de los límites por modelo: si hay quien mire la banda, cuándo fue la última, si hay
// una en marcha y si ya no merece repetirla en esta sesión (falló, o el plan no tiene ninguno).
let interactiva = false
let consultado = 0
let consultando = false
let sinConsulta = false

// La caché leída no cuenta: es el mismo contexto releído en cada petición.
const gasto = (usage: ModelUsage): number =>
  usage.input_tokens + usage.output_tokens + usage.cache_creation_input_tokens

// Lo que la petición envió al modelo: la misma medida que da `$.session.usage()`.
const enviado = (usage: ModelUsage): number =>
  usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens

const colorDe = (tokens: number): string =>
  TRAMOS.find(tramo => tokens <= tramo.hasta)?.color ?? ROJO

const conPuntos = (tokens: number): string =>
  String(tokens).replace(/\B(?=(\d{3})+(?!\d))/g, '.')

const colorUso = (pct: number): string => USOS.find(tramo => pct <= tramo.hasta)?.color ?? ROJO

// La media, en % entero, de unas lecturas en décimas.
const media = (decimas: number[]): number =>
  Math.round(decimas.reduce((sum, value) => sum + value, 0) / decimas.length / 10)

// «vie 9, 22:00», en la hora del equipo.
const cuando = (iso: string): string | null => {
  const date = new Date(iso)

  if (Number.isNaN(date.getTime())) {
    return null
  }

  const hora = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`

  return `${DIAS[date.getDay()] ?? ''} ${date.getDate()}, ${hora}`
}

const vale = (value: unknown): value is number =>
  value === 0 ||
  (typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= UMBRAL_MIN &&
    value <= UMBRAL_MAX)

// `rige` es el umbral de esta sesión; queda por debajo del pedido cuando el modelo o el entorno no dan más.
const estado = (limite: number, rige: number): string =>
  limite === 0
    ? `Compactado automático desactivado. Actívalo con /${COMANDO} ${UMBRAL}.`
    : `Compactado automático al llegar el contexto a ${conPuntos(rige)} tokens` +
      (rige < limite ? ` (el tope de esta sesión; pedidos ${conPuntos(limite)})` : '') +
      ', también a mitad de una tarea. Cámbialo arrastrando la marca ┃ de la barra.'

// El porcentaje de CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, si el motor lo va a tener en cuenta.
const porcentaje = (text: string | undefined): number | null => {
  const value = text === undefined ? NaN : parseFloat(text)

  return value > 0 && value <= 100 ? value : null
}

// Los tokens de contexto con los que el motor compacta para una ventana: su misma cuenta.
const umbralDe = (ventana: number, pct: number | null): number => {
  const util = ventana - RESERVA_SALIDA
  const base = util - RESERVA_RESUMEN

  return pct === null ? base : Math.min(Math.floor((util * pct) / 100), base)
}

// La ventana más pequeña con la que el motor compacta en `limite` o más.
const ventanaDe = (limite: number, pct: number | null): number => {
  const base = limite + RESERVA_SALIDA + RESERVA_RESUMEN
  const porPct = pct === null ? 0 : Math.ceil((limite * 100) / pct) + RESERVA_SALIDA

  return Math.min(VENTANA_MAX, Math.max(VENTANA_MIN, base, porPct))
}

// La celda de la barra en la que cae una cantidad de tokens.
const celdaDe = (tokens: number, ancho: number): number =>
  Math.min(ancho - 1, Math.floor((tokens * ancho) / ESCALA))

// El umbral que deja la marca en una celda: su borde izquierdo, redondeado al millar de arriba.
const valorDe = (celda: number, ancho: number): number =>
  Math.ceil((celda * ESCALA) / ancho / 1_000) * 1_000

// La barra celda a celda, sin la marca: lo recorrido lleno, el resto tenue y el punto actual.
const celdas = (tokens: number, ancho: number): { text: string; color: string }[] => {
  const actual = celdaDe(tokens, ancho)

  return Array.from({ length: ancho }, (_, i) => ({
    text: i === actual ? '●' : i < actual ? '█' : '░',
    color: i === actual ? 'text' : colorDe(((i + 1) * ESCALA) / ancho),
  }))
}

const guardar = async ($: EngineInterface, text: string): Promise<string> => {
  const stamp = new Date(await $.clock.now())
    .toISOString()
    .slice(0, 19)
    .replace(/[T:]/g, '-')
  const file = `${CARPETA}/resumen-${stamp}.md`
  await $.fs.write(file, text)
  await update($, resumen, () => file)

  return file
}

// Lleva el umbral al motor: la ventana de compactado de este proceso, sin tocar los ajustes del usuario.
const aplicar = async ($: EngineInterface): Promise<void> => {
  const limite = await read($, umbral)
  const pct = porcentaje(await $.env.get('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'))
  // El motor nunca compacta más tarde de lo que da la ventana del modelo.
  const modelo = Math.min(VENTANA_MAX, (await $.session.usage()).context.window)
  const tope = Math.max(UMBRAL_MIN, Math.min(UMBRAL_MAX, umbralDe(modelo, pct)))
  await update($, maximo, () => tope)

  if (limite === 0) {
    await $.env.set('CLAUDE_CODE_AUTO_COMPACT_WINDOW', undefined)
    await update($, efectivo, () => 0)

    return
  }

  const ventana = ventanaDe(limite, pct)
  await $.env.set('CLAUDE_CODE_AUTO_COMPACT_WINDOW', String(ventana))
  await update($, efectivo, () => Math.min(limite, umbralDe(Math.min(ventana, modelo), pct)))
}

// El umbral guardado manda sobre el de la sesión: otra sesión pudo cambiarlo.
const cargar = async ($: EngineInterface): Promise<void> => {
  const saved = await $.store.get('umbral')
  const limite = vale(saved) ? saved : UMBRAL
  await update($, umbral, () => limite)
  await aplicar($)
}

const fijar = async ($: EngineInterface, limite: number): Promise<void> => {
  await $.store.set('umbral', limite)
  await update($, umbral, () => limite)
  await aplicar($)
}

// De los límites que da el motor, el semanal; sin él (otro plan, o aún sin respuestas), nada.
const limitar = async ($: EngineInterface, limits: readonly SessionRateLimit[]): Promise<void> => {
  const found = limits.find(limit => limit.kind === LIMITE_SEMANAL)
  const value = found ? { pct: found.percentUsed, renueva: found.resetsAt ?? null } : null
  await update($, semana, () => value)
  const corto = limits.find(limit => limit.kind === 'five_hour')
  const cinco = corto ? { pct: corto.percentUsed, renueva: corto.resetsAt ?? null } : null
  await update($, cincoHoras, () => cinco)
}

// El instante de un «Oct 9, 10pm» o un «4:59am» de `/usage`, que vienen en la hora del equipo.
const instante = (text: string, now: number): string | null => {
  const found = /^(?:([A-Za-z]{3})[a-z]* (\d{1,2}), )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(text.trim())

  if (!found) {
    return null
  }

  const hoy = new Date(now)
  const mes = found[1] === undefined ? hoy.getMonth() : MESES.indexOf(found[1].toLowerCase())

  if (mes < 0) {
    return null
  }

  const dia = found[2] === undefined ? hoy.getDate() : Number(found[2])
  const horas = (Number(found[3]) % 12) + (found[5]?.toLowerCase() === 'pm' ? 12 : 0)
  const date = new Date(hoy.getFullYear(), mes, dia, horas, Number(found[4] ?? 0))

  // Una renovación nunca queda atrás: sin fecha es la de mañana; con ella, la del año que viene.
  if (found[1] === undefined && date.getTime() < now) {
    date.setDate(date.getDate() + 1)
  } else if (date.getTime() < now - DIA_MS) {
    date.setFullYear(date.getFullYear() + 1)
  }

  // `/usage` da unas veces «10pm» y otras «9:59pm» para la misma renovación.
  return new Date(Math.round(date.getTime() / REDONDEO_MS) * REDONDEO_MS).toISOString()
}

// Los límites semanales por modelo que hay en la salida de `/usage`; null si no es lo esperado.
const porModeloDe = (
  text: string,
  now: number,
): { nombre: string; pct: number; renueva: string | null }[] | null => {
  const found = [...text.matchAll(LINEA_USO)]

  if (found.length === 0) {
    return null
  }

  return found
    .filter(line => line[1]?.toLowerCase() !== TODOS)
    .map(line => ({
      nombre: line[1] ?? '',
      pct: Number(line[2]),
      renueva: line[3] === undefined ? null : instante(line[3], now),
    }))
}

// Pone al día los límites por modelo. Lo que falla una vez no se reintenta en la sesión, y donde
// el plan no tiene ninguno tampoco se vuelve a preguntar.
const consultar = async ($: EngineInterface): Promise<void> => {
  if (!interactiva || sinConsulta || consultando) {
    return
  }

  const now = await $.clock.now()

  if (consultado !== 0 && now - consultado < REFRESCO_MS) {
    return
  }

  consultando = true
  consultado = now

  try {
    const done = await $.process.run([...CONSULTA], { stdin: '', timeoutMs: CONSULTA_MS })
    const limits = done.exitCode === 0 ? porModeloDe(done.stdout, now) : null
    sinConsulta = limits === null || limits.length === 0
    await update($, porModelo, () => limits ?? [])
  } catch {
    sinConsulta = true
  }

  consultando = false
}

// Lee al lector mientras viva: el bucle es la vida del proceso, que acaba con él o con el mod.
const leer = async ($: EngineInterface): Promise<void> => {
  if (leyendo) {
    return
  }

  let resto = ''
  lecturas = []
  leyendo = true

  try {
    const lector = $.process.spawn({
      argv: ['powershell.exe', '-NoProfile', '-NoLogo', '-NonInteractive', '-Command', LECTOR],
    })

    for await (const { stream, text } of lector) {
      if (stream !== 'stdout') {
        continue
      }

      // Un trozo acaba donde acabó la escritura: una línea puede venir partida.
      const lines = (resto + text).split('\n')
      resto = lines.pop() ?? ''

      for (const line of lines) {
        const found = /^(\d+) (\d+)\s*$/.exec(line)

        if (found) {
          lecturas = [...lecturas, { cpu: Number(found[1]), ram: Number(found[2]) }].slice(-MEDIA)
          const medido = { cpu: media(lecturas.map(l => l.cpu)), ram: media(lecturas.map(l => l.ram)) }
          await update($, uso, () => medido)
        }
      }
    }
  } catch {
    // Sin lector (otro sistema, o no arranca) la banda va sin esas cifras.
  }

  leyendo = false
  await update($, uso, () => null)
}

// ---------------------------------------------------------------------------------------------
// Panel de agentes: registro de los agentes de cada tarea y modelo y esfuerzo por tipo de agente.
// ---------------------------------------------------------------------------------------------
// Un solo panel con cuatro pestañas: arriba, un botón por cada una; debajo, la elegida.
const PANEL = 'agentes'
const TITULO = 'Agentes'
const PESTANAS = [
  { id: 'agentes', titulo: 'Agentes', tecla: '1' },
  { id: 'tareas', titulo: 'Tareas', tecla: '2' },
  { id: 'enrutadores', titulo: 'Enrutadores', tecla: '3' },
  { id: 'sesion', titulo: 'Sesión', tecla: '4' },
] as const
const COMANDO_AGENTES = 'agentes'

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

// El registro guarda los últimos MAX_AGENTES agentes y las tareas que los lanzaron.
const MAX_AGENTES = 200
// De cada tarea se enseña el principio de su prompt; nada se corta a lo ancho: lo que no cabe sigue en la línea de abajo.
const TEXTO_TAREA = 300

// Columnas de cada parte de la línea de un agente: «✓ 12:31:05 → 12:32:47» y «  1m42s    18.420 tok».
// Con ANCHO_LINEA todo va en una línea; con ANCHO_CIFRAS, horas y cifras juntas y el agente debajo;
// con menos, cada parte en su fila.
const ANCHO_CIFRAS = 44
const ANCHO_LINEA = 76
// Lo que el panel pide de ancho al acoplarse.
const COLUMNAS = 48

const MARCAS = {
  'en curso': { signo: '●', color: 'warning' },
  ok: { signo: '✓', color: 'success' },
  abortado: { signo: '✗', color: 'error' },
  error: { signo: '✗', color: 'error' },
} as const

const agentes = atom({ plugin: 'tokens-sesion', key: 'agentes' } as const, [])
const tareas = atom({ plugin: 'tokens-sesion', key: 'tareas' } as const, [])
// La persona cerró el panel: no vuelve a abrirse solo hasta que lo pida con el comando.
const oculto = atom({ plugin: 'tokens-sesion', key: 'oculto' } as const, false)
const rutas = atom({ plugin: 'tokens-sesion', key: 'rutas' } as const, {})
// Los tipos de agente que el motor ha ofrecido al modelo o ha arrancado en la sesión.
const tipos = atom({ plugin: 'tokens-sesion', key: 'tipos' } as const, [])
const pestana = atom({ plugin: 'tokens-sesion', key: 'pestana' } as const, 'agentes')

// Tokens de un agente cuya primera petición llega antes de que su arranque quede anotado.
const sueltos = new Map<string, number>()
const MAX_SUELTOS = 50

const dos = (n: number): string => String(n).padStart(2, '0')

// La hora del equipo: el módulo ve la zona horaria del sistema.
const hora = (ms: number): string => {
  const date = new Date(ms)

  return `${dos(date.getHours())}:${dos(date.getMinutes())}:${dos(date.getSeconds())}`
}

const duracion = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))

  if (s < 60) {
    return `${s}s`
  }

  if (s < 3600) {
    return `${Math.floor(s / 60)}m${dos(s % 60)}s`
  }

  return `${Math.floor(s / 3600)}h${dos(Math.floor((s % 3600) / 60))}m`
}

const resumir = (text: string): string => {
  const line = text.replace(/\s+/g, ' ').trim()

  return line.length > TEXTO_TAREA ? `${line.slice(0, TEXTO_TAREA - 1)}…` : line
}

// Cambia el agente `id` si está en el registro; dice si estaba.
const cambiar = async (
  $: EngineInterface,
  id: string,
  change: (agente: Agente) => Agente,
): Promise<boolean> => {
  if (!(await read($, agentes)).some(agente => agente.id === id)) {
    return false
  }

  await update($, agentes, list => list.map(agente => (agente.id === id ? change(agente) : agente)))

  return true
}

const abrir = ($: EngineInterface) => $.ui.open({ id: PANEL, title: TITULO, columns: COLUMNAS })

const esModelo = (value: unknown): value is string =>
  typeof value === 'string' && (MODELOS as readonly string[]).includes(value)

const esEsfuerzo = (value: unknown): value is string =>
  typeof value === 'string' && (ESFUERZOS as readonly string[]).includes(value)

// Lo guardado puede venir de otra versión del mod: solo vale lo que se puede elegir hoy.
const validas = (stored: unknown): Record<string, Ruta> => {
  const table: Record<string, Ruta> = {}

  if (typeof stored !== 'object' || stored === null) {
    return table
  }

  for (const [tipo, ruta] of Object.entries(stored)) {
    const { modelo, esfuerzo } = (ruta ?? {}) as Partial<Ruta>

    if (esModelo(modelo) && esEsfuerzo(esfuerzo) && (modelo !== HEREDAR || esfuerzo !== HEREDAR)) {
      table[tipo] = { modelo, esfuerzo }
    }
  }

  return table
}

const rutaDe = (table: Record<string, Ruta>, tipo: string): Ruta =>
  table[tipo] ?? table[RESTO] ?? SIN_RUTA

const guardarRutas = async (
  $: EngineInterface,
  change: (table: Record<string, Ruta>) => Record<string, Ruta>,
) => {
  await update($, rutas, table => validas(change(table)))
  await $.store.set(CLAVE, await read($, rutas))
}

// El esfuerzo que la tabla da al agente `id`. Su primera petición puede salir antes de que su
// arranque quede anotado: entonces el tipo se le pregunta al motor, que no lista los de un workflow.
const esfuerzoDe = async ($: EngineInterface, id: string): Promise<string> => {
  const agente = (await read($, agentes)).find(one => one.id === id)

  if (agente?.hereda) {
    return HEREDAR
  }

  const tipo = agente?.tipo ?? (await $.agent.list()).find(one => one.id === id)?.type

  return tipo === undefined || tipo === FORK ? HEREDAR : rutaDe(await read($, rutas), tipo).esfuerzo
}

// Apunta un tipo de agente para que tenga fila en la tabla.
const apuntar = async ($: EngineInterface, tipo: string) => {
  if (tipo === FORK || (await read($, tipos)).includes(tipo)) {
    return
  }

  await update($, tipos, list => (list.includes(tipo) ? list : [...list, tipo]))
}

const dibujarAgentes = async (
  $: EngineInterface,
  e: RenderInput<'Pane'>,
): Promise<RenderElement> => {
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
      const tiempo = agente.fin === null ? '' : duracion(agente.fin - agente.inicio)
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

const dibujarRutas = async (
  $: EngineInterface,
  e: RenderInput<'Pane'>,
): Promise<RenderElement> => {
  const table = await read($, rutas)
  const vistos = await read($, tipos)
  const list = await read($, agentes)
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
    const ruta = table[tipo] ?? SIN_RUTA
    const nombre = tipo === RESTO ? 'Los demás' : tipo
    const corto =
      nombre.length > ANCHO_TIPO ? `${nombre.slice(0, ANCHO_TIPO - 1)}…` : nombre.padEnd(ANCHO_TIPO)
    const elegir = (campo: keyof Ruta) => (value: string) => {
      void guardarRutas($, now => ({ ...now, [tipo]: { ...(now[tipo] ?? SIN_RUTA), [campo]: value } }))
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
            void guardarRutas($, () => RECOMENDADAS)
          }}
        />
        <Text> </Text>
        <Button
          key="heredar"
          label="Todo heredar"
          onPress={() => {
            void guardarRutas($, () => ({}))
          }}
        />
      </Box>
      <Text> </Text>
      <Text dimColor>Tokens por modelo en la sesión</Text>
      <Text wrap="wrap">{pie}</Text>
    </Box>
  )
}

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
const ESTADOS_PASO = {
  hecho: { signo: '✓', color: 'success' },
  'en curso': { signo: '●', color: 'warning' },
  pendiente: { signo: '○', color: 'inactive' },
} as const
// Columnas de la barra de avance, y de la cola de cada paso: « 12:31 → 12:45  14m05s».
const BARRA_PASOS = 20
const COLA_PASO = 23

const pasos = atom({ plugin: 'tokens-sesion', key: 'pasos' } as const, [])

const horaCorta = (ms: number): string => hora(ms).slice(0, 5)

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

// La lista entera llega de una vez: cada paso conserva sus tiempos si sigue con el mismo texto.
const sincronizar = (
  list: readonly Paso[],
  nuevos: readonly { texto: string; estado: Paso['estado'] }[],
  now: number,
): Paso[] => {
  const libres = [...list]

  return nuevos.slice(0, MAX_PASOS).map((nuevo, n) => {
    const i = libres.findIndex(paso => paso.texto === nuevo.texto)
    const previo = i < 0 ? pasoNuevo(`p${now}-${n}`, nuevo.texto) : libres.splice(i, 1)[0]!

    return mover(previo, nuevo.estado, now)
  })
}

const ESTADOS_MOTOR: Record<string, Paso['estado']> = {
  pending: 'pendiente',
  in_progress: 'en curso',
  completed: 'hecho',
  pendiente: 'pendiente',
  en_curso: 'en curso',
  hecho: 'hecho',
}

// Lo que llega a la herramienta propia lo escribe el modelo: se comprueba antes de guardarlo.
const leerPlan = (value: unknown): { texto: string; estado: Paso['estado'] }[] | null => {
  if (!Array.isArray(value)) {
    return null
  }

  const list: { texto: string; estado: Paso['estado'] }[] = []

  for (const item of value) {
    const { texto, estado } = (item ?? {}) as { texto?: unknown; estado?: unknown }
    const known = typeof estado === 'string' ? ESTADOS_MOTOR[estado] : undefined

    if (typeof texto !== 'string' || texto.trim() === '' || known === undefined) {
      return null
    }

    list.push({ texto: resumir(texto), estado: known })
  }

  return list
}

// Donde el modelo no tiene lista de tareas del motor, se le da la herramienta del plan.
const ofrecerPlan = async ($: EngineInterface): Promise<void> => {
  const names = (await $.tool.list()).map(tool => tool.name)

  if (names.includes('TodoWrite') || names.includes('TaskCreate')) {
    return
  }

  await $.tool.register({
    name: PLAN,
    description:
      'Guarda el plan de la tarea en curso para que la persona lo siga en un panel: la lista completa de pasos, cada uno con su estado. Llámala al empezar un trabajo de varios pasos y cada vez que un paso cambie de estado.',
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

const dibujarTareas = async (
  $: EngineInterface,
  e: RenderInput<'Pane'>,
): Promise<RenderElement> => {
  const { Box, Text } = $.ui.resolve(e)
  const list = await read($, pasos)
  const ancho = e.props.bodyColumns

  if (list.length === 0) {
    return (
      <Box key="cuerpo" flexDirection="column">
        <Text dimColor>Sin plan todavía.</Text>
        <Text dimColor wrap="wrap">
          Aparece cuando Claude reparte el trabajo en pasos.
        </Text>
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
const registrarTareas = (on: On): void => {
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)

    if (ran.deny === undefined && ran.isError !== true && e.agentId === undefined) {
      const now = await $.clock.now()
      const nuevos = e.todos.map(todo => ({
        texto: resumir(todo.content),
        estado: ESTADOS_MOTOR[todo.status] ?? 'pendiente',
      }))
      await update($, pasos, list => sincronizar(list, nuevos, now))
    }

    return ran
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)

    if (ran.deny === undefined && ran.isError !== true && e.agentId === undefined) {
      const id = `t${ran.result.task.id}`
      const texto = resumir(e.subject)
      await update($, pasos, list =>
        [...list.filter(paso => paso.id !== id), pasoNuevo(id, texto)].slice(-MAX_PASOS),
      )
    }

    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)

    if (ran.deny === undefined && ran.isError !== true && e.agentId === undefined) {
      const now = await $.clock.now()
      const id = `t${e.taskId}`
      const estado = e.status
      const subject = e.subject

      await update($, pasos, list => {
        if (estado === 'deleted') {
          return list.filter(paso => paso.id !== id)
        }

        // Una tarea creada antes de cargar el mod entra aquí por primera vez.
        const known = list.some(paso => paso.id === id)
        const todos = known ? list : [...list, pasoNuevo(id, resumir(subject ?? `Tarea ${e.taskId}`))]

        return todos.map(paso => {
          if (paso.id !== id) {
            return paso
          }

          const renombrado = subject === undefined ? paso : { ...paso, texto: resumir(subject) }

          return estado === undefined ? renombrado : mover(renombrado, ESTADOS_MOTOR[estado] ?? paso.estado, now)
        })
      })
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
      const now = await $.clock.now()
      await update($, pasos, list => sincronizar(list, nuevos, now))
    }

    const hechos = nuevos.filter(paso => paso.estado === 'hecho').length

    return { result: `Plan guardado: ${hechos} de ${nuevos.length} pasos hechos.` }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    return e.tools.includes(PLAN_COMPLETO)
      ? {
          sections: [
            ...composed.sections.filter(section => section.id !== SECCION_PLAN),
            { id: SECCION_PLAN, text: TEXTO_PLAN, scope: 'session' as const },
          ],
        }
      : composed
  })
}

// ---------------------------------------------------------------------------------------------
// Pestaña Sesión e histórico: el resumen de la sesión en el panel, y en un fichero que la sobrevive.
// ---------------------------------------------------------------------------------------------
// El histórico es un Markdown por sesión en el proyecto, reescrito al acabar cada turno: el plan
// de tareas, los agentes de cada tarea y las compactaciones. Solo en sesiones interactivas.
const CARPETA_HISTORICO = '.claude/historial'
const LIMITE_5H = 'five_hour'
// Lo que llega del motor y de PostCompact de una misma compactación se junta si llega así de seguido.
const MISMA_COMPACTACION_MS = 120_000
const MAX_COMPACTACIONES = 50

// Lo gastado por los agentes de la sesión; el resto de `gastados` es del hilo principal.
const deAgentes = atom({ plugin: 'tokens-sesion', key: 'deAgentes' } as const, 0)
const cincoHoras = atom({ plugin: 'tokens-sesion', key: 'cincoHoras' } as const, null)
const compactaciones = atom({ plugin: 'tokens-sesion', key: 'compactaciones' } as const, [])
// Cuándo empezó el histórico de esta conversación (da nombre a su fichero) y dónde se guardó.
const nacida = atom({ plugin: 'tokens-sesion', key: 'nacida' } as const, null)
const historico = atom({ plugin: 'tokens-sesion', key: 'historico' } as const, null)

const sello = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace(/[T:]/g, '-')

const fecha = (ms: number): string => {
  const date = new Date(ms)

  return `${date.getFullYear()}-${dos(date.getMonth() + 1)}-${dos(date.getDate())} ${hora(ms).slice(0, 5)}`
}

const pct = (parte: number, total: number): string =>
  total <= 0 ? '0 %' : `${Math.round((parte / total) * 100)} %`

// Una compactación llega en dos avisos (lo que midió el motor y el fichero del resumen), en cualquier orden.
const anotarCompactacion = async (
  $: EngineInterface,
  dato: Partial<Omit<Compactacion, 'hora'>>,
): Promise<void> => {
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
      : [...list, { hora: now, antes: null, despues: null, fichero: null, ...dato }].slice(-MAX_COMPACTACIONES)
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
  agentes: readonly Agente[]
  tareas: readonly { n: number; inicio: number; texto: string }[]
  compactaciones: readonly Compactacion[]
  leido: number
}): string => {
  const celda = (text: string): string => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ')
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
      '| Estado | Paso | Inicio | Fin | Duración |',
      '|---|---|---|---|---|',
      ...datos.pasos.map(
        paso =>
          `| ${paso.estado} | ${celda(paso.texto)} | ${paso.inicio === null ? '' : hora(paso.inicio)} | ${paso.fin === null ? '' : hora(paso.fin)} | ${paso.ms > 0 ? duracion(paso.ms) : ''} |`,
      ),
    )
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
            `| ${agente.estado} | ${hora(agente.inicio)} | ${agente.fin === null ? '' : hora(agente.fin)} | ${agente.fin === null ? '' : duracion(agente.fin - agente.inicio)} | ${conPuntos(agente.tokens)} | ${celda(agente.nombre === null ? agente.tipo : `${agente.nombre} (${agente.tipo})`)} | ${celda(agente.descripcion)} | ${agente.modelo.replace(/^claude-/, '')} | ${agente.esfuerzo ?? ''} |`,
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

// Reescribe el histórico de la sesión si hay algo que contar.
const historiar = async ($: EngineInterface): Promise<void> => {
  if (!interactiva) {
    return
  }

  const lista = await read($, agentes)
  const plan = await read($, pasos)
  const hechas = await read($, compactaciones)

  if (lista.length === 0 && plan.length === 0 && hechas.length === 0) {
    return
  }

  const now = await $.clock.now()
  const inicio = (await read($, nacida)) ?? now
  await update($, nacida, () => inicio)
  const usage = await $.session.usage()
  const file = `${CARPETA_HISTORICO}/sesion-${sello(inicio)}.md`
  await $.fs.write(
    file,
    textoHistorico({
      inicio,
      now,
      proyecto: await $.session.root(),
      modelo: await $.session.model(),
      turnos: await $.session.turns().catch(() => null),
      total: await read($, gastados),
      agentesTok: await read($, deAgentes),
      usd: usage.cost?.usd ?? null,
      pasos: plan,
      agentes: lista,
      tareas: await read($, tareas),
      compactaciones: hechas,
      leido: (await read($, cache)).leido,
    }),
  )
  await update($, historico, () => file)
}

// Una conversación nueva (/clear, o al retomar otra) empieza su registro y su histórico de cero.
const reiniciarSesion = async ($: EngineInterface): Promise<void> => {
  await update($, agentes, () => [])
  await update($, tareas, () => [])
  await update($, pasos, () => [])
  await update($, deAgentes, () => 0)
  await update($, compactaciones, () => [])
  const now = await $.clock.now()
  await update($, nacida, () => now)
  await update($, historico, () => null)
  await update($, cache, estado => ({ ...estado, ultima: null, latidos: 0, nota: null }))
  pararLatido()
  prefijoNuevo = true
  sueltos.clear()
}

const dibujarSesion = async (
  $: EngineInterface,
  e: RenderInput<'Pane'>,
): Promise<RenderElement> => {
  const { Box, Text, Button } = $.ui.resolve(e)
  const now = await $.clock.now()
  const usage = await $.session.usage()
  const turnos = await $.session.turns().catch(() => null)
  const total = await read($, gastados)
  const agentesTok = Math.min(total, await read($, deAgentes))
  const tokens = (await read($, contexto)) ?? usage.context.tokens ?? 0
  const rige = await read($, efectivo)
  const limite5 = await read($, cincoHoras)
  const limite7 = await read($, semana)
  const hechas = await read($, compactaciones)
  const file = await read($, historico)
  const plan = await read($, pasos)
  const lista = await read($, agentes)
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
  const limite = (etiqueta: string, value: { pct: number; renueva: string | null } | null) => {
    if (value === null) {
      return
    }

    const renueva = value.renueva === null ? null : cuando(value.renueva)
    dato(
      etiqueta,
      `${Math.round(value.pct)} % usado${renueva === null ? '' : ` · se renueva ${renueva}`}`,
      colorUso(value.pct),
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

  if (limite5 !== null || limite7 !== null) {
    titulo('Límites del plan')
    limite('5 horas', limite5)
    limite('Semana', limite7)
  }

  titulo('Caché')

  for (const [etiqueta, texto] of await lineasCache($, now)) {
    dato(etiqueta, texto)
  }

  const guardada = await read($, cache)
  filas.push(
    <Box flexDirection="row">
      <Text dimColor>{'Mantenerla'.padEnd(13)}</Text>
      <Button
        key="cache-viva"
        label={guardada.viva ? 'sí' : 'no'}
        variant={guardada.viva ? 'primary' : 'secondary'}
        onPress={() => {
          void read($, cache).then(estado => fijarCache($, !estado.viva))
        }}
      />
    </Box>,
  )

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

  for (const one of hechas) {
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
      {file ?? 'Se guarda al acabar el primer turno con tareas o agentes.'}
    </Text>,
  )

  return (
    <Box key="cuerpo" flexDirection="column">
      {filas}
    </Box>
  )
}

// ---------------------------------------------------------------------------------------------
// Caché viva: en las pausas, lo más barato entre mantener la caché, compactar o dejarla caducar.
// ---------------------------------------------------------------------------------------------
// El motor guarda en caché la conversación ya enviada: mientras dura, cada petición la relee casi
// gratis; si caduca, la siguiente la reescribe entera a precio de escritura. Con el ajuste activado
// y la sesión en reposo, el mod hace poco antes de que caduque una consulta mínima sobre la propia
// conversación (`$.model.fork`: lee la caché y renueva su plazo sin dejar nada en la conversación).
// Es la regla del alquiler de esquís: se paga el «alquiler» (un latido por hora) hasta que lo
// pagado iguala lo que cuesta «comprar» (compactar, o dejarla caducar); entonces se hace lo más
// barato de esas dos cosas y se para. Así, en una sesión a la que no se vuelve se pierde como mucho
// lo que habría costado una caducidad.
const CLAVE_CACHE = 'cacheViva'
const TTL_LARGO_MS = 60 * 60_000
const TTL_CORTO_MS = 5 * 60_000
// El latido sale con este margen antes de que caduque; el plazo cuenta desde que empieza la petición.
const MARGEN_MS = 8 * 60_000
const HOLGURA_MS = 20_000
// Como mucho estos latidos por pausa, salga lo que salga la cuenta.
const MAX_LATIDOS = 12
// Por debajo de este contexto no se compacta: no hay nada que ganar.
const MIN_COMPACTAR = 150_000
// Lo que se estima que ocupa el resumen de una compactación y el contexto que deja.
const RESUMEN_TOKENS = 15_000
const TRAS_COMPACTAR = 45_000
// Precios en veces el de un token de entrada: escribir la caché de una hora, un token de salida
// y leer la caché según el modelo.
const PRECIO_ESCRITURA = 2
const PRECIO_SALIDA = 5
const precioLectura = (modelo: string): number =>
  /fable|mythos/i.test(modelo) ? 0.025 : /opus-5-5/i.test(modelo) ? 0.05 : 0.1
const LATIDO = 'Responde solo con la palabra: ok'
// Un acierto es leer de caché al menos esta parte de lo enviado.
const ACIERTO = 0.5

const cache = atom({ plugin: 'tokens-sesion', key: 'cache' } as const, {
  viva: false,
  ttl: 'sin confirmar',
  ultima: null,
  latidos: 0,
  leido: 0,
  nota: null,
})

// El temporizador del próximo latido, si hay uno en marcha.
let cancelarLatido: (() => void) | null = null
// Con un turno del hilo principal en marcha no hay pausa que cubrir.
let enTurno = false
// Tras compactar o cambiar de modelo, el siguiente fallo de caché no dice nada de su duración.
let prefijoNuevo = true
let modeloAnterior = ''

// Lo que cuesta cada salida con `contexto` tokens, en tokens a precio de entrada, y lo que se decide:
// cuántos latidos como mucho y qué se hace después.
const planCache = (
  contexto: number,
  modelo: string,
): { veces: number; final: 'compactar' | 'caducar' } => {
  const lectura = precioLectura(modelo)
  const latido = contexto * lectura
  const caducar = contexto * (PRECIO_ESCRITURA - lectura)
  const compactar =
    contexto * lectura +
    RESUMEN_TOKENS * PRECIO_SALIDA +
    TRAS_COMPACTAR * PRECIO_ESCRITURA +
    TRAS_COMPACTAR * (PRECIO_ESCRITURA - lectura)
  const final = contexto >= MIN_COMPACTAR && compactar < caducar ? 'compactar' : 'caducar'
  const tope = final === 'compactar' ? compactar : caducar

  return { veces: latido <= 0 ? 0 : Math.min(MAX_LATIDOS, Math.floor(tope / latido)), final }
}

const pararLatido = (): void => {
  cancelarLatido?.()
  cancelarLatido = null
}

// Programa el próximo latido para poco antes de que caduque la caché, si toca mantenerla.
const armarLatido = async ($: EngineInterface): Promise<void> => {
  pararLatido()
  const estado = await read($, cache)

  if (!interactiva || !estado.viva || estado.ttl !== '1h' || estado.ultima === null) {
    return
  }

  const espera = estado.ultima + TTL_LARGO_MS - MARGEN_MS - (await $.clock.now())
  const timer = $.clock.after(Math.max(1_000, espera), () => {
    latir($).catch(() => undefined)
  })
  cancelarLatido = () => timer.cancel()
}

const latir = async ($: EngineInterface): Promise<void> => {
  cancelarLatido = null
  const estado = await read($, cache)

  if (!estado.viva || estado.ttl !== '1h' || estado.ultima === null || enTurno) {
    return
  }

  const inicio = await $.clock.now()

  if (inicio - estado.ultima >= TTL_LARGO_MS - HOLGURA_MS) {
    await update($, cache, now => ({ ...now, nota: 'La caché caducó antes de poder mantenerla.' }))

    return
  }

  const tokens = (await read($, contexto)) ?? 0
  const { veces, final } = planCache(tokens, await $.session.model())

  if (estado.latidos < veces) {
    const reply = await $.model.fork({ prompt: LATIDO })
    const leido = 'usage' in reply ? (reply.usage?.cache_read_input_tokens ?? 0) : 0

    if (reply.isAnswered && leido >= tokens * ACIERTO) {
      await update($, cache, now => ({
        ...now,
        ultima: inicio,
        latidos: now.latidos + 1,
        leido: now.leido + leido,
        nota: `Mantenida a las ${hora(inicio).slice(0, 5)} (${now.latidos + 1} de ${veces} en esta pausa).`,
      }))
      await armarLatido($)

      return
    }

    await update($, cache, now => ({
      ...now,
      nota: reply.isAnswered
        ? 'La caché ya no estaba: no se sigue manteniendo en esta pausa.'
        : 'No se pudo mantener la caché: la consulta falló.',
    }))

    return
  }

  if (final === 'compactar') {
    await update($, cache, now => ({
      ...now,
      nota: `Tras ${duracion(now.latidos * (TTL_LARGO_MS - MARGEN_MS))} de pausa salía más barato compactar: compactada a las ${hora(inicio).slice(0, 5)}.`,
    }))
    await $.command.run({ command: 'compact', args: '' })

    return
  }

  await update($, cache, now => ({
    ...now,
    nota: `Tras ${duracion(now.latidos * (TTL_LARGO_MS - MARGEN_MS))} de pausa sale más barato dejarla caducar: no se mantiene más.`,
  }))
}

// Cada petición del hilo principal dice cuánto dura la caché (si acertó tras un hueco de más de
// cinco minutos, es la de una hora) y reinicia la cuenta de la pausa.
const observarCache = async (
  $: EngineInterface,
  inicio: number,
  usage: ModelUsage & { model?: string },
): Promise<void> => {
  const enviados = enviado(usage)
  const acierto = enviados > 0 && usage.cache_read_input_tokens >= enviados * ACIERTO
  const modelo = usage.model ?? ''
  const fiable = !prefijoNuevo && modelo === modeloAnterior
  prefijoNuevo = false
  modeloAnterior = modelo

  await update($, cache, now => {
    const hueco = now.ultima === null ? 0 : inicio - now.ultima
    const largo = hueco > TTL_CORTO_MS + HOLGURA_MS
    const ttl =
      largo && acierto
        ? '1h'
        : largo && !acierto && fiable && hueco < TTL_LARGO_MS - MARGEN_MS
          ? '5m'
          : now.ttl

    return { ...now, ttl, ultima: inicio, latidos: 0, nota: now.latidos > 0 ? now.nota : null }
  })
  await armarLatido($)
}

const fijarCache = async ($: EngineInterface, viva: boolean): Promise<void> => {
  await $.store.set(CLAVE_CACHE, viva)
  await update($, cache, now => ({ ...now, viva, nota: null }))
  await armarLatido($)
}

// Lo que dice la pestaña Sesión de la caché, línea a línea: [etiqueta, texto].
const lineasCache = async ($: EngineInterface, now: number): Promise<[string, string][]> => {
  const estado = await read($, cache)
  const lines: [string, string][] = [
    [
      'Duración',
      estado.ttl === '1h' ? '1 hora' : estado.ttl === '5m' ? '5 minutos' : 'sin confirmar todavía',
    ],
  ]

  if (estado.ultima !== null && estado.ttl !== 'sin confirmar') {
    const fin = estado.ultima + (estado.ttl === '1h' ? TTL_LARGO_MS : TTL_CORTO_MS)
    lines.push(['Caduca', fin > now ? `a las ${hora(fin).slice(0, 5)}` : 'ya caducó'])
  }

  if (estado.viva) {
    const { veces, final } = planCache((await read($, contexto)) ?? 0, await $.session.model())
    lines.push([
      'Plan',
      estado.ttl === '1h'
        ? `mantenerla hasta ${veces} h de pausa; después, ${final === 'compactar' ? 'compactar' : 'dejarla caducar'}`
        : estado.ttl === '5m'
          ? 'con caché de 5 minutos no compensa mantenerla'
          : 'empieza cuando se confirme que dura 1 hora',
    ])
  }

  if (estado.leido > 0) {
    lines.push(['Leído', `${conPuntos(estado.leido)} tokens de caché en mantenerla`])
  }

  return lines
}

// Un plugin engancha cada evento una sola vez: el arranque de la sesión y las peticiones al modelo
// son también de la banda, y sus hooks llaman a estas tres funciones.

// Al arrancar la sesión (o recargar el mod): el comando y la tabla guardada.
const arrancarAgentes = async ($: EngineInterface, isInteractive: boolean): Promise<void> => {
  await $.command.register({
    name: COMANDO_AGENTES,
    description: 'Panel con los agentes de cada tarea: inicio, fin, duración y tokens',
    argumentHint: '[tareas | rutas | sesion | cache si|no | cerrar | limpiar]',
  })
  const stored = validas(await $.store.get(CLAVE))
  await update($, rutas, () => stored)
  // Al recargar el mod la conversación sigue: su histórico conserva el nombre.
  const now = await $.clock.now()
  await update($, nacida, born => born ?? now)
  const viva = (await $.store.get(CLAVE_CACHE)) === true
  await update($, cache, estado => ({ ...estado, viva }))

  // El plan solo interesa donde hay alguien mirando el panel.
  if (isInteractive) {
    await ofrecerPlan($).catch(() => undefined)
  }
}

// La petición tal como debe salir: con el esfuerzo de la tabla si es de un agente y el modelo lo admite.
const enrutarPaso = async ($: EngineInterface, e: TurnStepInput): Promise<TurnStepInput> => {
  const id = e.agentId

  if (id === undefined || e.effort === undefined) {
    return e
  }

  const esfuerzo = await esfuerzoDe($, id)

  return esfuerzo === HEREDAR ? e : { ...e, effort: esfuerzo as Esfuerzo }
}

// Cada petición de un agente suma a su línea; si ya había acabado (lo retomaron), vuelve a estar en curso.
const contarPaso = async (
  $: EngineInterface,
  sent: TurnStepInput,
  usage: ModelUsage | null | undefined,
): Promise<void> => {
  const id = sent.agentId

  if (id === undefined || !usage) {
    return
  }

  const spent = gasto(usage)
  const known = await cambiar($, id, agente => ({
    ...agente,
    tokens: agente.tokens + spent,
    fin: null,
    estado: 'en curso',
    esfuerzo: sent.effort === undefined ? null : String(sent.effort),
  }))

  if (!known) {
    // Los ids que nunca arrancan como agente (compactación, memoria) no se acumulan.
    if (sueltos.size >= MAX_SUELTOS) {
      sueltos.clear()
    }

    sueltos.set(id, (sueltos.get(id) ?? 0) + spent)
  }
}

// Los hooks que son solo del panel de agentes.
const registrarAgentes = (on: On): void => {
  on('command.run', { command: COMANDO_AGENTES }, async ($, e) => {
    const typed = e.args.trim().toLowerCase()

    if (typed === 'cerrar') {
      await update($, oculto, () => true)
      await $.ui.close({ id: PANEL })

      return { text: 'Panel de agentes cerrado. El registro sigue: /agentes lo vuelve a abrir.' }
    }

    if (typed === 'cache si' || typed === 'cache sí' || typed === 'cache no') {
      const viva = typed !== 'cache no'
      await fijarCache($, viva)

      return {
        text: viva
          ? 'Caché viva activada: en las pausas se mantiene mientras sea lo más barato, y después se compacta o se deja caducar.'
          : 'Caché viva desactivada: en las pausas no se hace nada.',
      }
    }

    if (typed === 'limpiar') {
      await update($, pasos, () => [])
      await update($, agentes, () => [])
      await update($, tareas, () => [])
      sueltos.clear()

      return { text: 'Registro de agentes y plan de tareas vaciados.' }
    }

    if (typed !== '' && typed !== 'rutas' && typed !== 'tareas' && typed !== 'sesion') {
      return {
        text: 'Uso: /agentes (abre el panel), /agentes tareas, /agentes rutas y /agentes sesion (lo abren en esa pestaña), /agentes cache si|no, /agentes cerrar, /agentes limpiar.',
      }
    }

    await update($, oculto, () => false)
    if (typed === 'rutas') {
      await update($, pestana, () => 'enrutadores')
    }

    if (typed === 'tareas') {
      await update($, pestana, () => 'tareas')
    }

    if (typed === 'sesion') {
      await update($, pestana, () => 'sesion')
    }

    const opened = await abrir($)

    return {
      text: opened.isPlaced
        ? 'Panel de agentes abierto.'
        : 'El panel de agentes no cabe ahora: se abrirá al ensanchar el terminal.',
    }
  })

  // Cada prompt del hilo principal es una tarea; se guardan solo las que lanzaron algún agente.
  // El motor también avisa al empezar cada subagente (`agentId`): eso no es una tarea.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e)
    }

    enTurno = true
    const inicio = await $.clock.now()
    const usadas = new Set((await read($, agentes)).map(agente => agente.tarea))
    await update($, tareas, list => [
      ...list.filter(tarea => usadas.has(tarea.n)),
      { n: (list.at(-1)?.n ?? 0) + 1, inicio, texto: resumir(e.text) },
    ])

    return next(e)
  })

  // Cada tipo que el motor ofrece al modelo tiene su fila en la tabla.
  on('agent.offer', async ($, e, next) => {
    await apuntar($, e.agent)

    return next(e)
  })

  // El modelo de la tabla manda sobre el que pida la llamada; un fork y los agentes de un workflow
  // heredan.
  on('agent.spawn', async ($, e, next) => {
    // Un agente retomado (SendMessage) sigue en su línea y en su tarea: su primera petición lo
    // vuelve a poner en curso. El motor no deja cambiarle nada.
    if (e.resume !== undefined) {
      return next(e)
    }

    const inicio = await $.clock.now()
    const modelo = rutaDe(await read($, rutas), e.subagentType).modelo
    const started = await next(
      modelo === HEREDAR || e.fork || e.workflow !== undefined ? e : { ...e, model: modelo },
    )

    if (started.agentId === undefined) {
      return started
    }

    const id = started.agentId
    const agente: Agente = {
      id,
      tipo: e.subagentType,
      nombre: e.name ?? null,
      descripcion: e.description,
      modelo: started.model,
      tarea: (await read($, tareas)).at(-1)?.n ?? 0,
      inicio,
      fin: null,
      estado: 'en curso',
      tokens: 0,
      esfuerzo: null,
      hereda: e.fork || e.workflow !== undefined,
    }
    await apuntar($, e.subagentType)
    await update($, agentes, list =>
      [...list.filter(one => one.id !== id), agente].slice(-MAX_AGENTES),
    )
    const antes = sueltos.get(id)

    if (antes !== undefined) {
      sueltos.delete(id)
      await cambiar($, id, one => ({ ...one, tokens: one.tokens + antes }))
    }

    // Si ya está abierto no se toca: la persona puede estar en la otra pestaña.
    if (
      interactiva &&
      !(await read($, oculto)) &&
      !(await $.ui.panes()).some(pane => pane.id === PANEL)
    ) {
      abrir($).catch(() => undefined)
    }

    return started
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId

    if (id === undefined) {
      enTurno = false
    }

    if (id !== undefined) {
      const fin = await $.clock.now()
      const estado = e.reason === 'answer' ? 'ok' : e.reason === 'aborted' ? 'abortado' : 'error'
      await cambiar($, id, agente => ({ ...agente, fin, estado }))
    }

    const done = await next(e)
    await historiar($).catch(() => undefined)

    return done
  })

  on('ui.close', { id: PANEL }, async ($, e, next) => {
    if (e.origin.kind === 'person') {
      await update($, oculto, () => true)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANEL }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const actual = await read($, pestana)
    const cuerpo =
      actual === 'enrutadores'
        ? await dibujarRutas($, e)
        : actual === 'tareas'
          ? await dibujarTareas($, e)
          : actual === 'sesion'
            ? await dibujarSesion($, e)
            : await dibujarAgentes($, e)

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
                void update($, pestana, () => id)
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

export const register: Register = on => {
  registrarAgentes(on)
  registrarTareas(on)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tokens-compact',
      description: 'Umbral de tokens de contexto con el que se compacta la sesión',
      argumentHint: '[tokens | 0]',
    })
    await cargar($)
    // Al recargar el mod a media sesión el motor ya los tiene.
    await limitar($, (await $.session.usage()).rateLimits)
    await arrancarAgentes($, e.isInteractive)
    const started = await next(e)

    // Solo donde hay alguien mirando la banda.
    interactiva = e.isInteractive
    armarLatido($).catch(() => undefined)
    consultado = 0
    sinConsulta = false

    if (e.isInteractive) {
      leer($).catch(() => undefined)
      consultar($).catch(() => undefined)
    }

    return started
  })

  on('command.run', { command: 'tokens-compact' }, async ($, e) => {
    const typed = e.args.trim()

    if (typed === '') {
      await cargar($)
    } else {
      const value = Number(typed.replace(/[.\s_]/g, ''))

      if (!vale(value)) {
        return {
          text: `«${typed}» no vale: un número de ${conPuntos(UMBRAL_MIN)} a ${conPuntos(UMBRAL_MAX)}, o 0 para desactivarlo.`,
        }
      }

      await fijar($, value)
    }

    return { text: estado(await read($, umbral), await read($, efectivo)) }
  })

  // La barra avisa de dónde se soltó la marca. Viene de código: se comprueba como cualquier entrada.
  on('ui.message', async ($, e, next) => {
    const data = e.data

    if (typeof data === 'object' && data !== null && 'umbral' in data) {
      const limite = data.umbral

      if (limite !== 0 && vale(limite)) {
        await fijar($, limite)
        const rige = await read($, efectivo)
        $.ui.toast(`Compactado automático a los ${conPuntos(rige)} tokens de contexto`)
      }
    }

    return next(e)
  })

  on('ui.fault', async ($, e, next) => {
    await update($, sinRaton, () => true)

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const inicio = e.agentId === undefined ? await $.clock.now() : 0
    const sent = await enrutarPaso($, e)
    const response = yield* next(sent)
    const usage = response.usage
    await contarPaso($, sent, usage)

    if (usage) {
      const spent = gasto(usage)
      await update($, gastados, total => total + spent)

      if (e.agentId !== undefined) {
        await update($, deAgentes, total => total + spent)
      }

      if (e.agentId === undefined) {
        const tokens = enviado(usage)
        await update($, contexto, () => tokens)
        await observarCache($, inicio, usage)
      }
    }

    if (e.agentId === undefined) {
      consultar($).catch(() => undefined)
    }

    return response
  })

  on('session.measure', async ($, e, next) => {
    const tokens = e.context.tokens

    if (tokens !== undefined) {
      await update($, contexto, () => tokens)
    }

    await limitar($, e.rateLimits)
    // Otra sesión pudo mover el umbral, y esta cambiar de modelo.
    await cargar($)

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const instructions = e.instructions?.includes(INSTRUCCIONES)
      ? e.instructions
      : [e.instructions, INSTRUCCIONES].filter(Boolean).join('\n\n')
    const done = await next({ ...e, instructions })

    if (e.agentId === undefined && e.trigger !== 'precompute' && done.skip === undefined) {
      const after = done.tokensAfter
      await update($, contexto, () => after ?? null)
      await anotarCompactacion($, { antes: done.tokensBefore ?? null, despues: after ?? null })
      prefijoNuevo = true
      historiar($).catch(() => undefined)
    }

    return done
  })

  on('classic.PostCompact', async ($, e, next) => {
    if (e.agent_id === undefined) {
      // Hasta la siguiente respuesta, el contexto es el que diga el motor.
      await update($, contexto, () => null)
      const file = await guardar($, e.compact_summary)
      await anotarCompactacion($, { fichero: file })
      historiar($).catch(() => undefined)
      $.ui.toast(`Resumen de la sesión guardado en ${file}`)
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    pararLatido()

    if (e.reason === 'clear' || e.reason === 'resume') {
      await update($, gastados, () => 0)
      await update($, contexto, () => null)
      await update($, resumen, () => null)
      await reiniciarSesion($)
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const tokens = (await read($, contexto)) ?? (await $.session.usage()).context.tokens ?? 0
    const total = await read($, gastados)
    const rige = await read($, efectivo)
    const tope = await read($, maximo)
    const medido = await read($, uso)
    // Con un modelo que tiene su propio límite semanal se enseña ese; con los demás, el de todos.
    const propios = e.props.maxRows >= 2 ? await read($, porModelo) : []
    const modelo = propios.length === 0 ? '' : (await $.session.model()).toLowerCase()
    const propio = propios.find(limit => modelo.includes(limit.nombre.toLowerCase()))
    const limite = e.props.maxRows >= 2 ? (propio ?? (await read($, semana))) : null
    const reserva = Math.max(
      RESERVA + (medido === null ? 0 : RESERVA_USO),
      limite === null ? 0 : RESERVA_SEMANA,
    )
    const ancho = Math.max(BARRA_MIN, Math.min(BARRA_MAX, e.props.bodyColumns - reserva))
    const titulo = `Contexto: ${conPuntos(tokens)} tokens `
    const usado = limite === null ? 0 : Math.round(limite.pct)
    const tituloSemana = propio
      ? `Semana ${propio.nombre}: ${usado}% usado `
      : `Semana:   ${usado}% usado `
    // Con las dos líneas, sus barras empiezan en la misma columna.
    const largo = limite === null ? 0 : Math.max(titulo.length, tituloSemana.length)
    const llenas = Math.max(0, Math.min(ancho, Math.round((usado * ancho) / 100)))
    const renueva = limite === null || limite.renueva === null ? null : cuando(limite.renueva)
    const marca = rige === 0 ? -1 : celdaDe(rige, ancho)
    const barra = celdas(tokens, ancho)
    const indices = barra.map((_, i) => i)
    const table = $.ui.resolve(e)
    const { Box, Text } = table
    // Solo el terminal y el escritorio tienen regiones que reciban el ratón.
    const conRaton =
      (e.surface === 'terminal' || e.surface === 'desktop') && !(await read($, sinRaton))
    const Client = conRaton && 'Client' in table ? table.Client : undefined

    const linea = (
      <Box>
        <Text color={colorDe(tokens)}>{titulo.padEnd(largo)}</Text>
        {Client === undefined ? (
          barra.map((celda, i) =>
            i === marca && celda.text !== '●' ? (
              <Text color={MARCA}>┃</Text>
            ) : (
              <Text color={celda.color}>{celda.text}</Text>
            ),
          )
        ) : (
          <Client
            key="deslizador"
            module="./barra.tsx"
            width={ancho}
            height={1}
            props={{
              celdas: barra,
              marca,
              desde: Math.ceil((UMBRAL_MIN * ancho) / ESCALA),
              hasta: Math.floor((tope * ancho) / ESCALA),
              valores: indices.map(i => valorDe(i, ancho)),
              textos: indices.map(i => conPuntos(valorDe(i, ancho))),
              color: MARCA,
            }}
          />
        )}
        <Text dimColor> · sesión: {conPuntos(total)}</Text>
        {medido !== null && <Text dimColor> · </Text>}
        {medido !== null && <Text color={colorUso(medido.cpu)}>CPU {medido.cpu}%</Text>}
        {medido !== null && <Text dimColor> · </Text>}
        {medido !== null && <Text color={colorUso(medido.ram)}>RAM {medido.ram}%</Text>}
      </Box>
    )

    if (limite === null) {
      return linea
    }

    return (
      <Box flexDirection="column">
        {linea}
        <Box>
          <Text color={colorUso(usado)}>{tituloSemana.padEnd(largo)}</Text>
          <Text color={colorUso(usado)}>{'█'.repeat(llenas) + '░'.repeat(ancho - llenas)}</Text>
          {renueva !== null && <Text dimColor> · se renueva {renueva}</Text>}
        </Box>
      </Box>
    )
  })
}
