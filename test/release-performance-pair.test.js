import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReleaseOptions, releaseHealth, releaseStaticPath } from '../scripts/measure-release-performance.mjs';

const required=['--reference-provenance','reference.json','--candidate-json','candidate.json','--current-site','site','--output','new-report.json'];
test('release pair retains original 60/4/5000 configuration and rejects weakened sampling',()=>{
  const options=parseReleaseOptions(required);
  assert.equal(options.pairs,60);assert.equal(options.warmupPairs,4);assert.equal(options.bootstrap,5000);assert.equal(options.timeoutMs,30000);
  for(const pairs of ['2','59','61','0','NaN','60.5','1002'])assert.throws(()=>parseReleaseOptions([...required,'--pairs',pairs]));
  assert.equal(parseReleaseOptions([...required,'--pairs','80']).pairs,80);
  assert.throws(()=>parseReleaseOptions([...required,'--bootstrap','1000']));
  assert.throws(()=>parseReleaseOptions([...required,'--output','other.json']));
  assert.throws(()=>parseReleaseOptions(required.slice(2)));
});
test('release static paths stay normalized and malformed or encoded unsafe paths fail closed',()=>{
  assert.equal(releaseStaticPath('/'),'index.html');assert.equal(releaseStaticPath('/js/app-shell.js?ignored=1'),'js/app-shell.js');
  for(const path of ['/%2e%2e%2fsecret','/js%5csecret','/a//b','/%00secret','/%ZZ'])assert.equal(releaseStaticPath(path),null);
});
test('release health never hides missing pairs, page errors, instrumentation failures or failed samples',()=>{
  const side=()=>({pageErrors:0,networkInstrumentation:{failures:0}});
  const pair=()=>({retained:true,reference:side(),current:side()});
  assert.equal(releaseHealth([pair()],1).verdict,'PASS');
  assert.equal(releaseHealth([pair()],2).verdict,'INCONCLUSIVE');
  const missing=pair();missing.current=null;assert.equal(releaseHealth([missing],1).verdict,'INCONCLUSIVE');
  const error=pair();error.current.pageErrors=1;assert.equal(releaseHealth([error],1).verdict,'INCONCLUSIVE');
  const network=pair();network.reference.networkInstrumentation.failures=1;assert.equal(releaseHealth([network],1).verdict,'INCONCLUSIVE');
  const failed=pair();failed.failure={side:'current'};assert.equal(releaseHealth([failed],1).verdict,'INCONCLUSIVE');
  const unknown=pair();delete unknown.current.pageErrors;assert.equal(releaseHealth([unknown],1).verdict,'INCONCLUSIVE');
  assert.equal(releaseHealth([unknown],1).pageErrors,null);
});
