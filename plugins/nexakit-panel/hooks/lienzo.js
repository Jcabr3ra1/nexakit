// Dibuja la orquesta carácter a carácter, en posiciones fijas, como una pantalla de terminal de 104 columnas.
// Devuelve filas de tramos con estilo; la terminal (nexakit panel) y el panel de Claude los pintan igual.
import {
  alias, barra, barraEsfuerzo, duracion, estadoPorFamilia, etiquetaEnjambre, etiquetaModelo, familia, hora,
  resumenDelegacion, tituloDeOrquesta, tokens,
} from './panel.js';

export const ANCHO = 104;
export const COLOR = {
  sonnet: '#fb923c', haiku: '#60a5fa', opus: '#a78bfa', fable: '#f472b6', otro: '#9ca3af',
  ok: '#4ade80', error: '#f87171', texto: '#e5e7eb', tenue: '#6b7280', resalte: '#2e2a4a',
  codex: '#2dd4bf', antigravity: '#fbbf24', claude: '#fb923c',
};
const NOMBRE_IA = { codex: 'Codex', antigravity: 'Antigravity', claude: 'Claude' };
const colorIA = (ia) => COLOR[ia] ?? COLOR.otro;
const REVISION = { x: 84, w: 20, h: 8 };
const colorDe = (modelo) => COLOR[familia(modelo)] ?? COLOR.otro;

// Geometría, tomada de la imagen de referencia.
const CX = 66;                       // eje del flujo central
const ASESOR = { x: 2, w: 26 };
const LIDER = { w: 34, y: 4, h: 7 };
const DELEGACION = { w: 52, y: 12, h: 7 };
const SUB = { xs: [29, 54, 79], w: 24, y: 23, h: 8 };
const VUELTA = { w: 40, y: 34, h: 4 };
const REGISTRO_Y = 39;

function lienzo(alto) {
  const celdas = Array.from({ length: alto }, () => Array.from({ length: ANCHO }, () => ({ ch: ' ' })));
  const poner = (x, y, txt, estilo = {}) => {
    [...String(txt)].forEach((ch, i) => {
      const xx = x + i;
      if (y >= 0 && y < alto && xx >= 0 && xx < ANCHO) celdas[y][xx] = { ch, ...estilo };
    });
  };
  const corto = (txt, ancho) => ([...String(txt)].length <= ancho ? String(txt) : `${[...String(txt)].slice(0, Math.max(0, ancho - 1)).join('')}…`);
  const centro = (x, w, y, txt, estilo) => {
    const t = corto(txt, w);
    poner(x + Math.floor((w - [...t].length) / 2), y, t, estilo);
  };
  const caja = (x, y, w, h, color, titulo) => {
    const borde = { c: color };
    poner(x, y, `┌${'─'.repeat(w - 2)}┐`, borde);
    for (let i = 1; i < h - 1; i++) { poner(x, y + i, '│', borde); poner(x + w - 1, y + i, '│', borde); }
    poner(x, y + h - 1, `└${'─'.repeat(w - 2)}┘`, borde);
    if (titulo) poner(x + 4, y, `┤ ${titulo} ├`, { c: COLOR.tenue });
  };
  return { celdas, poner, centro, caja, corto };
}

// Junta las celdas contiguas con el mismo estilo en tramos.
function aTramos(celdas) {
  return celdas.map((fila) => {
    const tramos = [];
    for (const { ch, ...estilo } of fila) {
      const ultimo = tramos.at(-1);
      const clave = JSON.stringify(estilo);
      if (ultimo && ultimo.clave === clave) ultimo.t += ch;
      else tramos.push({ t: ch, ...estilo, clave });
    }
    return tramos.map(({ clave, ...resto }) => resto);
  });
}

export const texto = (filas) => filas.map((tramos) => tramos.map((x) => x.t).join(''));

