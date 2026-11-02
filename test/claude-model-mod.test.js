import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelStatus } from '../plugins/nexakit-modelo/hooks/status.js';
test('status requires a real effort and model match before displaying a check', () => {
  const rec = { model: 'haiku', effort: 'low' };
  assert.match(modelStatus('haiku', null, rec), /esfuerzo no informado/);
  assert.equal(modelStatus('haiku', null, rec).includes('✓'), false);
  assert.match(modelStatus('claude-haiku-5-5', 'low', rec), /✓/);
  assert.equal(modelStatus('sonnet', 'low', rec).includes('✓'), false);
});
test('mod refreshes model changes and forgets effort between turns', async () => {
 const { register } = await import('../plugins/nexakit-modelo/hooks/register.js');
 const hooks = new Map();
 register((event, ...rest) => { hooks.set(event, rest.at(-1)); });
 let model = 'haiku', displayed = '';
 const api = { session: { model: async () => model }, tool: { register: async () => {} }, ui: { status: text => { displayed = text; } } };
 await hooks.get('session.start')(api, {}, async e => e);
 await hooks.get('tool.call')(api, { model: 'haiku', effort: 'low', reason: 'test' });
 const next = async function* () {};
 for await (const _ of hooks.get('turn.step')(api, { model: 'haiku', effort: 'low' }, next)) {}
 assert.match(displayed, /✓/);
 model = 'sonnet';
 await hooks.get('turn.complete')(api, {}, async e => e);
 assert.match(displayed, /sonnet.*esfuerzo no informado/);
 assert.equal(displayed.includes('✓'), false);
});
