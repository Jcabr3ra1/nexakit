import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { Conector } from '../conectores/tipos.js';
import { leerDiff } from '../diff.js';
import { esperar, lanzar } from '../ejecutor.js';
import { calcularCoste, calcularHuella, jsonCanonico, type Catalogos, type EstacionRecorrido, type Recorrido } from '../enrutador.js';
import { ErrorFabrica } from '../errores.js';
import { ESTACIONES } from '../estaciones.js';
import { InformeEstacion, NOMBRES_ESTACION, NombreEstacion, type IA } from '../esquemas.js';
import { actualizar, cargar, cuantil05, guardar, type Evidencia, type FilaEvidencia } from '../evidencia.js';
import * as rastro from '../rastro.js';
import { cargarCasos, RAIZ_CASOS, type CasoBanco } from './casos.js';
import { medir, normalizarRuta, observacionDe, type Medicion } from './medir.js';

/** Tokens que se suponen por llamada cuando la evidencia no tiene datos del par en la estación. */
export const TOKENS_POR_LLAMADA = 30_000;
/** Finalistas por estación que pasan a la fase 2. */
export const FINALISTAS = 3;
/** Escala conocida de esfuerzos, de menor a mayor; los nombres desconocidos van después. */
export const ESCALA_ESFUERZOS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
/** Esfuerzos de la fase 2, si el catálogo del modelo los tiene. */
const ESFUERZOS_FASE2 = ['medium', 'high'] as const;

/** IA que el banco puede medir: las que van por conector. Claude corre como subagente de la sesión. */
export type IaBanco = Exclude<IA, 'claude'>;
const IAS_BANCO: readonly IaBanco[] = ['codex', 'antigravity'];

export interface EjecucionBanco {
  /** `<estacion>/<caso>`, como en `bench/casos`. */
  caso: string;
  ia: IaBanco;
  modelo: string;
  esfuerzo: string | null;
}

export interface PlanBanco {
  /** SHA-256 del JSON canónico de `{ fase, ejecuciones, coste }`: lo que la persona aprueba. */
  huella: string;
  fase: 1 | 2;
  ejecuciones: EjecucionBanco[];
  coste: { llamadas: number; tokensEstimados: number };
  /** Lo que conviene saber del plan (modelos que no se miden, estaciones sin finalistas). No entra en la huella. */
  avisos: string[];
}

const MENSAJE_PLAN = 'El plan del banco no es el que aprobaste; vuelve a planificarlo y a aprobar su coste';
const MENSAJE_SIN_HUELLA =
  'El banco no se ejecuta sin la huella del plan aprobado: muestra antes el coste con el plan y pide la aprobación de la persona';

/** Huella de un plan: SHA-256 del JSON canónico de su fase, sus ejecuciones y su coste. */
export function huellaPlan(plan: Pick<PlanBanco, 'fase' | 'ejecuciones' | 'coste'>): string {
  const { fase, ejecuciones, coste } = plan;
  return createHash('sha256').update(jsonCanonico({ fase, ejecuciones, coste }), 'utf8').digest('hex');
}

const compararTexto = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const rangoEsfuerzo = (e: string): number => {
  const i = (ESCALA_ESFUERZOS as readonly string[]).indexOf(e);
  return i === -1 ? ESCALA_ESFUERZOS.length : i;
};

/** Esfuerzos sin repetir, de menor a mayor según `ESCALA_ESFUERZOS`; los desconocidos, después y por nombre. */
export function ordenarEsfuerzos(esfuerzos: readonly string[]): string[] {
  return [...new Set(esfuerzos)].sort((a, b) => rangoEsfuerzo(a) - rangoEsfuerzo(b) || compararTexto(a, b));
}

const idCaso = (c: CasoBanco): string => `${c.estacion}/${c.nombre}`;

/** Tokens esperados de una llamada: la media medida del par en la estación o `TOKENS_POR_LLAMADA`. */
function tokensDe(ev: Evidencia, ej: EjecucionBanco, estacion: NombreEstacion): number {
  const fila = ev.filas.find(
    (f) => f.ia === ej.ia && f.modelo === ej.modelo && f.esfuerzo === ej.esfuerzo && f.estacion === estacion,
  );
  return fila !== undefined && fila.tokensMedios > 0 ? Math.round(fila.tokensMedios) : TOKENS_POR_LLAMADA;
}

