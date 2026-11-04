export type PanelAgente = {
  id: string;
  nombre: string;
  modelo: string;
  estado: 'corriendo' | 'listo' | 'error';
  inicio: number;
  fin: number | null;
  herramientas: number;
  leidos: number;
  escritos: number;
  ultimo: string;
};
export type PanelRegistro = { t: number; quien: string; texto: string; ms?: number };
export type PanelEstado = {
  lider: { modelo: string | null; esfuerzo: string | null; leidos: number; escritos: number; herramientas: number };
  agentes: PanelAgente[];
  asesor: { llamadas: number; ultimo: number | null; tiempo: number };
  registro: PanelRegistro[];
  pasos: number;
  recomendacion: { modelo: string; esfuerzo: string; motivo: string } | null;
};

declare module 'claude-code' {
  interface PluginState {
    'nexakit-panel': { panel: Shaped<PanelEstado>; demo: Shaped<boolean> };
  }
}
