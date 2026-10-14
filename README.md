# Plugin-Work — mod de Claude Code

https://github.com/user-attachments/assets/3bc9c9c4-c277-43f5-998e-c929266490b7

Un plugin para **ver y controlar lo que pasa en una sesión larga de Claude Code**: cuánto
contexto llevas, cuánto gastas, qué hacen los subagentes, por dónde va el plan de trabajo y
qué queda registrado cuando la sesión se cierra.

```
Contexto: 222.807 tokens ████████●░░░░░░░░░░░░░░░░░┃░░░░░░░░░░░░░ · sesión: 2.431.870 · CPU 23% · RAM 61%
Semana:   80% usado      ████████████████████████████████░░░░░░░░ · se renueva vie 9, 22:00
```

```
[ Agentes ]  [ Tareas ]  [ Enrutadores ]  [ Sesión ]
────────────────────────────────────────────────
█████████████░░░░░░░ 2/3 · 16m10s
✓ 2 hechas · ● 1 en curso · ○ 0 pendientes
```

## Para qué sirve

Claude Code trabaja con una ventana de un millón de tokens, subagentes en paralelo y sesiones
que duran horas. Casi nada de eso se ve mientras ocurre:

- el contexto crece sin que se note, y cada petición lo vuelve a enviar entero;
- el compactado automático salta casi al final de la ventana, cuando la sesión ya es cara y
  lenta, y su resumen no se guarda en ningún sitio;
- los subagentes arrancan y terminan sin dejar rastro de cuánto tardaron ni cuánto gastaron,
  y todos usan el modelo de la sesión aunque la tarea sea trivial;
- no hay forma de ver de un vistazo qué pasos del trabajo están hechos y cuáles faltan;
- al cerrar la sesión, lo que se hizo, cuánto costó y cuánto tardó se pierde;
- tras una pausa larga, el primer mensaje reescribe toda la caché y es el más caro de la sesión.

Este plugin pone todo eso a la vista y deja decidir sobre ello:

| Pieza | Qué hace | Para qué |
|---|---|---|
| **Banda sobre el prompt** | Contexto, gasto de la sesión, CPU y RAM, límite semanal | Saber en todo momento cuánto llevas y cuánto te queda |
| **Compactado a medida** | La sesión se compacta donde tú marques y guarda el resumen | No llegar al final de la ventana y no perder el resumen |
| **Pestaña Agentes** | Registro de cada subagente: inicio, fin, duración, tokens | Saber qué se lanzó, cuánto tardó y cuánto costó |
| **Pestaña Tareas** | El plan paso a paso, con colores por estado y tiempos | Seguir el avance del trabajo sin preguntar |
| **Pestaña Enrutadores** | Modelo y esfuerzo por tipo de agente | Gastar menos en tareas simples y más en las difíciles |
| **Pestaña Sesión** | Resumen: duración, turnos, tokens, coste, límites, caché | Tener la foto completa de la sesión |
| **Histórico** | Un fichero por sesión con todo lo anterior | Que lo hecho no se pierda al cerrar |
| **Caché viva** (opcional) | Mantiene la caché en las pausas mientras sea lo más barato | No pagar una reescritura completa al volver |

## Instalación

En el prompt de una sesión de Claude Code en el terminal:

```
/plugin install tokens-sesion --marketplace Picaresco/Plugin-Work
```

Responde `y` para añadir el marketplace y elige el ámbito (el de usuario lo deja
activo en todos tus proyectos). No hace falta reiniciar.

Desde la línea de comandos, lo mismo en dos pasos:

```
claude plugin marketplace add Picaresco/Plugin-Work
claude plugin install tokens-sesion@tokens-sesion
```

El plugin se llama `tokens-sesion` (el nombre con el que nació, cuando solo era la banda);
el repositorio, `Plugin-Work`. Probado con Claude Code 2.1.300. Con 2.1.300 o posterior
hace falta la versión 0.11.1 del plugin: con las anteriores el panel de agentes abre una
tarea por cada subagente y un agente retomado pierde sus tokens.

### Si ya lo tenías instalado

No hay que desinstalar nada: es una actualización.

```
claude plugin marketplace update tokens-sesion
claude plugin update tokens-sesion@tokens-sesion
```

