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
      sendResponse({ ok: true, state: result.downloadState || state });
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
  const stored = await chrome.storage.session.get("downloadState");
  const latest = stored.downloadState || state;
  if (latest.running) return { ok: false, error: "A PDF download is already running. Reopen this popup to view its progress." };

  await setState({
    running: true,
    phase: "starting",
    message: `Preparing ${job.pages.length} pages…`,
    completed: 0,
    total: job.pages.length,
    textPages: 0,
    failures: [],
    title: job.title,
    updatedAt: Date.now()
  });
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({ type: "run-job", job });
  if (!response?.ok) {
    await setState({ ...state, running: false, phase: "failed", message: response?.error || "The hidden renderer did not start." });
    return { ok: false, error: state.message };
  }
  return { ok: true };
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
    failures: [],
    title: "",
    updatedAt: Date.now()
  };
}
