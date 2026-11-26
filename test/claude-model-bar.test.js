import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recomendarPorTexto } from '../plugins/nexakit-modelo/hooks/recomendar.js';
import {
  activoDeTexto, cacheDeTokens, columnaDeAgentes, columnaDeFabrica, filasDeAgentes, filasDeFabrica, formatoReinicio, formatoTokens, medidor, nombreModelo, segmentosDeBarra, sumarTokens, tokensNuevos, tokensVacios, tono, totalDeTokens,
} from '../plugins/nexakit-modelo/hooks/barra.js';

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
  assert.deepEqual(pick(recomendarPorTexto('no funciona', ligera)), ['sonnet', 'high']);
  assert.deepEqual(pick(recomendarPorTexto('ok, depura esto', ligera)), ['sonnet', 'high']);
  assert.deepEqual(pick(recomendarPorTexto('sí, investiga seguridad', ligera)), ['opus', 'high']);
  assert.equal(recomendarPorTexto('ok dale gracias', ligera), ligera);
  assert.equal(recomendarPorTexto('¡sí, dale!', ligera), ligera);
  assert.notEqual(recomendarPorTexto('sídale', ligera), ligera);
  assert.deepEqual(pick(recomendarPorTexto('implementa el módulo y haz commit')), ['sonnet', 'medium']);
  assert.deepEqual(pick(recomendarPorTexto('traduce los mensajes de error')), ['haiku', 'low']);
  assert.deepEqual(pick(recomendarPorTexto('arregla el botón que no guarda')), ['sonnet', 'high']);
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
  // tool.call lleva un filtro por herramienta (la recomendación y el veto de subagentes): se guarda por separado.
  register((event, ...rest) => { hooks.set(rest.length > 1 && rest[0]?.tool ? `${event}:${rest[0].tool}` : event, rest.at(-1)); });
  let model = 'claude-haiku-5-5';
  const api = { session: { model: async () => model, usage: async () => null }, tool: { register: async () => {} }, ui: { status() {}, invalidate() {}, resolve: () => ({ Box: 'Box', Text: 'Text' }) } };
  globalThis.h = (tag, props, ...children) => ({ tag, props, children });
  try {
    await hooks.get('session.start')(api, {}, async (e) => e);
    for await (const _ of hooks.get('turn.step')(api, { model, effort: 'low' }, async function* () {})) { /* nada */ }
    model = 'claude-opus-5-5';
    await hooks.get('tool.call:mcp__nexakit-modelo__nexakit_recomendacion')(api, { model: 'opus', effort: 'low', reason: 'prueba' });
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
  assert.match(filas[1], /↳ ligero +Haiku 5\.5 · low +correr pruebas +●/);
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
    assert.match(plano, /●/, 'en marcha se dibuja con un punto, no con puntos suspensivos');
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
  assert.deepEqual(pick(recomendarPorTexto('¿por qué usamos zod aquí?')), ['sonnet', 'low']);
  assert.deepEqual(pick(recomendarPorTexto('investiga cómo funciona el login')), ['sonnet', 'medium']);
  assert.deepEqual(pick(recomendarPorTexto('el login falla y no sé por qué')), ['opus', 'high']);
});

test('lo mecánico se delega en nivel-ligero y un fallo ofrece nivel-alto como alternativa', () => {
  assert.equal(recomendarPorTexto('haz commit y push de esto').delegar, 'nivel-ligero');
  assert.equal(recomendarPorTexto('el botón sigue fallando y no sé por qué').delegar, 'nivel-alto');
  assert.equal(recomendarPorTexto('arregla el botón que no guarda').delegar, undefined, 'un fallo normal solo sube el esfuerzo');
  assert.equal(recomendarPorTexto('añade un botón de exportar').delegar, undefined);
});

test('la barra no propone cambiar de modelo cuando eso relee mucho contexto sin caché', () => {
  const mecanica = recomendarPorTexto('haz commit');
  const fallo = recomendarPorTexto('el botón sigue fallando y no sé por qué');
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
    assert.match(await pinta(), /→ Sonnet · high/);
    const antes = invalidaciones;
    await escribe('el login falla al guardar.');
    assert.equal(invalidaciones, antes, 'no redibuja si la recomendación no cambia');
    await hooks.get('prompt.submit')(api, { text: 'el login falla al guardar.' }, async (e) => e);
    await escribe('');
    assert.match(await pinta(), /→ Sonnet · high/, 'con la caja vacía queda la del último mensaje enviado');
    await escribe('ok dale');
    assert.match(await pinta(), /→ Sonnet · high/, 'una confirmación conserva la del último enviado');
  } finally {
    delete globalThis.h;
  }
});

