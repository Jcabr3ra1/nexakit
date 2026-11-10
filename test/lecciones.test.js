import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claveDeComando, claveDeError, esCorreccion, NOTA_CORRECCION } from '../plugins/nexakit-lecciones/hooks/lecciones.js';

test('reconoce las correcciones habituales y no los mensajes normales', () => {
  for (const t of ['no, eso no es lo que pedí', 'otra vez lo mismo', 'otra vez con eso?', '¿otra vez?', 'te dije que en español', 'ya te había dicho que no hicieras commit',
    'háblame en español', 'no hagas eso', 'deja de pedirme revisión', 'eso está mal', 'nunca uses ese comando', 'siempre que hagas un PR, avísame antes',
    'te equivocaste de rama', 'no era eso', 'por qué volviste a hacerlo'])
    assert.ok(esCorreccion(t), t);
  for (const t of ['añade un botón de exportar', 'sí, dale', 'listo', '¿qué subagentes hay?', 'no sé cómo se llama el archivo, búscalo', 'hagamos el PR',
    'ejecuta exactamente el mismo comando otra vez', 'corre las pruebas otra vez', 'siempre que puedas usa sonnet', 'no me acuerdo', 'deja de lado eso por ahora y sigue'])
    assert.equal(esCorreccion(t), false, t);
  assert.match(NOTA_CORRECCION, /memoria persistente/u);
  assert.match(NOTA_CORRECCION, /feedback/u);
  assert.match(NOTA_CORRECCION, /Si de verdad corrige/u);
});

test('dos comandos que solo difieren en espacios son el mismo; el permiso de repetir no cuenta', () => {
  assert.equal(claveDeComando('git   rebase  origin/main '), claveDeComando('git rebase origin/main'));
  assert.equal(claveDeComando('NEXAKIT_REPETIR=1 git rebase origin/main'), claveDeComando('git rebase origin/main'));
  assert.notEqual(claveDeComando('git rebase origin/main'), claveDeComando('git rebase main'));
});

test('el tipo de error ignora números, rutas temporales y horas', () => {
  assert.equal(claveDeError('Error: ENOENT /tmp/abc123/x.js línea 42'), claveDeError('Error: ENOENT /tmp/zz9/x.js línea 7'));
  assert.equal(claveDeError(''), null);
});

const montar = async () => {
  const { register } = await import(`../plugins/nexakit-lecciones/hooks/register.js?${Math.random()}`);
  const hooks = new Map();
  register((event, matcher, hook) => hooks.set(`${event}:${matcher?.tool ?? ''}`, hook ?? matcher));
  return (event, tool = '') => hooks.get(`${event}:${tool}`);
};
const falla = (stderr) => async () => ({ ref: 'x', isError: true, result: { stdout: '', stderr, interrupted: false } });
const bien = async () => ({ ref: 'ok', result: { stdout: 'ok', stderr: '', interrupted: false } });

test('frena un comando que acaba de fallar igual, salvo que algo haya cambiado o se pida repetir', async () => {
  const h = await montar();
  const bash = h('tool.call');
  const fallo = await bash({}, { tool: 'Bash', command: 'git rebase origin/main' }, falla('error: cannot rebase: You have unstaged changes.'));
  assert.equal(fallo.isError, true);
  const frenado = await bash({}, { tool: 'Bash', command: 'git  rebase origin/main' }, async () => assert.fail('no debía ejecutarse'));
  assert.match(frenado.deny, /ya falló.*unstaged changes.*NEXAKIT_REPETIR=1/su);
  assert.equal((await bash({}, { tool: 'Bash', command: 'NEXAKIT_REPETIR=1 git rebase origin/main' }, bien)).ref, 'ok');

  await bash({}, { tool: 'Bash', command: 'npm test' }, falla('not ok 3'));
  await h('tool.call')({}, { tool: 'Edit', file_path: 'a.js' }, bien);
  assert.equal((await bash({}, { tool: 'Bash', command: 'npm test' }, bien)).ref, 'ok', 'tras editar, repetir es legítimo');

  await bash({}, { tool: 'Bash', command: 'git push' }, falla('rejected'));
  await bash({}, { tool: 'Bash', command: 'git pull --rebase' }, bien);
  assert.equal((await bash({}, { tool: 'Bash', command: 'git push' }, bien)).ref, 'ok', 'otro comando que cambia el estado también vale');

  await bash({}, { tool: 'Bash', command: 'make' }, falla('boom'));
  const otroAgente = await bash({}, { tool: 'Bash', command: 'make', agentId: 'a1' }, bien);
  assert.equal(otroAgente.ref, 'ok', 'cada subagente lleva su propio historial');
});

