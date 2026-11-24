import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gitConfigGlobalVacio } from '../test-support/git-aislado.js';
import { ejecutarEncargo, TIEMPO_ENCARGO_MS } from '../dist/fabrica/encargo/ejecutar.js';
import { ErrorFabrica } from '../dist/fabrica/errores.js';
import { aceptar, registrar } from '../dist/fabrica/lecciones.js';
import * as rastro from '../dist/fabrica/rastro.js';
import { REGLA_ORDENES_SIMPLES } from '../src/regla-ordenes-simples.js';
import { fileSymlinkSkipReason } from '../testing/symlink-capability.js';

process.env.GIT_CONFIG_GLOBAL = gitConfigGlobalVacio;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Prueba';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'prueba@example.com';

const SIN_ENLACES = process.platform === 'win32' || fileSymlinkSkipReason();
const DIA_MS = 24 * 60 * 60 * 1000;

const temporales = [];
test.after(() => {
  for (const dir of temporales) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
const modo = (ruta) => lstatSync(ruta).mode & 0o777;

/** Repo con un commit (a.txt y un package.json con `test` y `typecheck`) y un home temporal. */
function entorno() {
  const raiz = mkdtempSync(path.join(tmpdir(), 'enc-ej-repo-'));
  const home = mkdtempSync(path.join(tmpdir(), 'enc-ej-home-'));
  temporales.push(raiz, home);
  git(raiz, 'init', '-q');
  writeFileSync(path.join(raiz, 'a.txt'), 'uno\n');
  writeFileSync(path.join(raiz, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node --test', typecheck: 'tsc --noEmit' } }));
  git(raiz, 'add', '-A');
  git(raiz, 'commit', '-q', '-m', 'base');
  return { raiz, home };
}

const CATALOGO = {
  codex: [{ modelo: 'gpt-6-sol', esfuerzos: ['medium', 'high'] }],
  antigravity: [{ modelo: 'gemini-4-hydrogen-medium', esfuerzos: ['medium'] }],
};
const RECOMENDADO = {
  codex: { modelo: 'gpt-6-sol', esfuerzo: 'medium' },
  antigravity: { modelo: 'gemini-4-hydrogen-medium', esfuerzo: 'medium' },
};
const recomendar = async (ia) => RECOMENDADO[ia];

const TOKENS = { entrada: 100, salida: 50, total: 150 };
const okDe = (cambios = {}) => ({
  estado: 'ok',
  informe: { hallazgos: [], resumen: 'Hecho: cambié a.txt.' },
  crudo: 'Hecho.',
  modeloInformado: 'x',
  tokens: TOKENS,
  denegaciones: [],
  ...cambios,
});

/**
 * Fábrica de un conector falso. `ejecutar(encargo, señal, alProgreso)` hace de la IA; el registro guarda cómo se creó
 * el conector, qué encargos recibió y si se cerró.
 */
function fabrica(ia, ejecutar, { catalogo = CATALOGO[ia], fallaAlCrear, fallaCatalogo } = {}) {
  const registro = { creaciones: [], encargos: [], cerrados: 0 };
  const crear = async (escritura) => {
    registro.creaciones.push(escritura);
    if (fallaAlCrear) throw new Error(fallaAlCrear);
    return {
      ia,
      catalogo: async () => {
        if (fallaCatalogo) throw new Error(fallaCatalogo);
        return catalogo;
      },
      ejecutar: async (encargo, señal, alProgreso) => {
        registro.encargos.push(encargo);
        return ejecutar(encargo, señal, alProgreso);
      },
      cerrar: async () => {
        registro.cerrados += 1;
      },
    };
  };
  return { crear, registro };
}

const opciones = (e, extra = {}) => ({
  raiz: e.raiz,
  home: e.home,
  ia: 'codex',
  texto: 'Cambia a.txt y añade nuevo.txt.',
  recomendar,
  entorno: {},
  ...extra,
});

/** El repo real sigue como estaba y no queda ningún worktree ni carpeta `repo` del encargo. */
function comprobarLimpio(e, informe) {
  assert.equal(git(e.raiz, 'status', '--porcelain'), '', 'el repo real no cambia');
  assert.equal(git(e.raiz, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 1, 'solo queda el repo');
  const carpeta = path.join(e.home, '.nexakit', 'encargos', informe.id);
  assert.equal(existsSync(path.join(carpeta, 'repo')), false, 'el worktree se borra');
  assert.equal(existsSync(carpeta), true, 'la carpeta del encargo se conserva con el informe');
  assert.equal(existsSync(path.join(e.home, '.nexakit', 'fabrica', 'activo.json')), false, 'activo.json se retira');
  const guardado = JSON.parse(readFileSync(informe.rutaInforme, 'utf8'));
  assert.deepEqual(guardado, JSON.parse(JSON.stringify(informe)), 'informe.json es el informe devuelto');
  assert.equal(modo(informe.rutaInforme), 0o600);
  assert.equal(modo(carpeta), 0o700);
}

/** Espera a que la señal se aborte (enseguida, si ya lo está). */
const hastaAbortar = (señal) =>
  señal.aborted ? Promise.resolve() : new Promise((resolver) => señal.addEventListener('abort', resolver, { once: true }));

async function esperarHasta(condicion, motivo) {
  for (let i = 0; i < 300; i++) {
    if (condicion()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no ocurrió: ${motivo}`);
}

test('el tiempo por defecto es de 20 minutos', () => {
  assert.equal(TIEMPO_ENCARGO_MS, 20 * 60 * 1000);
});

test('devuelve el diff de un archivo modificado y uno nuevo, con permisos 0o600, y se puede aplicar', async () => {
  const e = entorno();
  await registrar(e.home, { regla: 'Escribe los textos en español', porque: 'lo pidió la persona', ambito: { proyecto: e.raiz }, origen: 'persona' }).then(
    ({ leccion }) => aceptar(e.home, leccion.id),
  );
  const activos = [];
  const codex = fabrica('codex', async (encargo, _señal, alProgreso) => {
    assert.equal(encargo.raiz, path.join(e.home, '.nexakit', 'encargos', path.basename(path.dirname(encargo.raiz)), 'repo'));
    writeFileSync(path.join(encargo.raiz, 'a.txt'), 'dos\n');
    writeFileSync(path.join(encargo.raiz, 'nuevo.txt'), 'hola\n');
    // El estado vivo muestra la estación «encargo» con IA, modelo, esfuerzo, estado y tokens.
    await esperarHasta(() => rastro.leerActivo(e.home) !== null, 'activo.json');
    alProgreso({ tokens: 42 });
    await esperarHasta(() => rastro.leerActivo(e.home)?.estaciones[0]?.tokens === 42, 'tokens en activo.json');
    activos.push(rastro.leerActivo(e.home));
    return okDe();
  });
  const informe = await ejecutarEncargo(opciones(e, { conectores: { codex: codex.crear }, intervaloActivoMs: 5 }));

  assert.equal(informe.estado, 'ok', informe.motivo);
  assert.equal(informe.ia, 'codex');
  assert.equal(informe.modelo, 'gpt-6-sol');
  assert.equal(informe.esfuerzo, 'medium');
  assert.deepEqual(informe.tokens, TOKENS);
  assert.equal(informe.tokensValidos, true);
  assert.equal(informe.resumen, 'Hecho: cambié a.txt.');
  assert.deepEqual(informe.archivos, ['a.txt', 'nuevo.txt']);
  assert.equal(informe.base, git(e.raiz, 'rev-parse', 'HEAD'));
  assert.equal(typeof informe.segundos, 'number');
  assert.deepEqual(informe.escriturasFuera, []);
  assert.deepEqual(informe.avisos, []);

  // El conector se creó en modo escritura sobre el worktree, y el encargo trae las órdenes del repo, la lección y la regla.
  const [escritura] = codex.registro.creaciones;
  const [encargo] = codex.registro.encargos;
  assert.equal(escritura.raiz, encargo.raiz);
  assert.deepEqual(escritura.ordenesPermitidas, ['npm test', 'npm run typecheck']);
  assert.deepEqual(encargo.ordenesPermitidas, ['npm test', 'npm run typecheck']);
  assert.equal(encargo.modelo, 'gpt-6-sol');
  assert.equal(encargo.esfuerzo, 'medium');
  assert.match(encargo.instrucciones, /Cambia a\.txt y añade nuevo\.txt\./u);
  assert.match(encargo.instrucciones, /Escribe los textos en español/u);
  assert.ok(encargo.instrucciones.includes(REGLA_ORDENES_SIMPLES));
  assert.equal(codex.registro.cerrados, 1);

  assert.equal(activos[0].estaciones[0].estacion, 'encargo');
  assert.equal(activos[0].estaciones[0].ia, 'codex');
  assert.equal(activos[0].estaciones[0].modelo, 'gpt-6-sol');
  assert.equal(activos[0].estaciones[0].esfuerzo, 'medium');
  assert.equal(activos[0].estaciones[0].estado, 'en-curso');

  assert.equal(informe.rutaDiff, path.join(e.home, '.nexakit', 'encargos', informe.id, 'cambios.diff'));
  assert.equal(modo(informe.rutaDiff), 0o600);
  const diff = readFileSync(informe.rutaDiff, 'utf8');
  assert.match(diff, /b\/a\.txt/u);
  assert.match(diff, /b\/nuevo\.txt/u);
  comprobarLimpio(e, informe);

  // El diff se aplica tal cual a una copia del repo.
  const destino = mkdtempSync(path.join(tmpdir(), 'enc-ej-aplicar-'));
  temporales.push(destino);
  git(destino, 'init', '-q');
  writeFileSync(path.join(destino, 'a.txt'), 'uno\n');
  git(destino, 'apply', informe.rutaDiff);
  assert.equal(readFileSync(path.join(destino, 'a.txt'), 'utf8'), 'dos\n');
  assert.equal(readFileSync(path.join(destino, 'nuevo.txt'), 'utf8'), 'hola\n');
});

test('guarda el diff como bytes: un archivo que no es UTF-8 no se corrompe', async () => {
  const e = entorno();
  const bytes = Buffer.from([0x63, 0xe9, 0x0a]);
  const codex = fabrica('codex', async (encargo) => {
    writeFileSync(path.join(encargo.raiz, 'latin1.txt'), bytes);
    return okDe();
  });
  const informe = await ejecutarEncargo(opciones(e, { conectores: { codex: codex.crear } }));
  assert.equal(informe.estado, 'ok', informe.motivo);
  assert.ok(readFileSync(informe.rutaDiff).includes(Buffer.from([0x2b, 0x63, 0xe9, 0x0a])), 'conserva el byte 0xe9');
  comprobarLimpio(e, informe);
});

test('--ordenes amplía las órdenes detectadas del repo', async () => {
  const e = entorno();
  const codex = fabrica('codex', async () => okDe());
  const informe = await ejecutarEncargo(opciones(e, { conectores: { codex: codex.crear }, ordenesPermitidas: ['npm run lint', 'npm test'] }));
  assert.deepEqual(codex.registro.creaciones[0].ordenesPermitidas, ['npm test', 'npm run typecheck', 'npm run lint']);
  assert.equal(informe.estado, 'sin-cambios');
});

test('sin cambios: no hay diff aplicable y se guarda el informe', async () => {
  const e = entorno();
  const codex = fabrica('codex', async () => okDe());
  const informe = await ejecutarEncargo(opciones(e, { conectores: { codex: codex.crear } }));
  assert.equal(informe.estado, 'sin-cambios');
  assert.equal(informe.rutaDiff, null);
  assert.equal(existsSync(path.join(e.home, '.nexakit', 'encargos', informe.id, 'cambios.diff')), false);
  assert.deepEqual(informe.archivos, []);
  comprobarLimpio(e, informe);
});

test('tiempo agotado: aborta la señal del conector, borra el worktree y no guarda diff', async () => {
  const e = entorno();
  let señalRecibida;
  const codex = fabrica('codex', async (encargo, señal) => {
    señalRecibida = señal;
    writeFileSync(path.join(encargo.raiz, 'a.txt'), 'a medias\n');
    await hastaAbortar(señal);
    return { ...okDe(), estado: 'cancelada', motivo: 'cancelada' };
  });
  const informe = await ejecutarEncargo(opciones(e, { conectores: { codex: codex.crear }, tiempoMs: 50 }));
  assert.equal(informe.estado, 'tiempo-agotado');
  assert.match(informe.motivo, /tiempo agotado/u);
  assert.equal(señalRecibida.aborted, true);
  assert.equal(informe.rutaDiff, null);
  assert.equal(codex.registro.cerrados, 1);
  comprobarLimpio(e, informe);
});

test('una IA que no responde a la cancelación no cuelga el encargo', async () => {
  const e = entorno();
  const codex = fabrica('codex', () => new Promise(() => {}));
  const informe = await ejecutarEncargo(opciones(e, { conectores: { codex: codex.crear }, tiempoMs: 30, graciaMs: 30 }));
  assert.equal(informe.estado, 'tiempo-agotado');
  assert.match(informe.motivo, /tiempo agotado; la IA no respondió a la cancelación/u);
  comprobarLimpio(e, informe);
  const control = new AbortController();
  const sorda = fabrica('codex', () => {
    setTimeout(() => control.abort(), 10);
    return new Promise(() => {});
  });
  const e2 = entorno();
  const cancelado = await ejecutarEncargo(opciones(e2, { conectores: { codex: sorda.crear }, señal: control.signal, graciaMs: 30 }));
  assert.equal(cancelado.estado, 'cancelado');
  assert.match(cancelado.motivo, /cancelado por la persona; la IA no respondió a la cancelación/u);
  comprobarLimpio(e2, cancelado);
});

test('Ctrl+C: la señal cancela el turno, se borra el worktree y no hay diff', async () => {
  const e = entorno();
  const control = new AbortController();
  const codex = fabrica('codex', async (encargo, señal) => {
    writeFileSync(path.join(encargo.raiz, 'a.txt'), 'a medias\n');
    setTimeout(() => control.abort(), 10);
    await hastaAbortar(señal);
    return { ...okDe(), estado: 'cancelada', motivo: 'cancelada' };
  });
  const informe = await ejecutarEncargo(opciones(e, { conectores: { codex: codex.crear }, señal: control.signal }));
  assert.equal(informe.estado, 'cancelado');
  assert.equal(informe.rutaDiff, null);
  comprobarLimpio(e, informe);
});

test('una señal ya abortada cancela sin lanzar el conector', async () => {
  const e = entorno();
  const control = new AbortController();
  control.abort();
  const codex = fabrica('codex', async () => okDe());
  const informe = await ejecutarEncargo(opciones(e, { conectores: { codex: codex.crear }, señal: control.signal }));
  assert.equal(informe.estado, 'cancelado');
  assert.equal(codex.registro.encargos.length, 0);
  comprobarLimpio(e, informe);
});

test('una escritura fuera del worktree invalida el encargo y no se guarda el diff', async () => {
  const e = entorno();
  const codex = fabrica('codex', async (encargo) => {
    writeFileSync(path.join(encargo.raiz, 'a.txt'), 'dos\n');
    // La IA se sale del worktree y toca el repo de la persona.
    writeFileSync(path.join(e.raiz, 'escapado.txt'), 'fuera\n');
    return okDe();
  });
  const informe = await ejecutarEncargo(opciones(e, { conectores: { codex: codex.crear } }));
  assert.equal(informe.estado, 'invalido');
  assert.ok(informe.escriturasFuera.includes('escapado.txt'), informe.escriturasFuera.join(','));
  assert.match(informe.motivo, /fuera del worktree/u);
  assert.equal(informe.rutaDiff, null);
  assert.equal(existsSync(path.join(e.home, '.nexakit', 'encargos', informe.id, 'cambios.diff')), false);
  // El repo real conserva lo que escribió la IA para que se vea; el worktree sí se borró.
  assert.equal(existsSync(path.join(e.raiz, 'escapado.txt')), true);
  assert.equal(existsSync(path.join(e.home, '.nexakit', 'encargos', informe.id, 'repo')), false);
});

test('una escritura en el repo real también invalida un encargo cancelado', async () => {
  const e = entorno();
  const control = new AbortController();
  const codex = fabrica('codex', async (_encargo, señal) => {
    writeFileSync(path.join(e.raiz, 'a.txt'), 'cambiado fuera\n');
    control.abort();
    await hastaAbortar(señal);
    return { ...okDe(), estado: 'cancelada' };
  });
  const informe = await ejecutarEncargo(opciones(e, { conectores: { codex: codex.crear }, señal: control.signal }));
  assert.equal(informe.estado, 'invalido');
  assert.ok(informe.escriturasFuera.length > 0);
});

test('IA no disponible: el encargo falla con un motivo claro y no se lanza nada', async () => {
  const e = entorno();
  const informe = await ejecutarEncargo(opciones(e, { conectores: {} }));
  assert.equal(informe.estado, 'fallido');
  assert.match(informe.motivo, /codex no está disponible/u);
  assert.equal(informe.ia, null);
  assert.equal(informe.rutaDiff, null);
  comprobarLimpio(e, informe);

  const noCrea = fabrica('codex', async () => okDe(), { fallaAlCrear: 'no se encontró el ejecutable' });
  const e2 = entorno();
  const creacion = await ejecutarEncargo(opciones(e2, { conectores: { codex: noCrea.crear } }));
  assert.equal(creacion.estado, 'fallido');
  assert.match(creacion.motivo, /codex no está disponible: no se encontró el ejecutable/u);
  comprobarLimpio(e2, creacion);

  const sinCatalogo = fabrica('codex', async () => okDe(), { fallaCatalogo: 'Codex no está instalado' });
  const e3 = entorno();
  const catalogo = await ejecutarEncargo(opciones(e3, { conectores: { codex: sinCatalogo.crear } }));
  assert.equal(catalogo.estado, 'fallido');
  assert.match(catalogo.motivo, /codex no está disponible: Codex no está instalado/u);
  assert.equal(sinCatalogo.registro.encargos.length, 0);
  assert.equal(sinCatalogo.registro.cerrados, 1, 'el conector abierto se cierra');
  comprobarLimpio(e3, catalogo);
});

test('modelo fuera del catálogo vivo o esfuerzo no admitido: falla sin lanzar la IA', async () => {
  const e = entorno();
  const codex = fabrica('codex', async () => okDe());
  const fuera = await ejecutarEncargo(opciones(e, { conectores: { codex: codex.crear }, modelo: 'gpt-9-inventado' }));
  assert.equal(fuera.estado, 'fallido');
  assert.match(fuera.motivo, /gpt-9-inventado no está en el catálogo de codex/u);
  comprobarLimpio(e, fuera);

  const e2 = entorno();
  const esfuerzo = await ejecutarEncargo(opciones(e2, { conectores: { codex: codex.crear }, modelo: 'gpt-6-sol', esfuerzo: 'xhigh' }));
  assert.equal(esfuerzo.estado, 'fallido');
  assert.match(esfuerzo.motivo, /no admite el esfuerzo xhigh/u);
  comprobarLimpio(e2, esfuerzo);

  const agy = fabrica('antigravity', async () => okDe());
  const e3 = entorno();
  const otra = await ejecutarEncargo(opciones(e3, { ia: 'antigravity', conectores: { antigravity: agy.crear }, modelo: 'gemini-4-inventado' }));
  assert.equal(otra.estado, 'fallido');
  assert.match(otra.motivo, /no está en el catálogo de antigravity/u);
  assert.equal(codex.registro.encargos.length + agy.registro.encargos.length, 0);
  comprobarLimpio(e3, otra);
});

test('un modelo indicado vale si está en el catálogo; en Codex usa el esfuerzo del nivel normal', async () => {
  const e = entorno();
  const codex = fabrica('codex', async () => okDe(), { catalogo: [{ modelo: 'gpt-6-luna', esfuerzos: ['low', 'medium'] }] });
  const informe = await ejecutarEncargo(opciones(e, { conectores: { codex: codex.crear }, modelo: 'gpt-6-luna', recomendar: async () => assert.fail('no se recomienda') }));
  assert.equal(informe.estado, 'sin-cambios');
  assert.equal(informe.modelo, 'gpt-6-luna');
  assert.equal(informe.esfuerzo, 'medium');
  assert.equal(codex.registro.encargos[0].modelo, 'gpt-6-luna');
});

test('auto elige Codex cuando está disponible y no abre Antigravity', async () => {
  const e = entorno();
  const codex = fabrica('codex', async () => okDe());
  const agy = fabrica('antigravity', async () => okDe());
  const informe = await ejecutarEncargo(opciones(e, { ia: 'auto', conectores: { codex: codex.crear, antigravity: agy.crear } }));
  assert.equal(informe.ia, 'codex');
  assert.equal(informe.modelo, 'gpt-6-sol');
  assert.equal(codex.registro.encargos.length, 1);
  assert.equal(agy.registro.creaciones.length, 0);
  comprobarLimpio(e, informe);
});

test('auto cae a Antigravity si Codex no está disponible, con su modelo recomendado y sin esfuerzo aparte', async () => {
  const e = entorno();
  const codex = fabrica('codex', async () => okDe(), { fallaCatalogo: 'Codex no está instalado' });
  const agy = fabrica('antigravity', async (encargo) => {
    writeFileSync(path.join(encargo.raiz, 'nuevo.txt'), 'hola\n');
    return okDe({ informe: { hallazgos: [], resumen: 'Añadí nuevo.txt.' } });
  });
  const informe = await ejecutarEncargo(opciones(e, { ia: 'auto', conectores: { codex: codex.crear, antigravity: agy.crear } }));
  assert.equal(informe.estado, 'ok', informe.motivo);
  assert.equal(informe.ia, 'antigravity');
  assert.equal(informe.modelo, 'gemini-4-hydrogen-medium');
  assert.equal(informe.esfuerzo, null);
  // En Antigravity las órdenes se pasan al conector, que en modo escritura no ejecuta ninguna.
  assert.deepEqual(agy.registro.creaciones[0].ordenesPermitidas, ['npm test', 'npm run typecheck']);
  assert.equal(codex.registro.encargos.length, 0);
  assert.equal(codex.registro.cerrados, 1);
  assert.equal(agy.registro.cerrados, 1);
  comprobarLimpio(e, informe);
});

test('auto sin ninguna IA disponible dice por qué falló cada una', async () => {
  const e = entorno();
  const informe = await ejecutarEncargo(opciones(e, { ia: 'auto', conectores: {} }));
  assert.equal(informe.estado, 'fallido');
  assert.match(informe.motivo, /codex no está disponible; antigravity no está disponible/u);
  comprobarLimpio(e, informe);
});

test('sin recomendación de nivel normal pide indicar el modelo', async () => {
  const e = entorno();
  const codex = fabrica('codex', async () => okDe());
  const informe = await ejecutarEncargo(opciones(e, { conectores: { codex: codex.crear }, recomendar: async () => null }));
  assert.equal(informe.estado, 'fallido');
  assert.match(informe.motivo, /no hay una recomendación de nivel normal para codex; indica --modelo/u);
  comprobarLimpio(e, informe);
});

test('la recomendación por defecto sale del catálogo local, como nexakit modelo --nivel normal', async () => {
  const e = entorno();
  const codexHome = path.join(e.home, '.codex');
  mkdirSync(codexHome);
  const modelo = (slug, descripcion, prioridad) => ({
    slug,
    description: descripcion,
    visibility: 'list',
    priority: prioridad,
    supported_reasoning_levels: ['low', 'medium', 'high'].map((effort) => ({ effort })),
  });
  writeFileSync(
    path.join(codexHome, 'models_cache.json'),
    JSON.stringify({ models: [modelo('gpt-9-luna', 'Fast and affordable', 1), modelo('gpt-9-sol', 'Everyday workhorse', 2)] }),
  );
  const codex = fabrica('codex', async () => okDe(), { catalogo: [{ modelo: 'gpt-9-sol', esfuerzos: ['low', 'medium', 'high'] }] });
  const { recomendar: _quitada, ...sinRecomendar } = opciones(e, { conectores: { codex: codex.crear } });
  const informe = await ejecutarEncargo(sinRecomendar);
  assert.equal(informe.estado, 'sin-cambios', informe.motivo);
  assert.equal(informe.modelo, 'gpt-9-sol');
  assert.equal(informe.esfuerzo, 'medium');
});

test('un conector que falla, lanza o devuelve basura deja el encargo fallido y limpio', async () => {
  const e = entorno();
  const falla = fabrica('codex', async () => okDe({ estado: 'fallida', informe: undefined, motivo: 'Codex falló: sin red' }));
  const a = await ejecutarEncargo(opciones(e, { conectores: { codex: falla.crear } }));
  assert.equal(a.estado, 'fallido');
  assert.match(a.motivo, /Codex falló: sin red/u);
  comprobarLimpio(e, a);

  const e2 = entorno();
  const lanza = fabrica('codex', async () => {
    throw new Error('se cayó');
  });
  const b = await ejecutarEncargo(opciones(e2, { conectores: { codex: lanza.crear } }));
  assert.equal(b.estado, 'fallido');
  assert.match(b.motivo, /el conector falló: se cayó/u);
  comprobarLimpio(e2, b);

  const e3 = entorno();
  const basura = fabrica('codex', async () => 'no soy un resultado');
  const c = await ejecutarEncargo(opciones(e3, { conectores: { codex: basura.crear } }));
  assert.equal(c.estado, 'fallido');
  assert.match(c.motivo, /respuesta no válida/u);
  comprobarLimpio(e3, c);
});

test('guarda las denegaciones y aprobaciones, y los tokens 0 quedan en el informe sin contar como éxito', async () => {
  const e = entorno();
  const codex = fabrica('codex', async (encargo) => {
    writeFileSync(path.join(encargo.raiz, 'nuevo.txt'), 'hola\n');
    return okDe({
      tokens: { entrada: 0, salida: 0, total: 0 },
      denegaciones: [{ tipo: 'session/request_permission', detalle: 'Permiso denegado: rm -rf (orden no permitida)' }],
      aprobaciones: [{ tipo: 'session/request_permission', detalle: 'Permiso aprobado: editar nuevo.txt' }],
    });
  });
  const informe = await ejecutarEncargo(opciones(e, { conectores: { codex: codex.crear } }));
  assert.equal(informe.estado, 'ok');
  assert.deepEqual(informe.tokens, { entrada: 0, salida: 0, total: 0 });
  assert.equal(informe.tokensValidos, false);
  assert.match(informe.avisos.join('\n'), /no informó de tokens/u);
  assert.equal(informe.denegaciones.length, 1);
  assert.equal(informe.aprobaciones.length, 1);
  comprobarLimpio(e, informe);

  const e2 = entorno();
  const sin = fabrica('codex', async (encargo) => {
    writeFileSync(path.join(encargo.raiz, 'nuevo.txt'), 'hola\n');
    return okDe({ tokens: null });
  });
  const nulos = await ejecutarEncargo(opciones(e2, { conectores: { codex: sin.crear } }));
  assert.equal(nulos.tokens, null);
  assert.equal(nulos.tokensValidos, false);
});

test('avisa de los cambios sin commit, que el encargo no incluye', async () => {
  const e = entorno();
  writeFileSync(path.join(e.raiz, 'a.txt'), 'sucio\n');
  const codex = fabrica('codex', async (encargo) => {
    assert.equal(readFileSync(path.join(encargo.raiz, 'a.txt'), 'utf8'), 'uno\n');
    return okDe();
  });
  const informe = await ejecutarEncargo(opciones(e, { conectores: { codex: codex.crear } }));
  assert.equal(informe.estado, 'sin-cambios');
  assert.match(informe.avisos.join('\n'), /sin commit/u);
  // El árbol sucio de la persona no se toca.
  assert.equal(readFileSync(path.join(e.raiz, 'a.txt'), 'utf8'), 'sucio\n');
});

test('rechaza los argumentos mal formados antes de crear nada', async () => {
  const e = entorno();
  const base = opciones(e, { conectores: {} });
  await assert.rejects(ejecutarEncargo({ ...base, texto: '   ' }), ErrorFabrica);
  await assert.rejects(ejecutarEncargo({ ...base, ia: 'gemini' }), /codex, antigravity o auto/u);
  await assert.rejects(ejecutarEncargo({ ...base, tiempoMs: 0 }), /tiempo máximo/u);
  await assert.rejects(ejecutarEncargo({ ...base, ordenesPermitidas: [''] }), /órdenes permitidas/u);
  assert.equal(existsSync(path.join(e.home, '.nexakit', 'encargos')), false);
});

test('fuera de un repo de git falla con un error claro', async () => {
  const e = entorno();
  const noRepo = mkdtempSync(path.join(tmpdir(), 'enc-ej-norepo-'));
  temporales.push(noRepo);
  await assert.rejects(ejecutarEncargo(opciones({ ...e, raiz: noRepo }, { conectores: {} })), ErrorFabrica);
});

test('los encargos de más de 90 días caducan con la limpieza del rastro y no se siguen enlaces', { skip: SIN_ENLACES }, async () => {
  const e = entorno();
  const base = path.join(e.home, '.nexakit', 'encargos');
  mkdirSync(base, { recursive: true });
  const viejo = path.join(base, 'agenda-citas-abc123');
  const reciente = path.join(base, 'api-pedidos-def456');
  const enlace = path.join(base, 'facturacion-0a1b2c');
  const ajena = mkdtempSync(path.join(tmpdir(), 'enc-ej-ajena-'));
  temporales.push(ajena);
  for (const dir of [viejo, reciente]) {
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'informe.json'), '{}');
  }
  writeFileSync(path.join(ajena, 'no-borrar.txt'), 'x');
  symlinkSync(ajena, enlace, 'dir');
  const hace = new Date(Date.now() - 91 * DIA_MS);
  utimesSync(viejo, hace, hace);
  utimesSync(enlace, hace, hace);

  await rastro.podar(e.home);
  assert.equal(existsSync(viejo), false);
  assert.equal(existsSync(reciente), true);
  assert.equal(existsSync(path.join(ajena, 'no-borrar.txt')), true);
  assert.equal(lstatSync(enlace).isSymbolicLink(), true);
});
