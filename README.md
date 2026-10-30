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
  lenta, y su resumen queda enterrado en el registro de la conversación;
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
el repositorio, `Plugin-Work`. Probado con Claude Code 2.1.314. Con 2.1.300 o posterior
hace falta la versión 0.11.1 del plugin o una más nueva: con las anteriores el panel de agentes
abre una tarea por cada subagente y un agente retomado pierde sus tokens.

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
| `/agentes limpiar` | Vacía el panel de agentes y el plan de tareas; el histórico los conserva |
| `/tokens-compact 850000` | Fija el umbral de compactado; sin argumentos lo muestra y `0` quita el del mod |

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
  el de las compactaciones manuales (`/compact`), y avisa con la ruta. Si no se puede
  escribir, avisa de eso: el resumen sigue en la conversación.

### Cambiar el umbral

- **Con el ratón**: arrastra la marca `┃` de la barra. Mientras la mueves enseña la
  cifra; al soltarla queda guardada y se aplica al momento. Un clic sin mover no cambia nada.
- **Con un comando**: `/tokens-compact 850000`. Sin argumentos muestra el umbral
  actual. `/tokens-compact 0` quita el del mod: el motor sigue compactando, donde lo hace por su
  cuenta, y la marca desaparece.

Los dos comandos del mod se atienden al momento, también con un turno en marcha.

El umbral va de 200.000 a 950.000 tokens (650.000 al instalar) y se guarda para
todas tus sesiones y proyectos.

## El panel

Un panel lateral con cuatro pestañas, que se eligen con los botones de arriba (o con las
teclas `1` a `4` cuando el panel tiene el teclado). Nada se corta a lo ancho: lo que no cabe
sigue en la línea de abajo.

Se abre solo con el primer agente de la sesión si el terminal es ancho (desde 144 columnas) y
la conversación va a pantalla completa: si no, se llevaría un tercio de la altura. Con `/agentes`
se abre siempre. Si lo cierras, no vuelve a abrirse solo hasta que lo pidas, tampoco en las
sesiones siguientes.

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
`sesión:` en la banda. Un agente que se retoma vuelve a «en curso» y sigue sumando en su línea:
su duración no cuenta el tiempo que estuvo parado. Los agentes de un workflow y los que lanza otro
agente van en la tarea de quien los lanzó, aunque hayas escrito otro prompt mientras tanto.

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
Plan         mantenerla hasta 6h56m de pausa; después, compactar
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

Si una parte del mod falla (por ejemplo, no se puede escribir el histórico), las demás siguen
funcionando y el fallo sale al final de esta pestaña, en `Fallos`, hasta que vuelve a ir bien lo
que falló. Si falla algo que acabas de pedir, un botón, un selector o un comando, se avisa al momento.

## Histórico de cada sesión

**Finalidad:** que lo hecho en una sesión no se pierda al cerrarla: qué se hizo, cuánto tardó
y cuánto costó, en un fichero que se puede leer, guardar o pasar a otra persona.

Al acabar cada turno el mod reescribe `.claude/historial/sesion-<fecha UTC>.md` en la raíz donde
empezó la conversación, aunque te muevas a otra carpeta o a un worktree, con:

- duración, turnos, tokens (hilo principal y agentes) y coste;
- el plan de tareas, con la hora de inicio, de fin y la duración de cada paso, y los planes
  anteriores de la conversación;
- todos los agentes de cada tarea, con inicio, fin, duración, tokens, modelo y esfuerzo, también
  los que `/agentes limpiar` quitó del panel;
- las compactaciones, con lo que medía el contexto antes y después y dónde quedó su resumen.

Un fichero por conversación: `/clear` empieza otro. Un agente en segundo plano que sigue
trabajando tras `/clear` continúa en el panel y en el fichero nuevo; en el anterior se queda «en
curso». Solo en sesiones interactivas y solo si hubo tareas, agentes o compactaciones. Si no los
quieres en tu repositorio, añade `**/.claude/historial/` a `.gitignore`.

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
| 500.000 tokens | unas 7 horas de pausa | compacta una vez |
| 100.000 tokens | unas 11 horas (el tope) | la deja caducar |

### Cuándo compensa

- **Sí:** sesiones con mucho contexto que dejas abiertas y a las que vuelves al cabo de unas
  horas (comida, reuniones, una tarde fuera). Con 500.000 tokens, tres horas mantenidas cuestan
  unas 13 veces menos que dejarla caducar.
- **No:** pausas de menos de una hora (la caché no llega a caducar), contexto pequeño (se
  ahorra poco), sesiones a las que no vuelves (lo gastado se pierde) y ausencias de más de un
  día (mejor compactar o cerrar antes de irte).