Después, `/reload-plugins` en la sesión abierta. Si al seguir la orden de instalación sale
«Cannot add marketplace "tokens-sesion": its source doesn't match…», es que ya tenías el
marketplace con la dirección antigua del repositorio (`Picaresco/tokens-sesion`, que sigue
funcionando): cancela y usa las dos órdenes de arriba.

## Comandos

| Comando | Qué hace |
|---|---|
| `/agentes` | Abre el panel, en la pestaña en la que estaba |
| `/agentes tareas` · `/agentes rutas` · `/agentes sesion` | Abre el panel en esa pestaña |
| `/agentes cache si` · `/agentes cache no` | Activa o desactiva la caché viva |
| `/agentes cerrar` | Cierra el panel (el registro sigue) |
| `/agentes limpiar` | Vacía el registro de agentes y el plan de tareas |
| `/tokens-compact 850000` | Fija el umbral de compactado; sin argumentos lo muestra y `0` lo desactiva |

## La banda sobre el prompt

**Finalidad:** tener siempre delante cuánto ocupa la conversación y cuánto llevas gastado,
sin tener que pedirlo.

| Parte | Qué es |
|---|---|
| `Contexto: N tokens` | Lo que ocupa ahora la conversación: lo que se envía al modelo en cada petición. Verde hasta 500.000, lima hasta 650.000, amarillo hasta 800.000, naranja hasta 950.000 y rojo por encima |
| Barra | De 0 a 1.000.000 de tokens, con los mismos colores. `●` es el punto actual y `┃` el umbral en el que se compacta |
| `sesión: N` | Gasto acumulado de la sesión: entrada, salida y escritura de caché, subagentes incluidos. La caché leída no cuenta |
| `CPU n% · RAM n%` | Uso de todo el equipo: media de las 5 últimas lecturas, una cada 12 segundos. Verde hasta 60 %, amarillo hasta 85 %, rojo por encima. Solo en Windows |
| `Semana: n% usado` | Segunda línea: el límite semanal de tu plan, con su barra bajo la de contexto y cuándo se renueva, en la hora de tu equipo. Mismos colores que CPU y RAM. Si el modelo que estás usando tiene un límite semanal propio (como Fable), enseña ese, con su nombre: `Semana Fable: n% usado`; con los demás modelos, el de todos. Solo en planes de suscripción |

En terminales estrechos las barras se encogen.

## Compactado automático a medida

**Finalidad:** que la sesión se compacte donde tú decidas, no casi al final de la ventana, y
que el resumen de cada compactación quede guardado.

Al llegar el contexto al umbral, el motor de Claude Code compacta la conversación y
**sigue con lo que estaba haciendo**: no espera a que termine el turno, así que
también actúa en tareas largas y con subagentes. El mod:

- le indica al motor dónde compactar (el umbral que hayas elegido),
- añade a cada compactación la instrucción de conservar peticiones, decisiones,
  ficheros tocados, errores resueltos y tareas pendientes,
- guarda el resumen en `<proyecto>/.claude/resumenes/resumen-<fecha UTC>.md`, también
  el de las compactaciones manuales (`/compact`), y avisa con la ruta.

### Cambiar el umbral

- **Con el ratón**: arrastra la marca `┃` de la barra. Mientras la mueves enseña la
  cifra; al soltarla queda guardada y se aplica al momento.
- **Con un comando**: `/tokens-compact 850000`. Sin argumentos muestra el umbral
  actual y `/tokens-compact 0` lo desactiva: el motor vuelve a compactar donde lo hace por su cuenta.

El umbral va de 200.000 a 950.000 tokens (650.000 al instalar) y se guarda para
todas tus sesiones y proyectos.

## El panel

Un panel lateral con cuatro pestañas, que se eligen con los botones de arriba (o con las
teclas `1` a `4` cuando el panel tiene el teclado). Nada se corta a lo ancho: lo que no cabe
sigue en la línea de abajo.

Se abre solo con el primer agente de la sesión si el terminal es ancho (desde 144 columnas);
con `/agentes` se abre a cualquier ancho. Si lo cierras, no vuelve a abrirse solo hasta que
lo pidas.

### Pestaña Agentes

