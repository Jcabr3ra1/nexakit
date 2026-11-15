import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { gitConfigGlobalVacio } from '../test-support/git-aislado.js';
import path from 'node:path';
import { proponer, calcularHuella } from '../dist/fabrica/enrutador.js';
import { leerDiff } from '../dist/fabrica/diff.js';
import { ESTACIONES } from '../dist/fabrica/estaciones.js';
import { ErrorFabrica } from '../dist/fabrica/errores.js';
import { lanzar, estado, esperar, cancelar, construirEncargo, MAX_TERMINADOS } from '../dist/fabrica/ejecutor.js';
import * as rastro from '../dist/fabrica/rastro.js';
import { fileSymlinkSkipReason } from '../testing/symlink-capability.js';

process.env.GIT_CONFIG_GLOBAL = gitConfigGlobalVacio;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Prueba';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'prueba@example.com';
// Si el rastro guardara el entorno, este valor aparecería en sus archivos.
process.env.FABRICA_SECRETO_PRUEBA = 'sk-secreto-que-no-debe-salir';

const PATRON_ID = /^fab-\d{8}-\d{4}-[0-9a-f]{4}$/u;
const SIN_ENLACES = process.platform === 'win32' || fileSymlinkSkipReason();

const temporales = [];
test.after(() => {
  for (const dir of temporales) rmSync(dir, { recursive: true, force: true });
});

function temporal(prefijo) {
  const dir = mkdtempSync(path.join(tmpdir(), prefijo));
  temporales.push(dir);
  return dir;
}

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

/** Repo con `main` y la rama `trabajo` con un cambio sin confirmar. */
function crearRepo() {
  const dir = temporal('fabrica-ejecutor-');
  git(dir, 'init', '-q');
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  writeFileSync(path.join(dir, 'README.txt'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'trabajo');
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'a.js'), 'export const MARCA_DEL_DIFF_UNICA = 1;\n');
  return dir;
}

const externa = (estacion, ia = 'codex', modelo = 'gpt-6-sol', esfuerzo = 'high') => ({
  estacion,
  ia,
  modelo,
  esfuerzo: ia === 'codex' ? esfuerzo : null,
  motivo: 'prueba',
  descartes: [],
  ordenesPermitidas: ia === 'codex' ? [...ESTACIONES[estacion].ordenesPermitidas] : [],
  estado: 'propuesta',
});
const deClaude = (estacion) => ({
  estacion,
  ia: 'claude',
  modelo: 'revisor-de-calidad',
  esfuerzo: null,
  motivo: 'prueba',
  descartes: [],
  ordenesPermitidas: [],
  estado: 'propuesta',
});

/** Recorrido real (head, base y diff de `proponer`) con las estaciones que pide la prueba. */
async function recorridoCon(dir, estaciones, extra = {}) {
  const propuesto = await proponer({ raiz: dir, base: 'main', catalogos: {} });
  const r = { ...propuesto, ...extra, estaciones };
  r.huella = calcularHuella(r);
  return r;
}

const CATALOGO = {
  codex: [{ modelo: 'gpt-6-sol', esfuerzos: ['high', 'medium'] }],
  antigravity: [{ modelo: 'gemini-4-argon-high', esfuerzos: [] }],
};

function conector(ia, ejecutar, catalogo = CATALOGO[ia]) {
  return { ia, catalogo: async () => catalogo, ejecutar, cerrar: async () => {} };
}

const ok = (encargo) => ({
  estado: 'ok',
  informe: { hallazgos: [], resumen: `sin hallazgos en ${encargo.estacion}` },
  crudo: '{"hallazgos":[]}',
  modeloInformado: encargo.modelo,
  tokens: { entrada: 10, salida: 5, total: 15 },
  denegaciones: [],
});

/** Un conector bien hecho: no devuelve hasta que se aborta la señal. */
const hastaAbortar = (señal) =>
  new Promise((resolve) => {
    const fin = () =>
      resolve({ estado: 'cancelada', crudo: '', modeloInformado: null, tokens: null, denegaciones: [], motivo: 'abortada' });
    if (señal.aborted) fin();
    else señal.addEventListener('abort', fin, { once: true });
  });

const espera = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deEstacion = (e, nombre) => e.estaciones.find((x) => x.estacion === nombre);

