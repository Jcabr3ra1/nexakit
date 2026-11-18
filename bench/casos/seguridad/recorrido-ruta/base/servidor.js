import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const RAIZ = path.resolve('publico');
const PERMITIDOS = new Set(['index.html', 'estilos.css', 'app.js']);

export const servidor = http.createServer(async (req, res) => {
  const nombre = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
  if (!PERMITIDOS.has(nombre)) {
    res.writeHead(404).end('No encontrado');
    return;
  }
  const contenido = await readFile(path.join(RAIZ, nombre));
  res.writeHead(200).end(contenido);
});
