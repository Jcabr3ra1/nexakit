import fs from 'node:fs/promises';
import path from 'node:path';

// Only filesystem fixtures: never starts npm, Python, pip, Git or a generator.
export function fakeGenerators({ fail = () => false, calls = [] } = {}) {
  return async (command, args, {cwd}) => {
    calls.push({command,args,cwd});
    if (fail(command,args)) return {status:1,stderr:'Fallo simulado del generador.'};
    if (args.includes('--version')) return 'v24.20.0';
    if (args.includes('venv')) { await fs.mkdir(path.join(cwd,'.venv'),{recursive:true}); return {status:0}; }
    if (args.includes('startproject')) { await fs.writeFile(path.join(cwd,'manage.py'),'# django\n'); return {status:0}; }
    const packageIndex = args.findIndex(a => a.includes('@latest'));
    if (packageIndex >= 0 && !args.includes('supabase@latest')) {
      const pkg = args[packageIndex];
      const target = args.includes('--directory') ? args[args.indexOf('--directory')+1] : args[packageIndex+1];
      const dir = path.resolve(cwd,target); await fs.mkdir(dir,{recursive:true});
      const dependency = pkg.includes('next') ? 'next' : pkg.includes('express') ? 'express' : 'react';
      await fs.writeFile(path.join(dir,'package.json'),JSON.stringify({name:'prueba',dependencies:{[dependency]:'*'}}));
      await fs.writeFile(path.join(dir,'.gitignore'),'node_modules/\n');
    }
    return {status:0,stdout:'Simulado'};
  };
}
