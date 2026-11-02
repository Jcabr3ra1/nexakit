import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runRevision, runRevisionCommand} from '../src/revision.js';
test('review refuses uncertified clients and detects writes even after process failure',async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'review-run-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const briefFile=path.join(home,'brief');await fs.writeFile(briefFile,'Check code');
 const opts={client:'codex',model:'model',effort:'low',briefFile,start:home,homeDirectory:home};let executed=0,shot=0;
 const deps={collectContext:async()=>({root:home,base:'main',diff:'DIFF',changedFiles:['code.js']}),buildInvocation:async()=>({args:[],executable:'fake'}),getVersion:async()=>'1',checkIsolation:async()=>({status:'failed'}),snapshot:async()=>new Map(),runProcess:async()=>{executed++;return {status:1,stdout:'',stderr:'failure'};}};
 assert.equal((await runRevision(opts,deps)).exitCode,1);assert.equal(executed,0);
 const r=await runRevision(opts,{...deps,checkIsolation:async()=>({status:'passed'}),snapshot:async()=>new Map([['code.js',{sha256:String(shot++)}]] )});
 assert.equal(r.exitCode,1);assert.deepEqual(r.changedFiles,['code.js']);assert.equal(executed,1);
});
test('invalid or duplicate command arguments never invoke a review',async()=>{
 for(const args of [[],['--con','codex','--con','claude'],['--con','bad']]){
  let calls=0;assert.equal(await runRevisionCommand(args,{out:()=>{},err:()=>{}},{run:async()=>{calls++;}}),2);assert.equal(calls,0);
 }
});
test('successful review presents reported usage and does not infer unknown provenance',async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'review-success-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));const briefFile=path.join(home,'brief');await fs.writeFile(briefFile,'review');
 const r=await runRevision({client:'codex',model:'model',effort:'low',briefFile,homeDirectory:home},{collectContext:async()=>({root:home,base:'main',changedFiles:[],diff:''}),buildInvocation:async()=>({executable:'fake',args:[]}),getVersion:async()=>'1',checkIsolation:async()=>({status:'passed'}),snapshot:async()=>new Map(),runProcess:async()=>({status:0,stdout:[{type:'thread.started',thread_id:'id'},{type:'item.completed',item:{type:'agent_message',text:'Review'}},{type:'turn.completed',usage:{input_tokens:0,output_tokens:2}}].map(JSON.stringify).join('\n')}),readProvenance:async()=>null});
 assert.equal(r.exitCode,0);assert.equal(r.actual,null);assert.equal(r.usage.inputTokens,0);
});
test('command marks an effort mismatch and prints unknown usage without inventing zero',async()=>{
 let text='';const code=await runRevisionCommand(['--con','codex','--modelo','same','--esfuerzo','low','--encargo','brief'],{out:s=>{text+=s;},err:()=>{}},{run:async()=>({exitCode:0,report:'Review',actual:{model:'same',effort:'high',source:'log'},usage:{},changedFiles:[]})});
 assert.equal(code,0);assert.match(text,/! Modelo pedido:/);assert.match(text,/entrada no informado/);
});