export function dibujar(estado, { ahora, uso, carpeta = '', filasMax, asesorModelo = null, esEjemplo = false, codex = null } = {}) {
  const s = estado;
  const vacio = s.pasos === 0 && s.agentes.length === 0 && s.registro.length === 0;
  const medidores = medidoresDeUso(uso);

  if (vacio) {
    const L = lienzo(codex ? 8 : 7);
    L.centro(0, ANCHO, 0, 'NEXAKIT · ORQUESTA', { c: COLOR.opus, b: true });
    L.poner(2, 1, '═'.repeat(ANCHO - 4), { c: COLOR.tenue });
    L.centro(0, ANCHO, 3, 'Aún no hay actividad en esta sesión.', { c: COLOR.texto });
    L.centro(0, ANCHO, 4, 'Trabaja con normalidad: este panel se llena solo.', { c: COLOR.tenue });
    if (medidores.length) pintarMedidores(L, 6, medidores);
    if (codex) pintarCodex(L, medidores.length ? 7 : 6, codex, ahora);
    return { filas: aTramos(L.celdas), ancho: ANCHO, alto: codex ? 8 : 7 };
  }

  // El registro ocupa lo que sobre: entre 1 y 8 líneas (4 por defecto, como la referencia).
  // Filas fijas: hasta el registro, sus dos bordes, una en blanco, la orden, el estado y el uso si lo hay.
  const lineaModelo = s.lider.modelo ? modeloFrenteARecomendado(s) : null;
  const fijas = REGISTRO_Y + 2 + 3 + (medidores.length ? 1 : 0) + (lineaModelo ? 1 : 0) + (codex ? 1 : 0);
  const lineasRegistro = Math.max(1, Math.min(8, filasMax ? filasMax - fijas : 4, s.registro.length || 1));
  const alto = fijas + lineasRegistro;
  const L = lienzo(alto);
  const r = resumenDelegacion(s.agentes);
  const lider = etiquetaModelo(s.lider.modelo);
  const cLider = colorDe(s.lider.modelo);
  const enjambre = etiquetaEnjambre(s.agentes);
  const cEnjambre = s.agentes.length ? colorDe([...s.agentes].reverse().find((a) => etiquetaModelo(a.modelo) === enjambre)?.modelo) : COLOR.haiku;

  // ---- Cabecera
  const titulo = tituloDeOrquesta(s);
  const x0 = Math.floor((ANCHO - [...titulo].length) / 2);
  let x = x0;
  for (const [i, parte] of titulo.split(' · ').entries()) {
    const sep = i === 0 ? '' : ' · ';
    L.poner(x, 0, sep, { c: COLOR.tenue }); x += sep.length;
    const color = /DIRIGE/.test(parte) ? cLider : /ENJAMBRE/.test(parte) ? cEnjambre : COLOR.texto;
    L.poner(x, 0, parte, { c: color, b: true }); x += [...parte].length;
  }
  L.poner(2, 1, '═'.repeat(ANCHO - 4), { c: COLOR.tenue });
  if (esEjemplo) L.centro(0, ANCHO, 3, 'EJEMPLO · datos ficticios para ver el diseño', { c: '#facc15', b: true });
  const leyenda = [];
  if (s.lider.modelo) leyenda.push([`${lider.toLowerCase()} · líder`, cLider]);
  if (enjambre) leyenda.push([`${enjambre.toLowerCase()} · enjambre`, cEnjambre]);
  leyenda.push(['delegación', COLOR.ok], ['asesor', COLOR.opus]);
  const revision = (s.revisiones ?? []).at(-1);
  if (revision) leyenda.push([`${revision.ia} · revisa`, colorIA(revision.ia)]);
  x = 4;
  for (const [txt, color] of leyenda) { L.poner(x, 2, '■', { c: color }); L.poner(x + 2, 2, txt, { c: COLOR.texto }); x += [...txt].length + 7; }

  // ---- Líder
  const lx = CX - LIDER.w / 2;
  L.caja(lx, LIDER.y, LIDER.w, LIDER.h, cLider);
  L.centro(lx + 1, LIDER.w - 2, LIDER.y + 1, `${lider} · sesión principal`, { c: cLider, b: true });
  L.centro(lx + 1, LIDER.w - 2, LIDER.y + 2, `pasos ${s.pasos} · herramientas ${s.lider.herramientas ?? 0}`, { c: COLOR.texto });
  L.centro(lx + 1, LIDER.w - 2, LIDER.y + 3, `leídos ${tokens(s.lider.leidos)} · escritos ${tokens(s.lider.escritos)}`, { c: COLOR.texto });
  const esf = `esfuerzo ${barraEsfuerzo(s.lider.esfuerzo)} ${s.lider.esfuerzo ?? ''}`.trimEnd();
  L.centro(lx + 1, LIDER.w - 2, LIDER.y + 4, esf, { c: COLOR.texto });
  L.centro(lx + 1, LIDER.w - 2, LIDER.y + 5, `--model ${alias(s.lider.modelo)}`, { c: COLOR.tenue });

  // ---- Revisión externa (a la derecha del líder)
  if (revision) {
    const c = colorIA(revision.ia);
    L.poner(lx + LIDER.w, LIDER.y + 3, '▶', { c });
    L.caja(REVISION.x, LIDER.y, REVISION.w, REVISION.h, c);
    const dentro = (y, txt, estilo) => L.centro(REVISION.x + 1, REVISION.w - 2, y, txt, estilo);
    dentro(LIDER.y + 1, 'REVISIÓN', { c, b: true });
    dentro(LIDER.y + 2, NOMBRE_IA[revision.ia] ?? revision.ia, { c });
    dentro(LIDER.y + 3, revision.respondio ?? revision.modelo ?? 'modelo ?', { c: COLOR.texto });
    dentro(LIDER.y + 4, revision.esfuerzo ? `esfuerzo ${revision.esfuerzo}` : '', { c: COLOR.tenue });
    const t = duracion((revision.fin ?? ahora) - revision.inicio);
    const est = revision.estado === 'lista' ? [`✓ lista · ${t}`, COLOR.ok] : revision.estado === 'error' ? ['✗ falló', COLOR.error] : [`◐ revisando ${t}`, c];
    dentro(LIDER.y + 5, est[0], { c: est[1] });
    const total = (revision.entrada ?? 0) + (revision.salida ?? 0);
    dentro(LIDER.y + 6, total ? `tokens ${tokens(total)}` : 'tokens —', { c: COLOR.tenue });
  }

  // ---- Delegación
  const dx = CX - DELEGACION.w / 2;
  L.poner(CX, LIDER.y + LIDER.h, '┊', { c: COLOR.tenue });
  L.caja(dx, DELEGACION.y, DELEGACION.w, DELEGACION.h, COLOR.ok);
  L.poner(dx + 2, DELEGACION.y + 1, 'DELEGACIÓN · subagentes', { c: COLOR.ok, b: true });
  L.poner(dx + DELEGACION.w - 3 - String(r.total).length, DELEGACION.y + 1, String(r.total), { c: COLOR.texto, b: true });
  const filaD = (y, nombre, n, color) => {
    L.poner(dx + 2, y, nombre, { c: COLOR.texto });
    L.poner(dx + 15, y, barra(r.total ? n / r.total : 0, 22), { c: color });
    L.poner(dx + 39, y, `${n}/${r.total}`, { c: COLOR.texto });
  };
  filaD(DELEGACION.y + 2, 'listos', r.listos, COLOR.ok);
  filaD(DELEGACION.y + 3, 'corriendo', r.corriendo, cEnjambre);
  filaD(DELEGACION.y + 4, 'con error', r.errores, COLOR.error);
  const tokSub = s.agentes.reduce((n, a) => n + a.leidos, 0);
  L.poner(dx + 2, DELEGACION.y + 5, `herramientas ${r.herramientas} · tokens leídos ${tokens(tokSub)}`, { c: COLOR.ok });

  // ---- Delegar y subagentes
  const dy = DELEGACION.y + DELEGACION.h;
  L.poner(CX, dy, '┊', { c: COLOR.tenue });
  const frase = `delegar a subagentes · ${enjambre ?? '—'}`;
  const fx = CX - Math.floor([...frase].length / 2);
  L.poner(fx, dy + 1, 'delegar a subagentes · ', { c: COLOR.texto });
  L.poner(fx + 'delegar a subagentes · '.length, dy + 1, enjambre ?? '—', { c: cEnjambre, b: true });
  const visibles = s.agentes.slice(-3);
  const centros = SUB.xs.slice(0, Math.max(1, visibles.length)).map((x1) => x1 + SUB.w / 2);
  const by = SUB.y - 2;
  if (visibles.length > 1) {
    L.poner(centros[0], by, `┌${'─'.repeat(centros.at(-1) - centros[0] - 1)}┐`, { c: COLOR.tenue });
    L.poner(CX, by, centros.includes(CX) ? '┴' : '┴', { c: COLOR.tenue });
  } else {
    L.poner(centros[0], by, '┊', { c: COLOR.tenue });
  }
  centros.forEach((cx, i) => L.poner(cx, by + 1, i === 1 ? '●' : '▼', { c: cEnjambre }));
  const totalSub = visibles.reduce((n, a) => n + a.leidos, 0);
  visibles.forEach((a, i) => {
    const x1 = SUB.xs[i];
    const c = colorDe(a.modelo);
    L.caja(x1, SUB.y, SUB.w, SUB.h, c);
    const dentro = (y, txt, estilo) => L.centro(x1 + 1, SUB.w - 2, y, txt, estilo);
    dentro(SUB.y + 1, a.nombre, { c: COLOR.texto, b: true });
    dentro(SUB.y + 2, etiquetaModelo(a.modelo), { c });
    const parte = totalSub ? a.leidos / totalSub : 0;
    L.poner(x1 + 2, SUB.y + 3, barra(parte, 13), { c, d: a.estado === 'corriendo' && parte === 0 });
    const pct = `${Math.round(parte * 100)}%`;
    L.poner(x1 + SUB.w - 2 - pct.length, SUB.y + 3, pct, { c: COLOR.texto });
    dentro(SUB.y + 4, a.ultimo || '—', { c: COLOR.texto });
    const est = a.estado === 'listo' ? ['✓ listo', COLOR.ok] : a.estado === 'error' ? ['✗ con error', COLOR.error] : ['◐ corriendo', c];
    dentro(SUB.y + 5, est[0], { c: est[1] });
    dentro(SUB.y + 6, `leídos ${tokens(a.leidos)} · ${duracion((a.fin ?? ahora) - a.inicio)}`, { c: COLOR.tenue });
  });
  if (s.agentes.length > visibles.length) L.poner(SUB.xs[0], SUB.y + SUB.h, `+${s.agentes.length - visibles.length} más`, { c: COLOR.tenue });

  // ---- Vuelta al líder
  const my = SUB.y + SUB.h;
  if (visibles.length > 1) {
    centros.forEach((cx) => L.poner(cx, my, '│', { c: COLOR.tenue }));
    L.poner(centros[0], my + 1, `└${'─'.repeat(centros.at(-1) - centros[0] - 1)}┘`, { c: COLOR.tenue });
    L.poner(CX, my + 1, '●', { c: COLOR.texto });
  } else {
    L.poner(centros[0], my, '┊', { c: COLOR.tenue });
  }
  L.poner(CX, my + 2, '┊', { c: COLOR.tenue });
  const vx = CX - VUELTA.w / 2;
  L.caja(vx, VUELTA.y, VUELTA.w, VUELTA.h, cLider);
  L.centro(vx + 1, VUELTA.w - 2, VUELTA.y + 1, `de vuelta en ${lider} · líder`, { c: cLider, b: true });
  L.centro(vx + 1, VUELTA.w - 2, VUELTA.y + 2, r.corriendo > 0 ? `esperando ${r.corriendo} ${r.corriendo === 1 ? 'subagente' : 'subagentes'}` : 'subagentes terminados', { c: COLOR.texto });

  // ---- Asesor (columna izquierda, de arriba a la vuelta al líder)
  const ay = LIDER.y;
  const ah = VUELTA.y + VUELTA.h - ay;
  L.caja(ASESOR.x, ay, ASESOR.w, ah, COLOR.opus);
  L.centro(ASESOR.x + 1, ASESOR.w - 2, ay + 1, asesorModelo ? etiquetaModelo(asesorModelo).toUpperCase() : 'ASESOR', { c: COLOR.opus, b: true });
  L.centro(ASESOR.x + 1, ASESOR.w - 2, ay + 2, s.asesor.llamadas > 0 ? 'asesor · consultado' : 'asesor · en espera', { c: COLOR.opus });
  const consultas = s.registro.filter((e) => e.quien === 'asesor').slice(-6);
  const primera = LIDER.y + 3;
  const ultima = VUELTA.y + 1;
  const filasC = consultas.length <= 1 ? [primera]
    : consultas.map((_, i) => (i === 0 ? primera : i === consultas.length - 1 ? ultima : Math.round(primera + 5 + ((ultima - primera - 10) * i) / (consultas.length - 1))));
  const ocupadas = new Set(filasC.flatMap((y) => [y, y + 1]));
  if (consultas.length > 1) for (let y = filasC[0] + 1; y < filasC.at(-1); y++) if (!ocupadas.has(y)) L.poner(ASESOR.x + 2, y, '┊', { c: COLOR.tenue });
  consultas.forEach((c, i) => {
    const y = filasC[i];
    const final = i === consultas.length - 1;
    const estilo = final ? { c: COLOR.opus, b: true, bg: COLOR.resalte } : { c: COLOR.texto };
    if (final) L.poner(ASESOR.x + 1, y, ' '.repeat(ASESOR.w - 2), { bg: COLOR.resalte });
    L.poner(ASESOR.x + 2, y, `${final ? '◆' : '◇'} ${hora(c.t)} consulta`, estilo);
    if (c.ms) L.poner(ASESOR.x + 4, y + 1, `duró ${duracion(c.ms)}`, { c: COLOR.tenue });
  });
  if (consultas.length > 0) {
    L.poner(ASESOR.x + ASESOR.w + 1, filasC[0], `${'┈'.repeat(lx - (ASESOR.x + ASESOR.w + 1) - 2)}▶`, { c: COLOR.tenue });
    if (consultas.length > 1) L.poner(ASESOR.x + ASESOR.w + 1, filasC.at(-1), `${'┈'.repeat(vx - (ASESOR.x + ASESOR.w + 1) - 2)}▶`, { c: COLOR.tenue });
  } else {
    L.centro(ASESOR.x + 1, ASESOR.w - 2, primera, 'sin consultas', { c: COLOR.tenue });
  }
  const sy = ay + ah - 5;
  L.poner(ASESOR.x + 2, sy, 'consultas', { c: COLOR.texto });
  L.poner(ASESOR.x + ASESOR.w - 3 - String(s.asesor.llamadas).length, sy, String(s.asesor.llamadas), { c: COLOR.opus, b: true });
  L.poner(ASESOR.x + 2, sy + 1, 'tiempo', { c: COLOR.texto });
  const t = duracion(s.asesor.tiempo ?? 0);
  L.poner(ASESOR.x + ASESOR.w - 2 - [...t].length, sy + 1, t, { c: COLOR.opus });

  // ---- Registro de sesión
  const ry = REGISTRO_Y;
  L.caja(2, ry, ANCHO - 4, lineasRegistro + 2, COLOR.tenue, 'registro de sesión');
  const quienColor = (q) => (q === 'líder' ? cLider : q === 'asesor' ? COLOR.opus : colorDe(s.agentes.find((a) => a.nombre === q)?.modelo));
  s.registro.slice(-lineasRegistro).forEach((e, i) => {
    const y = ry + 1 + i;
    L.poner(4, y, hora(e.t), { c: COLOR.tenue });
    L.poner(14, y, L.corto(e.quien, 14), { c: quienColor(e.quien), b: true });
    const [herramienta, ...resto] = e.texto.split(' · ');
    if (resto.length && /^[A-Z]/.test(herramienta) && !/^(empieza|terminó|consultado)/.test(e.texto)) {
      L.poner(30, y, L.corto(herramienta, 14), { c: COLOR.texto });
      L.poner(46, y, `→ ${L.corto(resto.join(' · '), 52)}`, { c: COLOR.texto });
    } else {
      L.poner(30, y, L.corto(e.texto, 68), { c: COLOR.texto });
    }
  });

  // ---- Orden y estado
  const oy = ry + lineasRegistro + 3;
  const prefijo = `~/${carpeta || ''} $ `.replace('~/ $', '~ $');
  L.poner(2, oy, prefijo, { c: COLOR.tenue });
  L.poner(2 + [...prefijo].length, oy, `claude --model ${alias(s.lider.modelo)}${asesorModelo ? ` --advisor ${alias(asesorModelo)}` : ''}`, { c: COLOR.texto, b: true });
  x = 2;
  for (const etiqueta of estadoPorFamilia(s)) {
    const m = etiqueta.match(/^(.*?) \[(.*)\]$/u);
    L.poner(x, oy + 1, `${m[1]} `, { c: COLOR.tenue }); x += m[1].length + 1;
    const c = /enjambre/.test(m[2]) ? cEnjambre : /consultado/.test(m[2]) ? COLOR.opus : /error/.test(m[2]) ? COLOR.error : COLOR.ok;
    L.poner(x, oy + 1, `[${m[2]}]`, { c, b: true }); x += m[2].length + 2 + 3;
  }
  let ly = oy + 2;
  if (medidores.length) pintarMedidores(L, ly++, medidores);
  if (lineaModelo) {
    L.poner(2, ly, lineaModelo.actual, { c: COLOR.texto });
    L.poner(2 + [...lineaModelo.actual].length, ly, lineaModelo.cola, { c: lineaModelo.coincide ? COLOR.ok : '#facc15', b: !lineaModelo.coincide });
    ly++;
  }
  if (codex) pintarCodex(L, ly, codex, ahora);

  return { filas: aTramos(L.celdas), ancho: ANCHO, alto };
}

