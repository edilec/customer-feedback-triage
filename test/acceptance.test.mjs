import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const cli=new URL('../bin/customer-feedback-triage.mjs',import.meta.url).pathname;
const good={schemaVersion:'1',taxonomy:[{tag:'billing',keywords:['invoice','payment']},{tag:'delivery',keywords:['shipping','delay']}],feedback:[
  {id:'fb-001',redacted:true,redactedText:'Invoice was delayed',semanticSuggestions:[{tag:'delivery',confidence:0.72}]},
  {id:'fb-002',redacted:true,redactedText:'Payment failed',semanticSuggestions:[]}
]};
function run(doc=good) {
  const root=mkdtempSync(join(tmpdir(),'feedback-triage-'));
  try {
    writeFileSync(join(root,'feedback.json'),typeof doc==='string'?doc:JSON.stringify(doc));
    const p=spawnSync(process.execPath,[cli,'--root',root,'--input','feedback.json'],{encoding:'utf8'});
    return {...p,report:p.stdout?JSON.parse(p.stdout):null};
  } finally {rmSync(root,{recursive:true,force:true});}
}

test('good redacted export keeps original IDs and reviewable transparent suggestions', async () => {
  const {TOOL_ID,triageFeedback}=await import('../src/index.mjs');
  assert.equal(TOOL_ID,'customer-feedback-triage');
  const a=run(),b=run();
  assert.equal(a.status,0);
  assert.equal(a.stdout,b.stdout);
  assert.equal(a.report.status,'pass');
  assert.deepEqual(a.report.items.map(x=>x.id),['fb-001','fb-002']);
  assert.equal(a.report.items[0].reviewState,'ambiguous');
  assert.equal(a.report.items[0].reviewRequired,true);
  assert.deepEqual(a.report.items[0].candidates,[
    {tag:'billing',ruleHits:1,semanticConfidence:null},
    {tag:'delivery',ruleHits:0,semanticConfidence:0.72}
  ]);
  assert.deepEqual(a.report.groups.billing,['fb-001','fb-002']);
  assert.equal(triageFeedback(good).status,'pass');
  assert.doesNotMatch(a.stdout,/Invoice was delayed|Payment failed/);
});

test('source text containing an email fails without echoing private details', () => {
  const d=structuredClone(good);d.feedback[0].redactedText='Contact private@example.test about invoice';
  const r=run(d);
  assert.equal(r.status,1);
  assert.equal(r.report.findings[0].ruleId,'private-text-detected');
  assert.equal(r.report.findings[0].location.pointer,'/feedback/0/redactedText');
  assert.doesNotMatch(r.stdout,/private@example\.test|Contact/);
});

test('non-opaque source ID is not copied into output', () => {
  const d=structuredClone(good);d.feedback[0].id='fb-PRIVATESENTINEL';
  const r=run(d);
  assert.equal(r.status,2);
  assert.equal(r.report.findings[0].ruleId,'feedback-invalid');
  assert.doesNotMatch(r.stdout,/PRIVATESENTINEL/);
});

test('unredacted source cannot produce a green triage', () => {
  const d=structuredClone(good);d.feedback[0].redacted=false;
  const r=run(d);
  assert.equal(r.status,2);
  assert.equal(r.report.findings[0].ruleId,'feedback-unredacted');
});

test('duplicate original ID is incomplete with source ordinal', () => {
  const d=structuredClone(good);d.feedback[1].id='fb-001';
  const r=run(d);
  assert.equal(r.status,2);
  assert.equal(r.report.findings[0].ruleId,'feedback-id-duplicate');
  assert.equal(r.report.findings[0].location.pointer,'/feedback/1');
});

test('unknown semantic tag is incomplete instead of silently dropped', () => {
  const d=structuredClone(good);d.feedback[0].semanticSuggestions=[{tag:'unknown',confidence:0.5}];
  const r=run(d);
  assert.equal(r.status,2);
  assert.equal(r.report.findings[0].ruleId,'semantic-unknown-tag');
});

test('overlapping taxonomy keyword fails policy and remains reviewable', () => {
  const d=structuredClone(good);d.taxonomy[1].keywords.push('invoice');
  const r=run(d);
  assert.equal(r.status,1);
  assert.equal(r.report.findings[0].ruleId,'keyword-conflict');
  assert.equal(r.report.items[0].reviewState,'ambiguous');
});

test('feedback bound accepts 1000 records and refuses 1001', () => {
  const d=structuredClone(good);d.feedback=Array.from({length:1000},(_,i)=>({id:`fb-${i}`,redacted:true,redactedText:'Invoice issue'}));
  assert.equal(run(d).status,0);
  d.feedback.push({id:'fb-1000',redacted:true,redactedText:'Invoice issue'});
  const over=run(d);
  assert.equal(over.status,2);assert.equal(over.report.findings[0].ruleId,'record-limit');
});