test('construirEncargo une foco, criterios, foco de la persona, aviso de solo lectura y el diff', () => {
  const encargo = construirEncargo({
    estacion: externa('pruebas', 'codex', 'gpt-6-sol', 'medium'),
    raiz: '/repo',
    base: 'abc123',
    foco: 'mira los tiempos máximos',
    diff: 'diff --git a/x b/x\n+hola\n',
  });
  assert.equal(encargo.estacion, 'pruebas');
  assert.equal(encargo.modelo, 'gpt-6-sol');
  assert.equal(encargo.esfuerzo, 'medium');
  assert.equal(encargo.raiz, '/repo');
  assert.equal(encargo.base, 'abc123');
  assert.deepEqual(encargo.ordenesPermitidas, ['npm test']);
  assert.notEqual(encargo.ordenesPermitidas, ESTACIONES.pruebas.ordenesPermitidas, 'debe ser una copia');
  assert.ok(encargo.instrucciones.includes(ESTACIONES.pruebas.foco));
  for (const criterio of ESTACIONES.pruebas.criterios) assert.ok(encargo.instrucciones.includes(criterio));
  assert.ok(encargo.instrucciones.includes('mira los tiempos máximos'));
  assert.ok(encargo.instrucciones.includes('Revisa SOLO, sin modificar nada'));
  assert.ok(encargo.instrucciones.endsWith('diff --git a/x b/x\n+hola\n'));

  const sinFoco = construirEncargo({ estacion: externa('codigo'), raiz: '/r', base: 'b', diff: 'd' });
  assert.ok(!sinFoco.instrucciones.includes('persona'));
  assert.deepEqual(sinFoco.ordenesPermitidas, []);
});

test('el encargo lleva las órdenes del recorrido aprobado y no las de la tabla de estaciones', async () => {
  const aprobada = { ...externa('pruebas', 'codex', 'gpt-6-sol', 'medium'), ordenesPermitidas: ['npm run lint'] };
  const encargo = construirEncargo({ estacion: aprobada, raiz: '/r', base: 'b', diff: 'd' });
  assert.deepEqual(encargo.ordenesPermitidas, ['npm run lint']);
  assert.notEqual(encargo.ordenesPermitidas, aprobada.ordenesPermitidas, 'debe ser una copia');

  // De extremo a extremo: lo que recibe el conector es lo del recorrido, también cuando la tabla no declara nada.
  const dir = crearRepo();
  const home = temporal('fabrica-home-');
  const sinOrdenes = { ...externa('pruebas', 'codex', 'gpt-6-sol', 'medium'), ordenesPermitidas: [] };
  const conMas = { ...externa('seguridad'), ordenesPermitidas: ['git log'] };
  const r = await recorridoCon(dir, [sinOrdenes, conMas]);
  const recibidas = {};
  const codex = conector('codex', async (e) => {
    recibidas[e.estacion] = e.ordenesPermitidas;
    return ok(e);
  });
  const { id } = await lanzar(r, { raiz: dir, conectores: { codex }, home });
  await esperar(id);
  assert.deepEqual(recibidas, { pruebas: [], seguridad: ['git log'] });
});

test('con 6 estaciones externas y paralelismo 4 nunca hay más de 4 a la vez', async () => {
  const dir = crearRepo();
  const home = temporal('fabrica-home-');
  const nombres = ['seguridad', 'arquitectura', 'pruebas', 'interfaz', 'rendimiento', 'documentacion'];
  const r = await recorridoCon(dir, [...nombres.map((n) => externa(n)), deClaude('codigo')]);
  let activas = 0;
  let maximo = 0;
  const llamadas = [];
  const codex = conector('codex', async (encargo) => {
    llamadas.push(encargo.estacion);
    activas += 1;
    maximo = Math.max(maximo, activas);
    await espera(30);
    activas -= 1;
    return ok(encargo);
  });
  const { id } = await lanzar(r, { raiz: dir, conectores: { codex }, paralelismo: 4, home });
  assert.match(id, PATRON_ID);
  const final = await esperar(id);
  assert.equal(maximo, 4);
  assert.deepEqual([...llamadas].sort(), [...nombres].sort());
  assert.equal(final.fase, 'terminado');
  for (const n of nombres) assert.equal(deEstacion(final, n).estado, 'ok');
  assert.equal(deEstacion(final, 'codigo').estado, 'claude');
  assert.deepEqual(final.escriturasDetectadas, []);
  assert.deepEqual(estado(id), final);
});

