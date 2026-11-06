import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { runGeminiCli } from "../src/gemini-cli.js";
import { estado, imagen, investigar } from "../src/gemini-tools.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "gemini-tools-"));
after(() => fs.rm(root, { recursive: true, force: true }));
const CONVERSATION = "a142b972-d487-4b75-ac9c-f3d8970787e1";

async function fixture() {
  const directory = await fs.mkdtemp(path.join(root, "case-"));
  const calls = [];
  const brainDirectory = path.join(directory, "brain");
  const ok = (extra = {}) => ({ conversation_id: CONVERSATION, status: "SUCCESS", response: "Respuesta con fuentes https://ejemplo.org", duration_seconds: 1.5, usage: { total_tokens: 100 }, ...extra });
  return { directory, outRoot: path.join(directory, "out"), brainDirectory, calls, ok,
    run: (result, effect = async () => {}) => async (args, cwd, timeout) => { calls.push({ args, cwd, timeout }); await effect(cwd); return result; } };
}

test("a prompt and a model are validated before anything runs", async () => {
  const f = await fixture();
  for (const bad of [{ prompt: "" }, { prompt: "   " }, { prompt: "x".repeat(6_001) }, { prompt: "con \u0000 nulo" }, { prompt: "ok", model: "Modelo Con Espacios; rm -rf" }, { prompt: 7 }]) {
    await assert.rejects(investigar({ ...bad, outRoot: f.outRoot, run: f.run(f.ok()) }), { code: "gemini-tools" });
    await assert.rejects(imagen({ ...bad, outRoot: f.outRoot, run: f.run(f.ok()) }), { code: "gemini-tools" });
  }
  assert.equal(f.calls.length, 0);
  await assert.rejects(fs.access(f.outRoot));
});

test("research runs read-only in a private empty folder and keeps the answer", async t => {
  const f = await fixture();
  const result = await investigar({ prompt: "¿Qué hay de nuevo en Node?", outRoot: f.outRoot, run: f.run(f.ok()) });
  const [call] = f.calls;
  assert.deepEqual(call.args.slice(0, 1), ["-p"]);
  assert.match(call.args[1], /no uses subagentes/u);
  assert.match(call.args[1], /Pregunta: ¿Qué hay de nuevo en Node\?/u);
  assert.deepEqual(call.args.slice(2), ["--model", "gemini-4-argon-medium", "--mode", "plan", "--output-format", "json", "--print-timeout", "600s"]);
  assert.equal(call.cwd, result.directory);
  assert.equal(path.dirname(path.dirname(call.cwd)), await fs.realpath(f.outRoot));
  await t.test("POSIX run folder is private", { skip: process.platform === "win32" ? "Windows does not implement POSIX permission bits." : false }, async () => {
    assert.equal((await fs.stat(call.cwd)).mode & 0o777, 0o700);
  });
  assert.equal(await fs.readFile(result.files[0], "utf8"), "Respuesta con fuentes https://ejemplo.org");
  assert.equal(JSON.parse(await fs.readFile(path.join(call.cwd, "meta.json"), "utf8")).conversationId, CONVERSATION);
  assert.equal(result.response.includes("fuentes"), true);
  await assert.rejects(investigar({ prompt: "x", outRoot: f.outRoot, run: f.run({ status: "ERROR" }) }), { message: /no completó/u });
});

test("copying a result never overwrites what is already there", async () => {
  const f = await fixture();
  const target = path.join(f.directory, "proyecto", "docs");
  const first = await investigar({ prompt: "a", outRoot: f.outRoot, copyTo: target, run: f.run(f.ok()) });
  assert.deepEqual(first.copied, [path.join(target, "respuesta.md")]);
  await fs.writeFile(path.join(target, "respuesta.md"), "mío\n");
  await assert.rejects(investigar({ prompt: "b", outRoot: f.outRoot, copyTo: target, run: f.run(f.ok()) }), { message: /Ya existe .*respuesta\.md/u });
  assert.equal(await fs.readFile(path.join(target, "respuesta.md"), "utf8"), "mío\n");
});