test('un fallo normal sube el esfuerzo; el modelo solo sube si ya se intentó, es intermitente o es de seguridad', () => {
  for (const t of ['corrígela', 'haz entonces los arreglos', 'arrglemos los fallos por favor', 'hay un error en el PR', 'mira que no carga, se queda pegado'])
    assert.deepEqual(pick(recomendarPorTexto(t)), ['sonnet', 'high'], t);
  for (const t of ['si no hay endpoints todavía no los crees', 'no sé por qué estás cambiando los fondos'])
    assert.deepEqual(pick(recomendarPorTexto(t)), ['sonnet', 'medium'], t);
  assert.deepEqual(pick(recomendarPorTexto('no sé por qué no aparece todavía la recomendación')), ['opus', 'high']);
  for (const t of ['sigue fallando después del arreglo', 'todavía no funciona el login', 'a veces falla al guardar', 'es un fallo intermitente', 'revisa si hay una vulnerabilidad', 'hay una condición de carrera en el bloqueo', 'otra vez el mismo error'])
    assert.deepEqual(pick(recomendarPorTexto(t)), ['opus', 'high'], t);
});

test('preguntas y continuaciones no se toman por trabajo mecánico ni por diseño', () => {
  for (const t of ['¿ya están instalados los mods?', 'listo, ¿ya hiciste el merge y todo?', 'tengo una pregunta: ¿esa skill aprende de los errores?'])
    assert.deepEqual(pick(recomendarPorTexto(t)), ['sonnet', 'low'], t);
  for (const t of ['haz el commit y sigue con el paso 2', 'sí, haz el commit y sigue con el plan', 'haz el commit y sigues', 'terminemos los otros puntos antes de hacer commit'])
    assert.deepEqual(pick(recomendarPorTexto(t)), ['sonnet', 'medium'], t);
  assert.deepEqual(pick(recomendarPorTexto('instala las skills y rediseña el panel')), ['opus', 'medium'], 'rediseñar manda sobre instalar');
  for (const t of ['haz commit, push, pr y merge', 'listo, haz el merge y elimina las ramas', 'haz commit, push, pr y merge para seguir con taller'])
    assert.equal(recomendarPorTexto(t).delegar, 'nivel-ligero', t);
  const previa = recomendarPorTexto('diseña la arquitectura del módulo de pagos');
  assert.equal(recomendarPorTexto('sí, confirmo, sigue con el diseño', previa), previa, 'seguir con el diseño conserva la recomendación');
  assert.deepEqual(pick(recomendarPorTexto('está bien así, sigue con el diseño')), ['sonnet', 'medium']);
  assert.deepEqual(pick(recomendarPorTexto('rediseñemos el flujo de compras')), ['opus', 'medium']);
});

test('con mucho contexto la barra no propone bajar de modelo: solo ajusta el esfuerzo', () => {
  const fallo = recomendarPorTexto('arregla el botón que no guarda');
  const barra = (model, effort, recommendation, percent) =>
    texto(segmentosDeBarra({ model, effort, recommendation, usage: { context: { percent }, rateLimits: [] } }));
  assert.match(barra('claude-opus-5-5', 'medium', fallo, 50), /→ high/);
  assert.doesNotMatch(barra('claude-opus-5-5', 'medium', fallo, 50), /Sonnet/);
  assert.match(barra('claude-opus-5-5', 'high', fallo, 50), /✓/);
  assert.match(barra('claude-opus-5-5', 'medium', fallo, 5), /→ Sonnet · high/, 'con poco contexto cambiar sale barato');
  assert.match(barra('claude-sonnet-5-5', 'medium', fallo, 50), /→ Sonnet · high/);
});

function pick(r) {
  return [r.model, r.effort];
}