test('una estación que no termina se corta a los timeoutMs como fallida y las demás terminan', async () => {
  const dir = crearRepo();
  const home = temporal('fabrica-home-');
  const r = await recorridoCon(dir, [externa('seguridad'), externa('pruebas'), externa('rendimiento')]);
  const codex = conector('codex', (encargo, señal) => (encargo.estacion === 'pruebas' ? hastaAbortar(señal) : ok(encargo)));
  const { id } = await lanzar(r, { raiz: dir, conectores: { codex }, timeoutMs: 50, home });
  const final = await esperar(id);
  assert.deepEqual(deEstacion(final, 'pruebas'), { estacion: 'pruebas', estado: 'fallida', motivo: 'tiempo agotado' });
  assert.equal(deEstacion(final, 'seguridad').estado, 'ok');
  assert.equal(deEstacion(final, 'rendimiento').estado, 'ok');
  assert.equal(final.fase, 'terminado');
});

test('un conector que lanza (síncrono o asíncrono) deja la estación fallida sin filtrar plazas', async () => {
  const dir = crearRepo();
  const home = temporal('fabrica-home-');
  const r = await recorridoCon(dir, [
    externa('seguridad'),
    externa('arquitectura'),
    externa('pruebas'),
    externa('interfaz'),
  ]);
  let activas = 0;
  let maximo = 0;
  const codex = conector('codex', (encargo) => {
    if (encargo.estacion === 'seguridad') throw new Error('no arrancó el proceso');
    return (async () => {
      activas += 1;
      maximo = Math.max(maximo, activas);
      await espera(5);
      activas -= 1;
      if (encargo.estacion === 'arquitectura') throw new Error('se cayó la conexión');
      return ok(encargo);
    })();
  });
  // Con una sola plaza, cualquier fuga dejaría el recorrido colgado para siempre.
  const { id } = await lanzar(r, { raiz: dir, conectores: { codex }, paralelismo: 1, home });
  const final = await esperar(id);
  assert.equal(final.fase, 'terminado');
  assert.equal(maximo, 1);
  assert.equal(deEstacion(final, 'seguridad').estado, 'fallida');
  assert.match(deEstacion(final, 'seguridad').motivo, /no arrancó el proceso/u);
  assert.equal(deEstacion(final, 'arquitectura').estado, 'fallida');
  assert.match(deEstacion(final, 'arquitectura').motivo, /se cayó la conexión/u);
  assert.equal(deEstacion(final, 'pruebas').estado, 'ok');
  assert.equal(deEstacion(final, 'interfaz').estado, 'ok');
});

test('si un conector escribe en la raíz, la fase es fallido y escriturasDetectadas lo lista', async () => {
  const dir = crearRepo();
  const home = temporal('fabrica-home-');
  const r = await recorridoCon(dir, [externa('seguridad')]);
  const codex = conector('codex', async (encargo) => {
    writeFileSync(path.join(dir, 'escrito.txt'), 'no debería estar aquí\n');
    return ok(encargo);
  });
  const { id } = await lanzar(r, { raiz: dir, conectores: { codex }, home });
  const final = await esperar(id);
  assert.equal(final.fase, 'fallido');
  assert.ok(final.escriturasDetectadas.includes('escrito.txt'));
  const enDisco = JSON.parse(readFileSync(path.join(final.dir, 'estado.json'), 'utf8'));
  assert.equal(enDisco.fase, 'fallido');
  assert.ok(enDisco.escriturasDetectadas.includes('escrito.txt'));
});

test('lanzar con una huella desfasada rechaza antes de crear el rastro', async () => {
  const dir = crearRepo();
  const home = temporal('fabrica-home-');
  const r = await recorridoCon(dir, [externa('seguridad')]);
  writeFileSync(path.join(dir, 'src', 'a.js'), 'export const OTRA = 2;\n');
  let llamado = false;
  const codex = conector('codex', async (encargo) => {
    llamado = true;
    return ok(encargo);
  });
  await assert.rejects(lanzar(r, { raiz: dir, conectores: { codex }, home }), (error) => {
    assert.ok(error instanceof ErrorFabrica);
    assert.match(error.message, /vuelve a proponer/u);
    return true;
  });
  assert.equal(existsSync(path.join(home, '.nexakit')), false);
  assert.equal(llamado, false);
});

