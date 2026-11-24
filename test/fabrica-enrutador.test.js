import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gitConfigGlobalVacio } from '../test-support/git-aislado.js';
import path from 'node:path';
import {
  proponer as proponerReal,
  aplicarCambios,
  comprobarHuella,
  calcularHuella,
  jsonCanonico,
} from '../dist/fabrica/enrutador.js';
import { ErrorFabrica } from '../dist/fabrica/errores.js';
import { actualizar, evidenciaVacia, guardar } from '../dist/fabrica/evidencia.js';
import { ejecutarCli } from '../dist/fabrica/cli.js';

process.env.GIT_CONFIG_GLOBAL = gitConfigGlobalVacio;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Prueba';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'prueba@example.com';

const temporales = [];
test.after(() => {
  for (const dir of temporales) rmSync(dir, { recursive: true, force: true });
});

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

function escribir(dir, ruta, contenido) {
  const destino = path.join(dir, ...ruta.split('/'));
  mkdirSync(path.dirname(destino), { recursive: true });
  writeFileSync(destino, contenido);
}

/** Repo con un commit base en `main` (con la configuración ya confirmada) y la rama `trabajo`. */
function crearRepo({ config } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fabrica-enrutador-'));
  temporales.push(dir);
  git(dir, 'init', '-q');
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  escribir(dir, 'README.txt', 'base\n');
  if (config !== undefined) escribir(dir, '.nexakit/fabrica.json', JSON.stringify(config));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'trabajo');
  return dir;
}

/** Casi todas las pruebas parten sin evidencia: un HOME temporal vacío, nunca el real de quien las ejecuta. */
const HOME_VACIO = mkdtempSync(path.join(tmpdir(), 'fabrica-enrutador-home-'));
temporales.push(HOME_VACIO);
const proponer = (entrada) => proponerReal({ home: HOME_VACIO, ...entrada });

/** HOME temporal con una evidencia guardada: `filas` son [ia, modelo, esfuerzo, estacion, aciertos, fallos, tokens]. */
async function homeConEvidencia(filas, { ahora = new Date() } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'fabrica-enrutador-ev-'));
  temporales.push(home);
  let ev = evidenciaVacia(ahora);
  for (const [ia, modelo, esfuerzo, estacion, aciertos, fallos, tokens] of filas) {
    ev = actualizar(ev, { ia, modelo, esfuerzo, estacion }, { aciertos, fallos, tokens, segundos: 10, fuente: 'banco', ahora });
  }
  await guardar(home, ev, ahora);
  return home;
}

const hace = (dias) => new Date(Date.now() - dias * 24 * 60 * 60 * 1000);

const CATALOGOS = {
  codex: [
    { modelo: 'gpt-6.1-sol', esfuerzos: ['high', 'medium'] },
    { modelo: 'gpt-6-sol', esfuerzos: ['high', 'medium'] },
    { modelo: 'gpt-6.1-terra', esfuerzos: ['medium', 'low'] },
    { modelo: 'gpt-6-luna', esfuerzos: ['medium'] },
  ],
  antigravity: [
    { modelo: 'gemini-4-argon-high', esfuerzos: [] },
    { modelo: 'gemini-4-hydrogen-high', esfuerzos: [] },
    { modelo: 'gemini-3.8-flash-medium', esfuerzos: [] },
  ],
};

const porNombre = (r, nombre) => r.estaciones.find((e) => e.estacion === nombre);
const estados = (r) => Object.fromEntries(r.estaciones.map((e) => [e.estacion, e.estado]));

test('hooks propone seguridad, pruebas y código', async () => {
  const dir = crearRepo();
  escribir(dir, 'hooks/pre-tool.js', 'export {};\n');
  const r = await proponer({ raiz: dir, base: 'main', catalogos: CATALOGOS });
  assert.equal(porNombre(r, 'seguridad').estado, 'propuesta');
  assert.equal(porNombre(r, 'seguridad').motivo, 'toca hooks');
  assert.equal(porNombre(r, 'seguridad').modelo, 'gpt-6.1-sol');
  assert.equal(porNombre(r, 'pruebas').estado, 'propuesta');
  assert.equal(porNombre(r, 'codigo').estado, 'propuesta');
  assert.equal(porNombre(r, 'documentacion').estado, 'omitida');
  assert.equal(r.basePedida, 'main');
  assert.match(r.huella, /^[0-9a-f]{64}$/u);
});

test('solo docs propone documentación y código, con pruebas omitida', async () => {
  const dir = crearRepo();
  escribir(dir, 'docs/guia.md', '# guía\n');
  const r = await proponer({ raiz: dir, base: 'main', catalogos: CATALOGOS });
  assert.equal(porNombre(r, 'documentacion').estado, 'propuesta');
  assert.equal(porNombre(r, 'codigo').estado, 'propuesta');
  assert.equal(porNombre(r, 'pruebas').estado, 'omitida');
  assert.equal(porNombre(r, 'seguridad').estado, 'omitida');
});

