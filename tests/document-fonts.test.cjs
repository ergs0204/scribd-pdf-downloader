const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadScript(name, extra = {}) {
  const sandbox = {
    AbortController,
    Blob,
    DOMException,
    Map,
    Promise,
    TextEncoder,
    Uint8Array,
    atob,
    URL,
    chrome: { runtime: { onMessage: { addListener() {} } } },
    console,
    document: {},
    location: new URL("https://www.scribd.com/document/507619928/B-tree-dbms"),
    setTimeout,
    clearTimeout,
    ...extra
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", name), "utf8"), sandbox, { filename: name });
  return sandbox;
}

test("official previews retain Scribd's document-specific font stylesheet", () => {
  const links = [
    { href: "https://html.scribdassets.com/doc/hash/12/ttfs.css", getAttribute() { return this.href; } },
    { href: "https://example.com/site.css", getAttribute() { return this.href; } }
  ];
  const parsedLinks = [
    { href: "", getAttribute() { return "/doc/hash/12/ttfs.css"; } }
  ];
  const DOMParser = class {
    parseFromString() { return { querySelectorAll() { return parsedLinks; } }; }
  };
  const sandbox = loadScript("content.js", { DOMParser });
  const collect = vm.runInContext("collectFontStylesheetUrls", sandbox);
  const root = { querySelectorAll() { return links; } };

  const result = collect(["<link rel=stylesheet href='/doc/hash/12/ttfs.css'>"], root);

  assert.deepEqual(JSON.parse(JSON.stringify(result)), [
    "https://html.scribdassets.com/doc/hash/12/ttfs.css",
    "https://www.scribd.com/doc/hash/12/ttfs.css"
  ]);
});

test("real preparation carries dynamically declared font families without a live font link", async () => {
  const preview = `docManager.assetPrefix = "example-prefix";
    docManager.fontAggregatorHosts = ["https://html.scribdassets.com"];
    docManager.addFont(6, "", "ff6", "Georgia1, Georgia, serif", "normal", "normal");
    docManager.addFont(4, "b", "ff4", "Trebuchet MS1, Helvetica, sans-serif", "bold", "normal");
    docManager.addPage({pageNum:1,origWidth:902,origHeight:507,innerPageElem:document.getElementById("page1")});`;
  const page = {outerHTML:'<div id="page1" class="newpage"><div class="text_layer"><div class="ff6"><span>Kete</span></div></div></div>'};
  const sandbox = loadScript("content.js", {
    DOMParser: class { parseFromString() { return {getElementById(){return page;},querySelectorAll(){return [];}}; } },
    document: {getElementById(){return page;},querySelectorAll(){return [];}},
    fetch: async url => ({ok:true,text:async()=>preview,json:async()=>String(url).includes('csrf_token')?{csrf_token:'test'}:{token:'test'}})
  });
  const job = await sandbox.prepareJob();
  assert.match(job.styleText, /div\.ff6 span\{font-family:ff6,Georgia1, Georgia, serif/);
  assert.match(job.styleText, /div\.ff4 span\{.*font-weight:bold/);
  assert.deepEqual(Array.from(job.fontStylesheets), ['https://html.scribdassets.com/example-prefix/6,b4/12/ttfs.css']);
});

test("offscreen renderer loads font CSS and resolves its relative font URLs", async () => {
  const requested = [];
  const sandbox = loadScript("builder.js", {
    fetch: async url => {
      requested.push(String(url));
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        url: String(url),
        text: async () => "@font-face{font-family:ff6;src:url(font6.ttf)}"
      };
    }
  });
  const load = vm.runInContext("loadDocumentFontStyles", sandbox);

  const css = await load(["https://html.scribdassets.com/doc/hash/12/ttfs.css"]);

  assert.deepEqual(requested, ["https://html.scribdassets.com/doc/hash/12/ttfs.css"]);
  assert.match(css, /font-family:ff6/);
  assert.match(css, /url\("https:\/\/html\.scribdassets\.com\/doc\/hash\/12\/font6\.ttf"\)/);
});

test("offscreen renderer explicitly loads Scribd fonts before canvas drawing", async () => {
  const loaded = [];
  const textNode = { nodeValue: "Kete rnf`rks" };
  const parentElement = {};
  textNode.parentElement = parentElement;
  const sandbox = loadScript("builder.js", {
    NodeFilter: { SHOW_TEXT: 4 },
    document: {
      fonts: {
        async load(font, text) {
          loaded.push({ font, text });
          return [{}];
        }
      },
      createTreeWalker() {
        let done = false;
        return {
          currentNode: null,
          nextNode() {
            if (done) return false;
            done = true;
            this.currentNode = textNode;
            return true;
          }
        };
      }
    },
    getComputedStyle(element) {
      assert.equal(element, parentElement);
      return { fontFamily: "ff6, Georgia, serif", fontSize: "52px", fontStyle: "normal", fontWeight: "400" };
    }
  });
  const loadFonts = vm.runInContext("loadTextLayerFonts", sandbox);

  await loadFonts({});

  assert.deepEqual(loaded, [{ font: "normal 400 52px ff6", text: "Kete rnf`rks" }]);
});

test("document font faces are registered outside the renderer shadow root", () => {
  const appended = [];
  const sandbox = loadScript("builder.js", {
    document: {
      createElement(tag) { return { tag, dataset: {}, textContent: "", remove() {} }; },
      head: { appendChild(element) { appended.push(element); } },
      getElementById() { return null; }
    }
  });
  const install = vm.runInContext("installDocumentFontStyles", sandbox);

  const style = install("@font-face{font-family:ff6;src:url(data:font/opentype;base64,AAE=)}");

  assert.equal(appended.length, 1);
  assert.equal(appended[0], style);
  assert.equal(style.id, "scribd-document-fonts");
  assert.match(style.textContent, /font-family:ff6/);
});

test("font-bearing pages prefer a DOM canvas that shares document fonts", () => {
  const domCanvas = { width: 0, height: 0, getContext() { return {}; } };
  const sandbox = loadScript("builder.js", {
    document: { createElement(tag) { assert.equal(tag, "canvas"); return domCanvas; } },
    OffscreenCanvas: class { constructor() { throw new Error("OffscreenCanvas must not be selected"); } }
  });
  const createCanvas = vm.runInContext("createRenderCanvas", sandbox);

  const canvas = createCanvas(902, 507);

  assert.equal(canvas, domCanvas);
  assert.equal(canvas.width, 902);
  assert.equal(canvas.height, 507);
});

test("custom-font text keeps encoded visual glyphs but copies decoded Unicode", async () => {
  const page = {getBoundingClientRect(){return {left:0,top:0};}};
  const layer = {parentElement:page};
  const span = {parentElement:layer};
  const node = {nodeValue:'C+ [rnns',parentElement:span};
  const sandbox = loadScript("builder.js", {
    NodeFilter:{SHOW_TEXT:4},
    requestAnimationFrame:callback=>callback(),
    getComputedStyle:el=>el===span ? {fontFamily:'ff0, Comic Sans MS, cursive',fontSize:'100px',transform:'none',writingMode:'horizontal-tb'} : {transform:'matrix(0.2, 0, 0, 0.2, 0, 0)'},
    document:{
      body:{appendChild(){}},fonts:{ready:Promise.resolve(),load:async()=>[{}]},
      createElement(){return {style:{},remove(){},attachShadow(){return {append(){},querySelector:selector=>selector==='.newpage'?page:layer};}};},
      createTreeWalker(){let done=false;return {currentNode:node,nextNode(){if(done)return false;done=true;return true;}};},
      createRange(){return {selectNodeContents(){},detach(){},getBoundingClientRect(){return {left:10,top:20,width:160,height:25};}};}
    }
  });
  const decoder = {inverse:[15,0,11,2,6,1,3,14,13,12,8,4,9,10,5,7],families:new Set(['ff0'])};
  const fragments = await sandbox.extractTextFragments('<div>fixture</div>','',{width:902,height:507},decoder);
  assert.equal(fragments[0].text,'C+ [rnns');
  assert.equal(fragments[0].copyText,'B+ Trees');
  assert.equal(fragments[0].selectable,true);
  assert.equal(fragments[0].decoded,true);
  const codec = sandbox.makeTextCodec([{texts:fragments}]);
  assert.ok(codec.characters.has('B'));
  assert.equal(codec.characters.has('['),false);
  assert.match(sandbox.makePageContent({width:902,height:507,texts:fragments},codec,0.75),/Tj/);
});

test("font decoder recovers a unique permutation from subset glyph ordering, not a fixed key", () => {
  const sandbox = loadScript('builder.js');
  for(const key of [[1,5,3,6,11,14,4,15,10,12,13,2,9,8,7,0],[15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0]]) {
    const cmap=key.map((n,index)=>({code:0x60+n,glyph:index+1}));
    const decoder=sandbox.inferFontTextDecoder([{family:'ff6',cmap}]);
    assert.ok(decoder);
    const encoded=[..."Data records 0123456789"].map(c=>{const cp=c.codePointAt(0);return cp>=0x30&&cp<0x70?String.fromCharCode((cp&~15)|key[cp&15]):c;}).join('');
    assert.equal(sandbox.decodeFontText(encoded,'ff6',decoder).copyText,'Data records 0123456789');
  }
});

test('decoder combines partial subset ordering across fonts for 100 distinct keys', () => {
  const sandbox=loadScript('builder.js');
  let seed=519;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  for(let run=0;run<100;run++) {
    const key=Array.from({length:16},(_,i)=>i);
    for(let i=15;i>0;i--){const j=random()%(i+1);[key[i],key[j]]=[key[j],key[i]];}
    const fonts=Array.from({length:15},(_,i)=>({family:`ff${i}`,cmap:[{code:0x60+key[i],glyph:1},{code:0x60+key[i+1],glyph:2}]}));
    const decoder=sandbox.inferFontTextDecoder(fonts);
    assert.ok(decoder);
    assert.deepEqual(Array.from(decoder.inverse),Array.from({length:16},(_,i)=>key.indexOf(i)));
  }
});

test("ambiguous and conflicting font mappings cannot silently copy guessed strings", () => {
  const sandbox=loadScript('builder.js');
  assert.equal(sandbox.inferFontTextDecoder([{family:'ff6',cmap:[{code:97,glyph:1},{code:98,glyph:2}]}]),null);
  const first=Array.from({length:16},(_,i)=>({code:96+i,glyph:i+1}));
  assert.equal(sandbox.inferFontTextDecoder([{family:'ff0',cmap:first},{family:'ff6',cmap:first.map(x=>({...x,glyph:17-x.glyph}))}]),null);
  const result=sandbox.decodeFontText('C+ [rnns','ff0',null);
  assert.equal(result.selectable,false);
  assert.equal(sandbox.decodeFontText('Normal 中文','Arial',null).copyText,'Normal 中文');
  const decoder=sandbox.inferFontTextDecoder([{family:'ff0',cmap:first}]);
  assert.equal(sandbox.decodeFontText('Normal 中文 😀','ff0',decoder).copyText,'Normal 中文 😀');
  assert.equal(sandbox.decodeFontText('\uF0B7','ff0',decoder).selectable,false);
});

function sfntFixture(format, rangeOffset = false) {
  const bytes = Buffer.alloc(160);
  bytes.writeUInt32BE(0x10000, 0); bytes.writeUInt16BE(1, 4);
  bytes.write('cmap', 12); bytes.writeUInt32BE(28, 20); bytes.writeUInt32BE(132, 24);
  bytes.writeUInt16BE(1, 30); bytes.writeUInt16BE(3, 32);
  bytes.writeUInt16BE(format === 12 ? 10 : 1, 34); bytes.writeUInt32BE(12, 36);
  bytes.writeUInt16BE(format, 40);
  if (format === 4) {
    bytes.writeUInt16BE(rangeOffset ? 40 : 32, 42); bytes.writeUInt16BE(4, 46);
    bytes.writeUInt16BE(0x31, 54); bytes.writeUInt16BE(0xffff, 56);
    bytes.writeUInt16BE(0x30, 60); bytes.writeUInt16BE(0xffff, 62);
    bytes.writeUInt16BE(rangeOffset ? 2 : 0xffd1, 64); bytes.writeUInt16BE(1, 66);
    if (rangeOffset) {
      bytes.writeUInt16BE(4, 68); bytes.writeUInt16BE(5, 72); bytes.writeUInt16BE(0, 74);
    }
  } else {
    bytes.writeUInt32BE(28, 44); bytes.writeUInt32BE(1, 52);
    bytes.writeUInt32BE(0x30, 56); bytes.writeUInt32BE(0x31, 60); bytes.writeUInt32BE(7, 64);
  }
  return bytes;
}

test('bounded SFNT parser handles cmap 4 delta/range-offset and cmap 12', () => {
  const sandbox=loadScript('builder.js');
  const read=bytes=>JSON.parse(JSON.stringify(sandbox.readSfntCmap(bytes)));
  assert.deepEqual(read(sfntFixture(4)),[{code:48,glyph:1},{code:49,glyph:2}]);
  assert.deepEqual(read(sfntFixture(4,true)),[{code:48,glyph:7}]);
  assert.deepEqual(read(sfntFixture(12)),[{code:48,glyph:7},{code:49,glyph:8}]);
  assert.deepEqual(read(sfntFixture(4).subarray(0,60)),[]);
  const malformed=sfntFixture(4); malformed.writeUInt16BE(0xffff,46);
  assert.deepEqual(read(malformed),[]);
  const badOffset=sfntFixture(4,true); badOffset.writeUInt16BE(0xffff,68);
  assert.deepEqual(read(badOffset),[]);
  assert.deepEqual(read(Buffer.from('not a font')),[]);
});

test('font CSS decodes only supported document data fonts', () => {
  const sandbox=loadScript('builder.js');
  const css=`@font-face{font-family:ff0;src:url("data:font/opentype;base64,${sfntFixture(4).toString('base64')}")}`;
  const fonts=sandbox.documentFontCmaps(css);
  assert.equal(fonts.length,1);
  assert.equal(fonts[0].family,'ff0');
  assert.equal(fonts[0].cmap[0].glyph,1);
  assert.equal(sandbox.documentFontCmaps('@font-face{font-family:ff1;src:url(data:font/ttf;base64,AAAA)}').length,0);
  assert.equal(sandbox.documentFontCmaps('@font-face{font-family:ff1;src:url(https://example.com/font.ttf)}').length,0);
});

test("an explicit excluded fragment is still omitted from the PDF text map", () => {
  const sandbox = loadScript("builder.js");
  const makeCodec = vm.runInContext("makeTextCodec", sandbox);

  const codec = makeCodec([{ texts: [
    { text: "Kete rnf`rks", selectable: false },
    { text: "Normal English", selectable: true }
  ] }]);

  assert.equal(codec.characters.has("K"), false);
  assert.equal(codec.characters.has("N"), true);
});

test("canvas metrics preserve Scribd's 5x text scale and per-span spacing", () => {
  const page = {transform:"matrix(0.75, 0, 0, 0.75, 0, 0)"};
  const layer = {parentElement:page,transform:"matrix(0.2, 0, 0, 0.2, 0, 0)"};
  const span = {parentElement:layer,transform:"none"};
  const sandbox = loadScript("builder.js", {getComputedStyle:el=>el});
  const metrics = sandbox.textCanvasMetrics(span,page,{fontSize:"138px",letterSpacing:"2px",wordSpacing:"-6px"});
  assert.equal(metrics.fontSize,27.6);
  assert.equal(metrics.letterSpacing,0.4);
  assert.ok(Math.abs(metrics.wordSpacing + 1.2)<1e-9);
  const draws=[];
  const ctx={save(){},restore(){},fillText(...args){draws.push({args,font:this.font,letterSpacing:this.letterSpacing,wordSpacing:this.wordSpacing});}};
  sandbox.drawVisibleText(ctx,[{...metrics,text:'encoded',height:32,width:100,x:1,y:2,color:'#000',family:'ff6',style:'normal',weight:'400',writingMode:'horizontal-tb'}]);
  assert.equal(draws[0].font,'normal 400 27.6px ff6');
  assert.equal(draws[0].letterSpacing,'0.4px');
});
