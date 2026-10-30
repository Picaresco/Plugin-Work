import type { ClientModule } from 'claude-code'

// Lo que el mod le da a la barra: sus celdas sin la marca, dónde está la marca (-1 sin compactado),
// entre qué celdas se puede dejar, el umbral que corresponde a cada una, en número y en texto, y
// cuántas veces no pudo guardar uno.
type Props = {
  celdas: { text: string; color: string }[]
  marca: number
  desde: number
  hasta: number
  valores: number[]
  textos: string[]
  color: string
  rechazos: number
}

// `drag`: la celda de la marca mientras se arrastra; `origen`: donde se agarró. `fijada`: la celda donde
// se soltó, que vale hasta que el mod devuelve props nuevas (`sobre` y `rechazos` son los que traían las
// de entonces: si el mod no pudo guardarlo, la marca vuelve a donde estaba).
type State = { drag?: number; origen?: number; fijada?: number; sobre?: number; rechazos?: number }

const Barra: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const state = surface.state ?? {}
  const eco =
    state.fijada !== undefined &&
    state.sobre === props.marca &&
    state.rechazos === props.rechazos

  // Llegaron props nuevas: el eco de lo soltado ya no vale, ni aunque la marca vuelva a donde estaba.
  if (state.fijada !== undefined && !eco) {
    surface.setState({ drag: state.drag, origen: state.origen })
  }

  const quieta = eco ? (state.fijada as number) : props.marca
  const marca = state.drag ?? quieta
  const acotar = (x: number): number => Math.max(props.desde, Math.min(props.hasta, x))

  surface.onPointer(event => {
    // El estado de ahora, no el del último dibujo: pueden llegar dos eventos entre dos dibujos.
    const ahora = surface.state ?? {}

    if (event.type === 'down') {
      // Solo se agarra la marca: un clic en otro punto de la barra no cambia nada. Con un arrastre
      // vivo es que su `up` se perdió: ese arrastre no cuenta.
      if (event.button === 'left' && quieta >= 0 && Math.abs(event.x - quieta) <= 1) {
        surface.setState({ ...ahora, drag: acotar(event.x), origen: acotar(event.x) })
      } else if (ahora.drag !== undefined) {
        surface.setState({})
      }
    } else if (ahora.drag === undefined) {
      return
    } else if (event.type === 'move' && event.button !== undefined) {
      surface.setState({ ...ahora, drag: acotar(event.x) })
    } else if (event.type === 'up') {
      // Vale la última celda enseñada: un `up` que el terminal no informó trae la x de otro sitio.
      const celda = ahora.drag
      const umbral = props.valores[celda]

      if (celda === ahora.origen || celda === quieta || umbral === undefined) {
        surface.setState({})

        return
      }

      surface.post({ umbral })
      surface.setState({ fijada: celda, sobre: props.marca, rechazos: props.rechazos })
    }
  })

  // Al arrastrar, la cifra va a la derecha de la marca, o a su izquierda si no cabe.
  const cifra = state.drag === undefined ? '' : ` ${props.textos[marca] ?? ''} `
  const inicio = Math.max(
    0,
    marca + 1 + cifra.length <= props.celdas.length ? marca + 1 : marca - cifra.length,
  )

  return (
    <Box>
      {props.celdas.map((celda, i) => {
        // En reposo el punto actual tapa la marca; al arrastrar, la marca va por delante.
        if (i >= inicio && i < inicio + cifra.length) {
          return <Text inverse>{cifra[i - inicio]}</Text>
        }

        if (i === marca && (state.drag !== undefined || celda.text !== '●')) {
          return <Text color={props.color}>┃</Text>
        }

        return <Text color={celda.color}>{celda.text}</Text>
      })}
    </Box>
  )
}

export default Barra