**Finalidad:** saber qué subagentes se lanzaron en cada encargo, cuánto tardaron y cuánto
gastaron, mientras ocurre.

```
[ Agentes ]  [ Tareas ]  [ Enrutadores ]  [ Sesión ]
────────────────────────────────────────────────
Tarea 3 · 12:30:58 · 2 agentes · 21.520 tok
busca los hooks del mod y revisa los tests
✓ 12:31:05 → 12:32:47    1m42s    18.420 tok
  Explore · buscar hooks · haiku-5-5 · low
● 12:31:06 → en curso              3.100 tok
  revisor (general-purpose) · revisar tests · opus-5-5
```

Los subagentes van agrupados por tarea (cada prompt tuyo que lanza alguno), la más reciente
arriba: hora de inicio, hora de fin, duración y tokens, que suben en vivo, con el total de la
tarea. Debajo de cada uno, su tipo, el encargo, el modelo con el que corrió y el esfuerzo.
`●` en curso, `✓` terminado, `✗` abortado o con error. Los tokens se cuentan igual que
`sesión:` en la banda. Un agente que se retoma vuelve a «en curso» y sigue sumando en su línea.

### Pestaña Tareas

**Finalidad:** ver de un vistazo qué pasos del trabajo están hechos, cuál está en curso y
cuáles quedan, y cuánto tardó cada uno.

```
[ Agentes ]  [ Tareas ]  [ Enrutadores ]  [ Sesión ]
────────────────────────────────────────────────
█████████████░░░░░░░ 2/3 · 16m10s
✓ 2 hechas · ● 1 en curso · ○ 0 pendientes

✓ Leer el código
  12:31 → 12:33   2m05s
✓ Escribir la pestaña
  12:33 → 12:47  14m05s
● Probar en una sesión real
  12:47 → en curso
```

Verde y tachado lo hecho, amarillo y en negrita lo que está en curso, gris lo pendiente.
El tiempo de un paso es el que pasa «en curso»: si vuelve a pendiente y se retoma, se
suma. Arriba, la barra de avance y el tiempo total.

Los pasos salen de la lista de tareas de Claude Code (`TodoWrite`, o `TaskCreate` y
`TaskUpdate`). Donde el modelo no tiene esa lista, el mod le da una herramienta propia
(`plan`) y le pide en el prompt de sistema que la use en trabajos de tres pasos o más:
son unas líneas más de prompt y una llamada corta por cada cambio de estado. Solo en
sesiones interactivas, y solo cuenta el plan del hilo principal, no el de los subagentes.

### Pestaña Enrutadores

**Finalidad:** que cada tipo de subagente use el modelo y el esfuerzo que le corresponde, en
lugar de heredar siempre los de la sesión. Buscar ficheros no necesita el mismo modelo que
revisar un cambio delicado.

Una tabla con una fila por tipo de agente (los de Claude Code, los de tus plugins y los tuyos)
y otra para «Los demás». En cada fila eliges el **modelo** (heredar, haiku, sonnet, opus,
fable) y el **esfuerzo** (heredar, low, medium, high, xhigh, max) con el que arrancan los
agentes de ese tipo. `[ Recomendados ]` pone una tabla de partida y `[ Todo heredar ]` lo deja
como si no hubiera enrutado. Se aplica al momento y se guarda para todas tus sesiones y
proyectos. Al pie, los tokens gastados por modelo en la sesión.

- El modelo es un alias: lo resuelve Claude Code a su versión actual.
- La tabla manda sobre el modelo que pida la llamada. Para una excepción, pon esa fila
  en «heredar».
- Un fork y los agentes de un workflow heredan siempre: el fork no se puede cambiar y los de
  un workflow usan el modelo que les da su script.
- El esfuerzo solo se cambia en los modelos que lo admiten.

### Pestaña Sesión

**Finalidad:** la foto completa de la sesión en una pantalla.

