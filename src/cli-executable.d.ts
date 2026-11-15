// Tipos de src/cli-executable.js para el código TypeScript de la fábrica.
export interface InvocacionCli {
  executable: string;
  argsPrefix: string[];
}

export function resolveCliInvocation(opciones: {
  name: string;
  override?: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<InvocacionCli>;
