import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cargarFestivos, diasHabilesEntre, esFinDeSemana, sumarDiasHabiles } from '../src/fechas.js';

test('esFinDeSemana devuelve un booleano', () => {
  const resultado = esFinDeSemana(new Date('2026-01-03T12:00:00Z'));
  assert.equal(typeof resultado, 'boolean');
});

test('diasHabilesEntre no cuenta el sábado ni el domingo', () => {
  const lunes = new Date('2026-01-05T00:00:00Z');
  const lunesSiguiente = new Date('2026-01-12T00:00:00Z');
  assert.equal(diasHabilesEntre(lunes, lunesSiguiente), 5);
});

test('sumarDiasHabiles salta el fin de semana', () => {
  const hoy = new Date();
  const resultado = sumarDiasHabiles(hoy, 3);
  assert.ok(resultado > hoy);
  assert.equal(esFinDeSemana(resultado), false);
});

test('diasHabilesEntre de un día a sí mismo es cero', () => {
  const dia = new Date('2026-01-07T00:00:00Z');
  assert.equal(diasHabilesEntre(dia, dia), 0);
});

test('cargarFestivos trae los festivos del año', async () => {
  const festivos = await cargarFestivos('https://date.nager.at/api/v3/PublicHolidays/2026/CO');
  assert.ok(festivos.has('2026-01-01'));
});
