import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('la fábrica compilada expone VERSION_FABRICA', async () => {
  const modulo = await import('../dist/fabrica/indice.js');
  assert.equal(modulo.VERSION_FABRICA, '1');
});

test('package.json publica dist/', () => {
  const paquete = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(paquete.files.includes('dist/'));
});

test('tsconfig resuelve los tipos de node para la fábrica', () => {
  const raiz = fileURLToPath(new URL('..', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'fabrica-tipos-'));
  try {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'tipos.ts'),
      "import { execFileSync } from 'node:child_process';\nexport const ruta: string = process.cwd();\nexport const f = execFileSync;\n");
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
      extends: join(raiz, 'tsconfig.json'),
      compilerOptions: { rootDir: 'src', noEmit: true, typeRoots: [join(raiz, 'node_modules', '@types')] },
      include: ['src/**/*.ts']
    }));
    const tsc = join(raiz, 'node_modules', 'typescript', 'bin', 'tsc');
    execFileSync(process.execPath, [tsc, '-p', join(dir, 'tsconfig.json')], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
