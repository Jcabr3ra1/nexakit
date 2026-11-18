import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gitConfigGlobalVacio } from '../test-support/git-aislado.js';
import { medir, observacionDe, categoriasEquivalentes } from '../dist/fabrica/banco/medir.js';
import {
  planificarBanco,
  describirPlan,
  ejecutarBanco,
  huellaPlan,
  TOKENS_POR_LLAMADA,
} from '../dist/fabrica/banco/ejecutar.js';
import { cargarCasos } from '../dist/fabrica/banco/casos.js';
import { evidenciaVacia, actualizar, cargar, cuantil05 } from '../dist/fabrica/evidencia.js';
import { aceptar, registrar } from '../dist/fabrica/lecciones.js';
import { ErrorFabrica } from '../dist/fabrica/errores.js';

process.env.GIT_CONFIG_GLOBAL = gitConfigGlobalVacio;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Prueba';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'prueba@example.com';

const temporales = [];
test.after(() => {
  for (const dir of temporales) rmSync(dir, { recursive: true, force: true });
});
function temporal(prefijo) {
  const dir = mkdtempSync(path.join(tmpdir(), prefijo));
  temporales.push(dir);
  return dir;
}

const h = (archivo, linea, categoria) => ({
  estacion: 'seguridad',
  gravedad: 'alta',
  archivo,
  linea,
  categoria,
  hallazgo: 'algo',
  evidencia: 'algo',
  propuesta: 'algo',
  confianza: 'alta',
});
const f = (archivo, lineas, categoria) => ({ archivo, lineas, categoria, descripcion: 'fallo sembrado' });

// ---------------------------------------------------------------------------------------------------------------
// medir
// ---------------------------------------------------------------------------------------------------------------

test('medir: un hallazgo en el archivo, las líneas y la categoría del fallo es un acierto', () => {
  const r = medir([h('src/a.js', 12, 'inyeccion-ordenes')], [f('src/a.js', [12, 12], 'inyeccion-ordenes')]);
  assert.deepEqual(r, { aciertos: 1, fallosNoEncontrados: 0, falsosPositivos: 0 });
});

test('medir: el rango admite 3 líneas de margen por cada lado y no más', () => {
  const fallo = [f('src/a.js', [10, 12], 'recorrido-rutas')];
  for (const linea of [7, 10, 12, 15]) {
    assert.equal(medir([h('src/a.js', linea, 'recorrido-rutas')], fallo).aciertos, 1, `línea ${linea}`);
  }
  for (const linea of [6, 16]) {
    assert.deepEqual(medir([h('src/a.js', linea, 'recorrido-rutas')], fallo), { aciertos: 0, fallosNoEncontrados: 1, falsosPositivos: 1 }, `línea ${linea}`);
  }
});

test('medir: otro archivo, una línea nula o una categoría distinta no aciertan y cuentan como falso positivo', () => {
  const fallo = [f('src/a.js', [5, 5], 'inyeccion-ordenes')];
  for (const hallazgo of [h('src/b.js', 5, 'inyeccion-ordenes'), h('src/a.js', null, 'inyeccion-ordenes'), h('src/a.js', 5, 'consulta-n-mas-uno')]) {
    assert.deepEqual(medir([hallazgo], fallo), { aciertos: 0, fallosNoEncontrados: 1, falsosPositivos: 1 });
  }
});

test('medir: las rutas con «./» o barras invertidas se comparan normalizadas', () => {
  const fallo = [f('src/a.js', [5, 5], 'sin-prueba')];
  assert.equal(medir([h('./src/a.js', 5, 'sin-prueba')], fallo).aciertos, 1);
  assert.equal(medir([h('src\\a.js', 5, 'sin-prueba')], fallo).aciertos, 1);
});