test('al tercer error del mismo tipo pide parar y cambiar de enfoque', async () => {
  const h = await montar();
  const bash = h('tool.call');
  let r;
  for (const c of ['node a.js', 'node b.js', 'node c.js']) r = await bash({}, { tool: 'Bash', command: c }, falla(`Error: Cannot find module '/tmp/${c}'`));
  assert.ok(r.context?.some((t) => /3 veces.*para/su.test(t)));
  assert.equal(r.ref, 'x', 'conserva la respuesta del motor: sin ref, el motor revalida el resultado contra la forma de salida de Bash');
  assert.equal(r.isError, true);
});

test('la nota del tercer error no rehace un resultado de error en texto', async () => {
  // Un Bash fallido llega con el texto del error como resultado: rehacerlo sin `ref` hacía que el motor lo
  // rechazara («expected object, received string»).
  const h = await montar();
  const bash = h('tool.call');
  const fallaTexto = (c) => async () => ({ ref: 7, text: `Exit code 1\nError: Cannot find module '/tmp/${c}'`, isError: true, result: `Exit code 1\nError: Cannot find module '/tmp/${c}'` });
  let r;
  for (const c of ['node a.js', 'node b.js', 'node c.js']) r = await bash({}, { tool: 'Bash', command: c }, fallaTexto(c));
  assert.equal(r.ref, 7);
  assert.equal(r.text, r.result);
  assert.ok(r.context?.some((t) => /3 veces/u.test(t)));
});