const SUFIJO_ESFUERZO = new RegExp(`^(.+)-(${ESCALA_ESFUERZOS.join('|')})$`, 'u');

/**
 * Modelo base de un id de Antigravity, donde el esfuerzo va dentro del id: el id sin un sufijo final de la escala
 * (`gemini-4-neon-low` → `gemini-4-neon`). Un id sin ese sufijo es su propia base.
 */
export function baseAntigravity(id: string): { base: string; esfuerzo: string | null } {
  const m = SUFIJO_ESFUERZO.exec(id);
  return m === null ? { base: id, esfuerzo: null } : { base: m[1] as string, esfuerzo: m[2] as string };
}

/** Ids de Antigravity agrupados por modelo base, en el orden del catálogo; cada grupo, de menor a mayor esfuerzo. */
function basesAntigravity(catalogos: Catalogos): Map<string, Array<{ id: string; esfuerzo: string | null }>> {
  const bases = new Map<string, Array<{ id: string; esfuerzo: string | null }>>();
  for (const { modelo } of modelosVivos(catalogos, 'antigravity')) {
    const { base, esfuerzo } = baseAntigravity(modelo);
    bases.set(base, [...(bases.get(base) ?? []), { id: modelo, esfuerzo }]);
  }
  const rango = (e: string | null): number => (e === null ? -1 : rangoEsfuerzo(e));
  for (const variantes of bases.values()) variantes.sort((a, b) => rango(a.esfuerzo) - rango(b.esfuerzo));
  return bases;
}

/** Modelos vivos de una IA del banco, sin repetidos y en el orden del catálogo. */
function modelosVivos(catalogos: Catalogos, ia: IaBanco): Array<{ modelo: string; esfuerzos: string[] }> {
  const vistos = new Set<string>();
  return (catalogos[ia] ?? []).filter((m) => {
    if (vistos.has(m.modelo)) return false;
    vistos.add(m.modelo);
    return true;
  });
}

/**
 * Los `FINALISTAS` mejores pares (IA, modelo) de una estación según la evidencia del banco: el cuantil del 5 % más
 * alto y, en empate, el que gasta menos tokens (sin tokens medidos va detrás). Solo cuentan filas con observaciones
 * del banco y modelos que siguen en el catálogo vivo; de cada modelo vale su mejor fila. En Antigravity el modelo
 * devuelto es el base (sin el esfuerzo del id), aunque la evidencia se guarde por id completo.
 */
function finalistas(ev: Evidencia, estacion: NombreEstacion, catalogos: Catalogos): Array<{ ia: IaBanco; modelo: string }> {
  const filas = ev.filas.filter(
    (f): f is FilaEvidencia & { ia: IaBanco } =>
      f.estacion === estacion &&
      f.banco > 0 &&
      f.ia !== 'claude' &&
      (catalogos[f.ia] ?? []).some((m) => m.modelo === f.modelo),
  );
  const coste = (f: FilaEvidencia): number => (f.tokensMedios > 0 ? f.tokensMedios : Number.POSITIVE_INFINITY);
  const puntuadas = filas
    .map((fila) => ({ fila, calidad: cuantil05(fila.alfa, fila.beta) }))
    .sort(
      (a, b) =>
        b.calidad - a.calidad ||
        coste(a.fila) - coste(b.fila) ||
        compararTexto(a.fila.ia, b.fila.ia) ||
        compararTexto(a.fila.modelo, b.fila.modelo) ||
        compararTexto(a.fila.esfuerzo ?? '', b.fila.esfuerzo ?? ''),
    );
  const elegidos: Array<{ ia: IaBanco; modelo: string }> = [];
  for (const { fila } of puntuadas) {
    if (elegidos.length === FINALISTAS) break;
    const modelo = fila.ia === 'antigravity' ? baseAntigravity(fila.modelo).base : fila.modelo;
    if (elegidos.some((e) => e.ia === fila.ia && e.modelo === modelo)) continue;
    elegidos.push({ ia: fila.ia, modelo });
  }
  return elegidos;
}