test('medir: las categorías equivalentes aciertan, sin importar mayúsculas, tildes, espacios ni «de»', () => {
  const casos = [
    ['Inyección de órdenes', 'inyeccion-ordenes'],
    ['command injection', 'inyeccion-ordenes'],
    ['Path traversal', 'recorrido-rutas'],
    ['recorrido_de_rutas', 'recorrido-rutas'],
    ['N+1', 'consulta-n-mas-uno'],
    ['consultas en bucle', 'consulta-n-mas-uno'],
    ['E/S repetida', 'lectura-repetida'],
    ['documentación desactualizada', 'doc-contradice-codigo'],
    ['comentario obsoleto', 'doc-contradice-codigo'],
    ['falta de pruebas', 'sin-prueba'],
    ['prueba sin aserciones', 'aserciones-debiles'],
    ['Violación de ADR', 'violacion-adr'],
    ['violación de capas', 'violacion-adr'],
  ];
  for (const [delModelo, sembrada] of casos) {
    assert.ok(categoriasEquivalentes(delModelo, sembrada), `${delModelo} ≈ ${sembrada}`);
    assert.equal(medir([h('a.js', 1, delModelo)], [f('a.js', [1, 1], sembrada)]).aciertos, 1, delModelo);
  }
  assert.equal(categoriasEquivalentes('recorrido-rutas', 'inyeccion-ordenes'), false);
  assert.equal(categoriasEquivalentes('rendimiento', 'lectura-repetida'), false);
});

test('medir: los hallazgos repetidos sobre el mismo fallo cuentan un acierto y ningún falso positivo', () => {
  const r = medir(
    [h('src/a.js', 12, 'inyeccion-ordenes'), h('src/a.js', 13, 'inyección de órdenes'), h('src/a.js', 11, 'command injection')],
    [f('src/a.js', [12, 12], 'inyeccion-ordenes')],
  );
  assert.deepEqual(r, { aciertos: 1, fallosNoEncontrados: 0, falsosPositivos: 0 });
});

test('medir: un solo hallazgo no cubre dos fallos, y el emparejamiento busca el máximo de aciertos', () => {
  const fallos = [f('a.js', [10, 10], 'sin-prueba'), f('a.js', [14, 14], 'sin-prueba')];
  assert.deepEqual(medir([h('a.js', 12, 'sin-prueba')], fallos), { aciertos: 1, fallosNoEncontrados: 1, falsosPositivos: 0 });
  // El primero casa con los dos fallos y el segundo solo con el primero: el máximo es 2.
  assert.deepEqual(medir([h('a.js', 12, 'sin-prueba'), h('a.js', 8, 'sin-prueba')], fallos), {
    aciertos: 2,
    fallosNoEncontrados: 0,
    falsosPositivos: 0,
  });
});

test('medir: mezcla de aciertos, fallos no encontrados y falsos positivos', () => {
  const r = medir(
    [h('a.js', 3, 'sin-prueba'), h('b.js', 40, 'aserciones-debiles'), h('c.js', 1, 'sin-prueba')],
    [f('a.js', [2, 4], 'sin-prueba'), f('b.js', [5, 9], 'aserciones-debiles')],
  );
  assert.deepEqual(r, { aciertos: 1, fallosNoEncontrados: 1, falsosPositivos: 2 });
});

test('medir: un fallo de documentación también lo encuentra un hallazgo sobre un documento del caso', () => {
  const fallo = [f('src/config.js', [3, 3], 'doc-contradice-codigo')];
  const enReadme = h('README.md', 7, 'documentación desactualizada');
  assert.equal(medir([enReadme], fallo).aciertos, 0, 'sin documentos declarados no casa');
  assert.deepEqual(medir([enReadme], fallo, { documentos: ['README.md'] }), { aciertos: 1, fallosNoEncontrados: 0, falsosPositivos: 0 });
  // La línea del README no se conoce: también vale sin línea. Pero no con otra categoría.
  assert.equal(medir([h('README.md', null, 'doc-contradice-codigo')], fallo, { documentos: ['README.md'] }).aciertos, 1);
  assert.equal(medir([h('README.md', 3, 'inyeccion-ordenes')], fallo, { documentos: ['README.md'] }).aciertos, 0);
  // Solo vale para fallos de documentación.
  assert.equal(medir([h('README.md', 1, 'sin-prueba')], [f('src/a.js', [1, 1], 'sin-prueba')], { documentos: ['README.md'] }).aciertos, 0);
});