test('el mod detecta la caché fría y los turnos de rutina seguidos en un modelo caro', async () => {
  const { register } = await import('../plugins/nexakit-modelo/hooks/register.js?decision');
  const hooks = new Map();
  register((event, ...rest) => { hooks.set(event, rest.at(-1)); });
  let ahora = 1_000_000;
  const usage = { context: { percent: 50, tokens: 100_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 10 }] };
  const api = { clock: { now: async () => ahora }, session: { model: async () => 'claude-opus-5-5', usage: async () => usage }, tool: { register: async () => {} }, ui: { status() {}, invalidate() {}, resolve: () => ({ Box: 'Box', Text: 'Text' }) } };
  const pinta = async () => JSON.stringify(await hooks.get('ui.render')(api, { props: { hasSurvey: false } }, async () => 'engine'));
  const envia = (text) => hooks.get('prompt.submit')(api, { text }, async (e) => e);
  const turno = async () => {
    for await (const _ of hooks.get('turn.step')(api, { model: 'claude-opus-5-5', effort: 'medium' }, async function* () {})) { /* nada */ }
    await hooks.get('turn.complete')(api, {}, async () => ({ text: '', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 9, cache_creation_input_tokens: 0 } }));
  };
  globalThis.h = (tag, props, ...children) => ({ tag, props, children });
  try {
    await hooks.get('session.start')(api, {}, async (e) => e);
    for (let i = 0; i < 4; i += 1) { await envia('añade un botón de exportar'); await turno(); }
    assert.match(await pinta(), /✓/, 'cuatro turnos de rutina en Opus con mucho contexto: se mantiene');
    await envia('añade otro botón');
    assert.match(await pinta(), /→ sesión nueva en Sonnet/);
    await turno();
    await envia('el login sigue fallando y no sé por qué');
    assert.doesNotMatch(await pinta(), /sesión nueva/, 'un trabajo que sí necesita el modelo reinicia la cuenta');
    await turno();
    ahora += 61 * 60 * 1000;
    await hooks.get('prompt.edit')(api, { text: '' }, async () => ({ text: 'añade un filtro', cursor: 15 }));
    assert.match(await pinta(), /→ Sonnet · medium \(caché fría: cambiar no cuesta\)/);
    await turno();
    await hooks.get('prompt.edit')(api, { text: '' }, async () => ({ text: 'añade un filtro más', cursor: 19 }));
    assert.doesNotMatch(await pinta(), /caché fría/, 'tras un turno la caché vuelve a estar caliente');
  } finally {
    delete globalThis.h;
  }
});

const PASO_A = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 40000, cache_creation_input_tokens: 2000, model: 'claude-sonnet-5-5' };
const PASO_B = { input_tokens: 500, output_tokens: 44000, cache_read_input_tokens: 60000, cache_creation_input_tokens: 0, model: 'claude-sonnet-5-5' };

test('los tokens de un subagente se acumulan por paso y separan lo leído de la caché', () => {
  const t = tokensVacios();
  assert.equal(cacheDeTokens(t), null, 'sin datos no se inventa un porcentaje');
  sumarTokens(t, PASO_A);
  sumarTokens(t, PASO_B);
  assert.deepEqual(t, { input: 1500, output: 44500, read: 100000, creation: 2000, pasos: 2 });
  assert.equal(totalDeTokens(t), 148000);
  assert.equal(Math.round(cacheDeTokens(t)), 97, 'caché frente a todo lo que entró, sin contar la salida');
});

test('un uso ausente o con valores raros no altera los tokens acumulados', () => {
  const t = tokensVacios();
  sumarTokens(t, null);
  sumarTokens(t, undefined);
  sumarTokens(t, { input_tokens: -5, output_tokens: 'mucho', cache_read_input_tokens: NaN });
  assert.deepEqual(t, { input: 0, output: 0, read: 0, creation: 0, pasos: 0 }, 'nada válido: ni siquiera cuenta como paso');
  sumarTokens(t, { input_tokens: 10, output_tokens: -3, cache_read_input_tokens: Infinity, cache_creation_input_tokens: 4 });
  assert.deepEqual(t, { input: 10, output: 0, read: 0, creation: 4, pasos: 1 });
});

test('las cifras de tokens se abrevian sin perder el orden de magnitud', () => {
  assert.equal(formatoTokens(0), '0');
  assert.equal(formatoTokens(850), '850');
  assert.equal(formatoTokens(9500), '9,5k');
  assert.equal(formatoTokens(12000), '12k');
  assert.equal(formatoTokens(148000), '148k');
  assert.equal(tokensNuevos({ input: 12, output: 2838, read: 87763, creation: 26628 }), 29478, 'lo que no es lectura de caché: es lo que informa el sistema');
  assert.equal(formatoTokens(1_200_000), '1,2M');
});

