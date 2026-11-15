import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ErrorFabrica } from '../dist/fabrica/errores.js';
import {
  aceptar,
  cortarEnPalabra,
  efectividad,
  guardarPropuestas,
  idLeccion,
  listar,
  proponerPorRepeticion,
  registrar,
  retirar,
  vigentes,
} from '../dist/fabrica/lecciones.js';
import { runLeccionesCommand } from '../src/lecciones-command.js';
import { fileSymlinkSkipReason } from '../testing/symlink-capability.js';

const SIN_ENLACES = process.platform === 'win32' || fileSymlinkSkipReason();
const DIA = 24 * 60 * 60 * 1000;
const AHORA = 1_700_000_000_000;

const temporal = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'fab-lecciones-')));
const carpeta = (home) => path.join(home, '.nexakit', 'lecciones');
const modo = (ruta) => statSync(ruta).mode & 0o777;
const archivos = (home) => readdirSync(carpeta(home)).sort();
const persona = (regla, extra = {}) => ({ regla, porque: 'porque sí', origen: 'persona', ...extra });

test('registrar una lección de la persona la deja vigente, con carpeta 0o700 y archivo 0o600', async () => {
  const home = temporal();
  const { leccion, nueva } = await registrar(home, persona('Responde siempre en español'), AHORA);
  assert.equal(nueva, true);
  assert.match(leccion.id, /^[0-9a-f]{8}$/u);
  assert.equal(leccion.estado, 'vigente');
  assert.equal(leccion.origen, 'persona');
  assert.equal(leccion.ambito, 'global');
  assert.equal(leccion.fecha, AHORA);
  assert.equal(leccion.usos, 0);
  assert.equal(modo(carpeta(home)), 0o700);
  assert.deepEqual(archivos(home), [`${leccion.id}.json`]);
  assert.equal(modo(path.join(carpeta(home), `${leccion.id}.json`)), 0o600);
  assert.deepEqual(JSON.parse(readFileSync(path.join(carpeta(home), `${leccion.id}.json`), 'utf8')), leccion);
  assert.deepEqual(await listar(home), [leccion]);
});

test('las lecciones de la fábrica y del proceso nacen como propuesta', async () => {
  const home = temporal();
  const a = await registrar(home, { regla: 'a', porque: 'p', origen: 'fabrica' }, AHORA);
  const b = await registrar(home, { regla: 'b', porque: 'p', origen: 'proceso' }, AHORA);
  assert.equal(a.leccion.estado, 'propuesta');
  assert.equal(b.leccion.estado, 'propuesta');
  assert.deepEqual(await vigentes(home), []);
});

test('registrar la misma regla dos veces no duplica: actualiza la fecha', async () => {
  const home = temporal();
  const primera = await registrar(home, persona('Nunca borres  ramas sin avisar'), AHORA);
  const segunda = await registrar(home, persona('  nunca BORRES ramas sin avisar '), AHORA + DIA);
  assert.equal(segunda.nueva, false);
  assert.equal(segunda.leccion.id, primera.leccion.id, 'el id no depende de mayúsculas ni espacios');
  assert.equal(segunda.leccion.fecha, AHORA + DIA);
  assert.equal(archivos(home).length, 1);
  assert.equal(idLeccion('x', 'global') === idLeccion('x', { proyecto: '/p' }), false, 'otro ámbito, otro id');
});

test('una regla de más de 300 caracteres se rechaza y no escribe nada; el tope exacto se admite', async () => {
  const home = temporal();
  await assert.rejects(registrar(home, persona('x'.repeat(301))), (e) => e instanceof ErrorFabrica && /demasiado larga.*301.*300/u.test(e.message));
  await assert.rejects(registrar(home, persona('   ')), /Falta la regla/u);
  await assert.rejects(registrar(home, { regla: 'a', porque: '', origen: 'persona' }), /Falta el porqué/u);
  await assert.rejects(registrar(home, { regla: 'a', porque: 'p', origen: 'otro' }), /Origen/u);
  assert.deepEqual(await listar(home), []);
  const { leccion } = await registrar(home, persona('x'.repeat(300)));
  assert.equal(leccion.regla.length, 300);
});