test('observacionDe: aciertos son los fallos encontrados y fallos, los no encontrados más los falsos positivos', () => {
  assert.deepEqual(observacionDe({ aciertos: 2, fallosNoEncontrados: 1, falsosPositivos: 3 }, 3), { aciertos: 2, fallos: 4 });
  // Un caso limpio sin hallazgos cuenta un acierto; con hallazgos, cada uno es un fallo.
  assert.deepEqual(observacionDe({ aciertos: 0, fallosNoEncontrados: 0, falsosPositivos: 0 }, 0), { aciertos: 1, fallos: 0 });
  assert.deepEqual(observacionDe({ aciertos: 0, fallosNoEncontrados: 0, falsosPositivos: 2 }, 0), { aciertos: 0, fallos: 2 });
});

// ---------------------------------------------------------------------------------------------------------------
// planificarBanco y describirPlan
// ---------------------------------------------------------------------------------------------------------------

const CATALOGOS = {
  codex: [
    { modelo: 'gpt-a', esfuerzos: ['high', 'low', 'medium'] },
    { modelo: 'gpt-b', esfuerzos: ['xhigh', 'minimal'] },
    { modelo: 'gpt-c', esfuerzos: [] },
    { modelo: 'gpt-d', esfuerzos: ['turbo', 'high'] },
    { modelo: 'gpt-e', esfuerzos: ['zeta', 'alfa'] },
  ],
  antigravity: [{ modelo: 'gemini-1-high', esfuerzos: [] }],
};

const primerCasoConFallos = (estacion) => {
  const caso = cargarCasos().find((c) => c.estacion === estacion && c.fallos.length > 0);
  return `${caso.estacion}/${caso.nombre}`;
};

test('fase 1: todos los modelos vivos con su esfuerzo más bajo sobre el primer caso con fallos de cada estación', () => {
  const plan = planificarBanco({ fase: 1, catalogos: CATALOGOS, evidencia: evidenciaVacia(), estaciones: ['seguridad', 'documentacion'] });
  const casos = [primerCasoConFallos('documentacion'), primerCasoConFallos('seguridad')];
  assert.deepEqual(casos, ['documentacion/comentario-obsoleto', 'seguridad/inyeccion-orden']);
  const esperadas = casos.flatMap((caso) => [
    { caso, ia: 'codex', modelo: 'gpt-a', esfuerzo: 'low' },
    { caso, ia: 'codex', modelo: 'gpt-b', esfuerzo: 'minimal' },
    { caso, ia: 'codex', modelo: 'gpt-d', esfuerzo: 'high' },
    { caso, ia: 'codex', modelo: 'gpt-e', esfuerzo: 'alfa' },
    { caso, ia: 'antigravity', modelo: 'gemini-1-high', esfuerzo: null },
  ]);
  assert.deepEqual(plan.ejecuciones, esperadas);
  assert.equal(plan.fase, 1);
  assert.deepEqual(plan.coste, { llamadas: 10, tokensEstimados: 10 * TOKENS_POR_LLAMADA });
  assert.equal(TOKENS_POR_LLAMADA, 30000);
  assert.match(plan.huella, /^[0-9a-f]{64}$/u);
  assert.ok(plan.avisos.some((a) => /gpt-c/u.test(a)), 'avisa del modelo de codex sin esfuerzos');
});

test('fase 1 sin estaciones: cubre todas las estaciones con casos, sin Claude', () => {
  const plan = planificarBanco({ fase: 1, catalogos: { ...CATALOGOS, claude: [{ modelo: 'revisor', esfuerzos: [] }] }, evidencia: evidenciaVacia() });
  const estaciones = [...new Set(plan.ejecuciones.map((e) => e.caso.split('/')[0]))];
  assert.deepEqual(estaciones, ['arquitectura', 'documentacion', 'pruebas', 'rendimiento', 'seguridad']);
  assert.ok(plan.ejecuciones.every((e) => e.ia !== 'claude'));
});

