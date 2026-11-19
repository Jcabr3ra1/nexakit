export const CONFIG_POR_DEFECTO = {
  reintentos: 3,
  tiempoEsperaMs: 30_000,
};

export function configurar(opciones = {}) {
  return { ...CONFIG_POR_DEFECTO, ...opciones };
}
