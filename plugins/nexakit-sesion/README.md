# nexakit-sesion

Al pasar del 60 % y del 80 % de contexto avisa una vez de que es buen momento para escribir el traspaso y abrir
una sesión nueva. Solo avisa: nunca cierra la sesión. El contexto y los límites de 5 horas y semanal se ven en la
barra de `nexakit-modelo`, con los mismos umbrales de color.

Los datos salen de Claude Code (`$.session.usage()`); los límites se mueven en puntos enteros y solo cuando una
respuesta de la API informa un valor nuevo.

## Pruebas

`claude plugin test plugins/nexakit-sesion`