test('lanzar rechaza un paralelismo o un tiempo máximo no válidos', async () => {
  const dir = crearRepo();
  const home = temporal('fabrica-home-');
  const r = await recorridoCon(dir, [externa('seguridad')]);
  await assert.rejects(lanzar(r, { raiz: dir, conectores: {}, paralelismo: 0, home }), ErrorFabrica);
  await assert.rejects(lanzar(r, { raiz: dir, conectores: {}, timeoutMs: -1, home }), ErrorFabrica);
  assert.equal(existsSync(path.join(home, '.nexakit')), false);
});

test('revalida el catálogo vivo, marca las IA sin conector y muestra omitidas y sin modelo', async () => {
  const dir = crearRepo();
  const home = temporal('fabrica-home-');
  const estaciones = [
    externa('seguridad', 'codex', 'gpt-6-sol', 'high'),
    externa('pruebas', 'codex', 'gpt-6-sol', 'medium'),
    externa('interfaz', 'codex', 'gpt-6.1-sol', 'high'),
    externa('arquitectura', 'antigravity', 'gemini-4-argon-high'),
    { ...externa('documentacion'), ia: null, modelo: null, esfuerzo: null, motivo: 'no cambia documentación', estado: 'omitida' },
    { ...externa('rendimiento'), ia: null, modelo: null, esfuerzo: null, descartes: ['x no está'], estado: 'sin-modelo' },
    deClaude('codigo'),
  ];
  const r = await recorridoCon(dir, estaciones);
  r.coste = { llamadasExternas: 99, subagentesClaude: 99 }; // no entra en la huella: se recalcula
  const lanzadas = [];
  // El catálogo vivo ya no admite «high» en gpt-6-sol ni tiene gpt-6.1-sol.
  const codex = conector(
    'codex',
    async (encargo) => {
      lanzadas.push(encargo.estacion);
      return ok(encargo);
    },
    [{ modelo: 'gpt-6-sol', esfuerzos: ['medium'] }],
  );
  const { id } = await lanzar(r, { raiz: dir, conectores: { codex }, home });
  const final = await esperar(id);
  assert.deepEqual(lanzadas, ['pruebas']);
  assert.deepEqual(deEstacion(final, 'seguridad'), {
    estacion: 'seguridad',
    estado: 'fallida',
    motivo: 'el modelo ya no está en el catálogo',
  });
  assert.equal(deEstacion(final, 'interfaz').motivo, 'el modelo ya no está en el catálogo');
  assert.deepEqual(deEstacion(final, 'arquitectura'), {
    estacion: 'arquitectura',
    estado: 'fallida',
    motivo: 'antigravity no está disponible',
  });
  assert.equal(deEstacion(final, 'pruebas').estado, 'ok');
  assert.deepEqual(deEstacion(final, 'documentacion'), {
    estacion: 'documentacion',
    estado: 'omitida',
    motivo: 'no cambia documentación',
  });
  assert.equal(deEstacion(final, 'rendimiento').estado, 'sin-modelo');
  assert.equal(deEstacion(final, 'codigo').estado, 'claude');
  assert.equal(final.fase, 'terminado');
  const guardado = JSON.parse(readFileSync(path.join(final.dir, 'recorrido.json'), 'utf8'));
  assert.deepEqual(guardado.coste, { llamadasExternas: 4, subagentesClaude: 1 });
  assert.equal(guardado.huella, r.huella);
});

