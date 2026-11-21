import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const RAIZ = path.resolve('publico');
const TIPOS = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
]);

function dentroDeRaiz(raiz, ruta) {
  return ruta === raiz || ruta.startsWith(raiz + path.sep);
}

export const servidor = http.createServer(async (req, res) => {
  try {
    const nombre = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.slice(1)) || 'index.html';
    const ruta = path.resolve(RAIZ, nombre);
    if (!dentroDeRaiz(RAIZ, ruta)) {
      res.writeHead(403).end('Prohibido');
      return;
    }
    const real = await realpath(ruta);
    if (!dentroDeRaiz(await realpath(RAIZ), real)) {
      res.writeHead(403).end('Prohibido');
      return;
    }
    const contenido = await readFile(real);
    res.writeHead(200, {
      'content-type': TIPOS.get(path.extname(real)) ?? 'application/octet-stream',
      'x-content-type-options': 'nosniff',
    });
    res.end(contenido);
  } catch {
    res.writeHead(404).end('No encontrado');
  }
});