test('aceptar pasa una propuesta a vigente y retirar la deja retirada; ambos conservan el archivo 0o600', async () => {
  const home = temporal();
  const { leccion } = await registrar(home, { regla: 'regla', porque: 'p', origen: 'proceso' }, AHORA);
  const aceptada = await aceptar(home, leccion.id, AHORA + 5 * DIA);
  assert.equal(aceptada.estado, 'vigente');
  assert.equal(aceptada.fecha, AHORA + 5 * DIA, 'la fecha pasa a ser la de la aceptación');
  assert.equal((await aceptar(home, leccion.id, AHORA + 6 * DIA)).fecha, AHORA + 5 * DIA, 'aceptar una vigente no cambia nada');
  assert.deepEqual((await vigentes(home)).map((l) => l.id), [leccion.id]);
  const retirada = await retirar(home, leccion.id, AHORA + 7 * DIA);
  assert.equal(retirada.estado, 'retirada');
  assert.deepEqual(await vigentes(home), []);
  assert.equal((await listar(home))[0].estado, 'retirada', 'se conserva en el almacén');
  assert.equal(modo(path.join(carpeta(home), `${leccion.id}.json`)), 0o600);
  await assert.rejects(aceptar(home, leccion.id), /retirada/u);
});

test('retirar una propuesta la descarta; ids inexistentes o con forma de ruta se rechazan', async () => {
  const home = temporal();
  const { leccion } = await registrar(home, { regla: 'regla', porque: 'p', origen: 'fabrica' });
  assert.equal((await retirar(home, leccion.id)).estado, 'retirada');
  await assert.rejects(aceptar(home, 'abcdef12'), /No existe la lección abcdef12/u);
  for (const id of ['../x', '..', 'ABCDEF12', 'abc']) await assert.rejects(retirar(home, id), /Id de lección no válido/u);
});

test('vigentes con filtro devuelve las globales, las del proyecto y las de la estación pedida', async () => {
  const home = temporal();
  const proyecto = temporal();
  const otro = temporal();
  const g = (await registrar(home, persona('global'), AHORA)).leccion;
  const p = (await registrar(home, persona('de proyecto', { ambito: { proyecto } }), AHORA + 1)).leccion;
  const e = (await registrar(home, persona('de estación', { ambito: { proyecto, estacion: 'seguridad' } }), AHORA + 2)).leccion;
  const o = (await registrar(home, persona('de otro', { ambito: { proyecto: otro } }), AHORA + 3)).leccion;
  await registrar(home, { regla: 'propuesta', porque: 'p', origen: 'proceso' });
  const ids = async (filtro) => (await vigentes(home, filtro)).map((l) => l.id).sort();
  assert.deepEqual(await ids(), [g.id, p.id, e.id, o.id].sort(), 'sin filtro, todas las vigentes');
  assert.deepEqual(await ids({}), [g.id]);
  assert.deepEqual(await ids({ proyecto }), [g.id, p.id].sort());
  assert.deepEqual(await ids({ proyecto, estacion: 'seguridad' }), [g.id, p.id, e.id].sort());
  assert.deepEqual(await ids({ proyecto, estacion: 'pruebas' }), [g.id, p.id].sort());
  assert.deepEqual(await ids({ proyecto: otro }), [g.id, o.id].sort());
});

test('el proyecto se guarda como ruta real normalizada y debe existir', async () => {
  const home = temporal();
  const proyecto = temporal();
  const ruta = path.join(proyecto, 'sub');
  mkdirSync(ruta);
  const rara = `${ruta}${path.sep}..${path.sep}sub${path.sep}`;
  const { leccion } = await registrar(home, persona('con ruta', { ambito: { proyecto: rara } }));
  assert.deepEqual(leccion.ambito, { proyecto: ruta });
  assert.equal((await registrar(home, persona('con ruta', { ambito: { proyecto: ruta } }))).nueva, false, 'misma ruta, misma lección');
  await assert.rejects(registrar(home, persona('x', { ambito: { proyecto: path.join(proyecto, 'no-existe') } })), /no existe/u);
  await assert.rejects(registrar(home, persona('y', { ambito: { proyecto: ruta, estacion: 'inventada' } })), /Ámbito/u);
});

