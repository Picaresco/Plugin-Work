export type Agente = {
  id: string
  tipo: string
  nombre: string | null
  descripcion: string
  modelo: string
  tarea: number
  inicio: number
  fin: number | null
  estado: 'en curso' | 'ok' | 'abortado' | 'error'
  tokens: number
  esfuerzo: string | null
  hereda: boolean
  // Lo trabajado en tramos ya cerrados y cuándo empezó el último: un retomado no cuenta el hueco.
  ms: number
  desde: number
  // El workflow que lo lanzó, si lo lanzó uno.
  runId: string | null
}

export type Tarea = { n: number; inicio: number; texto: string }

// El modelo y el esfuerzo que se da a un tipo de agente; `heredar` deja lo que el motor decida.
export type Ruta = { modelo: string; esfuerzo: string }

// Un paso del plan: `ms` es lo que lleva en curso ya cerrado y `desde`, cuándo entró en curso la última vez.
export type Paso = {
  id: string
  texto: string
  estado: 'pendiente' | 'en curso' | 'hecho'
  inicio: number | null
  fin: number | null
  ms: number
  desde: number | null
}

// Una compactación de la sesión: lo que medía el contexto antes y después, y dónde quedó su resumen.
export type Compactacion = {
  hora: number
  antes: number | null
  despues: number | null
  fichero: string | null
}

// La caché de la conversación: si se mantiene viva en las pausas, cuánto se ha visto que dura, cuándo
// empezó la última petición que la renovó y lo hecho para mantenerla.
export type Cache = {
  viva: boolean
  ttl: 'sin confirmar' | '1h' | '5m'
  ultima: number | null
  latidos: number
  leido: number
  nota: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'tokens-sesion': {
      gastados: number
      contexto: number | null
      umbral: number
      efectivo: number
      maximo: number
      rechazos: number
      hidratada: boolean
      sinRaton: boolean
      uso: { cpu: number; ram: number } | null
      semana: { pct: number; renueva: string | null } | null
      porModelo: { nombre: string; pct: number; renueva: string | null }[]
      agentes: Shaped<Agente[]>
      retirados: Agente[]
      tareas: Tarea[]
      oculto: boolean
      rutas: Record<string, Ruta>
      tipos: string[]
      pestana: 'agentes' | 'tareas' | 'enrutadores' | 'sesion'
      deAgentes: number
      cincoHoras: { pct: number; renueva: string | null } | null
      compactaciones: Compactacion[]
      nacida: number | null
      historico: string | null
      cache: Cache
      pasos: Paso[]
      pasosRetirados: Paso[]
    }
  }
}