test('la fila de un subagente añade sus tokens y el porcentaje de caché, y sin datos queda como antes', () => {
  const con = { type: 'niveles:nivel-exigente', description: 'verificar contrato', status: 'running', model: 'claude-sonnet-5-5', effort: 'high', tokens: { input: 1500, output: 44500, read: 100000, creation: 2000, pasos: 2 } };
  const sin = { type: 'niveles:nivel-ligero', description: 'correr pruebas', status: 'running', model: 'claude-haiku-5-5', effort: 'low' };
  const vacio = { ...sin, tokens: tokensVacios() };
  const [a, b, c] = filasDeAgentes([con, sin, vacio]);
  assert.match(texto(a), /↳ exigente +Sonnet 5\.5 · high +verificar contrato +● +48k nuevos · 97% caché \(148k en total\)/);
  assert.equal(a.find((t) => /% caché/u.test(t.text)).color, 'success', '97 % de caché es buen tono');
  assert.doesNotMatch(texto(b), /caché|\dk/u);
  assert.doesNotMatch(texto(c), /caché|\dk/u, 'sin pasos todavía no se muestra nada');
  const poca = filasDeAgentes([{ ...con, tokens: { input: 90000, output: 1000, read: 5000, creation: 5000, pasos: 2 } }])[0];
  assert.equal(poca.find((t) => /% caché/u.test(t.text)).color, 'error', 'poca caché se nota en el tono');
  const primero = texto(filasDeAgentes([{ ...con, tokens: { input: 90000, output: 1000, read: 0, creation: 9000, pasos: 1 } }])[0]);
  assert.match(primero, /100k/);
  assert.doesNotMatch(primero, /caché/, 'el primer paso siempre escribe la caché: no se juzga todavía');
});

test('el mod suma los tokens de cada paso de un subagente, ignora la sesión principal y no altera la respuesta', async () => {
  const { register } = await import('../plugins/nexakit-modelo/hooks/register.js?tokens');
  const hooks = new Map();
  register((event, ...rest) => { hooks.set(event, rest.at(-1)); });
  const api = {
    session: { model: async () => 'claude-opus-5-5', usage: async () => null },
    agent: { list: async () => [{ id: 'a1', type: 'niveles:nivel-exigente', description: 'verificar contrato', status: 'running' }] },
    tool: { register: async () => {} },
    ui: { status() {}, invalidate() {}, resolve: () => ({ Box: 'Box', Text: 'Text' }) },
  };
  const paso = (usage) => async function* () { return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage }; };
  const correr = async (evento, usage) => {
    const it = hooks.get('turn.step')(api, evento, paso(usage));
    for (;;) {
      const x = await it.next();
      if (x.done) return x.value;
    }
  };
  globalThis.h = (tag, props, ...children) => ({ tag, props, children });
  try {
    await hooks.get('session.start')(api, {}, async (e) => e);
    await correr({ model: 'claude-opus-5-5', effort: 'medium' }, { ...PASO_A, input_tokens: 999999 });
    const respuesta = await correr({ model: 'claude-sonnet-5-5', effort: 'high', agentId: 'a1' }, PASO_A);
    assert.equal(respuesta.usage, PASO_A, 'el hook devuelve la respuesta del paso tal cual');
    await correr({ model: 'claude-sonnet-5-5', effort: 'high', agentId: 'a1' }, PASO_B);
    await correr({ model: 'claude-sonnet-5-5', effort: 'high', agentId: 'a1' }, null);
    const plano = JSON.stringify(await hooks.get('ui.render')(api, { props: { hasSurvey: false } }, async () => 'engine'));
    assert.match(plano, /48k nuevos/);
    assert.match(plano, /148k en total/);
    assert.match(plano, /97% caché/);
    assert.doesNotMatch(plano, /999\d{3}|1000k/u, 'la sesión principal no cuenta como subagente');
  } finally {
    delete globalThis.h;
  }
});

test('la fila de un especialista muestra su nombre sin el prefijo del plugin y las columnas se alinean', () => {
  const filas = filasDeAgentes([
    { type: 'niveles:nivel-ligero', description: 'correr pruebas', status: 'running', model: 'claude-haiku-5-5', effort: 'low' },
    { type: 'niveles:investigador', description: 'buscar fuentes', status: 'running', model: 'claude-sonnet-5-5', effort: 'medium' },
    { type: 'niveles:revisor-de-calidad', description: 'dictamen del cambio', status: 'completed', model: 'claude-sonnet-5-5', effort: 'high' },
  ]).map(texto);
  assert.match(filas[0], /↳ ligero +Haiku 5\.5 · low/);
  assert.match(filas[1], /↳ investigador +Sonnet 5\.5 · medium/);
  assert.match(filas[2], /↳ revisor-de-calidad +Sonnet 5\.5 · high/, 'un nombre de 18 caracteres no se corta');
  for (const fila of filas) assert.doesNotMatch(fila, /niveles:|…\s+(Haiku|Sonnet)/u, 'sin prefijo ni nombre cortado');
  const columna = filas.map((f) => f.search(/(Haiku|Sonnet)/u));
  assert.equal(new Set(columna).size, 1, 'el modelo empieza en la misma columna en todas las filas');
});

