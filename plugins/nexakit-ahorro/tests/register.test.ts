import { describe, expect, mock, test } from 'claude-code/testing';

// El sistema de archivos, el entorno y el reloj se simulan: ninguna prueba toca el HOME real.
const HOME_FALSO = '/home/prueba-ahorro';
const AHORA = 1_800_000_000_000;

const lineas = (n: number) => Array.from({ length: n }, (_, i) => `linea ${i + 1}`);
const corta = lineas(10).join('\n');
const larga = [...lineas(1500), 'error: se rompió el módulo', ...lineas(1500)].join('\n');

function simularMundo(on: any, opciones: { home?: string | null; fallarEscritura?: boolean; fallarSoloRegistro?: boolean } = {}) {
  const escrituras: { path: string; text: string }[] = [];
  const home = opciones.home === undefined ? HOME_FALSO : opciones.home;
  mock.env(on, home ? { HOME: home } : {});
  mock.clock(on, { now: AHORA });
  on('fs.exists', () => ({ value: false }));
  on('fs.read', () => ({ value: '' }));
  on('fs.write', ($: any, e: any) => {
    if (opciones.fallarEscritura || (opciones.fallarSoloRegistro && e.path.endsWith('ahorro.jsonl'))) {
      return { deny: 'disco lleno simulado' };
    }
    escrituras.push({ path: e.path, text: e.text });
    return { value: undefined };
  });
  return escrituras;
}

function simularBash(on: any, stdout: string, extra: Record<string, unknown> = {}) {
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout, stderr: '', interrupted: false, ...extra } }));
}

describe('nexakit-ahorro con el motor', () => {
  test('una salida corta pasa intacta y no escribe nada', async ($, on) => {
    const escrituras = simularMundo(on);
    simularBash(on, corta);
    const r = await $.tool.call({ tool: 'Bash', command: 'ls' });
    expect(r.result.stdout).toBe(corta);
    expect(escrituras).toEqual([]);
  });

  test('una salida larga se recorta, conserva el error y avisa de la ruta bajo .nexakit/salidas/', async ($, on) => {
    const escrituras = simularMundo(on);
    simularBash(on, larga);
    const r = await $.tool.call({ tool: 'Bash', command: 'npm test' });
    const texto: string = r.result.stdout;
    expect(texto.length).toBeLessThan(larga.length);
    expect(texto.split('\n').length).toBeLessThan(200);
    expect(texto).toContain('error: se rompió el módulo');
    expect(texto).toContain('linea 1');
    expect(r.result.stderr).toBe('');
    const aviso = texto.match(/Salida completa: (\S+)/u);
    expect(aviso).not.toBeNull();
    expect(aviso![1]).toContain('.nexakit/salidas/');
    // La copia guardada es la salida completa y está bajo el HOME simulado.
    const copia = escrituras.find((w) => w.path === aviso![1]);
    expect(copia?.text).toBe(larga);
    expect(aviso![1].startsWith(`${HOME_FALSO}/.nexakit/salidas/`)).toBe(true);
  });

  test('registra solo cifras en ahorro.jsonl, sin contenido ni comando', async ($, on) => {
    const escrituras = simularMundo(on);
    simularBash(on, larga);
    await $.tool.call({ tool: 'Bash', command: 'npm test --secreto-del-comando' });
    const registro = escrituras.find((w) => w.path === `${HOME_FALSO}/.nexakit/ahorro.jsonl`);
    expect(registro).toBeDefined();
    const fila = JSON.parse(registro!.text.trim());
    expect(fila.fecha).toBe(AHORA);
    expect(fila.antes).toBe(larga.length);
    expect(fila.despues).toBeLessThan(fila.antes);
    expect(fila.lineasAntes).toBe(3001);
    expect(registro!.text).not.toContain('secreto-del-comando');
    expect(registro!.text).not.toContain('se rompió');
  });

  test('con NEXAKIT_SALIDA=completa delante del comando no se recorta', async ($, on) => {
    const escrituras = simularMundo(on);
    simularBash(on, larga);
    const r = await $.tool.call({ tool: 'Bash', command: 'NEXAKIT_SALIDA=completa npm test' });
    expect(r.result.stdout).toBe(larga);
    expect(escrituras).toEqual([]);
  });

  test('si falla escribir en disco el resultado de Bash se devuelve igualmente', async ($, on) => {
    simularMundo(on, { fallarEscritura: true });
    simularBash(on, larga);
    const r = await $.tool.call({ tool: 'Bash', command: 'npm test' });
    expect(r.deny).toBeUndefined();
    expect(r.result.stdout).toContain('error: se rompió el módulo');
    expect(r.result.stdout.length).toBeLessThan(larga.length);
    expect(r.result.stdout).not.toContain('Salida completa:');
  });

  test('si solo falla el registro de cifras la copia y el recorte siguen', async ($, on) => {
    const escrituras = simularMundo(on, { fallarSoloRegistro: true });
    simularBash(on, larga);
    const r = await $.tool.call({ tool: 'Bash', command: 'npm test' });
    expect(r.result.stdout).toContain('Salida completa:');
    expect(escrituras.length).toBe(1);
  });

  test('sin HOME recorta igualmente, sin copia ni ruta', async ($, on) => {
    const escrituras = simularMundo(on, { home: null });
    simularBash(on, larga);
    const r = await $.tool.call({ tool: 'Bash', command: 'npm test' });
    expect(r.result.stdout.length).toBeLessThan(larga.length);
    expect(r.result.stdout).not.toContain('Salida completa:');
    expect(escrituras).toEqual([]);
  });

  test('una imagen pasa intacta', async ($, on) => {
    const escrituras = simularMundo(on);
    simularBash(on, larga, { isImage: true });
    const r = await $.tool.call({ tool: 'Bash', command: 'screencapture' });
    expect(r.result.stdout).toBe(larga);
    expect(escrituras).toEqual([]);
  });

  test('una tarea en segundo plano pasa intacta', async ($, on) => {
    const escrituras = simularMundo(on);
    simularBash(on, larga, { backgroundTaskId: 'bg-1' });
    const r = await $.tool.call({ tool: 'Bash', command: 'npm run dev' });
    expect(r.result.stdout).toBe(larga);
    expect(escrituras).toEqual([]);
  });

  test('un resultado que no es texto (error con cadena, sin stdout) pasa intacto', async ($, on) => {
    const escrituras = simularMundo(on);
    const cadena = `Exit code 1\n${larga}`;
    on('tool.call', { tool: 'Bash' }, () => ({ isError: true, result: cadena }));
    const r = await $.tool.call({ tool: 'Bash', command: 'npm test' });
    expect(r.isError).toBe(true);
    expect(r.result).toBe(cadena);
    expect(escrituras).toEqual([]);
  });

  test('una herramienta distinta de Bash pasa intacta', async ($, on) => {
    const escrituras = simularMundo(on);
    on('tool.call', { tool: 'Read' }, () => ({ result: { stdout: larga } }));
    const r = await $.tool.call({ tool: 'Read', file_path: 'x.txt' });
    expect(r.result.stdout).toBe(larga);
    expect(escrituras).toEqual([]);
  });
});
