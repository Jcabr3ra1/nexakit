import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gitConfigGlobalVacio } from '../test-support/git-aislado.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { crearServidorFabrica } from '../dist/fabrica/mcp.js';
import { registrationCommand } from '../src/toolkit-setup.js';

const ENTRADA = fileURLToPath(new URL('../bin/nexakit-fabrica-mcp.js', import.meta.url));
const SERVIDOR = fileURLToPath(new URL('../test-support/fabrica/servidor-falso.mjs', import.meta.url));
const GUIONES = fileURLToPath(new URL('../test-support/fabrica/', import.meta.url));
const leer = (nombre) => JSON.parse(readFileSync(path.join(GUIONES, nombre), 'utf8'));
const MENSAJE_SIN_PROPUESTA = 'No hay una propuesta con esa huella; vuelve a proponer';

const temporales = [];
const clientes = [];
test.after(async () => {
  await Promise.allSettled(clientes.map((c) => c.close()));
  for (const dir of temporales) rmSync(dir, { recursive: true, force: true });
});

function temporal(prefijo) {
  const dir = mkdtempSync(path.join(tmpdir(), prefijo));
  temporales.push(dir);
  return dir;
}

const GIT_ENTORNO = {
  GIT_CONFIG_GLOBAL: gitConfigGlobalVacio,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Prueba',
  GIT_COMMITTER_NAME: 'Prueba',
  GIT_AUTHOR_EMAIL: 'prueba@example.com',
  GIT_COMMITTER_EMAIL: 'prueba@example.com',
};

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENTORNO },
  }).trim();
}

/** Repo con `main` y la rama `trabajo` con `src/a.js` sin confirmar; Antigravity revisa arquitectura. */
function crearRepo() {
  const dir = temporal('fabrica-mcp-repo-');
  git(dir, 'init', '-q');
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  writeFileSync(path.join(dir, 'README.txt'), 'base\n');
  mkdirSync(path.join(dir, '.nexakit'));
  writeFileSync(path.join(dir, '.nexakit', 'fabrica.json'), JSON.stringify({ rutasCriticas: ['src/**'] }));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'trabajo');
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'a.js'), 'export const A = 1;\n');
  return dir;
}

const modeloCodex = (modelo, esfuerzos) => ({
  id: modelo,
  model: modelo,
  hidden: false,
  supportedReasoningEfforts: esfuerzos.map((reasoningEffort) => ({ reasoningEffort, description: '' })),
  defaultReasoningEffort: esfuerzos[0],
});
const catalogoCodex = {
  resultado: { data: [modeloCodex('gpt-6.1-terra', ['medium', 'low']), modeloCodex('gpt-6.1-sol', ['high'])], nextCursor: null },
};

/** Codex falso: catálogo y una revisión de «pruebas» que termina con un hallazgo. */
function guionCodexOk() {
  const revision = leer('codex-revision.json');
  const m = revision.metodos;
  return {
    version: 'codex-cli 0.0.1',
    metodos: {
      initialize: leer('codex-catalogo.json').metodos.initialize,
      'model/list': catalogoCodex,
      'config/read': m['config/read'],
      'mcpServerStatus/list': m['mcpServerStatus/list'],
      'thread/start': m['thread/start'],
      'turn/start': { resultado: m['turn/start'].resultado, notificaciones: revision.alResponder['srv-18'].notificaciones },
    },
  };
}

/** Codex falso que no termina el turno hasta recibir `turn/interrupt`. */
function guionCodexLento() {
  const cancelar = leer('codex-cancelar.json');
  return { ...cancelar, metodos: { ...cancelar.metodos, 'model/list': catalogoCodex } };
}