test('una fila con un tipo muy largo se corta con puntos suspensivos sin descuadrar el resto', () => {
  const [larga, corta] = filasDeAgentes([
    { type: 'otro-plugin:un-agente-con-un-nombre-larguisimo', description: 'x', status: 'running', model: 'claude-sonnet-5-5', effort: 'low' },
    { type: 'niveles:nivel-alto', description: 'y', status: 'running', model: 'claude-opus-5-5', effort: 'high' },
  ]).map(texto);
  assert.match(larga, /↳ otro-plugin:un-ag… +Sonnet/u, 'se corta a 18 caracteres con puntos suspensivos');
  assert.equal(larga.search(/Sonnet/u), corta.search(/Opus/u));
});

test('con solo los niveles de siempre la fila queda igual que antes', () => {
  const [fila] = filasDeAgentes([{ type: 'niveles:nivel-normal', description: 'implementar', status: 'running', model: 'claude-sonnet-5-5', effort: 'medium' }]).map(texto);
  assert.match(fila, /^  ↳ normal +Sonnet 5\.5 · medium +implementar/);
});

test('buscar o leer algo concreto es trabajo de nivel ligero: Haiku con poco esfuerzo, delegable', () => {
  for (const mensaje of ['busca dónde se usa zod', 'encuentra los archivos que mencionan el plugin niveles', 'lee el README y dime qué hace', 'muestra el archivo de configuración', '¿dónde se define la barra? búscalo']) {
    const r = recomendarPorTexto(mensaje);
    assert.deepEqual([r.model, r.effort, r.delegar], mensaje.startsWith('¿') ? ['sonnet', 'low', undefined] : ['haiku', 'low', 'nivel-ligero'], mensaje);
  }
});

test('buscar o leer no se confunde con construir, arreglar o pensar', () => {
  assert.deepEqual(pick(recomendarPorTexto('busca una forma de mejorar el rendimiento')), ['sonnet', 'medium'], 'sin objeto concreto es trabajo habitual');
  assert.deepEqual(pick(recomendarPorTexto('lee el error del log y arréglalo')), ['sonnet', 'high'], 'un fallo manda sobre la lectura');
  assert.deepEqual(pick(recomendarPorTexto('busca dónde se usa zod y migra todo a valibot')), ['opus', 'medium'], 'migrar es diseño');
  assert.deepEqual(pick(recomendarPorTexto('busca dónde se usa zod y añade un campo nuevo')), ['sonnet', 'medium'], 'construir manda sobre buscar');
});

test('escribir pruebas o cubrir casos borde pide Sonnet con esfuerzo alto, sin delegar ni cambiar de modelo', () => {
  for (const mensaje of ['escribe pruebas para el módulo de pagos', 'cubre los casos borde de la validación', 'añade un test para el caso borde de las fechas', 'agrega pruebas de cobertura al parser', 'crea pruebas de regresión del bug anterior']) {
    const r = recomendarPorTexto(mensaje);
    assert.deepEqual([r.model, r.effort, r.delegar], ['sonnet', 'high', undefined], mensaje);
  }
});

test('hablar de pruebas sin pedir escribirlas sigue las reglas de siempre', () => {
  assert.deepEqual(pick(recomendarPorTexto('corre las pruebas')), ['haiku', 'low'], 'ejecutar es mecánico');
  assert.deepEqual(pick(recomendarPorTexto('ejecuta las pruebas del módulo de pagos')), ['haiku', 'low']);
  assert.deepEqual(pick(recomendarPorTexto('las pruebas fallan en Windows')), ['sonnet', 'high'], 'un fallo ya pide esfuerzo alto');
  assert.deepEqual(pick(recomendarPorTexto('diseña la estrategia de pruebas del sistema')), ['opus', 'medium'], 'diseñar manda');
  assert.deepEqual(pick(recomendarPorTexto('¿para qué sirven las pruebas de regresión?')), ['sonnet', 'low'], 'una pregunta es una pregunta');
});

test('la cifra principal de un subagente son sus tokens nuevos, con la caché y el total aparte', () => {
  // El caso real de sincronizador-docs: 117.241 tokens en total, de los que 29.478 no eran lectura de caché.
  const real = { type: 'niveles:sincronizador-docs', description: 'detectar qué guías quedaron desactualizadas', status: 'running', model: 'claude-sonnet-5-5', effort: 'medium', tokens: { input: 12, output: 2838, read: 87763, creation: 26628, pasos: 6 } };
  const fila = texto(filasDeAgentes([real])[0]);
  assert.match(fila, /29k nuevos · 77% caché \(117k en total\)/);
  assert.doesNotMatch(fila, /^.*117k nuevos/u, 'el total no se presenta como si fuera lo nuevo');
  const [primero] = filasDeAgentes([{ ...real, tokens: { input: 9, output: 400, read: 0, creation: 26000, pasos: 1 } }]);
  assert.match(texto(primero), /26k nuevos$/u, 'en el primer paso no hay caché que juzgar y el total coincide con lo nuevo, así que no se repite');
  const dim = filasDeAgentes([real])[0].find((t) => /en total/u.test(t.text));
  assert.equal(dim.dim, true, 'el total va atenuado: es información, no lo que pesa en la cuota');
});