test('un archivo roto o ajeno en el almacén se ignora', async () => {
  const home = temporal();
  const { leccion } = await registrar(home, persona('buena'));
  writeFileSync(path.join(carpeta(home), 'aaaaaaaa.json'), 'no es json');
  writeFileSync(path.join(carpeta(home), 'bbbbbbbb.json'), JSON.stringify({ ...leccion, id: 'cccccccc' }));
  writeFileSync(path.join(carpeta(home), 'notas.txt'), 'hola');
  assert.deepEqual((await listar(home)).map((l) => l.id), [leccion.id]);
});

test('no sigue enlaces: ni la carpeta del almacén ni los archivos de lección', { skip: SIN_ENLACES }, async () => {
  const fuera = temporal();
  const home = temporal();
  mkdirSync(path.join(home, '.nexakit'));
  symlinkSync(fuera, carpeta(home));
  await assert.rejects(registrar(home, persona('x')), /no sigue enlaces/u);
  assert.deepEqual(readdirSync(fuera), [], 'no escribió en el destino del enlace');
  assert.deepEqual(await listar(home), [], 'tampoco lo lee');

  const home2 = temporal();
  const { leccion } = await registrar(home2, persona('real'));
  const secreto = path.join(fuera, 'secreto.json');
  writeFileSync(secreto, readFileSync(path.join(carpeta(home2), `${leccion.id}.json`)));
  const falso = path.join(carpeta(home2), 'dddddddd.json');
  symlinkSync(secreto, falso);
  assert.deepEqual((await listar(home2)).map((l) => l.id), [leccion.id], 'un enlace no se lee como lección');
  // Una lección cuyo archivo es un enlace se reemplaza por uno real sin escribir en el destino.
  const id = idLeccion('victima', 'global');
  const enlace = path.join(carpeta(home2), `${id}.json`);
  symlinkSync(secreto, enlace);
  const antes = readFileSync(secreto, 'utf8');
  await registrar(home2, persona('victima'));
  assert.equal(readFileSync(secreto, 'utf8'), antes, 'el destino del enlace queda intacto');
  assert.equal(modo(enlace), 0o600);
});

const SUCIO = '\u001b\u0000\u202e\u200b\u2028\u2029\u007f';
const hayInvisibles = (t) => /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(t);

test('regla y porqué se limpian de caracteres de control, de formato y separadores de línea', async () => {
  const home = temporal();
  const { leccion } = await registrar(home, {
    regla: `Usa\u001b[31m  siempre\u0000 espa\u202eñol\u200b${'\u2028'}hoy`,
    porque: `por\u2029qué\u007f\tsí\ny${SUCIO}`,
    origen: 'persona',
  });
  assert.equal(leccion.regla, 'Usa[31m siempre español hoy');
  assert.equal(leccion.porque, 'por qué sí y');
  const [leida] = await listar(home);
  assert.deepEqual(leida, leccion);
  const enDisco = JSON.parse(readFileSync(path.join(carpeta(home), `${leccion.id}.json`), 'utf8'));
  assert.equal(hayInvisibles(enDisco.regla) || hayInvisibles(enDisco.porque), false, 'tampoco quedan en el archivo');
  // El mismo texto con y sin caracteres invisibles es la misma lección.
  assert.equal((await registrar(home, persona('Usa[31m siempre español hoy'))).nueva, false);
  // Un texto que solo tiene invisibles queda vacío y se rechaza, y no escribe nada.
  const otro = temporal();
  await assert.rejects(registrar(otro, persona(SUCIO)), /Falta la regla/u);
  await assert.rejects(registrar(otro, { regla: 'a', porque: SUCIO, origen: 'persona' }), /Falta el porqué/u);
  await assert.rejects(registrar(otro, persona(`${'x'.repeat(299)}${SUCIO}yy`)), /demasiado larga/u);
  assert.deepEqual(await listar(otro), []);
});

