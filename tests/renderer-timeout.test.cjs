const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("a stalled Scribd asset cannot leave progress at 0 / 13 forever", async () => {
  const updates = [];
  const image = {
    getAttribute(name) {
      return name === "orig" ? "https://html.scribdassets.com/stalled-page.jpg" : null;
    },
    style: {}
  };
  const parsedDocument = {
    querySelectorAll() { return [image]; }
  };
  const shadow = {
    append() {},
    querySelector() { return null; }
  };
  const sandbox = {
    AbortController,
    Blob,
    DOMException,
    DOMParser: class { parseFromString() { return parsedDocument; } },
    Map,
    OffscreenCanvas: class {},
    Promise,
    TextEncoder,
    Uint8Array,
    URL,
    __SPDF_FETCH_TIMEOUT_MS: 20,
    __SPDF_RETRY_BASE_MS: 1,
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        async sendMessage(message) {
          if (message.type === "progress-update") updates.push(message.update);
          return { ok: true };
        }
      }
    },
    console,
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
    fetch(_url, options = {}) {
      if (String(_url).includes("stalled-page.jpg")) {
        return new Promise((_, reject) => {
          options.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          }, { once: true });
        });
      }
      return Promise.resolve({
        ok: true,
        text: async () => 'callback(["<img orig=\\"https://html.scribdassets.com/stalled-page.jpg\\">"])'
      });
    },
    requestAnimationFrame(callback) { callback(); },
    setTimeout,
    clearTimeout
  };

  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(__dirname, "..", "builder.js"), "utf8");
  vm.runInContext(source, sandbox, { filename: "builder.js" });
  const runJob = vm.runInContext("runJob", sandbox);
  const pages = Array.from({ length: 13 }, (_, index) => ({
    pageNum: index + 1,
    width: 800,
    height: 1000,
    contentUrl: `https://html.scribdassets.com/page-${index + 1}.js`
  }));

  const result = await Promise.race([
    runJob({ pages, concurrency: 6, token: "redacted", jpegQuality: 0.92, styleText: "", title: "fixture" })
      .then(() => "completed", () => "failed"),
    new Promise(resolve => setTimeout(() => resolve("stuck"), 500))
  ]);

  assert.notEqual(result, "stuck", "renderer remained stuck at Rendering 0 / 13 pages");
  assert.ok(updates.some(update => update.completed > 0), "renderer never advanced page progress");
});
