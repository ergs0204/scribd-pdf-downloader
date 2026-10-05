// Re-run the real PDF writer against already measured source geometry and
// unchanged JPEG streams, without another network request. Inputs stay ignored.
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const [input='tmp/font-regression/aligned-normal.pdf',geometry='tmp/font-regression/selection-geometry.json',output='tmp/font-regression/full-export.pdf']=process.argv.slice(2);
const bytes=fs.readFileSync(input),source=bytes.toString('latin1');
const images=[];
const pattern=/<< \/Type \/XObject \/Subtype \/Image [^\r\n]* \/Length (\d+) >>\r?\nstream\r?\n/g;
for(const match of source.matchAll(pattern)) {
  const start=match.index+match[0].length,length=Number(match[1]);
  if(start+length>bytes.length)throw Error('Truncated JPEG stream');
  images.push(new Uint8Array(bytes.subarray(start,start+length)));
}
const pages=JSON.parse(fs.readFileSync(geometry,'utf8'));
if(pages.length!==images.length)throw Error('Geometry/page-image count mismatch');
pages.forEach((page,index)=>page.bytes=images[index]);
const sandbox={TextEncoder,Uint8Array,DataView,Map,Set,chrome:{runtime:{onMessage:{addListener(){}}}}};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname,'../builder.js'),'utf8'),sandbox);
fs.writeFileSync(output,sandbox.makePdf(pages));
console.log(`Rebuilt ${pages.length} pages using the actual PDF writer and unchanged images`);
