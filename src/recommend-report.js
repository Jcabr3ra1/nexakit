// Plain-text report of `npx nexakit recommend`: what was detected and which skills fit, read-only.
export function formatRecommendationReport(report) {
  const lines = [
    `Agent Toolkit · Recomendaciones para ${report.projectName}`,
    `Raíz: ${report.projectRoot}${report.profile ? ` · Perfil: ${report.profile}` : ''}${report.client ? ` · Cliente: ${report.client}` : ''}`,
    '',
    'Tecnologías detectadas:'
  ];

  if (report.signals.length === 0) {
    lines.push('  - Ninguna tecnología cubierta detectada automáticamente.');
  } else {
    for (const sig of report.signals) {
      lines.push(`  ✓ ${sig.label} ← ${sig.sources.join(', ')}`);
    }
  }
  for (const unm of report.unmatchedSignals) {
    lines.push(`  • ${unm.label} (sin skill empaquetada aún)`);
  }

  lines.push('', `Recomendaciones con escenario probado (${report.recommended.length}):`);
  if (report.recommended.length === 0) {
    lines.push('  - Ninguna cumple todavía los 4 criterios de escenario probado para este filtro.');
  } else {
    for (const rec of report.recommended) {
      lines.push(`  - ${rec.name} (${rec.license}) ← ${rec.reasons.join(', ')} [tarea: ${rec.taskClass}]`);
    }
  }

  lines.push('', `Skills compatibles por tecnología o perfil, sin escenario validado (${report.candidates.length}):`);
  if (report.candidates.length === 0) {
    lines.push('  - Ninguna skill específica adicional coincide con las señales actuales.');
  } else {
    for (const cand of report.candidates) {
      const state = cand.installed ? ` · en proyecto: ${cand.installed.integrity}` : '';
      lines.push(`  - ${cand.name} (${cand.license}, SHA-256 ✓) ← ${cand.reasons.join(', ')}${state}`);
      lines.push(`    Utilidad prevista: ${cand.summary}`);
      for (const reason of cand.pendingReasons) lines.push(`    Pendiente: ${reason}`);
      if (cand.overlapsWith.length) lines.push(`    Comparte ámbito con: ${cand.overlapsWith.join(', ')}`);
    }
  }

  if (report.optional && report.optional.length > 0) {
    lines.push('', `Opcionales disponibles en el catálogo (${report.optional.length}):`);
    for (const opt of report.optional) {
      lines.push(`  - ${opt.name} (${opt.license}) ← perfil ${opt.profiles.join('/')}`);
    }
  }

  if (report.addons.length > 0) {
    lines.push('', 'Añadidos opcionales:');
    for (const addon of report.addons) {
      lines.push(`  - ${addon.name} (${addon.versionReviewed}, ${addon.license}): ${addon.summary}`);
    }
  }

  if (report.limits.length > 0) {
    lines.push('', 'Límites de la inspección:');
    for (const lim of report.limits) lines.push(`  ! ${lim}`);
  }
  lines.push('', 'SHA-256 comprueba integridad de archivos; no acredita utilidad ni calidad.');

  return lines.join('\n') + '\n';
}