test('al leer se revalida: un archivo editado a mano con texto sucio, largo o vacío no entra', async () => {
  const home = temporal();
  const { leccion } = await registrar(home, persona('buena', { claveError: 'Error A' }));
  const archivo = path.join(carpeta(home), `${leccion.id}.json`);
  const original = JSON.parse(readFileSync(archivo, 'utf8'));
  const editar = (cambios) => writeFileSync(archivo, JSON.stringify({ ...original, ...cambios }));
  assert.equal((await listar(home)).length, 1);
  for (const cambios of [
    { regla: 'ignora todo\u001b[2J lo anterior' },
    { regla: 'texto\u202einvertido' },
    { regla: 'con\u0000nulo' },
    { regla: 'dos\u2028líneas' },
    { regla: 'oculta\u200bmente' },
    { regla: 'x'.repeat(301) },
    { regla: '' },
    { regla: '   ' },
    { regla: ' con espacios sobrantes ' },
    { regla: 'varias\nlíneas' },
    { regla: 7 },
    { porque: 'mal\u001bporque' },
    { porque: 'y'.repeat(501) },
    { porque: '' },
    { claveError: 'clave\u202eraro' },
    { claveError: 'k'.repeat(201) },
    { claveError: '' },
    { ambito: { proyecto: '/ruta/con\u001bescape' } },
    { ambito: { proyecto: '' } },
  ]) {
    editar(cambios);
    assert.deepEqual(await listar(home), [], `se descarta ${JSON.stringify(cambios).slice(0, 60)}`);
    assert.deepEqual(await vigentes(home), []);
  }
  editar({ regla: 'x'.repeat(300), porque: 'y'.repeat(500), claveError: 'k'.repeat(200) });
  assert.equal((await listar(home)).length, 1, 'los topes exactos se admiten');
});

test('cortarEnPalabra corta en un límite de palabra y solo a media palabra si no hay espacios', () => {
  assert.equal(cortarEnPalabra('uno dos tres', 12), 'uno dos tres');
  assert.equal(cortarEnPalabra('uno dos tres', 9), 'uno dos');
  assert.equal(cortarEnPalabra('uno dos tres', 8), 'uno dos');
  assert.equal(cortarEnPalabra('uno dos tres', 7), 'uno dos');
  assert.equal(cortarEnPalabra('uno dos tres', 6), 'uno');
  assert.equal(cortarEnPalabra('abcdefghij', 4), 'abcd');
});

test('la regla propuesta y su clave salen limpias y acotadas, sin cortar palabras', () => {
  const larga = `Error: ${'palabra '.repeat(80)}fin`;
  const [p, q] = proponerPorRepeticion([rep(AHORA, larga), rep(AHORA, `Error\u001b[31m \u202ede\u0000 ${SUCIO}red`)]);
  assert.ok(p.claveError.length <= 200 && !p.claveError.endsWith(' '));
  assert.match(p.claveError, /^Error: (palabra )*palabra$/u, 'la clave termina en palabra entera');
  assert.ok(p.regla.length <= 300 && p.regla.includes(p.claveError));
  assert.equal(hayInvisibles(q.claveError) || hayInvisibles(q.regla), false);
  assert.equal(q.claveError, 'Error[31m de red');
  // Dos formas sucias de la misma clave cuentan como una.
  assert.deepEqual(proponerPorRepeticion([rep(AHORA, 'Error X'), rep(AHORA, 'Error\u200b X')]).map((x) => x.veces), [2]);
  // Una clave que solo tiene invisibles no propone nada.
  assert.deepEqual(proponerPorRepeticion([rep(AHORA, SUCIO)]), []);
});

const rep = (fecha, clave) => ({ fecha, tipo: 'repeticion', ...(clave === undefined ? {} : { clave }) });

