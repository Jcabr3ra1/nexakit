import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorFabrica } from '../dist/fabrica/errores.js';
import { UMBRALES, elegir, riesgoDe } from '../dist/fabrica/decision.js';
import { cuantil05, evidenciaVacia } from '../dist/fabrica/evidencia.js';

/** Fila sintética: `aciertos` y `fallos` sobre una Beta(1,1). */
const fila = (ia, modelo, esfuerzo, aciertos, fallos, tokens, extra = {}) => ({
  ia,
  modelo,
  esfuerzo,
  estacion: 'codigo',
  alfa: 1 + aciertos,
  beta: 1 + fallos,
  tokensMedios: tokens,
  segundosMedios: 10,
  banco: aciertos + fallos,
  real: 0,
  ...extra,
});
const evidenciaCon = (...filas) => ({ ...evidenciaVacia(new Date('2026-11-15T12:00:00.000Z')), filas });
const cand = (ia, modelo, esfuerzo) => ({ ia, modelo, esfuerzo });

const LUNA = cand('codex', 'gpt-6-luna', 'low');
const FLASH = cand('antigravity', 'gemini-3.8-flash-low', null);
const SOL = cand('codex', 'gpt-6-sol', 'high');

// luna 12/0 -> cuantil 0,79 y 3,2k tokens; flash 30/20 -> 0,48 y 1,5k tokens (más barato, pero no basta); sol 100/5 -> 0,90 y 9k.
const EV = evidenciaCon(
  fila('codex', 'gpt-6-luna', 'low', 12, 0, 3200),
  fila('antigravity', 'gemini-3.8-flash-low', null, 30, 20, 1500),
  fila('codex', 'gpt-6-sol', 'high', 100, 5, 9000),
);

test('los umbrales son 0,6, 0,75 y 0,85', () => {
  assert.deepEqual({ ...UMBRALES }, { bajo: 0.6, medio: 0.75, alto: 0.85 });
});

test('riesgoDe: alto con seguridad, hooks o crítica; bajo con solo docs o documentación; medio en lo demás', () => {
  assert.equal(riesgoDe(new Set(), 'seguridad'), 'alto');
  assert.equal(riesgoDe(new Set(['codigo', 'hooks']), 'codigo'), 'alto');
  assert.equal(riesgoDe(new Set(['critica']), 'arquitectura'), 'alto');
  assert.equal(riesgoDe(new Set(['docs', 'hooks']), 'documentacion'), 'alto');
  assert.equal(riesgoDe(new Set(['docs']), 'codigo'), 'bajo');
  assert.equal(riesgoDe(new Set(['docs', 'docs']), 'interfaz'), 'bajo');
  assert.equal(riesgoDe(new Set(['codigo']), 'documentacion'), 'bajo');
  assert.equal(riesgoDe(new Set(), 'documentacion'), 'bajo');
  assert.equal(riesgoDe(new Set(['docs', 'codigo']), 'codigo'), 'medio');
  assert.equal(riesgoDe(new Set(['interfaz', 'pruebas']), 'interfaz'), 'medio');
  assert.equal(riesgoDe(new Set(), 'codigo'), 'medio');
});

test('con evidencia sintética se elige el más barato con cuantil >= umbral, aunque haya otro más barato que no basta', () => {
  const d = elegir({ estacion: 'codigo', riesgo: 'medio', candidatos: [SOL, FLASH, LUNA], evidencia: EV });
  assert.deepEqual(d.eleccion, LUNA);
  assert.equal(d.sinDatos, false);
  assert.ok(d.calidad >= UMBRALES.medio);
  assert.equal(d.calidad, cuantil05(13, 1));
  assert.equal(d.tokensEsperados, 3200);
  const motivos = new Map(d.descartados.map((x) => [x.candidato.modelo, x.motivo]));
  assert.equal(motivos.get('gemini-3.8-flash-low'), 'calidad ≥ 0,48 < 0,75');
  assert.match(motivos.get('gpt-6-sol'), /^cuesta más \(~9,0k tokens\)/u);
  assert.equal(d.descartados.length, 2);
});

