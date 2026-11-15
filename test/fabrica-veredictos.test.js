import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { ejecutarCli } from '../dist/fabrica/cli.js';
import { claveDe, consolidadoMarkdown, hallazgosDe } from '../dist/fabrica/consolidar.js';
import { calcularHuella } from '../dist/fabrica/enrutador.js';
import { actualizar, cargar, evidenciaVacia, guardar, revertirReal } from '../dist/fabrica/evidencia.js';
import { crearServidorFabrica } from '../dist/fabrica/mcp.js';
import { aprenderDeVeredictos } from '../dist/fabrica/veredictos.js';

const posix = process.platform !== 'win32';
const temporales = [];
const clientes = [];
test.after(async () => {
  await Promise.allSettled(clientes.map((c) => c.close()));
  for (const dir of temporales) rmSync(dir, { recursive: true, force: true });
});

function temporal(prefijo) {
  const dir = mkdtempSync(path.join(tmpdir(), prefijo));
  temporales.push(dir);
  return dir;
}

const ID = 'fab-20261115-1200-abcd';
const hallazgo = (estacion, archivo, linea, extra = {}) => ({
  estacion,
  gravedad: 'alta',
  archivo,
  linea,
  categoria: 'bug',
  hallazgo: `fallo de ${estacion}`,
  evidencia: 'x',
  propuesta: 'arreglar',
  confianza: 'media',
  ...extra,
});

const FILA_SEGURIDAD = { estacion: 'seguridad', ia: 'codex', modelo: 'gpt-6.1-sol', esfuerzo: 'high' };
const FILA_CODIGO = { estacion: 'codigo', ia: 'antigravity', modelo: 'gemini-4-pro', esfuerzo: null };
const FILA_PRUEBAS = { estacion: 'pruebas', ia: 'claude', modelo: 'niveles:revisor-de-calidad', esfuerzo: null };

const estacionRecorrido = (f) => ({
  estacion: f.estacion,
  ia: f.ia,
  modelo: f.modelo,
  esfuerzo: f.esfuerzo,
  motivo: 'prueba',
  descartes: [],
  explicacion: '',
  calidad: null,
  ordenesPermitidas: [],
  estado: 'propuesta',
});

/**
 * Un rastro de recorrido terminado, escrito a mano: `recorrido.json` con su huella, `<estacion>.json` por cada
 * estación externa con sus hallazgos y tokens, y `estado.json`. Las estaciones de Claude solo constan en el recorrido.
 */
function rastroFalso({ externas = [[FILA_SEGURIDAD, [hallazgo('seguridad', 'src/a.js', 10)], 1200]], claude = [], tokens = true } = {}) {
  const home = temporal('fabrica-veredictos-');
  const dir = path.join(home, '.nexakit', 'fabrica', 'repo-1', ID);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filas = [...externas.map(([f]) => f), ...claude];
  const datos = {
    head: 'a'.repeat(40),
    diffSha256: 'b'.repeat(64),
    base: 'c'.repeat(40),
    basePedida: 'main',
    estaciones: filas.map(estacionRecorrido),
  };
  const recorrido = { ...datos, huella: calcularHuella(datos) };
  writeFileSync(path.join(dir, 'recorrido.json'), `${JSON.stringify(recorrido, null, 2)}\n`);
  for (const [f, hallazgos, total] of externas) {
    const dato = {
      estacion: f.estacion,
      encargo: { estacion: f.estacion, modelo: f.modelo, esfuerzo: f.esfuerzo, raiz: '/x', base: 'c', instrucciones: 'i', ordenesPermitidas: [], diffSha256: 'b'.repeat(64) },
      resultado: {
        estado: 'ok',
        informe: { hallazgos, resumen: 'r' },
        crudo: '',
        modeloInformado: f.modelo,
        tokens: tokens ? { entrada: 1, salida: 1, total } : null,
        denegaciones: [],
      },
    };
    writeFileSync(path.join(dir, `${f.estacion}.json`), `${JSON.stringify(dato)}\n`);
  }
  const estado = {
    id: ID,
    dir,
    fase: 'terminado',
    estaciones: [...externas.map(([f]) => ({ estacion: f.estacion, estado: 'ok' })), ...claude.map((f) => ({ estacion: f.estacion, estado: 'claude' }))],
    escriturasDetectadas: [],
  };
  writeFileSync(path.join(dir, 'estado.json'), `${JSON.stringify(estado)}\n`);
  return { home, dir, estado, claudeHallazgos: [] };
}

