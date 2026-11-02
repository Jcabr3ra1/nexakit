import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectReviewer, shouldAutoReview } from '../src/review-policy.js';
test('recommendations exclude the principal and respect session choices, changes and fallback', () => {
  const available = ['claude', 'codex', 'antigravity'],
    certified = available;
  for (const [principal, wanted] of [
    ['claude', 'codex'],
    ['codex', 'claude'],
    ['antigravity', 'claude'],
  ]) {
    const r = selectReviewer({ principal, available, certified });
    assert.equal(r.recommended, wanted);
    assert.equal(r.options.includes(principal), false);
    assert.equal(r.ask, true);
  }
  assert.equal(
    selectReviewer({ principal: 'claude', available, certified, sessionChoice: 'antigravity' }).selected,
    'antigravity',
  );
  assert.equal(
    selectReviewer({
      principal: 'claude',
      available,
      certified,
      sessionChoice: 'codex',
      requested: 'antigravity',
    }).selected,
    'antigravity',
  );
  assert.equal(
    selectReviewer({
      principal: 'claude',
      available: ['claude', 'codex'],
      certified,
      sessionChoice: 'antigravity',
    }).selected,
    'codex',
  );
  assert.equal(selectReviewer({ principal: 'claude', available: ['claude'], certified }).selected, null);
  assert.equal(selectReviewer({ principal: 'claude', available, certified: [] }).options.length, 0);
});
test('automatic review is once per task for code, respects opt-out, and ignores documents', () => {
  assert.equal(shouldAutoReview({ changedFiles: ['README.md', 'docs/guide.txt'] }), false);
  assert.equal(shouldAutoReview({ changedFiles: ['src/app.js'] }), true);
  assert.equal(shouldAutoReview({ changedFiles: ['docs/example.js'] }), true);
  assert.equal(shouldAutoReview({ changedFiles: ['app.js'], withoutReview: true }), false);
  assert.equal(shouldAutoReview({ changedFiles: ['app.js'], alreadyReviewed: true }), false);
});

test('installed pending reviewers are offered with a certification warning', () => {
  const result = selectReviewer({
    principal: 'claude',
    available: ['claude', 'codex'],
    certified: [],
    pending: ['codex'],
  });
  assert.deepEqual(result.options, ['codex']);
  assert.deepEqual(result.pending, ['codex']);
  assert.equal(result.selected, 'codex');
});
