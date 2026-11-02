import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadSkillCatalog, resolveCatalogResource, SkillCatalogError, validateSkillCatalog } from './skill-catalog.js';
import { auditSkillCatalog, hashSkillFiles, readSkillFiles } from './skill-catalog-audit.js';
import { scanSkillFiles } from './skill-scan.js';

// The judgment fields come from the reviewer; hashes, paths and scenarios are always computed here.
const JUDGMENT_FIELDS = ['name', 'summary', 'repository', 'sourcePath', 'revision', 'license', 'matching', 'overlapsWith', 'review'];

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function diffFiles(before, after) {
  const old = new Map(before.map(f => [f.path, f.sha256]));
  const next = new Map(after.map(f => [f.path, f.sha256]));
  return {
    added: after.filter(f => !old.has(f.path)).map(f => f.path),
    changed: after.filter(f => old.has(f.path) && old.get(f.path) !== f.sha256).map(f => f.path),
    removed: before.filter(f => !next.has(f.path)).map(f => f.path)
  };
}

export async function addCatalogSkill({ toolkitRoot, sourceDir, entry, apply = false, audit = auditSkillCatalog }) {
  const extra = Object.keys(entry ?? {}).filter(key => !JUDGMENT_FIELDS.includes(key));
  if (extra.length) throw new SkillCatalogError(`La entrada no admite el campo ${extra[0]}: se calcula al registrar.`);
  if (!/^[a-z0-9-]+$/u.test(entry.name ?? '')) throw new SkillCatalogError('El nombre de la skill solo admite minúsculas, números y guiones.');
  if (!/^[0-9a-f]{40}$/u.test(entry.revision ?? '')) throw new SkillCatalogError('La revisión debe ser un commit de 40 caracteres hexadecimales.');

  const sourceFiles = await readSkillFiles(path.resolve(sourceDir), sourceDir);
  const scan = scanSkillFiles(sourceFiles);
  if (scan.blocked) {
    const first = scan.findings.find(f => f.severity === 'bloqueo');
    throw new SkillCatalogError(`El escáner encontró un bloqueo (${first.rule} en ${first.file}:${first.line}); no se registra.`);
  }

  const catalogPath = await resolveCatalogResource(toolkitRoot, 'catalogs/skills.json');
  const catalog = structuredClone(await loadSkillCatalog({ catalogUrl: pathToFileURL(catalogPath) }));
  const index = catalog.skills.findIndex(skill => skill.name === entry.name);
  const previous = index >= 0 ? catalog.skills[index] : null;
  const files = hashSkillFiles(sourceFiles);
  const changes = diffFiles(previous?.files ?? [], files);
  const unchanged = previous && !changes.added.length && !changes.changed.length && !changes.removed.length;
  const installedPath = `catalogs/skills/${entry.name}`;
  const next = {
    ...entry,
    bundled: true,
    installedPath,
    files,
    scenarios: unchanged ? previous.scenarios : []
  };
  if (index >= 0) catalog.skills[index] = next;
  else catalog.skills.push(next);
  catalog.updatedAt = today();
  validateSkillCatalog(catalog);

  const result = { action: previous ? 'update' : 'create', files: changes, scan, written: false };
  if (!apply) return result;

  const target = path.join(toolkitRoot, installedPath);
  const backup = `${target}.anterior-${process.pid}`;
  const catalogBefore = await fs.readFile(catalogPath);
  const hadTarget = await fs.lstat(target).then(() => true, () => false);
  if (hadTarget) await fs.rename(target, backup);
  try {
    for (const file of sourceFiles) {
      await fs.mkdir(path.dirname(path.join(target, file.path)), { recursive: true });
      await fs.writeFile(path.join(target, file.path), file.bytes);
    }
    await fs.writeFile(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
    const report = await audit({ toolkitRoot });
    if (!report.ok) throw new SkillCatalogError(`La validación del catálogo falló: ${report.errors.join(' ')}`);
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true });
    if (hadTarget) await fs.rename(backup, target);
    await fs.writeFile(catalogPath, catalogBefore);
    throw error;
  }
  if (hadTarget) await fs.rm(backup, { recursive: true, force: true });
  return { ...result, written: true };
}