test("image generation waits for the subagent's files and copies only images", async () => {
  const f = await fixture();
  const artifacts = path.join(f.brainDirectory, CONVERSATION);
  const effect = async () => setTimeout(async () => {
    await fs.mkdir(artifacts, { recursive: true });
    await fs.writeFile(path.join(artifacts, "notas.txt"), "no es imagen");
    await fs.writeFile(path.join(artifacts, "logo_1.png"), "PNG");
  }, 40);
  const result = await imagen({ prompt: "Un logo", outRoot: f.outRoot, brainDirectory: f.brainDirectory, pollMs: 10, waitMs: 2_000,
    run: f.run(f.ok(), effect) });
  assert.deepEqual(result.files.map(file => path.basename(file)), ["logo_1.png"]);
  assert.equal(await fs.readFile(result.files[0], "utf8"), "PNG");
  const [call] = f.calls;
  assert.match(call.args[1], /generate_image.*Un logo/su);
  assert.deepEqual(call.args.slice(2, 6), ["--model", "gemini-3.8-flash-low", "--mode", "accept-edits"]);
  assert.equal(call.cwd, path.dirname(result.files[0]));
});

test("an image that never appears reports where it may still be", async () => {
  const f = await fixture();
  await assert.rejects(imagen({ prompt: "Nada", outRoot: f.outRoot, brainDirectory: f.brainDirectory, pollMs: 5, waitMs: 30, run: f.run(f.ok()) }),
    { code: "gemini-tools", message: new RegExp(`no terminó.*${CONVERSATION}`, "u") });
});

test("estado reports availability and models, or that agy is missing", async () => {
  const run = async args => args[0] === "--version" ? "1.4.7\n" : "gemini-4-argon-low\tGemini 4 Argon (Low)\nFetching available models...\nnone\n";
  const ok = await estado({ run });
  assert.deepEqual([ok.available, ok.version, ok.models], [true, "1.4.7", ["gemini-4-argon-low", "none"]]);
  assert.deepEqual(await estado({ run: async () => null }), { available: false });
});

test("the CLI maps options to the tools and rejects bad usage", async () => {
  const seen = [];
  const tools = { investigar: async input => { seen.push(["investigar", input]); return { ok: true }; }, imagen: async input => { seen.push(["imagen", input]); return { ok: true }; }, estado: async () => ({ available: true }) };
  const run = async argv => {
    const out = [], errors = [];
    const code = await runGeminiCli(argv, { tools, out: t => out.push(t), err: t => errors.push(t) });
    return { code, out: out.join(""), errors: errors.join("") };
  };
  assert.equal((await run(["investigar", "--prompt", "p", "--modelo", "gemini-4-argon-high", "--copiar-a", "/tmp/x"])).code, 0);
  assert.deepEqual(seen[0], ["investigar", { prompt: "p", model: "gemini-4-argon-high", copyTo: "/tmp/x" }]);
  await run(["imagen", "--prompt", "i", "--espera-seg", "90"]);
  assert.deepEqual(seen[1], ["imagen", { prompt: "i", model: undefined, copyTo: undefined, waitMs: 90_000 }]);
  assert.equal(JSON.parse((await run(["estado"])).out).available, true);
  for (const argv of [[], ["otra"], ["investigar"], ["investigar", "--prompt"], ["investigar", "--prompt", "a", "--prompt", "b"],
    ["investigar", "--prompt", "a", "--espera-seg", "5"], ["imagen", "--prompt", "a", "--espera-seg", "0"], ["imagen", "--prompt", "a", "--espera-seg", "601"],
    ["estado", "--prompt", "a"], ["imagen", "--prompt", "a", "--otro", "1"]]) {
    const result = await run(argv);
    assert.equal(result.code, 2, JSON.stringify(argv));
    assert.match(result.errors, /agent-toolkit-gemini investigar/u);
  }
  const failing = await runGeminiCli(["imagen", "--prompt", "x"], { tools: { ...tools, imagen: async () => { throw new Error("detalle interno"); } }, out: () => {}, err: t => seen.push(t) });
  assert.equal(failing, 1);
  assert.equal(seen.at(-1), "No se pudo completar la operación.\n");
});