/** Antigravity falso: catálogo y una revisión de «arquitectura» sin hallazgos. */
function guionAgyOk() {
  const m = leer('acp-catalogo.json').metodos;
  const informe = JSON.stringify({ hallazgos: [], resumen: 'Sin hallazgos.' });
  return {
    metodos: {
      ...m,
      'session/prompt': {
        diferir: true,
        notificaciones: [
          { metodo: 'session/update', params: { sessionId: 'ses-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: informe } } } },
        ],
        responder: [{ metodo: 'session/prompt', resultado: { stopReason: 'end_turn' } }],
      },
    },
  };
}

/** Escenario: HOME temporal, repo y conectores que apuntan a servidores falsos. */
function escenario({ codex = guionCodexOk(), agy = guionAgyOk() } = {}) {
  const dir = crearRepo();
  const home = temporal('fabrica-mcp-home-');
  const guiones = temporal('fabrica-mcp-guiones-');
  const invocacion = (nombre, guion) => {
    const ruta = path.join(guiones, `${nombre}.json`);
    writeFileSync(ruta, JSON.stringify(guion));
    return { ruta, texto: JSON.stringify([process.execPath, SERVIDOR, ruta]) };
  };
  const c = invocacion('codex', codex);
  const a = invocacion('agy', agy);
  return { dir, home, guiones: [c.ruta, a.ruta], env: { NEXAKIT_FABRICA_CODEX: c.texto, NEXAKIT_FABRICA_AGY: a.texto } };
}

/** Cliente MCP real contra `bin/nexakit-fabrica-mcp.js` por stdio, con HOME temporal y cwd en el repo. */
async function conectar(e, { env = {} } = {}) {
  const transporte = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRADA],
    cwd: e.dir,
    env: { ...GIT_ENTORNO, HOME: e.home, USERPROFILE: e.home, ...e.env, ...env },
    stderr: 'pipe',
  });
  transporte.stderr?.resume();
  const cliente = new Client({ name: 'prueba', version: '0.0.0' }, { capabilities: {} });
  clientes.push(cliente);
  await cliente.connect(transporte);
  return { cliente, transporte };
}

const llamar = async (cliente, name, args = {}) => {
  const r = await cliente.callTool({ name, arguments: args });
  return { ...r, texto: r.content?.map((b) => b.text).join('\n') ?? '' };
};
const datos = (r) => JSON.parse(r.texto);
const espera = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

async function hasta(condicion, descripcion) {
  for (let i = 0; i < 400; i++) {
    const valor = await condicion();
    if (valor) return valor;
    await espera(25);
  }
  assert.fail(`no se cumplió a tiempo: ${descripcion}`);
}

const porNombre = (r, nombre) => r.estaciones.find((x) => x.estacion === nombre);

async function proponer(cliente) {
  const r = await llamar(cliente, 'fabrica_proponer', { base: 'main' });
  assert.equal(r.isError, undefined, r.texto);
  return datos(r).recorrido;
}

test('listTools devuelve las cinco herramientas y las instrucciones van en español', async () => {
  const e = escenario();
  const { cliente } = await conectar(e);
  const { tools } = await cliente.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['fabrica_cancelar', 'fabrica_estado', 'fabrica_lanzar', 'fabrica_proponer', 'fabrica_resultado']);
  for (const t of tools) {
    assert.match(t.description, /\S/u, t.name);
    assert.equal(Object.hasOwn(t.inputSchema.properties ?? {}, 'raiz'), false, `${t.name} no acepta una raíz`);
  }
  for (const nombre of ['fabrica_proponer', 'fabrica_lanzar']) {
    assert.match(tools.find((t) => t.name === nombre).description, /directorio de trabajo del servidor/u, nombre);
  }
  assert.equal(cliente.getServerVersion().name, 'nexakit-fabrica');
  const instrucciones = cliente.getInstructions();
  assert.match(instrucciones, /Lánzala tú por tu cuenta[^.]*con la huella de la propuesta; solo hay un recorrido a la vez y no encadenes recorridos para el mismo diff\. Pide aprobación a la persona solo si el recorrido trae órdenes de \.nexakit\/fabrica\.json/u);
  assert.match(instrucciones, /Las estaciones de Claude las lanzas tú como subagentes; pasa sus hallazgos a fabrica_resultado/u);
});