test('si falta el modelo preferido usa el siguiente y explica el descarte', async () => {
  const dir = crearRepo();
  escribir(dir, 'hooks/pre-tool.js', 'export {};\n');
  const catalogos = { ...CATALOGOS, codex: CATALOGOS.codex.filter((m) => m.modelo !== 'gpt-6.1-sol') };
  const r = await proponer({ raiz: dir, base: 'main', catalogos });
  const seguridad = porNombre(r, 'seguridad');
  assert.equal(seguridad.modelo, 'gpt-6-sol');
  assert.ok(seguridad.descartes.includes('gpt-6.1-sol no está en el catálogo de codex'));
});

test('un esfuerzo que el modelo no admite descarta el candidato', async () => {
  const dir = crearRepo();
  escribir(dir, 'hooks/pre-tool.js', 'export {};\n');
  const catalogos = {
    ...CATALOGOS,
    codex: [
      { modelo: 'gpt-6.1-sol', esfuerzos: ['low'] },
      { modelo: 'gpt-6-sol', esfuerzos: ['high'] },
    ],
  };
  const seguridad = porNombre(await proponer({ raiz: dir, base: 'main', catalogos }), 'seguridad');
  assert.equal(seguridad.modelo, 'gpt-6-sol');
  assert.ok(seguridad.descartes.some((d) => d.includes('gpt-6.1-sol no admite el esfuerzo high')));
});

test('sin ningún candidato la estación queda sin modelo', async () => {
  const dir = crearRepo({ config: { rutasCalientes: ['src/**'] } });
  escribir(dir, 'src/a.js', 'export {};\n');
  const r = await proponer({ raiz: dir, base: 'main', catalogos: {} });
  const rendimiento = porNombre(r, 'rendimiento');
  assert.equal(rendimiento.estado, 'sin-modelo');
  assert.equal(rendimiento.modelo, null);
  assert.ok(rendimiento.descartes.length > 0);
  // Claude no necesita catálogo vivo.
  assert.equal(porNombre(r, 'codigo').estado, 'propuesta');
});

test('la configuración puede omitir una estación', async () => {
  const dir = crearRepo({
    config: { rutasCalientes: ['src/**'], estaciones: { rendimiento: { activa: false } } },
  });
  escribir(dir, 'src/a.js', 'export {};\n');
  const r = await proponer({ raiz: dir, base: 'main', catalogos: CATALOGOS });
  assert.equal(porNombre(r, 'rendimiento').estado, 'omitida');
  assert.equal(porNombre(r, 'rendimiento').motivo, 'desactivada en la configuración');
});

test('la configuración puede activar una estación que el diff no activa', async () => {
  const dir = crearRepo({ config: { estaciones: { seguridad: { activa: true } } } });
  escribir(dir, 'docs/guia.md', '# guía\n');
  const r = await proponer({ raiz: dir, base: 'main', catalogos: CATALOGOS });
  assert.equal(porNombre(r, 'seguridad').estado, 'propuesta');
});

test('se respeta la IA preferida de la configuración', async () => {
  const dir = crearRepo({
    config: { rutasCriticas: ['src/**'], estaciones: { arquitectura: { ia: 'codex' } } },
  });
  escribir(dir, 'src/a.js', 'export {};\n');
  const r = await proponer({ raiz: dir, base: 'main', catalogos: CATALOGOS });
  assert.equal(porNombre(r, 'arquitectura').ia, 'codex');
  assert.equal(porNombre(r, 'arquitectura').modelo, 'gpt-6.1-sol');
  // Sin la preferencia, la tabla pone primero a Antigravity.
  const dir2 = crearRepo({ config: { rutasCriticas: ['src/**'] } });
  escribir(dir2, 'src/a.js', 'export {};\n');
  const r2 = await proponer({ raiz: dir2, base: 'main', catalogos: CATALOGOS });
  assert.equal(porNombre(r2, 'arquitectura').ia, 'antigravity');
  assert.equal(porNombre(r2, 'arquitectura').esfuerzo, null);
});

test('el modelo y el esfuerzo de la configuración tienen prioridad', async () => {
  const dir = crearRepo({
    config: { estaciones: { pruebas: { ia: 'codex', modelo: 'gpt-6-luna', esfuerzo: 'medium' } } },
  });
  escribir(dir, 'src/a.js', 'export {};\n');
  const pruebas = porNombre(await proponer({ raiz: dir, base: 'main', catalogos: CATALOGOS }), 'pruebas');
  assert.equal(pruebas.modelo, 'gpt-6-luna');
  assert.equal(pruebas.esfuerzo, 'medium');
});

test('las estaciones de Claude cuentan como subagentes y no como llamadas externas', async () => {
  const dir = crearRepo();
  escribir(dir, 'hooks/pre-tool.js', 'export {};\n');
  const r = await proponer({ raiz: dir, base: 'main', catalogos: CATALOGOS });
  // seguridad y pruebas (codex) externas; código (claude) subagente.
  assert.deepEqual(r.coste, { llamadasExternas: 2, subagentesClaude: 1 });
});

test('el foco se guarda pero no activa estaciones', async () => {
  const dir = crearRepo();
  escribir(dir, 'docs/guia.md', '# guía\n');
  const r = await proponer({ raiz: dir, base: 'main', foco: 'revisa la seguridad', catalogos: CATALOGOS });
  assert.equal(r.foco, 'revisa la seguridad');
  assert.equal(porNombre(r, 'seguridad').estado, 'omitida');
});