test('el coste usa los tokens medios de la evidencia del par y la estación, o 30000 por llamada sin datos', () => {
  let ev = evidenciaVacia();
  ev = actualizar(ev, { ia: 'codex', modelo: 'gpt-a', esfuerzo: 'low', estacion: 'seguridad' }, { aciertos: 1, fallos: 0, tokens: 1234, fuente: 'banco' });
  // Otra estación u otro esfuerzo no cuentan.
  ev = actualizar(ev, { ia: 'codex', modelo: 'gpt-b', esfuerzo: 'minimal', estacion: 'pruebas' }, { aciertos: 1, fallos: 0, tokens: 99, fuente: 'banco' });
  const plan = planificarBanco({ fase: 1, catalogos: CATALOGOS, evidencia: ev, estaciones: ['seguridad'] });
  assert.equal(plan.coste.llamadas, 5);
  assert.equal(plan.coste.tokensEstimados, 1234 + 4 * TOKENS_POR_LLAMADA);
});

test('la huella es el sha256 del plan canónico y cambia con cualquier parte del plan', () => {
  const plan = planificarBanco({ fase: 1, catalogos: CATALOGOS, evidencia: evidenciaVacia(), estaciones: ['seguridad'] });
  assert.equal(huellaPlan(plan), plan.huella);
  assert.equal(planificarBanco({ fase: 1, catalogos: CATALOGOS, evidencia: evidenciaVacia(), estaciones: ['seguridad'] }).huella, plan.huella);
  assert.notEqual(huellaPlan({ ...plan, coste: { ...plan.coste, tokensEstimados: 1 } }), plan.huella);
  assert.notEqual(huellaPlan({ ...plan, ejecuciones: plan.ejecuciones.slice(1) }), plan.huella);
  assert.notEqual(huellaPlan({ ...plan, fase: 2 }), plan.huella);
});

test('el coste se muestra antes: describirPlan da las llamadas, los tokens, las ejecuciones y la huella', () => {
  const plan = planificarBanco({ fase: 1, catalogos: CATALOGOS, evidencia: evidenciaVacia(), estaciones: ['seguridad'] });
  const texto = describirPlan(plan);
  assert.match(texto, /fase 1/u);
  assert.match(texto, /5 llamadas/u);
  assert.match(texto, /150\.000 tokens/u);
  assert.match(texto, /seguridad\/inyeccion-orden: codex gpt-a low/u);
  assert.match(texto, /seguridad\/inyeccion-orden: antigravity gemini-1-high/u);
  assert.ok(texto.includes(plan.huella));
  assert.match(texto, /aprob/u);
});

test('una estación desconocida se rechaza', () => {
  assert.throws(() => planificarBanco({ fase: 1, catalogos: CATALOGOS, evidencia: evidenciaVacia(), estaciones: ['magia'] }), ErrorFabrica);
  assert.throws(() => planificarBanco({ fase: 3, catalogos: CATALOGOS, evidencia: evidenciaVacia() }), ErrorFabrica);
});

/** Suma a la evidencia una observación de banco del par en la estación. */
const medida = (ev, ia, modelo, esfuerzo, estacion, aciertos, fallos, tokens) =>
  actualizar(ev, { ia, modelo, esfuerzo, estacion }, { aciertos, fallos, ...(tokens === undefined ? {} : { tokens }), fuente: 'banco' });

const CATALOGOS_FASE2 = {
  codex: [
    { modelo: 'gpt-a', esfuerzos: ['low', 'medium', 'high'] },
    { modelo: 'gpt-b', esfuerzos: ['low', 'medium', 'high'] },
    { modelo: 'gpt-d', esfuerzos: ['low', 'medium', 'high'] },
    { modelo: 'gpt-e', esfuerzos: ['high', 'low', 'medium'] },
  ],
  antigravity: [{ modelo: 'gemini-1-high', esfuerzos: [] }],
};

