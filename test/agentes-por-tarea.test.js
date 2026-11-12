import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { test } from 'node:test';

// Subagentes por tarea del plugin niveles: se dividen por trabajo, no por dificultad.
const ESPECIALISTAS = ['investigador', 'revisor-de-calidad', 'cierre-de-memoria', 'subir-al-repo'];

async function agente(nombre) {
  const texto = await fs.readFile(new URL(`../plugins/niveles/agents/${nombre}.md`, import.meta.url), 'utf8');
  const [, cabecera, cuerpo] = texto.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/u) ?? [];
  assert.ok(cabecera, `${nombre} necesita cabecera`);
  const campos = Object.fromEntries(cabecera.split('\n').map((linea) => {
    const i = linea.indexOf(':');
    return [linea.slice(0, i).trim(), linea.slice(i + 1).trim()];
  }));
  const herramientas = (campos.tools ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  return { campos, herramientas, cuerpo, texto };
}

const palabras = (texto) => texto.trim().split(/\s+/u).length;

test('los cuatro especialistas existen, se llaman como su archivo y fijan modelo, esfuerzo y tope de pasos', async () => {
  for (const nombre of ESPECIALISTAS) {
    const { campos } = await agente(nombre);
    assert.equal(campos.name, nombre);
    assert.ok(campos.description.length > 30, `${nombre} dice cuándo usarlo`);
    assert.equal(campos.model, 'sonnet', `${nombre} no necesita Opus`);
    assert.match(campos.effort, /^(medium|high)$/u);
    assert.ok(Number(campos.maxTurns) > 0 && Number(campos.maxTurns) <= 40, `${nombre} lleva un tope de pasos de hasta 40`);
  }
});

test('el investigador solo lee y busca, con tope de 25 pasos, y separa lo verificado de lo que no', async () => {
  const { campos, herramientas, cuerpo } = await agente('investigador');
  assert.equal(Number(campos.maxTurns), 25);
  for (const h of ['WebSearch', 'WebFetch', 'Read', 'Grep']) assert.ok(herramientas.includes(h), `usa ${h}`);
  for (const h of ['Edit', 'Write', 'NotebookEdit']) assert.equal(herramientas.includes(h), false, `no puede ${h}`);
  assert.match(cuerpo, /fuentes? oficiales?/iu);
  assert.match(cuerpo, /no verificado/iu);
  assert.match(cuerpo, /300 palabras/u);
  assert.match(cuerpo, /tope|llegas al límite|se acaban los pasos/iu, 'dice qué hacer al agotar los pasos');
  assert.match(cuerpo, /comillas/u, 'avisa de la trampa de zsh con los separadores');
});

test('el revisor de calidad no edita, aplica quality-gate y da uno de los cuatro resultados', async () => {
  const { campos, herramientas, cuerpo } = await agente('revisor-de-calidad');
  assert.equal(campos.effort, 'high');
  for (const h of ['Edit', 'Write', 'NotebookEdit']) assert.equal(herramientas.includes(h), false, `no puede ${h}`);
  assert.ok(herramientas.includes('Bash') && herramientas.includes('Skill'));
  assert.match(cuerpo, /quality-gate/u);
  for (const resultado of ['Aprobado', 'Aprobado con observaciones', 'Requiere cambios', 'Sin evidencia suficiente']) {
    assert.ok(cuerpo.includes(resultado), `incluye el resultado ${resultado}`);
  }
  assert.match(cuerpo, /no hagas commit/iu);
  assert.match(cuerpo, /el resumen de otro agente/iu, 'no da por probado lo que otro agente declara');
});

test('el cierre de memoria usa la skill, registra de uno en uno y no hace commit por su cuenta', async () => {
  const { herramientas, cuerpo } = await agente('cierre-de-memoria');
  assert.ok(herramientas.includes('Edit') && herramientas.includes('Skill'));
  assert.match(cuerpo, /cerrar-memoria/u);
  assert.match(cuerpo, /uno a uno|de uno en uno/iu);
  assert.match(cuerpo, /no hagas push/iu, 'nunca sube la bóveda por su cuenta');
  assert.match(cuerpo, /commit local[^.]*solo si el encargo/iu, 'solo hace commit local si el encargo lo autoriza');
  assert.match(cuerpo, /fila (a mano|manual)/iu, 'no sustituye el registro por una fila manual');
  assert.match(cuerpo, /no (cambies|toques) (el )?c[oó]digo/iu);
});

test('subir al repo solo actúa con la autorización escrita, se detiene ante fallos y fusiona', async () => {
  const { campos, herramientas, cuerpo } = await agente('subir-al-repo');
  assert.equal(Number(campos.maxTurns), 40);
  assert.deepEqual([...herramientas].sort(), ['Bash', 'Glob', 'Grep', 'Read']);
  assert.match(cuerpo, /sube al repo/iu);
  assert.match(cuerpo, /si (el encargo )?no (dice|incluye|trae)[^.]*(autoriza|sube al repo)[^.]*(detente|para|no hagas nada)/iu, 'sin autorización escrita no hace nada');
  assert.match(cuerpo, /gh pr merge <n> --merge/u);
  assert.match(cuerpo, /gh pr checks/u);
  assert.match(cuerpo, /nunca fuerces el push|no fuerces el push/iu);
  assert.match(cuerpo, /co-authored-by/iu, 'recuerda la regla de commits del usuario');
  assert.match(cuerpo, /solo los archivos/iu, 'añade solo los archivos del cambio');
  assert.match(cuerpo, /una sola vez/iu, 'solo relanza una vez un fallo claramente ajeno');
  assert.match(cuerpo, /la sesión principal (verificar[aá]|comprobar[aá])/iu, 'deja la verificación final a la sesión principal');
});

test('ningún especialista contradice las reglas de los niveles: respuestas breves y sin pedir confirmación inútil', async () => {
  for (const nombre of ESPECIALISTAS) {
    const { cuerpo } = await agente(nombre);
    assert.ok(palabras(cuerpo) < 500, `${nombre} es corto (${palabras(cuerpo)} palabras)`);
    assert.match(cuerpo, /respuest|informe/iu, `${nombre} dice cómo informar`);
  }
});

test('el plugin niveles anuncia a los especialistas y sube su versión', async () => {
  const manifiesto = JSON.parse(await fs.readFile(new URL('../plugins/niveles/.claude-plugin/plugin.json', import.meta.url), 'utf8'));
  assert.match(manifiesto.description, /especialistas/iu);
  assert.equal(manifiesto.version, '0.3.0');
});