test('comprobarHuella pasa con el mismo diff y falla si cambia un archivo', async () => {
  const dir = crearRepo();
  escribir(dir, 'src/a.js', 'uno\n');
  const r = await proponer({ raiz: dir, base: 'main', catalogos: CATALOGOS });
  await comprobarHuella(r, dir);
  escribir(dir, 'src/a.js', 'dos\n');
  await assert.rejects(comprobarHuella(r, dir), (error) => {
    assert.ok(error instanceof ErrorFabrica);
    assert.equal(error.message, 'El cambio ya no es el que aprobaste; vuelve a proponer');
    return true;
  });
});

test('comprobarHuella falla si cambia el HEAD', async () => {
  const dir = crearRepo();
  escribir(dir, 'src/a.js', 'uno\n');
  const r = await proponer({ raiz: dir, base: 'main', catalogos: CATALOGOS });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'trabajo');
  await assert.rejects(comprobarHuella(r, dir), /ya no es el que aprobaste/u);
});

test('comprobarHuella falla si el recorrido fue alterado a mano', async () => {
  const dir = crearRepo();
  escribir(dir, 'src/a.js', 'uno\n');
  const r = await proponer({ raiz: dir, base: 'main', catalogos: CATALOGOS });
  const alterado = structuredClone(r);
  alterado.estaciones[0].modelo = 'otro';
  await assert.rejects(comprobarHuella(alterado, dir), /ya no es el que aprobaste/u);
});

test('aplicarCambios cambia la huella sin tocar el original', async () => {
  const dir = crearRepo();
  escribir(dir, 'hooks/pre-tool.js', 'export {};\n');
  const r = await proponer({ raiz: dir, base: 'main', catalogos: CATALOGOS });
  const copia = structuredClone(r);

  const cambiado = aplicarCambios(r, [{ estacion: 'seguridad', modelo: 'gpt-6-sol', esfuerzo: 'medium' }]);
  assert.notEqual(cambiado.huella, r.huella);
  assert.deepEqual(r, copia);
  assert.equal(porNombre(cambiado, 'seguridad').modelo, 'gpt-6-sol');
  assert.equal(porNombre(cambiado, 'seguridad').esfuerzo, 'medium');
  assert.equal(cambiado.huella, calcularHuella(cambiado));
  await comprobarHuella(cambiado, dir);

  const sinPruebas = aplicarCambios(r, [{ estacion: 'pruebas', quitar: true }]);
  assert.equal(porNombre(sinPruebas, 'pruebas').estado, 'omitida');
  assert.equal(porNombre(sinPruebas, 'pruebas').motivo, 'quitada por la persona');
  assert.equal(sinPruebas.coste.llamadasExternas, r.coste.llamadasExternas - 1);
  assert.notEqual(sinPruebas.huella, r.huella);
});

test('aplicarCambios rechaza estaciones, modelos y esfuerzos inválidos', async () => {
  const dir = crearRepo();
  escribir(dir, 'hooks/pre-tool.js', 'export {};\n');
  const r = await proponer({ raiz: dir, base: 'main', catalogos: CATALOGOS });
  assert.throws(() => aplicarCambios(r, [{ estacion: 'inexistente', quitar: true }]), ErrorFabrica);
  assert.throws(() => aplicarCambios(r, [{ estacion: 'seguridad', modelo: 'no-existe' }]), ErrorFabrica);
  assert.throws(
    () => aplicarCambios(r, [{ estacion: 'seguridad', ia: 'antigravity', modelo: 'gemini-4-argon-high', esfuerzo: 'high' }]),
    ErrorFabrica,
  );
  assert.throws(() => aplicarCambios(r, [{ estacion: 'seguridad', esfuerzo: 'extremo' }]), ErrorFabrica);
  // Cambiar a otra IA conocida con esfuerzo coherente sí vale.
  const ok = aplicarCambios(r, [{ estacion: 'seguridad', ia: 'antigravity', modelo: 'gemini-4-argon-high' }]);
  assert.equal(porNombre(ok, 'seguridad').esfuerzo, null);
  // Una estación omitida se activa indicando IA y modelo.
  const activada = aplicarCambios(r, [
    { estacion: 'rendimiento', ia: 'antigravity', modelo: 'gemini-4-hydrogen-high' },
  ]);
  assert.equal(estados(activada).rendimiento, 'propuesta');
  assert.throws(() => aplicarCambios(r, [{ estacion: 'rendimiento', esfuerzo: 'high' }]), ErrorFabrica);
});