test('fase 2: los finalistas salen de la evidencia de banco de la fase 1, con esfuerzos medio y alto y todos los casos', () => {
  let ev = evidenciaVacia();
  ev = medida(ev, 'codex', 'gpt-a', 'low', 'seguridad', 9, 1, 5000);
  ev = medida(ev, 'codex', 'gpt-b', 'low', 'seguridad', 1, 9, 100);
  ev = medida(ev, 'codex', 'gpt-d', 'low', 'seguridad', 7, 3, 9000);
  // Empate con gpt-d en calidad: gana el que gasta menos tokens.
  ev = medida(ev, 'codex', 'gpt-e', 'low', 'seguridad', 7, 3, 8000);
  ev = medida(ev, 'antigravity', 'gemini-1-high', null, 'seguridad', 8, 2, 4000);
  // Un modelo que ya no está en el catálogo no es finalista aunque sea el mejor.
  ev = medida(ev, 'codex', 'gpt-retirado', 'low', 'seguridad', 10, 0, 10);
  // Las observaciones reales no son evidencia de banco.
  ev = actualizar(ev, { ia: 'codex', modelo: 'gpt-b', esfuerzo: 'high', estacion: 'seguridad' }, { aciertos: 50, fallos: 0, fuente: 'real' });
  // Otra estación no cuenta para seguridad.
  ev = medida(ev, 'codex', 'gpt-b', 'low', 'pruebas', 10, 0, 100);

  const q = (fila) => cuantil05(fila.alfa, fila.beta);
  const filaDe = (modelo) => ev.filas.find((x) => x.modelo === modelo && x.estacion === 'seguridad' && x.esfuerzo !== 'high');
  assert.equal(q(filaDe('gpt-d')), q(filaDe('gpt-e')));

  const plan = planificarBanco({ fase: 2, catalogos: CATALOGOS_FASE2, evidencia: ev, estaciones: ['seguridad'] });
  const casos = cargarCasos().filter((c) => c.estacion === 'seguridad').map((c) => `seguridad/${c.nombre}`);
  assert.equal(casos.length, 3);
  const pares = [...new Set(plan.ejecuciones.map((e) => `${e.ia} ${e.modelo} ${e.esfuerzo}`))];
  assert.deepEqual(pares, ['codex gpt-a medium', 'codex gpt-a high', 'antigravity gemini-1-high null', 'codex gpt-e medium', 'codex gpt-e high']);
  for (const par of pares) {
    assert.deepEqual(
      plan.ejecuciones.filter((e) => `${e.ia} ${e.modelo} ${e.esfuerzo}` === par).map((e) => e.caso),
      casos,
      par,
    );
  }
  assert.equal(plan.fase, 2);
  // Antigravity no tiene esfuerzo aparte: su fila de la fase 1 ya da los tokens medios del par.
  assert.deepEqual(plan.coste, { llamadas: 5 * 3, tokensEstimados: 4 * 3 * TOKENS_POR_LLAMADA + 3 * 4000 });
});

test('fase 2: un finalista de codex sin esfuerzo medio ni alto en el catálogo no se lanza y se avisa', () => {
  const ev = medida(evidenciaVacia(), 'codex', 'gpt-b', 'minimal', 'seguridad', 5, 0, 100);
  const plan = planificarBanco({ fase: 2, catalogos: CATALOGOS, evidencia: ev, estaciones: ['seguridad'] });
  assert.deepEqual(plan.ejecuciones, []);
  assert.ok(plan.avisos.some((a) => /gpt-b/u.test(a)));
});