test('fabrica_lanzar con una huella inválida da isError con el mensaje de siempre y no lanza nada', async () => {
  const e = escenario();
  const { cliente } = await conectar(e);
  const sinPropuesta = await llamar(cliente, 'fabrica_lanzar', { huella: 'f'.repeat(64) });
  assert.equal(sinPropuesta.isError, true);
  assert.equal(sinPropuesta.texto, MENSAJE_SIN_PROPUESTA);

  await proponer(cliente);
  const falsa = await llamar(cliente, 'fabrica_lanzar', { huella: 'f'.repeat(64) });
  assert.equal(falsa.isError, true);
  assert.equal(falsa.texto, MENSAJE_SIN_PROPUESTA);
});

test('fabrica_lanzar rechaza una propuesta alterada a mano antes de aplicar cambios', async () => {
  const e = escenario();
  const { cliente } = await conectar(e);
  const propuesta = await proponer(cliente);
  const repo = readdirUnico(path.join(e.home, '.nexakit', 'fabrica'));
  const archivo = path.join(e.home, '.nexakit', 'fabrica', repo, 'propuesta.json');
  const alterada = JSON.parse(readFileSync(archivo, 'utf8'));
  porNombre(alterada, 'pruebas').ordenesPermitidas.push('rm -rf /');
  writeFileSync(archivo, JSON.stringify(alterada));
  const r = await llamar(cliente, 'fabrica_lanzar', { huella: propuesta.huella, cambios: [{ estacion: 'pruebas' }] });
  assert.equal(r.isError, true);
  assert.equal(r.texto, MENSAJE_SIN_PROPUESTA);
});

// Solo las carpetas visibles: activo.json y su temporal de escritura atómica pueden aparecer en cualquier momento.
function readdirUnico(dir) {
  const nombres = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name);
  assert.equal(nombres.length, 1, nombres.join(','));
  return nombres[0];
}

test('proponer, lanzar, estado hasta terminado y resultado devuelve la lista consolidada', async () => {
  const e = escenario();
  const { cliente } = await conectar(e);
  const propuesta = await proponer(cliente);
  assert.match(propuesta.huella, /^[0-9a-f]{64}$/u);
  assert.deepEqual(porNombre(propuesta, 'pruebas').ordenesPermitidas, ['npm test']);

  const lanzado = await llamar(cliente, 'fabrica_lanzar', { huella: propuesta.huella });
  assert.equal(lanzado.isError, undefined, lanzado.texto);
  const { id } = datos(lanzado);
  assert.match(id, /^fab-/u);
  assert.deepEqual(Object.keys(datos(lanzado)), ['id'], 'solo devuelve el id');

  const final = await hasta(async () => {
    const estado = datos(await llamar(cliente, 'fabrica_estado', { id }));
    return estado.fase === 'en-curso' ? null : estado;
  }, 'el recorrido termina');
  assert.equal(final.fase, 'terminado');
  assert.equal(porNombre(final, 'pruebas').estado, 'ok');
  assert.equal(porNombre(final, 'codigo').estado, 'claude');

  const resultado = await llamar(cliente, 'fabrica_resultado', { id });
  assert.equal(resultado.isError, undefined, resultado.texto);
  const cuerpo = datos(resultado);
  assert.equal(cuerpo.hallazgos.length, 1);
  assert.deepEqual(cuerpo.hallazgos[0].estaciones, ['pruebas']);
  assert.ok(existsSync(cuerpo.consolidado));
  assert.equal(path.basename(cuerpo.consolidado), 'consolidado.md');
  assert.match(readFileSync(cuerpo.consolidado, 'utf8'), /Falta una prueba/u);
});

