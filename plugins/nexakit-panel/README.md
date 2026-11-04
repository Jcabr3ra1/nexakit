# nexakit-panel

Panel de la orquestación de una sesión de Claude Code: el modelo líder y su esfuerzo, las consultas al asesor,
los subagentes con su modelo, estado y parte del uso, un registro de la sesión, el contexto, los límites de
5 horas y semanal, y el modelo frente al recomendado por `nexakit-modelo`. Todo sale de lo que informa Claude
Code; no muestra datos inventados.

## Uso

- `/panel` abre el panel junto al chat. Con al menos 104 columnas dibuja el diagrama completo; si no, una lista.
- `/panel-demo` alterna datos de ejemplo, marcados como ficticios, para ver el diseño.
- Para verlo siempre completo, abre `nexakit panel` en otra división de la terminal: lee la foto que este mod
  guarda en `~/.nexakit/panel/` y la dibuja a pantalla completa.

La foto se guarda en tu disco con los secretos evidentes tachados (variables `*TOKEN*`, `*KEY*`, `*SECRET*`,
`*PASSWORD*`, cabeceras `Bearer` y opciones `--password`).

## Pruebas

`claude plugin test plugins/nexakit-panel`