test('fase 2 sin evidencia de banco de una estación: no hay finalistas y lo avisa', () => {
  const plan = planificarBanco({ fase: 2, catalogos: CATALOGOS, evidencia: evidenciaVacia(), estaciones: ['seguridad'] });
  assert.deepEqual(plan.ejecuciones, []);
  assert.deepEqual(plan.coste, { llamadas: 0, tokensEstimados: 0 });
  assert.ok(plan.avisos.some((a) => /seguridad/u.test(a) && /fase 1/u.test(a)));
});

// ---------------------------------------------------------------------------------------------------------------
// ejecutarBanco
// ---------------------------------------------------------------------------------------------------------------

const CATALOGO_PRUEBA = { codex: [{ modelo: 'gpt-a', esfuerzos: ['low', 'medium', 'high'] }] };

function conector(ia, ejecutar, catalogo = CATALOGO_PRUEBA[ia]) {
  return { ia, catalogo: async () => catalogo, ejecutar, cerrar: async () => {} };
}

const informe = (encargo, hallazgos, tokens = { entrada: 10, salida: 5, total: 15 }) => ({
  estado: 'ok',
  informe: { hallazgos, resumen: 'revisado' },
  crudo: JSON.stringify({ hallazgos }),
  modeloInformado: encargo.modelo,
  tokens,
  denegaciones: [],
});

function planSeguridad(fase = 1, evidencia = evidenciaVacia()) {
  return planificarBanco({ fase, catalogos: CATALOGO_PRUEBA, evidencia, estaciones: ['seguridad'] });
}

