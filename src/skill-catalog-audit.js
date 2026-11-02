import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadSkillCatalog, resolveCatalogResource, SkillCatalogError } from './skill-catalog.js';
import { hashSkillFiles, readSkillFiles } from './skill-files.js';
import { scanSkillFiles } from './skill-scan.js';

// Re-exported so existing callers keep their import path.
export { hashSkillFiles, readSkillFiles };

export const DEFAULT_CATALOG_ROOT = fileURLToPath(new URL('../', import.meta.url));

// This inventory is read-only; updating the manifest remains an explicit authoring step.
export async function inventoryCatalogSkill({ toolkitRoot = DEFAULT_CATALOG_ROOT, installedPath } = {}) {
  if (!/^(?:skills|catalogs\/skills)\/[a-z0-9-]+$/u.test(installedPath ?? '')) {
    throw new SkillCatalogError('La carpeta debe ser skills/<nombre> o catalogs/skills/<nombre>.');
  }
  const root = await resolveCatalogResource(toolkitRoot, installedPath);
  return hashSkillFiles(await readSkillFiles(root, installedPath));
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
  // Anything left in catalogs/skills without an entry (an interrupted registration, a stray copy) would ship in the package.
  const listed = new Set(catalog.skills.map(skill => skill.installedPath));
  const entries = await fs.readdir(path.join(toolkitRoot, 'catalogs/skills'), { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = `catalogs/skills/${entry.name}`;
    if (!listed.has(rel)) report.warnings.push(`Carpeta sin entrada en el catálogo: ${rel}.`);
  }
  report.ok = report.errors.length === 0;
  return report;
}