test('el rastro guarda recorrido, estado y un JSON por estación con permisos privados y sin secretos', async () => {
  const dir = crearRepo();
  const home = temporal('fabrica-home-');
  const r = await recorridoCon(dir, [externa('seguridad'), externa('pruebas', 'codex', 'gpt-6-sol', 'medium'), deClaude('codigo')], {
    foco: 'revisa los permisos',
  });
  const codex = conector('codex', async (encargo) => ok(encargo));
  const { id } = await lanzar(r, { raiz: dir, conectores: { codex }, home });
  const final = await esperar(id);
  assert.equal(final.fase, 'terminado');

  const base = path.join(home, '.nexakit', 'fabrica');
  const repos = readdirSync(base);
  assert.equal(repos.length, 1);
  assert.match(repos[0], /^fabrica-ejecutor-[A-Za-z0-9._-]*-[0-9a-f]{8}$/u);
  const dirRepo = path.join(base, repos[0]);
  assert.equal(final.dir, path.join(dirRepo, id));
  assert.deepEqual(readdirSync(final.dir).sort(), ['estado.json', 'pruebas.json', 'recorrido.json', 'seguridad.json']);

  const recorrido = JSON.parse(readFileSync(path.join(final.dir, 'recorrido.json'), 'utf8'));
  assert.equal(recorrido.huella, r.huella);
  const estadoDisco = JSON.parse(readFileSync(path.join(final.dir, 'estado.json'), 'utf8'));
  assert.equal(estadoDisco.fase, 'terminado');
  assert.equal(estadoDisco.id, id);

  const diff = await leerDiff(dir, 'main');
  const seguridad = JSON.parse(readFileSync(path.join(final.dir, 'seguridad.json'), 'utf8'));
  assert.equal(seguridad.encargo.modelo, 'gpt-6-sol');
  assert.equal(seguridad.encargo.diffSha256, createHash('sha256').update(diff.texto, 'utf8').digest('hex'));
  assert.ok(seguridad.encargo.instrucciones.includes('Revisa SOLO, sin modificar nada'));
  assert.ok(seguridad.encargo.instrucciones.includes('revisa los permisos'));
  assert.equal(seguridad.resultado.estado, 'ok');
  assert.deepEqual(seguridad.resultado.tokens, { entrada: 10, salida: 5, total: 15 });

  for (const archivo of readdirSync(final.dir)) {
    const texto = readFileSync(path.join(final.dir, archivo), 'utf8');
    assert.ok(!texto.includes('MARCA_DEL_DIFF_UNICA'), `${archivo} no debe guardar el diff completo`);
    assert.ok(!texto.includes(process.env.FABRICA_SECRETO_PRUEBA), `${archivo} no debe guardar el entorno`);
  }

  if (process.platform !== 'win32') {
    for (const carpeta of [base, dirRepo, final.dir]) assert.equal(statSync(carpeta).mode & 0o777, 0o700, carpeta);
    for (const archivo of readdirSync(final.dir)) {
      assert.equal(statSync(path.join(final.dir, archivo)).mode & 0o777, 0o600, archivo);
    }
  }
});

test('nombreRepo deriva un nombre seguro de la raíz real', async () => {
  const padre = temporal('fabrica-nombre-');
  const raiz = path.join(padre, 'mi repo; rm -rf');
  mkdirSync(raiz);
  const nombre = await rastro.nombreRepo(raiz);
  assert.match(nombre, /^[A-Za-z0-9._-]+-[0-9a-f]{8}$/u);
  assert.ok(nombre.startsWith('mi_repo_rm_-rf-'));
  assert.equal(await rastro.nombreRepo(path.join(padre, '.', 'mi repo; rm -rf')), nombre);
});

test('rastro.crear no sigue un enlace bajo ~/.nexakit/fabrica', { skip: SIN_ENLACES }, async () => {
  const home = temporal('fabrica-home-');
  const fuera = temporal('fabrica-fuera-');
  mkdirSync(path.join(home, '.nexakit'));
  symlinkSync(fuera, path.join(home, '.nexakit', 'fabrica'), 'dir');
  await assert.rejects(rastro.crear(home, 'repo-12345678', { huella: 'h' }), ErrorFabrica);
  assert.deepEqual(readdirSync(fuera), []);

  const home2 = temporal('fabrica-home-');
  mkdirSync(path.join(home2, '.nexakit', 'fabrica'), { recursive: true });
  symlinkSync(fuera, path.join(home2, '.nexakit', 'fabrica', 'repo-12345678'), 'dir');
  await assert.rejects(rastro.crear(home2, 'repo-12345678', { huella: 'h' }), ErrorFabrica);
  assert.deepEqual(readdirSync(fuera), []);

  await assert.rejects(rastro.crear(home2, '../escapar', { huella: 'h' }), ErrorFabrica);
});