/** Archivos del repo temporal (sin `.git`), relativos a su raíz. */
function archivosDe(raiz) {
  return readdirSync(raiz, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(raiz, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
    .filter((r) => !r.startsWith('.git/'))
    .sort();
}

test('la huella es obligatoria: sin ella no se ejecuta nada', async () => {
  const home = temporal('banco-home-');
  let llamadas = 0;
  const codex = conector('codex', async (e) => {
    llamadas += 1;
    return informe(e, []);
  });
  const plan = planSeguridad();
  for (const opciones of [{}, { huella: '' }, { huella: undefined }]) {
    await assert.rejects(ejecutarBanco(plan, { ...opciones, home, conectores: { codex } }), (error) => {
      assert.ok(error instanceof ErrorFabrica);
      assert.match(error.message, /huella/u);
      return true;
    });
  }
  await assert.rejects(ejecutarBanco(plan, { huella: 'a'.repeat(64), home, conectores: { codex } }), ErrorFabrica);
  assert.equal(llamadas, 0);
  assert.equal(existsSync(path.join(home, '.nexakit')), false);
});

test('un plan alterado se rechaza aunque traiga su huella original', async () => {
  const home = temporal('banco-home-');
  let llamadas = 0;
  const codex = conector('codex', async (e) => {
    llamadas += 1;
    return informe(e, []);
  });
  const plan = planSeguridad();
  const alterados = [
    { ...plan, ejecuciones: plan.ejecuciones.map((e) => ({ ...e, modelo: 'gpt-caro' })) },
    { ...plan, ejecuciones: [...plan.ejecuciones, ...plan.ejecuciones] },
    { ...plan, coste: { ...plan.coste, tokensEstimados: 1 } },
    { ...plan, fase: 2 },
    { ...plan, extra: true },
  ];
  for (const alterado of alterados) {
    await assert.rejects(ejecutarBanco(alterado, { huella: plan.huella, home, conectores: { codex } }), ErrorFabrica);
  }
  // Un plan alterado con la huella recalculada tampoco pasa si no es la que se aprobó.
  const otro = { ...plan, coste: { ...plan.coste, tokensEstimados: 1 } };
  otro.huella = huellaPlan(otro);
  await assert.rejects(ejecutarBanco(otro, { huella: plan.huella, home, conectores: { codex } }), ErrorFabrica);
  assert.equal(llamadas, 0);
});

test('ejecutarBanco corre cada ejecución en un repo temporal aislado y suma la medición a la evidencia con fuente banco', async () => {
  const home = temporal('banco-home-');
  // Una lección global de la fábrica no debe llegar al banco.
  const { leccion } = await registrar(home, { regla: 'REGLA_QUE_NO_DEBE_LLEGAR', porque: 'prueba', ambito: 'global', origen: 'fabrica' });
  await aceptar(home, leccion.id);

  let visto;
  const codex = conector('codex', async (e) => {
    const estado = execFileSync('git', ['status', '--porcelain'], { cwd: e.raiz, encoding: 'utf8' });
    const commits = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: e.raiz, encoding: 'utf8' }).trim();
    visto = { encargo: e, estado, commits, archivos: archivosDe(e.raiz), respaldo: readFileSync(path.join(e.raiz, 'src/respaldo.ts'), 'utf8') };
    return informe(e, [h('src/respaldo.ts', 12, 'inyección de órdenes')], { entrada: 800, salida: 200, total: 1000 });
  });
  const plan = planSeguridad();
  assert.deepEqual(plan.ejecuciones, [{ caso: 'seguridad/inyeccion-orden', ia: 'codex', modelo: 'gpt-a', esfuerzo: 'low' }]);

  const resultado = await ejecutarBanco(plan, { huella: plan.huella, home, conectores: { codex } });

  // El repo: la base en un commit y el cambio sin confirmar, sin rastro del nombre del caso ni de esperado.json.
  assert.equal(visto.commits, '1');
  assert.match(visto.estado, /src\/respaldo\.ts/u);
  assert.deepEqual(visto.archivos, ['src/respaldo.ts']);
  const casoDir = cargarCasos().find((c) => c.nombre === 'inyeccion-orden').directorio;
  assert.equal(visto.respaldo, readFileSync(path.join(casoDir, 'cambio', 'src/respaldo.ts'), 'utf8'));
  for (const delator of ['inyeccion-orden', 'esperado', 'bench']) {
    assert.ok(!visto.encargo.raiz.includes(delator), `la ruta delata «${delator}»`);
    assert.ok(!visto.encargo.instrucciones.includes(delator), `las instrucciones delatan «${delator}»`);
  }
  assert.equal(visto.encargo.estacion, 'seguridad');
  assert.equal(visto.encargo.modelo, 'gpt-a');
  assert.equal(visto.encargo.esfuerzo, 'low');
  assert.ok(!visto.encargo.instrucciones.includes('REGLA_QUE_NO_DEBE_LLEGAR'), 'el banco no lleva lecciones');
  // El repo temporal se borra al terminar.
  assert.equal(existsSync(visto.encargo.raiz), false);

  assert.equal(resultado.ejecuciones.length, 1);
  const [ej] = resultado.ejecuciones;
  assert.equal(ej.valida, true);
  assert.deepEqual(ej.medicion, { aciertos: 1, fallosNoEncontrados: 0, falsosPositivos: 0 });
  assert.deepEqual(ej.observacion, { aciertos: 1, fallos: 0 });
  assert.equal(ej.tokens, 1000);

  const { evidencia } = await cargar(home);
  const fila = evidencia.filas.find((x) => x.modelo === 'gpt-a');
  assert.deepEqual(
    { ia: fila.ia, esfuerzo: fila.esfuerzo, estacion: fila.estacion, alfa: fila.alfa, beta: fila.beta, banco: fila.banco, real: fila.real, tokensMedios: fila.tokensMedios },
    { ia: 'codex', esfuerzo: 'low', estacion: 'seguridad', alfa: 2, beta: 1, banco: 1, real: 0, tokensMedios: 1000 },
  );
  assert.ok(evidencia.catalogo.codex.includes('gpt-a'));
});

test('las rutas absolutas dentro del repo temporal se comparan como relativas', async () => {
  const home = temporal('banco-home-');
  const codex = conector('codex', async (e) => informe(e, [h(path.join(e.raiz, 'src', 'respaldo.ts'), 12, 'inyeccion-ordenes')]));
  const plan = planSeguridad();
  const { ejecuciones } = await ejecutarBanco(plan, { huella: plan.huella, home, conectores: { codex } });
  assert.deepEqual(ejecuciones[0].medicion, { aciertos: 1, fallosNoEncontrados: 0, falsosPositivos: 0 });
});

