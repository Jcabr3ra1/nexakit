import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Las reglas del registro son las del mod, para que el resumen y el aviso de sesión nunca discrepen.
import { leerEventos, sinGuardar } from '../plugins/nexakit-lecciones/hooks/lecciones.js';
import { loadWithDependencyCheck } from './missing-dependencies.js';

const DIA_MS = 24 * 60 * 60 * 1000;
const MAX_PENDIENTES_TEXTO = 5;
const USO = `Uso: nexakit lecciones [--json | --descartar]
     nexakit lecciones registrar --regla <texto> --porque <texto> [--proyecto <ruta>] [--estacion <estacion>]
     nexakit lecciones aceptar <id>
     nexakit lecciones retirar <id>
`;

function resumir(eventos) {
  const cuenta = (tipo) => eventos.filter((e) => e.tipo === tipo).length;
  return {
    correcciones: cuenta('correccion'),
    leccionesGuardadas: cuenta('guardada'),
    erroresFrenados: cuenta('freno'),
    erroresRepetidos: cuenta('repeticion'),
  };
}

// Las más recientes primero.
const pendientes = (eventos) => sinGuardar(eventos).reverse().map((e) => (typeof e.texto === 'string' ? e.texto : ''));

// Opciones de `registrar`: cada una lleva un valor y no se admite repetirla ni ninguna otra.
function opcionesDeRegistrar(args) {
  const valores = {};
  for (let i = 0; i < args.length; i += 2) {
    const nombre = args[i];
    const valor = args[i + 1];
    if (!['--regla', '--porque', '--proyecto', '--estacion'].includes(nombre) || valor === undefined || valor.startsWith('--') || nombre in valores) return null;
    valores[nombre] = valor;
  }
  return valores['--regla'] === undefined || valores['--porque'] === undefined ? null : valores;
}

const formatoEfectividad = (e) => {
  if (e === null) return 'sin datos';
  return e.despues < e.antes ? `redujo ${e.antes} → ${e.despues}` : `no redujo ${e.antes} → ${e.despues}`;
};

const donde = (ambito) => {
  if (ambito === 'global') return 'global';
  return 'estacion' in ambito ? `${ambito.proyecto} · ${ambito.estacion}` : ambito.proyecto;
};

async function cargarAlmacen() {
  let aviso = '';
  const [lecciones, errores] = await Promise.all([
    loadWithDependencyCheck(() => import('../dist/fabrica/lecciones.js'), { write: (t) => { aviso += t; } }),
    loadWithDependencyCheck(() => import('../dist/fabrica/errores.js'), { write: (t) => { aviso += t; } }),
  ]);
  return lecciones && errores ? { ...lecciones, ErrorFabrica: errores.ErrorFabrica } : { aviso };
}

// Las órdenes del almacén: sus errores esperados se dicen en español y salen con 1.
async function ordenDelAlmacen(argv, { out, err }, home, ahora) {
  const [orden, ...args] = argv;
  const opciones = orden === 'registrar' ? opcionesDeRegistrar(args) : null;
  const idOk = (orden === 'aceptar' || orden === 'retirar') && args.length === 1;
  if ((orden === 'registrar' && (opciones === null || (opciones['--estacion'] !== undefined && opciones['--proyecto'] === undefined))) || (orden !== 'registrar' && !idOk)) {
    await err(USO);
    return 2;
  }
  const almacen = await cargarAlmacen();
  if (almacen.aviso !== undefined) {
    await err(almacen.aviso);
    return 1;
  }
  try {
    if (orden === 'registrar') {
      const ambito = opciones['--proyecto'] === undefined
        ? 'global'
        : { proyecto: opciones['--proyecto'], ...(opciones['--estacion'] === undefined ? {} : { estacion: opciones['--estacion'] }) };
      const { leccion, nueva } = await almacen.registrar(
        home,
        { regla: opciones['--regla'], porque: opciones['--porque'], ambito, origen: 'persona' },
        ahora,
      );
      await out(`${nueva ? 'Lección registrada' : 'Esa lección ya existía; se actualizó su fecha'} (${leccion.estado}): ${leccion.id} · ${leccion.regla}\n`);
    } else {
      const leccion = await (orden === 'aceptar' ? almacen.aceptar : almacen.retirar)(home, args[0], ahora);
      await out(`Lección ${leccion.id} ${leccion.estado === 'vigente' ? 'vigente' : 'retirada'}: ${leccion.regla}\n`);
    }
    return 0;
  } catch (error) {
    if (!(error instanceof almacen.ErrorFabrica)) throw error;
    await err(`${error.message}\n`);
    return 1;
  }
}

