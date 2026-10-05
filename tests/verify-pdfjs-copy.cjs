// Opt-in check with any installed CommonJS PDF.js build, including 3.x.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const [pdfFile='tmp/font-regression/full-export.pdf',modulePath='tmp/pdf-viewer-v3/node_modules/pdfjs-dist/build/pdf.js']=process.argv.slice(2);
const {getDocument}=require(path.resolve(modulePath));
async function main(){
  const pdf=await getDocument({data:new Uint8Array(fs.readFileSync(pdfFile))}).promise;
  const texts=[];
  for(let i=1;i<=pdf.numPages;i++) {
    const content=await(await pdf.getPage(i)).getTextContent();
    texts.push(content.items.map(item=>item.str+(item.hasEOL?'\n':'')).join(''));
  }
  assert.equal(pdf.numPages,22);
  assert.ok(texts[1].includes('Prepared by'),`Viewer inserts spaces: ${JSON.stringify(texts[1])}`);
  assert.ok(texts[1].includes('Hamid ali Dana'));
  assert.ok(texts[1].includes('From Gilgit Baltistan'));
  assert.ok(texts[0].includes('B+ Trees'));
  assert.ok(texts[2].includes('What is b+ tree'));
  assert.ok(texts[2].includes('A B+ tree is a data structure'));
  for(let i=6;i<13;i++)assert.ok(texts[i].includes('==2,4,7,10,17,21,28'));
  assert.ok(texts[21].includes('Thank you'));
  console.log('PASS: all 22 pages read; headings, author lines, body text and numeric sequences have no spurious letter spaces');
  await pdf.destroy();
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
