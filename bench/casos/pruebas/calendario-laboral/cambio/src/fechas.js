export function diasEntre(desde, hasta) {
  return Math.floor((hasta - desde) / 86_400_000);
}

export function esFinDeSemana(fecha) {
  const dia = fecha.getUTCDay();
  return dia === 0 || dia === 6;
}

export function esHabil(fecha, festivos = new Set()) {
  return !esFinDeSemana(fecha) && !festivos.has(fecha.toISOString().slice(0, 10));
}

export function sumarDiasHabiles(fecha, dias, festivos = new Set()) {
  const resultado = new Date(fecha);
  for (let restantes = dias; restantes > 0; ) {
    resultado.setUTCDate(resultado.getUTCDate() + 1);
    if (esHabil(resultado, festivos)) restantes -= 1;
  }
  return resultado;
}

export function diasHabilesEntre(desde, hasta, festivos = new Set()) {
  if (hasta < desde) throw new RangeError('La fecha final es anterior a la inicial');
  let cuenta = 0;
  for (const dia = new Date(desde); dia < hasta; dia.setUTCDate(dia.getUTCDate() + 1)) {
    if (esHabil(dia, festivos)) cuenta += 1;
  }
  return cuenta;
}

export async function cargarFestivos(url) {
  const respuesta = await fetch(url);
  if (!respuesta.ok) throw new Error(`No se pudieron cargar los festivos (${respuesta.status})`);
  const fechas = await respuesta.json();
  return new Set(fechas.map((f) => f.date));
}