### Protecciones y límites

- Solo actúa en reposo, en la terminal y con Claude Code abierto: en el escritorio y en VS Code
  el mod no tiene quién mantenga la pausa, y la opción no se ofrece.
- No empieza hasta haber visto que la caché dura una hora (una petición que acierta tras más
  de cinco minutos de pausa). Con caché de cinco minutos no hace nada.
- Si una consulta ya no encuentra la caché, deja de intentarlo y la duración vuelve a «sin
  confirmar»: no sigue pagando pausa tras pausa una caché que puede ser de cinco minutos.
- Si una consulta falla por la API, no dice nada de la caché: la repite a los 3 minutos mientras
  quede plazo. Sin plazo, compacta si tocaba compactar, y si no lo deja dicho en la pestaña.
- Solo compacta donde el motor también lo haría: con el compactado automático apagado en
  `/config`, o con `"idleCompaction": false` en `settings.json`, la mantiene y la deja caducar.
- Al volver a trabajar, la cuenta de la pausa empieza de cero. Si cambias de modelo o compactas,
  no hay nada que mantener hasta la siguiente petición.
- Claude Code compacta por su cuenta una conversación parada desde los 200.000 tokens, a los 54
  minutos. Con la caché viva activada y su plan en marcha, el mod frena esa compactación y decide
  él con la cuenta de arriba; lo demás (tu `/compact`, el compactado por llegar al umbral) sigue
  igual. Con la caché viva desactivada el motor hace lo de siempre: no esperes a la hora de la
  marca en una sesión parada.
- Cada consulta gasta cupo del plan: lee todo el contexto a precio de caché, y lo que escriba
  entra en `Gastado`. Las cuentas usan los precios de la API (leer caché 0,1 veces el precio de entrada; 0,05 en Opus 5.5 y 0,025 en
  Fable 5.1; escribirla, 2 veces); cómo pesa cada cosa en el cupo de una suscripción no es público.
- Compactar pierde detalle, como siempre; el resumen se guarda igual en `.claude/resumenes/`.
- Para decidir, estima que el resumen ocupa unos 15.000 tokens y que el contexto queda en
  unos 45.000 tras compactar.

## Qué toca en tu equipo

- **Una variable de entorno del proceso**, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, solo
  mientras dura la sesión. No modifica `settings.json`.
- **Ficheros de resumen** en `.claude/resumenes/` y **el histórico de cada sesión** en
  `.claude/historial/`, en la raíz del proyecto. Si no los quieres en tu repositorio, añade
  `**/.claude/resumenes/` y `**/.claude/historial/` a `.gitignore`.
- **Una consulta a Claude Code** (`claude -p /usage --safe-mode --no-session-persistence`) al
  arrancar la sesión y, como mucho, cada 5 minutos: de ahí sale el límite semanal propio de cada
  modelo. Tarda unos 3 segundos, no llama al modelo, no carga tus plugins ni servidores MCP y no
  guarda sesión. Si tu plan no tiene límites por modelo, se hace una sola vez; si falla, se vuelve a
  probar a los 5, 15 y 60 minutos, y mientras tanto la línea enseña el límite de todos.
- **Una herramienta y unas líneas de prompt de sistema** para que Claude lleve el plan, solo
  donde no tiene su propia lista de tareas y solo en sesiones interactivas.
- **El modelo y el esfuerzo de los subagentes**, solo de los tipos a los que se lo pongas en
  la pestaña Enrutadores. Con todo en «heredar» (así viene) no cambia nada.
- **Con la caché viva activada** (viene desactivada), una consulta mínima al modelo por hora
  de pausa y, llegado el caso, una compactación.
- **Un `powershell.exe` oculto por sesión** (unos 85 MB) que lee el uso de CPU y RAM
  por WMI. Se cierra con la sesión. No sale nada del equipo: no hay red ni telemetría.

Los ajustes (umbral de compactado, tabla de enrutadores, caché viva y si cerraste el panel) se
guardan en el almacén del plugin y valen para todas tus sesiones y proyectos. Sobreviven a `/clear`.

## Límites

- Los textos están en español.
- La barra está pensada para ventanas de un millón de tokens. Con un modelo de
  200.000 el motor compacta como muy tarde en 167.000 y la marca se queda ahí.