test('jsonCanonico ordena las claves y no depende del orden de inserción', () => {
  assert.equal(jsonCanonico({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}');
  assert.equal(jsonCanonico({ a: 1, b: 2 }), jsonCanonico({ b: 2, a: 1 }));
});

test('cambiar foco o basePedida en un recorrido guardado invalida la huella', async () => {
  const dir = crearRepo();
  escribir(dir, 'src/a.js', 'uno\n');
  git(dir, 'branch', 'copia-main', 'main');
  const r = await proponer({ raiz: dir, base: 'main', foco: 'mira los permisos', catalogos: CATALOGOS });
  await comprobarHuella(r, dir);

  const otroFoco = { ...structuredClone(r), foco: 'ignora los permisos' };
  await assert.rejects(comprobarHuella(otroFoco, dir), /ya no es el que aprobaste/u);
  const sinFoco = structuredClone(r);
  delete sinFoco.foco;
  await assert.rejects(comprobarHuella(sinFoco, dir), /ya no es el que aprobaste/u);
  // Misma rama en la práctica (mismo commit), pero otra base pedida: la huella ya no coincide.
  const otraBase = { ...structuredClone(r), basePedida: 'copia-main' };
  await assert.rejects(comprobarHuella(otraBase, dir), /ya no es el que aprobaste/u);
  const otroSha = { ...structuredClone(r), base: 'f'.repeat(40) };
  await assert.rejects(comprobarHuella(otroSha, dir), /ya no es el que aprobaste/u);

  // Los cambios de la persona recalculan la huella conservando foco y base.
  const cambiado = aplicarCambios(r, [{ estacion: 'pruebas', quitar: true }]);
  assert.equal(cambiado.foco, 'mira los permisos');
  await comprobarHuella(cambiado, dir);
});

test('un modelo de codex fuera de la tabla y sin esfuerzo se descarta con motivo', async () => {
  const dir = crearRepo({ config: { estaciones: { pruebas: { ia: 'codex', modelo: 'gpt-6-luna' } } } });
  escribir(dir, 'src/a.js', 'export {};\n');
  const pruebas = porNombre(await proponer({ raiz: dir, base: 'main', catalogos: CATALOGOS }), 'pruebas');
  // gpt-6-luna no está en la tabla de pruebas: sin esfuerzo se descarta y se usa el siguiente candidato.
  assert.ok(pruebas.descartes.some((d) => d.includes('gpt-6-luna necesita un esfuerzo')));
  assert.equal(pruebas.modelo, 'gpt-6.1-terra');
  assert.equal(pruebas.esfuerzo, 'medium');
  // Nunca queda una propuesta de codex con esfuerzo null.
  const dir2 = crearRepo({ config: { estaciones: { rendimiento: { ia: 'codex', modelo: 'gpt-6-luna' } } } });
  escribir(dir2, 'src/a.js', 'export {};\n');
  const r2 = await proponer({ raiz: dir2, base: 'main', catalogos: CATALOGOS });
  for (const e of r2.estaciones) assert.ok(!(e.estado === 'propuesta' && e.ia === 'codex' && e.esfuerzo === null));
});

test('jsonCanonico conserva la clave __proto__', () => {
  const objeto = JSON.parse('{"b":1,"__proto__":{"x":1}}');
  assert.equal(jsonCanonico(objeto), '{"__proto__":{"x":1},"b":1}');
  assert.notEqual(jsonCanonico(JSON.parse('{"__proto__":{"x":1}}')), jsonCanonico(JSON.parse('{"__proto__":{"x":2}}')));
});

test('cada estación propuesta de Codex lleva las órdenes de la tabla y las demás van vacías', async () => {
  const dir = crearRepo();
  escribir(dir, 'src/a.js', 'export {};\n');
  escribir(dir, 'hooks/pre-tool.js', 'export {};\n');
  const r = await proponer({ raiz: dir, base: 'main', catalogos: CATALOGOS });
  assert.deepEqual(porNombre(r, 'pruebas').ordenesPermitidas, ['npm test']);
  assert.deepEqual(porNombre(r, 'seguridad').ordenesPermitidas, []);
  // Claude no pasa por un conector y las estaciones omitidas no ejecutan nada.
  assert.deepEqual(porNombre(r, 'codigo').ordenesPermitidas, []);
  assert.deepEqual(porNombre(r, 'documentacion').ordenesPermitidas, []);
});

test('las órdenes de la configuración se suman a las de la tabla, sin repetirse, y entran en la huella', async () => {
  const sin = crearRepo();
  escribir(sin, 'src/a.js', 'export {};\n');
  const base = await proponer({ raiz: sin, base: 'main', catalogos: CATALOGOS });

  const con = crearRepo({
    config: { estaciones: { pruebas: { ordenesPermitidas: ['npm test', 'npm run lint'] }, seguridad: { activa: true, ordenesPermitidas: ['git log'] } } },
  });
  escribir(con, 'src/a.js', 'export {};\n');
  const r = await proponer({ raiz: con, base: 'main', catalogos: CATALOGOS });
  assert.deepEqual(porNombre(r, 'pruebas').ordenesPermitidas, ['npm test', 'npm run lint']);
  assert.deepEqual(porNombre(r, 'seguridad').ordenesPermitidas, ['git log']);
  // Con el mismo diff, solo las órdenes distintas cambian la huella de las estaciones.
  const igual = structuredClone(r);
  porNombre(igual, 'pruebas').ordenesPermitidas = ['npm test'];
  porNombre(igual, 'seguridad').ordenesPermitidas = [];
  assert.notEqual(calcularHuella(igual), r.huella);
  assert.notEqual(r.huella, base.huella);
  // Alterar a mano las órdenes aprobadas invalida el recorrido.
  const alterado = structuredClone(r);
  porNombre(alterado, 'pruebas').ordenesPermitidas.push('rm -rf /');
  await assert.rejects(comprobarHuella(alterado, con), /ya no es el que aprobaste/u);
});

test('Antigravity rechaza toda orden: sus estaciones van sin órdenes aunque la configuración las declare', async () => {
  const dir = crearRepo({
    config: { rutasCriticas: ['src/**'], estaciones: { arquitectura: { ordenesPermitidas: ['npm test'] } } },
  });
  escribir(dir, 'src/a.js', 'export {};\n');
  const r = await proponer({ raiz: dir, base: 'main', catalogos: CATALOGOS });
  assert.equal(porNombre(r, 'arquitectura').ia, 'antigravity');
  assert.deepEqual(porNombre(r, 'arquitectura').ordenesPermitidas, []);
});

function crearRepoArquitectura() {
  const dir = crearRepo({ config: { rutasCriticas: ['src/**'] } });
  escribir(dir, 'src/a.js', 'export {};\n');
  return dir;
}

test('aplicarCambios solo conserva las órdenes vistas: las mantiene quien sigue en Codex y ninguna recibe quien llega o se va', async () => {
  const dir = crearRepo({ config: { estaciones: { pruebas: { ordenesPermitidas: ['npm run lint'] } } } });
  escribir(dir, 'src/a.js', 'export {};\n');
  const r = await proponer({ raiz: dir, base: 'main', catalogos: CATALOGOS });
  assert.deepEqual(porNombre(r, 'pruebas').ordenesPermitidas, ['npm test', 'npm run lint']);

  // Sigue en Codex: conserva lo aprobado.
  const mismoCodex = aplicarCambios(r, [{ estacion: 'pruebas', modelo: 'gpt-6-sol', esfuerzo: 'medium' }]);
  assert.deepEqual(porNombre(mismoCodex, 'pruebas').ordenesPermitidas, ['npm test', 'npm run lint']);

  // Se va a Antigravity: ninguna orden. Y al volver a Codex tampoco recibe ninguna: hay que volver a proponer.
  const aAgy = aplicarCambios(r, [{ estacion: 'pruebas', ia: 'antigravity', modelo: 'gemini-4-argon-high' }]);
  assert.deepEqual(porNombre(aAgy, 'pruebas').ordenesPermitidas, []);
  const deVuelta = aplicarCambios(aAgy, [{ estacion: 'pruebas', ia: 'codex', modelo: 'gpt-6.1-terra', esfuerzo: 'medium' }]);
  assert.deepEqual(porNombre(deVuelta, 'pruebas').ordenesPermitidas, []);

  // Pasar de Antigravity a Codex una estación que la propuesta ya tenía en Antigravity da [].
  const rAgy = await proponer({ raiz: crearRepoArquitectura(), base: 'main', catalogos: CATALOGOS });
  assert.equal(porNombre(rAgy, 'pruebas').ia, 'codex');
  const arqACodex = aplicarCambios(rAgy, [{ estacion: 'arquitectura', ia: 'codex', modelo: 'gpt-6.1-sol', esfuerzo: 'high' }]);
  assert.deepEqual(porNombre(arqACodex, 'arquitectura').ordenesPermitidas, []);

  // Quitar la estación borra las órdenes; el original no cambia.
  const quitada = aplicarCambios(r, [{ estacion: 'pruebas', quitar: true }]);
  assert.deepEqual(porNombre(quitada, 'pruebas').ordenesPermitidas, []);
  assert.deepEqual(porNombre(r, 'pruebas').ordenesPermitidas, ['npm test', 'npm run lint']);
  assert.notEqual(quitada.huella, r.huella);
});

// ---------------------------------------------------------------------------------------------
// Decisión basada en evidencia

test('sin evidencia usa la tabla manual, lo explica y avisa de que conviene ejecutar el banco', async () => {
  const dir = crearRepo();
  escribir(dir, 'src/a.js', 'export {};\n');
  const r = await proponer({ raiz: dir, base: 'main', catalogos: CATALOGOS });
  const pruebas = porNombre(r, 'pruebas');
  assert.equal(pruebas.modelo, 'gpt-6.1-terra');
  assert.equal(pruebas.calidad, null);
  assert.match(pruebas.explicacion, /sin datos medidos/u);
  assert.ok(r.avisos.some((a) => a.startsWith('pruebas: sin datos medidos: ejecuta el banco')), r.avisos.join('\n'));
  assert.ok(r.avisos.every((a) => !/caducada/u.test(a)), 'sin ningún dato no se habla de caducidad');
  assert.equal(porNombre(r, 'codigo').explicacion, 'la ejecuta la sesión de Claude');
  assert.equal(porNombre(r, 'codigo').calidad, null);
  assert.equal(porNombre(r, 'documentacion').explicacion, '');
});

test('con evidencia elige el modelo más barato que alcanza el umbral y lo explica', async () => {
  const dir = crearRepo();
  escribir(dir, 'hooks/pre-tool.js', 'export {};\n');
  const home = await homeConEvidencia([
    ['codex', 'gpt-6.1-sol', 'high', 'seguridad', 200, 2, 9000],
    ['codex', 'gpt-6-sol', 'high', 'seguridad', 200, 2, 3000],
  ]);
  const r = await proponerReal({ raiz: dir, base: 'main', catalogos: CATALOGOS, home });
  const seguridad = porNombre(r, 'seguridad');
  // La tabla pone primero gpt-6.1-sol; la evidencia dice que gpt-6-sol basta y cuesta menos.
  assert.equal(seguridad.modelo, 'gpt-6-sol');
  assert.equal(seguridad.esfuerzo, 'high');
  assert.ok(seguridad.calidad > 0.85 && seguridad.calidad < 1, String(seguridad.calidad));
  assert.match(seguridad.explicacion, /^gpt-6-sol high: calidad ≥ 0,9\d \(\d+ obs\.\)/u);
  assert.match(seguridad.explicacion, /criterio barato/u);
  assert.ok(r.avisos.every((a) => !a.startsWith('seguridad:')), r.avisos.join('\n'));
});

async function preferencias(homeDirectory, ...args) {
  let salida = '';
  let error = '';
  const codigo = await ejecutarCli(['preferencias', ...args], {
    out: (texto) => { salida += texto; },
    err: (texto) => { error += texto; },
  }, { homeDirectory });
  return { codigo, salida, error };
}

test('preferencias guarda y muestra el criterio global que usa el enrutador', async () => {
  const raiz = crearRepo();
  escribir(raiz, 'hooks/pre-tool.js', 'export {};\n');
  const home = await homeConEvidencia([
    ['codex', 'gpt-6.1-sol', 'high', 'seguridad', 200, 2, 9000],
    ['codex', 'gpt-6-sol', 'high', 'seguridad', 200, 12, 3000],
  ]);
  const proponerSeguridad = async () => porNombre(await proponerReal({ raiz, base: 'main', catalogos: CATALOGOS, home }), 'seguridad');
  const archivo = path.join(home, '.nexakit', 'fabrica', 'preferencias.json');
  assert.deepEqual(await preferencias(home), { codigo: 0, salida: 'Criterio de la fábrica: barato\n', error: '' });
  assert.equal(existsSync(archivo), false);
  assert.equal((await proponerSeguridad()).modelo, 'gpt-6-sol');

  assert.equal((await preferencias(home, '--criterio', 'calidad')).codigo, 0);
  for (const texto of [readFileSync(archivo, 'utf8'), (await preferencias(home, '--json')).salida]) {
    assert.deepEqual(JSON.parse(texto), { criterio: 'calidad' });
  }
  if (process.platform !== 'win32') {
    assert.equal(statSync(archivo).mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(archivo)).mode & 0o777, 0o700);
  }
  const seguridad = await proponerSeguridad();
  assert.equal(seguridad.modelo, 'gpt-6.1-sol');
  assert.match(seguridad.explicacion, /criterio calidad/u);

  assert.equal((await preferencias(home, '--criterio', '')).codigo, 2);
  assert.equal((await proponerSeguridad()).modelo, 'gpt-6.1-sol');
  writeFileSync(archivo, '{"criterio":"inválido"}');
  assert.equal((await proponerSeguridad()).modelo, 'gpt-6-sol');
  assert.equal((await preferencias(home, '--criterio', 'barato')).codigo, 0);
  assert.deepEqual(JSON.parse(readFileSync(archivo, 'utf8')), { criterio: 'barato' });
});

test('preferencias ignora enlaces al leer y rechaza las carpetas enlazadas al guardar', { skip: process.platform === 'win32' }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'fabrica-preferencias-'));
  temporales.push(home);
  const destino = path.join(home, 'destino');
  mkdirSync(path.join(destino, 'fabrica'), { recursive: true });
  const original = '{"criterio":"calidad"}';
  const archivo = path.join(destino, 'fabrica', 'preferencias.json');
  writeFileSync(archivo, original);
  symlinkSync(destino, path.join(home, '.nexakit'), 'dir');
  assert.deepEqual(JSON.parse((await preferencias(home, '--json')).salida), { criterio: 'barato' });
  assert.equal((await preferencias(home, '--criterio', 'barato')).codigo, 1);
  assert.equal(readFileSync(archivo, 'utf8'), original);

  rmSync(path.join(home, '.nexakit'));
  const fabrica = path.join(home, '.nexakit', 'fabrica');
  mkdirSync(fabrica, { recursive: true });
  symlinkSync(archivo, path.join(fabrica, 'preferencias.json'));
  assert.deepEqual(JSON.parse((await preferencias(home, '--json')).salida), { criterio: 'barato' });
  assert.equal((await preferencias(home, '--criterio', 'barato')).codigo, 0);
  assert.equal(readFileSync(archivo, 'utf8'), original);
  assert.deepEqual(JSON.parse(readFileSync(path.join(fabrica, 'preferencias.json'), 'utf8')), { criterio: 'barato' });
});

