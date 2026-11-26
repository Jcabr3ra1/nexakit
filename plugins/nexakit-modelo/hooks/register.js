import { activoDeTexto, alAbortarTurno, columnaDeAgentes, columnaDeFabrica, familia, filasDeAgentes, filasDeFabrica, instruccionDeDelegar, segmentosDeBarra, sumarTokens, tokensVacios } from './barra.js';
import { ajustarPorLimite } from './decidir.js';
import { recomendarPorTexto } from './recomendar.js';

async function refrescar($, estado, { usage = false } = {}) {
  try {
    estado.model = await $.session.model();
    // El esfuerzo se observó en un modelo concreto: si cambió de modelo, ya no se sabe.
    if (familia(estado.model) !== familia(estado.modeloDelEsfuerzo)) estado.effort = null;
    if (usage) estado.usage = await $.session.usage();
  } catch {
    // Medir nunca debe romper el turno.
  }
  $.ui.invalidate('ui.render');
}

// Completa los subagentes vistos con lo que dice el motor: tipo, encargo y estado.
async function sincronizarAgentes($, agentes) {
  try {
    for (const info of await $.agent.list()) {
      const visto = agentes.get(info.id);
      if (visto) Object.assign(visto, { type: info.type, description: info.description, status: info.status });
    }
  } catch {
    // Sin lista, se conserva lo último conocido.
  }
  $.ui.invalidate('ui.render');
}

const mismaRecomendacion = (a, b) =>
  a?.model === b?.model && a?.effort === b?.effort && a?.delegar === b?.delegar;

// La caché de la conversación caduca tras un rato sin actividad: una hora con suscripción (la API informa
// límites de uso) y cinco minutos con clave de API. Con la caché fría, cambiar de modelo ya no cuesta nada extra.
const MINUTO = 60 * 1000;
const vidaDeCache = (usage) => ((usage?.rateLimits ?? []).length > 0 ? 60 : 5) * MINUTO;
const RANGO = { haiku: 0, sonnet: 1, opus: 2, fable: 3 };
const rango = (model) => RANGO[familia(model)] ?? -1;

async function medirCacheFria($, estado) {
  try {
    const fria = estado.ultimaActividad !== null && (await $.clock.now()) - estado.ultimaActividad > vidaDeCache(estado.usage);
    if (fria === estado.cacheFria) return false;
    estado.cacheFria = fria;
    return true;
  } catch {
    return false;
  }
}

async function marcarActividad($, estado) {
  try {
    estado.ultimaActividad = await $.clock.now();
    estado.cacheFria = false;
  } catch {
    // Sin reloj no se sabe si la caché está fría: se asume caliente.
  }
}

const cacheVacia = () => ({ read: 0, creation: 0, input: 0, turnos: 0 });
const tokens = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

function sumarCache(estado, usage) {
  if (!usage) return;
  const c = estado.cache;
  c.read += tokens(usage.cache_read_input_tokens);
  c.creation += tokens(usage.cache_creation_input_tokens);
  c.input += tokens(usage.input_tokens);
  c.turnos += 1;
}

// Estado vivo de la fábrica (~/.nexakit/fabrica/activo.json). Solo lectura y en abierto: cualquier fallo no da
// filas. $.fs no ofrece lstat, así que un enlace simbólico no se puede distinguir aquí (el límite de 64 KiB y
// la forma del contenido sí se comprueban, y solo se pintan datos tipados, nunca texto libre).
async function activoDeLaFabrica($) {
  try {
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'));
    if (!home) return [];
    const ruta = `${home}/.nexakit/fabrica/activo.json`;
    if (!(await $.fs.exists(ruta))) return null;
    return activoDeTexto(await $.fs.read(ruta));
  } catch {
    return null;
  }
}

const HERRAMIENTA_ENCARGO = 'mcp__nexakit-fabrica__fabrica_encargar';
const MARCA_SIN_ENCARGO = '[sin encargo]';
const MENSAJE_ENCARGO = 'Primero encarga esta implementación con fabrica_encargar (Codex o Antigravity): ahorra tokens de Claude. Si el encargo no es posible (repo sin commits, otro encargo en marcha, sin conector) o ya falló, vuelve a lanzar el subagente con [sin encargo] en la descripción.';

// Un subagente niveles:nivel-normal pedido por la sesión principal sin la marca [sin encargo].
function vetaSubagenteNormal(e) {
  if (e.agentId || e.subagent_type !== 'niveles:nivel-normal') return false;
  return !`${e.description ?? ''}\n${e.prompt ?? ''}`.toLowerCase().includes(MARCA_SIN_ENCARGO);
}

// ¿Existe la herramienta de encargos? Si no se puede saber, se asume que sí.
async function hayEncargos($) {
  try {
    return (await $.tool.list()).some((t) => t.name === HERRAMIENTA_ENCARGO);
  } catch {
    return true;
  }
}

