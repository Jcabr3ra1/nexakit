import { describe, expect, test } from 'claude-code/testing';
import { avisoDeContexto, mensajeDeAviso } from '../hooks/aviso.js';

describe('nexakit-sesion · lógica', () => {
  test('los umbrales avisan al 60 % y al 80 %, y nunca sin dato', () => {
    expect(avisoDeContexto(0)).toBe(0);
    expect(avisoDeContexto(59.9)).toBe(0);
    expect(avisoDeContexto(60)).toBe(1);
    expect(avisoDeContexto(79.9)).toBe(1);
    expect(avisoDeContexto(80)).toBe(2);
    expect(avisoDeContexto(100)).toBe(2);
    expect(avisoDeContexto(undefined)).toBe(0);
    expect(avisoDeContexto(Number.NaN)).toBe(0);
  });


  test('cada aviso dice el porcentaje, propone el traspaso y no promete cerrar nada', () => {
    const uno = mensajeDeAviso(1, 62.2);
    const dos = mensajeDeAviso(2, 83.7);
    expect(uno).toContain('62 %');
    expect(dos).toContain('84 %');
    for (const texto of [uno, dos]) {
      expect(texto).toContain('traspaso');
      expect(texto).toContain('sesión nueva');
    }
    expect(mensajeDeAviso(0, 10)).toBeUndefined();
  });
});

describe('nexakit-sesion · en la sesión', () => {
  const montar = async ($: any, on: any, porcentajes: number[]) => {
    const estados: (string | undefined)[] = [];
    const avisos: string[] = [];
    let turno = 0;
    on('session.start', (_: any, e: any) => ({ cwd: e.cwd }));
    on('turn.complete', () => ({ text: 'listo' }));
    on('session.end', () => ({ sessionId: 's1' }));
    on('clock.now', () => ({ value: 0 }));
    on('fs.write', () => ({ value: undefined }));
    on('session.usage', () => ({
      value: { startedAt: 0, context: { window: 1000000, percent: porcentajes[Math.min(turno, porcentajes.length - 1)] }, rateLimits: [] },
    }));
    on('ui.status', (_: any, e: any) => {
      estados.push(e.text);
      return { value: undefined };
    });
    on('ui.toast', (_: any, e: any) => {
      avisos.push(e.text);
      return { value: undefined };
    });
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/prueba' });
    const terminar = async () => {
      await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 5, isAborted: false, turnId: `t${turno}` });
      turno += 1;
    };
    return { estados, avisos, terminar };
  };

  test('avisa una sola vez por umbral y vuelve a avisar si el contexto baja y vuelve a subir', async ($, on) => {
    const { estados, avisos, terminar } = await montar($, on, [30, 61, 65, 82, 85, 20, 70]);
    await terminar(); // 30
    expect(avisos).toHaveLength(0);
    await terminar(); // 61 -> primer aviso
    expect(avisos).toHaveLength(1);
    await terminar(); // 65 -> sin repetir
    expect(avisos).toHaveLength(1);
    await terminar(); // 82 -> aviso urgente
    expect(avisos).toHaveLength(2);
    expect(avisos[1]).toContain('82 %');
    await terminar(); // 85 -> sin repetir
    expect(avisos).toHaveLength(2);
    await terminar(); // 20 -> tras compactar o limpiar
    await terminar(); // 70 -> vuelve a avisar
    expect(avisos).toHaveLength(3);
    expect(estados.filter((texto) => texto !== undefined)).toHaveLength(0);
  });

  test('al terminar la sesión limpia la línea de estado de versiones anteriores', async ($, on) => {
    const { estados } = await montar($, on, [10]);
    await $.session.end({ reason: 'exit' });
    expect(estados.at(-1)).toBeUndefined();
  });
});
