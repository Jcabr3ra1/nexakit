export function diasEntre(desde, hasta) {
  return Math.floor((hasta - desde) / 86_400_000);
}

export function esFinDeSemana(fecha) {
  const dia = fecha.getUTCDay();
  return dia === 0 || dia === 6;
}