export interface EntradaPlanificar {
  fase: 1 | 2;
  /** Catálogos vivos de las IA; Claude no se mide con el banco. */
  catalogos: Catalogos;
  evidencia: Evidencia;
  /** Estaciones que se miden; por defecto, todas las que tienen casos. */
  estaciones?: readonly string[];
  /** Carpeta de los casos; por defecto `bench/casos` del paquete. */
  raizCasos?: string;
}

/**
 * Planifica una fase del banco sin ejecutar nada. Fase 1: cada modelo vivo con su esfuerzo más bajo sobre el primer
 * caso con fallos de cada estación; en Antigravity, la variante más baja de cada modelo base (el id sin su sufijo de
 * esfuerzo), no todos los ids. Fase 2: los tres finalistas de cada estación según la evidencia del banco, con esfuerzo
 * medio y alto si el catálogo los tiene (en Antigravity, los ids `-medium` y `-high` de su base), sobre todos los
 * casos de la estación.
 * El coste estima las llamadas y los tokens con los datos previos; la huella cubre fase, ejecuciones y coste.
 */
export function planificarBanco(entrada: EntradaPlanificar): PlanBanco {
  const { fase, catalogos, evidencia, raizCasos = RAIZ_CASOS } = entrada;
  if (fase !== 1 && fase !== 2) throw new ErrorFabrica(`El banco tiene dos fases, 1 y 2; no existe la fase ${String(fase)}`);
  const pedidas = new Set<NombreEstacion>();
  for (const nombre of entrada.estaciones ?? []) {
    const valida = NombreEstacion.safeParse(nombre);
    if (!valida.success) throw new ErrorFabrica(`La estación «${String(nombre)}» no existe; son: ${NOMBRES_ESTACION.join(', ')}`);
    pedidas.add(valida.data);
  }

  const casos = cargarCasos(raizCasos);
  const conCasos = [...new Set(casos.map((c) => c.estacion))];
  const avisos: string[] = [];
  const avisar = (texto: string): void => {
    if (!avisos.includes(texto)) avisos.push(texto);
  };
  for (const e of pedidas) if (!conCasos.includes(e)) avisar(`${e}: no hay casos en el banco para esta estación`);
  const estaciones = entrada.estaciones === undefined ? conCasos : conCasos.filter((e) => pedidas.has(e));

  const ejecuciones: EjecucionBanco[] = [];
  for (const estacion of estaciones) {
    const deEstacion = casos.filter((c) => c.estacion === estacion);
    if (fase === 1) {
      const caso = deEstacion.find((c) => c.fallos.length > 0);
      if (caso === undefined) {
        avisar(`${estacion}: no hay casos con fallos sembrados para la fase 1`);
        continue;
      }
      for (const ia of IAS_BANCO) {
        if (ia === 'antigravity') {
          for (const variantes of basesAntigravity(catalogos).values()) {
            ejecuciones.push({ caso: idCaso(caso), ia, modelo: (variantes[0] as { id: string }).id, esfuerzo: null });
          }
          continue;
        }
        for (const { modelo, esfuerzos } of modelosVivos(catalogos, ia)) {
          const minimo = ordenarEsfuerzos(esfuerzos)[0];
          if (minimo === undefined) {
            avisar(`${modelo} de codex no declara esfuerzos en el catálogo: no se mide`);
            continue;
          }
          ejecuciones.push({ caso: idCaso(caso), ia, modelo, esfuerzo: minimo });
        }
      }
      continue;
    }
    const elegidos = finalistas(evidencia, estacion, catalogos);
    if (elegidos.length === 0) {
      avisar(`${estacion}: no hay evidencia del banco con modelos vivos; ejecuta antes la fase 1`);
      continue;
    }
    for (const { ia, modelo } of elegidos) {
      // Cada variante es una ejecución: en codex, el esfuerzo medio o alto; en antigravity, el id medium o high de la base.
      let variantes: Array<{ id: string; esfuerzo: string | null }>;
      if (ia === 'codex') {
        const admite = modelosVivos(catalogos, ia).find((m) => m.modelo === modelo)?.esfuerzos ?? [];
        variantes = ESFUERZOS_FASE2.filter((e) => admite.includes(e)).map((e) => ({ id: modelo, esfuerzo: e }));
      } else {
        const deBase = basesAntigravity(catalogos).get(modelo) ?? [];
        variantes = ESFUERZOS_FASE2.flatMap((e) => deBase.filter((v) => v.esfuerzo === e)).map((v) => ({ id: v.id, esfuerzo: null }));
      }
      if (variantes.length === 0) {
        avisar(`${estacion}: el finalista ${modelo} de ${ia} no admite esfuerzo medio ni alto; no pasa a la fase 2`);
        continue;
      }
      for (const { id, esfuerzo } of variantes) {
        for (const caso of deEstacion) ejecuciones.push({ caso: idCaso(caso), ia, modelo: id, esfuerzo });
      }
    }
  }

  const estacionDe = new Map(casos.map((c) => [idCaso(c), c.estacion]));
  const tokensEstimados = ejecuciones.reduce(
    (suma, ej) => suma + tokensDe(evidencia, ej, estacionDe.get(ej.caso) as NombreEstacion),
    0,
  );
  const coste = { llamadas: ejecuciones.length, tokensEstimados };
  return { huella: huellaPlan({ fase, ejecuciones, coste }), fase, ejecuciones, coste, avisos };
}

