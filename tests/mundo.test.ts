import { expect, test } from 'claude-code/testing'

import { REPUESTO_MS, conBorrado, limpiar, mundo, panel, shown } from './apoyo'

// El punto de partida de las pruebas de una herramienta nueva: `mundo`, un comando y lo que se dibuja.

test('sobre el mundo mínimo el mod arranca sin fallos y cada pestaña se dibuja', async ($, on) => {
  const w = mundo($, on)
  await w.start()
  await w.settle()
  expect(w.comandos.map(comando => comando.name)).toContain('agentes')

  for (const destino of ['tareas', 'rutas', 'sesion', 'agentes']) {
    await w.slash('agentes', destino)
    const ui = await panel($)
    expect(await ui.find({ key: 'cuerpo' })).toBeDefined()
    await ui.unmount()
  }

  await w.slash('agentes', 'sesion')
  const ui = await panel($)
  const texto = ((await ui.find({ key: 'cuerpo' }))?.children ?? []).map(shown)
  await ui.unmount()
  expect(texto).toContain('Sesión')
  expect(texto).not.toContain('Fallos')
})

test('sobre el mundo mínimo, /clear borra la conversación y lo guardado vuelve', async ($, on) => {
  const b = conBorrado(on)
  const w = mundo($, on, { umbral: 700_000 })
  await w.start()
  await limpiar($, b)
  await w.clock.advance(REPUESTO_MS)
  expect((await w.slash('tokens-compact')).text).toContain('700.000')
})

test('sobre el mundo mínimo, `roto` simula lo que falla debajo del mod', async ($, on) => {
  const w = mundo($, on)
  await w.start()
  w.roto.escritura = true
  const dicho = await w.slash('agentes', 'cache si')
  expect(dicho.text).toContain('store.set: lock')
})
