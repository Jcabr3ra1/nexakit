import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { PanelEstado } from '../types'
import { ANCHO, dibujar, medidoresDeUso, modeloFrenteARecomendado, tramosParaPanel } from './lienzo.js'
import {
  alias, barra, barraEsfuerzo, crear, duracion, ejemplo, estadoPorFamilia, etiquetaEnjambre, etiquetaModelo, familia, hora, iniciarAgente,
  registrarAsesor, registrarHerramienta, registrarPaso, registrarRecomendacion, registrarUso, resumenDelegacion, sinSecretos,
  esRevision, iniciarRevision, leerSalidaRevision, terminarRevision, terminarAgente, textoDeUso, tituloDeOrquesta,
} from './panel.js'

const PANE = 'panel'
const TITULO = 'Orquesta'
// Desde este ancho cabe el diagrama de varias columnas; por debajo se dibuja una lista vertical.
const ANCHO_DIAGRAMA = ANCHO
const RECOMENDACION = 'mcp__nexakit-modelo__nexakit_recomendacion'
// Cambia la etiqueta cuando cambien los campos del estado: descarta lo que guardó una versión anterior.
const panel = atom({ plugin: 'nexakit-panel', key: 'panel' } as const, crear() as PanelEstado, { shape: 'panel-4' })
// Con `/panel-demo` el panel enseña datos de ejemplo (marcados como tales) sin tocar los reales.
const demo = atom({ plugin: 'nexakit-panel', key: 'demo' } as const, false, { shape: 'demo-1' })

const COLOR = {
  sonnet: '#fb923c', haiku: '#60a5fa', opus: '#a78bfa', fable: '#f472b6', otro: '#9ca3af', ok: '#4ade80', error: '#f87171', marca: '#a78bfa',
} as const
const colorDe = (modelo: string | null) => COLOR[familia(modelo) as keyof typeof COLOR] ?? COLOR.otro

// Un detalle corto de lo que hizo la herramienta, sin volcar contenido.
const breve = (entrada: Record<string, unknown>) => {
  const valor = entrada.file_path ?? entrada.command ?? entrada.pattern ?? entrada.path ?? entrada.description ?? entrada.url ?? ''
  return sinSecretos(String(valor).replace(/\s+/gu, ' ')).slice(0, 48)
}

