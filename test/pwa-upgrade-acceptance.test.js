import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { boundUpgradeArtifacts, containedUpgradeAsset, parseUpgradeArguments, validateInstalledTestIdentity, validateUpgradeReferenceProvenance, matchLaunchedPwaTarget, UPGRADE_REFERENCE_SHA } from '../scripts/verify-pwa-upgrade.mjs';

test('upgrade harness defaults to zero-browser plan, explicit bounded execution only',()=>{
  assert.equal(parseUpgradeArguments([]).execute,undefined);
  assert.equal(parseUpgradeArguments(['--plan']).mode,'native');
  assert.equal(parseUpgradeArguments(['--plan','--existing-holdings']).existingHoldings,true);
  assert.equal(parseUpgradeArguments(['--plan']).existingHoldings,undefined);
  assert.equal(parseUpgradeArguments(['--mode','installed','--installed-entry','current-page','--plan']).installedEntry,'current-page');
  assert.equal(parseUpgradeArguments(['--mode','installed','--plan']).installedEntry,'launch');
  for(const args of [['--execute'],['--samples','0'],['--samples','4'],['--mode','fake'],['--plan','--plan'],['--execute','--plan']])assert.throws(()=>parseUpgradeArguments(args));
});
test('installed current-page entry is explicit native protocol only, rejected outside installed mode',()=>{
  for(const args of [['--installed-entry','current-page'],['--mode','native','--installed-entry','launch'],['--mode','installed','--installed-entry','emulate']])assert.throws(()=>parseUpgradeArguments(args));
});
test('actual artifact preflight calls realpath with a path rather than array callback index/options',async()=>{
  const absent=resolve(tmpdir(),`fundval-nonexistent-${randomUUID()}`);
  await assert.rejects(boundUpgradeArtifacts({'old-site':resolve(absent,'old'),'new-site':resolve(absent,'new')}),error=>error.code==='ENOENT');
});
test('upgrade static server accepts only contained relative inventory paths',()=>{
  const root=resolve('Temp/synthetic-upgrade-root');
  assert.equal(containedUpgradeAsset(root,'js/version.js'),resolve(root,'js/version.js'));
  for(const path of ['../package.json','C:/Windows/win.ini','C:Windows/win.ini','//remote/share/file','js\\bad.js',''])assert.equal(containedUpgradeAsset(root,path),null);
});
test('native PWA installation and cleanup is restricted to own loopback manifest identity',()=>{
  assert.equal(validateInstalledTestIdentity('http://127.0.0.1:12933/FundVal/','http://127.0.0.1:12933'),'http://127.0.0.1:12933/FundVal/');
  for(const [id,origin] of [['https://aureliuswu.github.io/FundVal/','https://aureliuswu.github.io'],['http://127.0.0.1:12934/FundVal/','http://127.0.0.1:12933'],['http://127.0.0.1:4173/FundVal/','http://127.0.0.1:4173'],['http://127.0.0.1:12933/other/','http://127.0.0.1:12933'],['http://u:p@127.0.0.1:12933/FundVal/','http://u:p@127.0.0.1:12933'],['http://127.0.0.1:12933/FundVal/','http://127.0.0.1:12933/path']])assert.throws(()=>validateInstalledTestIdentity(id,origin));
});
test('full old build proof rejects mixed shells/chunks despite unchanged raw source files',()=>{
  const root=resolve('Temp/reference-synthetic-site');
  const artifact={sha256:'a'.repeat(64),fileCount:110,totalBytes:110,files:Array.from({length:110},(_,i)=>({path:`asset-${i}.js`,bytes:1,sha256:'b'.repeat(64)}))};
  const receipt={schema:1,version:'15.0.2',referenceSha:UPGRADE_REFERENCE_SHA,sourceUnchanged:true,sourceInventorySha256:'c'.repeat(64),rawLockSha256:'d'.repeat(64),artifact};
  assert.equal(validateUpgradeReferenceProvenance(receipt,root,root,structuredClone(artifact)).referenceFileCount,110);
  const mixed=structuredClone(artifact);mixed.files[0].sha256='f'.repeat(64);
  assert.throws(()=>validateUpgradeReferenceProvenance(receipt,root,root,mixed));
  for(const change of [{version:'16.0.0'},{referenceSha:'f'.repeat(40)},{sourceUnchanged:false}])assert.throws(()=>validateUpgradeReferenceProvenance({...receipt,...change},root,root,artifact));
  assert.throws(()=>validateUpgradeReferenceProvenance(receipt,root,resolve('Temp/other-site'),artifact));
});
test('installed target binding permits only native same-context own-origin page ancestry, never an arbitrary matching URL',()=>{
  const origin='http://127.0.0.1:12933',contextId='synthetic-profile',url=origin+'/FundVal/';
  const tab={targetId:'app-tab',type:'tab',url,browserContextId:contextId},page={targetId:'app-page',parentId:'app-tab',type:'page',url,browserContextId:contextId};
  const match=infos=>matchLaunchedPwaTarget({launchTargetId:'app-tab',pageTargetId:'app-page',targetInfos:infos,origin,contextId});
  assert.deepEqual(match([tab,page]).ancestry.map(row=>row.targetId),['app-page','app-tab']);
  assert.equal(match([tab,{...page,parentId:'other-tab'}]),null);
  assert.equal(match([tab,{...page,browserContextId:'other-profile'}]),null);
  assert.equal(match([{...tab,browserContextId:'other-profile'},page]),null);
  assert.equal(match([tab,{...page,url:'https://example.test/FundVal/'}]),null);
  assert.equal(match([tab,{...page,parentId:'app-page'}]),null);
  assert.equal(match([tab,{...page,url:url+'?token=synthetic'}]),null);
  assert.equal(matchLaunchedPwaTarget({launchTargetId:'app-page',pageTargetId:'app-page',targetInfos:[page],origin,contextId}).ancestry.length,1);
});
