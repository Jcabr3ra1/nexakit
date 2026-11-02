import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readRevisionProvenance } from '../src/revision-provenance.js';
test('Codex provenance matches both execution id and originator, never the newest file',async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'revision-provenance-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const dir=path.join(home,'.codex','sessions','2026','11','02');await fs.mkdir(dir,{recursive:true});
 const write=async(id,originator,model)=>fs.writeFile(path.join(dir,`rollout-2026-${id}.jsonl`),[
 {type:'session_meta',payload:{id,originator}},{type:'turn_context',payload:{model,effort:'low'}}].map(JSON.stringify).join('\n'));
 await write('wanted','codex_exec','model-a');await write('newest','codex_exec','model-b');
 const r=await readRevisionProvenance({client:'codex',executionId:'wanted',homeDirectory:home});assert.equal(r.model,'model-a');assert.equal(r.effort,'low');
 await write('wanted','codex_cli','wrong');assert.equal(await readRevisionProvenance({client:'codex',executionId:'wanted',homeDirectory:home}),null);
 assert.equal(await readRevisionProvenance({client:'codex',executionId:'missing',homeDirectory:home}),null);
 assert.equal(await readRevisionProvenance({client:'codex',executionId:'../escape',homeDirectory:home}),null);
});