const clave = (...hs) => hs.map((h) => claveDe(h));
const hallazgosDelRastro = (r, claude = []) => hallazgosDe(r.estado, claude);

const filaDe = (ev, f) => ev.filas.find((x) => x.estacion === f.estacion && x.modelo === f.modelo && x.esfuerzo === f.esfuerzo && x.ia === f.ia);

/** Evidencia ya medida por el banco con una fila para cada modelo, para ver bien lo que suman los veredictos. */
async function evidenciaDelBanco(home, filas) {
  let ev = evidenciaVacia();
  for (const f of filas) ev = actualizar(ev, f, { aciertos: 8, fallos: 2, tokens: 5000, segundos: 40, fuente: 'banco' });
  await guardar(home, ev);
}

async function aprender(r, veredictos, claude = []) {
  return aprenderDeVeredictos({ home: r.home, estado: r.estado, hallazgos: hallazgosDelRastro(r, claude), veredictos });
}

// ---------------------------------------------------------------------------------------------
// Clave del hallazgo

test('la clave es estable: 12 hex de estación, archivo, línea y categoría, sin el texto del revisor', () => {
  const a = hallazgo('seguridad', 'src/a.js', 10);
  assert.match(claveDe(a), /^[0-9a-f]{12}$/u);
  assert.equal(claveDe(a), claveDe({ ...a, hallazgo: 'otro texto', propuesta: 'otra', gravedad: 'baja' }));
  assert.notEqual(claveDe(a), claveDe({ ...a, linea: 11 }));
  assert.notEqual(claveDe(a), claveDe({ ...a, categoria: 'otra' }));
  assert.notEqual(claveDe(a), claveDe({ ...a, archivo: 'src/b.js' }));
  assert.notEqual(claveDe(a), claveDe({ ...a, estacion: 'codigo' }));
  assert.notEqual(claveDe({ ...a, linea: null }), claveDe({ ...a, linea: 0 }));
});

test('cada hallazgo consolidado lleva su clave y consolidado.md la muestra en la columna «Clave»', () => {
  const r = rastroFalso();
  const [h] = hallazgosDelRastro(r);
  assert.equal(h.clave, claveDe(hallazgo('seguridad', 'src/a.js', 10)));
  const md = consolidadoMarkdown(ID, [h], r.estado);
  assert.match(md, /\| Verificado \| Clave \|/u);
  assert.match(md, new RegExp(`\\|  \\| ${h.clave} \\|`, 'u'));
});

// ---------------------------------------------------------------------------------------------
// Aprender

test('un veredicto real suma a alfa y uno falso a beta de la fila del modelo y esfuerzo que usó la estación', async () => {
  const r = rastroFalso({
    externas: [[FILA_SEGURIDAD, [hallazgo('seguridad', 'src/a.js', 10), hallazgo('seguridad', 'src/b.js', 5)], 1200]],
  });
  await evidenciaDelBanco(r.home, [FILA_SEGURIDAD]);
  const antes = filaDe((await cargar(r.home)).evidencia, FILA_SEGURIDAD);
  const [ka, kb] = clave(hallazgo('seguridad', 'src/a.js', 10), hallazgo('seguridad', 'src/b.js', 5));

  const res = await aprender(r, [{ clave: ka, verificado: 'real' }, { clave: kb, verificado: 'falso' }]);
  assert.equal(res.aplicados, 2);
  assert.deepEqual(res.avisos, []);

  const despues = filaDe((await cargar(r.home)).evidencia, FILA_SEGURIDAD);
  // Una observación real pesa el doble: un acierto suma 2 a alfa, un fallo suma 2 a beta.
  assert.equal(despues.alfa, antes.alfa + 2);
  assert.equal(despues.beta, antes.beta + 2);
  assert.equal(despues.real, 2);
  assert.equal(despues.banco, antes.banco);
  // Tokens medios: media ponderada por las observaciones con los de la estación en el rastro.
  assert.notEqual(despues.tokensMedios, antes.tokensMedios);
  assert.ok(despues.tokensMedios < antes.tokensMedios);
});

