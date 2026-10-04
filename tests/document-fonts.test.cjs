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

test("font-encoded glyph strings are not exposed as incorrect selectable Unicode", () => {
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
