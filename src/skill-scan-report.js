// Never calls a skill "safe": the scan only reports what its rules saw.
export function formatScanReport(report, label) {
  const count = severity => report.findings.filter(f => f.severity === severity).length;
  const blocks = count('bloqueo');
  const warnings = count('aviso');
  const lines = [blocks
    ? `Escaneo de ${label}: BLOQUEADA (${blocks} bloqueos, ${warnings} avisos)`
    : `Escaneo de ${label}: sin bloqueos; ${warnings} avisos`];
  for (const f of report.findings) lines.push(`  [${f.severity}] ${f.rule} · ${f.file}:${f.line} · ${f.excerpt}`);
  const caps = Object.entries(report.capabilities).filter(([, on]) => on).map(([name]) => name);
  lines.push(`Capacidades detectadas: ${caps.length ? caps.join(', ') : 'ninguna'}`);
  lines.push('El escaneo no ejecuta la skill ni garantiza que sea útil o segura.');
  return lines.join('\n') + '\n';
}
