import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SUPERPOWERS, applySuperpowers, inspectSuperpowers, parseSuperpowersState } from '../src/superpowers.js';

const ok = stdout => ({ status: 0, stdout, stderr: '' });

test('Claude: reads the JSON list and tells active, disabled and missing apart', () => {
  const list = enabled => ok(JSON.stringify([{ id: 'otro@x', enabled: true }, { id: 'superpowers@claude-plugins-official', enabled }]));
  assert.equal(parseSuperpowersState('claude', list(true)), 'activo');
  assert.equal(parseSuperpowersState('claude', list(false)), 'desactivado');
  assert.equal(parseSuperpowersState('claude', ok('[{"id":"otro@x","enabled":true}]')), 'falta');
});

test('Codex: reads the table line of superpowers', () => {
  const row = status => ok(`superhuman@openai-curated-remote   not installed   2.3.0   id\nsuperpowers@openai-curated-remote   ${status}   7.0.1   id\n`);
  assert.equal(parseSuperpowersState('codex', row('installed, enabled')), 'activo');
  assert.equal(parseSuperpowersState('codex', row('installed, disabled')), 'desactivado');
  assert.equal(parseSuperpowersState('codex', row('not installed')), 'falta');
  assert.equal(parseSuperpowersState('codex', ok('nada que listar\n')), 'desconocido', 'without its row nothing is assumed');
});

test('Antigravity: reads the JSON list, and its empty message means missing', () => {
  assert.equal(parseSuperpowersState('antigravity', ok('[{"name":"superpowers","enabled":true}]')), 'activo');
  assert.equal(parseSuperpowersState('antigravity', ok('[{"name":"superpowers","enabled":false}]')), 'desactivado');
  assert.equal(parseSuperpowersState('antigravity', ok('No plugins installed.\n')), 'falta');
});

test('a failed or unreadable list is unknown, never missing', () => {
  for (const agent of ['claude', 'codex', 'antigravity']) {
    assert.equal(parseSuperpowersState(agent, { status: 1, stdout: '', stderr: 'boom' }), 'desconocido');
    assert.equal(parseSuperpowersState(agent, { status: null, stdout: '', stderr: '', errorCode: 'ENOENT' }), 'desconocido');
  }
  assert.equal(parseSuperpowersState('claude', ok('no es json')), 'desconocido');
});

test('inspects only the agents that are installed', async () => {
  const calls = [];
  const runCommand = (command, args) => {
    calls.push([command, ...args].join(' '));
    return ok(command === 'claude' ? '[{"id":"superpowers@claude-plugins-official","enabled":true}]' : 'No plugins installed.');
  };
  const states = await inspectSuperpowers({ agentsFound: { claude: true, codex: false, antigravity: true }, runCommand });
  assert.deepEqual(states, { claude: 'activo', antigravity: 'falta' });
  assert.deepEqual(calls, ['claude plugin list --json', 'agy plugin list --json']);
});

test('installs what is missing and enables what is disabled, with the reviewed marketplace of each agent', async () => {
  const calls = [];
  const runCommand = (command, args) => { calls.push([command, ...args].join(' ')); return ok(''); };
  await applySuperpowers('claude', 'falta', { runCommand });
  await applySuperpowers('codex', 'falta', { runCommand });
  await applySuperpowers('antigravity', 'falta', { runCommand });
  await applySuperpowers('claude', 'desactivado', { runCommand });
  await applySuperpowers('antigravity', 'desactivado', { runCommand });
  assert.deepEqual(calls, [
    'claude plugin install superpowers@claude-plugins-official',
    'codex plugin add superpowers@openai-curated-remote',
    'agy plugin install superpowers@antigravity-plugins-partners',
    'claude plugin enable superpowers@claude-plugins-official',
    'agy plugin enable superpowers'
  ]);
});

test('Codex has no enable command: a disabled plugin is reported, not touched', async () => {
  assert.equal(SUPERPOWERS.codex.enable, null);
  await assert.rejects(applySuperpowers('codex', 'desactivado', { runCommand: () => ok('') }), /Codex/u);
});

test('a failed install stops with the reason', async () => {
  await assert.rejects(
    applySuperpowers('claude', 'falta', { runCommand: () => ({ status: 1, stdout: '', stderr: 'sin red' }) }),
    /sin red/u
  );
});

const MISSING_MARKETPLACE = { status: 1, stdout: '', stderr: '✘ Failed to install plugin "superpowers@claude-plugins-official": Plugin "superpowers" not found in marketplace "claude-plugins-official". Your local copy may be out of date' };

test('Claude on a new HOME: the reviewed marketplace is added and the install retried once', async () => {
  const calls = [];
  let added = false;
  const runCommand = (command, args) => {
    calls.push([command, ...args].join(' '));
    if (args[1] === 'marketplace') { added = true; return ok(''); }
    return added ? ok('') : MISSING_MARKETPLACE;
  };
  assert.equal(await applySuperpowers('claude', 'falta', { runCommand }), true);
  assert.deepEqual(calls, [
    'claude plugin install superpowers@claude-plugins-official',
    'claude plugin marketplace add anthropics/claude-plugins-official',
    'claude plugin install superpowers@claude-plugins-official'
  ]);
});

test('Claude with an outdated marketplace copy: add fails, so it is updated before retrying', async () => {
  const calls = [];
  let updated = false;
  const runCommand = (command, args) => {
    calls.push([command, ...args].join(' '));
    if (args[2] === 'add') return { status: 1, stdout: '', stderr: 'already exists' };
    if (args[2] === 'update') { updated = true; return ok(''); }
    return updated ? ok('') : MISSING_MARKETPLACE;
  };
  assert.equal(await applySuperpowers('claude', 'falta', { runCommand }), true);
  assert.deepEqual(calls.slice(1, 3), [
    'claude plugin marketplace add anthropics/claude-plugins-official',
    'claude plugin marketplace update claude-plugins-official'
  ]);
});

test('a marketplace that cannot be prepared, or any other install error, fails once with the reason', async () => {
  const calls = [];
  const noMarketplace = (command, args) => { calls.push(args.join(' ')); return args[1] === 'marketplace' ? { status: 1, stdout: '', stderr: 'sin red' } : MISSING_MARKETPLACE; };
  await assert.rejects(applySuperpowers('claude', 'falta', { runCommand: noMarketplace }), /not found in marketplace/u);
  assert.equal(calls.filter(call => call.startsWith('plugin install')).length, 1, 'no retry without a marketplace');
  let installs = 0;
  await assert.rejects(applySuperpowers('claude', 'falta', { runCommand: () => { installs++; return { status: 1, stdout: '', stderr: 'sin red' }; } }), /sin red/u);
  assert.equal(installs, 1, 'an unrelated error is not retried');
});
