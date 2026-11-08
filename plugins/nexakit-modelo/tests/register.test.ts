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
});
