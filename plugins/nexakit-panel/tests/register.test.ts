import { describe, expect, test } from 'claude-code/testing';

const PANE = {
  plugin: 'nexakit-panel',
  component: 'Pane',
  requestId: 'panel',
  props: { title: 'Orquesta', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const;

let reloj = 1_000_000;
const drain = async (stream: any) => {
  for await (const _ of stream) { /* el panel solo observa */ }
  return stream.result;
};

// Lo que el motor contestaría por debajo del mod.
function motor($: any, on: any, uso: any = { startedAt: 0, context: { window: 1000000, percent: 31 }, rateLimits: [{ kind: 'five_hour', percentUsed: 43 }, { kind: 'seven_day', percentUsed: 60 }] }, falla = false) {
  on('command.register', () => ({ value: { command: 'panel' } }));
  on('ui.open', () => ({ value: { isPlaced: true } }));
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }));
  on('clock.now', () => ({ value: (reloj += 1000) }));
  on('session.cwd', () => ({ value: '/prueba/mi-app' }));
  on('session.usage', () => { if (falla) throw new Error('sin datos'); return { value: uso }; });
  on('tool.call', () => ({ result: {} }));
  on('agent.spawn', (_: any, e: any) => ({ model: e.model ?? 'claude-haiku-5-5', agentId: `ag-${e.name ?? 'x'}` }));
  on('turn.complete', () => ({ text: '' }));
  on('turn.step', async function* (_: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null,
      serverToolUses: e.index === 1 ? [{ id: 's1', name: 'advisor', input: {}, startedAt: 1, endedAt: 2 }]
        : e.index === 2 ? [{ id: 's2', name: 'web_search', input: {}, startedAt: 3, endedAt: 4 }] : undefined };
  });
}
const paso = ($: any, extra: any) =>
  drain($.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', effort: 'high', messageCount: 3, ...extra }));
const turnoListo = ($: any, extra: any) =>
  $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 5, isAborted: false, turnId: 't1', ...extra });

