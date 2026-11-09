import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recomendarPorTexto } from '../plugins/nexakit-modelo/hooks/recomendar.js';
import { filasDeAgentes, medidor, nombreModelo, segmentosDeBarra, tono } from '../plugins/nexakit-modelo/hooks/barra.js';

const texto = (segmentos) => segmentos.map((s) => s.text).join('');

test('recomienda por el tipo de mensaje sin llamar a ningún modelo', () => {
  assert.deepEqual(pick(recomendarPorTexto('haz commit y push de esto')), ['haiku', 'low']);
  assert.deepEqual(pick(recomendarPorTexto('añade un botón de exportar en la tabla de sensores')), ['sonnet', 'medium']);
  assert.deepEqual(pick(recomendarPorTexto('la API da error 500 al guardar y no sé por qué')), ['opus', 'high']);
  assert.deepEqual(pick(recomendarPorTexto('diseña la arquitectura del módulo de pagos')), ['opus', 'medium']);
});

test('lo difícil gana a lo mecánico y una confirmación conserva la recomendación anterior', () => {
  assert.deepEqual(pick(recomendarPorTexto('ejecuta las pruebas, fallan y no sé por qué')), ['opus', 'high']);
  const previa = recomendarPorTexto('diseña la arquitectura del módulo de pagos');
  assert.equal(recomendarPorTexto('sí, dale', previa), previa);
  assert.equal(recomendarPorTexto('  ', previa), previa);
  assert.ok(recomendarPorTexto('ok').reason.length > 0);
});

test('casos de la revisión: confirmaciones exactas, alcance completo y error inocuo', () => {
  const ligera = recomendarPorTexto('haz commit');
  assert.deepEqual(pick(recomendarPorTexto('no funciona', ligera)), ['opus', 'high']);
  assert.deepEqual(pick(recomendarPorTexto('ok, depura esto', ligera)), ['opus', 'high']);
  assert.deepEqual(pick(recomendarPorTexto('sí, investiga seguridad', ligera)), ['opus', 'high']);
  assert.equal(recomendarPorTexto('ok dale gracias', ligera), ligera);
  assert.equal(recomendarPorTexto('¡sí, dale!', ligera), ligera);
  assert.notEqual(recomendarPorTexto('sídale', ligera), ligera);
  assert.deepEqual(pick(recomendarPorTexto('implementa el módulo y haz commit')), ['sonnet', 'medium']);
  assert.deepEqual(pick(recomendarPorTexto('traduce los mensajes de error')), ['haiku', 'low']);
  assert.deepEqual(pick(recomendarPorTexto('arregla el botón que no guarda')), ['opus', 'high']);
});

