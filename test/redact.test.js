import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sinSecretos} from '../src/redact.js';
test('redacts credentials in URLs, variables and bearer tokens',()=>{
 const input='postgresql://usuario:clave@localhost/db API_TOKEN=privado Bearer secreto --password=oculto';
 const result=sinSecretos(input);assert.doesNotMatch(result,/clave|privado|secreto|oculto/);assert.match(result,/usuario:\*\*\*@localhost/);
});