describe('nexakit-panel · en la sesión', () => {
  test('dibuja líder, subagentes, asesor, registro y límites con lo que informa el motor', async ($, on) => {
    motor($, on);
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/prueba' });
    await paso($, {});                                              // líder: Sonnet 5.5 · high
    await paso($, { index: 1 });                                    // el paso trae una consulta al asesor
    await paso($, { index: 2 });                                    // otra llamada del servidor: no es el asesor
    await $.agent.spawn({ prompt: 'mapea', name: 'search', subagentType: 'Explore', description: 'mapear el repo', model: 'claude-haiku-5-5' });
    await $.tool.call({ tool: 'Read', file_path: 'src/auth.ts', agentId: 'ag-search' });
    await turnoListo($, { agentId: 'ag-search' });

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface });
      expect((await ui.find({ type: 'Text', text: /Sonnet 5\.5 · sesión principal/ }))?.text).toBeTruthy();
      expect((await ui.find({ type: 'Text', text: /esfuerzo ▮▮▮▯ high/ }))?.text).toBeTruthy();
      expect((await ui.find({ type: 'Text', text: /Asesor · consultas 1/ }))?.text).toBeTruthy();
      expect((await ui.find({ type: 'Text', text: /search/ }))?.text).toBeTruthy();
      expect((await ui.find({ type: 'Text', text: /Haiku 5\.5/ }))?.text).toBeTruthy();
      expect((await ui.find({ type: 'Text', text: /✓ listo/ }))?.text).toBeTruthy();
      expect((await ui.find({ type: 'Text', text: /Read · src\/auth\.ts/ }))?.text).toBeTruthy();
      expect((await ui.find({ type: 'Text', text: /contexto .*31 % +5 h .*43 % +semana .*60 %/ }))?.text).toBeTruthy();
      await ui.unmount();
    }
  });

  test('con ancho de sobra dibuja el diagrama completo con la estructura de la imagen', async ($, on) => {
    motor($, on);
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/prueba' });
    await paso($, {});
    await paso($, { index: 1 });
    await $.agent.spawn({ prompt: 'mapea', name: 'search', subagentType: 'Explore', description: 'mapear', model: 'claude-haiku-5-5' });
    await $.agent.spawn({ prompt: 'busca', name: 'grep', subagentType: 'Explore', description: 'buscar', model: 'claude-haiku-5-5' });
    await $.tool.call({ tool: 'Read', file_path: 'src/auth.ts', agentId: 'ag-search' });
    await turnoListo($, { agentId: 'ag-search' });

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 120 } });
    const hay = async (texto: RegExp) => expect((await ui.find({ type: 'Text', text: texto }))?.text, String(texto)).toBeTruthy();
    for (const t of [/NEXAKIT/, /SONNET 5\.5 DIRIGE/, /HAIKU 5\.5 EN ENJAMBRE/, /═{50,}/, /sonnet 5\.5 · líder/, /ASESOR/,
      /◆ \d\d:\d\d:\d\d consulta/, /Sonnet 5\.5 · sesión principal/, /pasos 2 · herramientas 0/, /DELEGACIÓN · subagentes/,
      /delegar a subagentes/, /search/, /✓ listo/, /◐ corriendo/, /de vuelta en Sonnet 5\.5 · líder/, /esperando 1 subagente/,
      /registro de sesión/, /→ src\/auth\.ts/, /claude --model sonnet/, /\[enjambre\]/, /\[consultado 1\]/, /31 %/, /43 %/, /60 %/]) {
      await hay(t);
    }
    await ui.unmount();
  });

  test('en el diagrama ancho sin actividad no inventa cajas ni números', async ($, on) => {
    motor($, on, { startedAt: 0, context: { window: 1000000 }, rateLimits: [] });
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/prueba' });
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 120 } });
    expect((await ui.find({ type: 'Text', text: /Aún no hay actividad/ }))?.text).toBeTruthy();
    for (const falso of [/DELEGACIÓN/, /ASESOR/, /de vuelta en/, /registro de sesión/]) expect(await ui.find({ type: 'Text', text: falso })).toBeFalsy();
    await ui.unmount();
  });

  test('con más subagentes de los que caben avisa de los que no caben y no los pierde en silencio', async ($, on) => {
    motor($, on);
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/prueba' });
    await paso($, {});
    for (let i = 0; i < 6; i++) await $.agent.spawn({ prompt: 'x', name: 'tarea' + i, description: 'd', model: 'claude-haiku-5-5' });
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 120 } });
    expect((await ui.find({ type: 'Text', text: /\+3 más/ }))?.text).toBeTruthy();
    expect((await ui.find({ type: 'Text', text: /DELEGACIÓN · subagentes/ }))?.text).toBeTruthy();
    expect((await ui.find({ type: 'Text', text: /^ *6 *$/ }))?.text).toBeTruthy();
    await ui.unmount();
  });

  test('/panel-demo enseña datos de ejemplo marcados como ficticios, y el panel real no se contamina', async ($, on) => {
    motor($, on);
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/prueba' });
    await $.command.run({ command: 'panel-demo', args: '' } as any);
    let ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 120 } });
    expect((await ui.find({ type: 'Text', text: /EJEMPLO · datos ficticios/ }))?.text).toBeTruthy();
    expect((await ui.find({ type: 'Text', text: /DELEGACIÓN/ }))?.text).toBeTruthy();
    await ui.unmount();
    await $.command.run({ command: 'panel-demo', args: '' } as any);
    ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 120 } });
    expect(await ui.find({ type: 'Text', text: /EJEMPLO/ })).toBeFalsy();
    expect((await ui.find({ type: 'Text', text: /Aún no hay actividad/ }))?.text).toBeTruthy();
    await ui.unmount();
  });

  test('guarda una foto del estado real en ~/.nexakit/panel para nexakit panel, sin secretos', async ($, on) => {
    const escritos: Record<string, string> = {};
    motor($, on);
    on('env.get', (_: any, e: any) => ({ value: e.name === 'HOME' ? '/home/prueba' : undefined }));
    on('session.id', () => ({ value: 'sesion-123' }));
    on('fs.write', (_: any, e: any) => { escritos[e.path] = e.text; return { value: undefined }; });
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/prueba' });
    await paso($, {});
    await $.tool.call({ tool: 'Bash', command: 'export API_TOKEN=abc123 && npm test' } as any);
    const foto = JSON.parse(escritos['/home/prueba/.nexakit/panel/actual.json']);
    expect(foto).toMatchObject({ version: 1, sesion: 'sesion-123', carpeta: 'mi-app' });
    expect(foto.estado.lider.modelo).toBe('claude-sonnet-5-5');
    expect(foto.uso.context.percent).toBe(31);
    expect(JSON.stringify(foto)).not.toContain('abc123');
    expect(escritos['/home/prueba/.nexakit/panel/sesion-123.json']).toBe(escritos['/home/prueba/.nexakit/panel/actual.json']);
  });

  test('sin actividad el panel lo dice y no inventa nada', async ($, on) => {
    motor($, on, { startedAt: 0, context: { window: 1000000 }, rateLimits: [] });
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/prueba' });
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
    expect((await ui.find({ type: 'Text', text: /Aún no hay actividad/ }))?.text).toBeTruthy();
    expect(await ui.find({ type: 'Text', text: /Asesor/ })).toBeFalsy();
    expect(await ui.find({ type: 'Text', text: /contexto/ })).toBeFalsy();
    await ui.unmount();
  });

  test('si falla la lectura del uso, el panel se dibuja igual', async ($, on) => {
    motor($, on, undefined, true);
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/prueba' });
    await paso($, {});
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
    expect((await ui.find({ type: 'Text', text: /Sonnet 5\.5/ }))?.text).toBeTruthy();
    await ui.unmount();
  });
});