test('un subagente en marcha no usa el mismo símbolo que el resto de la fila', () => {
  const fila = texto(filasDeAgentes([{ type: 'niveles:investigador', description: 'encargo largo que no cabe en la fila de la barra de abajo', status: 'running', model: 'claude-sonnet-5-5', effort: 'medium' }])[0]);
  assert.doesNotMatch(fila, /…\s*…/u, 'no hay dos puntos suspensivos seguidos');
  assert.match(fila, /encargo largo que no cabe en la fila de la … ●/u, 'la descripción cabe hasta 44 caracteres, con el corte marcado');
});

// Fechas en hora local, como las dibuja la barra: así las pruebas no dependen de la zona horaria de quien las corre.
const AHORA = new Date(2026, 10, 12, 12, 0).getTime();
const iso = (d, h, m = 0) => new Date(2026, 10, d, h, m).toISOString();

test('el reinicio de un límite se escribe como hora si es hoy y como día y hora si es otro día', () => {
  assert.equal(formatoReinicio(iso(12, 15, 30), AHORA), '15:30');
  assert.equal(formatoReinicio(iso(12, 9, 5), AHORA - 3 * 3600_000), '09:05');
  assert.equal(formatoReinicio(iso(13, 10), AHORA), 'vie 10:00', 'el 13 de noviembre de 2026 es viernes');
  assert.equal(formatoReinicio(iso(16, 0, 30), AHORA), 'lun 00:30');
  assert.equal(formatoReinicio(iso(15, 23, 59), AHORA), 'dom 23:59');
});

test('un reinicio ausente, inválido o que ya pasó no se muestra', () => {
  for (const valor of [undefined, null, '', 'mañana', 12345, iso(12, 11, 59)]) {
    assert.equal(formatoReinicio(valor, AHORA), null, String(valor));
  }
});

test('la barra muestra cuándo se reinicia un límite solo cuando ya va en ámbar o en rojo', () => {
  const barra = (rateLimits) => texto(segmentosDeBarra({ model: 'claude-sonnet-5-5', effort: 'medium', usage: { context: { percent: 10 }, rateLimits }, ahora: AHORA }));
  const alto = barra([{ kind: 'five_hour', percentUsed: 61, resetsAt: iso(12, 15, 30) }, { kind: 'seven_day', percentUsed: 92, resetsAt: iso(13, 10) }]);
  assert.match(alto, /5h 61% ↻ 15:30/);
  assert.match(alto, /sem 92% ↻ vie 10:00/);
  const holgado = barra([{ kind: 'five_hour', percentUsed: 20, resetsAt: iso(12, 15, 30) }, { kind: 'seven_day', percentUsed: 59, resetsAt: iso(13, 10) }]);
  assert.match(holgado, /5h 20%/);
  assert.match(holgado, /sem 59%/);
  assert.doesNotMatch(holgado, /↻/, 'con margen no hay ruido');
});

test('si el motor no informa del reinicio, el límite se muestra como siempre', () => {
  const barra = texto(segmentosDeBarra({ model: 'claude-sonnet-5-5', effort: 'medium', usage: { context: { percent: 10 }, rateLimits: [{ kind: 'seven_day', percentUsed: 92 }, { kind: 'five_hour', percentUsed: 80, resetsAt: 'no es una fecha' }] }, ahora: AHORA }));
  assert.match(barra, /sem 92%/);
  assert.match(barra, /5h 80%/);
  assert.doesNotMatch(barra, /↻/);
});

test('el reinicio va atenuado y el porcentaje conserva su color', () => {
  const tramos = segmentosDeBarra({ model: 'claude-sonnet-5-5', effort: 'medium', usage: { context: { percent: 10 }, rateLimits: [{ kind: 'seven_day', percentUsed: 92, resetsAt: iso(13, 10) }] }, ahora: AHORA });
  const i = tramos.findIndex((t) => /92%/u.test(t.text));
  assert.equal(tramos[i].color, 'error');
  assert.equal(tramos[i + 1].dim, true);
  assert.match(tramos[i + 1].text, /↻ vie 10:00/);
});