test('simultaneous identical prompts never share a directory or overwrite an answer', async () => {
  const f = await fixture();
  const [a,b] = await Promise.all([1,2].map(n => investigar({ prompt: 'same', outRoot: f.outRoot,
    now: () => 1700000000000, run: f.run(f.ok({ response: String(n) })) })));
  assert.notEqual(a.directory, b.directory);
  assert.deepEqual(await Promise.all([a,b].map(r => fs.readFile(r.files[0], 'utf8'))), ['1','2']);
});

test('image artifact ids and symlinks cannot escape the conversation directory', async () => {
  const f = await fixture();
  await assert.rejects(imagen({ prompt: 'x', outRoot: f.outRoot, brainDirectory: f.brainDirectory,
    waitMs: 1, pollMs: 1, run: f.run(f.ok({ conversation_id: '../outside' })) }), /conversación/u);
  const artifacts = path.join(f.brainDirectory, CONVERSATION);
  await fs.mkdir(artifacts, { recursive: true });
  const secret = path.join(f.directory, 'private'); await fs.writeFile(secret, 'PRIVATE');
  await fs.symlink(process.platform === 'win32' ? f.directory : secret, path.join(artifacts, 'bad.png'), process.platform === 'win32' ? 'junction' : 'file');
  await assert.rejects(imagen({ prompt: 'x', outRoot: f.outRoot, brainDirectory: f.brainDirectory,
    waitMs: 1, pollMs: 1, run: f.run(f.ok()) }));
});

test('consultation persists usage; history and recovery never invoke a model', async () => {
  const f = await fixture(), api = await import('../src/gemini-tools.js');
  assert.equal(typeof api.consultar, 'function');
  const result = await api.consultar({ prompt: 'hola', outRoot: f.outRoot, run: f.run(f.ok()) });
  const history = await api.historial({ outRoot: f.outRoot });
  assert.equal(history.runs.length, 1);
  assert.equal(history.runs[0].directory, result.directory);
  assert.equal(history.runs[0].usage.total_tokens, 100);
  const recovered = await api.recuperar({ directory: result.directory, outRoot: f.outRoot });
  assert.equal(recovered.response, f.ok().response);
  assert.equal(f.calls.length, 1);
});

test('analysis copies only explicit inputs and rejects invalid or linked files before invoking agy', async () => {
  const f = await fixture(), api = await import('../src/gemini-tools.js');
  assert.equal(typeof api.analizar, 'function');
  const file = path.join(f.directory, 'selected.txt'); await fs.writeFile(file, 'el número es 42');
  const result = await api.analizar({ prompt: 'qué número', files: [file], outRoot: f.outRoot,
    run: f.run(f.ok({ structured_output: { status: 'completed', answer: '42', filesRead: ['input-1.txt'] } }), async cwd => {
      assert.equal(await fs.readFile(path.join(cwd, 'input-1.txt'), 'utf8'), 'el número es 42');
    }) });
  assert.equal(result.analysis.status, 'completed');
  assert.equal(f.calls[0].args[1].includes(f.directory), false);
  const linked = path.join(f.directory, 'linked.txt');
  await fs.symlink(process.platform === 'win32' ? f.directory : file, linked, process.platform === 'win32' ? 'junction' : 'file');
  for (const files of [[], [linked], [path.join(f.directory, 'absent.pdf')], [f.directory]]) {
    await assert.rejects(api.analizar({ prompt: 'x', files, outRoot: f.outRoot, run: f.run(f.ok()) }));
  }
  assert.equal(f.calls.length, 1);
});