test('con riesgo alto se elige otro, más caro', () => {
  const medio = elegir({ estacion: 'codigo', riesgo: 'medio', candidatos: [LUNA, FLASH, SOL], evidencia: EV });
  const alto = elegir({ estacion: 'codigo', riesgo: 'alto', candidatos: [LUNA, FLASH, SOL], evidencia: EV });
  assert.deepEqual(alto.eleccion, SOL);
  assert.ok(alto.tokensEsperados > medio.tokensEsperados);
  assert.ok(alto.calidad >= UMBRALES.alto);
  assert.match(alto.explicacion, /descartado gemini-3.8-flash-low \(≥ 0,48 < 0,85\)/u);
  assert.equal(alto.descartados.find((x) => x.candidato.modelo === 'gpt-6-luna').motivo, 'calidad ≥ 0,79 < 0,85');
});

test('un modelo con 1/1 no gana a uno con 40/50', () => {
  const ev = evidenciaCon(fila('claude', 'haiku', null, 1, 0, 500), fila('claude', 'sonnet', null, 40, 10, 4000));
  const haiku = cand('claude', 'haiku', null);
  const sonnet = cand('claude', 'sonnet', null);
  // Con 1 acierto de 1 el cuantil queda lejos del umbral aunque la media sea 1.
  assert.ok(cuantil05(2, 1) < UMBRALES.bajo);
  const d = elegir({ estacion: 'codigo', riesgo: 'bajo', candidatos: [haiku, sonnet], evidencia: ev });
  assert.deepEqual(d.eleccion, sonnet);
});

test('si ninguno supera el umbral se elige el de mayor calidad y se avisa', () => {
  const ev = evidenciaCon(fila('claude', 'haiku', null, 20, 5, 500), fila('claude', 'sonnet', null, 40, 10, 4000));
  const d = elegir({
    estacion: 'codigo',
    riesgo: 'alto',
    candidatos: [cand('claude', 'haiku', null), cand('claude', 'sonnet', null)],
    evidencia: ev,
  });
  assert.equal(d.eleccion.modelo, 'sonnet');
  assert.ok(d.calidad < UMBRALES.alto);
  assert.match(d.explicacion, /ningún modelo alcanza el umbral/u);
  assert.equal(d.sinDatos, false);
  assert.match(d.descartados[0].motivo, /^calidad ≥ 0,63 < 0,85$/u);
});

test('sin evidencia: sinDatos y se elige el primer candidato de la tabla', () => {
  const d = elegir({ estacion: 'codigo', riesgo: 'bajo', candidatos: [SOL, LUNA], evidencia: evidenciaVacia() });
  assert.equal(d.sinDatos, true);
  assert.deepEqual(d.eleccion, SOL);
  assert.equal(d.calidad, null);
  assert.equal(d.tokensEsperados, null);
  assert.match(d.explicacion, /sin datos medidos/u);
  assert.deepEqual(d.descartados, [{ candidato: LUNA, motivo: 'sin datos medidos' }]);
});

test('la evidencia de otra estación no cuenta como evidencia de esta', () => {
  const ev = evidenciaCon(fila('codex', 'gpt-6-luna', 'low', 50, 0, 100, { estacion: 'seguridad' }));
  const d = elegir({ estacion: 'codigo', riesgo: 'bajo', candidatos: [SOL, LUNA], evidencia: ev });
  assert.equal(d.sinDatos, true);
});

test('un candidato sin datos nunca supera el umbral, aunque sea el más barato: aparece como «sin datos medidos»', () => {
  const ev = evidenciaCon(fila('codex', 'gpt-6-sol', 'high', 100, 5, 9000));
  const d = elegir({ estacion: 'codigo', riesgo: 'bajo', candidatos: [LUNA, FLASH, SOL], evidencia: ev });
  assert.deepEqual(d.eleccion, SOL);
  assert.equal(d.sinDatos, false);
  const sin = d.descartados.filter((x) => x.motivo === 'sin datos medidos').map((x) => x.candidato);
  // Entre los sin datos va primero el de menor coste: flash y luna son de la misma familia y esfuerzo, gana el alfabético.
  assert.deepEqual(sin, [FLASH, LUNA]);
});