test('input symlink outside root is refused without reading target', () => {
  const root=mkdtempSync(join(tmpdir(),'feedback-root-')),outside=mkdtempSync(join(tmpdir(),'feedback-out-'));
  try {
    writeFileSync(join(outside,'feedback.json'),'PRIVATE_SENTINEL');
    symlinkSync(join(outside,'feedback.json'),join(root,'feedback.json'));
    const p=spawnSync(process.execPath,[cli,'--root',root,'--input','feedback.json'],{encoding:'utf8'});
    assert.equal(p.status,2);assert.equal(JSON.parse(p.stdout).status,'incomplete');assert.doesNotMatch(p.stdout,/PRIVATE_SENTINEL/);
  } finally {rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});

test('bad usage has empty stdout and malformed subject reports incomplete', () => {
  const bad=spawnSync(process.execPath,[cli,'--unknown'],{encoding:'utf8'});
  assert.equal(bad.status,2);assert.equal(bad.stdout,'');
  const r=run('at position 1');
  assert.equal(r.status,2);assert.equal(r.report.status,'incomplete');assert.doesNotMatch(r.stdout,/at position 1/);
});

test('byte bound accepts N and rejects N+1', () => {
  const base=JSON.stringify(good);
  const exact=base+' '.repeat(1_048_576-Buffer.byteLength(base));
  assert.equal(run(exact).status,0);
  const over=run(exact+' ');
  assert.equal(over.status,2);assert.equal(over.report.findings[0].ruleId,'byte-limit');
});

test('taxonomy bound accepts 100 and rejects 101', () => {
  const d=structuredClone(good);
  d.taxonomy=Array.from({length:100},(_,i)=>({tag:`t${i}`,keywords:[`word${i}`]}));
  d.feedback[0].semanticSuggestions=[];
  assert.equal(run(d).status,0);
  d.taxonomy.push({tag:'t100',keywords:['word100']});
  assert.equal(run(d).report.findings[0].ruleId,'record-limit');
});

test('keyword, suggestion, and source-text field bounds accept N and reject N+1', () => {
  const d=structuredClone(good);
  d.taxonomy[0].keywords=Array.from({length:20},(_,i)=>`word${i}`);
  d.taxonomy.push(...Array.from({length:8},(_,i)=>({tag:`other${i}`,keywords:[`otherword${i}`]})));
  d.feedback[0].semanticSuggestions=d.taxonomy.map(t=>({tag:t.tag,confidence:0.5}));
  d.feedback[0].redactedText='x'.repeat(4096);
  assert.equal(run(d).status,0);
  d.taxonomy[0].keywords.push('extra');
  assert.equal(run(d).report.findings[0].ruleId,'taxonomy-invalid');
  d.taxonomy[0].keywords.pop();
  d.feedback[0].redactedText+='x';
  assert.equal(run(d).report.findings[0].ruleId,'feedback-invalid');
  d.feedback[0].redactedText='x';
  d.feedback[0].semanticSuggestions=Array.from({length:11},()=>({tag:'billing',confidence:0.5}));
  assert.equal(run(d).report.findings[0].ruleId,'semantic-invalid');
});

test('JSON depth accepts 16 and rejects 17', () => {
  const d=structuredClone(good);
  let cursor=d;
  for(let i=0;i<16;i++){cursor.extra={};cursor=cursor.extra;}
  assert.equal(run(d).status,0);
  cursor.extra={};
  assert.equal(run(d).report.findings[0].ruleId,'depth-limit');
});

test('injected elapsed clock accepts 5000ms and rejects 5001ms', async () => {
  const {triageFeedback}=await import('../src/index.mjs');
  let first=true;
  const atLimit=()=>{if(first){first=false;return 0;}return 5000;};
  assert.equal(triageFeedback(good,atLimit).status,'pass');
  first=true;
  const over=()=>{if(first){first=false;return 0;}return 5001;};
  const r=triageFeedback(good,over);
  assert.equal(r.status,'incomplete');assert.equal(r.findings[0].ruleId,'time-limit');
});

test('elapsed limit is checked after the final feedback record', async () => {
  const {triageFeedback}=await import('../src/index.mjs');
  let calls=0;
  const now=()=>calls++<5?0:5001;
  const r=triageFeedback(good,now);
  assert.equal(r.status,'incomplete');
  assert.equal(r.findings[0].ruleId,'time-limit');
});