```
Sesión
Empezó       2026-10-10 12:26 · hace 1h48m
Modelo       opus-5-5
Turnos       23

Tokens
Contexto     222.807 · se compacta a los 650.000
Gastado      2.431.870
  principal  2.300.000 (95 %)
  agentes    131.870 (5 %)
Coste API    18.40 $

Límites del plan
5 horas      34 % usado · se renueva sáb 10, 17:00
Semana       80 % usado · se renueva vie 16, 22:00

Caché
Duración     1 hora
Caduca       a las 15:14
Plan         mantenerla hasta 11 h de pausa; después, compactar
Mantenerla   [ sí ]

Trabajo
Tareas       7 de 9 hechas
Agentes      4 · 1 en curso

1 compactación
12:40:11     650.000 → 40.000
             .claude/resumenes/resumen-2026-10-10-10-40-11.md

Histórico
.claude/historial/sesion-2026-10-10-10-26-03.md
```

«Coste API» es lo que dice Claude Code que costarían las respuestas de la sesión a precio de
API: con un plan de suscripción es una equivalencia, no lo que pagas. Los límites solo
aparecen en planes de suscripción, tras la primera respuesta.

## Histórico de cada sesión

**Finalidad:** que lo hecho en una sesión no se pierda al cerrarla: qué se hizo, cuánto tardó
y cuánto costó, en un fichero que se puede leer, guardar o pasar a otra persona.

Al acabar cada turno el mod reescribe `.claude/historial/sesion-<fecha UTC>.md` en el
proyecto, con:

- duración, turnos, tokens (hilo principal y agentes) y coste;
- el plan de tareas, con la hora de inicio, de fin y la duración de cada paso;
- los agentes de cada tarea, con inicio, fin, duración, tokens, modelo y esfuerzo;
- las compactaciones, con lo que medía el contexto antes y después y dónde quedó su resumen.

Un fichero por conversación: `/clear` empieza otro. Solo en sesiones interactivas y solo si
hubo tareas, agentes o compactaciones. Si no los quieres en tu repositorio, añade
`.claude/historial/` a `.gitignore`.

## Caché viva en las pausas (opcional, desactivada de fábrica)

**Finalidad:** no pagar una reescritura completa de la caché al volver de una pausa, y que la
elección entre mantenerla, compactar o dejarla caducar la haga el plugin según lo que salga
más barato.

### El problema

Claude Code guarda en caché la conversación ya enviada. Mientras la caché dura, cada petición
la relee casi gratis; si caduca (una hora sin peticiones, o cinco minutos según el plan), la
siguiente la reescribe entera a precio de escritura. Con mucho contexto, el primer mensaje
tras una pausa larga es el más caro de la sesión. La caché no ahorra contexto: ahorra coste.

### Qué hace

Se activa con un clic en `Mantenerla` en la pestaña Sesión, o con `/agentes cache si`. Con la
sesión en reposo, el mod elige solo:

1. **Mantenerla.** Poco antes de que caduque hace una consulta mínima sobre la propia
   conversación, que lee la caché y renueva su plazo. No deja nada en la conversación.
2. **Compactar o dejarla caducar.** Cuando lo gastado en mantenerla iguala lo que costaría
   compactar (con mucho contexto) o dejarla caducar (con poco), hace esa otra cosa y para.

Es la regla del alquiler: se paga el «alquiler» (una consulta por hora) hasta que lo pagado
iguala el precio de «comprar»; entonces se compra. Así, en una sesión a la que no vuelves se
pierde, como mucho, lo que habría costado una caducidad. Nunca hace más de 12 consultas por
pausa.

| Contexto (Opus 5.5) | Mantiene hasta | Después |
|---|---|---|
| 500.000 tokens | unas 11 horas de pausa | compacta una vez |
| 100.000 tokens | 12 horas (el tope) | la deja caducar |

### Cuándo compensa

- **Sí:** sesiones con mucho contexto que dejas abiertas y a las que vuelves al cabo de unas
  horas (comida, reuniones, una tarde fuera). Con 500.000 tokens, tres horas mantenidas cuestan
  unas 13 veces menos que dejarla caducar.
- **No:** pausas de menos de una hora (la caché no llega a caducar), contexto pequeño (se
  ahorra poco), sesiones a las que no vuelves (lo gastado se pierde) y ausencias de más de un
  día (mejor compactar o cerrar antes de irte).

### Protecciones y límites

- Solo actúa en reposo, en sesiones interactivas y con Claude Code abierto.
- No empieza hasta haber visto que la caché dura una hora (una petición que acierta tras más
  de cinco minutos de pausa). Con caché de cinco minutos no hace nada.