/** Número con punto de millares: 150000 → «150.000». */
const miles = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/gu, '.');

/**
 * Texto en español con el plan y su coste, para mostrarlo a la persona ANTES de ejecutar nada: fase, llamadas, tokens
 * estimados, cada ejecución, los avisos y la huella con la que se aprueba. Es pura.
 */
export function describirPlan(plan: PlanBanco): string {
  const lineas = [
    `Banco de pruebas, fase ${plan.fase}: ${plan.coste.llamadas} ${plan.coste.llamadas === 1 ? 'llamada' : 'llamadas'} a modelos externos, unos ${miles(plan.coste.tokensEstimados)} tokens estimados.`,
  ];
  if (plan.ejecuciones.length === 0) lineas.push('No hay nada que ejecutar.');
  else {
    lineas.push('', 'Ejecuciones:');
    for (const e of plan.ejecuciones) lineas.push(`- ${e.caso}: ${e.ia} ${e.modelo}${e.esfuerzo === null ? '' : ` ${e.esfuerzo}`}`);
  }
  if (plan.avisos.length > 0) {
    lineas.push('', 'Avisos:');
    for (const a of plan.avisos) lineas.push(`- ${a}`);
  }
  lineas.push('', `Para ejecutarlo hace falta tu aprobación de este coste. Huella del plan: ${plan.huella}`);
  return lineas.join('\n');
}

const EsquemaPlan = z.strictObject({
  huella: z.string(),
  fase: z.union([z.literal(1), z.literal(2)]),
  ejecuciones: z.array(
    z
      .strictObject({
        caso: z.string().min(1),
        ia: z.enum(['codex', 'antigravity']),
        modelo: z.string().min(1),
        esfuerzo: z.string().min(1).nullable(),
      })
      .refine((e) => (e.ia === 'codex') === (e.esfuerzo !== null), 'codex lleva esfuerzo y antigravity no'),
  ),
  coste: z.strictObject({ llamadas: z.number().int().nonnegative(), tokensEstimados: z.number().int().nonnegative() }),
  avisos: z.array(z.string()).optional(),
});

/** Medición de una ejecución del plan. Solo las válidas llegan a la evidencia. */
export interface EjecucionMedida extends EjecucionBanco {
  valida: boolean;
  /** Por qué no es válida (escrituras en el repo, estación fallida o cancelada, informe ausente...). */
  motivo?: string;
  medicion?: Medicion;
  /** Lo que se sumó a la evidencia. */
  observacion?: { aciertos: number; fallos: number };
  /** Tokens que informó la CLI; sin ellos no se registra ninguno. */
  tokens?: number;
  segundos?: number;
  /** Id del recorrido de la fábrica que hizo la ejecución, para buscarlo en el rastro. */
  recorrido?: string;
}

