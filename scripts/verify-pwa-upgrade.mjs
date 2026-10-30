import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inventorySite, validateCandidateManifest } from './release-candidate.mjs';
import { canonicalHoldingsDocument } from '../js/storage/holdings-schema.js';
import { artifactFingerprint } from './measure-performance-pair.mjs';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
export const UPGRADE_REFERENCE_SHA = '40e68edab9cb3fba0b17338dc3672a82d13ad17e';
export const UPGRADE_TARGET_SHA = '35808ee3b4698db1f9919cbc8f0d4033f9baa986';
const VERSIONS = ['15.0.2', '16.0.0'];
const MIME = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png' };
const hash = value => createHash('sha256').update(value).digest('hex');
const canonicalText = value => String(value).replace(/\r\n/g, '\n');

export function containedUpgradeAsset(root, path) {
  if (typeof path !== 'string' || !path || /[\\\0]/.test(path) || isAbsolute(path) || win32.parse(path).root) return null;
  const value = resolve(root, path), child = relative(root, value);
  return child.startsWith('..') || isAbsolute(child) ? null : value;
}

export function validateInstalledTestIdentity(appId, origin) {
  const base = new URL(origin);
  assert.equal(base.protocol, 'http:');
  assert.equal(base.hostname, '127.0.0.1');
  assert.equal(base.username,''); assert.equal(base.password,'');
  assert.equal(base.origin,origin);
  assert.ok(base.port && Number(base.port)>=1024 && Number(base.port)<=65535 && Number(base.port) !== 4173);
  assert.equal(appId, new URL('/FundVal/', base).href, 'Only this run-owned manifest identity can be installed/uninstalled');
  return appId;
}

export function matchLaunchedPwaTarget({launchTargetId,pageTargetId,targetInfos,origin,contextId}){
  if(typeof contextId!=='string'||!contextId||!Array.isArray(targetInfos))return null;
  const byId=new Map(targetInfos.map(info=>[info.targetId,info])),page=byId.get(pageTargetId),launch=byId.get(launchTargetId);
  const ownUrl=info=>{try{const url=new URL(info.url);return url.origin===origin&&!url.username&&!url.password&&!url.search&&!url.hash&&['/FundVal/','/FundVal/index.html'].includes(url.pathname);}catch{return false;}};
  if(!page||!launch||page.type!=='page'||!ownUrl(page)||!ownUrl(launch)||page.browserContextId!==contextId||launch.browserContextId!==contextId)return null;
  const ancestry=[],seen=new Set();let current=page;
  while(current&&ancestry.length<16){
    if(seen.has(current.targetId)||current.browserContextId!==contextId||!['page','tab'].includes(current.type))return null;
    seen.add(current.targetId);ancestry.push({targetId:current.targetId,type:current.type,parentId:current.parentId||null,browserContextId:current.browserContextId});
    if(current.targetId===launchTargetId)return {launchTargetId,pageTargetId,ancestry};
    current=current.parentId?byId.get(current.parentId):null;
  }
  return null;
}

export function parseUpgradeArguments(args) {
  const options = { mode:'native', samples:3, installedEntry:'launch' }, seen = new Set();
  for (let index=0; index<args.length; index++) {
    const name=args[index];
    if (seen.has(name)) throw new Error('Duplicate argument'); seen.add(name);
    if (name==='--execute') options.execute=true;
    else if (name==='--plan') options.plan=true;
    else if (name==='--existing-holdings') options.existingHoldings=true;
    else if (['--old-site','--old-provenance','--new-site','--new-candidate-json','--output','--mode','--samples','--installed-entry'].includes(name)) {
      const value=args[++index]; if (!value || value.startsWith('--')) throw new Error('Missing argument value');
      options[name==='--installed-entry'?'installedEntry':name.slice(2)]=name==='--samples'?Number(value):value;
    } else throw new Error('Unknown argument');
  }
  if (!['native','installed'].includes(options.mode) || !Number.isInteger(options.samples) || options.samples<1 || options.samples>3) throw new Error('Invalid bounded mode/sample count');
  if(!['launch','current-page'].includes(options.installedEntry)||(seen.has('--installed-entry')&&options.mode!=='installed'))throw new Error('Native installed entry is explicit and installed-mode only');
  if (options.execute) {
    if (options.plan) throw new Error('Choose plan or execute');
    for (const key of ['old-site','old-provenance','new-site','new-candidate-json','output']) if (!isAbsolute(options[key]||'')) throw new Error('Explicit absolute artifact/provenance/output paths are required');
  }
  return options;
}

