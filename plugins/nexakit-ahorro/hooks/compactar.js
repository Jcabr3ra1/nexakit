// Recorta la salida larga de un comando antes de que entre al contexto: cada línea que entra se vuelve a pagar
// en todos los turnos siguientes. Conserva el principio, el final y las líneas que delatan un fallo.

export const LIMITE_LINEAS = 120;
const LIMITE_CARACTERES = 12000;
const CABEZA = 20;
const COLA = 40;
const MAX_FALLOS = 40;
const MAX_LINEA = 400;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;
const FALLO = /(error|fail|falla|✖|✗|not ok|exception|traceback|panic|assert|warn|denied|refused|cannot|no se pudo)/iu;

const recortarLinea = (l) => (l.length > MAX_LINEA ? `${l.slice(0, MAX_LINEA)} … (${l.length - MAX_LINEA} caracteres más)` : l);

export function compactarSalida(texto, { ruta } = {}) {
  const limpio = String(texto ?? '').replace(ANSI, '');
  const todas = limpio.split('\n');
  if (todas.length <= LIMITE_LINEAS && limpio.length <= LIMITE_CARACTERES) return { texto: String(texto ?? ''), omitidas: 0 };

  const cabeza = todas.slice(0, CABEZA);
  const cola = todas.length > CABEZA ? todas.slice(Math.max(CABEZA, todas.length - COLA)) : [];
  const medio = todas.slice(CABEZA, Math.max(CABEZA, todas.length - COLA));
  const vistos = new Set();
  const fallos = [];
  for (const l of medio) {
    if (!FALLO.test(l)) continue;
    const clave = l.trim();
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    if (fallos.length < MAX_FALLOS) fallos.push(l);
  }
  const omitidas = Math.max(0, medio.length - fallos.length) + todas.filter((l) => l.length > MAX_LINEA).length;
  const donde = ruta ? ` Salida completa: ${ruta}` : '';
  const aviso = `… [nexakit: ${medio.length - fallos.length} líneas omitidas de ${todas.length}.${donde} Repite con NEXAKIT_SALIDA=completa delante del comando si necesitas verla entera.]`;
  const partes = [...cabeza, aviso];
  if (fallos.length > 0) partes.push('… [líneas con posibles fallos:]', ...fallos);
  partes.push(...cola);
  return { texto: partes.map(recortarLinea).join('\n'), omitidas: Math.max(omitidas, 1) };
}
