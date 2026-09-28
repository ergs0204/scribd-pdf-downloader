const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("official pages use the embed preview source and reuse all rendered page nodes", async () => {
  let requestedUrl;
  const previewSource = Array.from({ length: 13 }, (_, index) =>
    `docManager.addPage({pageNum:${index + 1},origWidth:902,origHeight:1375,contentUrl:"https://html.scribdassets.com/pages/${index + 1}.jsonp"});`
  ).join("\n");
  const sandbox = {
    URL,
    chrome: { runtime: { onMessage: { addListener() {} } } },
    console,
    document: {},
    DOMParser: class {
      parseFromString() { return { getElementById() { return null; }, querySelectorAll() { return []; } }; }
    },
    fetch: async url => {
      requestedUrl = new URL(url);
      return { ok: true, text: async () => previewSource };
    },
    location: {
      href: "https://www.scribd.com/document/677399104/9780190124113",
      origin: "https://www.scribd.com",
      pathname: "/document/677399104/9780190124113"
    },
    setTimeout
  };

  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  vm.runInContext(source, sandbox, { filename: "content.js" });
  const getPreviewSource = vm.runInContext("getPreviewSource", sandbox);
  const parsePages = vm.runInContext("parsePages", sandbox);
  const attachRenderedPageHtml = vm.runInContext("attachRenderedPageHtml", sandbox);

  const selectedSource = await getPreviewSource("677399104", "fallback");
  assert.equal(parsePages(selectedSource).length, 13);
  assert.equal(requestedUrl.pathname, "/embeds/677399104/content");
  assert.equal(requestedUrl.searchParams.get("start_page"), "1");
  assert.equal(requestedUrl.searchParams.get("view_mode"), "scroll");
  assert.equal(requestedUrl.searchParams.get("show_recommendations"), "false");

  const root = {
    getElementById(id) {
      return { outerHTML: `<div class="newpage" id="${id}"></div>` };
    }
  };
  const pages = attachRenderedPageHtml(parsePages(selectedSource), root);
  assert.equal(pages.filter(page => page.inlineHtml).length, 13);
});
