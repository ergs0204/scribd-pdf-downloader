const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
function renderer(extra={}) {
  const sandbox={TextEncoder,Uint8Array,DataView,Map,Set,chrome:{runtime:{onMessage:{addListener(){}}}}};
  Object.assign(sandbox,extra);
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../builder.js'),'utf8'),sandbox);
  return sandbox;
}
test('PDF copy layer embeds deterministic metrics instead of substituting Arial', () => {
  const r=renderer();
  const text={text:'C+ [rnns',copyText:'B+ Trees',x:20,y:30,width:120,height:24};
  const pdf=r.makePdf([{width:300,height:200,bytes:new Uint8Array([1]),texts:[text]}]);
  const source=new TextDecoder('latin1').decode(pdf);
  assert.match(source,/\/FontDescriptor \d+ 0 R/);
  assert.match(source,/\/FontFile2 \d+ 0 R/);
  assert.doesNotMatch(source,/\/BaseFont \/Arial/);
});
test('source Range measurement preserves proportional widths and UTF-16 offsets', () => {
  const offsets=[];
  let start,end;
  const range={setStart(node,at){start=at;},setEnd(node,at){end=at;},detach(){},getBoundingClientRect(){
    offsets.push([start,end]);return {left:100+start*2,top:50,width:(end-start)*3,height:12};
  }};
  const r=renderer({document:{createRange(){return range;}}});
  const boxes=r.measureCharacterBoxes({nodeValue:'W😀i'},{left:100,top:40});
  assert.deepEqual(offsets,[[0,1],[1,3],[3,4]]);
  assert.deepEqual(JSON.parse(JSON.stringify(boxes)),[
    {x:0,y:10,width:3,height:12},{x:2,y:10,width:6,height:12},{x:6,y:10,width:3,height:12}
  ]);
});
test('selection uses exact per-character source rectangles without scale clamps', () => {
  const r=renderer();
  const text={text:'Wi',copyText:'Wi',x:20,y:30,width:24,height:12,
    characterBoxes:[{x:20,y:30,width:20,height:12},{x:40,y:30,width:4,height:12}]};
  const page={width:300,height:200,texts:[text]};
  const content=r.makePageContent(page,r.makeTextCodec([page]),0.75);
  assert.match(content,/\/Ftxt0 9 Tf/);
  assert.match(content,/1 0 0 1 15 118\.5 Tm/);
  assert.match(content,/1 0 0 1 30 118\.5 Tm\n<0002> Tj/);
  assert.equal((content.match(/ Tf/g)||[]).length,1);
  const codec=r.makeTextCodec([page]);
  assert.deepEqual(Array.from(codec.glyphWidths),[6827,1365]);
  assert.doesNotMatch(content,/ Tz/);
});
test('the same Unicode character can have different font advances without changing em scale',()=>{
  const r=renderer();
  const text={text:'ee',x:0,y:0,width:16,height:12,
    characterBoxes:[{x:0,y:0,width:6,height:12},{x:6,y:0,width:10,height:12}]};
  const page={width:200,height:100,texts:[text]},codec=r.makeTextCodec([page]);
  assert.equal(codec.entries.length,2);
  assert.equal(codec.entries[0].character,'e');
  assert.equal(codec.entries[1].character,'e');
  assert.notEqual(codec.entries[0].advance,codec.entries[1].advance);
  assert.match(r.makePageContent(page,codec,.75),/1 0 0 1 4\.5 66 Tm\n<0002> Tj/);
});
test('incompatible source metrics use separate reusable faces, not one Unicode width',()=>{
  const r=renderer();
  const fragments=[
    {text:'e',x:0,y:0,width:6,height:12},
    {text:'e',x:10,y:0,width:10,height:12},
    {text:'e',x:30,y:0,width:6,height:12}
  ];
  const codec=r.makeTextCodec([{texts:fragments}]);
  assert.equal(codec.fonts.length,2);
  assert.equal(codec.fontFor(fragments[0]),codec.fontFor(fragments[2]));
  assert.notEqual(codec.fontFor(fragments[0]),codec.fontFor(fragments[1]));
});
test('collapsed source spaces cannot give the copy font a near-zero space advance',()=>{
  const r=renderer();
  const fragment={text:'A ',x:0,y:0,width:6,height:12,
    characterBoxes:[{x:0,y:0,width:6,height:12},{x:6,y:0,width:0,height:12}]};
  const codec=r.makeTextCodec([{texts:[fragment]}]);
  assert.equal(codec.entries.find(entry=>entry.character===' ').advance,1024);
});
