const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("an idle status poll cannot re-enable Download while preparation is pending", async () => {
  let clickHandler;
  let pollHandler;
  let resolveTabQuery;
  const elements = {
    download: {
      disabled: false,
      textContent: "Download all pages as PDF",
      addEventListener(type, handler) { if (type === "click") clickHandler = handler; }
    },
    progress: { max: 1, value: 0 },
    status: { textContent: "", className: "" },
    details: { textContent: "" }
  };
  const sandbox = {
    chrome: {
      runtime: {
        async sendMessage(message) {
          if (message.type === "get-status") {
            return { ok: true, state: { running: false, phase: "idle", message: "Open a Scribd document or preview…" } };
          }
          return { ok: true };
        }
      },
      tabs: {
        query() { return new Promise(resolve => { resolveTabQuery = resolve; }); }
      },
      webNavigation: { async getAllFrames() { return []; } },
      scripting: { async executeScript() {} }
    },
    console: { error() {} },
    document: { getElementById(id) { return elements[id]; } },
    setInterval(handler) { pollHandler = handler; return 1; },
    clearInterval() {},
    window: { addEventListener() {} }
  };

  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");
  vm.runInContext(source, sandbox, { filename: "popup.js" });
  await Promise.resolve();

  const clickPromise = clickHandler();
  assert.equal(elements.download.disabled, true);
  assert.equal(elements.download.textContent, "Preparing download…");

  await pollHandler();
  assert.equal(elements.download.disabled, true, "idle poll re-enabled the button during preparation");
  assert.equal(elements.download.textContent, "Preparing download…", "idle poll restored the original label");

  resolveTabQuery([]);
  await clickPromise;
});

test("an active download leaves the button available to queue another document", async () => {
  let clickHandler;
  const elements = {
    download: {
      disabled: false,
      textContent: "",
      addEventListener(type, handler) { if (type === "click") clickHandler = handler; }
    },
    progress: { max: 1, value: 0 },
    status: { textContent: "", className: "" },
    details: { textContent: "" }
  };
  const sandbox = {
    chrome: { runtime: { async sendMessage() { return { ok: false }; } } },
    console: { error() {} },
    document: { getElementById(id) { return elements[id]; } },
    setInterval() { return 1; },
    clearInterval() {},
    window: { addEventListener() {} }
  };
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");
  vm.runInContext(source, sandbox, { filename: "popup.js" });
  vm.runInContext(`setDisplay({
    running: true,
    phase: "rendering",
    message: "Rendered 4 / 13 pages",
    completed: 4,
    total: 13,
    queued: [{ documentId: "two", title: "Two" }]
  })`, sandbox);

  assert.equal(typeof clickHandler, "function");
  assert.equal(elements.download.disabled, false);
  assert.equal(elements.download.textContent, "Add this document to queue");
  assert.match(elements.details.textContent, /1 queued/);
});
