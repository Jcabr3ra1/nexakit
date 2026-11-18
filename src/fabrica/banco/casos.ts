import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ErrorFabrica } from '../errores.js';
import { NOMBRES_ESTACION, type NombreEstacion } from '../esquemas.js';

/** Raíz de los casos del banco: `bench/casos` en la raíz del paquete. */
export const RAIZ_CASOS = path.resolve(import.meta.dirname, '../../../bench/casos');

const Archivos = z.strictObject({ archivos: z.array(z.string()) });

const Fallo = z.strictObject({
  archivo: z.string(),
  lineas: z.tuple([z.number().int(), z.number().int()]),
  categoria: z.string().regex(/^[\p{L}\p{N}_-]{1,32}$/u),
  descripcion: z.string().refine((d) => d.trim().length > 0),
});
export type FalloSembrado = z.infer<typeof Fallo>;

const Esperado = z.strictObject({
  estacion: z.string(),
  base: Archivos,
  cambio: Archivos,
  fallos: z.array(Fallo),
});

/**
 * Un caso cargado. El banco lo materializa como un repo git temporal: `base` es el commit
 * y `cambio` se superpone sin commit. Los `fallos[].lineas` cuentan sobre `cambio`.
 */
export interface CasoBanco {
  estacion: NombreEstacion;
  nombre: string;
  directorio: string;
  base: { archivos: string[] };
  cambio: { archivos: string[] };
  fallos: FalloSembrado[];
}

/** Ruta relativa segura: no vacía, no absoluta y sin `..`. */
function rutaRelativaInvalida(ruta: string): string | undefined {
  if (ruta.trim() === '') return 'está vacía';
  if (path.isAbsolute(ruta) || path.win32.isAbsolute(ruta) || ruta.startsWith('/')) return 'es absoluta';
  const trozos = ruta.split(/[\\/]/);
  if (trozos.includes('..')) return 'contiene «..»';
  if (trozos.includes('') || trozos.includes('.')) return 'no está normalizada';
  return undefined;
}

/** Lee un archivo del caso sin seguir enlaces. Devuelve el texto o el error en español. */
function leerArchivo(carpeta: string, ruta: string, etiqueta: string): { texto: string } | { error: string } {
  const invalida = rutaRelativaInvalida(ruta);
  if (invalida) return { error: `${etiqueta}: la ruta «${ruta}» ${invalida}` };
  let actual = carpeta;
  const trozos = ruta.split('/');
  for (const [i, trozo] of trozos.entries()) {
    actual = path.join(actual, trozo);
    let info;
    try {
      info = lstatSync(actual);
    } catch {
      return { error: `${etiqueta}: el archivo «${ruta}» no existe` };
    }
    if (info.isSymbolicLink()) return { error: `${etiqueta}: «${ruta}» pasa por un enlace simbólico` };
    const esUltimo = i === trozos.length - 1;
    if (esUltimo && !info.isFile()) return { error: `${etiqueta}: «${ruta}» no es un archivo` };
    if (!esUltimo && !info.isDirectory()) return { error: `${etiqueta}: «${ruta}» cruza algo que no es una carpeta` };
  }
  return { texto: readFileSync(actual, 'utf8') };
}

function contarLineas(texto: string): number {
  if (texto === '') return 0;
  const partes = texto.split('\n');
  if (texto.endsWith('\n')) partes.pop();
  return partes.length;
}