test('sin evidencia previa se crea la fila con Beta(1,1) más el veredicto, solo para esa estación', async () => {
  const r = rastroFalso();
  const res = await aprender(r, [{ clave: clave(hallazgo('seguridad', 'src/a.js', 10))[0], verificado: 'real' }]);
  assert.equal(res.aplicados, 1);
  const ev = (await cargar(r.home)).evidencia;
  assert.equal(ev.filas.length, 1);
  assert.deepEqual({ alfa: ev.filas[0].alfa, beta: ev.filas[0].beta, real: ev.filas[0].real, banco: ev.filas[0].banco }, { alfa: 3, beta: 1, real: 1, banco: 0 });
  assert.equal(ev.filas[0].tokensMedios, 1200);
  // Aprender del uso real no cuenta como medición del banco: no renueva la fecha ni el catálogo medido.
  assert.deepEqual(ev.catalogo, { codex: [], antigravity: [], claude: [] });
});

test('un hallazgo reportado por varias estaciones actualiza cada estación y modelo', async () => {
  const r = rastroFalso({
    externas: [
      [FILA_SEGURIDAD, [hallazgo('seguridad', 'src/a.js', 10)], 1000],
      [FILA_CODIGO, [hallazgo('codigo', 'src/a.js', 12)], 3000],
    ],
  });
  const lista = hallazgosDelRastro(r);
  assert.equal(lista.length, 1);
  assert.deepEqual(lista[0].estaciones, ['seguridad', 'codigo']);
  const res = await aprender(r, [{ clave: lista[0].clave, verificado: 'falso' }]);
  assert.equal(res.aplicados, 1);
  const ev = (await cargar(r.home)).evidencia;
  assert.equal(ev.filas.length, 2);
  assert.equal(filaDe(ev, FILA_SEGURIDAD).beta, 3);
  assert.equal(filaDe(ev, FILA_CODIGO).beta, 3);
  assert.equal(filaDe(ev, FILA_CODIGO).esfuerzo, null);
});

test('las estaciones de Claude también aprenden: el modelo es el agente y no hay esfuerzo', async () => {
  const r = rastroFalso({ externas: [], claude: [FILA_PRUEBAS] });
  const delAgente = hallazgo('pruebas', 'test/a.test.js', 3);
  const lista = hallazgosDelRastro(r, [delAgente]);
  assert.equal(lista.length, 1);
  const res = await aprender(r, [{ clave: lista[0].clave, verificado: 'real' }], [delAgente]);
  assert.equal(res.aplicados, 1);
  const fila = filaDe((await cargar(r.home)).evidencia, FILA_PRUEBAS);
  assert.deepEqual({ alfa: fila.alfa, beta: fila.beta, real: fila.real, tokens: fila.tokensMedios }, { alfa: 3, beta: 1, real: 1, tokens: 0 });
});

test('los dudosos no cuentan y no escriben nada', async () => {
  const r = rastroFalso();
  const res = await aprender(r, [{ clave: clave(hallazgo('seguridad', 'src/a.js', 10))[0], verificado: 'dudoso' }]);
  assert.deepEqual({ aplicados: res.aplicados, dudosos: res.dudosos }, { aplicados: 0, dudosos: 1 });
  assert.equal(existsSync(path.join(r.home, '.nexakit', 'fabrica', 'evidencia.json')), false);
  assert.equal(existsSync(path.join(r.dir, 'veredictos.json')), false);
});

test('una clave desconocida se ignora con aviso y el resto sigue', async () => {
  const r = rastroFalso();
  const res = await aprender(r, [
    { clave: 'ffffffffffff', verificado: 'real' },
    { clave: 'mala\nclave|con**cosas', verificado: 'falso' },
    { clave: clave(hallazgo('seguridad', 'src/a.js', 10))[0], verificado: 'real' },
  ]);
  assert.equal(res.ignorados, 2);
  assert.equal(res.aplicados, 1);
  assert.equal(res.avisos.length, 2);
  assert.match(res.avisos[0], /^Clave desconocida, se ignora: ffffffffffff$/u);
  assert.doesNotMatch(res.avisos[1], /[\n|*]/u);
  assert.equal(filaDe((await cargar(r.home)).evidencia, FILA_SEGURIDAD).alfa, 3);
});

test('sin ninguna clave conocida no se toca la evidencia', async () => {
  const r = rastroFalso();
  const res = await aprender(r, [{ clave: 'ffffffffffff', verificado: 'real' }]);
  assert.equal(res.aplicados, 0);
  assert.equal(existsSync(path.join(r.home, '.nexakit', 'fabrica', 'evidencia.json')), false);
});