test('las escrituras detectadas invalidan la medición de esa ejecución y no tocan la evidencia', async () => {
  const home = temporal('banco-home-');
  const codex = conector('codex', async (e) => {
    writeFileSync(path.join(e.raiz, 'nuevo.txt'), 'escrito por el revisor\n');
    return informe(e, [h('src/respaldo.ts', 12, 'inyeccion-ordenes')]);
  });
  const plan = planSeguridad();
  const { ejecuciones } = await ejecutarBanco(plan, { huella: plan.huella, home, conectores: { codex } });
  assert.equal(ejecuciones[0].valida, false);
  assert.match(ejecuciones[0].motivo, /escrib/u);
  assert.equal(ejecuciones[0].observacion, undefined);
  const { evidencia } = await cargar(home);
  assert.deepEqual(evidencia.filas, []);
});

test('una ejecución fallida no se registra; sin tokens informados, la media de tokens no se toca', async () => {
  const home = temporal('banco-home-');
  let ev = evidenciaVacia();
  const plan2 = planificarBanco({
    fase: 2,
    catalogos: CATALOGO_PRUEBA,
    evidencia: medida(ev, 'codex', 'gpt-a', 'low', 'seguridad', 1, 0, 500),
    estaciones: ['seguridad'],
  });
  // medium y high sobre los tres casos de seguridad.
  assert.equal(plan2.ejecuciones.length, 6);
  const codex = conector('codex', async (e) => {
    if (e.esfuerzo === 'high') return { estado: 'fallida', crudo: '', modeloInformado: null, tokens: null, denegaciones: [], motivo: 'la CLI falló' };
    // Sin hallazgos y sin tokens informados.
    return informe(e, [], null);
  });
  const vistos = [];
  const { ejecuciones } = await ejecutarBanco(plan2, {
    huella: plan2.huella,
    home,
    conectores: { codex },
    alAvanzar: (medida, i, total) => vistos.push([i, total, medida.caso]),
  });
  assert.deepEqual(vistos.map(([i, total]) => [i, total]), [[0, 6], [1, 6], [2, 6], [3, 6], [4, 6], [5, 6]]);
  const altos = ejecuciones.filter((e) => e.esfuerzo === 'high');
  assert.ok(altos.every((e) => e.valida === false && /fallida/u.test(e.motivo)));
  const medios = ejecuciones.filter((e) => e.esfuerzo === 'medium');
  assert.ok(medios.every((e) => e.valida && e.tokens === undefined));
  // Dos casos con fallo sin encontrar (2 fallos) y uno limpio sin hallazgos (1 acierto).
  const limpio = medios.find((e) => e.caso === 'seguridad/limpio-validacion');
  assert.deepEqual(limpio.observacion, { aciertos: 1, fallos: 0 });

  const { evidencia } = await cargar(home);
  assert.equal(evidencia.filas.length, 1);
  const [fila] = evidencia.filas;
  assert.deepEqual(
    { esfuerzo: fila.esfuerzo, alfa: fila.alfa, beta: fila.beta, banco: fila.banco, tokensMedios: fila.tokensMedios },
    { esfuerzo: 'medium', alfa: 2, beta: 3, banco: 3, tokensMedios: 0 },
  );
});

test('un modelo que ya no está en el catálogo vivo invalida su ejecución', async () => {
  const home = temporal('banco-home-');
  const codex = conector('codex', async (e) => informe(e, []), [{ modelo: 'otro', esfuerzos: ['low'] }]);
  const plan = planSeguridad();
  const { ejecuciones } = await ejecutarBanco(plan, { huella: plan.huella, home, conectores: { codex } });
  assert.equal(ejecuciones[0].valida, false);
  const { evidencia } = await cargar(home);
  assert.deepEqual(evidencia.filas, []);
});
