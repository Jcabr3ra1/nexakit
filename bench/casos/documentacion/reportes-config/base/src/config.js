export const CONFIG_POR_DEFECTO = {
  reintentos: 3,
  tiempoEsperaMs: 30_000,
  comprimir: true,
};

export function configurar(opciones = {}) {
  return { ...CONFIG_POR_DEFECTO, ...opciones };
}

export function servidorDesdeEntorno(entorno = process.env) {
  const url = entorno.REPORTES_URL;
  if (!url) throw new Error('Falta la variable REPORTES_URL con la URL del servidor de reportes');
  return new URL(url);
}