// ---------------------------------------------------------------------------------------------
// Rastro de confianza

test('sin rastro del recorrido no se actualiza nada y se avisa', async () => {
  const r = rastroFalso();
  rmSync(path.join(r.dir, 'recorrido.json'));
  const res = await aprender(r, [{ clave: clave(hallazgo('seguridad', 'src/a.js', 10))[0], verificado: 'real' }]);
  assert.equal(res.aplicados, 0);
  assert.match(res.avisos[0], /No hay rastro del recorrido/u);
  assert.equal(existsSync(path.join(r.home, '.nexakit', 'fabrica', 'evidencia.json')), false);
});

test('un recorrido manipulado (la huella no coincide) no actualiza nada', async () => {
  const r = rastroFalso();
  const ruta = path.join(r.dir, 'recorrido.json');
  const recorrido = JSON.parse(readFileSync(ruta, 'utf8'));
  recorrido.estaciones[0].modelo = 'modelo-inventado';
  writeFileSync(ruta, JSON.stringify(recorrido));
  const res = await aprender(r, [{ clave: clave(hallazgo('seguridad', 'src/a.js', 10))[0], verificado: 'real' }]);
  assert.equal(res.aplicados, 0);
  assert.match(res.avisos[0], /no coincide con su huella/u);
  assert.equal(existsSync(path.join(r.home, '.nexakit', 'fabrica', 'evidencia.json')), false);
});

test('un recorrido ilegible o de otra forma no actualiza nada', async () => {
  for (const contenido of ['{no es json', '{"huella":3}', '[]']) {
    const r = rastroFalso();
    writeFileSync(path.join(r.dir, 'recorrido.json'), contenido);
    const res = await aprender(r, [{ clave: clave(hallazgo('seguridad', 'src/a.js', 10))[0], verificado: 'real' }]);
    assert.equal(res.aplicados, 0, contenido);
    assert.equal(res.avisos.length, 1, contenido);
    assert.equal(existsSync(path.join(r.home, '.nexakit', 'fabrica', 'evidencia.json')), false, contenido);
  }
});

test('un encargo del rastro que contradice el recorrido aprobado no cuenta para esa estación', async () => {
  const r = rastroFalso();
  const ruta = path.join(r.dir, 'seguridad.json');
  const dato = JSON.parse(readFileSync(ruta, 'utf8'));
  dato.encargo.modelo = 'otro-modelo';
  writeFileSync(ruta, JSON.stringify(dato));
  const res = await aprender(r, [{ clave: clave(hallazgo('seguridad', 'src/a.js', 10))[0], verificado: 'real' }]);
  assert.equal(res.aplicados, 0);
  assert.equal(res.ignorados, 1);
  assert.match(res.avisos[0], /seguridad: el encargo del rastro no coincide con el recorrido aprobado/u);
  assert.equal(existsSync(path.join(r.home, '.nexakit', 'fabrica', 'evidencia.json')), false);
});

test('si los tokens no constan en el rastro no se inventan: la media de la fila queda como estaba', async () => {
  const r = rastroFalso({ tokens: false });
  await evidenciaDelBanco(r.home, [FILA_SEGURIDAD]);
  const antes = filaDe((await cargar(r.home)).evidencia, FILA_SEGURIDAD);
  await aprender(r, [{ clave: clave(hallazgo('seguridad', 'src/a.js', 10))[0], verificado: 'real' }]);
  const despues = filaDe((await cargar(r.home)).evidencia, FILA_SEGURIDAD);
  assert.equal(despues.tokensMedios, antes.tokensMedios);
  assert.equal(despues.segundosMedios, antes.segundosMedios);
  assert.equal(despues.alfa, antes.alfa + 2);
});

test('una evidencia ilegible no se sustituye: no se actualiza nada y el archivo sigue ahí', async () => {
  const r = rastroFalso();
  const ruta = path.join(r.home, '.nexakit', 'fabrica', 'evidencia.json');
  writeFileSync(ruta, '{corrupto');
  const res = await aprender(r, [{ clave: clave(hallazgo('seguridad', 'src/a.js', 10))[0], verificado: 'real' }]);
  assert.equal(res.aplicados, 0);
  assert.match(res.avisos[0], /No se pudo leer la evidencia guardada/u);
  assert.equal(readFileSync(ruta, 'utf8'), '{corrupto');
  assert.equal(existsSync(path.join(r.dir, 'veredictos.json')), false);
});

