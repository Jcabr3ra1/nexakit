import { describe, expect, test } from 'claude-code/testing';
import { ANCHO, aAnsi, dibujar, texto } from '../hooks/lienzo.js';
import { crear, ejemplo, registrarPaso, registrarRecomendacion } from '../hooks/panel.js';

const AHORA = 1_800_000_000_000;
const USO = { context: { window: 1000000, percent: 31 }, rateLimits: [{ kind: 'five_hour', percentUsed: 43 }, { kind: 'seven_day', percentUsed: 60 }] };
const demo = () => texto(dibujar(ejemplo(AHORA), { ahora: AHORA, uso: USO, carpeta: 'mi-app' }).filas);
const cuenta = (lineas: string[], c: string) => lineas.join('').split(c).length - 1;

describe('nexakit-panel · lienzo', () => {
  test('cada línea mide exactamente el ancho del diagrama', () => {
    const lineas = demo();
    expect(ANCHO).toBe(104);
    for (const l of lineas) expect([...l].length).toBe(ANCHO);
  });

  test('cabecera: título centrado, regla doble y leyenda', () => {
    const l = demo();
    expect(l[0]).toContain('NEXAKIT · ORQUESTA · SONNET 5.5 DIRIGE · HAIKU 5.5 EN ENJAMBRE');
    expect(l[1]).toMatch(/═{90,}/);
    expect(l[2]).toContain('■ sonnet 5.5 · líder');
    expect(l[2]).toContain('■ haiku 5.5 · enjambre');
    expect(l[2]).toContain('■ delegación');
    expect(l[2]).toContain('■ asesor');
  });

  test('todas las cajas y conectores quedan cerrados', () => {
    const l = demo();
    expect(cuenta(l, '┌')).toBe(cuenta(l, '┐'));
    expect(cuenta(l, '└')).toBe(cuenta(l, '┘'));
  });

  test('líder, delegación, subagentes en fila y vuelta al líder, con uso real', () => {
    const l = demo().join('\n');
    expect(l).toContain('Sonnet 5.5 · sesión principal');
    expect(l).toMatch(/esfuerzo ▮▮▮▯ high/);
    expect(l).toMatch(/leídos \S+ · escritos \S+/);
    expect(l).toMatch(/DELEGACIÓN · subagentes +3/);
    expect(l).toMatch(/listos +█*░* +1\/3/);
    expect(l).toMatch(/corriendo +█*░* +2\/3/);
    expect(l).toContain('delegar a subagentes · Haiku 5.5');
    expect(l).toContain('de vuelta en Sonnet 5.5 · líder');
    const fila = demo().find((x) => x.includes('search') && x.includes('grep') && x.includes('audit'));
    expect(fila).toBeTruthy();
  });

  test('el porcentaje de cada subagente es su parte real del uso y suma 100', () => {
    const fila = demo().find((x) => (x.match(/\d+%/g) ?? []).length === 3)!;
    expect(fila).toBeTruthy();
    const suma = (fila.match(/(\d+)%/g) ?? []).map((p) => Number(p.slice(0, -1))).reduce((a, b) => a + b, 0);
    expect(Math.abs(suma - 100)).toBeLessThanOrEqual(2);
  });

  test('asesor a la izquierda con sus consultas, flechas y cifras', () => {
    const l = demo();
    expect(l.some((x) => x.includes('ASESOR'))).toBe(true);
    expect(l.some((x) => /◆ \d\d:\d\d:\d\d/.test(x))).toBe(true);
    expect(l.some((x) => x.includes('┈▶'))).toBe(true);
    expect(l.some((x) => /consultas +2/.test(x))).toBe(true);
  });

  test('registro con título en el borde, y abajo la orden y el estado', () => {
    const l = demo();
    expect(l.some((x) => x.includes('┤ registro de sesión ├'))).toBe(true);
    expect(l.some((x) => x.includes('→ src/auth.ts'))).toBe(true);
    expect(l.some((x) => x.includes('mi-app $ claude --model sonnet'))).toBe(true);
    expect(l.some((x) => /haiku \[enjambre\] +subagentes \[1\/3\] +asesor \[consultado 2\]/.test(x))).toBe(true);
    expect(l.some((x) => /contexto +█+░* +31 %/.test(x))).toBe(true);
  });

  test('sin actividad no dibuja cajas inventadas', () => {
    const l = texto(dibujar(crear(), { ahora: AHORA, uso: null, carpeta: 'mi-app' }).filas);
    expect(l.join('\n')).toContain('Aún no hay actividad');
    expect(cuenta(l, '┌')).toBe(0);
    for (const x of l) expect([...x].length).toBe(ANCHO);
  });

  test('se adapta al alto: recorta el registro y no pasa del máximo', () => {
    const alto = dibujar(ejemplo(AHORA), { ahora: AHORA, uso: USO, carpeta: 'mi-app', filasMax: 48 }).alto;
    expect(alto).toBeLessThanOrEqual(48);
    const completo = dibujar(ejemplo(AHORA), { ahora: AHORA, uso: USO, carpeta: 'mi-app' }).alto;
    expect(completo).toBeGreaterThan(alto);
  });

  test('a ANSI: sin color no hay escapes; con color de 24 bits sí', () => {
    const { filas } = dibujar(ejemplo(AHORA), { ahora: AHORA, uso: USO, carpeta: 'mi-app' });
    expect(aAnsi(filas, 'none')).not.toContain('\x1b');
    expect(aAnsi(filas, 'truecolor')).toContain('38;2;');
    expect(aAnsi(filas, '256')).toContain('38;5;');
  });

  test('la caja del líder no corta sus cifras', () => {
    const l = demo().join('\n');
    expect(l).toMatch(/leídos 668k · escritos 12k/);
    expect(l).not.toMatch(/escritos 1…/);
    expect(l).toMatch(/pasos 24 · herramientas 1/);
  });

  test('cada consulta del asesor dice cuánto duró', () => {
    expect(demo().some((x) => /duró 4 s/.test(x))).toBe(true);
  });

  test('si el asesor está configurado, lo nombra y lo pone en la orden', () => {
    const l = texto(dibujar(ejemplo(AHORA), { ahora: AHORA, uso: USO, carpeta: 'app', asesorModelo: 'opus' }).filas);
    expect(l.some((x) => x.includes('OPUS'))).toBe(true);
    expect(l.some((x) => x.includes('claude --model sonnet --advisor opus'))).toBe(true);
    expect(demo().some((x) => x.includes('--advisor'))).toBe(false);
  });

  test('abajo, el uso con barras y el modelo frente al recomendado', () => {
    const conRec = registrarRecomendacion(registrarPaso(ejemplo(AHORA), { modelo: 'claude-opus-5-5', esfuerzo: 'high' }), { modelo: 'sonnet', esfuerzo: 'medium', motivo: 'x' });
    const l = texto(dibujar(conRec, { ahora: AHORA, uso: USO, carpeta: 'app' }).filas);
    expect(l.some((x) => /contexto +█+░* +31 %/.test(x) && /5 h +█*░+ +43 %/.test(x) && /semana +█+░* +60 %/.test(x))).toBe(true);
    expect(l.some((x) => x.includes('modelo claude-opus-5-5 · high → recomendado: sonnet · medium'))).toBe(true);
    const igual = registrarRecomendacion(registrarPaso(ejemplo(AHORA), { modelo: 'claude-sonnet-5-5', esfuerzo: 'medium' }), { modelo: 'sonnet', esfuerzo: 'medium', motivo: 'x' });
    expect(texto(dibujar(igual, { ahora: AHORA, uso: USO, carpeta: 'app' }).filas).some((x) => x.includes('modelo claude-sonnet-5-5 · medium ✓'))).toBe(true);
    for (const x of l) expect([...x].length).toBe(ANCHO);
  });
});