test('las estaciones externas de la fábrica son filas con su IA, modelo, estado y tokens', () => {
  const ahora = Date.parse('2026-11-15T10:00:00Z');
  const activo = {
    pid: 1, id: 'r1', repo: 'x', actualizado: '2026-11-15T09:59:30Z',
    estaciones: [
      { estacion: 'implementar', ia: 'codex', modelo: 'gpt-5.5', esfuerzo: 'high', estado: 'en-curso', tokens: 12500 },
      { estacion: 'revisar', ia: 'antigravity', modelo: 'Gemini 4', esfuerzo: 'low', estado: 'ok', tokens: 0 },
      { estacion: 'probar', ia: 'claude', modelo: 'x', esfuerzo: null, estado: 'claude', tokens: 5 },
      { estacion: 'diseñar', ia: 'codex', modelo: null, esfuerzo: null, estado: 'omitida', tokens: 0 },
      { estacion: 'otra', ia: 'codex', modelo: 'm', esfuerzo: null, estado: 'sin-modelo', tokens: 0 },
    ],
  };
  const filas = filasDeFabrica(activo, ahora).map(texto);
  assert.equal(filas.length, 2);
  assert.equal(filas[0], `  ↳ implementar ${'codex gpt-5.5 high'.padEnd(20)} ${'en-curso'.padEnd(44)} ●  13k tokens`);
  assert.equal(filas[1], `  ↳ revisar     ${'agy Gemini 4 low'.padEnd(20)} ${'ok'.padEnd(44)} ✓`);
  assert.equal(filasDeFabrica({ ...activo, estaciones: Array.from({ length: 7 }, () => activo.estaciones[0]) }, ahora).length, 4);
});

test('un activo inválido, ajeno, demasiado grande o de más de 10 minutos no da filas ni errores', () => {
  const ahora = Date.parse('2026-11-15T10:00:00Z');
  const estacion = { estacion: 'a', ia: 'codex', modelo: 'm', esfuerzo: 'low', estado: 'en-curso', tokens: 1 };
  const activo = (actualizado) => ({ actualizado, estaciones: [estacion] });
  assert.equal(filasDeFabrica(activo('2026-11-15T09:49:00Z'), ahora).length, 0);
  assert.equal(filasDeFabrica(activo('2026-11-15T09:51:00Z'), ahora).length, 1);
  assert.equal(filasDeFabrica(activo('no es fecha'), ahora).length, 0);
  for (const malo of [null, undefined, 3, 'x', {}, { estaciones: 'x' }, { actualizado: 'x', estaciones: [null, 5] }]) {
    assert.deepEqual(filasDeFabrica(malo, ahora), []);
  }
  assert.equal(activoDeTexto('{roto'), null);
  assert.equal(activoDeTexto('[]'), null);
  assert.equal(activoDeTexto(`{"estaciones":[],"x":"${'a'.repeat(70 * 1024)}"}`), null);
  assert.deepEqual(activoDeTexto('{"estaciones":[]}'), { estaciones: [] });
});

const estacion = (extra) => ({ estacion: 'a', ia: 'codex', modelo: 'm', esfuerzo: 'low', estado: 'en-curso', tokens: 1, ...extra });
const ahoraF = Date.parse('2026-11-15T10:00:00Z');

test('el texto del archivo de la fábrica no puede colar secuencias de control en la terminal', () => {
  const filas = filasDeFabrica({
    actualizado: '2026-11-15T10:00:00Z',
    estaciones: [estacion({ estacion: 'x\x1b]0;titulo\x07y', modelo: '\x1b[2Jm\u009b', esfuerzo: 'l\x00ow' })],
  }, ahoraF).map(texto);
  assert.equal(filas.length, 1);
  assert.doesNotMatch(filas[0], /[\u0000-\u001f\u007f-\u009f]/u);
  assert.match(filas[0], /x\]0;tituloy/u);
});

test('una IA o un estado heredados del prototipo descartan solo esa estación', () => {
  const filas = filasDeFabrica({
    actualizado: '2026-11-15T10:00:00Z',
    estaciones: [estacion({ ia: 'constructor' }), estacion({ estado: 'constructor' }), estacion({ ia: '__proto__' }), estacion({ estacion: 'buena' })],
  }, ahoraF).map(texto);
  assert.equal(filas.length, 1);
  assert.match(filas[0], /buena/u);
});

test('un actualizado más de 60 s en el futuro se descarta', () => {
  assert.equal(filasDeFabrica({ actualizado: '2026-11-15T10:00:30Z', estaciones: [estacion()] }, ahoraF).length, 1);
  assert.equal(filasDeFabrica({ actualizado: '2026-11-15T10:02:00Z', estaciones: [estacion()] }, ahoraF).length, 0);
});