test('un veredictos.json ilegible o inválido no actualiza nada, para no contar dos veces', async () => {
  for (const contenido of ['{no es json', '{"version":2,"aplicados":{}}', '{"version":1,"aplicados":{"x":{"verificado":"dudoso","filas":[]}}}']) {
    const r = rastroFalso();
    writeFileSync(path.join(r.dir, 'veredictos.json'), contenido);
    const res = await aprender(r, [{ clave: clave(hallazgo('seguridad', 'src/a.js', 10))[0], verificado: 'real' }]);
    assert.equal(res.aplicados, 0, contenido);
    assert.match(res.avisos[0], /veredictos\.json/u, contenido);
    assert.equal(readFileSync(path.join(r.dir, 'veredictos.json'), 'utf8'), contenido);
    assert.equal(existsSync(path.join(r.home, '.nexakit', 'fabrica', 'evidencia.json')), false, contenido);
  }
});

// ---------------------------------------------------------------------------------------------
// Deduplicación

test('el mismo veredicto enviado dos veces no cuenta doble, ni en la misma llamada ni en otra', async () => {
  const r = rastroFalso();
  const k = clave(hallazgo('seguridad', 'src/a.js', 10))[0];
  const primera = await aprender(r, [{ clave: k, verificado: 'real' }, { clave: k, verificado: 'real' }]);
  assert.deepEqual({ aplicados: primera.aplicados, repetidos: primera.repetidos }, { aplicados: 1, repetidos: 1 });
  const segunda = await aprender(r, [{ clave: k, verificado: 'real' }]);
  assert.deepEqual({ aplicados: segunda.aplicados, repetidos: segunda.repetidos }, { aplicados: 0, repetidos: 1 });
  const fila = filaDe((await cargar(r.home)).evidencia, FILA_SEGURIDAD);
  assert.deepEqual({ alfa: fila.alfa, beta: fila.beta, real: fila.real }, { alfa: 3, beta: 1, real: 1 });
});

test('veredictos.json lleva 0o600, es JSON y guarda el veredicto y las filas aplicadas', { skip: !posix }, async () => {
  const r = rastroFalso();
  const k = clave(hallazgo('seguridad', 'src/a.js', 10))[0];
  await aprender(r, [{ clave: k, verificado: 'falso' }]);
  const ruta = path.join(r.dir, 'veredictos.json');
  assert.equal(statSync(ruta).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(ruta, 'utf8')), { version: 1, aplicados: { [k]: { verificado: 'falso', filas: [FILA_SEGURIDAD] } } });
  assert.equal(statSync(path.join(r.home, '.nexakit', 'fabrica', 'evidencia.json')).mode & 0o777, 0o600);
});

test('si el veredicto cambia de real a falso se revierte el anterior y se aplica el nuevo, y al revés', async () => {
  const r = rastroFalso();
  await evidenciaDelBanco(r.home, [FILA_SEGURIDAD]);
  const base = filaDe((await cargar(r.home)).evidencia, FILA_SEGURIDAD);
  const k = clave(hallazgo('seguridad', 'src/a.js', 10))[0];
  const leer = async () => filaDe((await cargar(r.home)).evidencia, FILA_SEGURIDAD);

  await aprender(r, [{ clave: k, verificado: 'real' }]);
  assert.deepEqual({ alfa: (await leer()).alfa, beta: (await leer()).beta, real: (await leer()).real }, { alfa: base.alfa + 2, beta: base.beta, real: 1 });

  const cambio = await aprender(r, [{ clave: k, verificado: 'falso' }]);
  assert.equal(cambio.aplicados, 1);
  assert.deepEqual({ alfa: (await leer()).alfa, beta: (await leer()).beta, real: (await leer()).real }, { alfa: base.alfa, beta: base.beta + 2, real: 1 });

  const repetido = await aprender(r, [{ clave: k, verificado: 'falso' }]);
  assert.equal(repetido.repetidos, 1);
  assert.equal((await leer()).beta, base.beta + 2);

  await aprender(r, [{ clave: k, verificado: 'real' }]);
  assert.deepEqual({ alfa: (await leer()).alfa, beta: (await leer()).beta, real: (await leer()).real }, { alfa: base.alfa + 2, beta: base.beta, real: 1 });
});

