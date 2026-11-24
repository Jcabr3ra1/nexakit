import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitConfigGlobalVacio } from '../test-support/git-aislado.js';
import { ejecutarEncargo, rutasVetadas, TIEMPO_ENCARGO_MS } from '../dist/fabrica/encargo/ejecutar.js';
import { analizarParche } from '../dist/fabrica/encargo/parche.js';
import { barrerHuerfanos, borrarWorktree, crearWorktree, diffDelWorktree } from '../dist/fabrica/encargo/worktree.js';
import { leerCandado } from '../dist/fabrica/encargo/candado.js';
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
const POSIX = process.platform !== 'win32';
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
  if (POSIX) {
    assert.equal(modo(informe.rutaInforme), 0o600);
    assert.equal(modo(carpeta), 0o700);
  }
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
  if (POSIX) assert.equal(modo(informe.rutaDiff), 0o600);
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
  assert.match(informe.avisos.join('\n'), /IA descartada: codex no está disponible: Codex no está instalado/u);
  // El texto no promete órdenes que Antigravity rechaza.
  assert.match(agy.registro.encargos[0].instrucciones, /No se aprueba ninguna orden/u);
  assert.doesNotMatch(agy.registro.encargos[0].instrucciones, /Solo se aprueban estas órdenes/u);
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
  // Los tokens 0 no se registran.
  assert.equal(informe.tokens, null);
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

test('un Ctrl+C justo después de elegir la IA y antes del turno cancela sin lanzarlo', async () => {
  const e = entorno();
  const control = new AbortController();
  const codex = fabrica('codex', async () => assert.fail('el turno no debe empezar'));
  // Tras devolver la recomendación solo hay microtareas hasta la última comprobación: el aborto cae después de ella.
  const informe = await ejecutarEncargo(
    opciones(e, {
      conectores: { codex: codex.crear },
      señal: control.signal,
      recomendar: async (ia) => {
        setImmediate(() => control.abort());
        return RECOMENDADO[ia];
      },
    }),
  );
  assert.equal(informe.estado, 'cancelado');
  assert.equal(codex.registro.encargos.length, 0);
  assert.ok(informe.segundos < 20, 'no espera al tope de tiempo');
  comprobarLimpio(e, informe);
});