export async function runLeccionesCommand(argv, { out, err }, options = {}) {
  const home = options.homeDirectory ?? os.homedir();
  const ahora = options.now ?? Date.now();
  if (['registrar', 'aceptar', 'retirar'].includes(argv[0])) return ordenDelAlmacen(argv, { out, err }, home, ahora);
  const json = argv.includes('--json');
  const descartar = argv.includes('--descartar');
  if (argv.some((a) => a !== '--json' && a !== '--descartar') || (json && descartar)) {
    await err(USO);
    return 2;
  }
  const ruta = path.join(home, '.nexakit', 'lecciones.jsonl');
  let texto = null;
  try {
    texto = await fs.readFile(ruta, 'utf8');
  } catch {
    texto = null;
  }
  const eventos = texto === null ? [] : leerEventos(texto);
  if (descartar) {
    // Para las correcciones que no eran tales o que ya no valen: se dan por resueltas sin borrar el historial.
    const cuantas = sinGuardar(eventos).length;
    if (cuantas === 0) {
      await out('No hay correcciones pendientes que descartar.\n');
      return 0;
    }
    const base = texto.endsWith('\n') ? texto : `${texto}\n`;
    await fs.writeFile(ruta, `${base}${JSON.stringify({ fecha: ahora, tipo: 'descartada' })}\n`);
    await out(`${cuantas === 1 ? '1 corrección descartada' : `${cuantas} correcciones descartadas`}; el historial se conserva.\n`);
    return 0;
  }
  // Las propuestas se guardan al listar para poder aceptarlas por id; solo la persona las pasa a vigentes.
  let vigentes = [];
  let propuestas = [];
  const almacen = await cargarAlmacen();
  if (almacen.aviso !== undefined) {
    await err(almacen.aviso);
  } else {
    try {
      await almacen.guardarPropuestas(home, almacen.proponerPorRepeticion(eventos), ahora);
      const todas = await almacen.listar(home);
      vigentes = todas.filter((l) => l.estado === 'vigente').map((l) => ({ ...l, efectividad: almacen.efectividad(l, eventos, ahora) }));
      propuestas = todas.filter((l) => l.estado === 'propuesta');
    } catch (error) {
      if (!(error instanceof almacen.ErrorFabrica)) throw error;
      await err(`${error.message}\n`);
    }
  }
  const resumen = {
    ultimos7Dias: resumir(eventos.filter((e) => e.fecha >= ahora - 7 * DIA_MS)),
    total: resumir(eventos),
    pendientes: pendientes(eventos),
    vigentes,
    propuestas,
  };
  if (json) {
    await out(`${JSON.stringify(resumen, null, 2)}\n`);
    return 0;
  }
  if (eventos.length === 0 && vigentes.length === 0 && propuestas.length === 0) {
    await out(
      'Aún no hay lecciones registradas. El registro lo escribe el mod nexakit-lecciones cuando detecta una corrección o un error repetido.\n',
    );
    return 0;
  }
  const formato = (titulo, r) =>
    `${titulo}: ${r.correcciones} correcciones, ${r.leccionesGuardadas} lecciones guardadas, ${r.erroresFrenados} errores frenados, ${r.erroresRepetidos} errores repetidos tres veces\n`;
  await out(formato('Últimos 7 días', resumen.ultimos7Dias));
  await out(formato('Total', resumen.total));
  const p = resumen.pendientes;
  if (p.length === 0) {
    await out('Pendientes: ninguna corrección sin guardar como lección.\n');
  } else {
    await out(`Pendientes: ${p.length} correcciones sin guardar como lección (si ya no valen: nexakit lecciones --descartar)\n`);
    for (const t of p.slice(0, MAX_PENDIENTES_TEXTO)) await out(`  - ${t}\n`);
    if (p.length > MAX_PENDIENTES_TEXTO) await out(`  ... y ${p.length - MAX_PENDIENTES_TEXTO} más (usa --json para verlas todas)\n`);
  }
  if (vigentes.length > 0) {
    await out(`Vigentes: ${vigentes.length} (quitar una: nexakit lecciones retirar <id>)\n`);
    for (const l of vigentes) await out(`  - ${l.id} · ${l.regla} [${donde(l.ambito)}] — ${formatoEfectividad(l.efectividad)}\n`);
  }
  if (propuestas.length > 0) {
    await out(`Propuestas: ${propuestas.length} (aceptar: nexakit lecciones aceptar <id>; descartar: nexakit lecciones retirar <id>)\n`);
    for (const l of propuestas) await out(`  - ${l.id} · ${l.regla}\n`);
  }
  return 0;
}
