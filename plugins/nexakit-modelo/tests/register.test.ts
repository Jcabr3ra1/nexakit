import { describe, expect, test } from 'claude-code/testing';

describe('nexakit-modelo API', () => {
  test('registers the recommendation tool and reads the session model without a model call', async ($, on) => {
    const tools: string[] = [];
    const statuses: string[] = [];
    on('session.start', ($, e) => ({ cwd: e.cwd }));
    on('session.model', () => ({ value: 'haiku' }));
    on('tool.register', ($, e) => {
      tools.push(e.name);
      return { value: { tool: e.name } };
    });
    on('ui.status', ($, e) => {
      statuses.push(e.text ?? '');
      return { value: undefined };
    });
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/test' });
    expect(tools).toContain('nexakit_recomendacion');
    expect(statuses).toHaveLength(0);
  });

  test('suma los tokens de cada paso de un subagente sin alterar la respuesta del paso', async ($, on) => {
    const usos = [
      { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 40000, cache_creation_input_tokens: 2000, model: 'claude-sonnet-5-5' },
      { input_tokens: 500, output_tokens: 44000, cache_read_input_tokens: 60000, cache_creation_input_tokens: 0, model: 'claude-sonnet-5-5' },
    ];
    on('session.start', ($, e) => ({ cwd: e.cwd }));
    on('session.model', () => ({ value: 'claude-opus-5-5' }));
    on('tool.register', ($, e) => ({ value: { tool: e.name } }));
    // Lo que el motor contestaría a cada petición del subagente.
    on('turn.step', async function* ($, e) {
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: usos[e.index] };
    });
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/test' });
    const respuestas = [];
    for (const index of [0, 1]) {
      const paso = $.turn.step({ turnId: 't1', index, model: 'claude-sonnet-5-5', effort: 'high', messageCount: 1, agentId: 'a1' });
      let x = await paso.next();
      while (!x.done) x = await paso.next();
      respuestas.push(x.value);
    }
    expect(respuestas.map((r) => r.usage?.output_tokens)).toEqual([500, 44000]);
    expect(respuestas[1].answer).toBe('');
    expect(respuestas[1].stopReason).toBe('end_turn');
    // La barra dibuja la fila del subagente con la suma de sus dos pasos: 48k nuevos, 97 % de caché y 148k en total.
    const barra = JSON.stringify(await $.ui.render({ surface: 'terminal', component: 'AbovePrompt', requestId: 'r1', props: { hasSurvey: false } }));
    expect(barra).toContain('48k nuevos');
    expect(barra).toContain('148k en total');
    expect(barra).toContain('97% caché');
  });

  // Prepara el motor con un HOME y un sistema de archivos falsos; `lecturas` cuenta las lecturas de activo.json.
  const preparar = ($: any, on: any, { home, archivos }: { home: string | null; archivos: Record<string, string> }) => {
    const lecturas: string[] = [];
    on('session.start', ($: any, e: any) => ({ cwd: e.cwd }));
    on('session.model', () => ({ value: 'claude-opus-5-5' }));
    on('tool.register', ($: any, e: any) => ({ value: { tool: e.name } }));
    on('env.get', ($: any, e: any) => ({ value: e.name === 'HOME' ? (home ?? undefined) : undefined }));
    on('fs.exists', ($: any, e: any) => ({ value: e.path in archivos }));
    on('fs.read', ($: any, e: any) => {
      lecturas.push(e.path);
      return { value: archivos[e.path] };
    });
    return lecturas;
  };
  const pintar = async ($: any) => JSON.stringify(await $.ui.render({ surface: 'terminal', component: 'AbovePrompt', requestId: 'r', props: { hasSurvey: false } }));
  const activo = (extra: object = {}) => JSON.stringify({
    pid: 1, id: 'r', repo: 'x', actualizado: new Date().toISOString(),
    estaciones: [{ estacion: 'implementar', ia: 'codex', modelo: 'gpt-5.5', esfuerzo: 'high', estado: 'en-curso', tokens: 2500 }], ...extra,
  });

  test('la barra pinta las estaciones externas de la fábrica leídas de activo.json', async ($, on) => {
    preparar($, on, { home: '/h', archivos: { '/h/.nexakit/fabrica/activo.json': activo() } });
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/test' });
    const barra = await pintar($);
    expect(barra).toContain('implementar');
    expect(barra).toContain('codex gpt-5.5 high');
    expect(barra).toContain('2,5k tokens');
  });

  test('con el archivo ausente la barra no muestra filas ni falla', async ($, on) => {
    preparar($, on, { home: '/h', archivos: {} });
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/test' });
    expect(await pintar($)).not.toContain('↳');
  });

  test('sin HOME no se lee nada', async ($, on) => {
    const lecturas = preparar($, on, { home: null, archivos: { '/h/.nexakit/fabrica/activo.json': activo() } });
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/test' });
    expect(await pintar($)).not.toContain('↳');
    expect(lecturas).toHaveLength(0);
  });

  test('un activo.json de más de 64 KiB (se lee entero: $.fs no informa del tamaño antes) no da filas', async ($, on) => {
    preparar($, on, { home: '/h', archivos: { '/h/.nexakit/fabrica/activo.json': activo({ relleno: 'a'.repeat(70 * 1024) }) } });
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/test' });
    expect(await pintar($)).not.toContain('↳');
  });
});
