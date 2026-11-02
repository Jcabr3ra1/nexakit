import path from 'node:path';
const CLIENTS = ['claude', 'codex', 'antigravity'];
export const RECOMMENDED_REVIEWERS = Object.freeze({
  claude: 'codex',
  codex: 'claude',
  antigravity: 'claude',
});
export function selectReviewer({ principal, available, certified, sessionChoice, requested }) {
  if (!CLIENTS.includes(principal)) throw new Error('IA principal inválida.');
  const options = CLIENTS.filter(
    (ia) => ia !== principal && available.includes(ia) && certified.includes(ia),
  );
  const recommended = options.includes(RECOMMENDED_REVIEWERS[principal])
    ? RECOMMENDED_REVIEWERS[principal]
    : (options[0] ?? null);
  const preferred = requested ?? sessionChoice;
  const selected = options.includes(preferred) ? preferred : options.length === 1 ? options[0] : null;
  return {
    options,
    recommended,
    selected,
    ask: options.length > 1 && !selected,
    unavailable: preferred && !options.includes(preferred) ? preferred : null,
  };
}
export function shouldAutoReview({ changedFiles = [], withoutReview = false, alreadyReviewed = false }) {
  if (withoutReview || alreadyReviewed) return false;
  return changedFiles.some(
    (file) =>
      !['.md', '.mdx', '.txt', '.rst', '.adoc', '.pdf', '.png', '.jpg', '.jpeg', '.svg'].includes(
        path.extname(file).toLowerCase(),
      ) && !/^(readme|license|licence|notice|changelog)$/iu.test(path.basename(file)),
  );
}
