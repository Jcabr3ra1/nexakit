# nexakit-sesion

Muestra en la línea de estado de Claude Code cuánto contexto llevas y tus límites de uso de 5 horas y semanal,
por ejemplo `contexto 42 % · 5 h 14 % · semana 79 %`. Al pasar del 60 % y del 80 % de contexto avisa una vez de
que es buen momento para escribir el traspaso y abrir una sesión nueva. Solo avisa: nunca cierra la sesión.

Los datos salen de Claude Code (`$.session.usage()`); los límites se mueven en puntos enteros y solo cuando una
respuesta de la API informa un valor nuevo.

## Pruebas

`claude plugin test plugins/nexakit-sesion`
