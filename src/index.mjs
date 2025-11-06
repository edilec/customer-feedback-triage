export const TOOL_ID='customer-feedback-triage';
export const LIMITS=Object.freeze({bytes:1_048_576,feedback:1000,taxonomy:100,depth:16,milliseconds:5000,keywords:20,suggestions:10,textLength:4096});
const errors=new Set(['private-text-detected','keyword-conflict']);
const messages={
  'input-unreadable':'Input could not be read, decoded, or parsed.',
  'input-invalid':'Expected a supported version 1 feedback export.',
  'byte-limit':'Input exceeds 1048576 bytes.',
  'depth-limit':'JSON nesting exceeds depth 16.',
  'time-limit':'Evaluation exceeded 5000 milliseconds.',
  'record-limit':'Feedback or taxonomy record limit exceeded.',
  'taxonomy-invalid':'Taxonomy entry or keyword is invalid.',
  'taxonomy-tag-duplicate':'Taxonomy tag is duplicated.',
  'keyword-conflict':'A keyword belongs to multiple taxonomy tags.',
  'feedback-invalid':'Feedback record has invalid fields or exceeds a field limit.',
  'feedback-unredacted':'Feedback has not been marked redacted.',
  'feedback-id-duplicate':'Feedback ID is duplicated.',
  'private-text-detected':'Source text appears to contain private details.',
  'semantic-invalid':'Semantic suggestion or confidence is invalid.',
  'semantic-unknown-tag':'Semantic suggestion names an unknown tag.'
};
const cmp=(a,b)=>a<b?-1:a>b?1:0;
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const tag=x=>typeof x==='string'&&/^[a-z][a-z0-9-]{0,31}$/.test(x);
const id=x=>typeof x==='string'&&/^(?:fb-\d{1,12}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(x);
const keyword=x=>typeof x==='string'&&/^[a-z0-9]+(?: [a-z0-9]+)*$/.test(x)&&x.length<=80;
const privateText=x=>/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:https?:\/\/|www\.)\S+|\b(?:\+?\d[\d ()-]{7,}\d)\b|\b(?:api[_-]?key|password|secret|token)\s*[:=]/i.test(x);
function finding(ruleId,pointer='') {return {ruleId,severity:errors.has(ruleId)?'error':'warning',message:messages[ruleId],location:{file:'@input',pointer}};}
function report(findings,items=[],groups={}) {
  findings.sort((a,b)=>cmp(a.location.file,b.location.file)||cmp(a.location.pointer,b.location.pointer)||cmp(a.ruleId,b.ruleId));
  const status=findings.some(f=>f.severity==='warning')?'incomplete':findings.length?'fail':'pass';
  return {schemaVersion:'1',tool:TOOL_ID,status,summary:{checked:items.length,errors:findings.filter(f=>f.severity==='error').length,warnings:findings.filter(f=>f.severity==='warning').length},findings,items,groups};
}
export function incomplete(ruleId){return report([finding(ruleId)]);}
function tooDeep(x,depth=0){if(depth>LIMITS.depth)return true;if(!x||typeof x!=='object')return false;return Object.values(x).some(v=>tooDeep(v,depth+1));}
function hits(text,word){const escaped=word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');return (text.match(new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`,'g'))||[]).length;}

export function triageFeedback(doc,now=()=>performance.now()){
  const start=now(),findings=[],items=[],groups=Object.create(null);
  if(!obj(doc)||doc.schemaVersion!=='1'||!Array.isArray(doc.taxonomy)||!Array.isArray(doc.feedback)||!doc.taxonomy.length||!doc.feedback.length)return report([finding('input-invalid')]);
  if(tooDeep(doc))return report([finding('depth-limit')]);
  if(doc.taxonomy.length>LIMITS.taxonomy||doc.feedback.length>LIMITS.feedback)return report([finding('record-limit')]);
  const tags=new Map(),words=new Map();
  for(const [i,t] of doc.taxonomy.entries()){
    if(now()-start>LIMITS.milliseconds)return incomplete('time-limit');
    const pointer=`/taxonomy/${i}`;
    if(!obj(t)||!tag(t.tag)||!Array.isArray(t.keywords)||!t.keywords.length||t.keywords.length>LIMITS.keywords||!t.keywords.every(keyword)){findings.push(finding('taxonomy-invalid',pointer));continue;}
    const duplicateKeyword=t.keywords.findIndex((w,j)=>t.keywords.indexOf(w)!==j);
    if(duplicateKeyword!==-1){findings.push(finding('taxonomy-invalid',`${pointer}/keywords/${duplicateKeyword}`));continue;}
    if(tags.has(t.tag)){findings.push(finding('taxonomy-tag-duplicate',pointer));continue;}
    tags.set(t.tag,t.keywords);
    for(const w of t.keywords){if(words.has(w)&&words.get(w)!==t.tag)findings.push(finding('keyword-conflict',`${pointer}/keywords/${t.keywords.indexOf(w)}`));else words.set(w,t.tag);}
  }
  if(findings.some(f=>f.severity==='warning'))return report(findings);
  const seen=new Set();
  for(const [i,f] of doc.feedback.entries()){
    if(now()-start>LIMITS.milliseconds)return incomplete('time-limit');
    const pointer=`/feedback/${i}`;
    if(!obj(f)||!id(f.id)||typeof f.redactedText!=='string'||!f.redactedText.length||f.redactedText.length>LIMITS.textLength){findings.push(finding('feedback-invalid',pointer));continue;}
    if(seen.has(f.id)){findings.push(finding('feedback-id-duplicate',pointer));continue;}
    seen.add(f.id);
    if(f.redacted!==true){findings.push(finding('feedback-unredacted',pointer));continue;}
    if(privateText(f.redactedText)){findings.push(finding('private-text-detected',`${pointer}/redactedText`));continue;}
    if(f.semanticSuggestions!==undefined&&(!Array.isArray(f.semanticSuggestions)||f.semanticSuggestions.length>LIMITS.suggestions)){findings.push(finding('semantic-invalid',`${pointer}/semanticSuggestions`));continue;}
    const suggestions=new Map();let bad=false;
    for(const [j,s] of (f.semanticSuggestions||[]).entries()){
      if(!obj(s)||!tag(s.tag)||typeof s.confidence!=='number'||!Number.isFinite(s.confidence)||s.confidence<0||s.confidence>1||suggestions.has(s.tag)){findings.push(finding('semantic-invalid',`${pointer}/semanticSuggestions/${j}`));bad=true;continue;}
      if(!tags.has(s.tag)){findings.push(finding('semantic-unknown-tag',`${pointer}/semanticSuggestions/${j}`));bad=true;continue;}
      suggestions.set(s.tag,s.confidence);
    }
    if(bad)continue;
    const candidates=[];const lower=f.redactedText.toLowerCase();
    for(const [name,keywords] of tags){const ruleHits=keywords.reduce((n,w)=>n+hits(lower,w),0);const semanticConfidence=suggestions.get(name)??null;if(ruleHits||semanticConfidence!==null)candidates.push({tag:name,ruleHits,semanticConfidence});}
    candidates.sort((a,b)=>cmp(a.tag,b.tag));
    for(const c of candidates)(groups[c.tag]??=[]).push(f.id);
    items.push({id:f.id,reviewState:candidates.length>1?'ambiguous':candidates.length===1?'suggested':'unmatched',reviewRequired:true,candidates});
  }
  if(now()-start>LIMITS.milliseconds)return incomplete('time-limit');
  if(findings.some(f=>f.severity==='warning'))return report(findings);
  items.sort((a,b)=>cmp(a.id,b.id));
  const sortedGroups=Object.fromEntries(Object.entries(groups).sort(([a],[b])=>cmp(a,b)).map(([k,v])=>[k,v.sort(cmp)]));
  return report(findings,items,sortedGroups);
}
