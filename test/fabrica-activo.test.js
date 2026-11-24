import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitConfigGlobalVacio } from '../test-support/git-aislado.js';
import { proponer, calcularHuella } from '../dist/fabrica/enrutador.js';
import { ESTACIONES } from '../dist/fabrica/estaciones.js';
import { lanzar, esperar, cancelar } from '../dist/fabrica/ejecutor.js';
import { crearConectorCodex } from '../dist/fabrica/conectores/codex.js';
import { crearConectorAntigravity } from '../dist/fabrica/conectores/antigravity.js';
import * as rastro from '../dist/fabrica/rastro.js';

process.env.GIT_CONFIG_GLOBAL = gitConfigGlobalVacio;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Prueba';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'prueba@example.com';

const SERVIDOR = fileURLToPath(new URL('../test-support/fabrica/servidor-falso.mjs', import.meta.url));
const GUIONES = fileURLToPath(new URL('../test-support/fabrica/', import.meta.url));

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
  const dir = temporal('fabrica-activo-');
  git(dir, 'init', '-q');
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  writeFileSync(path.join(dir, 'README.txt'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'trabajo');
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'a.js'), 'export const A = 1;\n');
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

/** Un HOME temporal vacío para proponer: nunca las preferencias ni la evidencia del HOME real de quien ejecuta. */
const HOME_VACIO = mkdtempSync(path.join(tmpdir(), 'fabrica-home-vacio-'));
temporales.push(HOME_VACIO);

async function recorridoCon(dir, estaciones) {
  const propuesto = await proponer({ raiz: dir, base: 'main', catalogos: {}, home: HOME_VACIO });
  const r = { ...propuesto, estaciones };
  r.huella = calcularHuella(r);
  return r;
}

const CATALOGO = [{ modelo: 'gpt-6-sol', esfuerzos: ['high', 'medium'] }];

function conector(ejecutar) {
  return { ia: 'codex', catalogo: async () => CATALOGO, ejecutar, cerrar: async () => {} };
}

const ok = (encargo, tokens = 15) => ({
  estado: 'ok',
  informe: { hallazgos: [], resumen: `sin hallazgos en ${encargo.estacion}` },
  crudo: '{"hallazgos":[]}',
  modeloInformado: encargo.modelo,
  tokens: { entrada: tokens - 5, salida: 5, total: tokens },
  denegaciones: [],
});

const espera = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Una puerta que el conector espera y la prueba abre. */
function puerta() {
  let abrir;
  const abierta = new Promise((resolve) => {
    abrir = resolve;
  });
  return { abierta, abrir };
}

const rutaActivo = (home) => path.join(home, '.nexakit', 'fabrica', 'activo.json');

function leerActivoSiExiste(home) {
  try {
    return JSON.parse(readFileSync(rutaActivo(home), 'utf8'));
  } catch {
    return null;
  }
}

/** Espera a que `activo.json` cumpla la condición; devuelve su contenido. */
async function esperarActivo(home, condicion, mensaje) {
  let ultimo = null;
  for (let i = 0; i < 300; i += 1) {
    ultimo = leerActivoSiExiste(home);
    if (ultimo !== null && condicion(ultimo)) return ultimo;
    await espera(20);
  }
  assert.fail(`${mensaje}; último activo.json: ${JSON.stringify(ultimo)}`);
}

async function esperarSinActivo(home) {
  for (let i = 0; i < 300; i += 1) {
    if (!existsSync(rutaActivo(home))) return;
    await espera(20);
  }
  assert.fail('activo.json sigue existiendo');
}

const tokensDe = (activo, estacion) => activo.estaciones.find((e) => e.estacion === estacion)?.tokens;