// Foto del estado real para `nexakit panel`, que la dibuja a pantalla completa en otra división de la terminal.
async function guardarFoto($: Parameters<Parameters<Register>[0]>[1] extends never ? never : any) {
  try {
    const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
    if (!home) return
    const sesion = await $.session.id()
    const estado = await read($, panel)
    let uso = null
    try { uso = await $.session.usage() } catch { /* sin uso */ }
    let carpeta = ''
    try { carpeta = String(await $.session.cwd()).split(/[\\/]/u).filter(Boolean).pop() ?? '' } catch { /* sin carpeta */ }
    let asesorModelo: string | null = null
    try { const valor = await $.settings.get('advisorModel'); asesorModelo = typeof valor === 'string' && valor ? valor : null } catch { /* sin ajuste */ }
    const foto = JSON.stringify({ version: 1, sesion, actualizado: await $.clock.now(), carpeta, asesorModelo, uso, estado })
    const carpetaFotos = `${home}/.nexakit/panel`
    await $.fs.write(`${carpetaFotos}/${sesion}.json`, foto)
    await $.fs.write(`${carpetaFotos}/actual.json`, foto)
  } catch { /* la foto es un extra: nunca rompe la sesión */ }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'panel', description: 'Abre el panel de la orquestación de esta sesión' })
    await $.command.register({ name: 'panel-demo', description: 'Activa o desactiva datos de ejemplo en el panel, para ver el diseño' })
    void $.ui.open({ id: PANE, title: TITULO, columns: ANCHO_DIAGRAMA })
    return next(e)
  })

  on('command.run', { command: 'panel' }, async $ => {
    await $.ui.open({ id: PANE, title: TITULO, columns: ANCHO_DIAGRAMA })
    return { text: 'Panel de la orquestación abierto.' }
  })

  on('command.run', { command: 'panel-demo' }, async $ => {
    const activo = !(await read($, demo))
    await update($, demo, () => activo)
    await $.ui.open({ id: PANE, title: TITULO, columns: ANCHO_DIAGRAMA })
    return { text: activo ? 'Panel con datos de ejemplo (ficticios). Repite /panel-demo para volver a los reales.' : 'Panel con los datos reales de la sesión.' }
  })

  on('turn.step', async function* ($, e, next) {
    try {
      await update($, panel, s => registrarPaso(s, { modelo: e.model, esfuerzo: e.effort == null ? null : String(e.effort), agentId: e.agentId }))
    } catch { /* observar nunca debe romper la sesión */ }
    const result = yield* next(e)
    try {
      const asesor = (result?.serverToolUses ?? []).filter(uso => uso.name === 'advisor')
      const at = await $.clock.now()
      const usage = result?.usage ?? null
      const agentId = e.agentId
      await update($, panel, s => {
        let siguiente = registrarUso(s, { agentId, usage })
        if (asesor.length > 0) {
          const tiempo = asesor.reduce((n, u) => n + Math.max(0, (u.endedAt ?? u.startedAt) - u.startedAt), 0)
          siguiente = registrarAsesor(siguiente, { llamadas: asesor.length, at, tiempo })
        }
        return siguiente
      })
    } catch { /* idem */ }
    await guardarFoto($)
    return result
  })

  on('agent.spawn', async ($, e, next) => {
    const salida = await next(e)
    try {
      if ('agentId' in salida && salida.agentId) {
        const at = await $.clock.now()
        const id = salida.agentId
        const nombre = e.name ?? e.subagentType ?? e.description ?? 'agente'
        await update($, panel, s => iniciarAgente(s, { id, nombre: String(nombre).slice(0, 24), modelo: salida.model ?? '', at }))
        await guardarFoto($)
      }
    } catch { /* idem */ }
    return salida
  })

  on('turn.complete', async ($, e, next) => {
    try {
      if (e.agentId) {
        const at = await $.clock.now()
        const id = e.agentId
        await update($, panel, s => terminarAgente(s, { id, ok: e.reason === 'answer', at }))
      }
      await guardarFoto($)
    } catch { /* idem */ }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const entrada = e as unknown as Record<string, unknown>
    let revision: { id: string } | null = null
    try {
      const at = await $.clock.now()
      const detalle = breve(entrada)
      const pedida = e.tool === 'Bash' ? esRevision(entrada.command) : null
      if (pedida) revision = { id: String(entrada.tool_use_id ?? at) }
      await update($, panel, s => {
        let siguiente = registrarHerramienta(s, { tool: e.tool, detalle, agentId: e.agentId, at })
        if (e.tool === RECOMENDACION) {
          siguiente = registrarRecomendacion(siguiente, { modelo: String(entrada.model ?? ''), esfuerzo: String(entrada.effort ?? ''), motivo: String(entrada.reason ?? '') })
        }
        if (pedida && revision) siguiente = iniciarRevision(siguiente, { id: revision.id, ...pedida, at })
        return siguiente
      })
      await guardarFoto($)
    } catch { /* idem */ }
    const resultado = await next(e)
    if (revision) {
      try {
        const at = await $.clock.now()
        const r = resultado as { result?: { stdout?: string }; text?: string; isError?: boolean; deny?: string }
        const cifras = leerSalidaRevision(r?.result?.stdout ?? r?.text ?? '')
        const id = revision.id
        await update($, panel, s => terminarRevision(s, { id, ok: !r?.isError && !r?.deny, at, cifras }))
        await guardarFoto($)
      } catch { /* idem */ }
    }
    return resultado
  })

  on('session.end', async ($, e, next) => {
    try { await update($, panel, () => crear() as PanelEstado) } catch { /* idem */ }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const ahora = await $.clock.now()
    const esEjemplo = await read($, demo)
    const s = esEjemplo ? ejemplo(ahora) : await read($, panel)
    let uso = null
    try { uso = await $.session.usage() } catch { /* sin datos de uso: el panel sigue */ }
    let carpeta = ''
    try { carpeta = String(await $.session.cwd()).split('/').filter(Boolean).pop() ?? '' } catch { /* sin directorio */ }
    const linea = textoDeUso(uso)
    const ancho = (e.props as { bodyColumns?: number } | undefined)?.bodyColumns ?? e.viewport?.columns ?? 80
    const filas = Math.max(6, (e.viewport?.rows ?? 30) - 4)
    const vacio = !esEjemplo && s.pasos === 0 && s.agentes.length === 0 && s.registro.length === 0
    const quienColor = (quien: string) => {
      if (quien === 'líder') return colorDe(s.lider.modelo)
      if (quien === 'asesor') return COLOR.opus
      const agente = s.agentes.find(a => a.nombre === quien)
      return agente ? colorDe(agente.modelo) : COLOR.otro
    }

    let asesorModelo: string | null = null
    try { const valor = await $.settings.get('advisorModel'); asesorModelo = typeof valor === 'string' && valor ? valor : null } catch { /* sin ajuste */ }

    // ---- Diagrama exacto, carácter a carácter, cuando cabe -------------------------------------------------
    if (ancho >= ANCHO) {
      const { filas: lineas } = dibujar(s, { ahora, uso, carpeta, filasMax: e.viewport?.rows, asesorModelo, esEjemplo })
      return (
        <Box flexDirection="column">
          {tramosParaPanel(lineas).map(tramos => (
            <Box flexDirection="row">
              {tramos.map(t => (
                <Text mono wrap="truncate" color={t.c} bold={t.b} dimColor={t.d} backgroundColor={t.bg}>{t.t}</Text>
              ))}
            </Box>
          ))}
        </Box>
      )
    }

    // ---- Versión estrecha: lista vertical, con aviso de cómo ver el diagrama ------------------------------
    {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold color={COLOR.marca}>NEXAKIT · ORQUESTA</Text>
          {esEjemplo && <Text color="#facc15">EJEMPLO · datos ficticios para ver el diseño</Text>}
          <Text dimColor>{`El diagrama completo necesita ${ANCHO} columnas (ahora ${ancho}). Amplía la ventana o el panel.`}</Text>
          {vacio && <Text dimColor>Aún no hay actividad en esta sesión.</Text>}

          {s.lider.modelo && (
            <Box flexDirection="column" borderStyle="round" borderColor={colorDe(s.lider.modelo)} paddingX={1}>
              <Text bold color={colorDe(s.lider.modelo)}>{`${etiquetaModelo(s.lider.modelo)} · sesión principal`}</Text>
              <Text>{`esfuerzo ${barraEsfuerzo(s.lider.esfuerzo)} ${s.lider.esfuerzo ?? ''}`.trimEnd()}</Text>
            </Box>
          )}

          {s.asesor.llamadas > 0 && (
            <Box flexDirection="column" borderStyle="round" borderColor={COLOR.opus} paddingX={1}>
              <Text bold color={COLOR.opus}>{`Asesor · consultas ${s.asesor.llamadas}`}</Text>
              {s.asesor.ultimo != null && <Text dimColor>{`última a las ${hora(s.asesor.ultimo)}`}</Text>}
            </Box>
          )}

          {s.agentes.length > 0 && <Text bold>Subagentes</Text>}
          {s.agentes.map(agente => (
            <Box key={agente.id} flexDirection="column" borderStyle="round" borderColor={colorDe(agente.modelo)} paddingX={1}>
              <Text bold color={colorDe(agente.modelo)}>{agente.nombre}</Text>
              <Text dimColor>{etiquetaModelo(agente.modelo)}</Text>
              <Text color={agente.estado === 'listo' ? COLOR.ok : agente.estado === 'error' ? COLOR.error : undefined}>
                {agente.estado === 'listo' ? '✓ listo' : agente.estado === 'error' ? '✗ con error' : '● corriendo'}
              </Text>
              <Text dimColor>{`${agente.herramientas} herramientas · ${duracion((agente.fin ?? ahora) - agente.inicio)}`}</Text>
            </Box>
          ))}

          {s.registro.length > 0 && (
            <Box flexDirection="column" borderStyle="single" borderColor={COLOR.otro} paddingX={1}>
              <Text bold dimColor>registro</Text>
              {s.registro.slice(-filas).map(r => (
                <Text>{`${hora(r.t)}  ${r.quien}  ${r.texto}`}</Text>
              ))}
            </Box>
          )}

          {medidoresDeUso(uso).length > 0 && <Text dimColor>{medidoresDeUso(uso).map(([n, p]) => `${n} ${barra(p / 100, 8)} ${Math.round(p)} %`).join('   ')}</Text>}
          {s.lider.modelo && (() => { const m = modeloFrenteARecomendado(s); return <Text color={m.coincide ? COLOR.ok : '#facc15'}>{`${m.actual}${m.cola}`}</Text> })()}
        </Box>
      )
    }
  })
}
