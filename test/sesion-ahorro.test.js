import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONSERVAR_AL_COMPACTAR, nivelDeCuota, notaDeCuota } from '../plugins/nexakit-sesion/hooks/aviso.js';

const uso = (cinco) => ({ context: { percent: 10 }, rateLimits: [{ kind: 'five_hour', percentUsed: cinco }, { kind: 'seven_day', percentUsed: 99 }] });

test('la cuota de 5 h decide si conviene delegar en serie', () => {
  assert.equal(nivelDeCuota(uso(69)), 0);
  assert.equal(nivelDeCuota(uso(70)), 1);
  assert.equal(nivelDeCuota(uso(90)), 2);
  assert.equal(nivelDeCuota({ rateLimits: [] }), 0);
  assert.equal(nivelDeCuota(undefined), 0);
  assert.match(notaDeCuota(1, 72), /72 %.*en serie/su);
  assert.match(notaDeCuota(2, 93), /93 %.*ligero/su);
  assert.equal(notaDeCuota(0, 10), undefined);
});

test('al compactar se pide conservar lo necesario para seguir la tarea', () => {
  for (const clave of ['rama', 'archivos', 'decisiones', 'pendiente', 'comprobaci', 'corrección']) assert.match(CONSERVAR_AL_COMPACTAR, new RegExp(clave, 'u'));
});

test('el mod añade la nota de cuota una vez por nivel y orienta la compactación de la sesión principal', async () => {
  const { register } = await import('../plugins/nexakit-sesion/hooks/register.js');
  const hooks = new Map();
  register((event, ...rest) => hooks.set(event, rest.at(-1)));
  let cinco = 50;
  const avisos = [];
  const api = { session: { usage: async () => uso(cinco) }, ui: { toast: (t) => avisos.push(t), status() {} } };
  const enviar = async (text) => { let enviado; await hooks.get('prompt.submit')(api, { text }, async (e) => { enviado = e.text; return e; }); return enviado; };
  assert.equal(await enviar('hola'), 'hola');
  cinco = 75;
  assert.match(await enviar('sigue'), /^sigue\n\n\[nexakit: .*en serie/su);
  assert.equal(await enviar('otra'), 'otra', 'no repite la nota en el mismo nivel');
  cinco = 95;
  assert.match(await enviar('más'), /ligero/u);

  let instrucciones;
  await hooks.get('session.compact')(api, { trigger: 'auto', messages: [] }, async (e) => { instrucciones = e.instructions; return { messages: [] }; });
  assert.match(instrucciones, /rama/u);
  await hooks.get('session.compact')(api, { trigger: 'manual', instructions: 'el plan', messages: [] }, async (e) => { instrucciones = e.instructions; return { messages: [] }; });
  assert.match(instrucciones, /^el plan\n\n/u);
  assert.ok(avisos.some((t) => /traspaso/u.test(t)));
  await hooks.get('session.compact')(api, { trigger: 'auto', agentId: 'a1', messages: [] }, async (e) => { instrucciones = e.instructions; return { messages: [] }; });
  assert.equal(instrucciones, undefined, 'la compactación de un subagente no se toca');
});