// Una sola barra sobre el prompt con modelo, esfuerzo, recomendación y uso. Solo muestra:
// nunca cambia el modelo ni el esfuerzo de la sesión.
export function register(on) {
  const estado = { model: null, effort: null, modeloDelEsfuerzo: null, recommendation: null, enviada: null, usage: null, cache: cacheVacia(), ultimaActividad: null, cacheFria: false, rutinaSeguidas: 0, turnoActivo: false, turnoId: null, delegado: false, enviando: false, ultimoTexto: null, borrador: '' };
  // Subagentes de esta petición, por id, con el modelo y el esfuerzo que de verdad usaron.
  const agentes = new Map();

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'nexakit_recomendacion',
      description: 'Registra una recomendación de modelo y esfuerzo para mostrarla, sin cambiar la sesión.',
      inputSchema: {
        type: 'object',
        properties: { model: { type: 'string' }, effort: { type: 'string' }, reason: { type: 'string' } },
        required: ['model', 'effort', 'reason'],
        additionalProperties: false,
      },
    });
    await refrescar($, estado, { usage: true });
    return next(e);
  });

  on('tool.call', { tool: 'mcp__nexakit-modelo__nexakit_recomendacion' }, async ($, e) => {
    estado.recommendation = { model: e.model, effort: e.effort, reason: e.reason };
    estado.enviada = estado.recommendation;
    await refrescar($, estado);
    return { result: 'Recomendación mostrada; no se cambió el modelo ni el esfuerzo.' };
  });

  // La implementación de nivel normal se encarga primero (fabrica_encargar en Codex o Antigravity, que ahorra tokens de
  // Claude). Solo se veta el subagente niveles:nivel-normal lanzado por la sesión principal y sin la marca
  // [sin encargo] (para cuando el encargo no es posible o ya falló); nada más se bloquea.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (!vetaSubagenteNormal(e) || !(await hayEncargos($))) return next(e);
    return { deny: MENSAJE_ENCARGO };
  });

  // Mientras se escribe: la recomendación aparece antes de pulsar Enter, cuando todavía se puede cambiar
  // de modelo o delegar. Parte de la del último mensaje enviado, para que «ok, dale» la conserve.
  on('prompt.edit', async ($, e, next) => {
    const r = await next(e);
    try {
      estado.borrador = r?.text ?? '';
      const nueva = recomendarPorTexto(r?.text ?? '', estado.enviada);
      const cambioCache = await medirCacheFria($, estado);
      if (cambioCache || !mismaRecomendacion(nueva, estado.recommendation)) {
        estado.recommendation = nueva;
        $.ui.invalidate('ui.render');
      }
    } catch {
      // Recomendar nunca debe estorbar la escritura.
    }
    return r;
  });

  on('prompt.submit', async ($, e, next) => {
    // Lo que envía el propio botón no es un mensaje de la persona: no cambia la recomendación ni «el último mensaje».
    if (estado.enviando && e.origin?.kind === 'plugin') return next(e);
    estado.delegado = false;
    estado.ultimoTexto = e.text;
    estado.borrador = '';
    estado.recommendation = recomendarPorTexto(e.text, estado.enviada);
    estado.enviada = estado.recommendation;
    await medirCacheFria($, estado);
    // Turnos seguidos de rutina en un modelo más caro del que hace falta: al quinto se propone sesión nueva.
    const limite = Math.max(-1, ...(estado.usage?.rateLimits ?? []).map((l) => (Number.isFinite(l?.percentUsed) ? l.percentUsed : -1)));
    const necesaria = ajustarPorLimite(estado.recommendation, limite < 0 ? undefined : limite);
    estado.rutinaSeguidas = estado.model && !necesaria.delegar && rango(necesaria.model) < rango(estado.model) ? estado.rutinaSeguidas + 1 : 0;
    for (const [id, a] of agentes) if (['completed', 'idle', 'failed', 'killed'].includes(a.status)) agentes.delete(id);
    $.ui.invalidate('ui.render');
    return next(e);
  });

  // Solo un turno real de la sesión principal oculta el botón (un envío que no llega a empezar turno no lo deja bloqueado).
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      estado.turnoActivo = true;
      estado.turnoId = e.turnId ?? null;
      $.ui.invalidate('ui.render');
    }
    return next(e);
  });

  // El turno de la sesión principal se interrumpió: el botón de delegar puede volver, y también reintentarse.
  // turn.abort solo trae el id del turno: un subagente aborta el suyo, que no es el principal.
  on('turn.abort', async ($, e, next) => {
    if (alAbortarTurno(estado, e)) $.ui.invalidate('ui.render');
    return next(e);
  });

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      // El último esfuerzo visto se conserva entre turnos; el siguiente paso lo corrige si cambió.
      estado.model = e.model;
      estado.effort = e.effort ?? null;
      estado.modeloDelEsfuerzo = e.model;
      $.ui.invalidate('ui.render');
    } else {
      const nuevo = !agentes.has(e.agentId);
      const a = agentes.get(e.agentId) ?? { status: 'running' };
      agentes.set(e.agentId, Object.assign(a, { model: e.model, effort: e.effort ?? null }));
      if (nuevo) await sincronizarAgentes($, agentes);
    }
    const respuesta = yield* next(e);
    // Cada paso de un subagente trae el uso de su petición: se suma a su fila (turn.complete no se usa para
    // esto, así que nada cuenta doble). La sesión principal ya suma su caché en turn.complete.
    if (e.agentId) {
      try {
        const a = agentes.get(e.agentId);
        if (a) {
          a.tokens ??= tokensVacios();
          sumarTokens(a.tokens, respuesta?.usage);
          $.ui.invalidate('ui.render');
        }
      } catch {
        // Medir nunca debe romper el turno.
      }
    }
    return respuesta;
  });

  on('turn.complete', async ($, e, next) => {
    const r = await next(e);
    if (!e.agentId) {
      estado.turnoActivo = false;
      estado.turnoId = null;
      // Solo la sesión principal: cada subagente tiene su propia caché y no toca la de la sesión.
      sumarCache(estado, r?.usage);
      await marcarActividad($, estado);
      await refrescar($, estado, { usage: true });
      if (agentes.size > 0) await sincronizarAgentes($, agentes);
    }
    return r;
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props?.hasSurvey || !estado.model) return next(e);
    const { Box, Text, Button } = $.ui.resolve(e);
    // El botón solo en la app de escritorio, sin turno en curso, sin pulsar ya y con la caja vacía o con el mismo
    // texto del último mensaje: se delega «mi mensaje anterior», así que ni la recomendación ni el texto
    // pueden ser de otro borrador.
    const borrador = estado.borrador.trim();
    const hayBoton = Boolean(Button) && e.surface === 'desktop' && !estado.turnoActivo && !estado.delegado
      && Boolean(estado.enviada) && (borrador === '' || borrador === estado.ultimoTexto?.trim())
      && (estado.recommendation === estado.enviada || mismaRecomendacion(estado.recommendation, estado.enviada));
    const tramos = segmentosDeBarra(estado).map((s, i) => {
      if (hayBoton && s.accion === 'delegar') {
        const nivel = s.nivel;
        return h(Button, {
          key: 'delegar',
          label: s.etiqueta,
          variant: 'primary',
          onPress: async () => {
            if (estado.delegado || estado.turnoActivo || estado.enviando) return;
            Object.assign(estado, { delegado: true, turnoActivo: true, enviando: true });
            $.ui.invalidate('ui.render');
            try {
              const r = await $.prompt.submit({ text: instruccionDeDelegar(nivel) });
              if (r?.drop !== undefined) throw new Error(r.drop);
            } catch {
              // El envío no empezó: se devuelve el botón y se avisa para poder reintentar.
              Object.assign(estado, { delegado: false, turnoActivo: false });
              try {
                $.ui.toast('No se pudo enviar la delegación. Pulsa el botón de nuevo para reintentar.', { timeoutMs: 8000 });
              } catch {
                // Sin aviso, el botón vuelve igual.
              }
            } finally {
              estado.enviando = false;
              $.ui.invalidate('ui.render');
            }
          },
        });
      }
      return h(Text, { key: String(i), color: s.color, dimColor: s.dim, bold: s.bold }, s.text);
    });
    const linea = (partes, clave) => h(Box, { key: clave, flexDirection: 'row' },
      ...partes.map((s, i) => h(Text, { key: String(i), color: s.color, dimColor: s.dim, bold: s.bold }, s.text)));
    const subagentes = [...agentes.values()];
    const activo = await activoDeLaFabrica($);
    let ahora = Date.now();
    try {
      ahora = await $.clock.now();
    } catch {
      // Con el reloj local basta.
    }
    const columna = Math.max(columnaDeAgentes(subagentes), columnaDeFabrica(activo, ahora));
    const filas = [
      ...filasDeAgentes(subagentes, columna).map((f, i) => linea(f, `agente-${i}`)),
      ...filasDeFabrica(activo, ahora, columna).map((f, i) => linea(f, `fabrica-${i}`)),
    ];
    return h(Box, { flexDirection: 'column' }, h(Box, { key: 'principal', flexDirection: 'row' }, ...tramos), ...filas);
  });

  on('session.end', async ($, e, next) => {
    agentes.clear();
    Object.assign(estado, { model: null, effort: null, modeloDelEsfuerzo: null, recommendation: null, enviada: null, usage: null, cache: cacheVacia(), ultimaActividad: null, cacheFria: false, rutinaSeguidas: 0, turnoActivo: false, turnoId: null, delegado: false, enviando: false, ultimoTexto: null, borrador: '' });
    return next(e);
  });
}
