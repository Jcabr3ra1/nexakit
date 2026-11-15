import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, devNull } from 'node:os';
import path from 'node:path';
import {
  proponer,
  aplicarCambios,
  comprobarHuella,
  calcularHuella,
  jsonCanonico,
} from '../dist/fabrica/enrutador.js';
import { ErrorFabrica } from '../dist/fabrica/errores.js';

process.env.GIT_CONFIG_GLOBAL = devNull;
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

test('aplicarCambios ajusta las órdenes al cambiar de IA: las de la tabla al llegar a Codex, ninguna al irse', async () => {
  const dir = crearRepo({ config: { estaciones: { pruebas: { ordenesPermitidas: ['npm run lint'] } } } });
  escribir(dir, 'src/a.js', 'export {};\n');
  const r = await proponer({ raiz: dir, base: 'main', catalogos: CATALOGOS });
  assert.deepEqual(porNombre(r, 'pruebas').ordenesPermitidas, ['npm test', 'npm run lint']);

  // Sigue en Codex: conserva lo aprobado.
  const mismoCodex = aplicarCambios(r, [{ estacion: 'pruebas', modelo: 'gpt-6-sol', esfuerzo: 'medium' }]);
  assert.deepEqual(porNombre(mismoCodex, 'pruebas').ordenesPermitidas, ['npm test', 'npm run lint']);

  // Se va a Antigravity: ninguna orden. Y al volver a Codex, solo las de la tabla (no las del repo).
  const aAgy = aplicarCambios(r, [{ estacion: 'pruebas', ia: 'antigravity', modelo: 'gemini-4-argon-high' }]);
  assert.deepEqual(porNombre(aAgy, 'pruebas').ordenesPermitidas, []);
  const deVuelta = aplicarCambios(aAgy, [{ estacion: 'pruebas', ia: 'codex', modelo: 'gpt-6.1-terra', esfuerzo: 'medium' }]);
  assert.deepEqual(porNombre(deVuelta, 'pruebas').ordenesPermitidas, ['npm test']);

  // Quitar la estación borra las órdenes; el original no cambia.
  const quitada = aplicarCambios(r, [{ estacion: 'pruebas', quitar: true }]);
  assert.deepEqual(porNombre(quitada, 'pruebas').ordenesPermitidas, []);
  assert.deepEqual(porNombre(r, 'pruebas').ordenesPermitidas, ['npm test', 'npm run lint']);
  assert.notEqual(quitada.huella, r.huella);
});
