import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage } from 'claude-code'

import { enviado, gasto } from '../util'

// Los tokens de la sesión: lo gastado, lo que de ello fue de los agentes y lo que ocupa el contexto.
const gastados = atom({ plugin: 'tokens-sesion', key: 'gastados' } as const, 0)
const contexto = atom({ plugin: 'tokens-sesion', key: 'contexto' } as const, null)
// Lo gastado por los agentes de la sesión; el resto de `gastados` es del hilo principal.
const deAgentes = atom({ plugin: 'tokens-sesion', key: 'deAgentes' } as const, 0)

export async function leerGastados($: EngineInterface): Promise<number> {
  return read($, gastados)
}

export async function leerDeAgentes($: EngineInterface): Promise<number> {
  return read($, deAgentes)
}

export async function leerContexto($: EngineInterface): Promise<number | null> {
  return read($, contexto)
}

export async function fijarContexto($: EngineInterface, tokens: number | null): Promise<void> {
  await update($, contexto, () => tokens)
}

// Suma una respuesta del modelo; la del hilo principal dice además lo que ocupa el contexto.
export async function sumarPaso(
  $: EngineInterface,
  agentId: string | undefined,
  usage: ModelUsage,
): Promise<void> {
  const spent = gasto(usage)
  await update($, gastados, total => total + spent)

  if (agentId !== undefined) {
    await update($, deAgentes, total => total + spent)

    return
  }

  const tokens = enviado(usage)
  await update($, contexto, () => tokens)
}

// Lo que costó una compactación: no pasa por las peticiones que ve el mod.
export async function sumarCompactacion(
  $: EngineInterface,
  agentId: string | undefined,
  usage: ModelUsage,
): Promise<void> {
  const spent = gasto(usage)
  await update($, gastados, total => total + spent)

  if (agentId !== undefined) {
    await update($, deAgentes, total => total + spent)
  }
}

export async function reiniciarContador($: EngineInterface): Promise<void> {
  await update($, gastados, () => 0)
  await update($, deAgentes, () => 0)
  await update($, contexto, () => null)
}