test('podar borra los rastros de más de 90 días y no sigue enlaces', { skip: SIN_ENLACES }, async () => {
  const home = temporal('fabrica-home-');
  const fuera = temporal('fabrica-fuera-');
  const viejo = await rastro.crear(home, 'repo-12345678', { huella: 'vieja' });
  const nuevo = await rastro.crear(home, 'repo-12345678', { huella: 'nueva' });
  const hace100Dias = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
  utimesSync(viejo.dir, hace100Dias, hace100Dias);

  // Un enlace con forma de rastro que apunta fuera, y una carpeta de repo que es un enlace.
  const victima = path.join(fuera, 'fab-20200101-0000-abcd');
  mkdirSync(victima);
  writeFileSync(path.join(victima, 'importante.txt'), 'no borrar\n');
  utimesSync(victima, hace100Dias, hace100Dias);
  const enlaceRastro = path.join(home, '.nexakit', 'fabrica', 'repo-12345678', 'fab-20200101-0000-abcd');
  symlinkSync(victima, enlaceRastro, 'dir');
  lutimesSync(enlaceRastro, hace100Dias, hace100Dias);
  const enlaceRepo = path.join(home, '.nexakit', 'fabrica', 'otro-87654321');
  symlinkSync(fuera, enlaceRepo, 'dir');
  lutimesSync(enlaceRepo, hace100Dias, hace100Dias);

  const borrados = await rastro.podar(home);
  assert.deepEqual(borrados, [viejo.id]);
  assert.equal(existsSync(viejo.dir), false);
  assert.equal(existsSync(nuevo.dir), true);
  assert.equal(readFileSync(path.join(victima, 'importante.txt'), 'utf8'), 'no borrar\n');
  assert.equal(await rastro.podar(path.join(home, 'no-existe')).then((x) => x.length), 0);
});

test('cancelar aborta las estaciones en curso, cancela las pendientes y deja la fase en cancelado', async () => {
  const dir = crearRepo();
  const home = temporal('fabrica-home-');
  const r = await recorridoCon(dir, [externa('seguridad'), externa('pruebas'), externa('rendimiento'), deClaude('codigo')]);
  let avisar;
  const empezada = new Promise((resolve) => {
    avisar = resolve;
  });
  const llamadas = [];
  const codex = conector('codex', (encargo, señal) => {
    llamadas.push(encargo.estacion);
    avisar();
    return hastaAbortar(señal);
  });
  const { id } = await lanzar(r, { raiz: dir, conectores: { codex }, paralelismo: 1, home });
  await empezada;
  assert.equal(estado(id).fase, 'en-curso');
  await cancelar(id);
  const final = estado(id);
  assert.equal(final.fase, 'cancelado');
  assert.equal(llamadas.length, 1);
  for (const n of ['seguridad', 'pruebas', 'rendimiento']) assert.equal(deEstacion(final, n).estado, 'cancelada', n);
  assert.equal(deEstacion(final, 'codigo').estado, 'claude');
  assert.deepEqual(await esperar(id), final);
  const enDisco = JSON.parse(readFileSync(path.join(final.dir, 'estado.json'), 'utf8'));
  assert.equal(enDisco.fase, 'cancelado');
  await cancelar(id); // ya terminado: no hace nada
  assert.throws(() => estado('fab-00000000-0000-0000', home), ErrorFabrica);
});

/** Un conector roto: ignora la señal y nunca devuelve. */
const nuncaDevuelve = () => new Promise(() => {});

test('si el conector ignora el aborto, tras la gracia la estación queda fallida y el recorrido sigue', async () => {
  const dir = crearRepo();
  const home = temporal('fabrica-home-');
  const r = await recorridoCon(dir, [externa('seguridad'), externa('pruebas')]);
  const codex = conector('codex', (encargo) => (encargo.estacion === 'pruebas' ? nuncaDevuelve() : ok(encargo)));
  const { id } = await lanzar(r, { raiz: dir, conectores: { codex }, timeoutMs: 30, graciaMs: 30, home });
  const final = await esperar(id);
  assert.deepEqual(deEstacion(final, 'pruebas'), {
    estacion: 'pruebas',
    estado: 'fallida',
    motivo: 'el revisor no respondió a la cancelación',
  });
  assert.equal(deEstacion(final, 'seguridad').estado, 'ok');
  assert.equal(final.fase, 'terminado');

  // También al cancelar: cancelar no se queda colgado.
  let avisar;
  const empezada = new Promise((resolve) => {
    avisar = resolve;
  });
  const roto = conector('codex', () => {
    avisar();
    return nuncaDevuelve();
  });
  const { id: id2 } = await lanzar(r, { raiz: dir, conectores: { codex: roto }, paralelismo: 1, graciaMs: 30, home });
  await empezada;
  await cancelar(id2);
  const cancelado = estado(id2);
  assert.equal(cancelado.fase, 'cancelado');
  assert.equal(deEstacion(cancelado, 'seguridad').motivo, 'el revisor no respondió a la cancelación');
  assert.equal(deEstacion(cancelado, 'pruebas').estado, 'cancelada');
});

