import { describe, expect, test } from 'claude-code/testing';
import {
  alias, barra, barraEsfuerzo, crear, duracion, ejemplo, estadoPorFamilia, etiquetaEnjambre, etiquetaModelo, familia, hora,
  iniciarAgente, registrarAsesor, registrarHerramienta, registrarPaso, registrarRecomendacion, registrarUso, resumenDelegacion, sinSecretos, esRevision, iniciarRevision, leerSalidaRevision, terminarRevision, terminarAgente, tituloDeOrquesta, tokens,
} from '../hooks/panel.js';

describe('nexakit-panel · lógica', () => {
  test('el nombre del modelo se lee como persona: familia y versión', () => {
    expect(etiquetaModelo('claude-sonnet-5-5')).toBe('Sonnet 5.5');
    expect(etiquetaModelo('claude-opus-5-5')).toBe('Opus 5.5');
    expect(etiquetaModelo('claude-haiku-5-5')).toBe('Haiku 5.5');
    expect(etiquetaModelo('claude-sonnet-4-20250514')).toBe('Sonnet 4');
    expect(etiquetaModelo('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5');
    expect(etiquetaModelo('sonnet')).toBe('Sonnet');
    expect(etiquetaModelo('modelo-raro')).toBe('modelo-raro');
    expect(etiquetaModelo(null)).toBe('modelo ?');
  });

  test('la familia decide el color del modelo', () => {
    expect(familia('claude-haiku-5-5')).toBe('haiku');
    expect(familia('claude-sonnet-5-5')).toBe('sonnet');
    expect(familia('claude-opus-5-5')).toBe('opus');
    expect(familia('otra-cosa')).toBe('otro');
    expect(familia(undefined)).toBe('otro');
  });

  test('el esfuerzo se dibuja como barra de 4', () => {
    expect(barraEsfuerzo('low')).toBe('▮▯▯▯');
    expect(barraEsfuerzo('medium')).toBe('▮▮▯▯');
    expect(barraEsfuerzo('high')).toBe('▮▮▮▯');
    expect(barraEsfuerzo('xhigh')).toBe('▮▮▮▮');
    expect(barraEsfuerzo('max')).toBe('▮▮▮▮');
    expect(barraEsfuerzo(null)).toBe('▯▯▯▯');
  });

  test('duración y hora legibles', () => {
    expect(duracion(400)).toBe('0 s');
    expect(duracion(12_400)).toBe('12 s');
    expect(duracion(75_000)).toBe('1 min 15 s');
    expect(hora(new Date(2026, 10, 4, 9, 5, 7).getTime())).toBe('09:05:07');
  });

  test('un paso de la sesión principal fija el líder; el de un subagente solo su modelo', () => {
    let s = crear();
    s = registrarPaso(s, { modelo: 'claude-sonnet-5-5', esfuerzo: 'high', at: 1 });
    expect(s.lider).toMatchObject({ modelo: 'claude-sonnet-5-5', esfuerzo: 'high', leidos: 0, escritos: 0 });
    expect(s.pasos).toBe(1);
    s = iniciarAgente(s, { id: 'a1', nombre: 'search', modelo: 'claude-haiku-5-5', at: 2 });
    s = registrarPaso(s, { modelo: 'claude-haiku-5-5', esfuerzo: 'low', agentId: 'a1', at: 3 });
    expect(s.lider.modelo).toBe('claude-sonnet-5-5');
    expect(s.pasos).toBe(1);
  });

  test('un subagente empieza, cuenta herramientas y termina, y todo queda en el registro', () => {
    let s = crear();
    s = iniciarAgente(s, { id: 'a1', nombre: 'grep', modelo: 'claude-haiku-5-5', at: 1000 });
    expect(s.agentes[0]).toMatchObject({ id: 'a1', estado: 'corriendo', herramientas: 0, fin: null });
    s = registrarHerramienta(s, { tool: 'Grep', detalle: 'auth', agentId: 'a1', at: 2000 });
    s = registrarHerramienta(s, { tool: 'Read', detalle: 'src/auth.ts', at: 3000 });
    expect(s.agentes[0].herramientas).toBe(1);
    s = terminarAgente(s, { id: 'a1', ok: true, at: 5000 });
    expect(s.agentes[0]).toMatchObject({ estado: 'listo', fin: 5000 });
    expect(s.registro.map((r) => r.quien)).toEqual(['grep', 'grep', 'líder', 'grep']);
    s = terminarAgente(iniciarAgente(s, { id: 'a2', nombre: 'audit', modelo: 'x', at: 6000 }), { id: 'a2', ok: false, at: 7000 });
    expect(s.agentes[1].estado).toBe('error');
  });

  test('las consultas al asesor se acumulan y cero consultas no ensucian nada', () => {
    let s = crear();
    expect(registrarAsesor(s, { llamadas: 0, at: 1 })).toBe(s);
    s = registrarAsesor(s, { llamadas: 1, at: 10 });
    s = registrarAsesor(s, { llamadas: 2, at: 20 });
    expect(s.asesor).toMatchObject({ llamadas: 3, ultimo: 20 });
    expect(s.registro.at(-1)?.texto).toContain('2 veces');
    expect(s.registro.at(0)?.texto).toContain('1 vez');
  });

  test('el registro y la lista de agentes tienen tope y no crecen sin límite', () => {
    let s = crear();
    for (let i = 0; i < 200; i++) s = registrarHerramienta(s, { tool: 'Read', detalle: `f${i}`, at: i });
    expect(s.registro.length).toBe(60);
    expect(s.registro.at(-1)?.texto).toContain('f199');
    for (let i = 0; i < 20; i++) s = iniciarAgente(s, { id: `a${i}`, nombre: `n${i}`, modelo: 'm', at: i });
    expect(s.agentes.length).toBe(8);
    expect(s.agentes.at(-1)?.id).toBe('a19');
  });

  test('un evento de un agente desconocido no rompe nada', () => {
    const s = crear();
    expect(terminarAgente(s, { id: 'no-existe', ok: true, at: 1 }).agentes).toEqual([]);
    expect(registrarHerramienta(s, { tool: 'Bash', detalle: 'ls', agentId: 'no-existe', at: 1 }).registro[0].quien).toBe('agente');
  });
});

describe('nexakit-panel · diagrama', () => {
  const con = (agentes: Array<[string, string, 'corriendo' | 'listo' | 'error', number]>) => {
    let s = crear();
    s = registrarPaso(s, { modelo: 'claude-sonnet-5-5', esfuerzo: 'high' });
    agentes.forEach(([nombre, modelo, estado, tools], i) => {
      s = iniciarAgente(s, { id: 'a' + i, nombre, modelo, at: i });
      for (let k = 0; k < tools; k++) s = registrarHerramienta(s, { tool: 'Read', detalle: 'f', agentId: 'a' + i, at: 10 + k });
      if (estado !== 'corriendo') s = terminarAgente(s, { id: 'a' + i, ok: estado === 'listo', at: 99 });
    });
    return s;
  };

  test('la barra es proporcional, de ancho fijo y nunca se pasa', () => {
    expect(barra(0, 10)).toBe('░░░░░░░░░░');
    expect(barra(0.5, 10)).toBe('█████░░░░░');
    expect(barra(1, 10)).toBe('██████████');
    expect(barra(2, 4)).toBe('████');
    expect(barra(-1, 4)).toBe('░░░░');
    expect(barra(Number.NaN, 4)).toBe('░░░░');
  });

  test('el resumen de delegación cuenta lo real', () => {
    const s = con([['search', 'claude-haiku-5-5', 'listo', 2], ['grep', 'claude-haiku-5-5', 'corriendo', 1], ['audit', 'claude-haiku-5-5', 'error', 0], ['otro', 'claude-haiku-5-5', 'listo', 4]]);
    expect(resumenDelegacion(s.agentes)).toEqual({ total: 4, corriendo: 1, listos: 2, errores: 1, herramientas: 7 });
    expect(resumenDelegacion([])).toEqual({ total: 0, corriendo: 0, listos: 0, errores: 0, herramientas: 0 });
  });

  test('el título nombra al líder y, si hay subagentes, a su familia más usada', () => {
    expect(tituloDeOrquesta(crear())).toBe('NEXAKIT · ORQUESTA');
    const solo = registrarPaso(crear(), { modelo: 'claude-sonnet-5-5', esfuerzo: 'high' });
    expect(tituloDeOrquesta(solo)).toBe('NEXAKIT · ORQUESTA · SONNET 5.5 DIRIGE');
    const mixto = con([['a', 'claude-haiku-5-5', 'corriendo', 0], ['b', 'claude-haiku-5-5', 'listo', 0], ['c', 'claude-opus-5-5', 'listo', 0]]);
    expect(tituloDeOrquesta(mixto)).toBe('NEXAKIT · ORQUESTA · SONNET 5.5 DIRIGE · HAIKU 5.5 EN ENJAMBRE');
  });

  test('la línea de estado dice por familia qué ocurre y no inventa lo que no ocurre', () => {
    const s = registrarAsesor(con([['a', 'claude-haiku-5-5', 'corriendo', 0], ['b', 'claude-haiku-5-5', 'listo', 0]]), { llamadas: 2, at: 5 });
    expect(estadoPorFamilia(s)).toEqual(['haiku [enjambre]', 'subagentes [1/2]', 'asesor [consultado 2]']);
    expect(estadoPorFamilia(crear())).toEqual([]);
    expect(estadoPorFamilia(con([['a', 'claude-haiku-5-5', 'listo', 0]]))).toEqual(['haiku [listo]', 'subagentes [1/1]']);
  });

  test('el alias es lo que se escribe en --model', () => {
    expect(alias('claude-sonnet-5-5')).toBe('sonnet');
    expect(alias('claude-opus-5-5')).toBe('opus');
    expect(alias('rara')).toBe('rara');
    expect(alias(null)).toBe('?');
  });

  test('la etiqueta del enjambre es la misma que usa el título', () => {
    expect(etiquetaEnjambre([])).toBeNull();
    const mixto = con([['a', 'claude-haiku-5-5', 'corriendo', 0], ['b', 'claude-haiku-5-5', 'listo', 0], ['c', 'claude-opus-5-5', 'listo', 0]]);
    expect(etiquetaEnjambre(mixto.agentes)).toBe('Haiku 5.5');
    expect(tituloDeOrquesta(mixto)).toContain(etiquetaEnjambre(mixto.agentes)!.toUpperCase());
  });

  test('el ejemplo es determinista y trae de todo para juzgar el diseño: líder, asesor, tres subagentes y registro', () => {
    const e = ejemplo(1_000_000);
    expect(e).toEqual(ejemplo(1_000_000));
    expect(e.lider.modelo).toBe('claude-sonnet-5-5');
    expect(e.asesor.llamadas).toBeGreaterThan(0);
    expect(e.agentes.map((a) => a.estado).sort()).toEqual(['corriendo', 'corriendo', 'listo']);
    expect(e.registro.length).toBeGreaterThan(5);
    expect(Math.max(...e.registro.map((r) => r.t))).toBeLessThanOrEqual(1_000_000);
  });

  test('el uso real se acumula: leídos = entrada + caché, escritos = salida, por líder y por subagente', () => {
    const u = (i: number, o: number, cr: number, cw: number) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw, model: 'm' });
    let s = iniciarAgente(crear(), { id: 'a1', nombre: 'search', modelo: 'claude-haiku-5-5', at: 1 });
    s = registrarUso(s, { usage: u(100, 20, 1000, 50) });
    s = registrarUso(s, { usage: u(10, 5, 0, 0) });
    s = registrarUso(s, { agentId: 'a1', usage: u(7, 3, 300, 0) });
    s = registrarUso(s, { agentId: 'desconocido', usage: u(1, 1, 1, 1) });
    s = registrarUso(s, { usage: null });
    expect(s.lider).toMatchObject({ leidos: 1160, escritos: 25 });
    expect(s.agentes[0]).toMatchObject({ leidos: 307, escritos: 3 });
  });

  test('el asesor acumula su tiempo y cada subagente recuerda su última acción', () => {
    let s = registrarAsesor(crear(), { llamadas: 1, at: 10, tiempo: 1500 });
    s = registrarAsesor(s, { llamadas: 1, at: 20, tiempo: 500 });
    expect(s.asesor).toMatchObject({ llamadas: 2, tiempo: 2000 });
    s = iniciarAgente(s, { id: 'a1', nombre: 'grep', modelo: 'claude-haiku-5-5', at: 1 });
    s = registrarHerramienta(s, { tool: 'Grep', detalle: 'verifyToken', agentId: 'a1', at: 2 });
    expect(s.agentes[0].ultimo).toBe('Grep · verifyToken');
  });

  test('los tokens se leen en k y M', () => {
    expect(tokens(0)).toBe('0');
    expect(tokens(999)).toBe('999');
    expect(tokens(1500)).toBe('1.5k');
    expect(tokens(668_400)).toBe('668k');
    expect(tokens(2_340_000)).toBe('2.3M');
  });

  test('el líder cuenta sus herramientas aunque el registro tenga tope', () => {
    let s = crear();
    for (let i = 0; i < 150; i++) s = registrarHerramienta(s, { tool: 'Read', detalle: 'f', at: i });
    expect(s.lider.herramientas).toBe(150);
  });

  test('cada consulta al asesor guarda cuánto duró', () => {
    const s = registrarAsesor(crear(), { llamadas: 1, at: 10, tiempo: 4200 });
    expect(s.registro.at(-1)).toMatchObject({ quien: 'asesor', ms: 4200 });
  });

  test('la recomendación de modelo se guarda tal cual llega', () => {
    const s = registrarRecomendacion(crear(), { modelo: 'sonnet', esfuerzo: 'medium', motivo: 'uso diario' });
    expect(s.recomendacion).toEqual({ modelo: 'sonnet', esfuerzo: 'medium', motivo: 'uso diario' });
    expect(crear().recomendacion).toBeNull();
  });

  test('los detalles se guardan sin secretos evidentes', () => {
    expect(sinSecretos('export GITHUB_TOKEN=ghp_abc123 && npm test')).toBe('export GITHUB_TOKEN=*** && npm test');
    expect(sinSecretos('curl -H "Authorization: Bearer abc.def" x')).toBe('curl -H "Authorization: Bearer ***" x');
    expect(sinSecretos('API_KEY=sk-123 node app')).toBe('API_KEY=*** node app');
    expect(sinSecretos('mysql --password=hunter2 db')).toBe('mysql --password=*** db');
    expect(sinSecretos('npm test')).toBe('npm test');
  });

  test('reconoce una revisión enviada a otra IA y no confunde la consulta de disponibles', () => {
    expect(esRevision('~/.nexakit/nexakit revision --con codex --modelo gpt-6.1-sol --esfuerzo high --encargo /tmp/e.md')).toEqual({ ia: 'codex', modelo: 'gpt-6.1-sol', esfuerzo: 'high' });
    expect(esRevision('C:\\Users\\x\\.nexakit\\nexakit.cmd revision --con antigravity --modelo gemini-3.8-flash-high --esfuerzo high --encargo e.md')).toMatchObject({ ia: 'antigravity' });
    expect(esRevision('~/.nexakit/nexakit revision --disponibles --principal claude')).toBeNull();
    expect(esRevision('npm test')).toBeNull();
  });

  test('lee del resultado de la revisión el modelo que respondió y los tokens reales', () => {
    const salida = 'Informe…\nModelo pedido: gpt-6.1-sol · high · Modelo que respondió: gpt-6.1-sol · high (registro)\nTokens: entrada 41000 (caché 3000) · salida 900\n';
    expect(leerSalidaRevision(salida)).toEqual({ respondio: 'gpt-6.1-sol', entrada: 41000, cache: 3000, salida: 900 });
    expect(leerSalidaRevision('Tokens: entrada no informado (caché no informado) · salida no informado')).toEqual({ respondio: null, entrada: null, cache: null, salida: null });
    expect(leerSalidaRevision('')).toEqual({ respondio: null, entrada: null, cache: null, salida: null });
  });

  test('una revisión empieza, termina con sus cifras y se ve en el estado y el registro', () => {
    let s = iniciarRevision(crear(), { id: 'r1', ia: 'codex', modelo: 'gpt-6.1-sol', esfuerzo: 'high', at: 1000 });
    expect(s.revisiones[0]).toMatchObject({ ia: 'codex', estado: 'revisando', fin: null });
    expect(estadoPorFamilia(s)).toContain('codex [revisando]');
    s = terminarRevision(s, { id: 'r1', ok: true, at: 46_000, cifras: { respondio: 'gpt-6.1-sol', entrada: 41000, cache: 3000, salida: 900 } });
    expect(s.revisiones[0]).toMatchObject({ estado: 'lista', fin: 46_000, entrada: 41000, salida: 900 });
    expect(estadoPorFamilia(s)).toContain('codex [revisó]');
    expect(s.registro.map((r) => r.quien)).toEqual(['codex', 'codex']);
    expect(terminarRevision(s, { id: 'no', ok: true, at: 1, cifras: null })).toBe(s);
  });
});

