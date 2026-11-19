# Cliente de reportes

Envía reportes al servidor central.

## Uso

```sh
REPORTES_URL=https://reportes.example.com node src/cli.js enviar --archivo informe.json
```

- `--archivo`, `-a`: ruta del reporte que se envía (obligatoria).
- `--reintentos <n>`: intentos antes de rendirse; sustituye al valor por defecto.

La variable de entorno `REPORTES_URL` indica la URL del servidor. El reporte se comprime con gzip antes de enviarlo.

Si el envío falla, la orden termina con el código de salida 1.

## Configuración

| Opción | Valor por defecto | Descripción |
| --- | --- | --- |
| `reintentos` | 3 | Intentos antes de rendirse |
| `tiempoEsperaMs` | 30000 | Tiempo máximo por intento |
