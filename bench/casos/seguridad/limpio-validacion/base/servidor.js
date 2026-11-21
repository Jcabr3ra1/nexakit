import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const RAIZ = path.resolve('publico');

export const servidor = http.createServer(async (req, res) => {
  const nombre = new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html';
  const contenido = await readFile(path.join(RAIZ, nombre));
  res.writeHead(200).end(contenido);
});