- Si tienes `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, el motor compacta antes: el mod lo
  compensa y la marca no pasa del tope que resulte.
- Por debajo de 200.000 no se puede bajar: con el umbral cerca de lo que ocupa una
  sesión recién compactada, el motor entra en bucle y aborta el turno.
- El punto exacto de compactado sale de las reservas que usa el motor en la versión
  2.1.314. Si una versión posterior las cambia, o si bajas `CLAUDE_CODE_MAX_OUTPUT_TOKENS` de
  20.000, la marca puede desviarse unos miles de tokens.
- El límite de todos los modelos llega con la primera respuesta de cada sesión; el propio de un
  modelo se lee del texto de `/usage` y puede ir hasta 5 minutos por detrás. Si una versión de
  Claude Code cambia ese texto, la línea vuelve a enseñar el de todos los modelos.
- CPU y RAM solo se muestran en Windows y en sesiones interactivas. En macOS y Linux
  el resto de la banda funciona igual.
- El registro de agentes y el plan de tareas duran lo que la sesión; lo que queda después es
  el histórico. Un `claude --resume` empieza un fichero de histórico nuevo, y `Gastado` cuenta
  desde que se retomó, mientras que `Coste API` y `Turnos` traen toda la conversación.
- La pestaña Tareas depende de que Claude lleve un plan: en una pregunta o un cambio de un solo
  paso se queda vacía.

## Desinstalar

```
claude plugin uninstall tokens-sesion@tokens-sesion
claude plugin marketplace remove tokens-sesion
```

## Desarrollo

Es un plugin de *function hooks*. El motor carga un solo módulo, `hooks/register.tsx`: el cuadro
de conexiones. Cada herramienta vive en su fichero de `hooks/herramientas/` con su estado y sus
hooks propios, y lo que comparten está en `hooks/util.ts`.

| Fichero | Qué es |
|---|---|
| `hooks/register.tsx` | Los eventos que comparten varias herramientas; `rehidratar`, que repone lo borrado por `/clear` |
| `hooks/util.ts` | Funciones puras, si hay alguien delante (`esInteractiva`) y los fallos (`aislar`, `aislarAhora`, `leerFallos`) |
| `herramientas/banda.tsx`, `barra.tsx` | La banda sobre el prompt y la barra que recibe el ratón |
| `herramientas/compactado.ts` | El umbral, la ventana del motor y el resumen de cada compactación |
| `herramientas/contador.ts`, `equipo.ts`, `limites.ts` | Tokens de la sesión, CPU y RAM, límites del plan |
| `herramientas/panel.tsx` | El panel: sus pestañas y el comando `/agentes` |
| `herramientas/agentes.tsx`, `tareas.tsx`, `rutas.tsx`, `sesion.tsx` | Una pestaña cada una, y lo que hay detrás |
| `herramientas/cache.ts` | La caché viva |
| `types/index.d.ts` | El contrato de `$.state` |
| `tests/apoyo.ts`, `tests/mundo.test.ts` | El arnés común y el ejemplo del que partir en una herramienta nueva |

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
tsc -p .claude-plugin/types
```

`validate` y `test` no miran los tipos. `tsc` sí, con el `tsconfig.json` que el motor deja en
`.claude-plugin/types/` cuando una sesión interactiva carga el mod con `--plugin-dir` (con `claude -p`
no los deja). Esa carpeta no se versiona, y sus tipos son los de la última carga.

### Añadir una herramienta

1. **Su fichero**: `hooks/herramientas/<nombre>.ts` (`.tsx` si dibuja), con su estado dentro, sus
   hooks en `registrar<Nombre>(on)`, con o sin matcher, y lo que haga al arrancar, como registrar un
   comando, en `arrancar<Nombre>($)`. En `register.tsx` solo van los eventos sin matcher que comparten
   varias herramientas. Los eventos y sus campos están en los tipos del motor: se buscan por su nombre
   (`'tool.call'`) en `.claude-plugin/types/claude-code/index.d.ts`. Con `immediate: true` un comando
   corre aunque haya un turno en marcha; sin él, espera a que acabe.
2. **Enchufarla** en `register.tsx`: impórtala, llama a `registrar<Nombre>(on)` al principio de
   `register` y a `await aislar('<Nombre>', arrancar<Nombre>($))` en `session.start`, detrás de las
   demás y justo antes de `await update($, hidratada, () => true)`. En los eventos que comparte con
   otras, su llamada va dentro de `aislar`, que espera el trabajo sin dejar salir su fallo: sale en la
   pestaña Sesión y la herramienta no se lleva a las demás por delante.
   - Lo que deba seguir tras un `next` sin esperarlo va con `void aislar(...)`.
   - `aislar` recibe una promesa: llama a una `async function`, o lo que lance antes de devolverla
     se le escapa.
   - Un fallo se borra cuando va bien lo que falló, y eso lo dice la clave, que sin tercer argumento
     es el nombre: si una herramienta hace trabajos que fallan por separado, dale a cada uno la suya,
     `aislar('Notas', guardarNota($), 'guardar-nota')`. Lo que pide la persona desde un `onPress` va
     con `aislarAhora($, ...)`, que además avisa al momento.
   - `turn.start`, `turn.step` y `turn.complete` saltan también por cada subagente, con `e.agentId`.
     Lo que sea solo del hilo principal va bajo `e.agentId === undefined`.