test('un catálogo vivo que no responde a tiempo deja esa IA como no disponible', async () => {
  const dir = crearRepo();
  const home = temporal('fabrica-home-');
  const r = await recorridoCon(dir, [externa('seguridad'), externa('arquitectura', 'antigravity', 'gemini-4-argon-high')]);
  let llamadas = 0;
  const codex = { ...conector('codex', async (e) => ((llamadas += 1), ok(e))), catalogo: nuncaDevuelve };
  const antigravity = conector('antigravity', async (e) => ok(e));
  const { id } = await lanzar(r, { raiz: dir, conectores: { codex, antigravity }, topeCatalogoMs: 30, home });
  const final = await esperar(id);
  assert.equal(deEstacion(final, 'seguridad').estado, 'fallida');
  assert.match(deEstacion(final, 'seguridad').motivo, /^codex no está disponible/u);
  assert.equal(deEstacion(final, 'arquitectura').estado, 'ok');
  assert.equal(llamadas, 0);
});

test('la revalidación usa el criterio del enrutador: codex sin esfuerzo no pasa', async () => {
  const dir = crearRepo();
  const home = temporal('fabrica-home-');
  const r = await recorridoCon(dir, [{ ...externa('seguridad'), esfuerzo: null }]);
  let llamadas = 0;
  const codex = conector('codex', async (e) => ((llamadas += 1), ok(e)));
  const { id } = await lanzar(r, { raiz: dir, conectores: { codex }, home });
  const final = await esperar(id);
  assert.deepEqual(deEstacion(final, 'seguridad'), {
    estacion: 'seguridad',
    estado: 'fallida',
    motivo: 'el modelo ya no está en el catálogo',
  });
  assert.equal(llamadas, 0);
});

test('lanzar poda en segundo plano los rastros de más de 90 días', async () => {
  const dir = crearRepo();
  const home = temporal('fabrica-home-');
  const viejo = await rastro.crear(home, 'otro-12345678', { huella: 'vieja' });
  const hace100Dias = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
  utimesSync(viejo.dir, hace100Dias, hace100Dias);
  const r = await recorridoCon(dir, [deClaude('codigo')]);
  const { id } = await lanzar(r, { raiz: dir, conectores: {}, home });
  await esperar(id);
  assert.equal(existsSync(viejo.dir), false);
  assert.equal(existsSync(estado(id).dir), true);
});

test(`conserva en memoria como mucho ${MAX_TERMINADOS} terminados y lee los demás de estado.json`, async () => {
  const dir = crearRepo();
  const home = temporal('fabrica-home-');
  const r = await recorridoCon(dir, [deClaude('codigo')]);
  const primero = (await lanzar(r, { raiz: dir, conectores: {}, home })).id;
  const finalPrimero = await esperar(primero);
  await Promise.all(
    Array.from({ length: MAX_TERMINADOS }, async () => {
      const { id } = await lanzar(r, { raiz: dir, conectores: {}, home });
      await esperar(id);
    }),
  );
  assert.deepEqual(estado(primero, home), finalPrimero);
  assert.deepEqual(await esperar(primero, home), finalPrimero);
  await cancelar(primero, home);
  // Ya no está en memoria: sin su estado.json no se encuentra.
  rmSync(path.join(finalPrimero.dir, 'estado.json'));
  assert.throws(() => estado(primero, home), ErrorFabrica);
  await assert.rejects(cancelar(primero, home), ErrorFabrica);
});

test('si falla la escritura del estado final, el motivo lo dice y el recorrido sigue en memoria', async () => {
  const dir = crearRepo();
  const home = temporal('fabrica-home-');
  const r = await recorridoCon(dir, [deClaude('codigo')]);
  const { id } = await lanzar(r, { raiz: dir, conectores: {}, home });
  // Antes de que acabe (falta la instantánea final): estado.json pasa a ser una carpeta.
  const enCurso = estado(id);
  rmSync(path.join(enCurso.dir, 'estado.json'));
  mkdirSync(path.join(enCurso.dir, 'estado.json', 'bloqueo'), { recursive: true });
  const final = await esperar(id);
  assert.equal(final.fase, 'fallido');
  assert.match(final.motivo, /^no se pudo guardar el estado final en el rastro/u);
  assert.deepEqual(estado(id, home), final);
});