export interface ResultadoBanco {
  huella: string;
  fase: 1 | 2;
  ejecuciones: EjecucionMedida[];
  /** La evidencia tal como quedó guardada. */
  evidencia: Evidencia;
  avisos: string[];
}

export interface OpcionesEjecutar {
  /** Huella del plan que aprobó la persona: obligatoria. */
  huella?: string;
  conectores: Partial<Record<IA, Conector>>;
  /** Carpeta personal donde viven la evidencia y el rastro; por defecto la de la persona. */
  home?: string;
  /** Carpeta de los casos; por defecto `bench/casos` del paquete. */
  raizCasos?: string;
  timeoutMs?: number;
  graciaMs?: number;
  topeCatalogoMs?: number;
  /** Se llama al terminar cada ejecución, válida o no. */
  alAvanzar?: (medida: EjecucionMedida, indice: number, total: number) => void;
}

const mensajeDe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=off', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args],
      { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } },
      (error, _stdout, stderr) => {
        if (error) reject(new ErrorFabrica(`git ${args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? ''} falló: ${String(stderr).trim()}`, { cause: error }));
        else resolve();
      },
    );
  });
}

/** Autor del commit de base del repo temporal. */
const AUTOR = { nombre: 'Laura Gómez', correo: 'laura.gomez@example.com' } as const;

/** Copia un archivo del caso al repo temporal: carpetas `0o700`, archivo nuevo `0o600` que no sigue enlaces. */
async function copiar(origen: string, destino: string): Promise<void> {
  await mkdir(path.dirname(destino), { recursive: true, mode: 0o700 });
  await rm(destino, { force: true });
  await writeFile(destino, await readFile(origen), { mode: 0o600, flag: 'wx' });
}

/**
 * Materializa el caso en `raiz`: la base en un commit y el cambio encima sin confirmar. Ni el nombre del caso ni
 * `esperado.json` llegan al repo: el autor y el mensaje del commit son neutros y la carpeta, aleatoria.
 */
async function prepararRepo(raiz: string, caso: CasoBanco): Promise<void> {
  await git(raiz, ['init', '-q']);
  for (const ruta of caso.base.archivos) await copiar(path.join(caso.directorio, 'base', ruta), path.join(raiz, ruta));
  if (caso.base.archivos.length > 0) await git(raiz, ['add', '-f', '--', ...caso.base.archivos]);
  // Autor neutro y verosímil: con `git log` el revisor no debe saber que lo están midiendo. Va en el entorno, que manda
  // sobre la configuración y sobre las variables de autor que tenga la persona.
  await git(raiz, ['commit', '-q', '--no-verify', '--allow-empty', '-m', 'Versión inicial'], {
    GIT_AUTHOR_NAME: AUTOR.nombre,
    GIT_AUTHOR_EMAIL: AUTOR.correo,
    GIT_COMMITTER_NAME: AUTOR.nombre,
    GIT_COMMITTER_EMAIL: AUTOR.correo,
  });
  for (const ruta of caso.cambio.archivos) await copiar(path.join(caso.directorio, 'cambio', ruta), path.join(raiz, ruta));
}

/** Recorrido de la fábrica con solo la estación del caso, fijada con la elección del plan; las demás, omitidas. */
async function recorridoDe(raiz: string, estacion: NombreEstacion, ej: EjecucionBanco): Promise<Recorrido> {
  const diff = await leerDiff(raiz, 'HEAD');
  const estaciones: EstacionRecorrido[] = NOMBRES_ESTACION.map((nombre) =>
    nombre === estacion
      ? {
          estacion: nombre,
          ia: ej.ia,
          modelo: ej.modelo,
          esfuerzo: ej.esfuerzo,
          motivo: 'banco de pruebas',
          descartes: [],
          explicacion: 'medición del banco de pruebas',
          calidad: null,
          ordenesPermitidas: ej.ia === 'codex' ? [...ESTACIONES[nombre].ordenesPermitidas] : [],
          estado: 'propuesta',
        }
      : {
          estacion: nombre,
          ia: null,
          modelo: null,
          esfuerzo: null,
          motivo: 'fuera de esta medición',
          descartes: [],
          explicacion: '',
          calidad: null,
          ordenesPermitidas: [],
          estado: 'omitida',
        },
  );
  const datos = { head: diff.head, base: diff.base, basePedida: 'HEAD', diffSha256: diff.sha256, estaciones };
  return { ...datos, huella: calcularHuella(datos), coste: calcularCoste(estaciones), catalogos: {}, avisos: [] };
}

