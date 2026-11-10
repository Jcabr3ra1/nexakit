# nexakit-lecciones

Repetir lo que ya falló, o lo que la persona ya corrigió, gasta tokens dos veces. Este mod:

- **Frena el comando que acaba de fallar igual.** Si un comando de Bash falla y se intenta otra vez sin que nada
  haya cambiado (ninguna edición ni otro comando que saliera bien), no se ejecuta: el modelo recibe el error
  anterior y tiene que cambiar de enfoque. `NEXAKIT_REPETIR=1` delante del comando lo permite a propósito.
  Cada subagente lleva su propio historial.
- **Pide parar ante el error repetido.** Al tercer error del mismo tipo en una sesión (se ignoran números, rutas y
  textos entre comillas), el modelo recibe una nota para explicar la causa raíz antes de otro intento.
- **Convierte tus correcciones en lecciones.** Si tu mensaje suena a corrección («te dije», «ya te había dicho»,
  «otra vez lo mismo», «háblame en…», «deja de…», «no vuelvas a…»), el modelo recibe una nota para guardar la
  lección en su memoria persistente (tipo feedback) y aplicarla. Si no era una corrección, la ignora.

- **Apunta lo que pasa, sin depender de que Claude se acuerde.** Cada corrección (tu frase, de 200 caracteres como
  máximo, y nada si parece llevar un secreto), cada comando frenado, cada error repetido tres veces y cada vez que
  Claude escribe en su memoria persistente quedan en `~/.nexakit/lecciones.jsonl` (solo los últimos 90 días y 500
  eventos). Cada nota escrita en la memoria resuelve una corrección, la más reciente
  sin resolver; el índice `MEMORY.md` no cuenta.
- **Recuerda lo que quedó sin guardar.** Al primer mensaje de una sesión, si de sesiones anteriores quedaron
  correcciones sin guardar, Claude recibe una nota con las últimas tres. Se recuerda una sola vez.
- **`nexakit lecciones`** resume el registro: correcciones, lecciones guardadas, errores frenados y repetidos, y las
  que siguen pendientes. Sirve para ver si el mod ayuda. `nexakit lecciones --descartar` da por resueltas las
  pendientes que no eran correcciones o ya no valen, sin borrar el historial.

La detección es local y no llama a ningún modelo. Al compactar, `nexakit-sesion` pide conservar las correcciones.

## Pruebas

`node --test test/lecciones.test.js` desde la raíz del repositorio.