test('las filas de la fábrica y las de los subagentes comparten columnas e icono', () => {
  const agentes = [{ type: 'niveles:nivel-normal', description: 'implementar', status: 'running', model: 'claude-sonnet-5-5', effort: 'medium' }];
  const activo = { actualizado: '2026-11-15T10:00:00Z', estaciones: [estacion({ estacion: 'implementar-largo' })] };
  const columna = Math.max(columnaDeAgentes(agentes), columnaDeFabrica(activo, ahoraF));
  const [fa] = filasDeAgentes(agentes, columna).map(texto);
  const [ff] = filasDeFabrica(activo, ahoraF, columna).map(texto);
  assert.equal(fa.indexOf('●'), ff.indexOf('●'));
  assert.equal(fa.indexOf('Sonnet'), ff.indexOf('codex'));
});

// turn.abort no se puede disparar con el motor de pruebas de los mods (su `$.turn` solo tiene start, step y complete):
// aquí se ejercita con ganchos y un `$` falsos.
test('el botón de delegar: aborto de subagente, reintento tras abortar la delegación, envío fallido y envío de otro plugin', async () => {
  const { register } = await import('../plugins/nexakit-modelo/hooks/register.js?boton');
  const hooks = new Map();
  register((event, ...rest) => { hooks.set(event, rest.at(-1)); });
  const enviados = [];
  const avisos = [];
  let falla = false;
  const api = {
    session: { model: async () => 'claude-opus-5-5', usage: async () => null },
    tool: { register: async () => {} },
    prompt: { submit: async ({ text }) => { if (falla) throw new Error('sin conexión'); enviados.push(text); return { text }; } },
    ui: { invalidate() {}, toast: (t) => avisos.push(t), resolve: () => ({ Box: 'Box', Text: 'Text', Button: 'Button' }) },
  };
  const ir = (nombre, e) => hooks.get(nombre)(api, e, async (x) => x);
  const buscar = (nodo) => (!nodo || typeof nodo !== 'object' ? null : nodo.tag === 'Button' ? nodo : [].concat(nodo.children ?? []).map(buscar).find(Boolean) ?? null);
  const boton = async (surface = 'desktop') => buscar(await hooks.get('ui.render')(api, { surface, props: { hasSurvey: false } }, async () => 'engine'));
  globalThis.h = (tag, props, ...children) => ({ tag, props, children });
  try {
    await ir('session.start', {});
    await ir('prompt.submit', { text: 'haz commit y push' });
    assert.ok(await boton(), 'sin turno en curso hay botón');
    assert.equal(await boton('terminal'), null);
    for (const otra of ['mobile', 'vscode', 'cli']) assert.equal(await boton(otra), null, otra);
    await ir('turn.start', { turnId: 'principal' });
    assert.equal(await boton(), null);
    // Un subagente aborta su turno: el principal sigue y el botón no vuelve.
    await ir('turn.start', { turnId: 'hijo', agentId: 'a1' });
    await ir('turn.abort', { turnId: 'hijo' });
    await ir('turn.abort', { turnId: 'otro', agentId: 'a1' });
    assert.equal(await boton(), null);
    await ir('turn.abort', { turnId: 'principal' });
    assert.ok(await boton(), 'el aborto del principal devuelve el botón');
    // Pulsar, abortar la delegación y reintentar.
    await (await boton()).props.onPress();
    assert.equal(enviados.length, 1);
    assert.match(enviados[0], /mi mensaje anterior/u);
    assert.equal(await boton(), null);
    await ir('turn.start', { turnId: 'delegacion' });
    await ir('turn.abort', { turnId: 'delegacion' });
    const reintento = await boton();
    assert.ok(reintento, 'tras abortar la delegación se puede reintentar');
    assert.match(reintento.props.label, /nivel-ligero/u);
    // Un envío fallido restaura el botón y avisa en español.
    falla = true;
    await reintento.props.onPress();
    assert.equal(avisos.length, 1);
    assert.match(avisos[0], /reintentar/u);
    falla = false;
    await (await boton()).props.onPress();
    assert.equal(enviados.length, 2);
    await ir('turn.start', { turnId: 'd2' });
    await ir('turn.complete', { turnId: 'd2' });
    assert.equal(await boton(), null, 'ya delegado, no vuelve para el mismo mensaje');
    // Un envío de otro plugin (no el del botón) sí es un mensaje: cambia la recomendación.
    await ir('prompt.submit', { text: 'la API da error 500 y no sé por qué', origin: { kind: 'plugin', name: 'otro' } });
    const r = JSON.stringify(await hooks.get('ui.render')(api, { surface: 'desktop', props: { hasSurvey: false } }, async () => 'engine'));
    assert.match(r, /→ delega: nivel-alto|→ Opus · high/u);
  } finally {
    delete globalThis.h;
  }
});