3. **Su estado** en el contrato, `types/index.d.ts`, cada valor de `$.state` con su tipo.
4. **Si tiene pestaña**: una fila en `PESTANAS` y su `case` en `dibujarPestana` (los dos en
   `panel.tsx`; sin el `case`, `tsc` da error y la pestaña dice que no tiene dibujo) y su id en
   `pestana`, en el contrato. En la fila, `nombres` es lo que se escribe tras `/agentes` para abrirla
   y `tecla`, su atajo. La pestaña dibuja con una `async function dibujar<Nombre>($, e)` cuyo árbol
   lleva `key="cuerpo"`, y lee de `$.state`: lo de `$.store` no la redibuja. Un comando propio que
   abra el panel va en `registrarPanel` y llama a `responder($, '<nombre>')`: `panel.tsx` ya importa
   la herramienta, y al revés habría un import circular.
5. **Lo que dura y lo que no**. `/clear` y `/resume` no vuelven a lanzar `session.start`: el motor
   borra `$.state` al acabar `session.end` y el proceso sigue, con sus comandos y sus variables de módulo.
   - Lo que sea de la conversación se reinicia con `reiniciar<Nombre>($)` dentro del
     `if (e.reason === 'clear' || e.reason === 'resume')` de `session.end`. Las variables de módulo no
     las borra nadie más, y lo de `$.state` también va ahí: esa escritura redibuja la pestaña abierta.
   - Lo que dure más va a `$.store` (entre sesiones) o a una variable de módulo (entre
     conversaciones) y se carga con `cargar<Nombre>($)` en tres sitios: `session.start`, para la sesión
     nueva, corre una vez por proceso y otra por cada recarga del mod; `rehidratar`, para lo que borra
     `/clear`; y `session.measure`, si lo guardado es común y otra sesión puede cambiarlo.
   - `$.store` es un solo JSON por usuario, común a todas las sesiones, y `get` devuelve `unknown`. Se
     escribe sobre lo guardado, nunca sobre la copia de `$.state`, que tras `/clear` está vacía hasta
     que corre `rehidratar`: lee, valida, cambia, `$.store.set` y luego `update` del atom, como
     `escribirRutas` en `rutas.tsx`. Si el `get` falla no escribas: pisarías lo guardado.
6. **Sus pruebas** en `tests/<nombre>.test.ts`, con `claude plugin test .`. El kit corre tus hooks de
   verdad, pero debajo no hay nada: cada `$.algo` lo responde tu prueba con `on('algo', ...)`, y lo
   que no respondas falla en silencio dentro del `aislar` de quien lo pidió. Empieza copiando
   `tests/mundo.test.ts`: `mundo($, on, guardado)`, de `tests/apoyo.ts`, responde lo que el mod pide
   para arrancar y trae `w.slash`, `w.llamar`, `w.roto` para simular fallos y `w.store`.
   - Las pestañas se leen con `const ui = await panel($)` y `ui.find({ key: 'cuerpo' })`, y sus filas
     con `.children.map(shown)`. Antes de volver a montar el panel, `ui.unmount()`. Un botón se pulsa
     con `ui.press({ key })`, seguido de `w.settle()`.
   - El kit no borra `$.state`: para `/clear`, `const b = conBorrado(on)` al empezar la prueba,
     `await limpiar($, b)` y después `w.clock.advance(REPUESTO_MS)` o `$.turn.start`, para que corra
     `rehidratar`. `conBorrado` no redibuja los paneles montados: monta uno nuevo tras reponer.
   - Para simular un fallo, devuelve `{ deny }`: un hook de prueba que lanza queda *skipped* y el `$`
     falla con `no implementation for ...`, no con tu mensaje.
   - Si tu herramienta lanza procesos, `tokens-sesion.test.ts` cuenta los suyos con `toHaveLength`.
   - Lo que dependa del motor real, como el borrado de `$.state` o el orden de los eventos, se prueba
     con `claude --plugin-dir .` en una sesión de verdad, con un `$.ui.toast` donde quieras ver qué pasa.
