import { describe, expect, test } from 'claude-code/testing';

describe('nexakit-lecciones con el motor', () => {
  test('al tercer error del mismo tipo añade la nota sin romper la forma del resultado de Bash', async ($, on) => {
    // Así llega un Bash que falla: el resultado es el texto del error, no el objeto de salida normal.
    on('tool.call', { tool: 'Bash' }, ($, e) => ({
      isError: true,
      result: `Exit code 1\nError: Cannot find module '/tmp/${e.command}'`,
    }));
    let r;
    for (const c of ['node a.js', 'node b.js', 'node c.js']) r = await $.tool.call({ tool: 'Bash', command: c });
    expect(r.isError).toBe(true);
    expect(String(r.result)).toContain('Cannot find module');
    expect((r.context ?? []).some((t: string) => /3 veces/u.test(t))).toBe(true);
  });
});
