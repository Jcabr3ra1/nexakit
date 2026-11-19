#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { configurar, servidorDesdeEntorno } from './config.js';
import { enviarReporte } from './envio.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    archivo: { type: 'string', short: 'a' },
    reintentos: { type: 'string' },
  },
});

if (positionals[0] !== 'enviar' || values.archivo === undefined) {
  console.error('Uso: cli.js enviar --archivo <ruta> [--reintentos <n>]');
  process.exit(2);
}

const reintentos = values.reintentos === undefined ? undefined : Number(values.reintentos);
if (reintentos !== undefined && (!Number.isInteger(reintentos) || reintentos < 1)) {
  console.error('--reintentos debe ser un entero mayor que 0');
  process.exit(2);
}

try {
  const config = configurar(reintentos === undefined ? {} : { reintentos });
  await enviarReporte(servidorDesdeEntorno(), await readFile(values.archivo), config);
  console.log('Reporte enviado');
} catch (error) {
  console.error(`No se pudo enviar el reporte: ${error.message}`);
  process.exitCode = 1;
}