test('al revertir, un hallazgo con varias estaciones deshace cada una de ellas', async () => {
  const r = rastroFalso({
    externas: [
      [FILA_SEGURIDAD, [hallazgo('seguridad', 'src/a.js', 10)], 1000],
      [FILA_CODIGO, [hallazgo('codigo', 'src/a.js', 12)], 3000],
    ],
  });
  const [h] = hallazgosDelRastro(r);
  await aprender(r, [{ clave: h.clave, verificado: 'real' }]);
  await aprender(r, [{ clave: h.clave, verificado: 'falso' }]);
  const ev = (await cargar(r.home)).evidencia;
  for (const f of [FILA_SEGURIDAD, FILA_CODIGO]) {
    assert.deepEqual({ alfa: filaDe(ev, f).alfa, beta: filaDe(ev, f).beta, real: filaDe(ev, f).real }, { alfa: 1, beta: 3, real: 1 }, f.estacion);
  }
});

test('revertirReal nunca baja alfa ni beta del valor de partida ni las observaciones reales de cero', () => {
  let ev = actualizar(evidenciaVacia(), FILA_SEGURIDAD, { aciertos: 0, fallos: 1, tokens: 10, segundos: 1, fuente: 'real' });
  assert.equal(ev.filas[0].beta, 3);
  // Se revierten más fallos de los que se sumaron: se queda en el valor de partida.
  ev = revertirReal(ev, FILA_SEGURIDAD, { aciertos: 1, fallos: 5 });
  assert.deepEqual({ alfa: ev.filas[0].alfa, beta: ev.filas[0].beta, real: ev.filas[0].real }, { alfa: 1, beta: 1, real: 0 });
  // Una fila que no existe se deja tal cual.
  const igual = revertirReal(ev, FILA_CODIGO, { aciertos: 1, fallos: 0 });
  assert.equal(igual, ev);
  assert.throws(() => revertirReal(ev, { ...FILA_CODIGO, modelo: '' }, { aciertos: 1, fallos: 0 }), /no válida/u);
});

test('dos llamadas simultáneas no pierden ninguna actualización', async () => {
  const r = rastroFalso({
    externas: [[FILA_SEGURIDAD, [hallazgo('seguridad', 'src/a.js', 10), hallazgo('seguridad', 'src/b.js', 50)], 1200]],
  });
  const [ka, kb] = clave(hallazgo('seguridad', 'src/a.js', 10), hallazgo('seguridad', 'src/b.js', 50));
  await Promise.all([aprender(r, [{ clave: ka, verificado: 'real' }]), aprender(r, [{ clave: kb, verificado: 'real' }])]);
  const fila = filaDe((await cargar(r.home)).evidencia, FILA_SEGURIDAD);
  assert.deepEqual({ alfa: fila.alfa, real: fila.real }, { alfa: 5, real: 2 });
});

test('si la evidencia no se puede guardar, el veredicto no queda anotado y se avisa', { skip: process.platform !== 'darwin' }, async (t) => {
  const r = rastroFalso();
  const k = clave(hallazgo('seguridad', 'src/a.js', 10))[0];
  await evidenciaDelBanco(r.home, [FILA_SEGURIDAD]);
  const ruta = path.join(r.home, '.nexakit', 'fabrica', 'evidencia.json');
  const antes = readFileSync(ruta, 'utf8');
  try {
    // Un archivo inmutable se lee bien pero no se puede reemplazar: así falla el guardado sin tocar permisos de carpeta.
    execFileSync('chflags', ['uchg', ruta]);
  } catch {
    t.skip('chflags no está disponible');
    return;
  }
  try {
    const res = await aprender(r, [{ clave: k, verificado: 'real' }]);
    assert.equal(res.aplicados, 0);
    assert.match(res.avisos[0], /No se pudo actualizar la evidencia/u);
  } finally {
    execFileSync('chflags', ['nouchg', ruta]);
  }
  assert.equal(readFileSync(ruta, 'utf8'), antes);
  assert.equal(existsSync(path.join(r.dir, 'veredictos.json')), false, 'se deshizo la anotación');
  // Con la evidencia otra vez escribible, el mismo veredicto sí cuenta, y una sola vez.
  assert.equal((await aprender(r, [{ clave: k, verificado: 'real' }])).aplicados, 1);
  assert.equal((await aprender(r, [{ clave: k, verificado: 'real' }])).repetidos, 1);
});