- Si una consulta ya no encuentra la caché, deja de intentarlo en esa pausa.
- Al volver a trabajar, la cuenta de la pausa empieza de cero.
- Cada consulta gasta cupo del plan: lee todo el contexto a precio de caché. Las cuentas usan
  los precios de la API (leer caché 0,1 veces el precio de entrada; 0,05 en Opus 5.5 y 0,025 en
  Fable 5.1; escribirla, 2 veces); cómo pesa cada cosa en el cupo de una suscripción no es público.
- Compactar pierde detalle, como siempre; el resumen se guarda igual en `.claude/resumenes/`.
- Para decidir, estima que el resumen ocupa unos 15.000 tokens y que el contexto queda en
  unos 45.000 tras compactar.

## Qué toca en tu equipo

- **Una variable de entorno del proceso**, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, solo
  mientras dura la sesión. No modifica `settings.json`.
- **Ficheros de resumen** en `.claude/resumenes/` y **el histórico de cada sesión** en
  `.claude/historial/`, dentro del proyecto. Si no los quieres en tu repositorio, añade esas
  carpetas a `.gitignore`.
- **Una consulta a Claude Code** (`claude -p /usage --safe-mode --no-session-persistence`) al
  arrancar la sesión y, como mucho, cada 5 minutos: de ahí sale el límite semanal propio de cada
  modelo. Tarda unos 3 segundos, no llama al modelo, no carga tus plugins ni servidores MCP y no
  guarda sesión. Si tu plan no tiene límites por modelo, se hace una sola vez.
- **Una herramienta y unas líneas de prompt de sistema** para que Claude lleve el plan, solo
  donde no tiene su propia lista de tareas y solo en sesiones interactivas.
- **El modelo y el esfuerzo de los subagentes**, solo de los tipos a los que se lo pongas en
  la pestaña Enrutadores. Con todo en «heredar» (así viene) no cambia nada.
- **Con la caché viva activada** (viene desactivada), una consulta mínima al modelo por hora
  de pausa y, llegado el caso, una compactación.
- **Un `powershell.exe` oculto por sesión** (unos 85 MB) que lee el uso de CPU y RAM
  por WMI. Se cierra con la sesión. No sale nada del equipo: no hay red ni telemetría.

Los ajustes (umbral de compactado, tabla de enrutadores, caché viva) se guardan en el almacén
del plugin y valen para todas tus sesiones y proyectos.

## Límites

- Los textos están en español.
- La barra está pensada para ventanas de un millón de tokens. Con un modelo de
  200.000 el motor compacta como muy tarde en 167.000 y la marca se queda ahí.
- Si tienes `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, el motor compacta antes: el mod lo
  compensa y la marca no pasa del tope que resulte.
- Por debajo de 200.000 no se puede bajar: con el umbral cerca de lo que ocupa una
  sesión recién compactada, el motor entra en bucle y aborta el turno.
- El punto exacto de compactado sale de las reservas que usa el motor en la versión
  2.1.293. Si una versión posterior las cambia, la marca puede desviarse unos miles
  de tokens.
- El límite de todos los modelos llega con la primera respuesta de cada sesión; el propio de un
  modelo se lee del texto de `/usage` y puede ir hasta 5 minutos por detrás. Si una versión de
  Claude Code cambia ese texto, la línea vuelve a enseñar el de todos los modelos.
- CPU y RAM solo se muestran en Windows y en sesiones interactivas. En macOS y Linux
  el resto de la banda funciona igual.
- El registro de agentes y el plan de tareas duran lo que la sesión; lo que queda después es
  el histórico.
- La pestaña Tareas depende de que Claude lleve un plan: en una pregunta o un cambio de un solo
  paso se queda vacía.

## Desinstalar

```
claude plugin uninstall tokens-sesion@tokens-sesion
claude plugin marketplace remove tokens-sesion
```

## Desarrollo

Es un plugin de *function hooks*: `hooks/register.tsx` es el módulo (la banda y el panel:
Claude Code carga un solo módulo por plugin), `hooks/barra.tsx` la barra que recibe el ratón y
`types/index.d.ts` el contrato de su estado. Las pruebas están en `tests/`.

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## Licencia

MIT. Ver [LICENSE](LICENSE).