test('fabrica_resultado regenera el consolidado con los hallazgos de Claude y valida su esquema', async () => {
  const e = escenario();
  const { cliente } = await conectar(e);
  const propuesta = await proponer(cliente);
  const { id } = datos(await llamar(cliente, 'fabrica_lanzar', { huella: propuesta.huella }));
  await hasta(async () => datos(await llamar(cliente, 'fabrica_estado', { id })).fase !== 'en-curso', 'el recorrido termina');

  const hallazgoClaude = {
    estacion: 'codigo',
    gravedad: 'alta',
    archivo: 'src/a.js',
    linea: 1,
    categoria: 'correccion',
    hallazgo: 'Constante A sin uso en el flujo principal',
    evidencia: 'export const A = 1;',
    propuesta: 'Usarla o quitarla',
    confianza: 'media',
  };
  const con = await llamar(cliente, 'fabrica_resultado', { id, hallazgosClaude: [hallazgoClaude] });
  assert.equal(con.isError, undefined, con.texto);
  const cuerpo = datos(con);
  assert.equal(cuerpo.hallazgos.length, 2);
  assert.ok(cuerpo.hallazgos.some((h) => h.estaciones.includes('codigo') && h.hallazgo === hallazgoClaude.hallazgo));
  assert.match(readFileSync(cuerpo.consolidado, 'utf8'), /Constante A sin uso/u);

  // Sin hallazgos nuevos se conserva el consolidado ya escrito.
  const sin = datos(await llamar(cliente, 'fabrica_resultado', { id }));
  assert.equal(sin.consolidado, cuerpo.consolidado);
  assert.match(readFileSync(sin.consolidado, 'utf8'), /Constante A sin uso/u);

  // Se guardan en el rastro con permisos privados y se reutilizan sin volver a pasarlos.
  const guardados = path.join(path.dirname(cuerpo.consolidado), 'claude.json');
  assert.deepEqual(JSON.parse(readFileSync(guardados, 'utf8')), [hallazgoClaude]);
  if (process.platform !== 'win32') assert.equal(statSync(guardados).mode & 0o777, 0o600);
  assert.equal(sin.hallazgos.length, 2);
  assert.ok(sin.hallazgos.some((h) => h.estaciones.includes('codigo') && h.hallazgo === hallazgoClaude.hallazgo));

  // Solo se aceptan hallazgos de las estaciones de Claude del recorrido: aquí «pruebas» es de Codex.
  const ajeno = await llamar(cliente, 'fabrica_resultado', { id, hallazgosClaude: [{ ...hallazgoClaude, estacion: 'pruebas' }] });
  assert.equal(ajeno.isError, true);
  assert.match(ajeno.texto, /pruebas/u);
  assert.match(ajeno.texto, /estaciones de Claude/u);
  assert.deepEqual(JSON.parse(readFileSync(guardados, 'utf8')), [hallazgoClaude], 'un rechazo no toca lo guardado');

  const invalido = await llamar(cliente, 'fabrica_resultado', { id, hallazgosClaude: [{ ...hallazgoClaude, gravedad: 'enorme' }] });
  assert.equal(invalido.isError, true);
  const noEstacion = await llamar(cliente, 'fabrica_resultado', { id, hallazgosClaude: [{ ...hallazgoClaude, estacion: 'inventada' }] });
  assert.equal(noEstacion.isError, true);
});

test('fabrica_lanzar aplica los cambios pedidos antes de lanzar', async () => {
  const e = escenario();
  const { cliente } = await conectar(e);
  const propuesta = await proponer(cliente);
  const lanzado = await llamar(cliente, 'fabrica_lanzar', { huella: propuesta.huella, cambios: [{ estacion: 'arquitectura', quitar: true }] });
  assert.equal(lanzado.isError, undefined, lanzado.texto);
  const { id } = datos(lanzado);
  const final = await hasta(async () => {
    const estado = datos(await llamar(cliente, 'fabrica_estado', { id }));
    return estado.fase === 'en-curso' ? null : estado;
  }, 'el recorrido termina');
  assert.equal(porNombre(final, 'arquitectura').estado, 'omitida');
  const guardado = JSON.parse(readFileSync(path.join(final.dir, 'recorrido.json'), 'utf8'));
  assert.notEqual(guardado.huella, propuesta.huella);

  const mal = await llamar(cliente, 'fabrica_lanzar', { huella: propuesta.huella, cambios: [{ estacion: 'pruebas', modelos: 'x' }] });
  assert.equal(mal.isError, true);
});