test('analysis rejects hard-linked inputs before invoking agy', async () => {
  const f = await fixture(), api = await import('../src/gemini-tools.js');
  const file = path.join(f.directory, 'selected.txt'), linked = path.join(f.directory, 'hard.txt');
  await fs.writeFile(file, 'private input');
  await fs.link(file, linked);
  await assert.rejects(api.analizar({ prompt: 'x', files: [linked], outRoot: f.outRoot, run: f.run(f.ok()) }));
  assert.equal(f.calls.length, 0);
});

test('unsupported media is reported honestly; no successful analysis without verified structured output', async () => {
  const f = await fixture(), api = await import('../src/gemini-tools.js');
  assert.equal(typeof api.analizar, 'function');
  const file = path.join(f.directory, 'document.pdf'); await fs.writeFile(file, 'test pdf');
  const response = f.ok({ structured_output: { status: 'unsupported', answer: 'No puedo leer audio', filesRead: [] } });
  const result = await api.analizar({ prompt: 'transcribe', files: [file], outRoot: f.outRoot, run: f.run(response) });
  assert.equal(result.analysis.status, 'unsupported');
  await assert.rejects(api.analizar({ prompt: 'x', files: [file], outRoot: f.outRoot, run: f.run(f.ok()) }));
});

test('CLI supports explicit media, local history and recovery; unsupported analysis is not success', async () => {
  const seen = [], tools = {
    analizar: async input => { seen.push(input); return { analysis: { status: 'unsupported' } }; },
    historial: async input => ({ runs: [], ...input }), recuperar: async input => ({ inferredAgain: false, ...input }),
    consultar: async input => ({ response: input.prompt })
  };
  const run = async argv => { let stdout = ''; const code = await runGeminiCli(argv, { tools, out: t => { stdout += t; }, err: () => {} }); return { code, stdout }; };
  assert.equal((await run(['analizar', '--prompt', 'resume', '--archivo', '/x.pdf', '--archivo', '/y.mp4'])).code, 3);
  assert.deepEqual(seen[0].files, ['/x.pdf','/y.mp4']);
  assert.equal((await run(['historial', '--limite', '5'])).code, 0);
  assert.equal(JSON.parse((await run(['recuperar', '--directorio', '/run'])).stdout).inferredAgain, false);
  assert.equal((await run(['consultar', '--prompt', 'hi'])).code, 0);
  for (const args of [['analizar','--prompt','x'], ['consultar','--prompt','x','--archivo','x.pdf'], ['historial','--limite','0'], ['recuperar'], ['imagen','--prompt','x','--proveedor','api']]) assert.equal((await run(args)).code, 2);
});

test('audio is explicitly unavailable after failed native validation, without spending another model call', async () => {
  const f=await fixture(), api=await import('../src/gemini-tools.js');
  const file=path.join(f.directory,'speech.wav');await fs.writeFile(file,'test');
  const result=await api.analizar({prompt:'transcribe',files:[file],outRoot:f.outRoot,run:f.run(f.ok())});
  assert.equal(result.analysis.status,'unsupported');
  assert.equal(result.inferred,false);
  assert.equal(f.calls.length,0);
});

test('explicit task binding records provider usage once and never infers on an invalid collaboration', async () => {
  const calls=[], records=[];
  const store={getCollaboration:async ()=>({}),recordUsage:async input=>{records.push(input);return {recorded:true};}};
  const tools={consultar:async ()=>{calls.push(1);return {kind:'consultar',conversationId:CONVERSATION,model:'gemini-3.8-flash-low',usage:{input_tokens:100,cache_read_tokens:40,output_tokens:5,total_tokens:105},durationMs:500};}};
  const args=['consultar','--prompt','hi','--task',CONVERSATION,'--project-root','/project'];
  const io={tools,usageStore:store,out:()=>{},err:()=>{}};
  assert.equal(await runGeminiCli(args,io),0);
  assert.equal(records[0].measurement.totalTokens,105);
  assert.equal(records[0].measurement.cacheReadTokens,40);
  assert.equal(records[0].measurement.source,'client-reported');
  assert.equal(await runGeminiCli(args,{...io,usageStore:{getCollaboration:async ()=>{throw Error('missing');}}}),1);
  assert.equal(calls.length,1);
});