test('los nombres de modelo se leen como personas', () => {
  assert.equal(nombreModelo('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(nombreModelo('claude-sonnet-5-5[1m]'), 'Sonnet 5.5');
  assert.equal(nombreModelo('haiku'), 'Haiku');
  assert.equal(nombreModelo('gpt-raro'), 'gpt-raro');
  assert.equal(nombreModelo(undefined), 'modelo ?');
});

test('el medidor y el tono siguen los umbrales de la sesión', () => {
  assert.equal(medidor(7), '▰▱▱▱▱▱▱▱▱▱');
  assert.equal(medidor(100), '▰▰▰▰▰▰▰▰▰▰');
  assert.equal(medidor(0), '▱▱▱▱▱▱▱▱▱▱');
  assert.equal(tono(10), 'success');
  assert.equal(tono(60), 'warning');
  assert.equal(tono(80), 'error');
});

test('la barra junta modelo, esfuerzo, recomendación y uso en una línea', () => {
  const usage = { context: { percent: 7 }, rateLimits: [{ kind: 'five_hour', percentUsed: 2 }, { kind: 'seven_day', percentUsed: 40.4 }] };
  const linea = texto(segmentosDeBarra({ model: 'claude-opus-5-5', effort: 'medium', recommendation: { model: 'sonnet', effort: 'medium' }, usage }));
  assert.match(linea, /Opus 5\.5 · medium/);
  assert.match(linea, /→ Sonnet · medium/);
  assert.match(linea, /ctx ▰▱▱▱▱▱▱▱▱▱ 7%/);
  assert.match(linea, /5h 2%/);
  assert.match(linea, /sem 40%/);
});

test('la barra marca ✓ cuando coincide y no inventa lo que no sabe', () => {
  const coincide = texto(segmentosDeBarra({ model: 'claude-sonnet-5-5', effort: 'medium', recommendation: { model: 'sonnet', effort: 'medium' } }));
  assert.match(coincide, /✓/);
  assert.doesNotMatch(coincide, /→/);
  const sinEsfuerzo = texto(segmentosDeBarra({ model: 'claude-sonnet-5-5', effort: null, recommendation: { model: 'sonnet', effort: 'medium' } }));
  assert.doesNotMatch(sinEsfuerzo, /✓/);
  assert.doesNotMatch(sinEsfuerzo, /ctx|5h|sem/);
});

test('el mod recuerda el último esfuerzo entre turnos y dibuja la barra sobre el prompt', async () => {
  const { register } = await import('../plugins/nexakit-modelo/hooks/register.js');
  const hooks = new Map();
  register((event, ...rest) => { hooks.set(event, rest.at(-1)); });
  const statuses = [];
  let invalidaciones = 0;
  const api = {
    session: { model: async () => 'claude-opus-5-5', usage: async () => ({ context: { percent: 7 }, rateLimits: [] }) },
    tool: { register: async () => {} },
    ui: { status: (t) => statuses.push(t), invalidate: () => { invalidaciones += 1; }, resolve: () => ({ Box: 'Box', Text: 'Text' }) },
  };
  globalThis.h = (tag, props, ...children) => ({ tag, props, children });
  try {
    await hooks.get('session.start')(api, {}, async (e) => e);
    await hooks.get('prompt.submit')(api, { text: 'la API da error 500 y no sé por qué' }, async (e) => e);
    for await (const _ of hooks.get('turn.step')(api, { model: 'claude-opus-5-5', effort: 'medium' }, async function* () {})) { /* nada */ }
    await hooks.get('turn.complete')(api, {}, async (e) => e);
    const arbol = await hooks.get('ui.render')(api, { props: { hasSurvey: false } }, async () => 'engine');
    const plano = JSON.stringify(arbol);
    assert.match(plano, /Opus 5\.5/);
    assert.match(plano, /· medium/);
    assert.match(plano, /→ Opus · high/);
    assert.match(plano, /ctx/);
    assert.ok(invalidaciones > 0);
    assert.equal(statuses.filter((t) => t !== undefined).length, 0, 'ya no usa la línea de estado amarilla');
    assert.equal(await hooks.get('ui.render')(api, { props: { hasSurvey: true } }, async () => 'engine'), 'engine');
  } finally {
    delete globalThis.h;
  }
});

test('un esfuerzo visto en otro modelo no se atribuye al modelo nuevo', async () => {
  const { register } = await import('../plugins/nexakit-modelo/hooks/register.js?cambio');
  const hooks = new Map();
  register((event, ...rest) => { hooks.set(event, rest.at(-1)); });
  let model = 'claude-haiku-5-5';
  const api = { session: { model: async () => model, usage: async () => null }, tool: { register: async () => {} }, ui: { status() {}, invalidate() {}, resolve: () => ({ Box: 'Box', Text: 'Text' }) } };
  globalThis.h = (tag, props, ...children) => ({ tag, props, children });
  try {
    await hooks.get('session.start')(api, {}, async (e) => e);
    for await (const _ of hooks.get('turn.step')(api, { model, effort: 'low' }, async function* () {})) { /* nada */ }
    model = 'claude-opus-5-5';
    await hooks.get('tool.call')(api, { model: 'opus', effort: 'low', reason: 'prueba' });
    const plano = JSON.stringify(await hooks.get('ui.render')(api, { props: { hasSurvey: false } }, async () => 'engine'));
    assert.match(plano, /Opus 5\.5/);
    assert.match(plano, /esfuerzo \?/);
    assert.doesNotMatch(plano, /✓/);
  } finally {
    delete globalThis.h;
  }
});

test('cada subagente delegado es una fila con su nivel, el modelo real y su estado', () => {
  const filas = filasDeAgentes([
    { type: 'niveles:nivel-normal', description: 'implementar exportación', status: 'completed', model: 'claude-sonnet-5-5', effort: 'medium' },
    { type: 'niveles:nivel-ligero', description: 'correr pruebas', status: 'running', model: 'claude-haiku-5-5', effort: 'low' },
    { type: 'Explore', description: 'buscar usos', status: 'failed', model: null, effort: null },
  ]).map(texto);
  assert.match(filas[0], /↳ normal +Sonnet 5\.5 · medium +implementar exportación +✓/);
  assert.match(filas[1], /↳ ligero +Haiku 5\.5 · low +correr pruebas +…/);
  assert.match(filas[2], /↳ Explore +modelo \? +buscar usos +✗/);
  assert.equal(filasDeAgentes(Array.from({ length: 7 }, (_, i) => ({ type: 'x', description: String(i), status: 'running' }))).length, 4);
});

test('el mod registra el modelo real de cada subagente y lo dibuja bajo la línea principal', async () => {
  const { register } = await import('../plugins/nexakit-modelo/hooks/register.js?agentes');
  const hooks = new Map();
  register((event, ...rest) => { hooks.set(event, rest.at(-1)); });
  let estadoAgente = 'running';
  const api = {
    session: { model: async () => 'claude-opus-5-5', usage: async () => null },
    agent: { list: async () => [{ id: 'a1', type: 'niveles:nivel-normal', description: 'implementar exportación', status: estadoAgente }] },
    tool: { register: async () => {} },
    ui: { status() {}, invalidate() {}, resolve: () => ({ Box: 'Box', Text: 'Text' }) },
  };
  globalThis.h = (tag, props, ...children) => ({ tag, props, children });
  try {
    await hooks.get('session.start')(api, {}, async (e) => e);
    for await (const _ of hooks.get('turn.step')(api, { model: 'claude-opus-5-5', effort: 'medium' }, async function* () {})) { /* nada */ }
    for await (const _ of hooks.get('turn.step')(api, { model: 'claude-sonnet-5-5', effort: 'medium', agentId: 'a1' }, async function* () {})) { /* nada */ }
    let plano = JSON.stringify(await hooks.get('ui.render')(api, { props: { hasSurvey: false } }, async () => 'engine'));
    assert.match(plano, /Opus 5\.5/);
    assert.match(plano, /Sonnet 5\.5 · medium/);
    assert.match(plano, /…/);
    estadoAgente = 'completed';
    await hooks.get('turn.complete')(api, {}, async (e) => e);
    plano = JSON.stringify(await hooks.get('ui.render')(api, { props: { hasSurvey: false } }, async () => 'engine'));
    assert.match(plano, /✓/);
    await hooks.get('prompt.submit')(api, { text: 'otra cosa' }, async (e) => e);
    plano = JSON.stringify(await hooks.get('ui.render')(api, { props: { hasSurvey: false } }, async () => 'engine'));
    assert.doesNotMatch(plano, /implementar exportación/, 'al pedir otra cosa se limpian los terminados');
  } finally {
    delete globalThis.h;
  }
});

test('preguntar por qué o pedir investigar no escala a Opus: es trabajo habitual', () => {
  assert.deepEqual(pick(recomendarPorTexto('¿por qué usamos zod aquí?')), ['sonnet', 'medium']);
  assert.deepEqual(pick(recomendarPorTexto('investiga cómo funciona el login')), ['sonnet', 'medium']);
  assert.deepEqual(pick(recomendarPorTexto('el login falla y no sé por qué')), ['opus', 'high']);
});

test('lo mecánico se delega en nivel-ligero y un fallo ofrece nivel-alto como alternativa', () => {
  assert.equal(recomendarPorTexto('haz commit y push de esto').delegar, 'nivel-ligero');
  assert.equal(recomendarPorTexto('arregla el botón que no guarda').delegar, 'nivel-alto');
  assert.equal(recomendarPorTexto('añade un botón de exportar').delegar, undefined);
});

test('la barra no propone cambiar de modelo cuando eso relee mucho contexto sin caché', () => {
  const mecanica = recomendarPorTexto('haz commit');
  const fallo = recomendarPorTexto('arregla el botón que no guarda');
  const barra = (model, effort, recommendation, percent) =>
    texto(segmentosDeBarra({ model, effort, recommendation, usage: { context: { percent }, rateLimits: [] } }));
  assert.match(barra('claude-opus-5-5', 'medium', mecanica, 5), /→ delega: nivel-ligero/);
  assert.doesNotMatch(barra('claude-opus-5-5', 'medium', mecanica, 5), /→ Haiku/);
  assert.match(barra('claude-sonnet-5-5', 'medium', fallo, 45), /→ delega: nivel-alto/);
  assert.match(barra('claude-sonnet-5-5', 'medium', fallo, 10), /→ Opus · high/);
  assert.match(barra('claude-opus-5-5', 'medium', fallo, 70), /→ Opus · high/, 'cambiar el esfuerzo no rompe la caché');
  assert.match(barra('claude-haiku-5-5', 'low', mecanica, 50), /✓/);
});

test('la barra muestra el acierto de caché desde el segundo turno, con su tono', () => {
  const con = (cache) => texto(segmentosDeBarra({ model: 'claude-sonnet-5-5', effort: 'medium', cache }));
  assert.doesNotMatch(con({ read: 0, creation: 900, input: 10, turnos: 1 }), /caché/);
  assert.match(con({ read: 900, creation: 50, input: 50, turnos: 3 }), /caché 90%/);
  const segmento = (cache) => segmentosDeBarra({ model: 'claude-sonnet-5-5', effort: 'medium', cache }).find((s) => /%$/.test(s.text));
  assert.equal(segmento({ read: 90, creation: 10, input: 0, turnos: 2 }).color, 'success');
  assert.equal(segmento({ read: 60, creation: 40, input: 0, turnos: 2 }).color, 'warning');
  assert.equal(segmento({ read: 20, creation: 80, input: 0, turnos: 2 }).color, 'error');
  assert.doesNotMatch(con({ read: 0, creation: 0, input: 0, turnos: 4 }), /caché/, 'sin tokens no inventa un porcentaje');
});

test('el mod acumula la caché de los turnos principales, no la de los subagentes', async () => {
  const { register } = await import('../plugins/nexakit-modelo/hooks/register.js?cache');
  const hooks = new Map();
  register((event, ...rest) => { hooks.set(event, rest.at(-1)); });
  const api = { session: { model: async () => 'claude-sonnet-5-5', usage: async () => null }, tool: { register: async () => {} }, ui: { status() {}, invalidate() {}, resolve: () => ({ Box: 'Box', Text: 'Text' }) } };
  const turno = (usage, agentId) => hooks.get('turn.complete')(api, agentId ? { agentId } : {}, async () => ({ text: '', usage }));
  globalThis.h = (tag, props, ...children) => ({ tag, props, children });
  try {
    await hooks.get('session.start')(api, {}, async (e) => e);
    await turno({ model: 'claude-sonnet-5-5', input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 990 });
    await turno({ model: 'claude-haiku-5-5', input_tokens: 0, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 5000 }, 'sub');
    await turno({ model: 'claude-sonnet-5-5', input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2990, cache_creation_input_tokens: 0 });
    const plano = JSON.stringify(await hooks.get('ui.render')(api, { props: { hasSurvey: false } }, async () => 'engine'));
    assert.match(plano, /caché "\]\},\{[^}]*\},"children":\["75%"\]/);
    await hooks.get('session.end')(api, {}, async (e) => e);
    await turno({ model: 'claude-sonnet-5-5', input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 990 });
    const nueva = JSON.stringify(await hooks.get('ui.render')(api, { props: { hasSurvey: false } }, async () => 'engine'));
    assert.doesNotMatch(nueva, /caché/, 'una sesión nueva empieza a contar de cero');
  } finally {
    delete globalThis.h;
  }
});

test('la recomendación se actualiza mientras se escribe, antes de enviar', async () => {
  const { register } = await import('../plugins/nexakit-modelo/hooks/register.js?escribiendo');
  const hooks = new Map();
  register((event, ...rest) => { hooks.set(event, rest.at(-1)); });
  let invalidaciones = 0;
  const api = { session: { model: async () => 'claude-sonnet-5-5', usage: async () => null }, tool: { register: async () => {} }, ui: { status() {}, invalidate() { invalidaciones += 1; }, resolve: () => ({ Box: 'Box', Text: 'Text' }) } };
  const escribe = (text) => hooks.get('prompt.edit')(api, { text: '', cursor: 0, start: 0, end: 0, inputText: text }, async () => ({ text, cursor: text.length }));
  const pinta = async () => JSON.stringify(await hooks.get('ui.render')(api, { props: { hasSurvey: false } }, async () => 'engine'));
  globalThis.h = (tag, props, ...children) => ({ tag, props, children });
  try {
    await hooks.get('session.start')(api, {}, async (e) => e);
    for await (const _ of hooks.get('turn.step')(api, { model: 'claude-sonnet-5-5', effort: 'medium' }, async function* () {})) { /* nada */ }
    const r = await escribe('el login falla al guardar');
    assert.deepEqual(r, { text: 'el login falla al guardar', cursor: 25 }, 'devuelve la caja tal cual');
    assert.match(await pinta(), /→ Opus · high/);
    const antes = invalidaciones;
    await escribe('el login falla al guardar.');
    assert.equal(invalidaciones, antes, 'no redibuja si la recomendación no cambia');
    await hooks.get('prompt.submit')(api, { text: 'el login falla al guardar.' }, async (e) => e);
    await escribe('');
    assert.match(await pinta(), /→ Opus · high/, 'con la caja vacía queda la del último mensaje enviado');
    await escribe('ok dale');
    assert.match(await pinta(), /→ Opus · high/, 'una confirmación conserva la del último enviado');
  } finally {
    delete globalThis.h;
  }
});

function pick(r) {
  return [r.model, r.effort];
}
