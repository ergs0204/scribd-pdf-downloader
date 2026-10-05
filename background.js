const OFFSCREEN_URL = "builder.html";
let state = idleState();

chrome.runtime.onInstalled.addListener(() => setState(idleState()));
chrome.runtime.onStartup.addListener(() => setState(idleState()));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "start-job") {
    startJob(message.job).then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "get-status") {
    chrome.storage.session.get("downloadState").then(result => {
      const stored = result.downloadState;
      if (stored && Number(stored.updatedAt) > Number(state.updatedAt)) state = stored;
      sendResponse({ ok: true, state });
    });
    return true;
  }

  if (message?.type === "progress-update") {
    setState({ ...state, ...message.update, updatedAt: Date.now() });
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "save-pdf") {
    chrome.downloads.download({ url: message.url, filename: message.filename, saveAs: true }).then(
      id => sendResponse({ ok: true, downloadId: id }),
      error => sendResponse({ ok: false, error: error.message })
    );
    return true;
  }
});

async function startJob(job) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({ type: "enqueue-job", job });
  if (!response?.ok) {
    await setState({ ...state, running: false, phase: "failed", message: response?.error || "The hidden renderer did not start." });
    return { ok: false, error: state.message };
  }
  return response;
}

async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
    if (contexts.length) return;
  } else if (await chrome.offscreen.hasDocument()) {
    return;
  }
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["DOM_PARSER", "BLOBS"],
    justification: "Render Scribd page DOM, assemble page canvases, and create the downloadable PDF blob."
  });
}

async function setState(next) {
  state = next;
  await chrome.storage.session.set({ downloadState: state });
}

function idleState() {
  return {
    running: false,
    phase: "idle",
    message: "Open a Scribd document or preview, then click Download. No scrolling is required.",
    completed: 0,
    total: 0,
    textPages: 0,
    decodedTextPages: 0,
    unresolvedTextPages: 0,
    failures: [],
    queued: [],
    currentDocumentId: null,
    title: "",
    updatedAt: Date.now()
  };
}