test('veredictos.json que es un enlace no se sigue: se avisa y no se actualiza nada', { skip: !posix }, async () => {
  const r = rastroFalso();
  const fuera = path.join(r.home, 'fuera.json');
  writeFileSync(fuera, 'dato ajeno');
  symlinkSync(fuera, path.join(r.dir, 'veredictos.json'));
  const res = await aprender(r, [{ clave: clave(hallazgo('seguridad', 'src/a.js', 10))[0], verificado: 'real' }]);
  assert.equal(res.aplicados, 0);
  assert.equal(readFileSync(fuera, 'utf8'), 'dato ajeno');
});

// ---------------------------------------------------------------------------------------------
// MCP y CLI

async function conectar(r) {
  const servidor = crearServidorFabrica({ homeDirectory: r.home, cwd: r.home, environment: {}, avisar: () => {} });
  const [extremoCliente, extremoServidor] = InMemoryTransport.createLinkedPair();
  await servidor.server.connect(extremoServidor);
  const cliente = new Client({ name: 'prueba', version: '0.0.0' }, { capabilities: {} });
  clientes.push(cliente);
  await cliente.connect(extremoCliente);
  return { cliente, servidor };
}
const llamar = async (cliente, args) => {
  const resultado = await cliente.callTool({ name: 'fabrica_resultado', arguments: args });
  return { ...resultado, texto: resultado.content?.map((b) => b.text).join('\n') ?? '' };
};

test('fabrica_resultado expone la clave, aplica los veredictos y devuelve el aprendizaje', async () => {
  const r = rastroFalso({
    externas: [[FILA_SEGURIDAD, [hallazgo('seguridad', 'src/a.js', 10)], 1200]],
    claude: [FILA_PRUEBAS],
  });
  const { cliente } = await conectar(r);
  const delAgente = hallazgo('pruebas', 'test/a.test.js', 3);

  const primera = await llamar(cliente, { id: ID, hallazgosClaude: [delAgente] });
  assert.equal(primera.isError, undefined, primera.texto);
  const lista = JSON.parse(primera.texto).hallazgos;
  assert.deepEqual(lista.map((h) => h.clave).sort(), clave(hallazgo('seguridad', 'src/a.js', 10), delAgente).sort());
  assert.equal(JSON.parse(primera.texto).aprendizaje, undefined);
  assert.match(readFileSync(path.join(r.dir, 'consolidado.md'), 'utf8'), new RegExp(`\\| ${lista[0].clave} \\|`, 'u'));

  const segunda = await llamar(cliente, {
    id: ID,
    veredictos: [
      { clave: lista.find((h) => h.estaciones[0] === 'seguridad').clave, verificado: 'real' },
      { clave: lista.find((h) => h.estaciones[0] === 'pruebas').clave, verificado: 'falso' },
      { clave: 'ffffffffffff', verificado: 'real' },
    ],
  });
  assert.equal(segunda.isError, undefined, segunda.texto);
  const datos = JSON.parse(segunda.texto);
  assert.equal(datos.hallazgos.length, 2, 'sin hallazgosClaude se reutilizan los guardados');
  assert.deepEqual({ aplicados: datos.aprendizaje.aplicados, ignorados: datos.aprendizaje.ignorados }, { aplicados: 2, ignorados: 1 });
  const ev = (await cargar(r.home)).evidencia;
  assert.equal(filaDe(ev, FILA_SEGURIDAD).alfa, 3);
  assert.equal(filaDe(ev, FILA_PRUEBAS).beta, 3);

  const otra = JSON.parse((await llamar(cliente, { id: ID, veredictos: [{ clave: lista[0].clave, verificado: lista[0].estaciones[0] === 'seguridad' ? 'real' : 'falso' }] })).texto);
  assert.equal(otra.aprendizaje.repetidos, 1);
  assert.equal(otra.aprendizaje.aplicados, 0);
});

test('fabrica_resultado rechaza un veredicto con un valor que no es real, falso o dudoso', async () => {
  const r = rastroFalso();
  const { cliente } = await conectar(r);
  const respuesta = await cliente.callTool({ name: 'fabrica_resultado', arguments: { id: ID, veredictos: [{ clave: 'abc', verificado: 'quizá' }] } });
  assert.equal(respuesta.isError, true);
  assert.equal(existsSync(path.join(r.home, '.nexakit', 'fabrica', 'evidencia.json')), false);
});