test('añade la nota solo a los mensajes que corrigen', async () => {
  const h = await montar();
  const enviar = async (text) => { let e2; await h('prompt.submit')({}, { text }, async (e) => { e2 = e; return e; }); return e2.text; };
  assert.equal(await enviar('añade un botón'), 'añade un botón');
  assert.match(await enviar('te dije que en español'), /^te dije que en español\n\n\[nexakit: .*memoria persistente/su);
});

// --- Registro propio de lecciones: eventos, correcciones pendientes y lecciones guardadas ---

const DIA = 24 * 60 * 60 * 1000;
const HOME = '/casa';
const REGISTRO = `${HOME}/.nexakit/lecciones.jsonl`;
const MEMORIA = `${HOME}/.claude/projects/-Users-yo-proyecto/memory/feedback-espanol.md`;

// Un `$` mínimo con el sistema de archivos y el reloj en memoria; `ahora` se mueve a mano.
function entorno({ previo = '', fallaEscritura = false } = {}) {
  const archivos = new Map(previo ? [[REGISTRO, previo]] : []);
  const reloj = { ahora: 1_000_000_000_000 };
  const $ = {
    env: { get: async (k) => (k === 'HOME' ? HOME : undefined) },
    clock: { now: async () => reloj.ahora },
    fs: {
      exists: async (r) => archivos.has(r),
      read: async (r) => archivos.get(r),
      write: async (r, t) => { if (fallaEscritura) throw new Error('disco lleno'); archivos.set(r, t); },
    },
  };
  const eventos = () => (archivos.get(REGISTRO) ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { $, reloj, eventos, archivos };
}
const linea = (e) => `${JSON.stringify(e)}\n`;

test('las reglas puras: podar, pendientes, texto seguro y ruta de memoria', async () => {
  const { podarEventos, pendientes, textoSeguro, esRutaDeMemoria, leerEventos } = await import('../plugins/nexakit-lecciones/hooks/lecciones.js');
  const ahora = 1_000_000_000_000;
  const evs = [
    { fecha: ahora - 100 * DIA, tipo: 'correccion', texto: 'vieja' },
    { fecha: ahora - 5 * DIA, tipo: 'correccion', texto: 'a' },
    { fecha: ahora - 4 * DIA, tipo: 'guardada' },
    { fecha: ahora - 3 * DIA, tipo: 'correccion', texto: 'b' },
    { fecha: ahora - 2 * DIA, tipo: 'avisada' },
    { fecha: ahora - 1 * DIA, tipo: 'correccion', texto: 'c' },
  ];
  assert.deepEqual(podarEventos(evs, ahora).map((e) => e.texto ?? e.tipo), ['a', 'guardada', 'b', 'avisada', 'c'], 'quita lo de más de 90 días');
  assert.equal(podarEventos(Array.from({ length: 700 }, (_, i) => ({ fecha: ahora - i, tipo: 'freno' })), ahora).length, 500, 'tope de 500');
  assert.deepEqual(pendientes(evs).map((e) => e.texto), ['c'], 'solo lo que sigue sin guardar y aún no se ha recordado');
  assert.deepEqual(pendientes(evs.slice(0, 2)).map((e) => e.texto), ['vieja', 'a']);
  assert.deepEqual(leerEventos('basura\n{"fecha":1,"tipo":"freno"}\n{"tipo":"raro","fecha":2}\n{"fecha":"x","tipo":"freno"}\n').map((e) => e.tipo), ['freno'], 'ignora líneas inválidas y tipos desconocidos');
  assert.equal(textoSeguro('háblame en español'), 'háblame en español');
  assert.equal(textoSeguro('x'.repeat(300)).length, 200);
  assert.match(textoSeguro('te dije que mi token=abc123def456 no se pega'), /omitido/u);
  assert.match(textoSeguro('la clave es sk-abcdefghijklmnop1234'), /omitido/u);
  assert.equal(esRutaDeMemoria('/Users/yo/.claude/projects/-Users-yo-p/memory/feedback.md'), true);
  assert.equal(esRutaDeMemoria('C:\\Users\\yo\\.claude\\projects\\p\\memory\\feedback.md'), true);
  assert.equal(esRutaDeMemoria('/Users/yo/.claude/projects/p/memory/MEMORY.md'), false, 'el índice no es una lección');
  assert.equal(esRutaDeMemoria('/Users/yo/proyecto/memory/notas.md'), false);
  assert.equal(esRutaDeMemoria('/Users/yo/.claude/projects/p/memory/foto.png'), false);
});

test('registra los frenos y el error repetido tres veces', async () => {
  const h = await montar();
  const { $, eventos } = entorno();
  const bash = h('tool.call');
  await bash($, { tool: 'Bash', command: 'git rebase origin/main' }, falla('error: cannot rebase: unstaged changes'));
  await bash($, { tool: 'Bash', command: 'git rebase origin/main' }, async () => assert.fail('no debía ejecutarse'));
  assert.deepEqual(eventos().map((e) => e.tipo), ['freno']);
  for (const c of ['node a.js', 'node b.js', 'node c.js']) await bash($, { tool: 'Bash', command: c }, falla(`Error: Cannot find module '/tmp/${c}'`));
  assert.deepEqual(eventos().map((e) => e.tipo), ['freno', 'repeticion']);
});

test('una corrección se apunta con su texto y una frase con un secreto no', async () => {
  const h = await montar();
  const { $, eventos } = entorno();
  const enviar = async (text) => { let e2; await h('prompt.submit')($, { text }, async (e) => { e2 = e; return e; }); return e2.text; };
  await enviar('añade un botón');
  assert.deepEqual(eventos(), [], 'un mensaje normal no se apunta');
  await enviar('te dije que en español');
  await enviar('te dije que mi token=abc123def456 no se pega');
  const [uno, dos] = eventos();
  assert.deepEqual([uno.tipo, uno.texto], ['correccion', 'te dije que en español']);
  assert.equal(dos.tipo, 'correccion');
  assert.match(dos.texto, /omitido/u);
  assert.doesNotMatch(JSON.stringify(eventos()), /abc123def456/u);
});

test('escribir en la memoria persistente marca las correcciones como guardadas; un error o otra ruta no', async () => {
  const h = await montar();
  const { $, eventos } = entorno();
  const herramienta = h('tool.call');
  await h('prompt.submit')($, { text: 'te dije que en español' }, async (e) => e);
  await herramienta($, { tool: 'Write', file_path: MEMORIA }, async () => ({ ref: 1, isError: true, result: 'sin permiso' }));
  await herramienta($, { tool: 'Write', file_path: '/casa/proyecto/notas.md' }, bien);
  assert.deepEqual(eventos().map((e) => e.tipo), ['correccion']);
  await herramienta($, { tool: 'Write', file_path: MEMORIA }, bien);
  assert.deepEqual(eventos().map((e) => e.tipo), ['correccion', 'guardada']);
  await herramienta($, { tool: 'Edit', file_path: MEMORIA }, bien);
  assert.equal(eventos().filter((e) => e.tipo === 'guardada').length, 1, 'sin correcciones pendientes no apunta otra guardada');
});

test('al empezar una sesión recuerda una sola vez las correcciones que quedaron sin guardar', async () => {
  const ahora = 1_000_000_000_000;
  const previo = linea({ fecha: ahora - 3 * DIA, tipo: 'correccion', texto: 'ya guardada' }) + linea({ fecha: ahora - 2 * DIA, tipo: 'guardada' })
    + linea({ fecha: ahora - DIA, tipo: 'correccion', texto: 'háblame en español' }) + linea({ fecha: ahora - DIA + 1, tipo: 'correccion', texto: 'no hagas commit solo' });
  const h = await montar();
  const { $, eventos } = entorno({ previo });
  const enviar = async (text) => { let e2; await h('prompt.submit')($, { text }, async (e) => { e2 = e; return e; }); return e2.text; };
  const primero = await enviar('añade un botón');
  assert.match(primero, /^añade un botón\n\n\[nexakit: .*2 correcciones.*«háblame en español».*«no hagas commit solo».*memoria persistente/su);
  assert.doesNotMatch(primero, /ya guardada/u);
  assert.equal(eventos().at(-1).tipo, 'avisada');
  assert.equal(await enviar('otra cosa'), 'otra cosa', 'solo al primer mensaje de la sesión');
  const h2 = await montar();
  const otra = async (text) => { let e2; await h2('prompt.submit')($, { text }, async (e) => { e2 = e; return e; }); return e2.text; };
  assert.equal(await otra('sesión siguiente'), 'sesión siguiente', 'tras avisar, no se repite en otra sesión');
});

test('registrar nunca rompe el turno aunque el disco falle', async () => {
  const h = await montar();
  const { $ } = entorno({ fallaEscritura: true });
  let e2;
  await h('prompt.submit')($, { text: 'te dije que en español' }, async (e) => { e2 = e; return e; });
  assert.match(e2.text, /memoria persistente/u);
  const r = await h('tool.call')($, { tool: 'Bash', command: 'make' }, falla('boom'));
  assert.equal(r.isError, true);
});

test('cada lección guardada resuelve una sola corrección, la más reciente; descartar las resuelve todas', async () => {
  const { sinGuardar, pendientes } = await import('../plugins/nexakit-lecciones/hooks/lecciones.js');
  const c = (texto) => ({ fecha: 1, tipo: 'correccion', texto });
  const g = { fecha: 1, tipo: 'guardada' };
  const textos = (evs) => evs.map((e) => e.texto);
  assert.deepEqual(textos(sinGuardar([c('a'), c('b'), g])), ['a'], 'la guardada resuelve la última, no las dos');
  assert.deepEqual(textos(sinGuardar([c('a'), c('b'), g, g])), []);
  assert.deepEqual(textos(sinGuardar([g, c('a')])), ['a'], 'una guardada anterior no resuelve una corrección posterior');
  assert.deepEqual(textos(sinGuardar([c('a'), g, g, c('b')])), ['b'], 'una guardada de más no queda a crédito');
  assert.deepEqual(textos(sinGuardar([c('a'), c('b'), { fecha: 1, tipo: 'descartada' }, c('d')])), ['d']);
  assert.deepEqual(textos(pendientes([c('a'), c('b'), { fecha: 1, tipo: 'avisada' }, g, c('d')])), ['d'], 'lo ya recordado no se repite');
  assert.deepEqual(textos(sinGuardar([c('a'), c('b'), { fecha: 1, tipo: 'avisada' }, g, c('d')])), ['a', 'd']);
});

test('dos correcciones y una sola nota de memoria dejan una pendiente; el índice MEMORY.md no cuenta', async () => {
  const h = await montar();
  const { $, eventos } = entorno();
  const herramienta = h('tool.call');
  await h('prompt.submit')($, { text: 'te dije que en español' }, async (e) => e);
  await h('prompt.submit')($, { text: 'no vuelvas a hacer commit solo' }, async (e) => e);
  await herramienta($, { tool: 'Write', file_path: MEMORIA }, bien);
  await herramienta($, { tool: 'Edit', file_path: MEMORIA.replace('feedback-espanol.md', 'MEMORY.md') }, bien);
  assert.deepEqual(eventos().map((e) => e.tipo), ['correccion', 'correccion', 'guardada']);
  await herramienta($, { tool: 'Write', file_path: MEMORIA.replace('espanol', 'commit') }, bien);
  await herramienta($, { tool: 'Write', file_path: MEMORIA.replace('espanol', 'otra') }, bien);
  assert.equal(eventos().filter((e) => e.tipo === 'guardada').length, 2, 'sin pendientes no apunta más');
});
