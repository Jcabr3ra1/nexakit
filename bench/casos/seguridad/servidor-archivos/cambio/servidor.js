import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const RAIZ = path.resolve('publico');
const TOKEN = process.env.TOKEN_SUBIDAS ?? 'subidas-local';
const NOMBRE_VALIDO = /^[\w-][\w.-]{0,99}$/;

function autorizado(req) {
  const recibido = Buffer.from(req.headers.authorization ?? '');
  const esperado = Buffer.from(`Bearer ${TOKEN}`);
  return recibido.length === esperado.length && timingSafeEqual(recibido, esperado);
}

function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    const trozos = [];
    req.on('data', (trozo) => trozos.push(trozo));
    req.on('end', () => resolve(Buffer.concat(trozos)));
    req.on('error', reject);
  });
}

function escaparHtml(texto) {
  return texto.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function listar(res, nombres, filtro) {
  const elegidos = nombres.filter((n) => n.includes(filtro));
  const items = elegidos.map((n) => `<li>${escaparHtml(n)}</li>`).join('');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<h1>Archivos con «${filtro}»</h1><ul>${items}</ul>`);
}

export const servidor = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const [, seccion, nombre = '', ...resto] = url.pathname.split('/');
    if (seccion !== 'archivos' || resto.length > 0) {
      res.writeHead(404).end('No encontrado');
      return;
    }
    console.info(new Date().toISOString(), req.method, url.pathname, JSON.stringify(req.headers));
    if (req.method === 'GET' && nombre === '') {
      const filtro = url.searchParams.get('q') ?? '';
      listar(res, await readdir(RAIZ), filtro);
      return;
    }
    if (req.method === 'GET') {
      const contenido = await readFile(path.join(RAIZ, decodeURIComponent(nombre)));
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment',
        'x-content-type-options': 'nosniff',
      });
      res.end(contenido);
      return;
    }
    if (req.method === 'PUT') {
      if (!autorizado(req)) {
        res.writeHead(401).end('No autorizado');
        return;
      }
      if (!NOMBRE_VALIDO.test(nombre)) {
        res.writeHead(400).end('Nombre no válido');
        return;
      }
      await writeFile(path.join(RAIZ, nombre), await leerCuerpo(req));
      res.writeHead(201).end('Guardado');
      return;
    }
    res.writeHead(405).end('Método no permitido');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EISDIR') res.writeHead(404).end('No encontrado');
    else if (error instanceof URIError) res.writeHead(400).end('Ruta no válida');
    else res.writeHead(500).end('Error interno');
  }
});