test('fabrica_resultado con el recorrido en curso da isError, y fabrica_cancelar lo interrumpe', async () => {
  const e = escenario({ codex: guionCodexLento() });
  const { cliente } = await conectar(e);
  const propuesta = await proponer(cliente);
  const { id } = datos(await llamar(cliente, 'fabrica_lanzar', { huella: propuesta.huella }));
  await hasta(async () => porNombre(datos(await llamar(cliente, 'fabrica_estado', { id })), 'pruebas').estado === 'en-curso', 'la estación empieza');

  const enCurso = await llamar(cliente, 'fabrica_resultado', { id });
  assert.equal(enCurso.isError, true);
  assert.match(enCurso.texto, /El recorrido sigue en curso/u);

  const cancelado = await llamar(cliente, 'fabrica_cancelar', { id });
  assert.equal(cancelado.isError, undefined, cancelado.texto);
  assert.match(cancelado.texto, /cancelado/u);
  assert.equal(datos(await llamar(cliente, 'fabrica_estado', { id })).fase, 'cancelado');

  const otra = await llamar(cliente, 'fabrica_cancelar', { id });
  assert.match(otra.texto, /ya había terminado|cancelado/u);
  const inexistente = await llamar(cliente, 'fabrica_estado', { id: 'fab-20260101-0000-abcd' });
  assert.equal(inexistente.isError, true);
  assert.match(inexistente.texto, /No hay ningún recorrido/u);
});

