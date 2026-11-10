import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidir, ajustarPorLimite } from '../plugins/nexakit-modelo/hooks/decidir.js';
import { recomendarPorTexto } from '../plugins/nexakit-modelo/hooks/recomendar.js';

const dificil = recomendarPorTexto('el login sigue fallando y no sé por qué');
const fallo = recomendarPorTexto('arregla el botón que no guarda');
const diseno = recomendarPorTexto('diseña la arquitectura del módulo de pagos');
const mecanico = recomendarPorTexto('haz commit y push');
const rutina = recomendarPorTexto('añade un botón de exportar');
const d = (extra) => decidir({ model: 'claude-sonnet-5-5', effort: 'medium', ctx: 50, tokens: 120_000, ...extra });

test('coincide, solo esfuerzo y delegación de lo mecánico', () => {
  assert.equal(d({ recommendation: rutina }).accion, 'mantener');
  assert.deepEqual([d({ recommendation: fallo }).accion, d({ recommendation: fallo }).texto], ['esfuerzo', 'Sonnet · high']);
  assert.deepEqual([d({ recommendation: mecanico }).accion, d({ recommendation: mecanico }).texto], ['delegar', 'delega: nivel-ligero']);
  assert.equal(d({ recommendation: mecanico, model: 'claude-haiku-5-5', effort: 'low' }).accion, 'mantener');
});

test('subir de modelo: barato con poco contexto o caché fría; con mucho contexto, delegar o avisar del coste', () => {
  assert.deepEqual([d({ recommendation: dificil, ctx: 10 }).accion, d({ recommendation: dificil, ctx: 10 }).texto], ['cambiar', 'Opus · high']);
  assert.deepEqual([d({ recommendation: dificil }).accion, d({ recommendation: dificil }).texto], ['delegar', 'delega: nivel-alto']);
  const fria = d({ recommendation: dificil, cacheFria: true });
  assert.equal(fria.accion, 'cambiar');
  assert.match(fria.texto, /Opus · high.*caché fría/u);
  const caro = d({ recommendation: diseno });
  assert.equal(caro.accion, 'cambiar');
  assert.match(caro.texto, /Opus · medium.*relee ~120k/u, 'diseñar no se delega: se avisa de lo que cuesta cambiar');
  assert.doesNotMatch(d({ recommendation: diseno, tokens: undefined }).texto, /relee/u, 'sin dato no inventa el coste');
});

test('bajar de modelo: solo si sale barato; tras cinco turnos de rutina propone sesión nueva', () => {
  const enOpus = (extra) => decidir({ model: 'claude-opus-5-5', effort: 'medium', ctx: 50, recommendation: rutina, ...extra });
  assert.equal(enOpus().accion, 'mantener', 'con mucho contexto no se baja');
  assert.deepEqual([enOpus({ recommendation: fallo }).accion, enOpus({ recommendation: fallo }).texto], ['esfuerzo', 'high']);
  assert.deepEqual([enOpus({ ctx: 5 }).accion, enOpus({ ctx: 5 }).texto], ['cambiar', 'Sonnet · medium']);
  assert.equal(enOpus({ cacheFria: true }).accion, 'cambiar');
  const cansado = enOpus({ rutinaSeguidas: 5 });
  assert.equal(cansado.accion, 'sesion');
  assert.match(cansado.texto, /sesión nueva en Sonnet/u);
  assert.equal(enOpus({ rutinaSeguidas: 4 }).accion, 'mantener');
});

test('con el límite de uso alto no se propone subir a Opus para diseñar; un fallo difícil se mantiene', () => {
  const tope = ajustarPorLimite(diseno, 85);
  assert.deepEqual([tope.model, tope.effort], ['sonnet', 'high']);
  assert.match(tope.reason, /límite de uso al 85/u);
  assert.equal(ajustarPorLimite(diseno, 60), diseno);
  assert.equal(ajustarPorLimite(dificil, 95), dificil);
  assert.equal(d({ recommendation: diseno, limite: 85 }).texto, 'Sonnet · high');
});

test('el texto relaciona el mensaje con el anterior y baja el esfuerzo en preguntas', () => {
  assert.deepEqual([fallo.model, fallo.effort, fallo.fallo], ['sonnet', 'high', true]);
  for (const t of ['tampoco funcionó', 'de nuevo el mismo problema', 'no se arregló', 'no quedó bien'])
    assert.deepEqual([recomendarPorTexto(t, fallo).model, recomendarPorTexto(t, fallo).delegar], ['opus', 'nivel-alto'], t);
  assert.equal(recomendarPorTexto('tampoco me gusta ese color', rutina).model, 'sonnet', 'sin un fallo antes no es un reintento');
  for (const t of ['¿por qué usamos zod aquí?', '¿ya están instalados los mods?', 'tengo una pregunta: ¿esa skill tiene nombre y descripción?', 'qué hace este hook?'])
    assert.deepEqual([recomendarPorTexto(t).model, recomendarPorTexto(t).effort], ['sonnet', 'low'], t);
  assert.equal(recomendarPorTexto(`tengo una pregunta y quiero que seas sincero: ${'¿no sería mejor otro enfoque? '.repeat(8)}`).effort, 'medium', 'una pregunta de fondo no es rápida');
  assert.equal(recomendarPorTexto('haz el push a main y tengo una pregunta').effort, 'medium', 'con otra petición no es solo una pregunta');
  assert.equal(recomendarPorTexto('¿por qué falla el login?').effort, 'high', 'una pregunta sobre un fallo sigue siendo un fallo');
  assert.equal(recomendarPorTexto('¿puedes añadir un botón de exportar?').effort, 'medium', 'una petición con forma de pregunta es trabajo');
  assert.equal(recomendarPorTexto(`¿${'x'.repeat(300)}?`).effort, 'medium', 'una pregunta larga no es simple');
});
