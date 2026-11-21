import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gitConfigGlobalVacio } from '../test-support/git-aislado.js';
import { medir, observacionDe, TOPE_FALSOS_POSITIVOS } from '../dist/fabrica/banco/medir.js';
import { elegir, UMBRALES } from '../dist/fabrica/decision.js';
import {
  planificarBanco,
  describirPlan,
  ejecutarBanco,
  huellaPlan,
  prefijoRepoTemporal,
  TOKENS_POR_LLAMADA,
} from '../dist/fabrica/banco/ejecutar.js';
import { nombreRepo } from '../dist/fabrica/rastro.js';
import { cargarCasos } from '../dist/fabrica/banco/casos.js';
import { evidenciaVacia, actualizar, cargar, guardar, cuantil05 } from '../dist/fabrica/evidencia.js';
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

const h = (archivo, linea, categoria, hallazgo = 'algo', evidencia = 'algo') => ({
  estacion: 'seguridad',
  gravedad: 'alta',
  archivo,
  linea,
  categoria,
  hallazgo,
  evidencia,
  propuesta: 'algo',
  confianza: 'alta',
});
/** Fallo sembrado; por defecto su única clave es su propia categoría. */
const f = (archivo, lineas, categoria, claves = [categoria]) => ({ archivo, lineas, categoria, claves, descripcion: 'fallo sembrado' });

// ---------------------------------------------------------------------------------------------------------------
// medir
// ---------------------------------------------------------------------------------------------------------------

