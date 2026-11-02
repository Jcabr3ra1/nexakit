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
