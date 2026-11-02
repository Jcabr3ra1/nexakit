const family = (model) => model?.match(/(?:^|claude-)(haiku|sonnet|opus|fable)(?:-|$)/u)?.[1] ?? model;
export function modelStatus(model, effort, recommendation) {
  const actual = `${model ?? 'modelo no informado'} · ${effort ?? 'esfuerzo no informado'}`;
  if (!recommendation) return actual;
  const matches =
    effort && family(model) === family(recommendation.model) && effort === recommendation.effort;
  return `${actual} ${matches ? '✓' : `→ recomendado: ${recommendation.model} · ${recommendation.effort}`}`;
}