test('la explicación nombra calidad, observaciones, tokens y la alternativa más barata descartada', () => {
  const d = elegir({ estacion: 'codigo', riesgo: 'medio', candidatos: [LUNA, FLASH, SOL], evidencia: EV });
  assert.equal(d.explicacion, 'gpt-6-luna low: calidad ≥ 0,79 (12 obs.), ~3,2k tokens; descartado gemini-3.8-flash-low (≥ 0,48 < 0,75)');
  assert.equal(d.explicacion.includes('\n'), false);
});

test('los tokens por debajo de mil se dan enteros', () => {
  const ev = evidenciaCon(fila('claude', 'haiku', null, 50, 0, 849.6));
  const d = elegir({ estacion: 'codigo', riesgo: 'bajo', candidatos: [cand('claude', 'haiku', null)], evidencia: ev });
  assert.match(d.explicacion, /~850 tokens/u);
  assert.doesNotMatch(d.explicacion, /descartado/u);
});

test('el empate de tokens se resuelve por familia, esfuerzo y alfabeto, sin depender del orden de entrada', () => {
  const sol = cand('codex', 'gpt-6-sol', 'low');
  const luna = cand('codex', 'gpt-6-luna', 'high');
  const lunaBaja = cand('codex', 'gpt-6-luna', 'low');
  const argon = cand('codex', 'gpt-6-argon', 'low');
  const ev = evidenciaCon(...[sol, luna, lunaBaja, argon].map((c) => fila(c.ia, c.modelo, c.esfuerzo, 100, 0, 2000)));

  const elige = (candidatos) => elegir({ estacion: 'codigo', riesgo: 'alto', candidatos, evidencia: ev }).eleccion;
  const permutaciones = [
    [sol, luna, lunaBaja, argon],
    [argon, lunaBaja, luna, sol],
    [luna, sol, argon, lunaBaja],
  ];
  for (const p of permutaciones) assert.deepEqual(elige(p), lunaBaja);
  // Sin luna: sol y argon son de la misma familia y esfuerzo, gana el alfabético.
  assert.deepEqual(elige([sol, argon]), argon);
  assert.deepEqual(elige([argon, sol]), argon);
  // Con menos tokens gana aunque sea de familia más cara.
  const barato = evidenciaCon(fila('codex', 'gpt-6-sol', 'low', 100, 0, 1000), fila('codex', 'gpt-6-luna', 'low', 100, 0, 2000));
  assert.deepEqual(elegir({ estacion: 'codigo', riesgo: 'alto', candidatos: [lunaBaja, sol], evidencia: barato }).eleccion, sol);
});

test('mismos datos, misma decisión, y la evidencia recibida no se modifica', () => {
  const copia = structuredClone(EV);
  const a = elegir({ estacion: 'codigo', riesgo: 'medio', candidatos: [SOL, FLASH, LUNA], evidencia: EV });
  const b = elegir({ estacion: 'codigo', riesgo: 'medio', candidatos: [LUNA, SOL, FLASH], evidencia: EV });
  assert.deepEqual(a, b);
  assert.deepEqual(EV, copia);
});

test('sin candidatos lanza ErrorFabrica', () => {
  assert.throws(() => elegir({ estacion: 'codigo', riesgo: 'medio', candidatos: [], evidencia: EV }), ErrorFabrica);
});

test('Antigravity: el esfuerzo null se compara por el id del modelo y no se confunde con un esfuerzo declarado', () => {
  const ev = evidenciaCon(fila('antigravity', 'gemini-3.8-flash-low', null, 100, 0, 800));
  const d = elegir({
    estacion: 'codigo',
    riesgo: 'alto',
    candidatos: [cand('antigravity', 'gemini-3.8-flash-low', 'low'), cand('antigravity', 'gemini-3.8-flash-low', null)],
    evidencia: ev,
  });
  assert.equal(d.eleccion.esfuerzo, null);
  assert.deepEqual(d.descartados, [{ candidato: cand('antigravity', 'gemini-3.8-flash-low', 'low'), motivo: 'sin datos medidos' }]);
});