test('durante el recorrido activo.json lleva las estaciones y los tokens crecientes, con permisos 0o600', async () => {
  const dir = crearRepo();
  const home = temporal('fabrica-home-');
  const r = await recorridoCon(dir, [externa('seguridad'), externa('pruebas', 'codex', 'gpt-6-sol', 'medium'), deClaude('codigo')]);
  const primera = puerta();
  const segunda = puerta();
  const final = puerta();
  const codex = conector(async (encargo, _senal, alProgreso) => {
    if (encargo.estacion !== 'seguridad') {
      await final.abierta;
      return ok(encargo, 40);
    }
    alProgreso({ tokens: 100 });
    await primera.abierta;
    alProgreso({ tokens: 250 });
    await segunda.abierta;
    return ok(encargo, 300);
  });
  const { id } = await lanzar(r, { raiz: dir, conectores: { codex }, home, intervaloActivoMs: 20 });

  const uno = await esperarActivo(home, (a) => tokensDe(a, 'seguridad') === 100, 'no aparecieron los 100 tokens');
  assert.equal(uno.pid, process.pid);
  assert.equal(uno.id, id);
  assert.equal(typeof uno.repo, 'string');
  assert.ok(uno.repo.length > 0);
  assert.ok(!Number.isNaN(Date.parse(uno.actualizado)), 'actualizado es una fecha ISO');
  assert.equal(new Date(uno.actualizado).toISOString(), uno.actualizado);
  assert.deepEqual(
    uno.estaciones.map((e) => e.estacion),
    ['seguridad', 'pruebas', 'codigo'],
  );
  const seguridad = uno.estaciones.find((e) => e.estacion === 'seguridad');
  assert.deepEqual(seguridad, { estacion: 'seguridad', ia: 'codex', modelo: 'gpt-6-sol', esfuerzo: 'high', estado: 'en-curso', tokens: 100 });
  assert.deepEqual(uno.estaciones.find((e) => e.estacion === 'pruebas'), {
    estacion: 'pruebas',
    ia: 'codex',
    modelo: 'gpt-6-sol',
    esfuerzo: 'medium',
    estado: 'en-curso',
    tokens: 0,
  });
  assert.deepEqual(uno.estaciones.find((e) => e.estacion === 'codigo'), {
    estacion: 'codigo',
    ia: 'claude',
    modelo: 'revisor-de-calidad',
    esfuerzo: null,
    estado: 'claude',
    tokens: 0,
  });
  if (process.platform !== 'win32') assert.equal(statSync(rutaActivo(home)).mode & 0o777, 0o600);

  primera.abrir();
  await esperarActivo(home, (a) => tokensDe(a, 'seguridad') === 250, 'los tokens no crecieron a 250');
  segunda.abrir();
  await esperarActivo(home, (a) => a.estaciones.find((e) => e.estacion === 'seguridad')?.estado === 'ok', 'seguridad no pasó a ok');
  assert.equal(tokensDe(leerActivoSiExiste(home), 'seguridad'), 300, 'al terminar queda el total del resultado');

  final.abrir();
  assert.equal((await esperar(id)).fase, 'terminado');
  assert.equal(existsSync(rutaActivo(home)), false);
  // Sin restos de escrituras atómicas.
  assert.deepEqual(
    readdirSync(path.join(home, '.nexakit', 'fabrica')).filter((n) => n.endsWith('.tmp')),
    [],
  );
});

test('activo.json se escribe como mucho una vez por intervalo y lo último que cambió sale después', async () => {
  const dir = crearRepo();
  const home = temporal('fabrica-home-');
  const r = await recorridoCon(dir, [externa('seguridad')]);
  const lista = puerta();
  const codex = conector(async (encargo, _senal, alProgreso) => {
    for (let tokens = 1; tokens <= 50; tokens += 1) alProgreso({ tokens });
    await lista.abierta;
    return ok(encargo, 50);
  });
  const { id } = await lanzar(r, { raiz: dir, conectores: { codex }, home, intervaloActivoMs: 400 });

  // La primera escritura es inmediata (todo pendiente); las 50 de después esperan al siguiente intervalo.
  await esperarActivo(home, () => true, 'no se escribió activo.json al lanzar');
  await espera(120);
  const antes = leerActivoSiExiste(home);
  assert.equal(tokensDe(antes, 'seguridad'), 0, 'dentro del intervalo no se reescribe');
  assert.equal(antes.estaciones[0].estado, 'pendiente');

  const despues = await esperarActivo(home, (a) => tokensDe(a, 'seguridad') === 50, 'no salió el último valor');
  assert.equal(despues.estaciones[0].estado, 'en-curso');
  lista.abrir();
  await esperar(id);
  assert.equal(existsSync(rutaActivo(home)), false);
});

