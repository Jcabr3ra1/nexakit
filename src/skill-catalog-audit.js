import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadSkillCatalog, resolveCatalogResource, SkillCatalogError } from './skill-catalog.js';
import { scanSkillFiles } from './skill-scan.js';

export const DEFAULT_CATALOG_ROOT = fileURLToPath(new URL('../', import.meta.url));

// This inventory is read-only; updating the manifest remains an explicit authoring step.
export async function inventoryCatalogSkill({ toolkitRoot = DEFAULT_CATALOG_ROOT, installedPath } = {}) {
  if (!/^(?:skills|catalogs\/skills)\/[a-z0-9-]+$/u.test(installedPath ?? '')) {
    throw new SkillCatalogError('La carpeta debe ser skills/<nombre> o catalogs/skills/<nombre>.');
  }
  const root = await resolveCatalogResource(toolkitRoot, installedPath);
  return hashSkillFiles(await readSkillFiles(root, installedPath));
}

export function hashSkillFiles(files) {
  return files
    .map(file => ({ path: file.path, sha256: createHash('sha256').update(file.bytes).digest('hex') }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

// The one safe walk of a skill folder: no links, only regular files, bounded size. Never executes anything.
export async function readSkillFiles(root, label) {
  if (!(await fs.lstat(root)).isDirectory()) throw new SkillCatalogError(`No es una carpeta de skill: ${label}.`);
  const files = [];
  let totalBytes = 0;
  async function visit(dir, prefix = '') {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (rel.length > 200 || rel.split('/').length > 32) throw new SkillCatalogError(`Ruta demasiado larga en ${label}.`);
      const full = path.join(dir, entry.name);
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) throw new SkillCatalogError(`Enlace no admitido en ${label}/${rel}.`);
      if (stat.isDirectory()) await visit(full, rel);
      else if (stat.isFile()) {
        if (files.length >= 256 || stat.size > 512 * 1024 || totalBytes + stat.size > 64 * 1024 * 1024) {
          throw new SkillCatalogError(`Límite de archivos o tamaño excedido en ${label}.`);
        }
        const bytes = await fs.readFile(full);
        totalBytes += bytes.length;
        files.push({ path: rel, bytes });
      } else throw new SkillCatalogError(`Archivo no regular en ${label}/${rel}.`);
    }
  }
  await visit(root);
  if (!files.some(file => file.path === 'SKILL.md')) throw new SkillCatalogError(`Falta SKILL.md en ${label}.`);
  return files;
}

export async function auditSkillCatalog({ toolkitRoot = DEFAULT_CATALOG_ROOT } = {}) {
  const report = { ok: false, skillsCount: 0, verifiedSkillsCount: 0, errors: [], warnings: [] };
  let catalog;
  try {
    const catalogPath = await resolveCatalogResource(toolkitRoot, 'catalogs/skills.json');
    catalog = await loadSkillCatalog({ catalogUrl: pathToFileURL(catalogPath) });
  } catch (error) {
    report.errors.push(error.message);
    return report;
  }
  report.skillsCount = catalog.skills.length;
  for (const skill of catalog.skills) {
    try {
      if (!/^(?:skills|catalogs\/skills)\/[a-z0-9-]+$/u.test(skill.installedPath ?? '')) {
        throw new SkillCatalogError('La carpeta debe ser skills/<nombre> o catalogs/skills/<nombre>.');
      }
      const bytes = await readSkillFiles(await resolveCatalogResource(toolkitRoot, skill.installedPath), skill.installedPath);
      const actual = hashSkillFiles(bytes);
      const expected = [...skill.files].sort((a, b) => a.path.localeCompare(b.path));
      if (actual.length !== expected.length || actual.some((file, index) => file.path !== expected[index].path || file.sha256 !== expected[index].sha256)) {
        throw new SkillCatalogError(`${skill.name}: inventario o hashes SHA-256 distintos del manifiesto.`);
      }
      report.verifiedSkillsCount++;
      const scan = scanSkillFiles(bytes);
      for (const f of scan.findings) {
        if (f.severity === 'bloqueo') report.errors.push(`${skill.name}: bloqueo del escáner (${f.rule} en ${f.file}:${f.line}).`);
        else if (f.severity === 'aviso') report.warnings.push(`${skill.name}: aviso del escáner (${f.rule} en ${f.file}:${f.line}).`);
      }
      for (const [capability, detected] of Object.entries(scan.capabilities)) {
        if (detected && skill.review.capabilities[capability] === 'none') report.warnings.push(`${skill.name}: capacidad no declarada: ${capability}.`);
      }
      if (!skill.scenarios.some(scenario => scenario.status === 'passed')) report.warnings.push(`${skill.name}: sin escenario funcional pasado; no acredita utilidad.`);
      if (skill.review.status === 'pending' || skill.review.status === 'rejected') report.warnings.push(`${skill.name}: revisión ${skill.review.status}; no puede recomendarse.`);
    } catch (error) {
      report.errors.push(error.message);
    }
  }
  report.ok = report.errors.length === 0;
  return report;
}