test('la explicación y la calidad entran en la huella', async () => {
  const dir = crearRepo();
  escribir(dir, 'src/a.js', 'export {};\n');
  const home = await homeConEvidencia([['codex', 'gpt-6.1-terra', 'medium', 'pruebas', 100, 2, 4000]]);
  const r = await proponerReal({ raiz: dir, base: 'main', catalogos: CATALOGOS, home });
  assert.equal(typeof porNombre(r, 'pruebas').calidad, 'number');
  await comprobarHuella(r, dir);
  for (const cambio of [{ explicacion: 'otra cosa' }, { calidad: 0.99 }]) {
    const alterado = structuredClone(r);
    Object.assign(porNombre(alterado, 'pruebas'), cambio);
    await assert.rejects(comprobarHuella(alterado, dir), /ya no es el que aprobaste/u);
  }
  // Los avisos solo informan: no son parte de lo que la persona aprueba.
  await comprobarHuella({ ...structuredClone(r), avisos: ['otro aviso'] }, dir);
});

test('un par vivo que solo está en la evidencia compite con los de la tabla; uno que ya no está en el catálogo, no', async () => {
  const dir = crearRepo();
  escribir(dir, 'src/a.js', 'export {};\n');
  const home = await homeConEvidencia([
    ['codex', 'gpt-6.1-terra', 'medium', 'pruebas', 100, 2, 4000],
    // No está en la tabla de «pruebas», pero está vivo (esfuerzo del catálogo) y es más barato.
    ['codex', 'gpt-6.1-terra', 'low', 'pruebas', 100, 2, 1000],
    // Medido en su día, ya no existe en el catálogo vivo: no puede elegirse por barato que fuera.
    ['codex', 'gpt-5-retirado', 'low', 'pruebas', 500, 0, 10],
    // Esfuerzo que el catálogo ya no admite para ese modelo.
    ['codex', 'gpt-6.1-terra', 'xhigh', 'pruebas', 500, 0, 10],
  ]);
  const pruebas = porNombre(await proponerReal({ raiz: dir, base: 'main', catalogos: CATALOGOS, home }), 'pruebas');
  assert.equal(pruebas.modelo, 'gpt-6.1-terra');
  assert.equal(pruebas.esfuerzo, 'low');
  assert.deepEqual(pruebas.ordenesPermitidas, ['npm test']);
});

