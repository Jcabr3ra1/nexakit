import { z } from 'zod';

export const IA = z.enum(['codex', 'antigravity', 'claude']);
export type IA = z.infer<typeof IA>;

export const NOMBRES_ESTACION = [
  'seguridad',
  'arquitectura',
  'pruebas',
  'codigo',
  'interfaz',
  'rendimiento',
  'documentacion',
] as const;
export const NombreEstacion = z.enum(NOMBRES_ESTACION);
export type NombreEstacion = z.infer<typeof NombreEstacion>;

const Nivel = z.enum(['alta', 'media', 'baja']);

export const Hallazgo = z.object({
  estacion: NombreEstacion,
  gravedad: Nivel,
  archivo: z.string(),
  linea: z.number().int().nullable(),
  categoria: z.string(),
  hallazgo: z.string(),
  evidencia: z.string(),
  propuesta: z.string(),
  confianza: Nivel,
});
export type Hallazgo = z.infer<typeof Hallazgo>;

export const InformeEstacion = z.object({
  hallazgos: z.array(Hallazgo),
  resumen: z.string(),
});
export type InformeEstacion = z.infer<typeof InformeEstacion>;

export function hallazgosJsonSchema(): object {
  return z.toJSONSchema(InformeEstacion);
}

export const ConfigFabrica = z.object({
  rutasCriticas: z.array(z.string()).optional(),
  rutasCalientes: z.array(z.string()).optional(),
  estaciones: z
    .partialRecord(
      NombreEstacion,
      z.object({
        activa: z.boolean().optional(),
        ia: IA.optional(),
        modelo: z.string().optional(),
        esfuerzo: z.string().optional(),
        ordenesPermitidas: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  paralelismo: z.number().int().min(1).max(8).default(4),
});
export type ConfigFabrica = z.infer<typeof ConfigFabrica>;

export const TablaModelos = z.record(
  NombreEstacion,
  z.array(
    z.object({
      ia: IA,
      modelo: z.string(),
      esfuerzo: z.string().nullable(),
    }),
  ),
);
export type TablaModelos = z.infer<typeof TablaModelos>;
