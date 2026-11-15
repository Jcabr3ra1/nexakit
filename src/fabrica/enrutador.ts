import { createHash } from 'node:crypto';
import os from 'node:os';
import { cargarConfig } from './config.js';
import { elegir, riesgoDe, UMBRALES, type Candidato } from './decision.js';
import { clasificar, leerDiff, type Categoria } from './diff.js';
import { ErrorFabrica } from './errores.js';
import { caducada, cargar, type Evidencia } from './evidencia.js';
import { ESTACIONES, TABLA_MODELOS_INICIAL } from './estaciones.js';
import { NOMBRES_ESTACION, type ConfigFabrica, type IA, type NombreEstacion } from './esquemas.js';

/** Catálogo vivo de una IA: modelos y esfuerzos que admite cada uno. */
export type Catalogos = Partial<Record<IA, Array<{ modelo: string; esfuerzos: string[] }>>>;

export type EstadoEstacion = 'propuesta' | 'sin-modelo' | 'omitida';

export interface EstacionRecorrido {
  estacion: NombreEstacion;
  ia: IA | null;
  modelo: string | null;
  esfuerzo: string | null;
  motivo: string;
  descartes: string[];
  /** Una línea en español con el porqué de la elección (vacía si la estación va omitida). Entra en la huella. */
  explicacion: string;
  /** Cuantil del 5 % de la calidad medida del modelo elegido; `null` si no hay datos medidos o no se decidió por evidencia. */
  calidad: number | null;
  /**
   * Órdenes exactas que el revisor puede ejecutar. Entran en la huella, así que la persona las
   * aprueba con el resto del recorrido: las que declara el repo revisado no son de fiar por sí solas.
   */
  ordenesPermitidas: string[];
  estado: EstadoEstacion;
}

export interface Recorrido {
  huella: string;
  head: string;
  /** SHA del ancestro común contra el que se calculó el diff. */
  base: string;
  /** Rama base tal como la pidió la persona; se usa para releer el diff. */
  basePedida: string;
  diffSha256: string;
  /** Texto libre de la persona; no activa estaciones, pero va a los encargos. */
  foco?: string;
  estaciones: EstacionRecorrido[];
  coste: { llamadasExternas: number; subagentesClaude: number };
  /** Catálogos con los que se eligieron los modelos; validan los cambios posteriores. */
  catalogos: Catalogos;
  /** Avisos sobre la evidencia (sin datos, umbral no alcanzado, caducada). Informan; no entran en la huella. */
  avisos: string[];
}

export interface CambioRecorrido {
  estacion: string;
  quitar?: true;
  ia?: IA;
  modelo?: string;
  esfuerzo?: string;
}

const MENSAJE_HUELLA = 'El cambio ya no es el que aprobaste; vuelve a proponer';

/** Condición de activación de cada estación (tabla «Estaciones» del diseño). */
const ACTIVACION: Record<NombreEstacion, { categoria: Categoria | null; motivo: string; sinActivar: string }> = {
  seguridad: { categoria: 'hooks', motivo: 'toca hooks', sinActivar: 'no toca hooks' },
  arquitectura: { categoria: 'critica', motivo: 'toca rutas críticas', sinActivar: 'no toca rutas críticas' },
  pruebas: { categoria: 'codigo', motivo: 'cambia código', sinActivar: 'no cambia código' },
  codigo: { categoria: null, motivo: 'siempre revisa el diff', sinActivar: '' },
  interfaz: { categoria: 'interfaz', motivo: 'toca archivos de interfaz', sinActivar: 'no toca archivos de interfaz' },
  rendimiento: { categoria: 'caliente', motivo: 'toca rutas calientes', sinActivar: 'no toca rutas calientes' },
  documentacion: { categoria: 'docs', motivo: 'cambia documentación', sinActivar: 'no cambia documentación' },
};

/**
 * JSON con las claves de los objetos ordenadas, para que la misma información dé
 * siempre la misma cadena. Las propiedades `undefined` se omiten, como en `JSON.stringify`.
 */
export function jsonCanonico(valor: unknown): string {
  return JSON.stringify(ordenar(valor));
}

function ordenar(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(ordenar);
  if (valor !== null && typeof valor === 'object') {
    const origen = valor as Record<string, unknown>;
    // `fromEntries` define propiedades propias: una clave `__proto__` no se pierde.
    return Object.fromEntries(
      Object.keys(origen)
        .sort()
        .map((clave) => [clave, ordenar(origen[clave])]),
    );
  }
  return valor;
}