const RE_DOCUMENTO = /^docs\/|\.md$/iu;

/**
 * Una ejecución del plan en su propio repo temporal, que se borra al terminar. No toca la evidencia. Si el repo no se
 * puede borrar (en Windows, un proceso que aún lo tiene abierto), se avisa con `avisar` y la medición se conserva.
 */
async function medirUna(
  ej: EjecucionBanco,
  caso: CasoBanco,
  opciones: OpcionesEjecutar,
  home: string,
  avisar: (aviso: string) => void,
): Promise<EjecucionMedida> {
  const invalida = (motivo: string, extra: Partial<EjecucionMedida> = {}): EjecucionMedida => ({ ...ej, ...extra, valida: false, motivo });
  const raiz = await mkdtemp(path.join(os.tmpdir(), 'nexakit-banco-'));
  try {
    const raices = [...new Set([raiz, await realpath(raiz)].map((r) => r.split(path.sep).join('/')))];
    await prepararRepo(raiz, caso);
    const recorrido = await recorridoDe(raiz, caso.estacion, ej);
    const inicio = Date.now();
    const { id } = await lanzar(recorrido, {
      raiz,
      conectores: opciones.conectores,
      home,
      sinLecciones: true,
      ...(opciones.timeoutMs === undefined ? {} : { timeoutMs: opciones.timeoutMs }),
      ...(opciones.graciaMs === undefined ? {} : { graciaMs: opciones.graciaMs }),
      ...(opciones.topeCatalogoMs === undefined ? {} : { topeCatalogoMs: opciones.topeCatalogoMs }),
    });
    const estado = await esperar(id, home);
    const segundos = (Date.now() - inicio) / 1000;
    const base = { recorrido: id };
    if (estado.escriturasDetectadas.length > 0) {
      return invalida(`el revisor escribió en el repo (${estado.escriturasDetectadas.slice(0, 5).join(', ')}): la medición no vale`, base);
    }
    const fila = estado.estaciones.find((e) => e.estacion === caso.estacion);
    if (fila?.estado !== 'ok') {
      return invalida(`la ejecución terminó como ${fila?.estado ?? 'desconocida'}${fila?.motivo === undefined ? '' : `: ${fila.motivo}`}`, base);
    }
    if (estado.fase !== 'terminado') {
      return invalida(`el recorrido terminó como ${estado.fase}${estado.motivo === undefined ? '' : `: ${estado.motivo}`}`, base);
    }
    const resultado = rastro.leerEstacion(estado.dir, caso.estacion)?.resultado;
    const informe = InformeEstacion.safeParse(resultado?.informe);
    if (!informe.success) return invalida('el revisor no devolvió un informe válido', base);

    // Un revisor puede dar la ruta absoluta dentro del repo temporal: se compara la relativa.
    const relativa = (archivo: string): string => {
      const n = normalizarRuta(archivo);
      for (const r of raices) if (n.startsWith(`${r}/`)) return n.slice(r.length + 1);
      return n;
    };
    const hallazgos = informe.data.hallazgos.map((h) => ({ ...h, archivo: relativa(h.archivo) }));
    const documentos = [...new Set([...caso.base.archivos, ...caso.cambio.archivos])].filter((r) => RE_DOCUMENTO.test(r));
    const medicion = medir(hallazgos, caso.fallos, { documentos });
    const total = resultado?.tokens?.total;
    const tokens = typeof total === 'number' && Number.isFinite(total) && total > 0 ? total : undefined;
    return {
      ...ej,
      ...base,
      valida: true,
      medicion,
      observacion: observacionDe(medicion, caso.fallos.length),
      ...(tokens === undefined ? {} : { tokens }),
      segundos,
    };
  } catch (error) {
    return invalida(`no se pudo medir: ${mensajeDe(error)}`);
  } finally {
    // Un fallo al borrar no puede tapar el resultado ni cortar el banco: el plan ya se consumió.
    await rm(raiz, { recursive: true, force: true }).catch((error: unknown) => {
      avisar(`No se pudo borrar el repo temporal ${raiz} (${mensajeDe(error)}); bórralo a mano cuando termine el banco.`);
    });
  }
}

