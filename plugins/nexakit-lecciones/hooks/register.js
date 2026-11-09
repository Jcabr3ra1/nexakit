import { claveDeComando, claveDeError, esCorreccion, NOTA_CORRECCION } from './lecciones.js';

const REPETIR = /(^|\s)NEXAKIT_REPETIR=1(\s|$)/u;
const CAMBIAN_ESTADO = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const TOPE_MISMO_ERROR = 3;

const textoDeError = (r) => {
  const res = r?.result;
  if (typeof res === 'string') return res;
  return [res?.stderr, res?.stdout, r?.text].filter((t) => typeof t === 'string' && t.trim()).join('\n');
};

export function register(on) {
  // Por bucle (sesión principal o cada subagente): comandos que fallaron y cuántas veces salió cada tipo de error.
  const bucles = new Map();
  const bucle = (id = 'principal') => {
    if (!bucles.has(id)) bucles.set(id, { fallidos: new Map(), errores: new Map() });
    return bucles.get(id);
  };

  on('tool.call', async ($, e, next) => {
    const b = bucle(e.agentId);
    if (e.tool !== 'Bash') {
      const r = await next(e);
      if (CAMBIAN_ESTADO.has(e.tool) && !r?.isError && !r?.deny) b.fallidos.clear();
      return r;
    }

    const clave = claveDeComando(e.command);
    const previo = b.fallidos.get(clave);
    if (previo && !REPETIR.test(e.command ?? '')) {
      return { deny: `nexakit: este comando ya falló así y no ha cambiado nada desde entonces:\n${previo}\nCambia de enfoque. Si de verdad corregiste la causa por otra vía, repítelo con NEXAKIT_REPETIR=1 delante.` };
    }

    const r = await next(e);
    if (!r?.isError) {
      // Otro comando que salió bien pudo cambiar el estado (un commit, un pull): los fallos anteriores ya no valen.
      if (r && !r.deny) b.fallidos.clear();
      return r;
    }
    const error = textoDeError(r);
    b.fallidos.set(clave, error.split('\n').slice(0, 3).join('\n').slice(0, 400));
    const tipo = claveDeError(error);
    if (!tipo) return r;
    const veces = (b.errores.get(tipo) ?? 0) + 1;
    b.errores.set(tipo, veces);
    if (veces !== TOPE_MISMO_ERROR) return r;
    // Se devuelve la respuesta del motor (con su `ref`) y solo se añade la nota: un objeto rehecho sin `ref` se
    // revalida contra la forma de salida de Bash, y un error llega como texto, que esa forma rechaza.
    return {
      ...r,
      context: [...(r.context ?? []), `[nexakit: el mismo tipo de error salió ${veces} veces en esta tarea («${tipo}»). Para, explica la causa raíz antes de otro intento y cambia de enfoque; si es una lección que vale para el futuro, guárdala en tu memoria persistente.]`],
    };
  });

  on('prompt.submit', async ($, e, next) => (esCorreccion(e.text) ? next({ ...e, text: `${e.text}\n\n${NOTA_CORRECCION}` }) : next(e)));

  on('session.end', async ($, e, next) => {
    bucles.clear();
    return next(e);
  });
}
