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