test('un par de Antigravity con evidencia se elige sin esfuerzo aparte', async () => {
  const dir = crearRepo({ config: { rutasCriticas: ['src/**'] } });
  escribir(dir, 'src/a.js', 'export {};\n');
  const home = await homeConEvidencia([
    ['antigravity', 'gemini-4-argon-high', null, 'arquitectura', 300, 1, 8000],
    ['antigravity', 'gemini-4-hydrogen-high', null, 'arquitectura', 300, 1, 2000],
  ]);
  const arquitectura = porNombre(await proponerReal({ raiz: dir, base: 'main', catalogos: CATALOGOS, home }), 'arquitectura');
  assert.equal(arquitectura.ia, 'antigravity');
  assert.equal(arquitectura.modelo, 'gemini-4-hydrogen-high');
  assert.equal(arquitectura.esfuerzo, null);
});

test('lo fijado en .nexakit/fabrica.json no se decide por evidencia y la explicación lo dice', async () => {
  const dir = crearRepo({ config: { estaciones: { pruebas: { ia: 'codex', modelo: 'gpt-6-luna', esfuerzo: 'medium' } } } });
  escribir(dir, 'src/a.js', 'export {};\n');
  const home = await homeConEvidencia([
    ['codex', 'gpt-6.1-terra', 'low', 'pruebas', 500, 0, 100],
    ['codex', 'gpt-6-luna', 'medium', 'pruebas', 3, 20, 100],
  ]);
  const r = await proponerReal({ raiz: dir, base: 'main', catalogos: CATALOGOS, home });
  const pruebas = porNombre(r, 'pruebas');
  assert.equal(pruebas.modelo, 'gpt-6-luna');
  assert.equal(pruebas.explicacion, 'fijado en .nexakit/fabrica.json');
  assert.equal(pruebas.calidad, null);
  assert.ok(r.avisos.every((a) => !a.startsWith('pruebas:')), 'lo fijado no genera aviso de evidencia');

  // Solo la IA fijada: también manda la configuración (sigue la tabla dentro de esa IA).
  const dir2 = crearRepo({ config: { rutasCriticas: ['src/**'], estaciones: { arquitectura: { ia: 'codex' } } } });
  escribir(dir2, 'src/a.js', 'export {};\n');
  const arq = porNombre(await proponerReal({ raiz: dir2, base: 'main', catalogos: CATALOGOS, home }), 'arquitectura');
  assert.equal(arq.ia, 'codex');
  assert.equal(arq.explicacion, 'fijado en .nexakit/fabrica.json');
});

