/** Error esperado de la fábrica: su mensaje va dirigido a la persona, en español. */
export class ErrorFabrica extends Error {
  constructor(mensaje: string, opciones?: ErrorOptions) {
    super(mensaje, opciones);
    this.name = 'ErrorFabrica';
  }
}
