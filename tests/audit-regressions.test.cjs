const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),test=require('node:test');
function load(file,sandbox){vm.createContext(sandbox);vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),sandbox);return sandbox;}
function background(stored) {
  let handler,exists=false,creates=0;const queued=[];
  const c={Date:class extends Date{static now(){return 200;}},chrome:{
    runtime:{onInstalled:{addListener(){}},onStartup:{addListener(){}},onMessage:{addListener(f){handler=f;}},getURL:x=>x,
      async getContexts(){return exists?[{}]:[];},async sendMessage(m){queued.push(m.job.documentId);return {ok:true};}},
    storage:{session:{async get(){return {downloadState:stored};},async set(){}}},
    offscreen:{async createDocument(){if(++creates>1)throw Error('Only one offscreen document');exists=true;}}
  }};
  load('background.js',c);
  return {c,queued,creates:()=>creates,status:()=>new Promise(resolve=>handler({type:'get-status'},{},resolve))};
}
test('worker restart restores completed, failed, and active persisted progress',async()=>{
  for(const phase of ['complete','failed','rendering']){
    const saved={phase,completed:7,total:10,running:phase==='rendering',updatedAt:100};
    const {status}=background(saved);assert.deepEqual((await status()).state,saved);
  }
});
test('simultaneous first jobs create only one offscreen renderer and enqueue both',async()=>{
  const {c,queued,creates}=background();
  await Promise.all([c.startJob({documentId:'one'}),c.startJob({documentId:'two'})]);
  assert.equal(creates(),1);assert.deepEqual(queued,['one','two']);
});

test('failed offscreen creation can be retried and newer progress beats stored state',async()=>{
  const {c,status}=background({phase:'complete',updatedAt:100});let attempts=0;
  c.chrome.offscreen.createDocument=async()=>{if(++attempts===1)throw Error('Temporary failure');};
  await assert.rejects(c.ensureOffscreenDocument(),/Temporary failure/);
  await c.ensureOffscreenDocument();assert.equal(attempts,2);
  await c.setState({phase:'rendering',completed:2,updatedAt:300});
  assert.equal((await status()).state.phase,'rendering');
});
test('popup preparation error survives idle polls until the next attempt',async()=>{
  let click,poll,fail=true;
  const e={download:{addEventListener(t,f){click=f;}},progress:{},status:{},details:{}};
  load('popup.js',{console:{error(){}},document:{getElementById:id=>e[id]},window:{addEventListener(){}},
    setInterval(f){poll=f;return 1;},clearInterval(){},chrome:{
      runtime:{async sendMessage(){return {ok:true,state:{phase:'idle',running:false,message:'Idle'}};}},
      tabs:{async query(){if(!fail)throw Error('New attempt');return [{id:1,url:'https://www.scribd.com/document/1/fixture'}];},async sendMessage(){return {ok:false,error:'403 token failure'};}},
      webNavigation:{async getAllFrames(){return [{frameId:0,url:'https://www.scribd.com/document/1/fixture'}];}}
    }});
  await Promise.resolve();await click();await poll();assert.equal(e.status.textContent,'403 token failure');
  fail=false;await click();assert.equal(e.status.textContent,'New attempt');
});
test('canceled and rejected PDF saves revoke their blob URLs immediately',async()=>{
  for(const reject of [false,true]) {
    const revoked=[],timers=[];
    const c=load('builder.js',{Blob,TextEncoder,Uint8Array,Map,Set,
      URL:{createObjectURL(){return 'blob:fixture';},revokeObjectURL(url){revoked.push(url);}},document:{getElementById(){return null;}},
      chrome:{runtime:{onMessage:{addListener(){}},async sendMessage(m){if(m.type==='save-pdf'){if(reject)throw Error('Port closed');return {ok:false,error:'Canceled'};}return {ok:true};}}},
      setTimeout(f){timers.push(f);return 1;},clearTimeout(){}});
    c.buildPage=async()=>({width:10,height:10,bytes:new Uint8Array([1]),texts:[]});
    await assert.rejects(c.runJob({pages:[{pageNum:1}],concurrency:1,title:'fixture',fontStylesheets:[]}),/Canceled|Port closed/);
    assert.deepEqual(revoked,['blob:fixture']);assert.equal(timers.length,0);
  }
});

test('successful downloads retain their blob until delayed cleanup even if final progress reporting fails',async()=>{
  for(const failFinalReport of [false,true]) {
    const revoked=[],timers=[];
    const c=load('builder.js',{Blob,TextEncoder,Uint8Array,Map,Set,
      URL:{createObjectURL(){return 'blob:fixture';},revokeObjectURL(url){revoked.push(url);}},document:{getElementById(){return null;}},
      chrome:{runtime:{onMessage:{addListener(){}},async sendMessage(m){
        if(m.type==='progress-update'&&m.update.phase==='complete'&&failFinalReport)throw Error('Progress port closed');
        return {ok:true};
      }}},setTimeout(callback,delay){timers.push({callback,delay});return 1;},clearTimeout(){}});
    c.buildPage=async()=>({width:10,height:10,bytes:new Uint8Array([1]),texts:[]});
    const job=c.runJob({pages:[{pageNum:1}],concurrency:1,title:'fixture',fontStylesheets:[]});
    if(failFinalReport)await assert.rejects(job,/Progress port closed/);else await job;
    assert.equal(revoked.length,0);assert.equal(timers.length,1);assert.equal(timers[0].delay,120000);
    timers[0].callback();assert.deepEqual(revoked,['blob:fixture']);
  }
});