// ---- Uso y modelo, como las líneas de estado de nexakit-sesion y nexakit-modelo, pero con barras
const esNumero = (v) => typeof v === 'number' && Number.isFinite(v);
export function medidoresDeUso(uso) {
  const m = [];
  if (esNumero(uso?.context?.percent)) m.push(['contexto', uso.context.percent]);
  for (const l of uso?.rateLimits ?? []) {
    if (!esNumero(l?.percentUsed)) continue;
    if (l.kind === 'five_hour') m.push(['5 h', l.percentUsed]);
    if (l.kind === 'seven_day') m.push(['semana', l.percentUsed]);
  }
  return m;
}
const colorDeNivel = (p) => (p >= 85 ? COLOR.error : p >= 60 ? '#facc15' : COLOR.ok);
function pintarMedidores(L, y, medidores) {
  let x = 2;
  for (const [nombre, p] of medidores) {
    L.poner(x, y, nombre, { c: COLOR.tenue }); x += [...nombre].length + 1;
    L.poner(x, y, barra(p / 100, 10), { c: colorDeNivel(p) }); x += 11;
    const pct = `${Math.round(p)} %`;
    L.poner(x, y, pct, { c: COLOR.texto, b: true }); x += pct.length + 4;
  }
}
const hace = (ms) => (ms < 60_000 ? `hace ${Math.max(0, Math.round(ms / 1000))} s` : ms < 3_600_000 ? `hace ${Math.round(ms / 60_000)} min` : `hace ${Math.round(ms / 3_600_000)} h`);
// Uso de Codex leído de su propia sesión: tokens, límites y cuándo fue la última actividad.
function pintarCodex(L, y, codex, ahora) {
  let x = 2;
  const cabeza = `codex ${codex.modelo ?? '?'}${codex.esfuerzo ? ` · ${codex.esfuerzo}` : ''}`;
  L.poner(x, y, cabeza, { c: COLOR.codex, b: true }); x += [...cabeza].length + 2;
  const tok = `leídos ${tokens(codex.leidos)} · escritos ${tokens(codex.escritos)}`;
  L.poner(x, y, tok, { c: COLOR.texto }); x += [...tok].length + 2;
  for (const [nombre, p] of [['5 h', codex.limite5h], ['semana', codex.limiteSemana]]) {
    if (!esNumero(p)) continue;
    L.poner(x, y, nombre, { c: COLOR.tenue }); x += [...nombre].length + 1;
    L.poner(x, y, barra(p / 100, 5), { c: colorDeNivel(p) }); x += 6;
    const pct = `${Math.round(p)} %`;
    L.poner(x, y, pct, { c: COLOR.texto, b: true }); x += pct.length + 2;
  }
  if (esNumero(codex.actualizado)) L.poner(x, y, hace(ahora - codex.actualizado), { c: COLOR.tenue });
}

