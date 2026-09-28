const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("different documents run sequentially and duplicate queued documents are rejected", async () => {
  const calls = [];
  let releaseFirst;
  const sandbox = {
    AbortController,
    Blob,
    DOMException,
    Map,
    Promise,
    TextEncoder,
    Uint8Array,
    URL,
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        async sendMessage() { return { ok: true }; }
      }
    },
    console,
    document: {},
    setTimeout,
    clearTimeout
  };

  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(__dirname, "..", "builder.js"), "utf8");
  vm.runInContext(source, sandbox, { filename: "builder.js" });
  vm.runInContext(`runJob = async job => {
    globalThis.__calls.push({ event: "start", id: job.documentId });
    if (job.documentId === "one") await new Promise(resolve => { globalThis.__releaseFirst = resolve; });
    globalThis.__calls.push({ event: "end", id: job.documentId });
  };`, sandbox);
  sandbox.__calls = calls;

  const enqueueJob = vm.runInContext("enqueueJob", sandbox);
  const first = enqueueJob({ documentId: "one", title: "One" });
  const duplicate = enqueueJob({ documentId: "one", title: "One again" });
  const second = enqueueJob({ documentId: "two", title: "Two" });

  assert.equal(first.queued, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(second.queued, true);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(JSON.stringify(calls), JSON.stringify([{ event: "start", id: "one" }]));

  vm.runInContext("globalThis.__releaseFirst()", sandbox);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(JSON.stringify(calls), JSON.stringify([
    { event: "start", id: "one" },
    { event: "end", id: "one" },
    { event: "start", id: "two" },
    { event: "end", id: "two" }
  ]));
});
