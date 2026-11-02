import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_CATALOG_ROOT } from '../src/skill-catalog-audit.js';
import { addCatalogSkill } from '../src/skill-catalog-add.js';
import { formatScanReport } from '../src/skill-scan-report.js';

const HELP = 'Uso: npm run catalog:add -- <carpeta de skill> --entry <entrada.json> [--apply] [--root <toolkit>] [--json]\n' +
  'Sin --apply solo muestra lo que cambiaría. La entrada lleva los campos de juicio; hashes y rutas se calculan aquí.\n';

export async function runAddCatalogSkill(argv, { out = t => process.stdout.write(t), err = t => process.stderr.write(t) } = {}) {
  const options = { toolkitRoot: DEFAULT_CATALOG_ROOT, apply: false, json: false, entryPath: null, sourceDir: null };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' && argv.length === 1) { out(HELP); return 0; }
    if (seen.has(arg)) { err(HELP); return 2; }
    seen.add(arg);
    if (arg === '--apply') options.apply = true;
    else if (arg === '--json') options.json = true;
    else if ((arg === '--entry' || arg === '--root') && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      if (arg === '--entry') options.entryPath = argv[++i];
      else options.toolkitRoot = path.resolve(argv[++i]);
    } else if (!arg.startsWith('--') && !options.sourceDir) options.sourceDir = arg;
    else { err(HELP); return 2; }
  }
  if (!options.sourceDir || !options.entryPath) { err(HELP); return 2; }
  try {
    const entry = JSON.parse(await fs.readFile(options.entryPath, 'utf8'));
    const result = await addCatalogSkill({ toolkitRoot: options.toolkitRoot, sourceDir: options.sourceDir, entry, apply: options.apply });
    if (options.json) { out(JSON.stringify(result, null, 2) + '\n'); return 0; }
    const verb = result.action === 'create' ? 'Alta' : 'Actualización';
    out(`${verb} de ${entry.name}${result.written ? ' aplicada y catálogo validado.' : ' (vista previa; usa --apply para escribir).'}\n`);
    for (const [label, list] of [['Añadidos', result.files.added], ['Cambiados', result.files.changed], ['Eliminados', result.files.removed]]) {
      if (list.length) out(`${label}: ${list.join(', ')}\n`);
    }
    out(formatScanReport(result.scan, options.sourceDir));
    out('Estado de prueba: no probada (sin escenario funcional).\n');
    return 0;
  } catch (error) {
    err(`${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runAddCatalogSkill(process.argv.slice(2));
}
