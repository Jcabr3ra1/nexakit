import {
  avisoPendientes, claveDeComando, claveDeError, esCorreccion, esRutaDeMemoria, leerEventos, NOTA_CORRECCION,
  pendientes, podarEventos, sinGuardar, textoSeguro,
} from './lecciones.js';

const REPETIR = /(^|\s)NEXAKIT_REPETIR=1(\s|$)/u;
const CAMBIAN_ESTADO = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const ESCRIBEN_MEMORIA = new Set(['Edit', 'Write', 'MultiEdit']);
const TOPE_MISMO_ERROR = 3;

const textoDeError = (r) => {
  const res = r?.result;
  if (typeof res === 'string') return res;
  return [res?.stderr, res?.stdout, r?.text].filter((t) => typeof t === 'string' && t.trim()).join('\n');
};

// El motor no ofrece añadir al final de un archivo: se lee el registro, se poda y se reescribe con el evento
// nuevo. Registrar nunca debe romper el turno: cualquier fallo se ignora.
async function rutaDelRegistro($) {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'));
  return home ? `${home}/.nexakit/lecciones.jsonl` : null;
}

async function leerRegistro($) {
  try {
    const ruta = await rutaDelRegistro($);
    if (!ruta || !(await $.fs.exists(ruta))) return [];
    return leerEventos(await $.fs.read(ruta));
  } catch {
    return [];
  }
}

async function apuntar($, evento) {
  try {
    const ruta = await rutaDelRegistro($);
    if (!ruta) return;
    const ahora = await $.clock.now();
    const eventos = podarEventos([...(await leerRegistro($)), { fecha: ahora, ...evento }], ahora);
    await $.fs.write(ruta, `${eventos.map((e) => JSON.stringify(e)).join('\n')}\n`);
  } catch {
    // Sin registro la lección igual se aplica; solo se pierde la estadística.
  }
}

export function register(on) {
  // Por bucle (sesión principal o cada subagente): comandos que fallaron y cuántas veces salió cada tipo de error.
  const bucles = new Map();
  const bucle = (id = 'principal') => {
    if (!bucles.has(id)) bucles.set(id, { fallidos: new Map(), errores: new Map() });
    return bucles.get(id);
  };
  // Las correcciones sin guardar de sesiones anteriores se recuerdan una vez, al primer mensaje.
  let avisoHecho = false;

  on('tool.call', async ($, e, next) => {
    const b = bucle(e.agentId);
    if (e.tool !== 'Bash') {
      const r = await next(e);
      if (CAMBIAN_ESTADO.has(e.tool) && !r?.isError && !r?.deny) b.fallidos.clear();
      // Escribir en la memoria persistente es guardar la lección: resuelve las correcciones apuntadas hasta ahora.
      if (ESCRIBEN_MEMORIA.has(e.tool) && esRutaDeMemoria(e.file_path) && !r?.isError && !r?.deny &&
          sinGuardar(await leerRegistro($)).length > 0) {
        await apuntar($, { tipo: 'guardada' });
      }
      return r;
    }

    const clave = claveDeComando(e.command);
    const previo = b.fallidos.get(clave);
    if (previo && !REPETIR.test(e.command ?? '')) {
      await apuntar($, { tipo: 'freno' });
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
    await apuntar($, { tipo: 'repeticion' });
    // Se devuelve la respuesta del motor (con su `ref`) y solo se añade la nota: un objeto rehecho sin `ref` se
    // revalida contra la forma de salida de Bash, y un error llega como texto, que esa forma rechaza.
    return {
      ...r,
      context: [...(r.context ?? []), `[nexakit: el mismo tipo de error salió ${veces} veces en esta tarea («${tipo}»). Para, explica la causa raíz antes de otro intento y cambia de enfoque; si es una lección que vale para el futuro, guárdala en tu memoria persistente.]`],
    };
  });

  on('prompt.submit', async ($, e, next) => {
    const notas = [];
    if (!avisoHecho) {
      avisoHecho = true;
      const porRecordar = pendientes(await leerRegistro($));
      if (porRecordar.length > 0) {
        notas.push(avisoPendientes(porRecordar));
        await apuntar($, { tipo: 'avisada' });
      }
    }
    if (esCorreccion(e.text)) {
      await apuntar($, { tipo: 'correccion', texto: textoSeguro(e.text) });
      notas.push(NOTA_CORRECCION);
    }
    return next(notas.length > 0 ? { ...e, text: `${e.text}\n\n${notas.join('\n')}` } : e);
  });

  on('session.end', async ($, e, next) => {
    bucles.clear();
    avisoHecho = false;
    return next(e);
  });
}
