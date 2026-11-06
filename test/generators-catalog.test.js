import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import { loadGeneratorsCatalog, validateGeneratorsCatalog, GeneratorsCatalogError } from '../src/generators-catalog.js';
const raw = async () => JSON.parse(await fs.readFile(new URL('../catalogs/generadores.json', import.meta.url), 'utf8'));
test('the catalog loads and every entry is valid', async () => {
  const catalog = await loadGeneratorsCatalog();
  assert.ok(Object.isFrozen(catalog.generators[0].steps));
  assert.deepEqual(validateGeneratorsCatalog(await raw()), catalog);
});
test('an unknown signal is rejected', async () => {
  const value = await raw(); value.generators[0].signals = ['unknown-signal'];
  assert.throws(() => validateGeneratorsCatalog(value), e => e instanceof GeneratorsCatalogError && /unknown-signal/.test(e.message));
});
test('an unknown placeholder is rejected', async () => {
  const value = await raw(); value.generators[0].steps[0].argv.push('{unknown}');
  assert.throws(() => validateGeneratorsCatalog(value), /marcador.*unknown/i);
});
test('a write step outside fastapi is rejected', async () => {
  const value = await raw(); value.generators[0].steps.push({ kind: 'write', path: 'x', content: 'x' });
  assert.throws(() => validateGeneratorsCatalog(value), /fastapi/i);
});
test('there is one entry per option of the design', async () => {
  assert.deepEqual((await loadGeneratorsCatalog()).generators.map(g => g.id).sort(),
    ['react-vite','nextjs','vue-vite','sveltekit','astro','angular','django','fastapi','express','nestjs','hono','sqlite','postgresql','supabase','expo'].sort());
});
test('duplicates, malformed steps and escaping writes are rejected', async () => {
  for (const mutate of [v => v.generators.push(v.generators[0]), v => v.generators[0].steps[0].argv = [],
    v => v.generators.find(g => g.id === 'fastapi').steps.push({kind:'write',path:'../escape',content:'x'})]) {
    const v = await raw(); mutate(v); assert.throws(() => validateGeneratorsCatalog(v), GeneratorsCatalogError);
  }
});
test('a non-database entry cannot have empty signals', async () => {
  const v = await raw(); v.generators[0].signals = []; assert.throws(() => validateGeneratorsCatalog(v), /señal/i);
});
test('express can scaffold an inspected empty folder without prompts and ignores installed dependencies', async () => {
  const express = (await loadGeneratorsCatalog()).generators.find(g => g.id === 'express');
  assert.deepEqual(express.steps[0].argv, ['npx','--yes','express-generator@latest','{dir}','--no-view','--force','--git']);
});
test('supabase declares the Node requirement of its root CLI even with a Python backend', async () => {
  const supabase = (await loadGeneratorsCatalog()).generators.find(g => g.id === 'supabase');
  assert.ok(supabase.requires.some(r => r.program === 'node'));
});
