import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import { colorUso, conPuntos, cuando, ROJO, vigente } from '../util'
import { leerEfectivo, leerMaximo, leerRechazos, UMBRAL_MIN } from './compactado'
import { leerContexto, leerGastados } from './contador'
import { leerUso, RESERVA_USO } from './equipo'
import { leerPorModelo, leerSemana } from './limites'

// Cada tramo se pinta con su color hasta `hasta` tokens de contexto, incluido; por encima del último, ROJO.
const TRAMOS = [
  { hasta: 500_000, color: '#22c55e' },
  { hasta: 650_000, color: '#a3e635' },
  { hasta: 800_000, color: '#facc15' },
  { hasta: 950_000, color: '#fb923c' },
] as const

// La barra va de 0 a ESCALA tokens de contexto, con una marca donde se compacta.
const ESCALA = 1_000_000
const BARRA_MAX = 40
const BARRA_MIN = 10
// Columnas que ocupan los dos textos que acompañan a la barra.
const RESERVA = 44
const MARCA = '#38bdf8'

// Columnas de la etiqueta del límite semanal y de cuándo se renueva.
const RESERVA_SEMANA = 54

// La superficie no pudo con la barra que recibe el ratón: se dibuja la fija.
const sinRaton = atom({ plugin: 'tokens-sesion', key: 'sinRaton' } as const, false)

// Si el terminal ha dicho que no está a pantalla completa; ahí un panel no va acoplado al lado.
let pantallaPrincipal = false

export const enPantallaPrincipal = (): boolean => pantallaPrincipal

export const colorDe = (tokens: number): string =>
  TRAMOS.find(tramo => tokens <= tramo.hasta)?.color ?? ROJO

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

// Un fallo puntual de la barra no la deja fija para siempre: se vuelve a probar al arrancar.
export async function arrancarBanda($: EngineInterface): Promise<void> {
  await update($, sinRaton, () => false)
}

export function registrarBanda(on: On): void {
  on('ui.fault', { element: 'deslizador' }, async ($, e, next) => {
    await update($, sinRaton, () => true)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    pantallaPrincipal = e.viewport?.isFullscreen === false
    const tokens = (await leerContexto($)) ?? (await $.session.usage()).context.tokens ?? 0
    const total = await leerGastados($)
    const rige = await leerEfectivo($)
    const tope = await leerMaximo($)
    const rechazos = await leerRechazos($)
    const medido = await leerUso($)
    const now = await $.clock.now()
    // Con un modelo que tiene su propio límite semanal se enseña ese; con los demás, el de todos.
    // `/usage` los llama «Fable» o «Sonnet only»: cuenta la primera palabra.
    const propios = e.props.maxRows >= 2 ? await leerPorModelo($) : []
    const modelo = propios.length === 0 ? '' : (await $.session.model()).toLowerCase()
    const propio = vigente(
      propios.find(limit => modelo.includes(limit.nombre.toLowerCase().split(' ')[0] ?? limit.nombre)),
      now,
    )
    const limite = e.props.maxRows >= 2 ? (propio ?? vigente(await leerSemana($), now)) : null
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
              rechazos,
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