/** Procesos del sistema cuya línea de órdenes menciona alguno de los guiones: los servidores falsos vivos. */
function conectoresVivos(guiones) {
  const procesos = execFileSync('ps', ['-A', '-o', 'command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return procesos.split('\n').filter((linea) => guiones.some((g) => linea.includes(g)));
}

const posix = process.platform !== 'win32';

for (const cierre of ['SIGTERM', 'stdin']) {
  test(`al cerrarse el servidor (${cierre}) cancela los recorridos en curso y cierra los conectores`, { skip: !posix }, async () => {
    const e = escenario({ codex: guionCodexLento() });
    const { cliente, transporte } = await conectar(e);
    const propuesta = await proponer(cliente);
    const { id } = datos(await llamar(cliente, 'fabrica_lanzar', { huella: propuesta.huella }));
    await hasta(async () => porNombre(datos(await llamar(cliente, 'fabrica_estado', { id })), 'pruebas').estado === 'en-curso', 'la estación empieza');
    const pid = transporte.pid;
    assert.ok(pid, 'el servidor tiene pid');
    assert.ok(conectoresVivos(e.guiones).length > 0, 'hay un conector vivo mientras corre el recorrido');

    const salida = new Promise((resolver) => transporte.onclose = resolver);
    const inicio = Date.now();
    if (cierre === 'SIGTERM') process.kill(pid, 'SIGTERM');
    else await cliente.close();
    await salida;
    await hasta(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 'el servidor termina');
    // El cliente MCP envía SIGTERM a los 2 s si el servidor sigue vivo: salir antes prueba que bastó cerrar stdin.
    if (cierre === 'stdin') assert.ok(Date.now() - inicio < 2000, `el servidor tardó ${Date.now() - inicio} ms en salir al cerrar stdin`);

    const dir = path.join(e.home, '.nexakit', 'fabrica', readdirUnico(path.join(e.home, '.nexakit', 'fabrica')), id);
    const estado = JSON.parse(readFileSync(path.join(dir, 'estado.json'), 'utf8'));
    assert.equal(estado.fase, 'cancelado');
    assert.equal(porNombre(estado, 'pruebas').estado, 'cancelada');
    await hasta(() => conectoresVivos(e.guiones).length === 0, 'los conectores se cierran');
  });
}

test('el servidor cierra los conectores cuando termina cada recorrido', { skip: !posix }, async () => {
  const e = escenario();
  const { cliente } = await conectar(e);
  const propuesta = await proponer(cliente);
  const { id } = datos(await llamar(cliente, 'fabrica_lanzar', { huella: propuesta.huella }));
  await hasta(async () => datos(await llamar(cliente, 'fabrica_estado', { id })).fase !== 'en-curso', 'el recorrido termina');
  await hasta(() => conectoresVivos(e.guiones).length === 0, 'los conectores se cierran sin esperar al cierre del servidor');
});

test('una variable NEXAKIT_FABRICA_* mal formada da un error claro en la propuesta', async () => {
  const e = escenario();
  const { cliente } = await conectar(e, { env: { NEXAKIT_FABRICA_CODEX: '[1, 2' } });
  const r = await llamar(cliente, 'fabrica_proponer', { base: 'main' });
  assert.equal(r.isError, true);
  assert.match(r.texto, /NEXAKIT_FABRICA_CODEX no es un JSON válido/u);
});

test('el instalador registra nexakit-fabrica, no el MCP antiguo', () => {
  const nodo = '/usr/bin/node';
  const entrada = '/h/.nexakit/actual/bin/nexakit-fabrica-mcp.js';
  const claude = registrationCommand('claude', { state: 'falta' }, nodo, entrada);
  assert.ok(claude.includes('claude mcp add --scope user --transport stdio nexakit-fabrica'), claude);
  assert.ok(!claude.includes('agent-toolkit-workflow'));
  const codex = registrationCommand('codex', { state: 'falta' }, nodo, entrada);
  assert.ok(codex.includes('codex mcp add nexakit-fabrica'), codex);
  // Reparar quita la entrada que haya hoy, con el nombre que tenga, y añade la nueva.
  assert.match(registrationCommand('claude', { state: 'efimero', name: 'agent-toolkit-workflow' }, nodo, entrada), /^claude mcp remove agent-toolkit-workflow -s user && claude mcp add .* nexakit-fabrica /u);
});

test('solo hay un recorrido a la vez: dos fabrica_lanzar simultáneos no lanzan dos', async () => {
  const e = escenario({ codex: guionCodexLento() });
  const { cliente } = await conectar(e);
  const propuesta = await proponer(cliente);
  const [a, b] = await Promise.all([
    llamar(cliente, 'fabrica_lanzar', { huella: propuesta.huella }),
    llamar(cliente, 'fabrica_lanzar', { huella: propuesta.huella }),
  ]);
  const aceptadas = [a, b].filter((r) => !r.isError);
  const rechazadas = [a, b].filter((r) => r.isError);
  assert.equal(aceptadas.length, 1, `${a.texto} | ${b.texto}`);
  assert.equal(rechazadas.length, 1);
  assert.equal(rechazadas[0].texto, 'Ya hay un recorrido en curso; espera a que termine o cancélalo');
  const { id } = datos(aceptadas[0]);
  const base = path.join(e.home, '.nexakit', 'fabrica', readdirUnico(path.join(e.home, '.nexakit', 'fabrica')));
  assert.equal(readdirSync(base).filter((n) => n.startsWith('fab-')).length, 1, 'solo se creó un rastro');

  // Con uno en curso sigue rechazando, aunque pase tiempo; al cancelarlo se libera.
  const otra = await llamar(cliente, 'fabrica_lanzar', { huella: propuesta.huella });
  assert.equal(otra.isError, true);
  assert.equal((await llamar(cliente, 'fabrica_cancelar', { id })).isError, undefined);
  const nuevo = await hasta(async () => {
    const r = await llamar(cliente, 'fabrica_lanzar', { huella: propuesta.huella });
    return r.isError ? null : r;
  }, 'tras terminar se puede lanzar otro');
  assert.equal((await llamar(cliente, 'fabrica_cancelar', { id: datos(nuevo).id })).isError, undefined);
});

test('si el servidor se cierra mientras se lanza, el recorrido nuevo se cancela y no queda ningún conector', { skip: !posix }, async () => {
  const e = escenario({ codex: guionCodexLento() });
  const servidor = crearServidorFabrica({ homeDirectory: e.home, cwd: e.dir, environment: { ...process.env, ...GIT_ENTORNO, ...e.env }, avisar: () => {} });
  const [extremoCliente, extremoServidor] = InMemoryTransport.createLinkedPair();
  await servidor.server.connect(extremoServidor);
  const cliente = new Client({ name: 'prueba', version: '0.0.0' }, { capabilities: {} });
  clientes.push(cliente);
  await cliente.connect(extremoCliente);

  const propuesta = await proponer(cliente);
  await hasta(() => conectoresVivos(e.guiones).length === 0, 'los conectores de la propuesta se cierran');
  const pendiente = llamar(cliente, 'fabrica_lanzar', { huella: propuesta.huella });
  // El conector ya existe: el lanzamiento está a medias cuando el servidor se cierra.
  await hasta(() => conectoresVivos(e.guiones).length > 0, 'el lanzamiento crea sus conectores');
  await servidor.detener();

  const respuesta = await pendiente;
  const base = path.join(e.home, '.nexakit', 'fabrica', readdirUnico(path.join(e.home, '.nexakit', 'fabrica')));
  const rastros = readdirSync(base).filter((n) => n.startsWith('fab-'));
  for (const id of rastros) {
    const estado = JSON.parse(readFileSync(path.join(base, id, 'estado.json'), 'utf8'));
    assert.equal(estado.fase, 'cancelado', `${id}: ${respuesta.texto}`);
  }
  if (rastros.length === 0) assert.equal(respuesta.isError, true);
  await hasta(() => conectoresVivos(e.guiones).length === 0, 'no queda ningún conector');
  const otra = await llamar(cliente, 'fabrica_lanzar', { huella: propuesta.huella });
  assert.equal(otra.isError, true);
  assert.match(otra.texto, /cerrando/u);
});

test('una segunda llamada rechazada por ocupada no impide que el cierre espere al lanzamiento a medias', { skip: !posix }, async () => {
  const e = escenario({ codex: guionCodexLento() });
  const servidor = crearServidorFabrica({ homeDirectory: e.home, cwd: e.dir, environment: { ...process.env, ...GIT_ENTORNO, ...e.env }, avisar: () => {} });
  const [extremoCliente, extremoServidor] = InMemoryTransport.createLinkedPair();
  await servidor.server.connect(extremoServidor);
  const cliente = new Client({ name: 'prueba', version: '0.0.0' }, { capabilities: {} });
  clientes.push(cliente);
  await cliente.connect(extremoCliente);

  const propuesta = await proponer(cliente);
  await hasta(() => conectoresVivos(e.guiones).length === 0, 'los conectores de la propuesta se cierran');
  const a = llamar(cliente, 'fabrica_lanzar', { huella: propuesta.huella });
  await hasta(() => conectoresVivos(e.guiones).length > 0, 'A crea sus conectores');
  const b = await llamar(cliente, 'fabrica_lanzar', { huella: propuesta.huella });
  assert.equal(b.isError, true);
  assert.equal(b.texto, 'Ya hay un recorrido en curso; espera a que termine o cancélalo');
  await servidor.detener();

  // Nada de esperar a la respuesta de A: al volver `detener()` el cierre ya tiene que haberlo cancelado todo,
  // porque un proceso que sale ahí no tiene quien termine el trabajo.
  const base = path.join(e.home, '.nexakit', 'fabrica', readdirUnico(path.join(e.home, '.nexakit', 'fabrica')));
  const rastros = readdirSync(base).filter((n) => n.startsWith('fab-'));
  assert.equal(rastros.length, 1, 'A ya creó su rastro');
  const estado = JSON.parse(readFileSync(path.join(base, rastros[0], 'estado.json'), 'utf8'));
  assert.equal(estado.fase, 'cancelado');
  assert.equal(conectoresVivos(e.guiones).length, 0, 'no queda ningún conector al volver detener()');
  assert.equal((await a).isError, true);
});
