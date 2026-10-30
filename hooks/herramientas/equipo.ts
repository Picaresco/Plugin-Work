import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

// Uso de CPU y RAM del equipo: una lectura cada LECTURA_S segundos, y en la banda la media de las
// MEDIA últimas, cada cifra con su color hasta `hasta` por ciento, incluido; por encima, ROJO.
const LECTURA_S = 12
const MEDIA = 5
// Columnas que ocupan las dos cifras cuando se muestran.
export const RESERVA_USO = 22
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

// La media de CPU y RAM en %, o null mientras no hay lecturas (otro sistema, sin lector).
const uso = atom({ plugin: 'tokens-sesion', key: 'uso' } as const, null)

// Las últimas lecturas del lector, en décimas de %, y si hay uno en marcha.
let lecturas: { cpu: number; ram: number }[] = []
let leyendo = false

// La media, en % entero, de unas lecturas en décimas.
const media = (decimas: number[]): number =>
  Math.round(decimas.reduce((sum, value) => sum + value, 0) / decimas.length / 10)

// Lee al lector mientras viva: el bucle es la vida del proceso, que acaba con él o con el mod.
export async function leer($: EngineInterface): Promise<void> {
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

export async function leerUso($: EngineInterface): Promise<{ cpu: number; ram: number } | null> {
  return read($, uso)
}
