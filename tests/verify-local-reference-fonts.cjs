// Opt-in geometry/copy smoke test against locally available fonts. This is not
// proof of Scribd layout/shaping support. No font files or fixtures are bundled.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),folder=path.join(root,'tmp/reference-smoke');
const samples=[['segoeui.ttf','Привет'],['segoeui.ttf','שלום'],['segoeui.ttf','مرحبا'],
  ['Nirmala.ttc','नमस्ते'],['LeelawUI.ttf','ภาษาไทย'],['msjh.ttc','中文'],
  ['msgothic.ttc','かなカナ'],['malgun.ttf','한국어'],['mingliub.ttc','𠀀']];
const prepare=spawnSync('python',['-c',[
  'import sys,json;from pathlib import Path;from fontTools.ttLib import TTFont;from fontTools import subset',
  'samples=json.loads(sys.argv[1]);source=Path(sys.argv[2]);target=Path(sys.argv[3]);target.mkdir(parents=True,exist_ok=True)',
  'for i,(name,text) in enumerate(samples):',
  ' p=source/name',
  ' if not p.exists():continue',
  ' f=TTFont(p,fontNumber=0);s=subset.Subsetter();s.populate(unicodes=list(range(0x30,0x70))+list(map(ord,text)));s.subset(f);f.save(target/(str(i)+".ttf"));f.close()'
].join('\n'),JSON.stringify(samples),process.argv[2]||'C:/Windows/Fonts',folder],{encoding:'utf8'});
if(prepare.status!==0)throw Error(prepare.stderr||'Could not prepare local font fixtures');
const c={Uint8Array,DataView,TextEncoder,atob,Map,Set,chrome:{runtime:{onMessage:{addListener(){}}}}};
vm.createContext(c);
for(const file of ['glyph-fingerprints.js','font-outline-decoder.js','builder.js'])vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),c);
const fonts=samples.flatMap((_,i)=>fs.existsSync(path.join(folder,`${i}.ttf`))?[{family:`ff${i}`,bytes:new Uint8Array(fs.readFileSync(path.join(folder,`${i}.ttf`)))}]:[]);
const decoder=c.inferFontTextDecoder(fonts);
assert.ok(decoder,'Local fonts must establish a decoder');
for(const font of fonts){
  const sample=samples[Number(font.family.slice(2))],result=c.decodeFontText(sample[1],font.family,decoder);
  assert.equal(result.selectable,true,`Unresolved local sample: ${sample[1]}`);
  assert.equal(result.copyText,sample[1]);
}
assert.ok(fonts.length,'No sample fonts available');
console.log(`PASS: ${fonts.length} local-font Unicode samples copy correctly (including available non-Latin and supplementary-plane samples)`);