test('proponerPorRepeticion propone una vez por clave de error repetido y salta lo que no tiene clave', () => {
  const eventos = [
    rep(AHORA, 'Error: Cannot find module <…>'),
    rep(AHORA + 1, 'Error: Cannot find module <…>'),
    rep(AHORA + 2, 'npm ERR! code E#'),
    rep(AHORA + 3),
    rep(AHORA + 4, '(texto omitido: parecía contener un dato sensible)'),
    { fecha: AHORA, tipo: 'freno', clave: 'no cuenta' },
  ];
  const propuestas = proponerPorRepeticion(eventos);
  assert.deepEqual(propuestas.map((p) => [p.claveError, p.veces]), [['Error: Cannot find module <…>', 2], ['npm ERR! code E#', 1]]);
  for (const p of propuestas) assert.ok(p.regla.length <= 300 && p.regla.includes(p.claveError));
  assert.deepEqual(proponerPorRepeticion([]), []);
});

test('guardarPropuestas crea propuestas nuevas y no toca las existentes, ni siquiera las retiradas', async () => {
  const home = temporal();
  const propuestas = proponerPorRepeticion([rep(AHORA, 'Error A'), rep(AHORA, 'Error B')]);
  const nuevas = await guardarPropuestas(home, propuestas, AHORA);
  assert.deepEqual(nuevas.map((l) => [l.estado, l.origen, l.claveError]), [['propuesta', 'proceso', 'Error A'], ['propuesta', 'proceso', 'Error B']]);
  const [a] = nuevas;
  await retirar(home, a.id, AHORA + DIA);
  assert.deepEqual(await guardarPropuestas(home, propuestas, AHORA + 2 * DIA), [], 'no duplica ni resucita');
  assert.equal((await listar(home)).find((l) => l.id === a.id).estado, 'retirada');
  assert.deepEqual(await guardarPropuestas(temporal(), [], AHORA), []);
});

test('efectividad cuenta las repeticiones antes y después de la fecha, en ventanas iguales', async () => {
  const home = temporal();
  const { leccion } = await registrar(home, { regla: 'r', porque: 'p', origen: 'proceso', claveError: 'Error A' }, AHORA);
  const vigente = await aceptar(home, leccion.id, AHORA);
  const ahora = AHORA + 10 * DIA;
  const eventos = [
    rep(AHORA - 3 * DIA, 'Error A'),
    rep(AHORA - 2 * DIA, 'Error A'),
    rep(AHORA - 1 * DIA, 'Error A'),
    rep(AHORA - 11 * DIA, 'Error A'), // fuera de la ventana previa de 10 días
    rep(AHORA - 1 * DIA, 'Error B'),
    rep(AHORA + 2 * DIA, 'Error A'),
  ];
  assert.deepEqual(efectividad(vigente, eventos, ahora), { antes: 3, despues: 1 });
  assert.equal(efectividad(vigente, eventos.slice(3, 4), ahora), null, 'sin repeticiones antes no hay nada que reducir');
  assert.equal(efectividad({ ...vigente, claveError: undefined }, eventos, ahora), null, 'sin clave de error no hay datos');
});

// --- La orden `nexakit lecciones` ---

async function orden(home, argv) {
  let salida = '';
  let error = '';
  const code = await runLeccionesCommand(argv, { out: (m) => { salida += m; }, err: (m) => { error += m; } }, { homeDirectory: home, now: AHORA });
  return { code, salida, error };
}

const idDe = (salida) => /([0-9a-f]{8}) ·/u.exec(salida)?.[1];

test('registrar, aceptar y retirar desde la orden', async () => {
  const home = temporal();
  const proyecto = temporal();
  let r = await orden(home, ['registrar', '--regla', 'Pregunta una sola vez', '--porque', 'La persona se cansa', '--proyecto', proyecto, '--estacion', 'pruebas']);
  assert.equal(r.code, 0, r.error);
  assert.match(r.salida, /Lección registrada \(vigente\)/u);
  const id = idDe(r.salida);
  const [guardada] = await listar(home);
  assert.deepEqual(guardada.ambito, { proyecto, estacion: 'pruebas' });
  assert.equal(guardada.origen, 'persona');

  r = await orden(home, ['registrar', '--regla', 'pregunta una sola vez', '--porque', 'otra vez', '--proyecto', proyecto, '--estacion', 'pruebas']);
  assert.match(r.salida, /ya existía/u);
  assert.equal(archivos(home).length, 1);

  r = await orden(home, ['retirar', id]);
  assert.equal(r.code, 0, r.error);
  assert.match(r.salida, /retirada/u);
  assert.equal((await listar(home))[0].estado, 'retirada');
  r = await orden(home, ['aceptar', id]);
  assert.equal(r.code, 1);
  assert.match(r.error, /retirada/u);
});

