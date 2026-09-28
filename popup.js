const button = document.getElementById("download");
const progress = document.getElementById("progress");
const status = document.getElementById("status");
const details = document.getElementById("details");
let pollTimer;

refreshStatus();
pollTimer = setInterval(refreshStatus, 700);
window.addEventListener("unload", () => clearInterval(pollTimer));

button.addEventListener("click", async () => {
  button.disabled = true;
  setDisplay({ phase: "detecting", message: "Finding a Scribd document or preview…", completed: 0, total: 0, failures: [] });
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active browser tab was found.");

    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
    const frame = chooseScribdFrame(frames || [], tab.url || "");
    if (!frame) throw new Error("No supported Scribd document was detected. Open an official /doc/ page or wait for the embedded preview to appear.");

    setDisplay({ phase: "detecting", message: "Reading the complete page list and requesting a fresh access token…", completed: 0, total: 0, failures: [] });
    let prepared;
    try {
      prepared = await chrome.tabs.sendMessage(tab.id, { type: "prepare-job" }, { frameId: frame.frameId });
    } catch (_) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [frame.frameId] }, files: ["content.js"] });
      prepared = await chrome.tabs.sendMessage(tab.id, { type: "prepare-job" }, { frameId: frame.frameId });
    }
    if (!prepared?.ok) throw new Error(prepared?.error || "The Scribd page could not be read.");

    setDisplay({ phase: "starting", message: `Found ${prepared.job.pages.length} pages. Starting the hidden renderer…`, completed: 0, total: prepared.job.pages.length, failures: [] });
    const started = await chrome.runtime.sendMessage({ type: "start-job", job: prepared.job });
    if (!started?.ok) throw new Error(started?.error || "Could not start the PDF builder.");
    await refreshStatus();
  } catch (error) {
    console.error(error);
    setDisplay({ phase: "failed", message: error.message, completed: 0, total: 0, failures: [] });
    button.disabled = false;
  }
});

function chooseScribdFrame(frames, activeUrl) {
  const embed = frames.find(frame => /^https:\/\/www\.scribd\.com\/embeds\/\d+\/content(?:[/?#]|$)/i.test(frame.url));
  if (embed) return embed;
  if (/^https:\/\/www\.scribd\.com\/(?:doc|document)\/\d+(?:[/?#]|$)/i.test(activeUrl)) {
    return frames.find(frame => frame.frameId === 0) || { frameId: 0, url: activeUrl };
  }
  return null;
}

async function refreshStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "get-status" });
    if (response?.ok) setDisplay(response.state);
  } catch (_) {}
}

function setDisplay(state) {
  const total = Number(state.total) || 0;
  const completed = Number(state.completed) || 0;
  progress.max = Math.max(1, total);
  progress.value = Math.min(completed, progress.max);
  status.textContent = state.message || state.phase || "";
  status.className = state.phase === "failed" ? "error" : state.phase === "complete" ? "success" : "";
  const parts = [];
  if (total) parts.push(`${completed} / ${total} pages`);
  if (state.textPages) parts.push(`${state.textPages} with selectable text`);
  if (state.failures?.length) parts.push(`${state.failures.length} failed`);
  if (state.sizeMiB) parts.push(`${state.sizeMiB} MiB`);
  if (state.title) parts.push(state.title);
  details.textContent = parts.join(" • ");
  button.disabled = !!state.running;
  button.textContent = state.running ? "Download in progress…" : "Download all pages as PDF";
}