export function modeloFrenteARecomendado(s) {
  const actual = `modelo ${s.lider.modelo} · ${s.lider.esfuerzo ?? 'esfuerzo ?'}`;
  const rec = s.recomendacion;
  if (!rec) return { actual, cola: '', coincide: true };
  const coincide = familia(s.lider.modelo) === familia(rec.modelo) && s.lider.esfuerzo === rec.esfuerzo;
  return { actual, cola: coincide ? ' ✓' : ` → recomendado: ${rec.modelo} · ${rec.esfuerzo}`, coincide };
}

// Para el panel de Claude: los espacios sin estilo se pegan al tramo vecino, para no dejar textos solo de espacios.
export function tramosParaPanel(filas) {
  return filas.map((tramos) => {
    const salida = [];
    let pendiente = '';
    for (const t of tramos) {
      const soloEspacio = /^ +$/u.test(t.t) && !t.bg && !t.c;
      if (soloEspacio) {
        if (salida.length) salida.at(-1).t += t.t;
        else pendiente += t.t;
        continue;
      }
      salida.push({ ...t, t: pendiente + t.t });
      pendiente = '';
    }
    if (pendiente) salida.push({ t: pendiente });
    return salida;
  });
}

// ---- A ANSI para la terminal
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const a256 = ([r, g, b]) => 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5);
const a16 = ([r, g, b]) => {
  const brillo = (r + g + b) / 3 > 140 ? 60 : 0;
  return 30 + brillo + (r > 127 ? 1 : 0) + (g > 127 ? 2 : 0) + (b > 127 ? 4 : 0);
};
function sgr(tramo, nivel) {
  const partes = [];
  if (tramo.b) partes.push('1');
  if (tramo.d) partes.push('2');
  if (tramo.c) {
    const c = rgb(tramo.c);
    partes.push(nivel === 'truecolor' ? `38;2;${c.join(';')}` : nivel === '256' ? `38;5;${a256(c)}` : String(a16(c)));
  }
  if (tramo.bg) {
    const c = rgb(tramo.bg);
    partes.push(nivel === 'truecolor' ? `48;2;${c.join(';')}` : nivel === '256' ? `48;5;${a256(c)}` : String(a16(c) + 10));
  }
  return partes.join(';');
}
export function aAnsi(filas, nivel) {
  return filas.map((tramos) => tramos.map((t) => {
    if (nivel === 'none') return t.t;
    const codigo = sgr(t, nivel);
    return codigo ? `\x1b[${codigo}m${t.t}\x1b[0m` : t.t;
  }).join('')).join('\n');
}