test('la orden rechaza lo mal escrito con el uso (2) y los errores esperados con un mensaje (1)', async () => {
  const home = temporal();
  for (const argv of [
    ['registrar'],
    ['registrar', '--regla', 'a'],
    ['registrar', '--regla', 'a', '--porque'],
    ['registrar', '--regla', 'a', '--porque', 'b', '--estacion', 'pruebas'],
    ['registrar', '--regla', 'a', '--porque', 'b', '--regla', 'c'],
    ['registrar', '--regla', 'a', '--porque', 'b', '--otra', 'c'],
    ['aceptar'],
    ['retirar', 'uno', 'dos'],
  ]) {
    const r = await orden(home, argv);
    assert.equal(r.code, 2, argv.join(' '));
    assert.match(r.error, /Uso: nexakit lecciones/u);
  }
  let r = await orden(home, ['registrar', '--regla', 'x'.repeat(301), '--porque', 'b']);
  assert.equal(r.code, 1);
  assert.match(r.error, /demasiado larga/u);
  r = await orden(home, ['aceptar', 'abcdef12']);
  assert.equal(r.code, 1);
  assert.match(r.error, /No existe la lección/u);
  assert.deepEqual(readdirSync(path.join(home, '.nexakit', 'lecciones')), []);
});

test('el listado muestra las propuestas por repetición y si cada vigente redujo su error', async () => {
  const home = temporal();
  mkdirSync(path.join(home, '.nexakit'), { recursive: true });
  const claveA = 'Error: Cannot find module <…>';
  const claveB = 'npm ERR! code E#';
  await registrar(home, { regla: 'Comprueba el módulo antes de importar', porque: 'p', origen: 'proceso', claveError: claveA }, AHORA - 10 * DIA);
  const id = (await listar(home))[0].id;
  await aceptar(home, id, AHORA - 5 * DIA);
  await registrar(home, persona('Sin clave de error'), AHORA - 5 * DIA);
  const eventos = [
    rep(AHORA - 8 * DIA, claveA),
    rep(AHORA - 7 * DIA, claveA),
    rep(AHORA - 6 * DIA, claveA),
    rep(AHORA - 1 * DIA, claveA),
    rep(AHORA - 1 * DIA, claveB),
  ];
  writeFileSync(path.join(home, '.nexakit', 'lecciones.jsonl'), `${eventos.map((e) => JSON.stringify(e)).join('\n')}\n`);

  const r = await orden(home, []);
  assert.equal(r.code, 0, r.error);
  assert.match(r.salida, /Vigentes: 2/u);
  assert.match(r.salida, new RegExp(`${id} · Comprueba el módulo antes de importar .* — redujo 3 → 1`, 'u'));
  assert.match(r.salida, /Sin clave de error .* — sin datos/u);
  assert.match(r.salida, /Propuestas: 1 \(aceptar: nexakit lecciones aceptar <id>/u);
  assert.match(r.salida, /npm ERR! code E#/u);
  assert.equal((await listar(home)).filter((l) => l.estado === 'propuesta').length, 1, 'la propuesta quedó guardada para aceptarla');

  const propuesta = (await listar(home)).find((l) => l.estado === 'propuesta');
  assert.equal((await orden(home, ['aceptar', propuesta.id])).code, 0);
  const j = await orden(home, ['--json']);
  const datos = JSON.parse(j.salida);
  assert.equal(datos.propuestas.length, 0);
  assert.deepEqual(datos.vigentes.find((l) => l.id === id).efectividad, { antes: 3, despues: 1 });
  assert.equal(datos.vigentes.find((l) => l.id === propuesta.id).fecha, AHORA);
});

test('sin registro ni lecciones el listado no crea el almacén', async () => {
  const home = temporal();
  const r = await orden(home, []);
  assert.match(r.salida, /Aún no hay lecciones registradas/u);
  assert.throws(() => readdirSync(carpeta(home)), /ENOENT/u);
});