function leerCaso(directorio: string): { caso?: CasoBanco; errores: string[] } {
  const nombre = path.basename(directorio);
  const estacionCarpeta = path.basename(path.dirname(directorio));
  const id = `${estacionCarpeta}/${nombre}`;
  const errores: string[] = [];
  const fallar = (m: string) => errores.push(`${id}: ${m}`);

  let datos: unknown;
  try {
    const info = lstatSync(path.join(directorio, 'esperado.json'));
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('no es un archivo normal');
    datos = JSON.parse(readFileSync(path.join(directorio, 'esperado.json'), 'utf8'));
  } catch (error) {
    fallar(`no se pudo leer esperado.json (${error instanceof Error ? error.message : String(error)})`);
    return { errores };
  }
  const analisis = Esperado.safeParse(datos);
  if (!analisis.success) {
    for (const p of analisis.error.issues) {
      fallar(`esperado.json tiene un campo inválido o de más en «${p.path.join('.') || 'raíz'}»`);
    }
    return { errores };
  }
  const esperado = analisis.data;

  const conocida = (NOMBRES_ESTACION as readonly string[]).includes(esperado.estacion);
  if (!conocida) fallar(`la estación «${esperado.estacion}» no existe`);
  if (esperado.estacion !== estacionCarpeta) {
    fallar(`la estación «${esperado.estacion}» no coincide con la carpeta «${estacionCarpeta}»`);
  }

  for (const carpeta of ['base', 'cambio'] as const) {
    const info = (() => {
      try {
        return lstatSync(path.join(directorio, carpeta));
      } catch {
        return undefined;
      }
    })();
    if (!info || info.isSymbolicLink() || !info.isDirectory()) {
      fallar(`falta la carpeta «${carpeta}» o es un enlace simbólico`);
    }
  }

  if (errores.length === 0) {
    for (const carpeta of ['base', 'cambio'] as const) {
      for (const ruta of esperado[carpeta].archivos) {
        const r = leerArchivo(path.join(directorio, carpeta), ruta, `${carpeta}.archivos`);
        if ('error' in r) fallar(r.error);
      }
      const repetidos = esperado[carpeta].archivos.filter((r, i, l) => l.indexOf(r) !== i);
      if (repetidos.length > 0) fallar(`${carpeta}.archivos repite «${repetidos[0]}»`);
    }
    for (const [i, fallo] of esperado.fallos.entries()) {
      const etiqueta = `fallos[${i}]`;
      if (!esperado.cambio.archivos.includes(fallo.archivo)) {
        fallar(`${etiqueta}: «${fallo.archivo}» no está en cambio.archivos`);
        continue;
      }
      const r = leerArchivo(path.join(directorio, 'cambio'), fallo.archivo, etiqueta);
      if ('error' in r) {
        fallar(r.error);
        continue;
      }
      const total = contarLineas(r.texto);
      const [desde, hasta] = fallo.lineas;
      if (!(desde >= 1 && desde <= hasta && hasta <= total)) {
        fallar(`${etiqueta}: las líneas [${desde}, ${hasta}] no caben en «${fallo.archivo}» (tiene ${total})`);
      }
    }
  }
  if (errores.length > 0 || !conocida) return { errores };
  return {
    errores,
    caso: {
      estacion: esperado.estacion as NombreEstacion,
      nombre,
      directorio,
      base: esperado.base,
      cambio: esperado.cambio,
      fallos: esperado.fallos,
    },
  };
}

/** Valida un caso (`<raiz>/<estacion>/<caso>`) y devuelve sus errores en español; vacío si es válido. */
export function validarCaso(directorio: string): string[] {
  return leerCaso(directorio).errores;
}

function subcarpetas(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Carga y valida todos los casos, ordenados por estación y caso. Lanza `ErrorFabrica` si alguno es inválido. */
export function cargarCasos(raiz: string = RAIZ_CASOS): CasoBanco[] {
  let estaciones: string[];
  try {
    estaciones = subcarpetas(raiz);
  } catch (error) {
    throw new ErrorFabrica(`No se pudo leer la carpeta de casos del banco «${raiz}».`, { cause: error });
  }
  const casos: CasoBanco[] = [];
  const errores: string[] = [];
  for (const estacion of estaciones) {
    for (const nombre of subcarpetas(path.join(raiz, estacion))) {
      const r = leerCaso(path.join(raiz, estacion, nombre));
      errores.push(...r.errores);
      if (r.caso) casos.push(r.caso);
    }
  }
  if (errores.length > 0) {
    throw new ErrorFabrica(`Hay casos del banco inválidos:\n- ${errores.join('\n- ')}`);
  }
  return casos;
}
