import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const RAIZ = path.resolve('subidas');
const PERMITIDOS = new Set(['condiciones.pdf', 'tarifas.pdf']);

export const servidor = http.createServer(async (req, res) => {
  const nombre = new URL(req.url, 'http://localhost').pathname.replace(/^\/archivos\//, '');
  if (req.method !== 'GET' || !PERMITIDOS.has(nombre)) {
    res.writeHead(404).end('No encontrado');
    return;
  }
  const contenido = await readFile(path.join(RAIZ, nombre));
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-disposition': 'attachment',
    'x-content-type-options': 'nosniff',
  });
  res.end(contenido);
});
