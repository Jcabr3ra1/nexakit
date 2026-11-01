import fs from 'node:fs/promises';
import path from 'node:path';

const write = async (file, content) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
};

// Lays out what `npm install --prefix <prefix> nexakit@<version>` leaves behind, with a minimal copy of the
// three dependencies the stable install probes. `broken` makes one specific part wrong:
// 'bin' | 'dependencia' | 'version' | 'skill'.
export async function writeFakeInstall(prefix, { version = '9.9.9', name = 'nexakit', broken = null } = {}) {
  const modules = path.join(prefix, 'node_modules');
  const root = path.join(modules, 'nexakit');
  await write(path.join(root, 'package.json'), JSON.stringify({ name, version: broken === 'version' ? '0.0.1' : version }));
  if (broken !== 'bin') await write(path.join(root, 'bin/agent-toolkit-mcp.js'), '');
  await write(path.join(root, 'skills/example/SKILL.md'), 'x');
  await write(path.join(root, 'catalogs/skills/catalogada', broken === 'skill' ? 'LEEME.md' : 'SKILL.md'), 'x');
  if (broken !== 'dependencia') {
    await write(path.join(modules, 'ajv/package.json'), JSON.stringify({ name: 'ajv', version: '1.0.0' }));
    await write(path.join(modules, 'ajv/index.js'), 'module.exports = {};');
  }
  await write(path.join(modules, 'zod/package.json'), JSON.stringify({ name: 'zod', version: '1.0.0' }));
  await write(path.join(modules, 'zod/index.js'), 'module.exports = {};');
  await write(path.join(modules, '@modelcontextprotocol/sdk/package.json'), JSON.stringify({ name: '@modelcontextprotocol/sdk', version: '1.0.0' }));
  await write(path.join(modules, '@modelcontextprotocol/sdk/client/index.js'), 'module.exports = {};');
  return root;
}

// A stand-in for the `runNpm` option: same contract as the real one, `{ status, stderr }`, and it records its calls.
export function fakeNpm({ version = '9.9.9', fail = false, broken = null } = {}) {
  const calls = [];
  const runNpm = async args => {
    calls.push(args);
    if (fail) return { status: 1, stderr: 'npm ERR! fallo simulado\n' };
    await writeFakeInstall(args[args.indexOf('--prefix') + 1], { version, broken });
    return { status: 0, stderr: '' };
  };
  return Object.assign(runNpm, { calls });
}