/**
 * Comprueba, sin tocar nada, que `plan` es el plan que aprobó la persona: forma válida, huella con 64 hex que coincide
 * con la del plan y con su contenido, y llamadas iguales a las ejecuciones. Lanza `ErrorFabrica` si algo no cuadra.
 */
export function verificarPlanAprobado(plan: unknown, huella: string | undefined): PlanBanco {
  if (typeof huella !== 'string' || !/^[0-9a-f]{64}$/u.test(huella)) throw new ErrorFabrica(MENSAJE_SIN_HUELLA);
  const analisis = EsquemaPlan.safeParse(plan);
  if (!analisis.success) throw new ErrorFabrica(MENSAJE_PLAN);
  const aprobado = analisis.data;
  if (huellaPlan(aprobado) !== aprobado.huella || aprobado.huella !== huella) throw new ErrorFabrica(MENSAJE_PLAN);
  if (aprobado.coste.llamadas !== aprobado.ejecuciones.length) throw new ErrorFabrica(MENSAJE_PLAN);
  return { ...aprobado, avisos: aprobado.avisos ?? [] };
}

/**
 * Ejecuta un plan del banco aprobado. Exige la huella que vio la persona y rechaza el plan si no coincide o si se
 * alteró después de calcularla. Cada ejecución corre con la propia fábrica (`lanzar`, sus conectores, su comprobación
 * del disco y su rastro) en un repo git temporal y aleatorio, sin lecciones, y solo mide la estación del caso. Las
 * ejecuciones válidas se suman a `~/.nexakit/fabrica/evidencia.json` con fuente `banco` en cuanto terminan; las que
 * escribieron en el repo, fallaron o se cancelaron se devuelven como inválidas y no se registran.
 */
export async function ejecutarBanco(plan: unknown, opciones: OpcionesEjecutar): Promise<ResultadoBanco> {
  const aprobado = verificarPlanAprobado(plan, opciones.huella);

  const home = opciones.home ?? os.homedir();
  const casos = new Map(cargarCasos(opciones.raizCasos ?? RAIZ_CASOS).map((c) => [idCaso(c), c]));
  for (const ej of aprobado.ejecuciones) {
    if (!casos.has(ej.caso)) throw new ErrorFabrica(`El caso ${ej.caso} del plan no existe en el banco; vuelve a planificarlo`);
  }

  const avisos: string[] = [];
  const avisar = (aviso: string | null): void => {
    if (aviso !== null && !avisos.includes(aviso)) avisos.push(aviso);
  };
  // Se lee al empezar para avisar pronto si no se puede leer, y otra vez antes de cada guardado.
  const inicial = await cargar(home);
  avisar(inicial.aviso);
  let evidencia = inicial.evidencia;
  const ejecuciones: EjecucionMedida[] = [];
  const total = aprobado.ejecuciones.length;
  for (const [indice, ej] of aprobado.ejecuciones.entries()) {
    const caso = casos.get(ej.caso) as CasoBanco;
    const medida = await medirUna(ej, caso, opciones, home, avisar);
    if (medida.valida && medida.observacion !== undefined) {
      // El banco dura mucho: entre dos ejecuciones la persona puede registrar veredictos reales. Se suma sobre lo que
      // hay ahora en disco, no sobre la copia del principio, para no borrarlos al guardar.
      const actual = await cargar(home);
      avisar(actual.aviso);
      evidencia = actualizar(
        actual.evidencia,
        { ia: ej.ia, modelo: ej.modelo, esfuerzo: ej.esfuerzo, estacion: caso.estacion },
        { ...medida.observacion, tokens: medida.tokens, segundos: medida.segundos, fuente: 'banco' },
      );
      avisar((await guardar(home, evidencia)).aviso);
    }
    ejecuciones.push(medida);
    opciones.alAvanzar?.(medida, indice, total);
  }
  return { huella: aprobado.huella, fase: aprobado.fase, ejecuciones, evidencia, avisos };
}
