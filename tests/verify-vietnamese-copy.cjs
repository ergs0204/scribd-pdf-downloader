// Opt-in check of a locally exported public preview; no source data is bundled.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {getDocument}=require(process.argv[3]||path.resolve(__dirname,'../tmp/pdf-viewer-v3/node_modules/pdfjs-dist/build/pdf.js'));
async function main(){
  const input=process.argv[2]||path.resolve(__dirname,'../tmp/regression-718119075/full-export.pdf');
  const pdf=await getDocument({data:new Uint8Array(fs.readFileSync(input))}).promise;
  try{
    assert.equal(pdf.numPages,67);
    const texts=[];
    for(let page=1;page<=pdf.numPages;page++){
      const content=await(await pdf.getPage(page)).getTextContent();
      const text=content.items.map(item=>item.str+(item.hasEOL?'\n':'')).join('').replace(/\s+/gu,' ').normalize('NFC');
      assert.ok(text.trim().length>20,`Page ${page} has no usable selectable text`);
      texts.push(text);
    }
    for(const phrase of ['Biên Soạn: Nguyễn','TÓM TẮT','tính toán CẤU KIỆN CHỊU UỐN','Tải trọng','nội lực tiêu chuẩn','phần tác dụng dài hạn']){
      assert.ok(texts[0].includes(phrase),`Missing first-page Vietnamese phrase: ${phrase}`);
    }
    assert.ok(texts[66].includes('Nén lệch tâm lớn'),'Late font subsets lost Vietnamese text on page 67');
    console.log('PASS: PDF.js copies text on all 67 pages, including Vietnamese accents and late font subsets');
  }finally{await pdf.destroy();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
