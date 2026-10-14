// Opt-in exact reproduction with Scribd's real font CSS, kept outside Git.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const css=process.argv[2]||'tmp/regression-492478137/font.css';
const c={Uint8Array,DataView,TextEncoder,atob,Map,Set,chrome:{runtime:{onMessage:{addListener(){}}}}};
vm.createContext(c);
for(const file of ['glyph-fingerprints.js','font-outline-decoder.js','builder.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),c);
const fonts=c.documentFontCmaps(fs.readFileSync(css,'utf8')),decoder=c.inferFontTextDecoder(fonts);
assert.equal(decoder?.method,'outline-signatures');
for(const [encoded,plain,family] of [
  ['YDCHDC ŃĉK\\HC','TKANKA ŁĄCZNA','ff2'],
  ['Ydchd` Ņākzha wŅcŔk`wa','Tkanki łączne właściwe','ff0'],
  ['wŅûdhc e`cŅdbwa','włókna białkowe','ff0'],
  ['•','•','ff1'],['-','-','ff0']
]) {
  const result=c.decodeFontText(encoded,family,decoder);assert.equal(result.selectable,true);assert.equal(result.copyText,plain);
}
for(const font of fonts.filter(f=>f.family!=='ff1')) {
  const mapping=decoder.mappings.get(font.family);
  for(const {code} of c.readSfntCmap(font.bytes,32,0x27af))assert.ok(mapping.has(code),`Unresolved text character U+${code.toString(16)}`);
}
console.log('PASS: original shuffled fonts decode Polish headings/body/diacritics; all text-font characters resolved');
