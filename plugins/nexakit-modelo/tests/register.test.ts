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

  // Botón para delegar: la sesión tiene 50 % de contexto, así que un mensaje difícil desde Sonnet recomienda delegar
  // en nivel-alto y uno mecánico desde Opus en nivel-ligero (sin cambiar de modelo, que costaría releer el contexto).
  const prepararBoton = ($: any, on: any, modelo = 'claude-opus-5-5', extra: { avisos?: string[]; falla?: { valor: boolean } } = {}) => {
    const enviados: { text: string; plugin: boolean }[] = [];
    on('session.start', ($: any, e: any) => ({ cwd: e.cwd }));
    on('session.model', () => ({ value: modelo }));
    on('session.usage', () => ({ value: { context: { percent: 50, tokens: 100000 }, rateLimits: [] } }));
    on('turn.start', ($: any, e: any) => ({ text: e.text, turnId: e.turnId }));
    on('turn.complete', ($: any, e: any) => ({ text: e.answer }));
    on('turn.abort', () => undefined);
    on('clock.now', () => ({ value: Date.now() }));
    on('tool.register', ($: any, e: any) => ({ value: { tool: e.name } }));
    on('env.get', () => ({ value: undefined }));
    on('ui.toast', (_: any, e: any) => {
      extra.avisos?.push(e.text);
      return { value: undefined };
    });
    on('prompt.edit', ($: any, e: any) => {
      const text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end);
      return { text, cursor: e.start + e.inputText.length };
    });
    on('prompt.submit', ($: any, e: any) => {
      if (extra.falla?.valor && e.origin?.kind === 'plugin') return { drop: 'bloqueado' };
      enviados.push({ text: e.text, plugin: e.origin?.kind === 'plugin' });
      return { text: e.text, origin: e.origin };
    });
    return enviados;
  };
  const MENSAJES = {
    'nivel-ligero': 'haz commit y push',
    'nivel-alto': 'el login sigue fallando y no sé por qué',
  } as const;
  const BARRA = (surface: string) => ({ plugin: 'nexakit-modelo', surface, component: 'AbovePrompt', props: { hasSurvey: false } }) as any;
  const turno = async ($: any, sufijo: string) => {
    await $.turn.start({ text: 'x', turnId: `t${sufijo}` });
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: `t${sufijo}`, reason: 'answer' });
  };

  test('en el escritorio la sugerencia de delegar es un botón y envía la instrucción de su nivel', async ($, on) => {
    const enviados = prepararBoton($, on);
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/test' });
    await $.prompt.submit({ text: MENSAJES['nivel-ligero'] });
    await turno($, '1');
    const ui = await $.ui.mount(BARRA('desktop'));
    const boton = await ui.find({ type: 'Button' });
    expect(boton?.props.label).toBe('→ delega: nivel-ligero');
    await ui.press({ key: 'delegar' });
    const enviado = enviados.at(-1)!;
    expect(enviado.plugin).toBe(true);
    expect(enviado.text).toContain('fabrica_encargar en Codex o Antigravity');
    expect(enviado.text).toContain('niveles:nivel-ligero');
    await ui.unmount();
  });

  test('para nivel-alto el botón delega directo en el subagente', async ($, on) => {
    // Desde Sonnet con contexto lleno, subir a Opus releería todo: se delega.
    const enviados = prepararBoton($, on, 'claude-sonnet-5-5');
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/test' });
    await $.prompt.submit({ text: MENSAJES['nivel-alto'] });
    await turno($, '1');
    const ui = await $.ui.mount(BARRA('desktop'));
    expect((await ui.find({ type: 'Button' }))?.props.label).toBe('→ delega: nivel-alto');
    await ui.press({ key: 'delegar' });
    expect(enviados.at(-1)!.text).toBe('Delega la tarea de mi mensaje anterior en el subagente niveles:nivel-alto y comprueba su informe.');
    await ui.unmount();
  });

  test('en la terminal la sugerencia sigue siendo texto', async ($, on) => {
    prepararBoton($, on);
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/test' });
    await $.prompt.submit({ text: MENSAJES['nivel-ligero'] });
    await turno($, '1');
    const ui = await $.ui.mount(BARRA('terminal'));
    expect(await ui.find({ type: 'Button' })).toBeUndefined();
    expect(await pintar($)).toContain('→ delega: nivel-ligero');
    await ui.unmount();
  });

  test('durante un turno en curso de la sesión principal no hay botón; un envío que no empieza turno no lo oculta', async ($, on) => {
    prepararBoton($, on);
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/test' });
    await $.prompt.submit({ text: MENSAJES['nivel-ligero'] });
    // El envío por sí solo no es un turno: el botón sigue (si el envío fallara, no quedaría bloqueado).
    const sinTurno = await $.ui.mount(BARRA('desktop'));
    expect(await sinTurno.find({ type: 'Button' })).toBeDefined();
    await sinTurno.unmount();
    await $.turn.start({ text: 'x', turnId: 't1' });
    const ui = await $.ui.mount(BARRA('desktop'));
    expect(await ui.find({ type: 'Button' })).toBeUndefined();
    await ui.unmount();
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' });
    const despues = await $.ui.mount(BARRA('desktop'));
    expect(await despues.find({ type: 'Button' })).toBeDefined();
    await despues.unmount();
  });

  test('sin mensaje previo de la persona no hay botón', async ($, on) => {
    prepararBoton($, on);
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/test' });
    const ui = await $.ui.mount(BARRA('desktop'));
    expect(await ui.find({ type: 'Button' })).toBeUndefined();
    await ui.unmount();
  });

  test('tras pulsar el botón no se puede enviar dos veces', async ($, on) => {
    const enviados = prepararBoton($, on);
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/test' });
    await $.prompt.submit({ text: MENSAJES['nivel-ligero'] });
    await turno($, '1');
    const ui = await $.ui.mount(BARRA('desktop'));
    await ui.press({ key: 'delegar' });
    await ui.unmount();
    const antes = enviados.length;
    // El turno de la delegación termina y el botón sigue sin volver para el mismo mensaje.
    await turno($, '2');
    const otra = await $.ui.mount(BARRA('desktop'));
    expect(await otra.find({ type: 'Button' })).toBeUndefined();
    expect(enviados).toHaveLength(antes);
    await otra.unmount();
  });

  test('el envío del botón no cambia el último mensaje de la persona', async ($, on) => {
    const enviados = prepararBoton($, on);
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/test' });
    await $.prompt.submit({ text: MENSAJES['nivel-ligero'] });
    await turno($, '1');
    const ui = await $.ui.mount(BARRA('desktop'));
    await ui.press({ key: 'delegar' });
    await ui.unmount();
    // «ok, dale» hereda la recomendación del último mensaje: si la instrucción del botón la hubiera cambiado, no saldría ligero.
    await $.prompt.submit({ text: 'ok, dale' });
    await turno($, '2');
    const otra = await $.ui.mount(BARRA('desktop'));
    expect((await otra.find({ type: 'Button' }))?.props.label).toBe('→ delega: nivel-ligero');
    expect(enviados.map((x) => x.plugin)).toEqual([false, true, false]);
    await otra.unmount();
  });

  test('si el envío del botón falla, avisa en español y el botón vuelve para reintentar', async ($, on) => {
    const avisos: string[] = [];
    const falla = { valor: true };
    const enviados = prepararBoton($, on, 'claude-opus-5-5', { avisos, falla });
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/test' });
    await $.prompt.submit({ text: MENSAJES['nivel-ligero'] });
    await turno($, '1');
    const ui = await $.ui.mount(BARRA('desktop'));
    await ui.press({ key: 'delegar' });
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain('reintentar');
    expect(enviados).toHaveLength(1);
    expect((await ui.find({ type: 'Button' }))?.props.label).toBe('→ delega: nivel-ligero');
    falla.valor = false;
    await ui.press({ key: 'delegar' });
    expect(enviados).toHaveLength(2);
    expect(enviados[1]!.plugin).toBe(true);
    await ui.unmount();
  });

  test('un borrador con otro texto oculta el botón aunque la recomendación sea la misma; vacío o igual lo conserva', async ($, on) => {
    prepararBoton($, on);
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/test' });
    await $.prompt.submit({ text: MENSAJES['nivel-ligero'] });
    await turno($, '1');
    const editar = (text: string, inputText: string) => $.prompt.edit({ origin: { kind: 'composer' }, text, cursor: text.length, start: 0, end: text.length, inputText });
    const hayBoton = async () => {
      const ui = await $.ui.mount(BARRA('desktop'));
      const boton = await ui.find({ type: 'Button' });
      await ui.unmount();
      return boton !== undefined;
    };
    expect(await hayBoton()).toBe(true);
    // «ok, dale» conserva la recomendación del último mensaje, pero es otro texto.
    await editar('', 'ok, dale');
    expect(await hayBoton()).toBe(false);
    await editar('ok, dale', '');
    expect(await hayBoton()).toBe(true);
    await editar('', ` ${MENSAJES['nivel-ligero']} `);
    expect(await hayBoton()).toBe(true);
  });

  test('el botón solo aparece en la app de escritorio, no en otras superficies con botones', async ($, on) => {
    prepararBoton($, on);
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/test' });
    await $.prompt.submit({ text: MENSAJES['nivel-ligero'] });
    await turno($, '1');
    for (const surface of ['mobile', 'vscode', 'terminal'] as const) {
      const ui = await $.ui.mount(BARRA(surface));
      expect(await ui.find({ type: 'Button' })).toBeUndefined();
      await ui.unmount();
    }
    const escritorio = await $.ui.mount(BARRA('desktop'));
    expect(await escritorio.find({ type: 'Button' })).toBeDefined();
    await escritorio.unmount();
  });
});