test('copy failures and late images still record usage and expose the recoverable run',async()=>{
  const api=await import('../src/gemini-tools.js');
  for(const command of ['consultar','imagen']) {
    const f=await fixture(), records=[], target=path.join(f.directory,'target');
    await fs.mkdir(target);await fs.writeFile(path.join(target,'respuesta.md'),'preserve');
    const tools={ [command]: options=>api[command]({...options,outRoot:f.outRoot,run:f.run(f.ok()),brainDirectory:f.brainDirectory,waitMs:1,pollMs:1}) };
    let stdout='',stderr='';
    const code=await runGeminiCli([command,'--prompt','test','--task',CONVERSATION,'--project-root',f.directory,...(command==='consultar'?['--copiar-a',target]:[])],{
      tools,usageStore:{getCollaboration:async()=>({}),recordUsage:async record=>{records.push(record);return {recorded:true};}},
      out:s=>{stdout+=s;},err:s=>{stderr+=s;}
    });
    assert.equal(code,1);assert.equal(records.length,1);assert.equal(records[0].measurement.totalTokens,100);
    const result=JSON.parse(stdout);
    assert.ok(result.directory);assert.equal(result.usageRecord.recorded,true);
    assert.equal((await api.historial({outRoot:f.outRoot})).runs[0].directory,result.directory);
    assert.equal(await fs.readFile(path.join(target,'respuesta.md'),'utf8'),'preserve');
    assert.ok(stderr.length>0);
  }
});

test('recovering partial analysis retains its status, evidence and CLI exit code',async()=>{
  const f=await fixture(),api=await import('../src/gemini-tools.js');
  const file=path.join(f.directory,'doc.pdf');await fs.writeFile(file,'test');
  const result=await api.analizar({prompt:'read',files:[file],outRoot:f.outRoot,run:f.run(f.ok({structured_output:{status:'partial',answer:'only page one',filesRead:['input-1.pdf']}}))});
  const recovered=await api.recuperar({directory:result.directory,outRoot:f.outRoot});
  assert.equal(recovered.analysis.status,'partial');assert.equal(recovered.analysisVerified,false);
  assert.equal(recovered.evidence,'model-reported');
  const code=await runGeminiCli(['recuperar','--directorio',result.directory],{tools:{recuperar:options=>api.recuperar({...options,outRoot:f.outRoot})},out:()=>{},err:()=>{}});
  assert.equal(code,3);assert.equal(f.calls.length,1);
});

test('image collection retries a file still being written without repeating inference', async t => {
  const f = await fixture(), artifacts = path.join(f.brainDirectory, CONVERSATION);
  await fs.mkdir(artifacts, { recursive:true });
  const image = path.join(artifacts, 'partial.png'); await fs.writeFile(image, 'P');
  const original = fs.lstat; let grew = false;
  t.mock.method(fs, 'lstat', async (...args) => {
    const stat = await original(...args);
    if (args[0] === image && !grew) { grew = true; await fs.writeFile(image, 'PNG completo'); }
    return stat;
  });
  const result = await imagen({ prompt:'Logo', outRoot:f.outRoot, brainDirectory:f.brainDirectory,
    pollMs:1, waitMs:1000, run:f.run(f.ok()) });
  assert.equal(await fs.readFile(result.files[0], 'utf8'), 'PNG completo');
  assert.equal(f.calls.length, 1);
});