test('activo.json desaparece al terminar, al cancelar y al fallar', async () => {
  const dir = crearRepo();

  // Terminar bien.
  const homeOk = temporal('fabrica-home-');
  const rOk = await recorridoCon(dir, [externa('seguridad')]);
  const { id: idOk } = await lanzar(rOk, {
    raiz: dir,
    conectores: { codex: conector(async (encargo, _s, alProgreso) => (alProgreso({ tokens: 5 }), ok(encargo))) },
    home: homeOk,
    intervaloActivoMs: 10,
  });
  assert.equal((await esperar(idOk)).fase, 'terminado');
  assert.equal(existsSync(rutaActivo(homeOk)), false, 'terminado');

  // Fallar: el conector lanza.
  const homeFallo = temporal('fabrica-home-');
  const rFallo = await recorridoCon(dir, [externa('seguridad')]);
  const { id: idFallo } = await lanzar(rFallo, {
    raiz: dir,
    conectores: {
      codex: conector(async () => {
        throw new Error('se rompió');
      }),
    },
    home: homeFallo,
    intervaloActivoMs: 10,
  });
  const fallido = await esperar(idFallo);
  assert.equal(fallido.estaciones[0].estado, 'fallida');
  assert.equal(existsSync(rutaActivo(homeFallo)), false, 'fallido');

  // Cancelar mientras corre.
  const homeCancelar = temporal('fabrica-home-');
  const rCancelar = await recorridoCon(dir, [externa('seguridad'), externa('pruebas')]);
  const empezada = puerta();
  const codex = conector(
    (_encargo, senal) =>
      new Promise((resolve) => {
        empezada.abrir();
        senal.addEventListener('abort', () =>
          resolve({ estado: 'cancelada', crudo: '', modeloInformado: null, tokens: null, denegaciones: [], motivo: 'abortada' }),
        );
      }),
  );
  const { id: idCancelar } = await lanzar(rCancelar, { raiz: dir, conectores: { codex }, paralelismo: 1, home: homeCancelar, intervaloActivoMs: 10 });
  await empezada.abierta;
  await esperarActivo(homeCancelar, () => true, 'no apareció activo.json mientras corría');
  await cancelar(idCancelar);
  assert.equal((await esperar(idCancelar)).fase, 'cancelado');
  assert.equal(existsSync(rutaActivo(homeCancelar)), false, 'cancelado');
});

test('un activo.json de otro pid no se borra: ni al terminar ni con guardarActivo(null)', async () => {
  const ajeno = { pid: process.pid + 1_000_000, id: 'fab-00000000-0000-0000', repo: 'otro', actualizado: new Date().toISOString(), estaciones: [] };

  // Directo sobre el rastro.
  const homeDirecto = temporal('fabrica-home-');
  mkdirSync(path.join(homeDirecto, '.nexakit', 'fabrica'), { recursive: true });
  writeFileSync(rutaActivo(homeDirecto), JSON.stringify(ajeno));
  await rastro.guardarActivo(homeDirecto, null);
  assert.deepEqual(leerActivoSiExiste(homeDirecto), ajeno);
  // El propio sí se borra, y borrar lo que no existe no falla.
  await rastro.guardarActivo(homeDirecto, { ...ajeno, pid: process.pid });
  assert.equal(leerActivoSiExiste(homeDirecto).pid, process.pid);
  await rastro.guardarActivo(homeDirecto, null);
  assert.equal(existsSync(rutaActivo(homeDirecto)), false);
  await rastro.guardarActivo(homeDirecto, null);

  // En un recorrido: otro proceso se queda el archivo mientras este corre.
  const dir = crearRepo();
  const home = temporal('fabrica-home-');
  const r = await recorridoCon(dir, [externa('seguridad')]);
  const liberar = puerta();
  const codex = conector(async (encargo, _s, alProgreso) => {
    alProgreso({ tokens: 7 });
    await liberar.abierta;
    return ok(encargo);
  });
  const { id } = await lanzar(r, { raiz: dir, conectores: { codex }, home, intervaloActivoMs: 60_000 });
  await esperarActivo(home, (a) => a.pid === process.pid, 'no apareció el activo propio');
  writeFileSync(rutaActivo(home), JSON.stringify(ajeno));
  liberar.abrir();
  assert.equal((await esperar(id)).fase, 'terminado');
  assert.deepEqual(leerActivoSiExiste(home), ajeno, 'el archivo ajeno queda como estaba');
});

test('con dos recorridos a la vez no quedan restos: cada fin borra y el siguiente cambio vuelve a publicar', async () => {
  const dir = crearRepo();
  const home = temporal('fabrica-home-');
  const rapido = puerta();
  const lento = puerta();
  const fin = puerta();
  const rA = await recorridoCon(dir, [externa('seguridad')]);
  const rB = await recorridoCon(dir, [externa('pruebas', 'codex', 'gpt-6-sol', 'medium')]);
  const codex = conector(async (encargo, _s, alProgreso) => {
    alProgreso({ tokens: 9 });
    if (encargo.estacion === 'seguridad') {
      await rapido.abierta;
      return ok(encargo);
    }
    await lento.abierta;
    alProgreso({ tokens: 33 });
    await fin.abierta;
    return ok(encargo);
  });
  const opciones = { raiz: dir, conectores: { codex }, home, intervaloActivoMs: 10 };
  const { id: idA } = await lanzar(rA, opciones);
  const { id: idB } = await lanzar(rB, opciones);
  assert.notEqual(idA, idB);
  await esperarActivo(home, (a) => a.estaciones.every((e) => e.estado === 'en-curso'), 'no empezaron');

  rapido.abrir();
  await esperar(idA);
  lento.abrir();
  const queda = await esperarActivo(home, (a) => a.id === idB && tokensDe(a, 'pruebas') === 33, 'no volvió el estado del recorrido B');
  assert.equal(queda.pid, process.pid);

  fin.abrir();
  await esperar(idB);
  await esperarSinActivo(home);
});

