# nexakit-ahorro

Cada línea que devuelve un comando entra al contexto y se vuelve a pagar en todos los turnos siguientes. Este
mod recorta la salida de Bash que pasa de 120 líneas o 12 000 caracteres: conserva las 20 primeras, las 40
últimas y hasta 40 líneas con señales de fallo (`error`, `fail`, `not ok`, `✖`…), quita los códigos de color y
acorta las líneas gigantes. La salida completa queda en `~/.nexakit/salidas/` y el aviso dice la ruta.

Para ver una salida entera, pon `NEXAKIT_SALIDA=completa` delante del comando. Los comandos en segundo plano y
las imágenes no se tocan.

Cada recorte añade una línea con cifras (fecha, caracteres y líneas antes y después; nunca el contenido ni el
comando) a `~/.nexakit/ahorro.jsonl`, donde se conservan 90 días (y como máximo 5000 líneas). `nexakit ahorro` resume cuántos recortes hubo y cuánto se evitó.

## Por qué solo Bash

- Las búsquedas (`grep`, `rg`, `find`) pasan por Bash, así que ya se recortan.
- `Read` no se recorta: Claude Code ya rechaza los archivos demasiado grandes salvo que se pida `allow_large`,
  y se leen por tramos con `offset` y `limit`. Recortar una lectura haría que el modelo editara un archivo que
  no ha visto entero.
- `WebFetch` ya devuelve un resumen hecho por un modelo pequeño, no la página entera.

## Pruebas

`node --test test/ahorro-salida.test.js` desde la raíz del repositorio.
