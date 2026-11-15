import type { IA, InformeEstacion, NombreEstacion } from '../esquemas.js';

export interface Encargo {
  estacion: NombreEstacion;
  modelo: string;
  esfuerzo: string | null;
  /** Raíz del repo que se revisa; el revisor trabaja ahí en solo lectura. */
  raiz: string;
  /** Commit de base del diff. */
  base: string;
  instrucciones: string;
  /** Órdenes exactas que el revisor puede ejecutar; cualquier otra se deniega. */
  ordenesPermitidas: string[];
  imagenes?: string[];
}

export interface Denegacion {
  tipo: string;
  detalle: string;
}

export interface ResultadoEstacion {
  estado: 'ok' | 'fallida' | 'cancelada';
  informe?: InformeEstacion;
  crudo: string;
  modeloInformado: string | null;
  tokens: { entrada: number; salida: number; total: number } | null;
  denegaciones: Denegacion[];
  motivo?: string;
}

/** Avance de una estación en curso: los tokens usados hasta ahora. */
export type AlProgreso = (progreso: { tokens: number }) => void;

export interface Conector {
  ia: IA;
  catalogo(): Promise<Array<{ modelo: string; esfuerzos: string[] }>>;
  ejecutar(encargo: Encargo, señal: AbortSignal, alProgreso?: AlProgreso): Promise<ResultadoEstacion>;
  cerrar(): Promise<void>;
}
