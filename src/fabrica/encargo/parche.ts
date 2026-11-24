/**
 * Análisis del parche que devuelve un encargo (`git diff --binary --no-renames`), hecho sobre los MISMOS bytes que se
 * guardan en `cambios.diff`: rutas, modos y destinos de los enlaces simbólicos salen del parche y no del disco, que la
 * IA (o un proceso que dejara vivo) podría cambiar entre el diff y la comprobación.
 */

/** Una entrada del parche: un archivo creado, cambiado o borrado. */
export interface EntradaParche {
  /** Ruta relativa, con `/`. */
  ruta: string;
  /** Modo nuevo (`120000` enlace, `160000` gitlink, `000000` borrado); `''` si el parche no lo dice. */
  modo: string;
  /** Destino del enlace simbólico (solo con modo `120000`); `null` si el parche no permite leerlo con certeza. */
  destino?: string | null;
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/**
 * Lee una ruta entrecomillada al estilo C de git (`"a/raro\"q"`) desde `inicio` (la comilla). Devuelve sus bytes y la
 * posición siguiente a la comilla de cierre, o `null` si está mal formada.
 */
function leerEntrecomillada(linea: string, inicio: number): { bytes: number[]; fin: number } | null {
  const bytes: number[] = [];
  for (let i = inicio + 1; i < linea.length; i += 1) {
    const c = linea[i] as string;
    if (c === '"') return { bytes, fin: i + 1 };
    if (c !== '\\') {
      bytes.push(c.charCodeAt(0) & 0xff);
      continue;
    }
    const s = linea[i + 1];
    if (s === undefined) return null;
    const escape = ESCAPES[s];
    if (/[0-7]/u.test(s)) {
      const octal = linea.slice(i + 1, i + 4);
      if (!/^[0-7]{3}$/u.test(octal)) return null;
      bytes.push(Number.parseInt(octal, 8) & 0xff);
      i += 3;
    } else if (escape !== undefined) {
      bytes.push(escape);
      i += 1;
    } else return null;
  }
  return null;
}

/** Texto `latin1` (un carácter por byte) a UTF-8. */
const deBytes = (texto: string): string => Buffer.from(texto, 'latin1').toString('utf8');

/**
 * Ruta de una cabecera `diff --git a/<ruta> b/<ruta>` (sin renombrados las dos son iguales). `null` si no se puede leer
 * con certeza.
 */
function rutaDeCabecera(linea: string): string | null {
  const resto = linea.slice('diff --git '.length);
  if (resto.startsWith('"')) {
    const a = leerEntrecomillada(resto, 0);
    if (a === null || resto[a.fin] !== ' ') return null;
    const segundo = resto.slice(a.fin + 1);
    const b = segundo.startsWith('"') ? leerEntrecomillada(segundo, 0) : null;
    const textoA = Buffer.from(a.bytes).toString('latin1');
    const textoB = b === null ? segundo : Buffer.from(b.bytes).toString('latin1');
    if (!textoA.startsWith('a/') || !textoB.startsWith('b/') || textoA.slice(2) !== textoB.slice(2)) return null;
    return deBytes(textoA.slice(2));
  }
  // Sin comillas: `a/<ruta> b/<ruta>`, con la misma ruta dos veces (puede llevar espacios).
  if ((resto.length - 5) % 2 !== 0 || !resto.startsWith('a/')) return null;
  const largo = (resto.length - 5) / 2;
  const ruta = resto.slice(2, 2 + largo);
  if (resto.slice(2 + largo) !== ` b/${ruta}`) return null;
  return deBytes(ruta);
}

interface Borrador {
  ruta: string;
  modo: string;
  /** Líneas del lado nuevo (contexto y añadidas) de todos los trozos. */
  nuevas: string[];
  /** La última línea nueva no acaba en salto de línea. */
  sinSaltoFinal: boolean;
  trozos: number;
  /** El primer trozo empieza en la línea 1 (o 0, archivo nuevo) del lado nuevo. */
  desdeElPrincipio: boolean;
  binario: boolean;
  valida: boolean;
}

function destinoDe(b: Borrador): string | null {
  // Un destino de enlace es una sola línea sin salto final; cualquier otra forma no se puede leer con certeza.
  if (b.binario || b.trozos !== 1 || !b.desdeElPrincipio || b.nuevas.length !== 1 || !b.sinSaltoFinal) return null;
  return deBytes(b.nuevas[0] as string);
}

/**
 * Entradas del parche, en su orden. Una cabecera que no se puede leer da una entrada con ruta `''` y modo `''`, para
 * que quien analiza falle cerrado.
 */
export function analizarParche(parche: Buffer): EntradaParche[] {
  const entradas: EntradaParche[] = [];
  let actual: Borrador | undefined;
  let enTrozo = false;
  let ultimaFueNueva = false;
  const cerrar = (): void => {
    if (actual === undefined) return;
    const entrada: EntradaParche = { ruta: actual.valida ? actual.ruta : '', modo: actual.valida ? actual.modo : '' };
    if (actual.modo === '120000') entrada.destino = actual.valida ? destinoDe(actual) : null;
    entradas.push(entrada);
    actual = undefined;
  };
  for (const linea of parche.toString('latin1').split('\n')) {
    if (linea.startsWith('diff --git ')) {
      cerrar();
      const ruta = rutaDeCabecera(linea);
      actual = { ruta: ruta ?? '', modo: '', nuevas: [], sinSaltoFinal: false, trozos: 0, desdeElPrincipio: false, binario: false, valida: ruta !== null };
      enTrozo = false;
      ultimaFueNueva = false;
      continue;
    }
    if (actual === undefined) continue;
    if (linea.startsWith('@@ ')) {
      enTrozo = true;
      actual.trozos += 1;
      const nuevo = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(linea);
      if (actual.trozos === 1) actual.desdeElPrincipio = nuevo !== null && Number(nuevo[1]) <= 1;
      ultimaFueNueva = false;
      continue;
    }
    if (enTrozo) {
      const c = linea[0];
      if (c === '+' || c === ' ') {
        actual.nuevas.push(linea.slice(1));
        actual.sinSaltoFinal = false;
        ultimaFueNueva = true;
      } else if (c === '\\') {
        if (ultimaFueNueva) actual.sinSaltoFinal = true;
      } else if (c === '-') ultimaFueNueva = false;
      continue;
    }
    // Cabecera extendida de la entrada.
    let m: RegExpExecArray | null;
    if ((m = /^new file mode (\d{6})$/u.exec(linea)) !== null) actual.modo = m[1] as string;
    else if (/^deleted file mode \d{6}$/u.test(linea)) actual.modo = '000000';
    else if ((m = /^new mode (\d{6})$/u.exec(linea)) !== null) actual.modo = m[1] as string;
    else if ((m = /^index [0-9a-f]+\.\.[0-9a-f]+ (\d{6})$/u.exec(linea)) !== null) {
      if (actual.modo === '') actual.modo = m[1] as string;
    } else if (linea === 'GIT binary patch' || linea.startsWith('Binary files ')) actual.binario = true;
  }
  cerrar();
  return entradas;
}
