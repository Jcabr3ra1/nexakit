// Tipos de src/model-command.js para el código TypeScript de la fábrica.
export interface ModeloDeCatalogo {
  model: string;
  efforts: string[];
  defaultEffort?: string | null;
}

export interface FilaDeNivel {
  level: string;
  effort: string;
  claude: { model: string; effort: string } | null;
  codex: { model: string; effort: string } | null;
}

export function inspectModels(opciones?: {
  homeDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  codexProfile?: string;
  runCommand?: unknown;
  includeAntigravity?: boolean;
}): Promise<{
  catalogs: { claude: ModeloDeCatalogo[]; codex: ModeloDeCatalogo[]; antigravity: ModeloDeCatalogo[] };
  levels: FilaDeNivel[];
}>;

export function recommendAntigravity(
  models: ModeloDeCatalogo[],
  nivel: { level: string; effort: string },
): { model: string; effort: string } | null;
