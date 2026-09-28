chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "prepare-job") return;
  prepareJob().then(
    job => sendResponse({ ok: true, job }),
    error => {
      console.error("Scribd Preview to PDF:", error);
      sendResponse({ ok: false, error: error.message });
    }
  );
  return true;
});

async function prepareJob() {
  const pageSource = await fetch(location.href, { credentials: "include", cache: "no-store" }).then(assertOk).then(r => r.text());
  const documentId = getDocumentId(pageSource);
  const source = await getPreviewSource(documentId, pageSource);
  let pages = parsePages(source);
  if (!pages.length) throw new Error("No Scribd page manifest was found in this preview.");

  await waitForRenderedPages(pages, 5000);
  pages = attachRenderedPageHtml(pages, document);

  const csrf = await fetch("https://www.scribd.com/csrf_token", {
    method: "POST", credentials: "include", headers: { "content-type": "application/json" },
    body: JSON.stringify({ href: location.href })
  }).then(assertOk).then(r => r.json());

  const tokenResult = await fetch(`https://www.scribd.com/document/${documentId}/token`, {
    method: "POST", credentials: "include",
    headers: { "content-type": "application/json", "x-csrf-token": csrf.csrf_token, "x-requested-with": "XMLHttpRequest" },
    body: "{}"
  }).then(assertOk).then(r => r.json());

  return {
    documentId, title: getTitle(pageSource, documentId), token: tokenResult.token, pages,
    styleText: `${extractStyleText(pageSource)}\n${extractStyleText(source)}`, concurrency: 6, jpegQuality: 0.92
  };
}

async function getPreviewSource(documentId, fallbackSource) {
  if (!/^\/(?:doc|document)\/\d+(?:\/|$)/i.test(location.pathname)) return fallbackSource;
  const previewUrl = new URL(`/embeds/${documentId}/content`, location.origin);
  previewUrl.searchParams.set("start_page", "1");
  previewUrl.searchParams.set("view_mode", "scroll");
  previewUrl.searchParams.set("show_recommendations", "false");
  try {
    const previewSource = await fetch(previewUrl, {
      credentials: "include",
      cache: "no-store"
    }).then(assertOk).then(response => response.text());
    return parsePages(previewSource).length ? previewSource : fallbackSource;
  } catch (_) {
    return fallbackSource;
  }
}

async function waitForRenderedPages(pages, timeoutMs) {
  const expected = new Set(pages.map(page => page.pageNum));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let found = 0;
    for (const pageNum of expected) {
      if (document.getElementById(`page${pageNum}`)) found++;
    }
    if (found === expected.size) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

function attachRenderedPageHtml(pages, root) {
  return pages.map(page => {
    const rendered = root.getElementById(`page${page.pageNum}`);
    return rendered ? { ...page, inlineHtml: rendered.outerHTML } : page;
  });
}

function assertOk(response) {
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} while requesting ${response.url}`);
  return response;
}

function getDocumentId(source) {
  const fromUrl = location.pathname.match(/\/embeds\/(\d+)\/content/);
  const fromOfficialUrl = location.pathname.match(/^\/(?:doc|document)\/(\d+)(?:\/|$)/);
  const fromSource = source.match(/initTokenRefresh\(["'](\d+)["']\)/);
  const id = fromUrl?.[1] || fromOfficialUrl?.[1] || fromSource?.[1];
  if (!id) throw new Error("Could not identify the Scribd document.");
  return id;
}

function parsePages(source) {
  const pages = [];
  const sourceDocument = new DOMParser().parseFromString(source, "text/html");
  for (const match of source.matchAll(/docManager\.addPage\(\{([\s\S]*?)\}\);/g)) {
    const block = match[1];
    const pageNum = Number(block.match(/pageNum\s*:\s*(\d+)/)?.[1]);
    const width = Number(block.match(/origWidth\s*:\s*(\d+)/)?.[1]);
    const height = Number(block.match(/origHeight\s*:\s*(\d+)/)?.[1]);
    const contentUrl = block.match(/contentUrl\s*:\s*["']([^"']+)["']/)?.[1];
    const inlineId = block.match(/innerPageElem\s*:\s*document\.getElementById\(["']([^"']+)["']\)/)?.[1];
    const inlineHtml = inlineId ? sourceDocument.getElementById(inlineId)?.outerHTML : null;
    if (pageNum && width && height && (contentUrl || inlineHtml)) pages.push({ pageNum, width, height, contentUrl, inlineHtml });
  }
  return pages.sort((a, b) => a.pageNum - b.pageNum);
}

function getTitle(source, documentId) {
  const match = source.match(/"document"\s*:\s*\{[\s\S]*?"id"\s*:\s*\d+[\s\S]*?"title"\s*:\s*("(?:\\.|[^"\\])*")/);
  if (match) { try { return JSON.parse(match[1]); } catch (_) {} }
  return `scribd-${documentId}`;
}

function extractStyleText(source) {
  const parsed = new DOMParser().parseFromString(source, "text/html");
  return [...parsed.querySelectorAll("style")].map(style => style.textContent).join("\n");
}
