import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const RAIZ = path.resolve('publico');

export const servidor = http.createServer(async (req, res) => {
  const nombre = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.slice(1)) || 'index.html';
  const ruta = path.resolve(RAIZ, nombre);
  if (ruta !== RAIZ && !ruta.startsWith(RAIZ + path.sep)) {
    res.writeHead(403).end('Prohibido');
    return;
  }
  try {
    res.writeHead(200).end(await readFile(ruta));
  } catch {
    res.writeHead(404).end('No encontrado');
  }
});