/**
 * SHA-256 del JSON canónico de `{ head, diffSha256, base, basePedida, foco, estaciones }`:
 * todo lo que la persona aprueba. `coste` se deriva de `estaciones` y `catalogos` solo
 * sirve para validar cambios, así que no entran.
 */
export function calcularHuella(
  datos: Pick<Recorrido, 'head' | 'diffSha256' | 'base' | 'basePedida' | 'estaciones'> & { foco?: string },
): string {
  const { head, diffSha256, base, basePedida, foco, estaciones } = datos;
  return createHash('sha256')
    .update(jsonCanonico({ head, diffSha256, base, basePedida, foco, estaciones }), 'utf8')
    .digest('hex');
}

export type { Candidato };

type ConfigEstacion = NonNullable<ConfigFabrica['estaciones']>[NombreEstacion];

function clave(c: Candidato): string {
  return `${c.ia}\u0000${c.modelo}\u0000${c.esfuerzo ?? ''}`;
}

/** Lista ordenada de candidatos: la tabla inicial, adaptada a lo que pide la configuración. */
function candidatosDe(estacion: NombreEstacion, cfg: ConfigEstacion | undefined, descartes: string[]): Candidato[] {
  const tabla: Candidato[] = (TABLA_MODELOS_INICIAL[estacion] ?? []).map((c) => ({ ...c }));
  let lista = tabla;
  if (cfg?.modelo !== undefined) {
    const enTabla = tabla.find((c) => c.modelo === cfg.modelo && (cfg.ia === undefined || c.ia === cfg.ia));
    const ia = cfg.ia ?? enTabla?.ia;
    if (ia === undefined) {
      descartes.push(`la configuración pide ${cfg.modelo} pero no indica la IA`);
    } else {
      lista = [{ ia, modelo: cfg.modelo, esfuerzo: cfg.esfuerzo ?? enTabla?.esfuerzo ?? null }, ...tabla];
    }
  } else if (cfg?.ia !== undefined) {
    lista = [...tabla.filter((c) => c.ia === cfg.ia), ...tabla.filter((c) => c.ia !== cfg.ia)];
  }
  if (cfg?.esfuerzo !== undefined) {
    lista = lista.map((c) => (c.ia === 'codex' ? { ...c, esfuerzo: cfg.esfuerzo ?? c.esfuerzo } : c));
  }
  const vistos = new Set<string>();
  return lista.filter((c) => {
    const k = clave(c);
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
}

/** Devuelve el motivo del descarte, o `null` si el candidato está disponible. */
export function descarte(c: Candidato, catalogos: Catalogos): string | null {
  // Las estaciones de Claude son subagentes nativos: no dependen de un catálogo vivo.
  if (c.ia === 'claude') return null;
  const catalogo = catalogos[c.ia];
  if (catalogo === undefined) return `no hay catálogo de ${c.ia}`;
  const entrada = catalogo.find((m) => m.modelo === c.modelo);
  if (entrada === undefined) return `${c.modelo} no está en el catálogo de ${c.ia}`;
  if (c.ia === 'codex') {
    // El catálogo no declara un esfuerzo por defecto: sin esfuerzo no se puede proponer.
    if (c.esfuerzo === null) return `${c.modelo} necesita un esfuerzo en codex y no se indicó ninguno`;
    if (!entrada.esfuerzos.includes(c.esfuerzo)) return `${c.modelo} no admite el esfuerzo ${c.esfuerzo} en ${c.ia}`;
  }
  return null;
}

/**
 * Órdenes de una estación: las de la tabla de estaciones más las de la configuración del repo.
 * Solo Codex ejecuta órdenes; Antigravity las rechaza todas y Claude no pasa por un conector.
 */
function ordenesDe(estacion: NombreEstacion, ia: IA, cfg: ConfigEstacion | undefined): string[] {
  if (ia !== 'codex') return [];
  return [...new Set([...ESTACIONES[estacion].ordenesPermitidas, ...(cfg?.ordenesPermitidas ?? [])])];
}

/** Llamadas externas y subagentes de Claude de las estaciones propuestas. */
export function calcularCoste(estaciones: EstacionRecorrido[]): Recorrido['coste'] {
  let llamadasExternas = 0;
  let subagentesClaude = 0;
  for (const e of estaciones) {
    if (e.estado !== 'propuesta') continue;
    if (e.ia === 'claude') subagentesClaude += 1;
    else llamadasExternas += 1;
  }
  return { llamadasExternas, subagentesClaude };
}

function catalogoClaudeDeLaTabla(): Array<{ modelo: string; esfuerzos: string[] }> {
  const nombres = new Set<string>();
  for (const candidatos of Object.values(TABLA_MODELOS_INICIAL)) {
    for (const c of candidatos) if (c.ia === 'claude') nombres.add(c.modelo);
  }
  return [...nombres].map((modelo) => ({ modelo, esfuerzos: [] }));
}

const NOTA_CLAUDE = 'la ejecuta la sesión de Claude';
const NOTA_FIJADA = 'fijado en .nexakit/fabrica.json';
const ORDEN_BANCO = 'ejecuta `nexakit fabrica banco planificar`';

const nombreDe = (c: Candidato): string => (c.esfuerzo === null ? c.modelo : `${c.modelo} ${c.esfuerzo}`);

/** `true` si el par está en el catálogo vivo: Codex con uno de sus esfuerzos y Antigravity sin esfuerzo aparte. */
function parVivo(c: Candidato, catalogos: Catalogos): boolean {
  if (c.ia === 'claude' || (c.ia === 'antigravity' && c.esfuerzo !== null)) return false;
  return descarte(c, catalogos) === null;
}

/**
 * Candidatos de una estación externa: los de la tabla manual, en su orden, y después los pares vivos del catálogo
 * que tienen fila de evidencia para la estación. Sin repetidos.
 */
function candidatosConEvidencia(
  estacion: NombreEstacion,
  manual: readonly Candidato[],
  cfg: ConfigEstacion | undefined,
  catalogos: Catalogos,
  evidencia: Evidencia,
): Candidato[] {
  const medidos: Candidato[] = [];
  for (const fila of evidencia.filas) {
    if (fila.estacion !== estacion) continue;
    // Un esfuerzo fijado en la configuración también vale para los modelos que solo aparecen en la evidencia.
    if (fila.ia === 'codex' && cfg?.esfuerzo !== undefined && fila.esfuerzo !== cfg.esfuerzo) continue;
    const candidato: Candidato = { ia: fila.ia, modelo: fila.modelo, esfuerzo: fila.esfuerzo };
    if (parVivo(candidato, catalogos)) medidos.push(candidato);
  }
  const vistos = new Set<string>();
  return [...manual, ...medidos].filter((c) => {
    const k = clave(c);
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
}

/**
 * Propone el recorrido: qué estaciones se activan con este diff, y qué IA, modelo y esfuerzo usa cada una.
 * Las estaciones externas se deciden con la evidencia medida (`~/.nexakit/fabrica/evidencia.json` bajo `home`): el modelo más
 * barato que alcanza la calidad que pide el riesgo. Sin datos manda la tabla manual, y la configuración del repo
 * (`ia` o `modelo` fijados) manda siempre. Las estaciones de Claude siguen la tabla.
 */
export async function proponer(entrada: {
  raiz: string;
  base: string;
  foco?: string;
  catalogos: Catalogos;
  /** Carpeta personal donde vive `~/.nexakit`; por defecto la de la persona. */
  home?: string;
  /** Instante con el que se mide la caducidad de la evidencia; por defecto, ahora. */
  ahora?: Date;
}): Promise<Recorrido> {
  const { raiz, base, foco, catalogos, home = os.homedir(), ahora = new Date() } = entrada;
  const config = await cargarConfig(raiz);
  const diff = await leerDiff(raiz, base);
  const categorias = clasificar(diff.archivos, config);
  const { evidencia, aviso: avisoEvidencia } = await cargar(home, ahora);

  const avisosEstaciones: string[] = [];
  let usoEvidencia = false;

  const estaciones: EstacionRecorrido[] = NOMBRES_ESTACION.map((estacion): EstacionRecorrido => {
    const cfg = config.estaciones?.[estacion];
    const regla = ACTIVACION[estacion];
    const omitida = (motivo: string): EstacionRecorrido => ({
      estacion,
      ia: null,
      modelo: null,
      esfuerzo: null,
      motivo,
      descartes: [],
      explicacion: '',
      calidad: null,
      ordenesPermitidas: [],
      estado: 'omitida',
    });
    if (cfg?.activa === false) return omitida('desactivada en la configuración');
    const porDiff = regla.categoria === null || categorias.has(regla.categoria);
    if (!porDiff && cfg?.activa !== true) return omitida(regla.sinActivar);
    const motivo = porDiff ? regla.motivo : 'activada en la configuración';

    const descartes: string[] = [];
    const manual = candidatosDe(estacion, cfg, descartes);
    const propuesta = (c: Candidato, explicacion: string, calidad: number | null): EstacionRecorrido => ({
      estacion,
      ia: c.ia,
      modelo: c.modelo,
      // Antigravity lleva el esfuerzo dentro del id del modelo.
      esfuerzo: c.ia === 'antigravity' ? null : c.esfuerzo,
      motivo,
      descartes,
      explicacion,
      calidad,
      ordenesPermitidas: ordenesDe(estacion, c.ia, cfg),
      estado: 'propuesta',
    });
    const sinModelo = (): EstacionRecorrido => ({
      ...omitida(motivo),
      descartes,
      explicacion: 'ningún candidato está disponible en el catálogo',
      estado: 'sin-modelo',
    });

    const fijada = cfg?.ia !== undefined || cfg?.modelo !== undefined;
    if (fijada || manual[0]?.ia === 'claude') {
      // Lo fijado en la configuración y las estaciones de Claude no se deciden por evidencia: manda la tabla.
      for (const c of manual) {
        const razon = descarte(c, catalogos);
        if (razon !== null) {
          descartes.push(razon);
          continue;
        }
        if (!fijada) return propuesta(c, NOTA_CLAUDE, null);
        const cumple = (cfg?.ia === undefined || c.ia === cfg.ia) && (cfg?.modelo === undefined || c.modelo === cfg.modelo);
        return propuesta(c, cumple ? NOTA_FIJADA : `${NOTA_FIJADA} no está disponible; se usa ${nombreDe(c)} de la tabla`, null);
      }
      return sinModelo();
    }

    const disponibles: Candidato[] = [];
    for (const c of candidatosConEvidencia(estacion, manual, cfg, catalogos, evidencia)) {
      const razon = descarte(c, catalogos);
      if (razon === null) disponibles.push(c);
      else descartes.push(razon);
    }
    if (disponibles.length === 0) return sinModelo();

    usoEvidencia = true;
    const riesgo = riesgoDe(categorias, estacion);
    const decision = elegir({ estacion, riesgo, candidatos: disponibles, evidencia });
    if (decision.sinDatos) {
      avisosEstaciones.push(`${estacion}: sin datos medidos: ejecuta el banco con \`nexakit fabrica banco planificar\`; mientras, se usa la tabla manual`);
    } else if (!decision.alcanzaUmbral) {
      avisosEstaciones.push(
        `${estacion}: ningún modelo alcanza la calidad que pide el riesgo ${riesgo} (${String(UMBRALES[riesgo]).replace('.', ',')}): ${ORDEN_BANCO} para medir más`,
      );
    }
    return propuesta(decision.eleccion, decision.explicacion, decision.calidad);
  });

  const avisos: string[] = [];
  if (usoEvidencia) {
    if (avisoEvidencia !== null) avisos.push(avisoEvidencia);
    const vivos = Object.fromEntries(
      (Object.entries(catalogos) as Array<[IA, NonNullable<Catalogos[IA]>]>).map(([ia, catalogo]) => [ia, catalogo.map((m) => m.modelo)]),
    );
    const caducidad = evidencia.filas.length === 0 ? null : caducada(evidencia, vivos, ahora);
    if (caducidad?.caducada === true) avisos.push(`La evidencia está caducada (${caducidad.motivos.join('; ')}): ${ORDEN_BANCO}`);
  }
  avisos.push(...avisosEstaciones);

  const recorrido: Recorrido = {
    huella: calcularHuella({
      head: diff.head,
      diffSha256: diff.sha256,
      base: diff.base,
      basePedida: base,
      foco,
      estaciones,
    }),
    head: diff.head,
    base: diff.base,
    basePedida: base,
    diffSha256: diff.sha256,
    estaciones,
    coste: calcularCoste(estaciones),
    catalogos: { claude: catalogoClaudeDeLaTabla(), ...catalogos },
    avisos,
  };
  if (foco !== undefined) recorrido.foco = foco;
  return recorrido;
}

function validarEleccion(estacion: string, ia: IA, modelo: string, esfuerzo: string | null, catalogos: Catalogos): void {
  const entrada = catalogos[ia]?.find((m) => m.modelo === modelo);
  if (entrada === undefined) {
    throw new ErrorFabrica(`El modelo ${modelo} no está en el catálogo de ${ia} (estación ${estacion})`);
  }
  if (ia === 'codex') {
    if (esfuerzo === null || !entrada.esfuerzos.includes(esfuerzo)) {
      const admitidos = entrada.esfuerzos.join(', ') || 'ninguno';
      throw new ErrorFabrica(
        `El modelo ${modelo} de codex no admite el esfuerzo ${esfuerzo ?? '(sin indicar)'}; admite: ${admitidos}`,
      );
    }
  } else if (esfuerzo !== null) {
    throw new ErrorFabrica(`${ia} no usa esfuerzo aparte (estación ${estacion}); ${ia === 'antigravity' ? 'va dentro del id del modelo' : 'se elige el subagente'}`);
  }
}

/**
 * Aplica los cambios de la persona sin modificar el recorrido original y recalcula la
 * huella. Lanza `ErrorFabrica` si la estación no existe o la elección no está en el catálogo.
 */
export function aplicarCambios(recorrido: Recorrido, cambios: CambioRecorrido[]): Recorrido {
  const estaciones = structuredClone(recorrido.estaciones);
  for (const cambio of cambios) {
    const actual = estaciones.find((e) => e.estacion === cambio.estacion);
    if (actual === undefined) throw new ErrorFabrica(`La estación ${cambio.estacion} no existe en el recorrido`);

    if (cambio.quitar === true) {
      Object.assign(actual, {
        ia: null,
        modelo: null,
        esfuerzo: null,
        ordenesPermitidas: [],
        explicacion: '',
        calidad: null,
        motivo: 'quitada por la persona',
        estado: 'omitida',
      } satisfies Partial<EstacionRecorrido>);
      continue;
    }
    if (cambio.ia === undefined && cambio.modelo === undefined && cambio.esfuerzo === undefined) continue;

    const ia = cambio.ia ?? actual.ia;
    const modelo = cambio.modelo ?? actual.modelo;
    if (ia === null || modelo === null) {
      throw new ErrorFabrica(`Para activar la estación ${cambio.estacion} indica la IA y el modelo`);
    }
    const mismaIa = ia === actual.ia;
    const mismoModelo = modelo === actual.modelo;
    const esfuerzo = cambio.esfuerzo ?? (mismaIa && mismoModelo ? actual.esfuerzo : null);
    validarEleccion(cambio.estacion, ia, modelo, esfuerzo, recorrido.catalogos);
    Object.assign(actual, {
      ia,
      modelo,
      esfuerzo,
      // Solo se conserva lo que la persona vio en la propuesta y sigue valiendo para la IA nueva:
      // quien sigue en Codex mantiene sus órdenes; quien llega a Codex desde otra IA no recibe ninguna.
      // Para tener órdenes nuevas hay que volver a proponer.
      ordenesPermitidas: ia === 'codex' && actual.ia === 'codex' ? actual.ordenesPermitidas : [],
      motivo: 'cambiada por la persona',
      explicacion: 'elegida por la persona',
      calidad: null,
      estado: 'propuesta',
    } satisfies Partial<EstacionRecorrido>);
  }
  return {
    ...recorrido,
    estaciones,
    huella: calcularHuella({ ...recorrido, estaciones }),
    coste: calcularCoste(estaciones),
  };
}

/**
 * Comprueba que el recorrido sigue siendo el aprobado: la huella corresponde a su
 * contenido y el `HEAD` y el diff actuales son los mismos con los que se propuso.
 */
export async function comprobarHuella(recorrido: Recorrido, raiz: string): Promise<void> {
  if (calcularHuella(recorrido) !== recorrido.huella) throw new ErrorFabrica(MENSAJE_HUELLA);
  const actual = await leerDiff(raiz, recorrido.basePedida);
  if (actual.head !== recorrido.head || actual.sha256 !== recorrido.diffSha256) {
    throw new ErrorFabrica(MENSAJE_HUELLA);
  }
}