7. **Su documentación** en este README: el comando en `Comandos`, la pestaña y cuántas hay en
   `El panel`, y el fichero en la tabla de `Desarrollo`.

Un ejemplo mínimo, con un contador en una pestaña propia:

```tsx
// hooks/herramientas/vueltas.tsx
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderElement, RenderInput } from 'claude-code'

const vueltas = atom({ plugin: 'tokens-sesion', key: 'vueltas' } as const, 0)

export async function contarVuelta($: EngineInterface): Promise<void> {
  await update($, vueltas, n => n + 1)
}

export async function dibujarVueltas(
  $: EngineInterface,
  e: RenderInput<'Pane'>,
): Promise<RenderElement> {
  const { Box, Text } = $.ui.resolve(e)

  return (
    <Box key="cuerpo" flexDirection="column">
      <Text>{`Vueltas: ${await read($, vueltas)}`}</Text>
    </Box>
  )
}

export async function arrancarVueltas($: EngineInterface): Promise<void> {
  await $.command.register({
    name: 'vuelta',
    description: 'Cuenta una vuelta',
    argumentHint: '[nota]',
    immediate: true,
  })
}

export function registrarVueltas(on: On): void {
  on('command.run', { command: 'vuelta' }, async ($, e) => {
    await contarVuelta($)

    return { text: `Vuelta contada (${e.args || 'sin nota'}).` }
  })
}
```

```tsx
// hooks/register.tsx
import { arrancarVueltas, registrarVueltas } from './herramientas/vueltas'
// al principio de register:
registrarVueltas(on)
// en on('session.start'), detrás de las demás y justo antes de marcar `hidratada`:
await aislar('Vueltas', arrancarVueltas($))
```

```ts
// hooks/herramientas/panel.tsx
import { dibujarVueltas } from './vueltas'
// en PESTANAS:
{ id: 'vueltas', titulo: 'Vueltas', tecla: '5', nombres: ['vueltas'] },
// en dibujarPestana:
case 'vueltas':
  return dibujarVueltas($, e)
```

```ts
// types/index.d.ts
vueltas: number
pestana: 'agentes' | 'tareas' | 'enrutadores' | 'sesion' | 'vueltas'
```

`vueltas` no necesita más: su cuenta es de la conversación y vuelve a cero con `/clear`. Si la
pestaña debe verlo al momento con el panel abierto, añade su `reiniciarVueltas($)`, como en el paso 5.

### Las reglas del motor

Comprobadas con Claude Code 2.1.314. Saltarse las primeras no da error de tipos: `claude plugin
validate` o la carga del mod lo rechazan.

| Regla | En la práctica |
|---|---|
| Carga un solo módulo, que sí puede importar | `hooks/hooks.json` nombra `register.tsx` y nada más |
| `$` solo cruza un import hacia una `function` o `async function` declarada y llamada por su nombre | Ni una `const` con flecha, ni una tabla, ni un callback, ni `import *`. Por eso `dibujarPestana` es un `switch` |
| Los `atom` se declaran en el fichero que hace `read` y `update` | Las demás herramientas usan accesores: `leerX($)` |
| Un evento sin matcher se engancha una sola vez en todo el mod | Los compartidos están en `register.tsx`; con matchers distintos puede haber varios |
| `on` sí se puede pasar a una función importada | Por eso cada herramienta tiene `registrar<Nombre>(on)` |
| `$.env.get` y `$.env.set` llevan el nombre literal | Nada de una `const` con el nombre de la variable |
| El contrato no importa nada | `Shaped` se usa dentro de `declare module`, sin `import` |
| `Client` lleva el `module` relativo al fichero que lo dibuja | `module="./barra.tsx"` en `banda.tsx` |
| Un dibujo no escribe `$.state` | Se escribe desde el `onPress` o desde otro evento |
| Un dibujo solo se repite si cambia lo que leyó de `$.state` | Lo de `$.store` se copia a un atom y la pestaña lee el atom. Lo que esté en una variable de módulo pide `$.ui.invalidate('ui.render')` |
| Cada `get` de `$.state` de un mismo evento lee el mismo momento | Tras un `next` lento, una escritura renueva la foto: `update($, valor, v => v)` |
| Un texto con un carácter de control hace que el motor rechace el árbol y cierre el panel | Lo que venga de fuera pasa por `limpio` o `resumir` |
| `$.state` sobrevive a una recarga del mod, y las variables de módulo no; `/clear` es al revés | Si cambia la forma de un valor, `Shaped<T>` y `atom(ref, inicial, { shape })`, y lo que había se migra en `session.start` (`migrarAgentes`) |

## Licencia

MIT. Ver [LICENSE](LICENSE).
