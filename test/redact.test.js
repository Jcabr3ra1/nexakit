import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import {sinSecretos} from '../src/redact.js';
import {sinSecretos as panelRedact} from '../plugins/nexakit-panel/hooks/panel.js';
test('redacts credentials in URLs, variables and bearer tokens for both consumers',()=>{
 const input='postgresql://usuario:clave@localhost/db API_TOKEN=privado Bearer secreto --password=oculto';
 const result=sinSecretos(input);assert.doesNotMatch(result,/clave|privado|secreto|oculto/);assert.match(result,/usuario:\*\*\*@localhost/);assert.equal(panelRedact(input),result);
});
test('the standalone plugin ships the canonical redaction implementation',async()=>{
 assert.equal(await fs.readFile(new URL('../src/redact.js',import.meta.url),'utf8'),await fs.readFile(new URL('../plugins/nexakit-panel/hooks/redact.js',import.meta.url),'utf8'));
});