test('medir: un hallazgo en el archivo y las líneas del fallo, con una de sus claves, es un acierto', () => {
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

test('medir: otro archivo o una línea nula no aciertan y cuentan como falso positivo', () => {
  const fallo = [f('src/a.js', [5, 5], 'inyeccion-ordenes')];
  for (const hallazgo of [h('src/b.js', 5, 'inyeccion-ordenes'), h('src/a.js', null, 'inyeccion-ordenes')]) {
    assert.deepEqual(medir([hallazgo], fallo), { aciertos: 0, fallosNoEncontrados: 1, falsosPositivos: 1 });
  }
});

test('medir: sin ninguna clave del fallo en la categoría ni en el texto no acierta, aunque casen archivo y línea', () => {
  const fallo = [f('src/a.js', [10, 10], 'tls-desactivado', ['tls', 'certificad'])];
  assert.deepEqual(medir([h('src/a.js', 10, 'seguridad', 'Algo raro en la red')], fallo), { aciertos: 0, fallosNoEncontrados: 1, falsosPositivos: 1 });
  // La clave vale en la categoría, en el hallazgo o en la evidencia, sin mayúsculas ni tildes y por raíz.
  for (const hallazgo of [
    h('src/a.js', 10, 'TLS desactivado'),
    h('src/a.js', 11, 'red', 'Se desactiva la verificación de los Certificados'),
    h('src/a.js', 9, 'otra cosa', 'algo', "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'"),
  ]) {
    assert.deepEqual(medir([hallazgo], fallo), { aciertos: 1, fallosNoEncontrados: 0, falsosPositivos: 0 }, hallazgo.categoria);
  }
  // La raíz empieza en un límite de palabra: «red» no casa con «credencial».
  const red = [f('src/a.js', [10, 10], 'dependencia-red', ['red-real', 'fetch'])];
  assert.equal(medir([h('src/a.js', 10, 'credenciales', 'credencial expuesta')], red).aciertos, 0);
  assert.equal(medir([h('src/a.js', 10, 'prueba', 'llama a la red real')], red).aciertos, 1);
  // Las claves de varias palabras casan con el texto normalizado: «N+1» es «n-mas-1».
  assert.equal(medir([h('src/a.js', 10, 'Consultas N+1')], [f('src/a.js', [10, 10], 'consulta-n-mas-uno', ['n-mas-1'])]).aciertos, 1);
});

test('medir: las claves cortas permitidas casan solo como palabra completa', () => {
  const tls = [f('src/a.js', [10, 10], 'tls-desactivado', ['tls', 'certificad'])];
  assert.equal(medir([h('src/a.js', 10, 'TLS desactivado')], tls).aciertos, 1);
  assert.equal(medir([h('src/a.js', 10, 'otra', 'algo', 'NODE_TLS_REJECT_UNAUTHORIZED')], tls).aciertos, 1);
  assert.equal(medir([h('src/a.js', 10, 'tlsx', 'nada que ver')], tls).aciertos, 0);
  const es = [f('src/a.js', [10, 10], 'e-s-sincrona', ['e-s', 'sincron'])];
  assert.equal(medir([h('src/a.js', 10, 'E/S repetida')], es).aciertos, 1);
  assert.equal(medir([h('src/a.js', 10, 'es lento')], es).aciertos, 0);
});

test('medir: camelCase se separa en palabras y también se compara junto', () => {
  const fallo = [f('src/a.js', [10, 10], 'violacion-adr', ['correo', 'regla'])];
  assert.equal(medir([h('src/a.js', 10, 'capas', 'Importa normalizarCorreo del servicio')], fallo).aciertos, 1);
  const junto = [f('src/a.js', [10, 10], 'doc-contradice-codigo', ['buscarusuario', 'buscar-usuario'])];
  assert.equal(medir([h('src/a.js', 10, 'jsdoc', 'buscarUsuario ya no devuelve null')], junto).aciertos, 1);
  assert.equal(medir([h('src/a.js', 10, 'jsdoc', 'buscarusuario ya no devuelve null')], junto).aciertos, 1);
});

test('medir: las claves con guion casan aunque las palabras vayan separadas por palabras vacías', () => {
  const fallo = [f('servicios/perfil.js', [1, 10], 'violacion-adr', ['acceso-datos', 'persistencia'])];
  for (const texto of ['El servicio hace el acceso a los datos él mismo', 'acceso a datos desde el servicio', 'acceso de la datos']) {
    assert.equal(medir([h('servicios/perfil.js', 5, 'capas', texto)], fallo).aciertos, 1, texto);
  }
});

test('medir: en documentación, un hallazgo del README solo acredita el fallo cuya clave específica nombra', () => {
  // Reproducción de la revisión: un revisor que encuentra 3 fallos de reportes-config y repite dos en el README sacaba
  // 5/5 porque «ejemplo» y «opcion» casaban con otros fallos a través del README.
  const caso = cargarCasos().find((c) => c.nombre === 'reportes-config');
  const documentos = ['README.md'];
  const hallazgos = [
    h('src/config.js', 12, 'Variable renombrada', 'La variable de entorno pasa a llamarse REPORTES_SERVIDOR', 'El README usa REPORTES_URL'),
    h('src/config.js', 3, 'Valor por defecto', 'El tiempo de espera por defecto es ahora 10 000 ms', 'tiempoEsperaMs: 10_000'),
    h('src/cli.js', 34, 'Código de salida', 'Si el envío falla la orden termina con el código 3', 'process.exitCode = 3'),
    h('README.md', null, 'ejemplo', 'El ejemplo del README sigue usando REPORTES_URL', 'REPORTES_URL=https://...'),
    h('README.md', null, 'opciones', 'La tabla de opciones del README dice que el tiempo de espera es 30000', '| tiempo de espera | 30000 |'),
  ];
  assert.deepEqual(medir(hallazgos, caso.fallos, { documentos }), { aciertos: 3, fallosNoEncontrados: 2, falsosPositivos: 0 });
  // comentario-obsoleto: el límite en el código y repetido en el README es un solo acierto, no también el de copia.ts.
  const comentario = cargarCasos().find((c) => c.nombre === 'comentario-obsoleto');
  const limite = [
    h('src/usuarios.ts', 32, 'jsdoc', 'El comentario dice que el límite por defecto es 50, pero ahora es 20'),
    h('README.md', null, 'readme', 'El README sigue diciendo que el límite por defecto es 50'),
  ];
  assert.deepEqual(medir(limite, comentario.fallos, { documentos: ['README.md'] }), { aciertos: 1, fallosNoEncontrados: 4, falsosPositivos: 0 });
});

test('medir: el ejemplo real de SSRF casado con el TLS desactivado no es un acierto', () => {
  // gpt-6-sol en seguridad/inyeccion-orden (fase 1): en la línea del TLS, pero habla de la URL remota sin validar.
  const caso = cargarCasos().find((c) => c.estacion === 'seguridad' && c.nombre === 'inyeccion-orden');
  const tls = caso.fallos.filter((x) => x.categoria === 'tls-desactivado');
  assert.equal(tls.length, 1);
  const ssrf = h(
    'src/respaldo.ts',
    23,
    'destino de red sin validar',
    'La URL remota controlable puede enviar el token y el respaldo a un destino no confiable.',
    'fetch usa remoto.url directamente y añade Authorization: Bearer; no se restringen esquema, host ni redirecciones.',
  );
  assert.deepEqual(medir([ssrf], tls), { aciertos: 0, fallosNoEncontrados: 1, falsosPositivos: 1 });
});

test('medir: un acierto legítimo con una categoría imprevisible casa por el texto', () => {
  const tls = cargarCasos().find((c) => c.nombre === 'inyeccion-orden').fallos.filter((x) => x.categoria === 'tls-desactivado');
  const enRed = h('src/respaldo.ts', 23, 'red', 'Deshabilitación global de la validación de certificados TLS/SSL', "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';");
  assert.deepEqual(medir([enRed], tls), { aciertos: 1, fallosNoEncontrados: 0, falsosPositivos: 0 });
  // gpt-6.2-astra en documentacion/comentario-obsoleto: «Formato del identificador».
  const caso = cargarCasos().find((c) => c.nombre === 'comentario-obsoleto');
  const id = h(
    'src/usuarios.ts',
    11,
    'Formato del identificador',
    'crearUsuario sigue anunciando un identificador numérico consecutivo desde 1.',
    'La función declara un retorno string y devuelve el identificador generado por randomUUID().',
  );
  assert.equal(medir([id], caso.fallos).aciertos, 1);
});

test('medir: el ejemplo real de arquitectura con categorías propias del revisor cuenta sus aciertos', () => {
  // gpt-6-sol en arquitectura/alta-usuarios (fase 1): acertó archivo y línea con categorías libres y se le contaban 0.
  const caso = cargarCasos().find((c) => c.estacion === 'arquitectura' && c.nombre === 'alta-usuarios');
  const hallazgos = [
    h('repositorios/usuarios.js', 2, 'Dependencia circular', 'El repositorio importa una función del servicio de usuarios, invirtiendo la dirección de dependencias y creando un ciclo entre ambas capas.'),
    h('repositorios/usuarios.js', 14, 'Responsabilidad de módulo', 'La regla que asigna el límite de proyectos según el dominio del correo queda dentro de la capa de persistencia.'),
    h('servicios/perfil.js', 1, 'Límite de persistencia', 'El nuevo servicio ejecuta SQL directamente, repartiendo el acceso a usuarios entre servicio y repositorio.'),
  ];
  assert.equal(caso.fallos.length, 5);
  assert.deepEqual(medir(hallazgos, caso.fallos), { aciertos: 3, fallosNoEncontrados: 2, falsosPositivos: 0 });
});

test('medir: las rutas con «./» o barras invertidas se comparan normalizadas', () => {
  const fallo = [f('src/a.js', [5, 5], 'sin-prueba')];
  assert.equal(medir([h('./src/a.js', 5, 'sin-prueba')], fallo).aciertos, 1);
  assert.equal(medir([h('src\\a.js', 5, 'sin-prueba')], fallo).aciertos, 1);
});

test('medir: los hallazgos repetidos sobre el mismo fallo cuentan un acierto y ningún falso positivo', () => {
  const r = medir(
    [h('src/a.js', 12, 'inyeccion-ordenes'), h('src/a.js', 13, 'shell', 'inyección de órdenes'), h('src/a.js', 11, 'x', 'otra vez la inyeccion')],
    [f('src/a.js', [12, 12], 'inyeccion-ordenes', ['inyeccion'])],
  );
  assert.deepEqual(r, { aciertos: 1, fallosNoEncontrados: 0, falsosPositivos: 0 });
});

test('medir: un solo hallazgo no cubre dos fallos, y el emparejamiento busca el máximo de aciertos', () => {
  const fallos = [f('a.js', [10, 10], 'sin-prueba', ['cobertura']), f('a.js', [14, 14], 'aserciones-debiles', ['cobertura'])];
  assert.deepEqual(medir([h('a.js', 12, 'cobertura')], fallos), { aciertos: 1, fallosNoEncontrados: 1, falsosPositivos: 0 });
  // El primero casa con los dos fallos y el segundo solo con el primero: el máximo es 2.
  assert.deepEqual(medir([h('a.js', 12, 'cobertura'), h('a.js', 8, 'cobertura')], fallos), {
    aciertos: 2,
    fallosNoEncontrados: 0,
    falsosPositivos: 0,
  });
});

test('medir: mezcla de aciertos, fallos no encontrados y falsos positivos', () => {
  const r = medir(
    [h('a.js', 3, 'sin-prueba'), h('b.js', 40, 'aserciones-debiles'), h('c.js', 1, 'sin-prueba'), h('a.js', 2, 'otra cosa')],
    [f('a.js', [2, 4], 'sin-prueba'), f('b.js', [5, 9], 'aserciones-debiles')],
  );
  assert.deepEqual(r, { aciertos: 1, fallosNoEncontrados: 1, falsosPositivos: 3 });
});

test('medir: un fallo de documentación también lo encuentra un hallazgo con sus claves sobre un documento del caso', () => {
  const fallos = [
    f('src/usuarios.js', [3, 3], 'doc-contradice-codigo', ['uuid', 'identificador']),
    f('src/usuarios.js', [20, 20], 'doc-contradice-codigo', ['null', 'buscarusuario']),
  ];
  const ejemplo = h('README.md', 17, 'ejemplo-roto', 'El ejemplo comprueba ana === null, pero buscarUsuario ya lanza una excepción.');
  assert.equal(medir([ejemplo], fallos).aciertos, 0, 'sin documentos declarados no casa');
  // Casa con el fallo de sus claves, sin mirar la línea (la del documento no se conoce): también sin línea.
  assert.deepEqual(medir([ejemplo], fallos, { documentos: ['README.md'] }), { aciertos: 1, fallosNoEncontrados: 1, falsosPositivos: 0 });
  assert.equal(medir([{ ...ejemplo, archivo: './README.md', linea: null }], fallos, { documentos: ['README.md'] }).aciertos, 1);
  // Sin ninguna clave del fallo, un hallazgo en el README no lo encuentra.
  assert.deepEqual(medir([h('README.md', 3, 'jsdoc', 'falta una coma')], fallos, { documentos: ['README.md'] }), { aciertos: 0, fallosNoEncontrados: 2, falsosPositivos: 1 });
  // Uno a uno también aquí: dos hallazgos en el README no cubren un solo fallo dos veces ni son falsos positivos.
  assert.deepEqual(medir([ejemplo, { ...ejemplo, linea: 30 }], fallos, { documentos: ['README.md'] }), { aciertos: 1, fallosNoEncontrados: 1, falsosPositivos: 0 });
  // Solo vale para fallos de documentación.
  assert.equal(medir([h('README.md', 1, 'sin-prueba')], [f('src/a.js', [1, 1], 'sin-prueba')], { documentos: ['README.md'] }).aciertos, 0);
});

test('observacionDe: aciertos son los fallos encontrados y fallos, los no encontrados más los falsos positivos', () => {
  assert.deepEqual(observacionDe({ aciertos: 2, fallosNoEncontrados: 1, falsosPositivos: 3 }, 3), { aciertos: 2, fallos: 4 });
  // Un caso limpio sin hallazgos cuenta un acierto; con hallazgos, cada uno es un fallo.
  assert.deepEqual(observacionDe({ aciertos: 0, fallosNoEncontrados: 0, falsosPositivos: 0 }, 0), { aciertos: 1, fallos: 0 });
  assert.deepEqual(observacionDe({ aciertos: 0, fallosNoEncontrados: 0, falsosPositivos: 2 }, 0), { aciertos: 0, fallos: 2 });
});

test('observacionDe: cuenta por fallo sembrado, no por caso, y los falsos positivos tienen tope por ejecución', () => {
  // Un caso con tres fallos sembrados, todos encontrados, da tres aciertos.
  assert.deepEqual(observacionDe({ aciertos: 3, fallosNoEncontrados: 0, falsosPositivos: 0 }, 3), { aciertos: 3, fallos: 0 });
  assert.equal(TOPE_FALSOS_POSITIVOS, 3);
  // Un revisor ruidoso no hunde la Beta con un solo caso: los falsos positivos cuentan como mucho el tope.
  assert.deepEqual(observacionDe({ aciertos: 1, fallosNoEncontrados: 1, falsosPositivos: 20 }, 2), { aciertos: 1, fallos: 1 + TOPE_FALSOS_POSITIVOS });
  assert.deepEqual(observacionDe({ aciertos: 0, fallosNoEncontrados: 0, falsosPositivos: 9 }, 0), { aciertos: 0, fallos: TOPE_FALSOS_POSITIVOS });
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

const IDS_ANTIGRAVITY = [
  'gemini-4-neon-high', 'gemini-4-neon-xhigh', 'gemini-4-neon-medium', 'gemini-4-neon-low',
  'gemini-4-argon-medium', 'gemini-4-argon-high', 'gemini-4-argon-low',
  'gemini-4-hydrogen-high', 'gemini-4-hydrogen-xhigh', 'gemini-4-hydrogen-medium', 'gemini-4-hydrogen-low',
  'gemini-pro-orchestrator-neon', 'gemini-pro-orchestrator-g1-pro',
  'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
  'claude-opus-5-5-low', 'claude-opus-5-5-medium', 'claude-opus-5-5-high',
  'claude-sonnet-5-5-low', 'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-high',
  'gpt-oss-120b-medium',
];
const CATALOGOS_REALES = { antigravity: IDS_ANTIGRAVITY.map((modelo) => ({ modelo, esfuerzos: [] })) };

test('fase 1: en antigravity solo la variante más baja de cada modelo base, con el catálogo real', () => {
  const plan = planificarBanco({ fase: 1, catalogos: CATALOGOS_REALES, evidencia: evidenciaVacia(), estaciones: ['seguridad'] });
  assert.deepEqual(
    plan.ejecuciones.map((e) => e.modelo),
    [
      'gemini-4-neon-low', 'gemini-4-argon-low', 'gemini-4-hydrogen-low', 'gemini-pro-orchestrator-neon',
      'gemini-pro-orchestrator-g1-pro', 'gemini-3.8-flash-low', 'claude-opus-5-5-low', 'claude-sonnet-5-5-low',
      'gpt-oss-120b-medium',
    ],
  );
  assert.ok(plan.ejecuciones.every((e) => e.ia === 'antigravity' && e.esfuerzo === null));
  assert.equal(plan.coste.llamadas, 9);
});

test('fase 2: un finalista de antigravity pasa con las variantes medium y high de su base', () => {
  let ev = medida(evidenciaVacia(), 'antigravity', 'gemini-4-neon-low', null, 'seguridad', 9, 1, 100);
  ev = medida(ev, 'antigravity', 'gemini-pro-orchestrator-neon', null, 'seguridad', 8, 2, 100);
  ev = medida(ev, 'antigravity', 'gpt-oss-120b-medium', null, 'seguridad', 7, 3, 100);
  const plan = planificarBanco({ fase: 2, catalogos: CATALOGOS_REALES, evidencia: ev, estaciones: ['seguridad'] });
  const modelos = [...new Set(plan.ejecuciones.map((e) => e.modelo))];
  assert.deepEqual(modelos, ['gemini-4-neon-medium', 'gemini-4-neon-high', 'gpt-oss-120b-medium']);
  assert.ok(plan.avisos.some((a) => /gemini-pro-orchestrator-neon/u.test(a) && /antigravity/u.test(a)));
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

/** Palabras que delatan que el revisor está siendo medido. */
const DELATORES = /banco|nexakit|bench|prueba|medici|test|caso|eval/iu;

test('el repo temporal lleva un nombre de proyecto neutro y aleatorio', async () => {
  const prefijos = new Set();
  for (let i = 0; i < 200; i += 1) {
    const prefijo = prefijoRepoTemporal();
    assert.match(prefijo, /^[a-z]+(?:-[a-z]+)*-$/u, prefijo);
    assert.doesNotMatch(prefijo, DELATORES);
    prefijos.add(prefijo);
  }
  assert.ok(prefijos.size > 1, 'el nombre cambia de una ejecución a otra');
  // El nombre del repo en el rastro sale de la carpeta: tampoco delata nada.
  const dir = temporal(prefijoRepoTemporal());
  assert.doesNotMatch(await nombreRepo(dir), DELATORES);
});

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
    const repo = await nombreRepo(e.raiz);
    const estado = execFileSync('git', ['status', '--porcelain'], { cwd: e.raiz, encoding: 'utf8' });
    const commits = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: e.raiz, encoding: 'utf8' }).trim();
    const log = execFileSync('git', ['log', '--format=%an <%ae> | %cn <%ce> | %s'], { cwd: e.raiz, encoding: 'utf8' });
    visto = { encargo: e, repo, estado, commits, log, archivos: archivosDe(e.raiz), respaldo: readFileSync(path.join(e.raiz, 'src/respaldo.ts'), 'utf8') };
    return informe(e, [h('src/respaldo.ts', 12, 'inyección de órdenes')], { entrada: 800, salida: 200, total: 1000 });
  });
  const plan = planSeguridad();
  assert.deepEqual(plan.ejecuciones, [{ caso: 'seguridad/inyeccion-orden', ia: 'codex', modelo: 'gpt-a', esfuerzo: 'low' }]);

  const resultado = await ejecutarBanco(plan, { huella: plan.huella, home, conectores: { codex } });

  // El repo: la base en un commit y el cambio sin confirmar, sin rastro del nombre del caso ni de esperado.json.
  assert.equal(visto.commits, '1');
  // Ni el autor ni el mensaje del commit dicen que es una medición (y no se cuela el autor del entorno).
  assert.doesNotMatch(visto.log, /banco|bench|prueba|nexakit|medici|test|caso/iu);
  assert.match(visto.log, /@example\.com/u);
  assert.match(visto.estado, /src\/respaldo\.ts/u);
  assert.deepEqual(visto.archivos, ['src/respaldo.ts']);
  const casoDir = cargarCasos().find((c) => c.nombre === 'inyeccion-orden').directorio;
  assert.equal(visto.respaldo, readFileSync(path.join(casoDir, 'cambio', 'src/respaldo.ts'), 'utf8'));
  for (const delator of ['inyeccion-orden', 'esperado', 'bench']) {
    assert.ok(!visto.encargo.raiz.includes(delator), `la ruta delata «${delator}»`);
    assert.ok(!visto.encargo.instrucciones.includes(delator), `las instrucciones delatan «${delator}»`);
  }
  // Ni la carpeta del repo ni su nombre en el rastro dicen que es una medición.
  assert.doesNotMatch(path.basename(visto.encargo.raiz), DELATORES);
  assert.doesNotMatch(visto.repo, DELATORES);
  assert.equal(visto.encargo.estacion, 'seguridad');
  assert.equal(visto.encargo.modelo, 'gpt-a');
  assert.equal(visto.encargo.esfuerzo, 'low');
  assert.ok(!visto.encargo.instrucciones.includes('REGLA_QUE_NO_DEBE_LLEGAR'), 'el banco no lleva lecciones');
  // El repo temporal se borra al terminar.
  assert.equal(existsSync(visto.encargo.raiz), false);
  // El rastro guarda el recorrido bajo ese mismo nombre neutro.
  const carpetasRastro = readdirSync(path.join(home, '.nexakit', 'fabrica'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  assert.ok(carpetasRastro.includes(visto.repo), carpetasRastro.join(', '));
  for (const carpeta of carpetasRastro) assert.doesNotMatch(carpeta, DELATORES);

  assert.equal(resultado.ejecuciones.length, 1);
  const [ej] = resultado.ejecuciones;
  assert.equal(ej.valida, true);
  // El hallazgo encuentra uno de los fallos sembrados del caso; los demás cuentan como no encontrados.
  const sembrados = cargarCasos().find((c) => c.nombre === 'inyeccion-orden').fallos.length;
  assert.deepEqual(ej.medicion, { aciertos: 1, fallosNoEncontrados: sembrados - 1, falsosPositivos: 0 });
  assert.deepEqual(ej.observacion, { aciertos: 1, fallos: sembrados - 1 });
  assert.equal(ej.tokens, 1000);

  const { evidencia } = await cargar(home);
  const fila = evidencia.filas.find((x) => x.modelo === 'gpt-a');
  assert.deepEqual(
    { ia: fila.ia, esfuerzo: fila.esfuerzo, estacion: fila.estacion, alfa: fila.alfa, beta: fila.beta, banco: fila.banco, real: fila.real, tokensMedios: fila.tokensMedios },
    { ia: 'codex', esfuerzo: 'low', estacion: 'seguridad', alfa: 2, beta: sembrados, banco: sembrados, real: 0, tokensMedios: 1000 },
  );
  assert.ok(evidencia.catalogo.codex.includes('gpt-a'));
});

test('el banco no borra la evidencia que otro registra mientras corre', async () => {
  const home = temporal('banco-home-');
  const plan = planificarBanco({
    fase: 2,
    catalogos: CATALOGO_PRUEBA,
    evidencia: medida(evidenciaVacia(), 'codex', 'gpt-a', 'low', 'seguridad', 1, 0, 500),
    estaciones: ['seguridad'],
  });
  const externa = { ia: 'codex', modelo: 'gpt-otro', esfuerzo: 'high', estacion: 'codigo' };
  let llamadas = 0;
  const codex = conector('codex', async (e) => {
    llamadas += 1;
    // Entre la primera y la segunda ejecución, la persona registra un veredicto real (otro proceso guarda la evidencia).
    if (llamadas === 2) {
      const { evidencia } = await cargar(home);
      await guardar(home, actualizar(evidencia, externa, { aciertos: 3, fallos: 1, fuente: 'real' }));
    }
    return informe(e, []);
  });
  const { ejecuciones } = await ejecutarBanco(plan, { huella: plan.huella, home, conectores: { codex } });
  assert.ok(ejecuciones.every((e) => e.valida));
  const { evidencia } = await cargar(home);
  const real = evidencia.filas.find((f) => f.modelo === 'gpt-otro');
  assert.ok(real !== undefined, 'la observación real sobrevive');
  assert.deepEqual({ alfa: real.alfa, beta: real.beta, real: real.real }, { alfa: 7, beta: 3, real: 4 });
  // Y las seis ejecuciones del banco siguen sumadas (2 esfuerzos × 3 casos de seguridad): sin hallazgos, cada caso con
  // fallo suma sus fallos no encontrados y el limpio, un acierto.
  const porEsfuerzo = cargarCasos().filter((c) => c.estacion === 'seguridad').reduce((n, c) => n + Math.max(c.fallos.length, 1), 0);
  const delBanco = evidencia.filas.filter((f) => f.modelo === 'gpt-a');
  assert.equal(delBanco.reduce((n, f) => n + f.banco, 0), 2 * porEsfuerzo);
});

test('las rutas absolutas dentro del repo temporal se comparan como relativas', async () => {
  const home = temporal('banco-home-');
  const codex = conector('codex', async (e) => informe(e, [h(path.join(e.raiz, 'src', 'respaldo.ts'), 12, 'inyeccion-ordenes')]));
  const plan = planSeguridad();
  const { ejecuciones } = await ejecutarBanco(plan, { huella: plan.huella, home, conectores: { codex } });
  const sembrados = cargarCasos().find((c) => c.nombre === 'inyeccion-orden').fallos.length;
  assert.deepEqual(ejecuciones[0].medicion, { aciertos: 1, fallosNoEncontrados: sembrados - 1, falsosPositivos: 0 });
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
  // Los fallos sin encontrar de los dos casos con fallo, y el limpio sin hallazgos (1 acierto).
  const noEncontrados = cargarCasos().filter((c) => c.estacion === 'seguridad').reduce((n, c) => n + c.fallos.length, 0);
  const limpio = medios.find((e) => e.caso === 'seguridad/limpio-validacion');
  assert.deepEqual(limpio.observacion, { aciertos: 1, fallos: 0 });

  const { evidencia } = await cargar(home);
  assert.equal(evidencia.filas.length, 1);
  const [fila] = evidencia.filas;
  assert.deepEqual(
    { esfuerzo: fila.esfuerzo, alfa: fila.alfa, beta: fila.beta, banco: fila.banco, tokensMedios: fila.tokensMedios },
    { esfuerzo: 'medium', alfa: 2, beta: 1 + noEncontrados, banco: 1 + noEncontrados, tokensMedios: 0 },
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

/** Banco propio en `raiz`: dos casos de rendimiento con tres fallos sembrados cada uno y uno limpio. */
function bancoConVariosFallos() {
  const raiz = temporal('banco-casos-');
  const lineas = (marca) => Array.from({ length: 30 }, (_, i) => `export const v${i + 1} = ${marca};`).join('\n') + '\n';
  const crear = (nombre, fallos) => {
    const dir = path.join(raiz, 'rendimiento', nombre);
    for (const carpeta of ['base', 'cambio']) mkdirSync(path.join(dir, carpeta, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'base', 'src', 'a.js'), lineas('0'));
    writeFileSync(path.join(dir, 'cambio', 'src', 'a.js'), lineas(fallos.length > 0 ? `"SEMBRADO ${fallos.join(' ')}"` : '1'));
    writeFileSync(path.join(dir, 'esperado.json'), JSON.stringify({
      estacion: 'rendimiento',
      base: { archivos: ['src/a.js'] },
      cambio: { archivos: ['src/a.js'] },
      fallos: fallos.map((l) => ({ archivo: 'src/a.js', lineas: [l, l], categoria: 'lectura-repetida', claves: ['lectura', 'repetid'], descripcion: 'fallo sembrado' })),
    }));
  };
  crear('caso-a', [3, 12, 21]);
  crear('caso-b', [5, 15, 25]);
  crear('limpio', []);
  return raiz;
}

test('con medidas buenas en la fase 2, un par medido supera el umbral y gana al que no se ha medido', async () => {
  const home = temporal('banco-home-');
  const raizCasos = bancoConVariosFallos();
  assert.equal(cargarCasos(raizCasos).length, 3);
  // Un revisor perfecto: encuentra cada fallo sembrado y, en el caso limpio, no inventa nada. Su categoría
  // lleva una clave de los fallos sembrados.
  const codex = conector('codex', async (e) => {
    const sembrado = /SEMBRADO ([\d ]+)/u.exec(readFileSync(path.join(e.raiz, 'src', 'a.js'), 'utf8'));
    if (sembrado === null) return informe(e, [], { entrada: 400, salida: 100, total: 500 });
    const fallos = sembrado[1].split(' ').map(Number);
    return informe(e, fallos.map((l) => h('src/a.js', l, 'Rendimiento', 'Lectura repetida del disco')), { entrada: 800, salida: 200, total: 1000 });
  });
  const fase1 = medida(evidenciaVacia(), 'codex', 'gpt-a', 'low', 'rendimiento', 3, 0, 1000);
  await guardar(home, fase1);
  const plan = planificarBanco({ fase: 2, catalogos: CATALOGO_PRUEBA, evidencia: fase1, estaciones: ['rendimiento'], raizCasos });
  assert.equal(plan.ejecuciones.length, 2 * 3);
  const { ejecuciones } = await ejecutarBanco(plan, { huella: plan.huella, home, conectores: { codex }, raizCasos });
  assert.ok(ejecuciones.every((e) => e.valida), JSON.stringify(ejecuciones.map((e) => e.motivo)));

  const { evidencia } = await cargar(home);
  const fila = evidencia.filas.find((x) => x.modelo === 'gpt-a' && x.esfuerzo === 'medium');
  // Cada fallo sembrado encontrado es un acierto: 3 + 3 + 1 (el limpio) en una sola fase 2.
  assert.deepEqual({ alfa: fila.alfa, beta: fila.beta, banco: fila.banco }, { alfa: 8, beta: 1, banco: 7 });
  assert.ok(cuantil05(fila.alfa, fila.beta) >= UMBRALES.bajo);
  // Los tokens son la media por llamada (1000, 1000 y 500), no por observación.
  assert.equal(fila.tokensMedios, 2500 / 3);
  assert.equal(fila.muestrasTokens, 3);

  const sinMedir = { ia: 'codex', modelo: 'gpt-sin-medir', esfuerzo: 'high' };
  const medido = { ia: 'codex', modelo: 'gpt-a', esfuerzo: 'medium' };
  const decision = elegir({ estacion: 'rendimiento', riesgo: 'bajo', candidatos: [sinMedir, medido], evidencia });
  assert.deepEqual(decision.eleccion, medido);
  assert.equal(decision.alcanzaUmbral, true);
});

test('si no se puede borrar el repo temporal, el banco avisa, conserva la medición y sigue', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const home = temporal('banco-home-');
  const bloqueadas = [];
  const codex = conector('codex', async (e) => {
    // Una carpeta sin permiso de escritura con un archivo dentro: el borrado recursivo falla con EACCES.
    const bloqueada = path.join(e.raiz, 'bloqueada');
    mkdirSync(bloqueada);
    writeFileSync(path.join(bloqueada, 'x.txt'), 'x\n');
    chmodSync(bloqueada, 0o500);
    bloqueadas.push(bloqueada);
    return informe(e, [h('src/respaldo.ts', 12, 'inyeccion-ordenes')]);
  });
  try {
    const plan = planificarBanco({
      fase: 2,
      catalogos: CATALOGO_PRUEBA,
      evidencia: medida(evidenciaVacia(), 'codex', 'gpt-a', 'low', 'seguridad', 1, 0, 500),
      estaciones: ['seguridad'],
    });
    const resultado = await ejecutarBanco(plan, { huella: plan.huella, home, conectores: { codex } });
    assert.equal(resultado.ejecuciones.length, plan.ejecuciones.length, 'el banco no se corta');
    assert.ok(resultado.avisos.some((a) => /No se pudo borrar el repo temporal/u.test(a)), resultado.avisos.join('\n'));
  } finally {
    for (const b of bloqueadas) {
      chmodSync(b, 0o700);
      rmSync(path.dirname(b), { recursive: true, force: true });
    }
  }
});
