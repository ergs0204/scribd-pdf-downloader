const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("suspended animation frames cannot leave the offscreen renderer at 0 / 13", async () => {
  const updates = [];
  const image = {
    getAttribute(name) {
      return name === "orig" ? "https://html.scribdassets.com/page.png" : null;
    },
    style: {}
  };
  const parsedDocument = { querySelectorAll() { return [image]; } };
  const shadow = { append() {}, querySelector() { return null; } };
  const context = {
    fillRect() {},
    drawImage() {},
    save() {},
    restore() {},
    fillText() {},
    translate() {},
    rotate() {}
  };
  const sandbox = {
    AbortController,
    Blob,
    DOMException,
    DOMParser: class { parseFromString() { return parsedDocument; } },
    Map,
    OffscreenCanvas: class {
      getContext() { return context; }
      async convertToBlob() { return new Blob([new Uint8Array([255, 216, 255, 217])], { type: "image/jpeg" }); }
    },
    Promise,
    TextEncoder,
    Uint8Array,
    URL,
    __SPDF_LAYOUT_TIMEOUT_MS: 10,
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        async sendMessage(message) {
          if (message.type === "progress-update") updates.push(message.update);
          if (message.type === "save-pdf") return { ok: true };
          return { ok: true };
        }
      }
    },
    console,
    createImageBitmap: async () => ({ width: 1, height: 1, close() {} }),
    document: {
      body: { appendChild() {} },
      createElement() {
        return {
          style: {},
          attachShadow() { return shadow; },
          remove() {},
          set innerHTML(_) {}
        };
      },
      fonts: { ready: Promise.resolve() }
    },
    fetch: async url => ({
      ok: true,
      status: 200,
      statusText: "OK",
      url: String(url),
      blob: async () => new Blob([new Uint8Array([255, 216, 255, 217])], { type: "image/jpeg" })
    }),
    requestAnimationFrame() {},
    setTimeout(callback, delay, ...args) {
      if (delay >= 100000) return 0;
      return setTimeout(callback, delay, ...args);
    },
    clearTimeout
  };

  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(__dirname, "..", "builder.js"), "utf8");
  vm.runInContext(source, sandbox, { filename: "builder.js" });
  const runJob = vm.runInContext("runJob", sandbox);
  const pages = Array.from({ length: 13 }, (_, index) => ({
    pageNum: index + 1,
    width: 902,
    height: 1375,
    inlineHtml: `<div class="newpage" id="page${index + 1}"><img orig="https://html.scribdassets.com/page.png"></div>`
  }));

  const result = await Promise.race([
    runJob({ pages, concurrency: 6, token: "redacted", jpegQuality: 0.92, styleText: "", title: "fixture" })
      .then(() => "completed", () => "failed"),
    new Promise(resolve => setTimeout(() => resolve("stuck"), 500))
  ]);

  assert.notEqual(result, "stuck", "offscreen layout remained stuck at Rendering 0 / 13 pages");
  assert.ok(updates.some(update => update.completed === 13), "renderer did not finish all 13 pages");
});