export function validateUpgradeReferenceProvenance(receipt,claimedRoot,actualRoot,actualArtifact){
  assert.equal(receipt?.schema,1);assert.equal(receipt.version,'15.0.2');assert.equal(receipt.referenceSha,UPGRADE_REFERENCE_SHA);assert.equal(receipt.sourceUnchanged,true);
  assert.match(receipt.sourceInventorySha256,/^[a-f0-9]{64}$/);assert.match(receipt.rawLockSha256,/^[a-f0-9]{64}$/);
  assert.equal(claimedRoot,actualRoot,'Reference provenance must name this exact realpath');
  assert.equal(actualArtifact.fileCount,110,'The frozen original reference build has 110 complete files');
  assert.deepEqual(actualArtifact,receipt.artifact,'All v15 shell/chunk/resource bytes, hashes and counts must match the independently prepared build provenance');
  return {referenceBuildFingerprint:actualArtifact.sha256,referenceFileCount:actualArtifact.fileCount,referenceBytes:actualArtifact.totalBytes,sourceInventorySha256:receipt.sourceInventorySha256,rawLockSha256:receipt.rawLockSha256};
}

export async function boundUpgradeArtifacts(options) {
  const roots=await Promise.all([options['old-site'],options['new-site']].map(path=>realpath(path)));
  assert.notEqual(roots[0],roots[1]);
  const inventories=await Promise.all(roots.map(inventorySite));
  const referenceReceipt=JSON.parse(await readFile(options['old-provenance'],'utf8'));
  const referenceProof=validateUpgradeReferenceProvenance(referenceReceipt,await realpath(referenceReceipt.siteRoot),roots[0],await artifactFingerprint(roots[0]));
  const candidate=validateCandidateManifest(JSON.parse(await readFile(options['new-candidate-json'],'utf8')), {
    repository:'AureliusWu/FundVal',sha:UPGRADE_TARGET_SHA,runId:'40877032757',attempt:'1',
  });
  assert.deepEqual(inventories[1],candidate.site,'Use the complete original released v16 candidate, not a changed local build');
  const bindings=[];
  for (const path of ['js/app.js','js/bootstrap.js','js/integrity.js','js/storage.js','js/storage/holdings-schema.js','js/version.js','manifest.json']) {
    const source=execFileSync('git',['show',`${UPGRADE_REFERENCE_SHA}:${path}`],{cwd:ROOT,encoding:'utf8',stdio:['ignore','pipe','pipe']});
    const built=await readFile(resolve(roots[0],path),'utf8');
    assert.equal(canonicalText(built),canonicalText(source),`v15 source binding: ${path}`);
    bindings.push({path,normalizedSha256:hash(canonicalText(built))});
  }
  for(let index=0; index<2; index++) {
    const version=await readFile(resolve(roots[index],'js/version.js'),'utf8');
    assert.equal(version.match(/APP_VERSION\s*=\s*['"]([^'"]+)/)?.[1],VERSIONS[index]);
    const worker=await readFile(resolve(roots[index],'sw.js'),'utf8');
    assert.equal(worker.match(/const CACHE\s*=\s*['"]([^'"]+)/)?.[1],`fuyu-v${VERSIONS[index]}`);
  }
  return {roots,inventories,candidate,bindings,referenceProof};
}

async function servingPair(artifacts) {
  const activity={phase:0,writes:0,apiReads:0,externalBlocked:0,unsafePaths:0,served:[],closed:false};
  const files=artifacts.inventories.map(inventory=>new Map(inventory.files.map(file=>[file.path,file])));
  const server=createServer(async(request,response)=>{
    response.setHeader('Cache-Control','no-store');
    if (!['GET','HEAD'].includes(request.method)) {activity.writes++;response.writeHead(405).end();return;}
    const url=new URL(request.url,'http://127.0.0.1');
    if (url.pathname.startsWith('/__fundval_dev/')) {activity.apiReads++;response.writeHead(503,{'Content-Type':'application/json'}).end('{"error":"synthetic_unavailable"}');return;}
    if (!url.pathname.startsWith('/FundVal/')) {response.writeHead(404).end();return;}
    let path;try{path=decodeURIComponent(url.pathname.slice('/FundVal/'.length))||'index.html';}catch{response.writeHead(400).end();return;}
    const phase=activity.phase,full=containedUpgradeAsset(artifacts.roots[phase],path),expected=files[phase].get(path);
    if(!full||!expected){activity.unsafePaths++;response.writeHead(404).end();return;}
    try{
      const body=await readFile(full);assert.equal(body.length,expected.bytes);assert.equal(hash(body),expected.sha256);
      if (['sw.js','index.html','js/app-shell.js','manifest.json'].includes(path)||path.startsWith('js/chunks/')) activity.served.push({version:VERSIONS[phase],path,sha256:hash(body)});
      response.writeHead(200,{'Content-Type':MIME[extname(path)]||'application/octet-stream'});response.end(request.method==='HEAD'?undefined:body);
    }catch{response.writeHead(500).end();}
  });
  await new Promise((done,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',done);});
  const origin=`http://127.0.0.1:${server.address().port}`;
  assert.notEqual(new URL(origin).port,'4173');
  return {origin,activity,async close(){server.closeAllConnections();await new Promise(done=>server.close(done));activity.closed=true;}};
}

async function workerVersion(page,which='controller') {
  return page.evaluate(async(which)=>{
    const registration=await navigator.serviceWorker.getRegistration();
    const worker=which==='controller'?navigator.serviceWorker.controller:registration?.[which];
    if(!worker)return null;
    return new Promise((done,fail)=>{const channel=new MessageChannel(),timer=setTimeout(()=>{channel.port1.close();fail(new Error('version_message_timeout'));},3000);channel.port1.onmessage=event=>{clearTimeout(timer);channel.port1.close();done(event.data?.cache||null);};worker.postMessage({type:'GET_VERSION'},[channel.port2]);});
  },which);
}

async function holdingsSnapshot(page) {
  return page.evaluate(async()=>{
    if(localStorage.getItem('fuyu_gist_token')||localStorage.getItem('fuyu_gist_id'))throw new Error('Synthetic empty cloud configuration required');
    const raw=localStorage.getItem('fuyu_holdings_v3');if(!raw)throw new Error('Missing synthetic holdings');
    const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw));
    return {sha256:[...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join(''),schema:JSON.parse(raw).schema};
  });
}

async function waitFor(predicate,description,timeout=15000) {
  const deadline=Date.now()+timeout;
  do{if(await predicate())return;await new Promise(done=>setTimeout(done,50));}while(Date.now()<deadline);
  throw new Error(`Deadline: ${description}`);
}

async function protocolDeadline(promise,description,timeout=20000){
  let timer;
  try{return await Promise.race([promise,new Promise((_,fail)=>{timer=setTimeout(()=>fail(new Error(`Protocol deadline: ${description}`)),timeout);})]);}
  finally{clearTimeout(timer);}
}

async function runSample(chromium,artifacts,options,index,output) {
  const host=await servingPair(artifacts),events=[];
  const result={sample:index,mode:options.mode,result:'FAIL',sourceVersions:VERSIONS,sourceShas:[UPGRADE_REFERENCE_SHA,UPGRADE_TARGET_SHA],
    personalProfileUsed:false,liveGistWrites:0,providerData:'SYNTHETIC_UNAVAILABLE_NO_LIVE_CLAIM',pageErrors:[],sameOriginHttpErrors:[],events,contextClosed:false,browserClosed:false,installed:{status:options.mode==='installed'?'PENDING':'NOT_RUN',mobileClaim:false}};
  let browser,context,page,appIdentity,installed=false,installationAttempted=false;
  try{
    if(options.mode==='installed'){
      context=await chromium.launchPersistentContext(resolve(output,`isolated-profile-${index}`),{channel:'chrome',headless:true,serviceWorkers:'allow',viewport:{width:390,height:844},args:['--disable-background-networking']});browser=context.browser();
    }else{browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-background-networking']});context=await browser.newContext({serviceWorkers:'allow',viewport:{width:390,height:844}});}
    result.browserVersion=browser.version();context.on('close',()=>{result.contextClosed=true;});
    await context.exposeBinding('__recordPwaUpgrade',({page},kind)=>{events.push({kind,urlPath:new URL(page.url()).pathname});});
    const device='upgrade-synthetic:'+randomUUID(),now=new Date().toISOString();
    const existingHoldings=options.existingHoldings?{device,raw:canonicalHoldingsDocument({schema:3,updatedAt:now,deviceId:device,holdings:[{id:'fund:005844',fundCode:'005844',fundName:'合成PWA跨版本升级持仓',shares:100,costNav:0,createdAt:now,updatedAt:now,deletedAt:null,revision:1,deviceId:device,note:null}]})}:null;
    if(existingHoldings)result.existingHoldingsSeedSha256=hash(existingHoldings.raw);
    result.variant=options.existingHoldings?'existingHoldingsDiscardDraftThenUpgrade':'oldUiSaveThenUpgrade';
    await context.addInitScript(({origin,existingHoldings})=>{
      if(window!==window.top||location.origin!==origin)return;
      if(existingHoldings&&!localStorage.getItem('fuyu_pwa_upgrade_seeded_v1')){
        localStorage.setItem('fuyu_device_id_v1',existingHoldings.device);
        localStorage.setItem('fuyu_holdings_v3',existingHoldings.raw);
        localStorage.setItem('fuyu_pwa_upgrade_seeded_v1','1');
      }
      window.__pwaUpgradeDocumentId=crypto.randomUUID();
      const record=kind=>window.__recordPwaUpgrade(kind).catch(()=>{});
      const native=ServiceWorker.prototype.postMessage;
      ServiceWorker.prototype.postMessage=function(message,...rest){if(message?.type==='SKIP_WAITING')record('skip-waiting');return native.call(this,message,...rest);};
      navigator.serviceWorker.addEventListener('message',event=>{if(event.data?.type==='UPDATE_ACTIVATED')record('update-activated');});
      navigator.serviceWorker.addEventListener('controllerchange',()=>{record('controllerchange');});
    },{origin:host.origin,existingHoldings});
    await context.route('**/*',route=>{const request=route.request(),url=new URL(request.url());if(url.origin===host.origin&&['GET','HEAD'].includes(request.method()))return route.continue();host.activity.externalBlocked++;if(!['GET','HEAD'].includes(request.method()))result.liveGistWrites++;return route.abort('blockedbyclient');});
    await context.routeWebSocket('**/*',socket=>{result.blockedSockets=(result.blockedSockets||0)+1;socket.close();});
    page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',error=>result.pageErrors.push(error.name));
    let initialNavigations=0;page.on('framenavigated',frame=>{if(frame===page.mainFrame())initialNavigations++;});
    page.on('response',response=>{const url=new URL(response.url());if(url.origin===host.origin&&response.status()>=400)result.sameOriginHttpErrors.push({path:url.pathname,status:response.status()});});
    await page.goto(`${host.origin}/FundVal/`,{waitUntil:'domcontentloaded',timeout:30000});
    // Both shipped clients deliberately reload on the first native claim.
    // Never begin editing in the transient pre-reload document.
    await waitFor(async()=>initialNavigations===2,'complete actual first-install controllerchange reload');
    await waitFor(async()=>{try{return await page.locator('html').getAttribute('data-app-ready')==='true'&&await page.locator('#app-version-label').innerText()==='15.0.2'&&await workerVersion(page)==='fuyu-v15.0.2';}catch{return false;}},'v15 actual controller and app ready');
    result.firstInstallMainFrameNavigations=initialNavigations;
    result.stage='old-app-ready';
    const cdp=await context.newCDPSession(page);
    const oldManifest=await cdp.send('Page.getAppManifest');
    const oldId=await cdp.send('Page.getAppId');
    result.nativeOldManifest={errors:oldManifest.errors,appId:oldId.appId,recommendedId:oldId.recommendedId};
    if(options.mode==='installed'){
      try{
        appIdentity=validateInstalledTestIdentity(oldId.appId,host.origin);
        const browserCdp=await browser.newBrowserCDPSession();
        installationAttempted=true;
        await protocolDeadline(browserCdp.send('PWA.install',{manifestId:appIdentity,installUrlOrBundleUrl:`${host.origin}/FundVal/`}), 'install own test app');installed=true;
        result.installed.status='INSTALLED';result.installed.manifestIdentity=appIdentity;
        result.installed.osState=await protocolDeadline(browserCdp.send('PWA.getOsAppState',{manifestId:appIdentity}),'own app OS state');
        result.installed.entry=options.installedEntry;
        let appPage;
        if(options.installedEntry==='current-page'){
          const before=(await cdp.send('Target.getTargetInfo')).targetInfo;
          assert.equal(before.type,'page');assert.ok(before.browserContextId);assert.equal(before.url,`${host.origin}/FundVal/`);
          result.installed.currentPageTargetBefore={targetId:before.targetId,type:before.type,browserContextId:before.browserContextId};
          try{result.installed.windowBefore=(await cdp.send('Browser.getWindowForTarget')).windowId;}catch{result.installed.windowBeforeQuery='UNAVAILABLE';}
          await protocolDeadline(cdp.send('PWA.openCurrentPageInApp',{manifestId:appIdentity}),'open exact current old page in own installed app');
          result.installed.openCurrentPageProtocolReturned=true;
          const after=(await cdp.send('Target.getTargetInfo')).targetInfo;
          assert.equal(after.targetId,before.targetId);assert.equal(after.browserContextId,before.browserContextId);assert.equal(after.url,`${host.origin}/FundVal/`);
          result.installed.currentPageTargetAfter={targetId:after.targetId,type:after.type,browserContextId:after.browserContextId};
          try{result.installed.windowAfter=(await cdp.send('Browser.getWindowForTarget')).windowId;}catch{result.installed.windowAfterQuery='UNAVAILABLE';}
          appPage=page;
        }else{
        const target=await protocolDeadline(browserCdp.send('PWA.launch',{manifestId:appIdentity}),'launch own test app');
        result.installed.launchTargetId=target.targetId;
        const oldTarget=(await cdp.send('Target.getTargetInfo')).targetInfo;
        result.installed.oldPageTarget={targetId:oldTarget.targetId,type:oldTarget.type,browserContextId:oldTarget.browserContextId};
        const diagnostic=async()=>{
          const infos=(await browserCdp.send('Target.getTargets',{filter:[{}]})).targetInfos;
          const launched=(await browserCdp.send('Target.getTargetInfo',{targetId:target.targetId})).targetInfo;
          const own=infos.filter(info=>info.targetId===target.targetId||info.targetId===oldTarget.targetId||(()=>{try{return new URL(info.url).origin===host.origin;}catch{return false;}})());
          result.installed.targetMetadata=own.map(info=>({targetId:info.targetId,type:info.type,parentId:info.parentId||null,browserContextId:info.browserContextId,attached:info.attached,ownOrigin:(()=>{try{return new URL(info.url).origin===host.origin;}catch{return false;}})()}));
          result.installed.launchTargetType=launched.type;
          return infos;
        };
        await waitFor(async()=>{
          const infos=await diagnostic();
          for(const candidate of context.pages()){
            const session=await context.newCDPSession(candidate);let info;
            try{info=(await session.send('Target.getTargetInfo')).targetInfo;}finally{await session.detach();}
            const proof=matchLaunchedPwaTarget({launchTargetId:target.targetId,pageTargetId:info.targetId,targetInfos:infos,origin:host.origin,contextId:oldTarget.browserContextId});
            if(proof){appPage=candidate;result.installed.targetIdentityProof=proof;return true;}
          }
          return false;
        },'installed PWA target ancestry');
        const appCdp=await context.newCDPSession(appPage);
        try{
          const launchWindow=await browserCdp.send('Browser.getWindowForTarget',{targetId:target.targetId}),pageWindow=await appCdp.send('Browser.getWindowForTarget');
          result.installed.nativeWindowId=launchWindow.windowId;result.installed.pageWindowId=pageWindow.windowId;assert.equal(launchWindow.windowId,pageWindow.windowId);
        }catch(error){if(error.name==='AssertionError')throw error;result.installed.windowQueryStatus='UNAVAILABLE';result.installed.windowQueryErrorName=error.name;}
        await appCdp.detach();
        }
        await appPage.waitForFunction(()=>document.documentElement.dataset.appReady==='true');
        await appPage.waitForFunction(()=>matchMedia('(display-mode: standalone)').matches,null,{timeout:8000});
        result.installed.standalone=await appPage.evaluate(()=>matchMedia('(display-mode: standalone)').matches);
        assert.equal(result.installed.standalone,true,'Actual installed app must report standalone, not emulated display mode');
        if(page!==appPage){await page.close();page=appPage;page.on('pageerror',error=>result.pageErrors.push(error.name));}page.setDefaultTimeout(8000);
      }catch(error){result.installed.status=installed?'INSTALLED_LAUNCH_NOT_VERIFIED':'NOT_RUN_PLATFORM_UNAVAILABLE';result.installed.errorName=error.name;result.installed.reason='Native installed entry/target/standalone not verified; do not substitute a manifest replay';throw error;}
    }
    await page.locator('#nav-edit').click();
    if(!options.existingHoldings){await page.locator('#i-code').fill('005844');await page.locator('#i-name').fill('合成PWA跨版本升级持仓');await page.locator('#i-shares').fill('100');await page.locator('#i-cost').fill('0');await page.locator('#add-btn').click();}
    await page.locator('.holding-item[data-code="005844"]').waitFor({state:'visible'});
    result.oldHoldings=await holdingsSnapshot(page);assert.equal(result.oldHoldings.schema,3);
    if(options.existingHoldings)assert.equal(result.oldHoldings.sha256,result.existingHoldingsSeedSha256,'The real old App must preserve/read the canonical pre-existing holding');
    result.oldCacheKeys=await page.evaluate(()=>caches.keys());assert.ok(result.oldCacheKeys.includes('fuyu-v15.0.2'));
    await page.locator('.holding-item[data-code="005844"]').click();await page.locator('#i-shares').fill('101');result.stage='old-dirty-draft';
    const beforeDocument=await page.evaluate(()=>window.__pwaUpgradeDocumentId);
    host.activity.phase=1;
    await page.evaluate(async()=>(await navigator.serviceWorker.getRegistration()).update());
    await waitFor(async()=>await workerVersion(page,'waiting')==='fuyu-v16.0.0','real distinct v16 worker waiting');
    result.stage='new-worker-waiting-old-draft';
    await page.locator('#update-banner').waitFor({state:'visible'});await page.locator('#update-now-btn').click();
    await page.locator('#update-banner-text').filter({hasText:'请先保存或清空当前输入'}).waitFor({state:'visible'});
    assert.equal(await page.evaluate(()=>window.__pwaUpgradeDocumentId),beforeDocument);assert.equal(await page.locator('#i-shares').inputValue(),'101');
    assert.deepEqual(await holdingsSnapshot(page),result.oldHoldings);assert.equal(await workerVersion(page),'fuyu-v15.0.2');assert.equal(await workerVersion(page,'waiting'),'fuyu-v16.0.0');assert.equal(events.filter(e=>e.kind==='skip-waiting').length,0);result.dirtyDraftPreservedAndUpdateBlocked=true;
    if(options.existingHoldings){
      await page.locator('#cancel-edit-btn').click();
      await waitFor(async()=>await page.locator('#i-shares').inputValue()==='','draft explicitly discarded by native UI');
      assert.deepEqual(await holdingsSnapshot(page),result.oldHoldings);
      result.oldUiSaveLane='NOT_RUN_IN_EXISTING_HOLDINGS_VARIANT';result.draftResolution='EXPLICIT_NATIVE_CANCEL_NO_STORAGE_CHANGE';
    }else{await page.locator('#add-btn').click();await waitFor(async()=>await page.locator('#i-shares').inputValue()==='','saved draft cleared');result.oldUiSaveLane='PASS';result.draftResolution='SAVED_BY_OLD_UI';}
    result.preUpgradeHoldings=await holdingsSnapshot(page);result.stage='safe-update';
    await page.locator('#update-now-btn').click();
    await waitFor(async()=>{try{return await page.locator('html').getAttribute('data-app-ready')==='true'&&await page.locator('#app-version-label').innerText()==='16.0.0'&&await workerVersion(page)==='fuyu-v16.0.0';}catch{return false;}},'v16 actual ready/controller after safe update',20000);
    if(options.mode==='installed'){result.installed.standaloneAfterUpdate=await page.evaluate(()=>matchMedia('(display-mode: standalone)').matches);assert.equal(result.installed.standaloneAfterUpdate,true);}
    assert.notEqual(await page.evaluate(()=>window.__pwaUpgradeDocumentId),beforeDocument);
    result.newHoldings=await holdingsSnapshot(page);assert.deepEqual(result.newHoldings,result.preUpgradeHoldings);
    assert.equal(await workerVersion(page,'waiting'),null);result.noWaitingWorkerAfterUpdate=true;
    result.newCacheKeys=await page.evaluate(()=>caches.keys());assert.deepEqual(result.newCacheKeys.filter(key=>key.startsWith('fuyu-v')).sort(),['fuyu-v15.0.2','fuyu-v16.0.0']);
    const newCdp=await context.newCDPSession(page),newId=await newCdp.send('Page.getAppId');assert.equal(newId.appId,oldId.appId);result.manifestIdentityPreserved=true;
    await page.locator('#nav-edit').click();await page.locator('.holding-item[data-code="005844"]').click();assert.equal(await page.locator('#i-shares').inputValue(),options.existingHoldings?'100':'101');assert.equal(await page.locator('#i-cost').inputValue(),'0');
    if(options.existingHoldings){result.stage='v16-native-save';await page.locator('#i-shares').fill('101');await page.locator('#add-btn').click();await waitFor(async()=>await page.locator('#i-shares').inputValue()==='','v16 saved draft cleared');result.postUpgradeUiSave=true;}
    else await page.locator('#cancel-edit-btn').click();
    result.postUpgradeSavedHoldings=await holdingsSnapshot(page);if(options.existingHoldings)assert.notEqual(result.postUpgradeSavedHoldings.sha256,result.preUpgradeHoldings.sha256);
    result.stage='offline-reopen';
    await context.setOffline(true);const started=performance.now();await page.reload({waitUntil:'domcontentloaded',timeout:10000});
    await page.waitForFunction(()=>document.documentElement.dataset.appReady==='true',null,{timeout:3000});await page.locator('#nav-edit').click();await page.locator('.holding-item[data-code="005844"]').click();
    result.offlineToEditableHoldingsMs=performance.now()-started;assert.ok(result.offlineToEditableHoldingsMs<=3000);
    assert.equal(await page.locator('#i-shares').inputValue(),'101');assert.equal(await page.locator('#i-cost').inputValue(),'0');assert.deepEqual(await holdingsSnapshot(page),result.postUpgradeSavedHoldings);
    if(options.mode==='installed'){result.installed.standaloneAfterOffline=await page.evaluate(()=>matchMedia('(display-mode: standalone)').matches);assert.equal(result.installed.standaloneAfterOffline,true);}
    result.offlineReopenPreservedHoldings=true;assert.deepEqual(result.pageErrors,[]);assert.equal(result.liveGistWrites,0);assert.equal(host.activity.writes,0);
    result.stage='complete';result.result='PASS';
  }catch(error){
    result.failure={name:error.name,detail:String(error.message).slice(0,300).replace(/[A-Z]:[\\/][^\n]+/g,'[local-path]')};
    if(page&&!page.isClosed())try{result.failureState=await page.evaluate(()=>({version:document.getElementById('app-version-label')?.textContent,ready:document.documentElement.dataset.appReady,documentId:window.__pwaUpgradeDocumentId,holdingRows:document.querySelectorAll('.holding-item').length,hasSavedDocument:localStorage.getItem('fuyu_holdings_v3')!==null,codeIsSynthetic:document.getElementById('i-code')?.value==='005844',sharesIsSynthetic:document.getElementById('i-shares')?.value==='100',costIsZero:document.getElementById('i-cost')?.value==='0',addDisabled:document.getElementById('add-btn')?.disabled,saveFailureToast:/保存失败/.test(document.getElementById('toast')?.textContent||'')}));}catch{result.failureStateUnavailable=true;}
  }
  finally{
    if(installationAttempted&&appIdentity&&browser?.isConnected()){
      try{const session=await browser.newBrowserCDPSession();validateInstalledTestIdentity(appIdentity,host.origin);await protocolDeadline(session.send('PWA.uninstall',{manifestId:appIdentity}),'uninstall only own test app');result.installed.uninstalledOwnTestApp=true;}catch(error){result.installed.uninstalledOwnTestApp=false;result.installed.uninstallErrorName=error.name;result.installed.noInstalledAppReported=/not.*installed|not found/i.test(String(error.message));result.result='FAIL';}
    }
    if(installationAttempted&&result.installed.uninstalledOwnTestApp!==true){result.installed.uninstalledOwnTestApp=false;result.result='FAIL';}
    try{await context?.close();}catch{result.contextCloseFailed=true;result.result='FAIL';}
    try{if(browser?.isConnected())await browser.close();result.browserClosed=Boolean(browser);}catch{result.browserCloseFailed=true;result.result='FAIL';}
    await host.close();result.serverClosed=host.activity.closed;result.activity=host.activity;
    if(!result.contextClosed||!result.browserClosed||!result.serverClosed)result.result='FAIL';
  }
  return result;
}

export async function verifyPwaUpgrade(options) {
  const output=resolve(await realpath(dirname(options.output)),basename(options.output));
  for(const artifactPath of [options['old-site'],options['new-site']]){
    const child=relative(await realpath(artifactPath),output);
    assert.ok(child==='..'||child.startsWith('..\\')||child.startsWith('../')||isAbsolute(child),'Evidence/profile output must be outside both source artifacts');
  }
  await mkdir(output,{recursive:false});
  const report={schema:1,scope:'EXACT_TWO_VERSION_LOCAL_NATIVE_SW_AND_OPTIONAL_DESKTOP_INSTALL',startedAt:new Date().toISOString(),verdict:'FAIL',mode:options.mode,installedEntry:options.installedEntry,harnessSha256:hash(await readFile(fileURLToPath(import.meta.url))),samples:[],physicalAndroidIosAcceptance:'NOT_RUN',liveDataAcceptance:'NOT_RUN',productionDeploymentChanged:false};
  try{
    const artifacts=await boundUpgradeArtifacts(options);
    report.artifacts={referenceSha:UPGRADE_REFERENCE_SHA,targetSha:UPGRADE_TARGET_SHA,referenceInventory:artifacts.inventories[0].fingerprint,...artifacts.referenceProof,targetInventory:artifacts.inventories[1].fingerprint,targetReleaseFingerprint:artifacts.candidate.releaseFingerprint,referenceSelectedSourceBindings:artifacts.bindings};
    const {chromium}=await import('playwright');
    report.requestedSamples=options.samples;
    for(let index=1;index<=options.samples;index++){const sample=await runSample(chromium,artifacts,options,index,output);report.samples.push(sample);if(sample.result!=='PASS')break;}
    assert.deepEqual(await Promise.all(artifacts.roots.map(inventorySite)),artifacts.inventories,'Read-only source artifacts must remain unchanged');
    report.verdict=report.samples.every(sample=>sample.result==='PASS')?'PASS':'FAIL';
  }catch(error){report.failure={name:error.name,detail:String(error.message).slice(0,300).replace(/[A-Z]:[\\/][^\n]+/g,'[local-path]')};}
  finally{report.finishedAt=new Date().toISOString();await writeFile(resolve(output,'receipt.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});}
  return report;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  try{
    const options=parseUpgradeArguments(process.argv.slice(2));
    if(!options.execute)console.log(JSON.stringify({status:'PREPARED_NOT_RUN',network:0,browser:0,versions:VERSIONS,referenceSha:UPGRADE_REFERENCE_SHA,targetSha:UPGRADE_TARGET_SHA,mode:options.mode,installedEntry:options.installedEntry,variant:options.existingHoldings?'existingHoldingsDiscardDraftThenUpgrade':'oldUiSaveThenUpgrade',requires:'--execute with absolute --old-site --old-provenance --new-site --new-candidate-json --output',scope:'Native two-version worker test; installed mode additionally requires actual native PWA install+standalone launch; neither proves physical phones'},null,2));
    else{const report=await verifyPwaUpgrade(options);console.log(JSON.stringify({verdict:report.verdict,mode:report.mode,samples:report.samples.map(({sample,result,failure,installed})=>({sample,result,failure,installed}))},null,2));if(report.verdict!=='PASS')process.exitCode=1;}
  }catch(error){console.error(JSON.stringify({verdict:'BLOCKED',errorName:error.name}));process.exitCode=1;}
}