test('si lo fijado no está disponible la explicación lo reconoce y usa la tabla', async () => {
  const dir = crearRepo({ config: { estaciones: { pruebas: { ia: 'codex', modelo: 'gpt-9-inexistente', esfuerzo: 'medium' } } } });
  escribir(dir, 'src/a.js', 'export {};\n');
  const pruebas = porNombre(await proponer({ raiz: dir, base: 'main', catalogos: CATALOGOS }), 'pruebas');
  assert.equal(pruebas.modelo, 'gpt-6.1-terra');
  assert.match(pruebas.explicacion, /^fijado en \.nexakit\/fabrica\.json no está disponible; se usa gpt-6\.1-terra medium de la tabla$/u);
  assert.ok(pruebas.descartes.some((d) => d.includes('gpt-9-inexistente')));
});

test('con la evidencia caducada avisa con sus motivos y la orden del banco, sin relanzar nada', async () => {
  const dir = crearRepo();
  escribir(dir, 'src/a.js', 'export {};\n');
  const home = await homeConEvidencia([['codex', 'gpt-6.1-terra', 'medium', 'pruebas', 100, 2, 4000]], { ahora: hace(40) });
  const r = await proponerReal({ raiz: dir, base: 'main', catalogos: CATALOGOS, home });
  const aviso = r.avisos.find((a) => /caducada/u.test(a));
  assert.ok(aviso, r.avisos.join('\n'));
  assert.match(aviso, /la evidencia tiene 40 días/u);
  assert.match(aviso, /modelos sin medir: .*gpt-6-sol/u);
  assert.match(aviso, /ejecuta `nexakit fabrica banco planificar`/u);
  // Solo avisa: la elección sigue siendo la medida.
  assert.equal(porNombre(r, 'pruebas').modelo, 'gpt-6.1-terra');
  assert.ok(porNombre(r, 'pruebas').calidad > 0.75);
});

