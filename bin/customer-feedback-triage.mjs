#!/usr/bin/env node
import {readFile,realpath,stat} from 'node:fs/promises';
import {resolve,relative,isAbsolute,sep} from 'node:path';
import {triageFeedback,incomplete,LIMITS} from '../src/index.mjs';

const args=process.argv.slice(2);
if(args.length===1&&args[0]==='--help'){
  process.stdout.write('Usage: customer-feedback-triage --root DIR --input FILE [--human]\nJSON report on stdout; --human summary on stderr. Local redacted export only.\n');
  process.exit(0);
}
let root,input,human=false;
try{
  for(let i=0;i<args.length;i++){
    const key=args[i];
    if(key==='--human'){if(human)throw new Error('duplicate');human=true;continue;}
    if(!['--root','--input'].includes(key)||i+1>=args.length)throw new Error('bad option');
    const value=args[++i];
    if(key==='--root'){if(root)throw new Error('duplicate');root=value;}
    else{if(input)throw new Error('duplicate');input=value;}
  }
  if(!root||!input||isAbsolute(input))throw new Error('missing option');
  root=await realpath(root);
  if(!(await stat(root)).isDirectory())throw new Error('root not directory');
}catch{process.stderr.write('Invalid configuration. Use --help.\n');process.exit(2);}
let result;
try{
  const path=await realpath(resolve(root,input));
  const rel=relative(root,path);
  if(rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel))throw new Error('outside root');
  const meta=await stat(path);
  if(!meta.isFile())throw new Error('not file');
  if(meta.size>LIMITS.bytes)result=incomplete('byte-limit');
  else{
    const bytes=await readFile(path,{signal:AbortSignal.timeout(LIMITS.milliseconds)});
    if(bytes.length>LIMITS.bytes)result=incomplete('byte-limit');
    else{
      try{result=triageFeedback(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}
      catch{result=incomplete('input-unreadable');}
    }
  }
}catch{result=incomplete('input-unreadable');}
process.stdout.write(`${JSON.stringify(result)}\n`);
if(human)process.stderr.write(`Feedback triage: ${result.status}; ${result.summary.checked} records reviewed; ${result.summary.errors} errors.\n`);
process.exitCode=result.status==='pass'?0:result.status==='fail'?1:2;
