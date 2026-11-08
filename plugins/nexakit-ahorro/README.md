# nexakit-ahorro

Cada línea que devuelve un comando entra al contexto y se vuelve a pagar en todos los turnos siguientes. Este
mod recorta la salida de Bash que pasa de 120 líneas o 12 000 caracteres: conserva las 20 primeras, las 40
últimas y hasta 40 líneas con señales de fallo (`error`, `fail`, `not ok`, `✖`…), quita los códigos de color y
acorta las líneas gigantes. La salida completa queda en `~/.nexakit/salidas/` y el aviso dice la ruta.

Para ver una salida entera, pon `NEXAKIT_SALIDA=completa` delante del comando. Los comandos en segundo plano y
las imágenes no se tocan.

## Pruebas

`node --test test/ahorro-salida.test.js` desde la raíz del repositorio.