test('un temporizador pendiente al terminar no resucita activo.json', async () => {
  const dir = crearRepo();
  const home = temporal('fabrica-home-');
  const r = await recorridoCon(dir, [externa('seguridad')]);
  const codex = conector(async (encargo, _s, alProgreso) => {
    // La primera escritura ya salió al lanzar: esto queda esperando al siguiente intervalo.
    alProgreso({ tokens: 3 });
    return ok(encargo);
  });
  const { id } = await lanzar(r, { raiz: dir, conectores: { codex }, home, intervaloActivoMs: 300 });
  assert.equal((await esperar(id)).fase, 'terminado');
  assert.equal(existsSync(rutaActivo(home)), false);
  await espera(700);
  assert.equal(existsSync(rutaActivo(home)), false, 'no reaparece pasado el intervalo');
});

test('si las escrituras fallan a mitad de recorrido, activo.json se borra igualmente al terminar', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async () => {
  const dir = crearRepo();
  const home = temporal('fabrica-home-');
  const carpeta = path.join(home, '.nexakit', 'fabrica');
  const r = await recorridoCon(dir, [externa('seguridad')]);
  const codex = conector(async (encargo, _s, alProgreso) => {
    await esperarActivo(home, () => true, 'no se escribió activo.json al lanzar');
    // Sin permiso de escritura en la carpeta, la escritura diferida falla y se ignora.
    chmodSync(carpeta, 0o500);
    alProgreso({ tokens: 4 });
    await espera(150);
    chmodSync(carpeta, 0o700);
    return ok(encargo);
  });
  const { id } = await lanzar(r, { raiz: dir, conectores: { codex }, home, intervaloActivoMs: 50 });
  try {
    assert.equal((await esperar(id)).fase, 'terminado');
  } finally {
    chmodSync(carpeta, 0o700);
  }
  assert.equal(existsSync(rutaActivo(home)), false);
});

/** Guion del servidor falso copiado a una carpeta temporal, con la ruta de registro. */
function prepararServidor(prefijo, nombre) {
  const dir = temporal(prefijo);
  const guion = JSON.parse(readFileSync(join(GUIONES, nombre), 'utf8'));
  guion.registro = join(dir, 'registro.ndjson');
  guion.registroArgs = join(dir, 'args.json');
  guion.registroCwd = join(dir, 'cwd.txt');
  const rutaGuion = join(dir, 'guion.json');
  writeFileSync(rutaGuion, JSON.stringify(guion));
  return { dir, rutaGuion };
}

function encargo(raiz, modelo, esfuerzo) {
  return {
    estacion: 'pruebas',
    modelo,
    esfuerzo,
    raiz,
    base: 'abc123',
    instrucciones: 'Revisa el diff.',
    ordenesPermitidas: ['npm test'],
  };
}

test('el conector de Codex avisa de los tokens con thread/tokenUsage/updated y un oyente roto no lo rompe', async () => {
  for (const oyenteRoto of [false, true]) {
    const { dir, rutaGuion } = prepararServidor('nexakit-activo-codex-', 'codex-revision.json');
    const c = await crearConectorCodex({ orden: process.execPath, argsPrefijo: [SERVIDOR, rutaGuion] });
    try {
      const avances = [];
      const resultado = await c.ejecutar(encargo(dir, 'gpt-5.5', 'high'), AbortSignal.timeout(10_000), (p) => {
        avances.push(p);
        if (oyenteRoto) throw new Error('oyente roto');
      });
      assert.equal(resultado.estado, 'ok', resultado.motivo);
      assert.deepEqual(avances.at(-1), { tokens: 1500 });
      assert.equal(resultado.tokens.total, 1500);
    } finally {
      await c.cerrar();
    }
  }
});

test('el conector de Antigravity avisa de los tokens con usage_update y un oyente roto no lo rompe', async () => {
  for (const oyenteRoto of [false, true]) {
    const { dir, rutaGuion } = prepararServidor('nexakit-activo-agy-', 'acp-revision.json');
    const raiz = join(dir, 'repo');
    mkdirSync(join(raiz, '.git'), { recursive: true });
    const c = await crearConectorAntigravity({ orden: process.execPath, argsPrefijo: [SERVIDOR, rutaGuion] });
    try {
      const avances = [];
      const resultado = await c.ejecutar(encargo(raiz, 'gemini-4-argon-high', null), AbortSignal.timeout(10_000), (p) => {
        avances.push(p);
        if (oyenteRoto) throw new Error('oyente roto');
      });
      assert.equal(resultado.estado, 'ok', resultado.motivo);
      assert.deepEqual(avances.at(-1), { tokens: 1500 });
      assert.equal(resultado.tokens.total, 1500);
    } finally {
      await c.cerrar();
    }
  }
});
