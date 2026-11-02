import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRecommendationReport } from '../src/recommend-report.js';

const base = {
  projectName: 'demo', projectRoot: '/tmp/demo', signals: [], unmatchedSignals: [], addons: [], limits: [],
  recommended: [{ name: 'probada', license: 'MIT', reasons: ['React'], taskClass: 'ui-authoring' }],
  candidates: [
    { name: 'con-notas', license: 'MIT', reasons: ['React'], summary: 'Hace algo.', pendingReasons: [], overlapsWith: [], reviewStatus: 'reviewed-with-observations', reviewNotes: 'Consulta internet.' },
    { name: 'limpia', license: 'MIT', reasons: ['React'], summary: 'Hace otra cosa.', pendingReasons: [], overlapsWith: [], reviewStatus: 'reviewed', reviewNotes: 'Solo Markdown.' }
  ],
  optional: [{ name: 'opcional', license: 'MIT', profiles: ['security'] }]
};

test('recommend marca como no probadas las compatibles y las opcionales', () => {
  const text = formatRecommendationReport(base);
  assert.match(text, /Skills compatibles, no probadas \(2\):/);
  assert.equal(text.match(/    No probada: nadie ha comprobado aún que mejore el trabajo con este agente\./g).length, 2);
  assert.match(text, /    Observaciones: Consulta internet\./);
  assert.doesNotMatch(text, /Observaciones: Solo Markdown/);
  assert.match(text, /- opcional \(MIT\) ← perfil security · no probada/);
  assert.doesNotMatch(text, /- probada .*no probada/);
});

test('recommend muestra las referencias externas con su enlace y sin instalarlas', () => {
  const text = formatRecommendationReport({
    ...base,
    externalCandidates: [{ name: 'ui-ux-pro-max', summary: 'Guía de diseño UI/UX.', sourceUrl: 'https://github.com/ejemplo/ui', reasons: ['React'], statusNote: 'Se instala como plugin de Claude.' }]
  });
  assert.match(text, /Disponibles fuera del catálogo, se instalan aparte \(1\):/);
  assert.match(text, /  - ui-ux-pro-max ← React · no probada/);
  assert.match(text, /    Utilidad prevista: Guía de diseño UI\/UX\./);
  assert.match(text, /    Dónde: https:\/\/github\.com\/ejemplo\/ui/);
  assert.match(text, /    Nota: Se instala como plugin de Claude\./);
});

test('recommend sin referencias externas no muestra el apartado', () => {
  assert.doesNotMatch(formatRecommendationReport({ ...base, externalCandidates: [] }), /fuera del catálogo/);
  assert.doesNotMatch(formatRecommendationReport(base), /fuera del catálogo/);
});