test('con la evidencia al día y todo el catálogo medido no hay aviso de caducidad', async () => {
  const dir = crearRepo();
  escribir(dir, 'src/a.js', 'export {};\n');
  const filas = [];
  for (const [ia, catalogo] of Object.entries(CATALOGOS)) {
    for (const m of catalogo) filas.push([ia, m.modelo, ia === 'codex' ? m.esfuerzos[0] : null, 'pruebas', 100, 2, 4000]);
  }
  const home = await homeConEvidencia(filas);
  const r = await proponerReal({ raiz: dir, base: 'main', catalogos: CATALOGOS, home });
  assert.ok(r.avisos.every((a) => !/caducada/u.test(a)), r.avisos.join('\n'));
});

test('si ningún modelo medido alcanza el umbral avisa por estación', async () => {
  const dir = crearRepo();
  escribir(dir, 'src/a.js', 'export {};\n');
  const home = await homeConEvidencia([
    ['codex', 'gpt-6.1-terra', 'medium', 'pruebas', 2, 30, 4000],
    ['codex', 'gpt-6.1-terra', 'low', 'pruebas', 1, 40, 1000],
  ]);
  const r = await proponerReal({ raiz: dir, base: 'main', catalogos: CATALOGOS, home });
  assert.ok(r.avisos.some((a) => /^pruebas: ningún modelo alcanza la calidad que pide el riesgo medio \(0,75\)/u.test(a)), r.avisos.join('\n'));
  assert.match(porNombre(r, 'pruebas').explicacion, /ningún modelo alcanza el umbral/u);
});

test('una evidencia ilegible se avisa y se parte sin datos medidos', async () => {
  const dir = crearRepo();
  escribir(dir, 'src/a.js', 'export {};\n');
  const home = mkdtempSync(path.join(tmpdir(), 'fabrica-enrutador-corrupta-'));
  temporales.push(home);
  mkdirSync(path.join(home, '.nexakit', 'fabrica'), { recursive: true });
  writeFileSync(path.join(home, '.nexakit', 'fabrica', 'evidencia.json'), '{ no es json');
  const r = await proponerReal({ raiz: dir, base: 'main', catalogos: CATALOGOS, home });
  assert.ok(r.avisos.some((a) => /No se pudo leer la evidencia guardada \(JSON corrupto\)/u.test(a)), r.avisos.join('\n'));
  assert.ok(r.avisos.some((a) => a.startsWith('pruebas: sin datos medidos')));
  assert.equal(porNombre(r, 'pruebas').modelo, 'gpt-6.1-terra');
});

test('el riesgo sale de lo que toca el diff: con hooks la misma evidencia ya no basta', async () => {
  const filas = [['codex', 'gpt-6.1-terra', 'medium', 'pruebas', 12, 1, 4000]];
  const home = await homeConEvidencia(filas);
  // Calidad ≥ 0,6 pero < 0,85: alcanza el umbral medio (0,75)? Con 12 aciertos y 1 fallo, el cuantil del 5 % ronda 0,70.
  const normal = crearRepo();
  escribir(normal, 'src/a.js', 'export {};\n');
  const rn = await proponerReal({ raiz: normal, base: 'main', catalogos: CATALOGOS, home });
  const conHooks = crearRepo();
  escribir(conHooks, 'hooks/pre-tool.js', 'export {};\n');
  const rh = await proponerReal({ raiz: conHooks, base: 'main', catalogos: CATALOGOS, home });
  const calidad = porNombre(rn, 'pruebas').calidad;
  assert.ok(calidad > 0.6 && calidad < 0.75, String(calidad));
  assert.ok(rn.avisos.some((a) => /^pruebas: ningún modelo alcanza la calidad que pide el riesgo medio/u.test(a)));
  assert.ok(rh.avisos.some((a) => /^pruebas: ningún modelo alcanza la calidad que pide el riesgo alto \(0,85\)/u.test(a)));
});

test('aplicarCambios marca la estación cambiada como elegida por la persona y conserva los avisos', async () => {
  const dir = crearRepo();
  escribir(dir, 'hooks/pre-tool.js', 'export {};\n');
  const r = await proponer({ raiz: dir, base: 'main', catalogos: CATALOGOS });
  const cambiado = aplicarCambios(r, [{ estacion: 'seguridad', modelo: 'gpt-6-sol', esfuerzo: 'medium' }, { estacion: 'pruebas', quitar: true }]);
  assert.equal(porNombre(cambiado, 'seguridad').explicacion, 'elegida por la persona');
  assert.equal(porNombre(cambiado, 'seguridad').calidad, null);
  assert.equal(porNombre(cambiado, 'pruebas').explicacion, '');
  assert.deepEqual(cambiado.avisos, r.avisos);
  await comprobarHuella(cambiado, dir);
});
