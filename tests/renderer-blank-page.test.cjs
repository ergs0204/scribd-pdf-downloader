const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),test=require('node:test');

function renderer(computedStyle = {}) {
  const updates=[],saved=[],painted=[];
  const canvas={getContext(){return {fillRect(...args){painted.push(args);},drawImage(){}};},
    toBlob(callback){callback(new Blob([new Uint8Array([255,216,255,217])],{type:'image/jpeg'}));}};
  const pageElement={textContent:'',querySelector(){return null;},querySelectorAll(){return [];},getAttribute(){return null;}};
  const emptyShadow={append(){},querySelector(selector){return selector==='.newpage'?pageElement:null;},querySelectorAll(){return [];}};
  const sandbox={AbortController,Blob,DOMException,TextEncoder,Uint8Array,URL,Map,Set,
    __SPDF_RETRY_BASE_MS:1,
    chrome:{runtime:{onMessage:{addListener(){}},async sendMessage(message){
      if(message.type==='progress-update')updates.push(message.update);
      if(message.type==='save-pdf'){saved.push({filename:message.filename,pdf:await(await fetch(message.url)).text()});}
      return {ok:true};
    }}},
    document:{body:{appendChild(){}},fonts:{ready:Promise.resolve()},
      createElement(tag){return tag==='canvas'?canvas:{style:{},attachShadow(){return emptyShadow;},remove(){}};}
    },
    DOMParser:class {parseFromString(html){return {
      querySelector(selector){return selector==='.newpage'&&html.includes('class="newpage"')?pageElement:null;},
      querySelectorAll(selector){return selector.startsWith('img')&&html.includes('<img')?[{getAttribute(){return 'https://html.scribdassets.com/fixture.jpg';},style:{}}]:[];}
    };}},
    fetch:async url=>({ok:true,url:String(url),text:async()=>JSON.stringify('unused'),blob:async()=>new Blob(['fixture'])}),
    createImageBitmap:async()=>({width:1,height:1,close(){}}),requestAnimationFrame:callback=>callback(),
    getComputedStyle(){return {backgroundImage:'none',content:'none',...computedStyle};},
    setTimeout(callback,delay,...args){return delay>100000?0:setTimeout(callback,delay,...args);},clearTimeout
  };
  vm.createContext(sandbox);vm.runInContext(fs.readFileSync(path.join(__dirname,'../builder.js'),'utf8'),sandbox);
  return {sandbox,updates,saved,painted};
}

test('a real empty page is retained in order and does not prevent saving the other pages',async()=>{
  const {sandbox,updates,saved,painted}=renderer();
  const pages=[
    {pageNum:1,width:800,height:1000,inlineHtml:'<div class="newpage"><img orig="https://html.scribdassets.com/fixture.jpg"></div>'},
    {pageNum:2,width:600,height:900,inlineHtml:'<div class="newpage"><div class="image_layer"></div><div class="text_layer"></div></div>'},
    {pageNum:3,width:1000,height:800,inlineHtml:'<div class="newpage"><img orig="https://html.scribdassets.com/fixture.jpg"></div>'}
  ];
  await sandbox.runJob({documentId:'test',pages,concurrency:3,token:'test',jpegQuality:.92,title:'blank-page-regression'});
  assert.equal(saved.length,1,'A blank page must not discard the full PDF');
  assert.match(saved[0].pdf,/\/Count 3\b/);
  const sizes=[...saved[0].pdf.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map(m=>[Number(m[1]),Number(m[2])]);
  assert.deepEqual(sizes,[[600,750],[450,675],[750,600]]);
  assert.ok(painted.some(args=>args[2]===600&&args[3]===900),'Blank page was not painted white');
  assert.equal(updates.at(-1).phase,'complete');
  assert.equal(updates.at(-1).failures.length,0);
});

test('a textless server error is not silently converted into a blank page',async()=>{
  const {sandbox}=renderer();
  await assert.rejects(sandbox.buildPage({width:800,height:1000,inlineHtml:'<html><body>Access denied</body></html>'},'test',.92,'',null),/No image|blank page|page container/);
});

test('unsupported media, visible error text, or CSS images are not accepted as blank',()=>{
  const {sandbox}=renderer();
  const base={textContent:' \n\u00a0',querySelector(){return null;},querySelectorAll(){return [];},getAttribute(){return null;}};
  const check=page=>sandbox.isBlankPreviewPage({querySelector(){return page;}});
  assert.equal(check(base),true);
  assert.equal(check(null),false);
  assert.equal(check({...base,textContent:'Access denied'}),false);
  assert.equal(check({...base,querySelector(){return {};}}),false);
  assert.equal(check({...base,getAttribute(){return 'background-image:url(page.png)';}}),false);
  assert.equal(check({...base,querySelectorAll(){return [{getAttribute(){return 'background:linear-gradient(red,blue)';}}];}}),false);
});

test('class-based CSS images and generated pseudo-text fail visibly instead of saving blank',async()=>{
  for(const style of [{backgroundImage:'url(page.png)'},{content:'"Missing page"'}]) {
    const {sandbox,saved}=renderer(style);
    await assert.rejects(sandbox.buildPage({width:800,height:1000,inlineHtml:'<div class="newpage"><div class="image_layer"></div></div>'},'test',.92,'.image_layer{background-image:url(page.png)}',null),/No image/);
    assert.equal(saved.length,0);
  }
});
