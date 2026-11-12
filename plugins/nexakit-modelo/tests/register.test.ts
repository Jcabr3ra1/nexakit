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
    // La barra dibuja la fila del subagente con la suma de sus dos pasos: 148k en total y 97 % de caché.
    const barra = JSON.stringify(await $.ui.render({ surface: 'terminal', component: 'AbovePrompt', requestId: 'r1', props: { hasSurvey: false } }));
    expect(barra).toContain('148k');
    expect(barra).toContain('97% caché');
  });
});