test('fabrica_resultado con un rastro manipulado devuelve los hallazgos y un aviso, sin actualizar la evidencia', async () => {
  const r = rastroFalso();
  const ruta = path.join(r.dir, 'recorrido.json');
  const recorrido = JSON.parse(readFileSync(ruta, 'utf8'));
  recorrido.estaciones[0].esfuerzo = 'low';
  writeFileSync(ruta, JSON.stringify(recorrido));
  const { cliente } = await conectar(r);
  const respuesta = await llamar(cliente, { id: ID, veredictos: [{ clave: clave(hallazgo('seguridad', 'src/a.js', 10))[0], verificado: 'real' }] });
  assert.equal(respuesta.isError, undefined, respuesta.texto);
  const datos = JSON.parse(respuesta.texto);
  assert.equal(datos.hallazgos.length, 1);
  assert.equal(datos.aprendizaje.aplicados, 0);
  assert.match(datos.aprendizaje.avisos[0], /huella/u);
  assert.equal(existsSync(path.join(r.home, '.nexakit', 'fabrica', 'evidencia.json')), false);
});

async function cli(argv, r) {
  let out = '';
  let err = '';
  const codigo = await ejecutarCli(argv, { out: (t) => { out += t; }, err: (t) => { err += t; } }, { homeDirectory: r.home, cwd: r.home, environment: {} });
  return { codigo, out, err };
}

test('resultado --veredictos aplica los veredictos y los cuenta; --json trae el aprendizaje y las claves', async () => {
  const r = rastroFalso();
  const k = clave(hallazgo('seguridad', 'src/a.js', 10))[0];
  const archivo = path.join(r.home, 'veredictos.json');
  writeFileSync(archivo, JSON.stringify([{ clave: k, verificado: 'real' }, { clave: 'ffffffffffff', verificado: 'falso' }]));

  const texto = await cli(['resultado', '--id', ID, '--veredictos', archivo], r);
  assert.equal(texto.codigo, 0, texto.err);
  assert.match(texto.out, new RegExp(`\\| ${k} \\|`, 'u'));
  assert.match(texto.out, /Evidencia: 1 veredictos aplicados, 0 repetidos, 0 dudosos, 1 ignorados\./u);
  assert.match(texto.err, /^Aviso: Clave desconocida, se ignora: ffffffffffff$/mu);
  assert.equal(filaDe((await cargar(r.home)).evidencia, FILA_SEGURIDAD).alfa, 3);

  const json = await cli(['resultado', '--id', ID, '--veredictos', archivo, '--json'], r);
  const datos = JSON.parse(json.out);
  assert.equal(datos.hallazgos[0].clave, k);
  assert.equal(datos.aprendizaje.repetidos, 1);
  assert.equal(datos.aprendizaje.aplicados, 0);
  assert.equal(filaDe((await cargar(r.home)).evidencia, FILA_SEGURIDAD).alfa, 3);
});

test('resultado sin --veredictos no toca la evidencia', async () => {
  const r = rastroFalso();
  const res = await cli(['resultado', '--id', ID, '--json'], r);
  assert.equal(res.codigo, 0, res.err);
  assert.equal(JSON.parse(res.out).aprendizaje, undefined);
  assert.equal(existsSync(path.join(r.home, '.nexakit', 'fabrica', 'evidencia.json')), false);
});

test('resultado --veredictos con un archivo que no existe o no es válido da código 2 sin tocar nada', async () => {
  const r = rastroFalso();
  const perdido = await cli(['resultado', '--id', ID, '--veredictos', path.join(r.home, 'no-existe.json')], r);
  assert.equal(perdido.codigo, 2);
  assert.match(perdido.err, /No se pudo leer el archivo de veredictos/u);
  const archivo = path.join(r.home, 'malo.json');
  writeFileSync(archivo, JSON.stringify([{ clave: 'abc', verificado: 'tal vez' }]));
  const malo = await cli(['resultado', '--id', ID, '--veredictos', archivo], r);
  assert.equal(malo.codigo, 2);
  assert.match(malo.err, /El archivo de veredictos no es válido/u);
  assert.equal(existsSync(path.join(r.home, '.nexakit', 'fabrica', 'evidencia.json')), false);
});
