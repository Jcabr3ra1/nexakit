// Vendoriza los tipos del protocolo `codex app-server` que usa el conector de la fábrica.
// Uso: npm run tipos:codex
//
// `codex app-server generate-ts` genera unos 760 archivos (más de 3 MB). Solo se copian los tipos que importa
// `src/fabrica/conectores/codex.ts` (RAICES) y los que estos necesitan, para que el repo no cargue el protocolo
// entero. Si el conector necesita un tipo nuevo, se añade a RAICES y se vuelve a ejecutar este script.
// Las importaciones se reescriben con extensión `.js`, como exige `moduleResolution: NodeNext`.
// `VERSION` guarda la salida de `codex --version` para avisar cuando la instalación cambie.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCliInvocation } from '../src/cli-executable.js';

const RAIZ_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESTINO = path.join(RAIZ_REPO, 'src', 'fabrica', 'protocolos', 'codex');

const RAICES = [
  'InitializeParams',
  'InitializeResponse',
  'ApplyPatchApprovalResponse',
  'ExecCommandApprovalParams',
  'ExecCommandApprovalResponse',
  'v2/ModelListParams',
  'v2/ModelListResponse',
  'v2/ThreadStartParams',
  'v2/TurnStartParams',
  'v2/TurnInterruptParams',
  'v2/ThreadTokenUsageUpdatedNotification',
  'v2/CommandExecutionRequestApprovalParams',
  'v2/CommandExecutionRequestApprovalResponse',
  'v2/FileChangeRequestApprovalResponse',
  'v2/PermissionsRequestApprovalResponse',
  'v2/ToolRequestUserInputResponse',
  'v2/McpServerElicitationRequestResponse',
];

const IMPORTACION = /(from\s+")(\.{1,2}\/[^"]+)(")/g;

function ejecutar(invocacion, args) {
  return execFileSync(invocacion.executable, [...invocacion.argsPrefix, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

async function principal() {
  let invocacion;
  try {
    invocacion = await resolveCliInvocation({ name: 'codex' });
  } catch {
    console.error('Codex no está instalado: instala @openai/codex y vuelve a ejecutar npm run tipos:codex.');
    process.exit(1);
  }
  const version = ejecutar(invocacion, ['--version']).trim();
  const temporal = mkdtempSync(path.join(tmpdir(), 'nexakit-tipos-codex-'));
  try {
    ejecutar(invocacion, ['app-server', 'generate-ts', '--out', temporal]);

    // Cierre transitivo de las importaciones relativas desde las raíces.
    const pendientes = [...RAICES];
    const vistos = new Map();
    while (pendientes.length > 0) {
      const relativo = pendientes.pop();
      if (vistos.has(relativo)) continue;
      const origen = path.join(temporal, `${relativo}.ts`);
      if (!existsSync(origen)) throw new Error(`El tipo ${relativo} no existe en la salida de codex ${version}.`);
      const texto = readFileSync(origen, 'utf8');
      const reescrito = texto.replace(IMPORTACION, (_todo, antes, especificador, despues) => {
        const destino = path.posix.normalize(path.posix.join(path.posix.dirname(relativo), especificador));
        pendientes.push(destino);
        return `${antes}${especificador}.js${despues}`;
      });
      vistos.set(relativo, reescrito);
    }

    rmSync(DESTINO, { recursive: true, force: true });
    for (const [relativo, texto] of vistos) {
      const archivo = path.join(DESTINO, `${relativo}.ts`);
      mkdirSync(path.dirname(archivo), { recursive: true });
      writeFileSync(archivo, texto);
    }
    writeFileSync(path.join(DESTINO, 'VERSION'), `${version}\n`);
    console.log(`Tipos de ${version}: ${vistos.size} archivos en ${path.relative(RAIZ_REPO, DESTINO)}.`);
  } finally {
    rmSync(temporal, { recursive: true, force: true });
  }
}

await principal();
