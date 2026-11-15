/** Error esperado de la fábrica: su mensaje va dirigido a la persona, en español. */
export class ErrorFabrica extends Error {
  constructor(mensaje: string, opciones?: ErrorOptions) {
    super(mensaje, opciones);
    this.name = 'ErrorFabrica';
  }
}

/** Configuración del entorno mal formada (por ejemplo `NEXAKIT_FABRICA_CODEX`): la persona debe corregirla. */
export class ErrorEntorno extends ErrorFabrica {
  constructor(mensaje: string, opciones?: ErrorOptions) {
    super(mensaje, opciones);
    this.name = 'ErrorEntorno';
  }
}
