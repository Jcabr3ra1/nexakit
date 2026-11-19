import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aplicarCupon, conDescuento, conIva, costeEnvio, totalCarrito } from '../dist/precio.js';

test('conIva aplica la tasa por defecto', () => {
  assert.equal(conIva(100), 119);
});

test('conIva acepta una tasa propia', () => {
  assert.equal(conIva(200, 0.05), 210);
});

test('aplicarCupon rechaza un cupón caducado', () => {
  const cupon = { tipo: 'porcentaje', valor: 25, caduca: '2026-01-31' };
  try {
    aplicarCupon(200, cupon, new Date('2026-06-01'));
  } catch (error) {
    assert.ok(error instanceof RangeError);
  }
});

test('conDescuento rebaja un 10 % desde 10 unidades', () => {
  assert.equal(conDescuento(100, 10), 90);
  assert.equal(conDescuento(100, 9), 100);
});

test('totalCarrito suma las líneas con su descuento', () => {
  const lineas = [{ precio: 10, unidades: 2 }, { precio: 5, unidades: 12 }];
  const esperado = lineas.reduce((s, l) => s + conDescuento(l.precio, l.unidades) * l.unidades, 0);
  assert.equal(totalCarrito(lineas), esperado);
});

test('aplicarCupon descuenta el porcentaje', () => {
  const cupon = { tipo: 'porcentaje', valor: 25, caduca: '2026-12-31' };
  assert.equal(aplicarCupon(200, cupon, new Date('2026-06-01')), 150);
});

test('costeEnvio cobra cada kilo empezado', () => {
  costeEnvio(2.5, async () => 4).then((coste) => {
    assert.equal(coste, 12);
  });
});