test('un enlace simbólico hacia fuera del repo invalida el encargo; uno que se queda dentro vale', { skip: SIN_ENLACES }, async () => {
  for (const destino of ['/etc/hosts', '../../fuera', 'sub/../../fuera', 'C:\\Windows\\win.ini']) {
    const e = entorno();
    const codex = fabrica('codex', async (encargo) => {
      writeFileSync(path.join(encargo.raiz, 'nuevo.txt'), 'hola\n');
      symlinkSync(destino, path.join(encargo.raiz, 'enlace'));
      return okDe();
    });
    const informe = await ejecutarEncargo(opciones(e, { conectores: { codex: codex.crear } }));
    assert.equal(informe.estado, 'invalido', destino);
    assert.equal(informe.rutaDiff, null);
    assert.equal(existsSync(path.join(e.home, '.nexakit', 'encargos', informe.id, 'cambios.diff')), false);
    assert.equal(informe.rutasVetadas.length, 1);
    assert.match(informe.rutasVetadas[0], /^enlace \(enlace simbólico hacia fuera del repo/u);
    assert.match(informe.motivo, /enlace simbólico hacia fuera del repo/u);
    comprobarLimpio(e, informe);
  }
  const e = entorno();
  const dentro = fabrica('codex', async (encargo) => {
    symlinkSync('a.txt', path.join(encargo.raiz, 'dentro'));
    mkdirSync(path.join(encargo.raiz, 'sub'));
    symlinkSync('../a.txt', path.join(encargo.raiz, 'sub', 'otro'));
    return okDe();
  });
  const informe = await ejecutarEncargo(opciones(e, { conectores: { codex: dentro.crear } }));
  assert.equal(informe.estado, 'ok', informe.motivo);
  assert.deepEqual(informe.rutasVetadas, []);
  assert.deepEqual(informe.archivos, ['dentro', 'sub/otro']);
});

test('un enlace simbólico que apunta dentro del repo pero a un componente protegido invalida el encargo', { skip: SIN_ENLACES }, async () => {
  for (const [destino, ruta] of [['.git/hooks', 'x'], ['.claude', 'y'], ['./.github/workflows/ci.yml', 'z'], ['../.codex', 'sub/w']]) {
    const e = entorno();
    const codex = fabrica('codex', async (encargo) => {
      mkdirSync(path.dirname(path.join(encargo.raiz, ruta)), { recursive: true });
      symlinkSync(destino, path.join(encargo.raiz, ruta));
      return okDe();
    });
    const informe = await ejecutarEncargo(opciones(e, { conectores: { codex: codex.crear } }));
    assert.equal(informe.estado, 'invalido', destino);
    assert.equal(informe.rutaDiff, null);
    assert.equal(informe.rutasVetadas.length, 1, informe.rutasVetadas.join('|'));
    assert.match(informe.rutasVetadas[0], new RegExp(`^${ruta} \\(enlace simbólico hacia una ruta protegida`, 'u'));
    comprobarLimpio(e, informe);
  }
});

/** Pid de un proceso que ya terminó. */
const pidMuerto = () => {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(r.stdout);
};

test('al empezar un encargo se borran los worktrees huérfanos de procesos muertos y no los de procesos vivos', async () => {
  const e = entorno();
  const muerto = await crearWorktree(e.raiz, e.home);
  const vivo = await crearWorktree(e.raiz, e.home);
  const sinCandado = path.join(e.home, '.nexakit', 'encargos', 'sin-candado');
  mkdirSync(path.join(sinCandado, 'repo'), { recursive: true });
  writeFileSync(path.join(sinCandado, 'repo', 'x'), 'x');
  if (POSIX) assert.equal(modo(path.join(path.dirname(muerto.dir), 'candado.json')), 0o600);
  writeFileSync(path.join(path.dirname(muerto.dir), 'candado.json'), JSON.stringify({ pid: pidMuerto(), raiz: e.raiz }));
  writeFileSync(path.join(path.dirname(muerto.dir), 'informe.json'), '{}');

  const codex = fabrica('codex', async () => okDe());
  const informe = await ejecutarEncargo(opciones(e, { conectores: { codex: codex.crear } }));
  assert.equal(informe.estado, 'sin-cambios');
  assert.equal(existsSync(muerto.dir), false, 'el worktree del proceso muerto se borra');
  assert.equal(existsSync(path.join(path.dirname(muerto.dir), 'informe.json')), true, 'su informe se conserva');
  assert.equal(existsSync(vivo.dir), true, 'el del proceso vivo (este) se respeta');
  assert.equal(existsSync(path.join(sinCandado, 'repo', 'x')), true, 'sin candado y reciente se respeta');
  assert.ok(informe.avisos.some((a) => /huérfano/u.test(a)), informe.avisos.join('|'));
  assert.equal(git(e.raiz, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 2, 'repo y el vivo');
  assert.equal(git(e.raiz, 'status', '--porcelain'), '');

  // Pasada la gracia, una carpeta sin candado también es huérfana.
  const avisos = await barrerHuerfanos(e.home, Date.now() + 10 * 60_000);
  assert.equal(existsSync(path.join(sinCandado, 'repo')), false);
  assert.equal(existsSync(vivo.dir), true, 'el vivo sigue aunque pase el tiempo');
  assert.equal(avisos.length, 1);
});

test('el barrido de huérfanos no sigue enlaces ni toca nada fuera de ~/.nexakit/encargos', { skip: SIN_ENLACES }, async () => {
  const e = entorno();
  const fuera = mkdtempSync(path.join(tmpdir(), 'enc-fuera-'));
  temporales.push(fuera);
  writeFileSync(path.join(fuera, 'valioso.txt'), 'no me borres');
  const encargos = path.join(e.home, '.nexakit', 'encargos');
  // `repo` es un enlace a una carpeta ajena, y una carpeta de encargo entera es un enlace.
  mkdirSync(path.join(encargos, 'a'), { recursive: true });
  symlinkSync(fuera, path.join(encargos, 'a', 'repo'));
  writeFileSync(path.join(encargos, 'a', 'candado.json'), JSON.stringify({ pid: pidMuerto(), raiz: e.raiz }));
  symlinkSync(fuera, path.join(encargos, 'b'));
  const avisos = await barrerHuerfanos(e.home, Date.now() + 10 * 60_000);
  assert.deepEqual(avisos, []);
  assert.equal(readFileSync(path.join(fuera, 'valioso.txt'), 'utf8'), 'no me borres');
  assert.equal(lstatSync(path.join(encargos, 'a', 'repo')).isSymbolicLink(), true);
  // Si `encargos` mismo es un enlace, no se barre.
  const home2 = mkdtempSync(path.join(tmpdir(), 'enc-home2-'));
  temporales.push(home2);
  mkdirSync(path.join(home2, '.nexakit'), { recursive: true });
  symlinkSync(encargos, path.join(home2, '.nexakit', 'encargos'));
  assert.deepEqual(await barrerHuerfanos(home2, Date.now() + 10 * 60_000), []);
});

test('un enlace a la raíz del repo o a .github también invalida el encargo', { skip: SIN_ENLACES }, async () => {
  for (const [destino, ruta] of [['.', 'x'], ['.github', 'y'], ['./', 'z'], ['sub/..', 'w']]) {
    const e = entorno();
    const codex = fabrica('codex', async (encargo) => {
      symlinkSync(destino, path.join(encargo.raiz, ruta));
      return okDe();
    });
    const informe = await ejecutarEncargo(opciones(e, { conectores: { codex: codex.crear } }));
    assert.equal(informe.estado, 'invalido', destino);
    assert.match(informe.rutasVetadas.join('|'), /enlace simbólico hacia una ruta protegida/u, destino);
    comprobarLimpio(e, informe);
  }
});

const vivoAjeno = process.ppid;

test('el candado global de encargos: se toma con pid, id y fecha, se libera siempre y bloquea a otro encargo vivo', async () => {
  const e = entorno();
  const archivo = path.join(e.home, '.nexakit', 'encargos', '.candado');
  let visto;
  const codex = fabrica('codex', async () => {
    visto = { datos: leerCandado(e.home), modo: modo(archivo) };
    return okDe();
  });
  const informe = await ejecutarEncargo(opciones(e, { conectores: { codex: codex.crear } }));
  assert.equal(visto.datos.pid, process.pid);
  assert.equal(visto.datos.id, informe.id);
  assert.ok(Number.isFinite(Date.parse(visto.datos.fecha)));
  if (POSIX) assert.equal(visto.modo, 0o600);
  assert.equal(existsSync(archivo), false, 'se libera al terminar');

  // Con un proceso vivo que lo tiene, no arranca nada (ni siquiera el conector) y el candado ajeno no se toca.
  writeFileSync(archivo, JSON.stringify({ pid: vivoAjeno, id: 'otro-abcdef', fecha: new Date().toISOString() }));
  const otro = fabrica('codex', async () => okDe());
  await assert.rejects(ejecutarEncargo(opciones(e, { conectores: { codex: otro.crear } })), /Ya hay un encargo en curso \(otro-abcdef/u);
  assert.equal(otro.registro.creaciones.length, 0);
  assert.equal(JSON.parse(readFileSync(archivo, 'utf8')).pid, vivoAjeno, 'el candado de otro no se libera');

  // Un candado de un proceso muerto, o ilegible, se sustituye.
  for (const viejo of [JSON.stringify({ pid: pidMuerto(), id: null, fecha: '' }), 'basura']) {
    writeFileSync(archivo, viejo);
    const nuevo = fabrica('codex', async () => okDe());
    const r = await ejecutarEncargo(opciones(e, { conectores: { codex: nuevo.crear } }));
    assert.equal(r.estado, 'sin-cambios');
    assert.equal(existsSync(archivo), false);
  }
});

test('dos encargos simultáneos en el mismo proceso: solo uno toma el candado', async () => {
  const e = entorno();
  let soltar;
  const espera = new Promise((resolver) => { soltar = resolver; });
  const lento = fabrica('codex', async () => { await espera; return okDe(); });
  const primero = ejecutarEncargo(opciones(e, { conectores: { codex: lento.crear } }));
  await esperarHasta(() => lento.registro.encargos.length === 1, 'el primero arranca');
  const rapido = fabrica('codex', async () => okDe());
  await assert.rejects(ejecutarEncargo(opciones(e, { conectores: { codex: rapido.crear } })), /Ya hay un encargo en curso/u);
  soltar();
  assert.equal((await primero).estado, 'sin-cambios');
  assert.equal(existsSync(path.join(e.home, '.nexakit', 'encargos', '.candado')), false);
});

test('un recorrido vivo de otro proceso en activo.json impide el encargo y libera el candado; el propio pid no', async () => {
  const e = entorno();
  const activo = (pid) => ({ pid, id: 'fab-20260101-0000-abcd', repo: 'demo', actualizado: new Date().toISOString(), estaciones: [] });
  mkdirSync(path.join(e.home, '.nexakit', 'fabrica'), { recursive: true, mode: 0o700 });
  const archivoActivo = path.join(e.home, '.nexakit', 'fabrica', 'activo.json');
  writeFileSync(archivoActivo, JSON.stringify(activo(vivoAjeno)));
  const codex = fabrica('codex', async () => okDe());
  await assert.rejects(ejecutarEncargo(opciones(e, { conectores: { codex: codex.crear } })), /Ya hay un recorrido o encargo en curso/u);
  assert.equal(codex.registro.creaciones.length, 0);
  assert.equal(existsSync(path.join(e.home, '.nexakit', 'encargos', '.candado')), false, 'el candado se libera tras el rechazo');
  writeFileSync(archivoActivo, JSON.stringify(activo(pidMuerto())));
  assert.equal((await ejecutarEncargo(opciones(e, { conectores: { codex: codex.crear } }))).estado, 'sin-cambios');
});

test('el informe separa las órdenes por defecto del repo de las extra', async () => {
  const e = entorno();
  const codex = fabrica('codex', async () => okDe());
  const informe = await ejecutarEncargo(opciones(e, { conectores: { codex: codex.crear }, ordenesPermitidas: ['npm run lint', ' npm run lint '] }));
  assert.deepEqual(informe.ordenesPorDefecto, ['npm test', 'npm run typecheck']);
  assert.deepEqual(informe.ordenesExtra, ['npm run lint']);
  assert.deepEqual(codex.registro.encargos[0].ordenesPermitidas, ['npm test', 'npm run typecheck', 'npm run lint']);
});

test('con ~/.nexakit como enlace no se toma el candado, no se barre y no se escribe fuera', { skip: SIN_ENLACES }, async () => {
  const e = entorno();
  const real = mkdtempSync(path.join(tmpdir(), 'enc-nexakit-real-'));
  temporales.push(real);
  const cuelga = path.join(real, 'encargos', 'a');
  mkdirSync(path.join(cuelga, 'repo'), { recursive: true });
  writeFileSync(path.join(cuelga, 'repo', 'valioso.txt'), 'no me borres');
  writeFileSync(path.join(cuelga, 'candado.json'), JSON.stringify({ pid: pidMuerto(), raiz: e.raiz }));
  symlinkSync(real, path.join(e.home, '.nexakit'));
  assert.deepEqual(await barrerHuerfanos(e.home, Date.now() + 10 * 60_000), []);
  const codex = fabrica('codex', async () => okDe());
  await assert.rejects(ejecutarEncargo(opciones(e, { conectores: { codex: codex.crear } })), /no sigue enlaces/u);
  assert.equal(codex.registro.creaciones.length, 0);
  assert.equal(readFileSync(path.join(cuelga, 'repo', 'valioso.txt'), 'utf8'), 'no me borres');
  assert.equal(existsSync(path.join(real, 'encargos', '.candado')), false);
});

test('el barrido solo ejecuta git en la raíz del candado si ese repo tiene registrado el worktree', async () => {
  const a = entorno();
  const b = entorno();
  const huerfano = await crearWorktree(a.raiz, a.home);
  // En el repo ajeno hay una entrada de worktree ya rota que un `prune` limpiaría.
  const ajeno = await crearWorktree(b.raiz, b.home);
  rmSync(ajeno.dir, { recursive: true, force: true });
  const antes = git(b.raiz, 'worktree', 'list', '--porcelain');
  assert.match(antes, /prunable/u);
  writeFileSync(path.join(path.dirname(huerfano.dir), 'candado.json'), JSON.stringify({ pid: pidMuerto(), raiz: b.raiz }));
  const avisos = await barrerHuerfanos(a.home);
  assert.equal(existsSync(huerfano.dir), false, 'la carpeta bajo encargos se borra');
  assert.equal(avisos.length, 1);
  assert.equal(git(b.raiz, 'worktree', 'list', '--porcelain'), antes, 'el repo ajeno no se toca (ni remove ni prune)');
});

test('un cambio en rutas sensibles (.claude, .husky, .github/workflows...) invalida el encargo con la lista', async () => {
  const e = entorno();
  const codex = fabrica('codex', async (encargo) => {
    const escribir = (relativa, texto) => {
      mkdirSync(path.dirname(path.join(encargo.raiz, relativa)), { recursive: true });
      writeFileSync(path.join(encargo.raiz, relativa), texto);
    };
    escribir('.claude/settings.json', '{}');
    escribir('.HUSKY/pre-commit', 'echo hola');
    escribir('.github/workflows/ci.yml', 'on: push');
    escribir('src/.codex/config.toml', 'x');
    escribir('src/claude.md', 'esta sí vale');
    return okDe();
  });
  const informe = await ejecutarEncargo(opciones(e, { conectores: { codex: codex.crear } }));
  assert.equal(informe.estado, 'invalido');
  assert.equal(informe.rutaDiff, null);
  assert.deepEqual(informe.rutasVetadas.map((v) => v.split(' ')[0]).sort(), [
    '.HUSKY/pre-commit',
    '.claude/settings.json',
    '.github/workflows/ci.yml',
    'src/.codex/config.toml',
  ]);
  assert.match(informe.motivo, /\.claude\/settings\.json/u);
  comprobarLimpio(e, informe);

  // Un archivo normal con otro nombre parecido sí se entrega.
  const e2 = entorno();
  const normal = fabrica('codex', async (encargo) => {
    mkdirSync(path.join(encargo.raiz, 'github', 'workflows'), { recursive: true });
    writeFileSync(path.join(encargo.raiz, 'github', 'workflows', 'doc.md'), 'x');
    return okDe();
  });
  const bueno = await ejecutarEncargo(opciones(e2, { conectores: { codex: normal.crear } }));
  assert.equal(bueno.estado, 'ok', bueno.motivo);
});

test('si se lanza desde una subcarpeta usa la raíz del repo: una escritura fuera de la subcarpeta se detecta', async () => {
  const e = entorno();
  mkdirSync(path.join(e.raiz, 'sub'));
  writeFileSync(path.join(e.raiz, 'sub', 'x.txt'), 'x\n');
  git(e.raiz, 'add', '-A');
  git(e.raiz, 'commit', '-q', '-m', 'sub');
  const sub = path.join(e.raiz, 'sub');
  const codex = fabrica('codex', async () => {
    writeFileSync(path.join(e.raiz, 'escapado.txt'), 'fuera\n');
    return okDe();
  });
  const informe = await ejecutarEncargo(opciones(e, { raiz: sub, conectores: { codex: codex.crear } }));
  assert.equal(informe.estado, 'invalido');
  assert.ok(informe.escriturasFuera.includes('escapado.txt'), informe.escriturasFuera.join(','));

  const e2 = entorno();
  mkdirSync(path.join(e2.raiz, 'sub'));
  const limpio = fabrica('codex', async (encargo) => {
    writeFileSync(path.join(encargo.raiz, 'a.txt'), 'dos\n');
    return okDe();
  });
  const bueno = await ejecutarEncargo(opciones(e2, { raiz: path.join(e2.raiz, 'sub'), conectores: { codex: limpio.crear } }));
  assert.equal(bueno.estado, 'ok', bueno.motivo);
  assert.deepEqual(bueno.archivos, ['a.txt']);
});

test('el hook post-checkout del repo real no corre al crear el worktree', { skip: process.platform === 'win32' }, async () => {
  const e = entorno();
  const hook = path.join(e.raiz, '.git', 'hooks', 'post-checkout');
  mkdirSync(path.dirname(hook), { recursive: true });
  writeFileSync(hook, `#!/bin/sh\necho corrió > "${path.join(e.raiz, 'hook-corrio.txt')}"\n`);
  chmodSync(hook, 0o755);
  const codex = fabrica('codex', async () => okDe());
  const informe = await ejecutarEncargo(opciones(e, { conectores: { codex: codex.crear } }));
  assert.equal(informe.estado, 'sin-cambios', informe.motivo);
  assert.equal(existsSync(path.join(e.raiz, 'hook-corrio.txt')), false);
});

// ---------------------------------------------------------------------------------------------
// Repo git anidado, análisis sobre el parche guardado, alertas y carpeta temporal

/** Crea en `dir` un repo con un commit, un filtro `clean` que crea `testigo` y un archivo sucio que obliga a pasarlo. */
function repoAnidadoConFiltro(dir, testigo) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  writeFileSync(path.join(dir, 'f.txt'), 'hola\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'sub');
  git(dir, 'config', 'filter.testigo.clean', `"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1], 'x')" "${testigo}"`);
  writeFileSync(path.join(dir, '.gitattributes'), '* filter=testigo\n');
  // Mismo tamaño y otra fecha: git tiene que leer el contenido (y pasar el filtro) para saber si cambió.
  writeFileSync(path.join(dir, 'f.txt'), 'HOLA\n');
  const hace = new Date(Date.now() - 3_600_000);
  utimesSync(path.join(dir, 'f.txt'), hace, hace);
}

test('un repo git anidado (carpeta .git) invalida el encargo sin ejecutar git sobre la copia: su filtro no corre', async () => {
  const e = entorno();
  const testigo = path.join(e.home, 'testigo-filtro');
  let explotable = false;
  const codex = fabrica('codex', async (encargo) => {
    writeFileSync(path.join(encargo.raiz, 'a.txt'), 'dos\n');
    repoAnidadoConFiltro(path.join(encargo.raiz, 'sub'), testigo);
    // Comprobación previa: sin las protecciones, un `git diff` sobre la copia sí ejecutaría el filtro del repo anidado.
    try {
      git(encargo.raiz, '-c', 'advice.addEmbeddedRepo=false', 'add', '-N', '--all', '--', '.');
      git(encargo.raiz, 'diff', 'HEAD', '--');
    } catch {}
    explotable = existsSync(testigo);
    try {
      git(encargo.raiz, 'reset', '-q');
    } catch {}
    rmSync(testigo, { force: true });
    return okDe();
  });
  const informe = await ejecutarEncargo(opciones(e, { conectores: { codex: codex.crear } }));
  assert.equal(informe.estado, 'invalido');
  assert.match(informe.motivo, /repo git anidado en sub\/\.git/u);
  assert.deepEqual(informe.rutasVetadas, ['sub/.git (repo git anidado)']);
  assert.equal(informe.rutaDiff, null);
  assert.equal(existsSync(testigo), false, 'el filtro clean del repo anidado no debe ejecutarse');
  comprobarLimpio(e, informe);
  if (!explotable) console.log('aviso: esta versión de git no ejecutó el filtro en la comprobación previa');
});

test('un .git anidado como archivo (gitdir:) o con otra caja también invalida el encargo', async () => {
  for (const [ruta, crear] of [
    ['x/y/.git', (raiz, testigo) => {
      const gitdir = mkdtempSync(path.join(tmpdir(), 'enc-ej-gitdir-'));
      temporales.push(gitdir);
      repoAnidadoConFiltro(gitdir, testigo);
      mkdirSync(path.join(raiz, 'x', 'y'), { recursive: true });
      writeFileSync(path.join(raiz, 'x', 'y', '.git'), `gitdir: ${path.join(gitdir, '.git')}\n`);
      writeFileSync(path.join(raiz, 'x', 'y', 'f.txt'), 'HOLA\n');
      writeFileSync(path.join(raiz, 'x', 'y', '.gitattributes'), '* filter=testigo\n');
    }],
    ['z/.GIT', (raiz) => {
      mkdirSync(path.join(raiz, 'z', '.GIT'), { recursive: true });
    }],
  ]) {
    const e = entorno();
    const testigo = path.join(e.home, 'testigo-filtro');
    const codex = fabrica('codex', async (encargo) => {
      crear(encargo.raiz, testigo);
      rmSync(testigo, { force: true });
      return okDe();
    });
    const informe = await ejecutarEncargo(opciones(e, { conectores: { codex: codex.crear } }));
    assert.equal(informe.estado, 'invalido', ruta);
    assert.deepEqual(informe.rutasVetadas, [`${ruta} (repo git anidado)`]);
    assert.equal(existsSync(testigo), false, ruta);
    comprobarLimpio(e, informe);
  }
});

test('rutasVetadas veta gitlinks (modo 160000), enlaces sin destino legible y entradas que no se pueden analizar', () => {
  const vetadas = rutasVetadas([
    { ruta: 'vendor/lib', modo: '160000' },
    { ruta: 'enlace', modo: '120000', destino: null },
    { ruta: '', modo: '' },
    { ruta: 'normal.txt', modo: '100644' },
    { ruta: 'dentro', modo: '120000', destino: 'normal.txt' },
    { ruta: 'gh', modo: '120000', destino: '.GitHub.' },
  ]);
  assert.deepEqual(vetadas.map((v) => v.split(' (')[0]), ['vendor/lib', 'enlace', '(sin ruta)', 'gh']);
  assert.match(vetadas[0], /modo 160000/u);
  assert.match(vetadas[1], /no se pudo leer del diff/u);
  assert.match(vetadas[2], /no se pudo analizar/u);
  assert.match(vetadas[3], /apunta a \.github/u);
});

test('el análisis sale del diff guardado: cambiar el disco después no cambia el veredicto', { skip: SIN_ENLACES }, async () => {
  const e = entorno();
  const w = await crearWorktree(e.raiz, e.home);
  try {
    symlinkSync('/etc/hosts', path.join(w.dir, 'enlace'));
    const diff = await diffDelWorktree(w);
    // Tras guardar el diff, alguien cambia el enlace en el disco por uno inofensivo.
    rmSync(path.join(w.dir, 'enlace'));
    symlinkSync('a.txt', path.join(w.dir, 'enlace'));
    const entradas = analizarParche(diff);
    assert.deepEqual(entradas, [{ ruta: 'enlace', modo: '120000', destino: '/etc/hosts' }]);
    assert.match(rutasVetadas(entradas)[0], /^enlace \(enlace simbólico hacia fuera del repo: \/etc\/hosts\)/u);
  } finally {
    await borrarWorktree(w);
  }
});

test('analizarParche lee rutas con espacios y comillas, borrados, modos y destinos de enlace; un destino de varias líneas no se acepta', { skip: SIN_ENLACES }, async () => {
  const e = entorno();
  writeFileSync(path.join(e.raiz, 'borrar.txt'), 'x\n');
  writeFileSync(path.join(e.raiz, 'script.sh'), 'echo\n');
  git(e.raiz, 'add', '-A');
  git(e.raiz, 'commit', '-q', '-m', 'mas');
  const w = await crearWorktree(e.raiz, e.home);
  try {
    writeFileSync(path.join(w.dir, 'con espacio.txt'), 'hola\n');
    writeFileSync(path.join(w.dir, 'raro"q.txt'), 'x\n');
    rmSync(path.join(w.dir, 'borrar.txt'));
    chmodSync(path.join(w.dir, 'script.sh'), 0o755);
    symlinkSync('a.txt', path.join(w.dir, 'b c'));
    symlinkSync('uno\ndos', path.join(w.dir, 'multi'));
    writeFileSync(path.join(w.dir, 'datos.bin'), Buffer.from([0, 1, 2, 0]));
    const entradas = analizarParche(await diffDelWorktree(w));
    const por = Object.fromEntries(entradas.map((x) => [x.ruta, x]));
    assert.deepEqual(por['b c'], { ruta: 'b c', modo: '120000', destino: 'a.txt' });
    assert.equal(por['borrar.txt'].modo, '000000');
    assert.equal(por['con espacio.txt'].modo, '100644');
    assert.equal(por['datos.bin'].modo, '100644');
    assert.equal(por['raro"q.txt'].modo, '100644');
    if (process.platform !== 'win32') assert.equal(por['script.sh'].modo, '100755');
    assert.deepEqual(por.multi, { ruta: 'multi', modo: '120000', destino: null });
    assert.match(rutasVetadas(entradas).join('|'), /^multi \(enlace simbólico cuyo destino no se pudo leer del diff\)$/u);
  } finally {
    await borrarWorktree(w);
  }
});

test('los cambios en instrucciones y configuración no invalidan el encargo, pero salen en alertas', async () => {
  const e = entorno();
  const codex = fabrica('codex', async (encargo) => {
    const escribir = (relativa, texto) => {
      mkdirSync(path.dirname(path.join(encargo.raiz, relativa)), { recursive: true });
      writeFileSync(path.join(encargo.raiz, relativa), texto);
    };
    escribir('CLAUDE.md', 'nuevas instrucciones');
    escribir('src/AGENTS.md', 'x');
    escribir('GEMINI.md', 'x');
    escribir('.envrc', 'export A=1');
    escribir('pkg/.npmrc', 'registry=x');
    escribir('.devcontainer/devcontainer.json', '{}');
    escribir('.cursor/rules.md', 'x');
    escribir('.idea/workspace.xml', 'x');
    escribir('normal.txt', 'x');
    return okDe();
  });
  const informe = await ejecutarEncargo(opciones(e, { conectores: { codex: codex.crear } }));
  assert.equal(informe.estado, 'ok', informe.motivo);
  assert.deepEqual(informe.rutasVetadas, []);
  assert.deepEqual(informe.alertas.map((a) => a.split(' ')[0]).sort(), [
    '.cursor/rules.md',
    '.devcontainer/devcontainer.json',
    '.envrc',
    '.idea/workspace.xml',
    'CLAUDE.md',
    'GEMINI.md',
    'pkg/.npmrc',
    'src/AGENTS.md',
  ]);
  assert.match(informe.alertas[0], /requiere revisión explícita/u);
  assert.ok(informe.rutaDiff !== null);
  comprobarLimpio(e, informe);
  // Sin esos archivos, no hay alertas.
  const e2 = entorno();
  const limpio = fabrica('codex', async (encargo) => {
    writeFileSync(path.join(encargo.raiz, 'a.txt'), 'dos\n');
    return okDe();
  });
  assert.deepEqual((await ejecutarEncargo(opciones(e2, { conectores: { codex: limpio.crear } }))).alertas, []);
});

test('el conector recibe una carpeta temporal propia fuera de la copia, 0o700, que se borra con el encargo', async () => {
  const e = entorno();
  let visto;
  const codex = fabrica('codex', async (encargo) => {
    const tmp = codex.registro.creaciones[0].tmp;
    writeFileSync(path.join(tmp, 'prueba.tmp'), 'x');
    visto = { tmp, existe: existsSync(tmp), modo: modo(tmp), raiz: encargo.raiz };
    return okDe();
  });
  const informe = await ejecutarEncargo(opciones(e, { conectores: { codex: codex.crear } }));
  assert.equal(informe.estado, 'sin-cambios', informe.motivo);
  assert.equal(visto.tmp, path.join(e.home, '.nexakit', 'encargos', informe.id, 'tmp'));
  assert.equal(path.dirname(visto.tmp), path.dirname(visto.raiz), 'junto a la copia, no dentro');
  assert.equal(visto.existe, true);
  if (POSIX) assert.equal(visto.modo, 0o700);
  assert.equal(existsSync(visto.tmp), false, 'se borra al terminar');
  comprobarLimpio(e, informe);
});

test('la poda de encargos caducados quita su worktree con git solo si el repo del candado lo tiene registrado y respeta los vivos', async () => {
  const a = entorno();
  const b = entorno();
  const viejo = await crearWorktree(a.raiz, a.home);
  const ajeno = await crearWorktree(a.raiz, a.home);
  const vivo = await crearWorktree(a.raiz, a.home);
  // En el repo b hay una entrada de worktree rota que un `prune` en b limpiaría.
  const roto = await crearWorktree(b.raiz, b.home);
  rmSync(roto.dir, { recursive: true, force: true });
  const antesB = git(b.raiz, 'worktree', 'list', '--porcelain');
  writeFileSync(path.join(path.dirname(viejo.dir), 'candado.json'), JSON.stringify({ pid: pidMuerto(), raiz: a.raiz }));
  writeFileSync(path.join(path.dirname(ajeno.dir), 'candado.json'), JSON.stringify({ pid: pidMuerto(), raiz: b.raiz }));
  const hace = new Date(Date.now() - 91 * DIA_MS);
  for (const w of [viejo, ajeno, vivo]) utimesSync(path.dirname(w.dir), hace, hace);

  await rastro.podarEncargos(a.home);
  assert.equal(existsSync(path.dirname(viejo.dir)), false, 'el caducado se borra entero');
  assert.equal(existsSync(path.dirname(ajeno.dir)), false, 'el de candado ajeno también, pero sin tocar ese repo');
  assert.equal(existsSync(vivo.dir), true, 'el de un proceso vivo se respeta aunque haya caducado');
  const listado = git(a.raiz, 'worktree', 'list', '--porcelain');
  assert.doesNotMatch(listado, new RegExp(viejo.id), 'el registro del caducado se limpia en su repo');
  assert.match(listado, new RegExp(vivo.id));
  assert.equal(git(b.raiz, 'worktree', 'list', '--porcelain'), antesB, 'el repo ajeno no se toca (ni remove ni prune)');
});

test('sin conectores inyectados, el conector real de Codex (con NEXAKIT_FABRICA_CODEX) recibe la copia como raíz escribible', async () => {
  const e = entorno();
  const guiones = fileURLToPath(new URL('../test-support/fabrica/', import.meta.url));
  const servidor = path.join(guiones, 'servidor-falso.mjs');
  const catalogo = JSON.parse(readFileSync(path.join(guiones, 'codex-catalogo.json'), 'utf8'));
  const revision = JSON.parse(readFileSync(path.join(guiones, 'codex-revision.json'), 'utf8'));
  const dir = mkdtempSync(path.join(tmpdir(), 'enc-ej-integracion-'));
  temporales.push(dir);
  const registro = path.join(dir, 'registro.ndjson');
  const registroEnv = path.join(dir, 'env.json');
  const rutaGuion = path.join(dir, 'guion.json');
  // En macOS el conector exige que Codex active el perfil de lectura acotada; en otras plataformas se ignora.
  const hiloConPerfil = {
    ...revision.metodos['thread/start'],
    resultado: { ...revision.metodos['thread/start'].resultado, activePermissionProfile: { id: 'nexakit-encargo', extends: null } },
  };
  writeFileSync(rutaGuion, JSON.stringify({
    ...revision,
    metodos: { ...revision.metodos, 'thread/start': hiloConPerfil, 'model/list': catalogo.metodos['model/list'] },
    registro,
    registroEnv,
  }));
  // CODEX_HOME de pruebas: el home aislado del modo escritura nunca enlaza el auth.json de la persona.
  const codexHome = path.join(dir, 'codex-home');
  mkdirSync(codexHome);
  writeFileSync(path.join(codexHome, 'auth.json'), '{}');
  const previo = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  let informe;
  try {
    informe = await ejecutarEncargo(
      opciones(e, {
        entorno: { NEXAKIT_FABRICA_CODEX: JSON.stringify([process.execPath, servidor, rutaGuion]) },
        modelo: 'gpt-5.5',
        esfuerzo: 'high',
      }),
    );
  } finally {
    if (previo === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previo;
  }
  assert.equal(informe.estado, 'sin-cambios', informe.motivo);
  assert.equal(informe.ia, 'codex');
  const mensajes = readFileSync(registro, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const hilo = mensajes.find((m) => m.method === 'thread/start').params;
  const turno = mensajes.find((m) => m.method === 'turn/start').params;
  const carpeta = path.join(realpathSync(e.home), '.nexakit', 'encargos', informe.id);
  const copia = path.join(carpeta, 'repo');
  assert.equal(hilo.approvalPolicy, 'never');
  assert.equal(hilo.cwd, copia);
  assert.equal(turno.cwd, copia);
  const env = JSON.parse(readFileSync(registroEnv, 'utf8'));
  if (process.platform === 'darwin') {
    // Perfil de permisos del CODEX_HOME aislado: la copia y su carpeta temporal escribibles, el home del encargo vetado
    // salvo ese camino (aquí, la carpeta personal de pruebas), sin red.
    assert.equal('sandbox' in hilo, false);
    assert.equal('sandboxPolicy' in turno, false);
    const escribibles = [...env.config.matchAll(/^(".*") = "write"$/gmu)].map((m) => JSON.parse(m[1]));
    assert.deepEqual(escribibles, [copia, path.join(carpeta, 'tmp')]);
    assert.ok(!escribibles.some((r) => r.startsWith(realpathSync(e.raiz))), 'el repo real nunca es escribible');
    assert.match(env.config, /^\[permissions\.nexakit-encargo\.network\]\nenabled = false$/mu);
  } else {
    assert.equal(hilo.sandbox, 'workspace-write');
    // La copia es la única raíz escribible del repo; la otra es la carpeta temporal del encargo, fuera del repo real.
    assert.deepEqual(turno.sandboxPolicy.writableRoots, [copia, path.join(carpeta, 'tmp')]);
    assert.equal(turno.sandboxPolicy.networkAccess, false);
    assert.deepEqual(hilo.config.sandbox_workspace_write.writable_roots, [copia, path.join(carpeta, 'tmp')]);
    assert.ok(!turno.sandboxPolicy.writableRoots.some((r) => r.startsWith(realpathSync(e.raiz))), 'el repo real nunca es escribible');
  }
  assert.notEqual(env.home, codexHome, 'CODEX_HOME aislado');
  assert.equal(env.temporales.TMPDIR, path.join(carpeta, 'tmp'));
  assert.match(turno.input[0].text, /Para comprobar tu trabajo usa solo estas órdenes: `npm test`, `npm run typecheck`/u);
  assert.doesNotMatch(turno.input[0].text, /cualquier otra se rechaza/u);
  comprobarLimpio(e, informe);
});
