let processingQueue = false;
let activeDocumentId = null;
let lastProgress = {
  running: false,
  phase: "idle",
  message: "Ready for a Scribd preview.",
  completed: 0,
  total: 0,
  textPages: 0,
  decodedTextPages: 0,
  unresolvedTextPages: 0,
  failures: [],
  title: ""
};
const pendingJobs = [];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "enqueue-job") return;
  sendResponse(enqueueJob(message.job));
});

function enqueueJob(job) {
  const documentId = String(job?.documentId || "");
  if (!documentId) return { ok: false, error: "The Scribd document ID is missing." };
  if (activeDocumentId === documentId || pendingJobs.some(item => String(item.documentId) === documentId)) {
    return { ok: true, queued: false, duplicate: true };
  }

  pendingJobs.push(job);
  const position = processingQueue ? pendingJobs.length : 0;
  void report({});
  void processQueue();
  return { ok: true, queued: true, duplicate: false, position };
}

async function processQueue() {
  if (processingQueue) return;
  processingQueue = true;
  while (pendingJobs.length) {
    const job = pendingJobs.shift();
    activeDocumentId = String(job.documentId);
    try {
      await runJob(job);
    } catch (error) {
      console.error(error);
      await report({
        running: false,
        phase: "failed",
        message: error.message,
        title: job.title,
        failures: lastProgress.failures || []
      });
    } finally {
      document.getElementById?.("scribd-document-fonts")?.remove();
      activeDocumentId = null;
    }
  }
  processingQueue = false;
  await report({ running: false });
}

async function runJob(job) {
  await report({
    running: true, phase: "rendering", message: `Rendering 0 / ${job.pages.length} pages…`,
    completed: 0, total: job.pages.length, textPages: 0, decodedTextPages: 0, unresolvedTextPages: 0, failures: [], title: job.title
  });

  const output = new Array(job.pages.length);
  const fontStyleText = await loadDocumentFontStyles(job.fontStylesheets || []);
  installDocumentFontStyles(fontStyleText);
  const renderStyleText = `${job.styleText || ""}\n${fontStyleText}`;
  const textDecoder = inferFontTextDecoder(documentFontCmaps(fontStyleText));
  let completed = 0;
  let next = 0;
  let textPageCount = 0;
  let decodedTextPageCount = 0;
  let unresolvedTextPageCount = 0;
  const failures = [];

  async function worker() {
    while (true) {
      const index = next++;
      if (index >= job.pages.length) return;
      const page = job.pages[index];
      try {
        output[index] = await retry(() => buildPage(page, job.token, job.jpegQuality, renderStyleText, textDecoder), 3);
        if (output[index].texts.some(fragment => fragment.selectable !== false)) textPageCount++;
        if (output[index].texts.some(fragment => fragment.decoded)) decodedTextPageCount++;
        if (output[index].texts.some(fragment => fragment.selectable === false)) unresolvedTextPageCount++;
      } catch (error) {
        failures.push({ page: page.pageNum, error: error.message });
      }
      completed++;
      await report({
        running: true,
        phase: "rendering",
        message: `Rendered ${completed} / ${job.pages.length} pages`,
        completed,
        total: job.pages.length,
        textPages: textPageCount,
        decodedTextPages: decodedTextPageCount,
        unresolvedTextPages: unresolvedTextPageCount,
        failures: [...failures],
        title: job.title
      });
    }
  }

  await Promise.all(Array.from({ length: Math.min(job.concurrency, job.pages.length) }, worker));
  if (failures.length) {
    throw new Error(`Could not render every page. ${failures.map(x => `Page ${x.page}: ${x.error}`).join("; ")}`);
  }

  await report({ running: true, phase: "assembling", message: "Assembling PDF and Unicode text layer…", completed, total: job.pages.length, textPages: textPageCount, failures: [], title: job.title });
  const pdf = makePdf(output);
  const blob = new Blob([pdf], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const filename = `${safeFilename(job.title || `scribd-${job.documentId}`)}.pdf`;
  await report({ running: true, phase: "saving", message: "PDF assembled. Opening the Save dialog…", completed, total: job.pages.length, textPages: textPageCount, failures: [], title: job.title });
  const saved = await chrome.runtime.sendMessage({ type: "save-pdf", url, filename });
  if (!saved?.ok) throw new Error(saved?.error || "Chrome could not save the PDF.");
  await report({
    running: false,
    phase: "complete",
    message: "PDF ready. The browser download has started.",
    completed,
    total: job.pages.length,
    textPages: textPageCount,
    decodedTextPages: decodedTextPageCount,
    unresolvedTextPages: unresolvedTextPageCount,
    failures: [],
    title: job.title,
    sizeMiB: +(blob.size / 1048576).toFixed(1)
  });
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}

async function loadDocumentFontStyles(stylesheetUrls) {
  const styles = await Promise.all([...new Set(stylesheetUrls)].map(async stylesheetUrl => {
    const css = await fetchBody(
      stylesheetUrl,
      { cache: "force-cache" },
      response => response.text(),
      "Document font stylesheet"
    );
    return absolutizeCssUrls(css, stylesheetUrl);
  }));
  return styles.join("\n");
}

function absolutizeCssUrls(css, stylesheetUrl) {
  return css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (_, quote, value) => {
    if (/^(?:data:|blob:|chrome-extension:)/i.test(value)) return `url(${quote}${value}${quote})`;
    try { return `url("${new URL(value, stylesheetUrl).href}")`; }
    catch (_) { return `url(${quote}${value}${quote})`; }
  });
}

function installDocumentFontStyles(css) {
  document.getElementById?.("scribd-document-fonts")?.remove();
  if (!css?.trim()) return null;
  const style = document.createElement("style");
  style.id = "scribd-document-fonts";
  style.textContent = css;
  document.head.appendChild(style);
  return style;
}

async function report(update) {
  lastProgress = {
    ...lastProgress,
    ...update,
    currentDocumentId: activeDocumentId,
    queued: pendingJobs.map(job => ({ documentId: String(job.documentId), title: job.title || `scribd-${job.documentId}` }))
  };
  await chrome.runtime.sendMessage({ type: "progress-update", update: lastProgress });
}

async function buildPage(page, token, quality, styleText, textDecoder) {
  const html = page.inlineHtml || parseJsonp(
    await fetchBody(withToken(page.contentUrl, token), { cache: "no-store" }, response => response.text(), "Page data")
  );
  const doc = new DOMParser().parseFromString(html, "text/html");
  const images = [...doc.querySelectorAll("img[orig], img[src]")];
  const texts = await extractTextFragments(html, styleText, page, textDecoder);
  if (!images.length && !texts.length) throw new Error("No image or built-in text data was found.");

  const canvas = createRenderCanvas(page.width, page.height);
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, page.width, page.height);
  const cache = new Map();

  for (const element of images) {
    const assetUrl = normalizeAssetUrl(element.getAttribute("orig") || element.getAttribute("src"));
    let bitmap = cache.get(assetUrl);
    if (!bitmap) {
      const blob = await fetchBody(withToken(assetUrl, token), { cache: "force-cache" }, response => response.blob(), "Page image");
      bitmap = await withTimeout(
        createImageBitmap(blob),
        configuredNumber("__SPDF_IMAGE_TIMEOUT_MS", 20000),
        "Page image decoding timed out."
      );
      cache.set(assetUrl, bitmap);
    }
    drawClippedImage(ctx, bitmap, element);
  }
  for (const bitmap of cache.values()) bitmap.close();

  drawVisibleText(ctx, texts);
  const jpeg = await renderCanvasToBlob(canvas, "image/jpeg", quality);
  return { width: page.width, height: page.height, bytes: new Uint8Array(await jpeg.arrayBuffer()), texts };
}

function createRenderCanvas(width, height) {
  const canvas = document.createElement?.("canvas");
  if (canvas?.getContext) {
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  return new OffscreenCanvas(width, height);
}

async function renderCanvasToBlob(canvas, type, quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error("Canvas image encoding failed.")),
      type,
      quality
    );
  });
}

async function extractTextFragments(html, styleText, page, textDecoder) {
  const host = document.createElement("div");
  Object.assign(host.style, {
    position: "fixed", left: "-100000px", top: "0", width: `${page.width}px`, height: `${page.height}px`,
    overflow: "hidden", pointerEvents: "none"
  });
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `${styleText || ""}\n.newpage{position:relative!important;margin:0!important;transform:none!important;} .text_layer{transform-origin:top left!important;}`;
  const container = document.createElement("div");
  container.innerHTML = html;
  shadow.append(style, container);

  try {
    await waitForLayout();
    const pageElement = shadow.querySelector(".newpage") || container.firstElementChild;
    const textLayer = shadow.querySelector(".text_layer");
    if (!pageElement || !textLayer) return [];
    await loadTextLayerFonts(textLayer);
    await Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 1200))]);

    const pageRect = pageElement.getBoundingClientRect();
    const fragments = [];
    const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = node.nodeValue;
      if (!text || !text.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      range.detach();
      if (!rect.width || !rect.height) continue;
      const computed = getComputedStyle(node.parentElement);
      fragments.push({
        text,
        characterBoxes: measureCharacterBoxes(node, pageRect),
        x: rect.left - pageRect.left,
        y: rect.top - pageRect.top,
        width: rect.width,
        height: rect.height,
        color: visibleColor(computed.color),
        family: computed.fontFamily || "sans-serif",
        weight: computed.fontWeight || "400",
        style: computed.fontStyle || "normal",
        ...textCanvasMetrics(node.parentElement, pageElement, computed),
        writingMode: computed.writingMode || "horizontal-tb",
        // Visual glyphs still use the source codes. Only the invisible PDF
        // layer uses Unicode recovered from the document's subset fonts.
        ...decodeFontText(text, computed.fontFamily, textDecoder)
      });
    }
    return fragments;
  } finally {
    host.remove();
  }
}

function measureCharacterBoxes(node, pageRect) {
  const range = document.createRange();
  // Older test DOMs may not implement Range offsets. Actual browser exports
  // always measure source-font advances, including kerning and CSS spacing.
  if (!range.setStart || !range.setEnd) { range.detach(); return null; }
  const boxes = [];
  let offset = 0;
  for (const character of node.nodeValue) {
    range.setStart(node, offset);
    offset += character.length;
    range.setEnd(node, offset);
    const rect = range.getBoundingClientRect();
    boxes.push({ x: rect.left - pageRect.left, y: rect.top - pageRect.top, width: rect.width, height: rect.height });
  }
  range.detach();
  return boxes;
}

function textCanvasMetrics(element, pageElement, computed) {
  let scale = 1;
  for (let current = element; current && current !== pageElement; current = current.parentElement) {
    const matrix = getComputedStyle(current).transform?.match(/^matrix\(([^)]+)\)$/);
    if (matrix) {
      const values = matrix[1].split(",").map(Number);
      scale *= Math.hypot(values[0], values[1]);
    }
  }
  return {
    fontSize: cssNumber(computed.fontSize) * scale,
    letterSpacing: cssNumber(computed.letterSpacing) * scale,
    wordSpacing: cssNumber(computed.wordSpacing) * scale
  };
}

async function loadTextLayerFonts(textLayer) {
  const requests = new Map();
  const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.nodeValue?.trim();
    if (!text || !node.parentElement) continue;
    const computed = getComputedStyle(node.parentElement);
    const family = computed.fontFamily?.split(",")[0]?.trim();
    if (!isDocumentFontFamily(family)) continue;
    const font = `${computed.fontStyle || "normal"} ${computed.fontWeight || "400"} ${computed.fontSize || "16px"} ${family}`;
    if (!requests.has(font)) requests.set(font, { font, text });
  }
  if (!requests.size) return;

  const timeoutMs = configuredNumber("__SPDF_FONT_TIMEOUT_MS", 8000);
  const results = await withTimeout(
    Promise.all([...requests.values()].map(request => document.fonts.load(request.font, request.text))),
    timeoutMs,
    "Scribd document fonts timed out."
  );
  for (let index = 0; index < results.length; index++) {
    if (!results[index]?.length) {
      throw new Error(`Scribd document font ${[...requests.values()][index].font} could not be loaded.`);
    }
  }
}

function isDocumentFontFamily(value) {
  const family = value?.split(",")[0]?.trim();
  return /^['"]?ff\d+['"]?$/i.test(family || "");
}

// Scribd subset glyph IDs retain the original character ordering. Across the
// four scrambled ASCII blocks, that ordering constrains a shared low-nibble
// permutation. Accept only a complete, unique, contradiction-free ordering;
// never substitute a fixed document key or guess from language frequency.
function inferFontTextDecoder(fonts) {
  const edges = Array.from({ length: 16 }, () => new Set());
  const families = new Set();
  for (const { family, cmap } of fonts) {
    if (!isDocumentFontFamily(family)) continue;
    let evidence = false;
    for (let block = 0x30; block < 0x70; block += 16) {
      const entries = cmap.filter(item => item.code >= block && item.code < block + 16 && item.glyph > 0)
        .sort((a, b) => a.glyph - b.glyph);
      if (new Set(entries.map(item => item.glyph)).size !== entries.length) return null;
      for (let i = 1; i < entries.length; i++) {
        edges[entries[i - 1].code & 15].add(entries[i].code & 15);
        evidence = true;
      }
    }
    if (evidence) families.add(family.replace(/^["']|["']$/g, '').toLowerCase());
  }
  const indegree = Array(16).fill(0);
  for (const successors of edges) for (const next of successors) indegree[next]++;
  const remaining = new Set(Array.from({ length: 16 }, (_, i) => i));
  const inverse = [];
  for (let plain = 0; plain < 16; plain++) {
    const available = [...remaining].filter(node => indegree[node] === 0);
    if (available.length !== 1) return null;
    const encoded = available[0];
    inverse[encoded] = plain;
    remaining.delete(encoded);
    for (const next of edges[encoded]) indegree[next]--;
  }
  return { inverse, families };
}

function decodeFontText(text, family, decoder) {
  if (!isDocumentFontFamily(family)) return { copyText: text, selectable: true, decoded: false };
  const name = family.split(',')[0].trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (!decoder?.families.has(name)) return { copyText: '', selectable: false, decoded: false };
  const copyText = [...text].map(character => {
    const code = character.codePointAt(0);
    return code >= 0x30 && code < 0x70
      ? String.fromCharCode((code & ~15) | decoder.inverse[code & 15]) : character;
  }).join('');
  // Private-use symbol glyphs have no Unicode meaning in cmap. Keep their
  // appearance but omit them from copying rather than inventing a character.
  if (/[\uE000-\uF8FF]/u.test(copyText)) return { copyText: '', selectable: false, decoded: false };
  return { copyText, selectable: true, decoded: true };
}

function documentFontCmaps(css) {
  const fonts = [];
  for (const match of css.matchAll(/@font-face\s*\{([^}]+)\}/gi)) {
    const family = match[1].match(/font-family\s*:\s*["']?(ff\d+)/i)?.[1];
    const data = match[1].match(/url\(\s*["']?data:[^,;]+(?:;[^,]*)?;base64,([A-Za-z0-9+/=\s]+)["']?\s*\)/i)?.[1];
    if (!family || !data || data.length > 16 * 1024 * 1024) continue;
    try {
      const bytes = Uint8Array.from(atob(data.replace(/\s/g, '')), c => c.charCodeAt(0));
      const cmap = readSfntCmap(bytes);
      if (cmap.length) fonts.push({ family, cmap });
    } catch (_) { /* Unsupported/malformed fonts cannot supply a decoder. */ }
  }
  return fonts;
}

// Only read the 64 relevant code points. Bounds checks apply to every table
// and subtable access; hostile/unsupported fonts fail closed, without loops
// over a potentially enormous character range.
function readSfntCmap(bytes) {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = offset => view.getUint16(offset, false);
    const u32 = offset => view.getUint32(offset, false);
    const bounded = (offset, length, end = bytes.length) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || offset + length > end) throw new Error('Invalid font bounds');
    };
    bounded(0, 12);
    if (![0x00010000, 0x4f54544f, 0x74727565].includes(u32(0))) return [];
    const tables = u16(4);
    if (tables > 256) return [];
    bounded(12, tables * 16);
    let base, end;
    for (let i = 0; i < tables; i++) {
      const record = 12 + i * 16;
      if (u32(record) !== 0x636d6170) continue;
      base = u32(record + 8);
      const length = u32(record + 12);
      bounded(base, length);
      end = base + length;
    }
    if (base === undefined) return [];
    bounded(base, 4, end);
    const count = u16(base + 2);
    if (count > 64) return [];
    bounded(base + 4, count * 8, end);
    const candidates = [];
    for (let i = 0; i < count; i++) {
      const record = base + 4 + i * 8;
      const platform = u16(record), encoding = u16(record + 2);
      if (platform !== 0 && !(platform === 3 && [1, 10].includes(encoding))) continue;
      const sub = base + u32(record + 4);
      bounded(sub, 2, end);
      const format = u16(sub);
      if (![4, 12].includes(format)) continue;
      bounded(sub, 16, end);
      const length = format === 4 ? u16(sub + 2) : u32(sub + 4);
      if (length < 16) return [];
      bounded(sub, length, end);
      const limit = sub + length;
      const entries = [];
      if (format === 4) {
        const segments = u16(sub + 6) / 2;
        if (!Number.isInteger(segments) || segments < 1 || segments > 8192) return [];
        bounded(sub, 16 + 8 * segments, limit);
        const ends = sub + 14, starts = ends + 2 * segments + 2;
        const deltas = starts + 2 * segments, offsets = deltas + 2 * segments;
        for (let code = 0x30; code < 0x70; code++) {
          for (let i = 0; i < segments; i++) {
            if (code < u16(starts + 2 * i) || code > u16(ends + 2 * i)) continue;
            const delta = u16(deltas + 2 * i), range = u16(offsets + 2 * i);
            let glyph;
            if (!range) glyph = (code + delta) & 0xffff;
            else {
              const address = offsets + 2 * i + range + 2 * (code - u16(starts + 2 * i));
              bounded(address, 2, limit);
              glyph = u16(address);
              if (glyph) glyph = (glyph + delta) & 0xffff;
            }
            if (glyph) entries.push({ code, glyph });
            break;
          }
        }
      } else {
        const groups = u32(sub + 12);
        if (groups > 65536) return [];
        bounded(sub + 16, groups * 12, limit);
        for (let i = 0; i < groups; i++) {
          const record = sub + 16 + 12 * i, start = u32(record), finish = u32(record + 4);
          if (finish < start) return [];
          for (let code = Math.max(start, 0x30); code <= Math.min(finish, 0x6f); code++) {
            const glyph = u32(record + 8) + code - start;
            if (glyph) entries.push({ code, glyph });
          }
        }
      }
      if (entries.length) candidates.push(entries);
    }
    // Unicode subtables must agree for the range being decoded.
    const signature = entries => JSON.stringify(entries.slice().sort((a, b) => a.code - b.code));
    if (candidates.some(entries => signature(entries) !== signature(candidates[0]))) return [];
    return candidates[0] || [];
  } catch (_) { return []; }
}

async function waitForLayout() {
  const timeoutMs = configuredNumber("__SPDF_LAYOUT_TIMEOUT_MS", 100);
  await Promise.race([
    new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    new Promise(resolve => setTimeout(resolve, timeoutMs))
  ]);
}

function drawVisibleText(ctx, fragments) {
  for (const fragment of fragments) {
    const size = Math.max(1, fragment.fontSize || fragment.height * 0.9);
    ctx.save();
    ctx.fillStyle = fragment.color;
    ctx.font = `${fragment.style} ${fragment.weight} ${size}px ${fragment.family}`;
    ctx.letterSpacing = `${fragment.letterSpacing || 0}px`;
    ctx.wordSpacing = `${fragment.wordSpacing || 0}px`;
    ctx.textBaseline = "top";
    if (fragment.writingMode.startsWith("vertical")) {
      ctx.translate(fragment.x + fragment.width, fragment.y);
      ctx.rotate(Math.PI / 2);
      ctx.fillText(fragment.text, 0, 0, Math.max(fragment.height, fragment.width));
    } else {
      ctx.fillText(fragment.text, fragment.x, fragment.y, Math.max(1, fragment.width));
    }
    ctx.restore();
  }
}

function visibleColor(value) {
  if (!value || /rgba\([^)]*,\s*0(?:\.0+)?\s*\)/i.test(value) || value === "transparent") return "#000";
  return value;
}

function drawClippedImage(ctx, bitmap, element) {
  const left = cssNumber(element.style.left);
  const top = cssNumber(element.style.top);
  const width = cssNumber(element.style.width) || bitmap.width;
  const height = cssNumber(element.style.height) || bitmap.height;
  const clip = parseClip(element.style.clip, width, height);
  const dw = Math.max(0, clip.right - clip.left);
  const dh = Math.max(0, clip.bottom - clip.top);
  if (!dw || !dh) return;
  const scaleX = bitmap.width / width;
  const scaleY = bitmap.height / height;
  ctx.drawImage(
    bitmap,
    clip.left * scaleX, clip.top * scaleY, dw * scaleX, dh * scaleY,
    left + clip.left, top + clip.top, dw, dh
  );
}

function parseClip(value, width, height) {
  const match = value?.match(/rect\(\s*(-?[\d.]+)px[ ,]+(-?[\d.]+)px[ ,]+(-?[\d.]+)px[ ,]+(-?[\d.]+)px\s*\)/i);
  return match
    ? { top: +match[1], right: +match[2], bottom: +match[3], left: +match[4] }
    : { top: 0, right: width, bottom: height, left: 0 };
}

function parseJsonp(text) {
  const start = text.indexOf("(");
  const end = text.lastIndexOf(")");
  if (start < 0 || end <= start) throw new Error("Invalid page JSONP.");
  const value = JSON.parse(text.slice(start + 1, end));
  if (!Array.isArray(value) || typeof value[0] !== "string") throw new Error("Unexpected page JSONP payload.");
  return value[0];
}

function normalizeAssetUrl(value) {
  if (!value) throw new Error("Page image URL is missing.");
  return value.replace(/^http:\/\/html\.scribd\.com\//i, "https://html.scribdassets.com/");
}

function withToken(value, token) {
  const url = new URL(value);
  url.searchParams.set("token", token);
  return url.href;
}

function cssNumber(value) { return Number.parseFloat(value || "0") || 0; }

function assertOk(response) {
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${safeUrl(response.url)}`);
  return response;
}

async function fetchBody(url, options, readBody, label) {
  const controller = new AbortController();
  const timeoutMs = configuredNumber("__SPDF_FETCH_TIMEOUT_MS", 20000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = assertOk(await fetch(url, { ...options, signal: controller.signal }));
    return await readBody(response);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${label} timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function configuredNumber(name, fallback) {
  const value = Number(globalThis[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    url.searchParams.delete("token");
    return url.href;
  } catch (_) {
    return value;
  }
}

async function retry(action, attempts) {
  let last;
  for (let n = 0; n < attempts; n++) {
    try { return await action(); }
    catch (error) {
      last = error;
      if (n + 1 < attempts) {
        const baseDelay = configuredNumber("__SPDF_RETRY_BASE_MS", 500);
        await new Promise(resolve => setTimeout(resolve, baseDelay * 2 ** n));
      }
    }
  }
  throw last;
}

function safeFilename(value) {
  return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "").slice(0, 160) || "scribd-preview";
}

function makePdf(pages) {
  const encoder = new TextEncoder();
  const codec = makeTextCodec(pages);
  const hasText = codec.characters.size > 0;
  const pageObjectStart = 3 + codec.fonts.length * 6;
  const objectCount = 2 + codec.fonts.length * 6 + pages.length * 3;
  const chunks = [];
  const offsets = [0];
  let length = 0;

  function push(value) {
    const bytes = typeof value === "string" ? encoder.encode(value) : value;
    chunks.push(bytes);
    length += bytes.length;
  }
  function object(number, parts) {
    offsets[number] = length;
    push(`${number} 0 obj\n`);
    for (const part of parts) push(part);
    push("\nendobj\n");
  }

  push("%PDF-1.4\n%binary\n");
  object(1, ["<< /Type /Catalog /Pages 2 0 R >>"]);
  const kids = pages.map((_, i) => `${pageObjectStart + i * 3} 0 R`).join(" ");
  object(2, [`<< /Type /Pages /Count ${pages.length} /Kids [${kids}] >>`]);

  codec.fonts.forEach((face,index) => {
    const base=3+index*6, name=`ScribdSelection${index}`;
    object(base, [`<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding /Identity-H /DescendantFonts [${base+1} 0 R] /ToUnicode ${base+2} 0 R >>`]);
    const widths = face.entries.map(entry => pdfNumber(entry.advance * 1000 / 4096)).join(' ');
    object(base+1, [`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${base+3} 0 R /DW 1000 /W [1 [${widths}]] /CIDToGIDMap ${base+5} 0 R >>`]);
    const cmap = encoder.encode(makeToUnicodeCMap(face.entries.map(entry => [entry.character, entry.cid])));
    object(base+2, [`<< /Length ${cmap.length} >>\nstream\n`, cmap, "endstream"]);
    const maxWidth = Math.max(...face.glyphWidths) * 1000 / 4096;
    object(base+3, [`<< /Type /FontDescriptor /FontName /${name} /Flags 4 /FontBBox [0 0 ${pdfNumber(maxWidth)} 1000] /ItalicAngle 0 /Ascent 1000 /Descent 0 /CapHeight 1000 /StemV 80 /FontFile2 ${base+4} 0 R >>`]);
    const font = makeSelectionFont(face.glyphWidths);
    object(base+4, [`<< /Length ${font.length} /Length1 ${font.length} >>\nstream\n`, font, "\nendstream"]);
    const gids = new Uint8Array((face.entries.length + 1) * 2);
    const gidView = new DataView(gids.buffer);
    for (const entry of face.entries) gidView.setUint16(entry.cid * 2, entry.gid);
    object(base+5, [`<< /Length ${gids.length} >>\nstream\n`, gids, "\nendstream"]);
  });

  pages.forEach((page, index) => {
    const pageObj = pageObjectStart + index * 3;
    const imageObj = pageObj + 1;
    const contentObj = pageObj + 2;
    const scale = 0.75;
    const pageWidth = +(page.width * scale).toFixed(3);
    const pageHeight = +(page.height * scale).toFixed(3);
    const content = encoder.encode(makePageContent(page, codec, scale));
    const usedFonts = new Set(page.texts.filter(fragment=>fragment.selectable!==false && (fragment.copyText??fragment.text)).map(fragment=>codec.fontFor(fragment)));
    const fontResource = hasText ? ` /Font << ${[...usedFonts].map(face=>`/${face.resource} ${3+face.index*6} 0 R`).join(' ')} >>` : "";
    object(pageObj, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 ${imageObj} 0 R >>${fontResource} >> /Contents ${contentObj} 0 R >>`]);
    object(imageObj, [
      `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.bytes.length} >>\nstream\n`,
      page.bytes,
      "\nendstream"
    ]);
    object(contentObj, [`<< /Length ${content.length} >>\nstream\n`, content, "endstream"]);
  });

  const xref = length;
  push(`xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`);
  for (let i = 1; i <= objectCount; i++) push(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const result = new Uint8Array(length);
  let position = 0;
  for (const chunk of chunks) {
    result.set(chunk, position);
    position += chunk.length;
  }
  return result;
}

function makeTextCodec(pages) {
  const characters = new Map();
  const fonts = [], byFragment = new WeakMap();
  function variant(character, box) {
    // Collapsed source spaces have zero width and are not painted/copied.
    // Keep a sensible nominal metric for them: a near-zero space advance
    // causes some extractors to misclassify tiny kerning corrections as words.
    const ratio=box?.height>0 && box.width>0 ? box.width/box.height : /\s/u.test(character) ? .25 : 1;
    const advance = Math.max(1, Math.min(32767, Math.round(ratio * 4096)));
    return { advance, key: `${character}\u0000${advance}` };
  }
  for (const page of pages) {
    for (const fragment of page.texts) {
      if (fragment.selectable === false) continue;
      const text = [...(fragment.copyText ?? fragment.text)];
      if (!text.length) continue;
      const candidates=text.map((character,index)=>variant(character,selectionBox(fragment,index,text.length)));
      const family=fragment.family || 'source';
      // Some extractors key widths by Unicode instead of CID. Do not put
      // substantially different advances for the same letter in one face.
      // Reuse compatible subsets; split only when source font/spacing differs.
      let face=fonts.find(font=>font.family===family && candidates.every(({advance},i)=>
        !font.primaryWidths.has(text[i]) || Math.abs(font.primaryWidths.get(text[i])-advance)<=1));
      if (!face) {
        face={family,index:fonts.length,resource:`Ftxt${fonts.length}`,entries:[],variants:new Map(),glyphWidths:[],glyphIds:new Map(),primaryWidths:new Map()};
        fonts.push(face);
      }
      byFragment.set(fragment,face);
      text.forEach((character, index) => {
        const {advance,key} = candidates[index];
        if (face.variants.has(key)) return;
        if (face.entries.length >= 65534) throw new Error("The document contains too many character-width variants for one PDF text map.");
        if (!face.glyphIds.has(advance)) { face.glyphWidths.push(advance); face.glyphIds.set(advance,face.glyphWidths.length); }
        const entry = {character,advance,cid:face.entries.length+1,gid:face.glyphIds.get(advance)};
        face.entries.push(entry); face.variants.set(key, entry.cid);
        if (!face.primaryWidths.has(character)) face.primaryWidths.set(character,advance);
        if (!characters.has(character)) characters.set(character, entry.cid);
      });
    }
  }
  return {
    characters,
    fonts,
    entries:fonts.flatMap(font=>font.entries),
    glyphWidths:fonts.flatMap(font=>font.glyphWidths),
    fontFor:fragment=>byFragment.get(fragment),
    encode(text, box, fragment) {
      let hex = "";
      for (const character of text) {
        const cid = box ? byFragment.get(fragment).variants.get(variant(character,box).key) : characters.get(character);
        hex += cid.toString(16).padStart(4, "0");
      }
      return hex;
    }
  };
}

function selectionBox(fragment, index, count) {
  return fragment.characterBoxes?.length === count ? fragment.characterBoxes[index] : {
    x: fragment.x + index * fragment.width / count, y: fragment.y,
    width: fragment.width / count, height: fragment.height
  };
}

function makePageContent(page, codec, scale) {
  const width = +(page.width * scale).toFixed(3);
  const height = +(page.height * scale).toFixed(3);
  let content = `q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ\n`;
  for (const fragment of page.texts) {
    if (fragment.selectable === false) continue;
    const copyText = fragment.copyText ?? fragment.text;
    const characters = [...copyText];
    if (!characters.length) continue;
    content += 'BT\n3 Tr\n';
    let previousEm;
    characters.forEach((character, index) => {
      const box = selectionBox(fragment, index, characters.length);
      if (!(box.width > 0 && box.height > 0)) return;
      const x = box.x * scale, y = (page.height - box.y - box.height) * scale;
      // Keep a stable em scale within each line. Widths belong in the font's
      // CID metrics; changing scale for every letter makes older PDF.js builds
      // infer word spaces even for near-zero rounding gaps.
      const em = pdfNumber(box.height * scale);
      if (em !== previousEm) { content += `/${codec.fontFor(fragment).resource} ${em} Tf\n`; previousEm = em; }
      // Absolute origins avoid accumulating engine-specific integer rounding
      // of CID advances, without changing the per-line transform/space metric.
      content += `1 0 0 1 ${pdfNumber(x)} ${pdfNumber(y)} Tm\n<${codec.encode(character,box,fragment)}> Tj\n`;
    });
    content += 'ET\n';
  }
  return content;
}

// Tiny, deterministic rectangular glyphs used ONLY with invisible rendering
// mode 3. It makes selection geometry independent of installed fallback fonts.
// Source Scribd fonts still draw every visible glyph; /ToUnicode supplies text.
function makeSelectionFont(widths = [4096]) {
  const units = 4096, count = widths.length + 1;
  const maxAdvance = Math.max(units, ...widths);
  const tables = new Map();
  function table(tag, size) {
    const bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
    tables.set(tag, bytes);
    return { u16: (at, value) => view.setUint16(at, value), u32: (at, value) => view.setUint32(at, value), bytes };
  }
  const head = table('head', 54);
  head.u32(0, 0x10000); head.u32(4, 0x10000); head.u32(12, 0x5f0f3cf5);
  head.u16(18, units); head.u16(40, maxAdvance); head.u16(42, units); head.u16(46, 8); head.u16(48, 2); head.u16(50, 1);
  const hhea = table('hhea', 36);
  hhea.u32(0, 0x10000); hhea.u16(4, units); hhea.u16(10, maxAdvance); hhea.u16(16, maxAdvance); hhea.u16(18, 1); hhea.u16(34, count);
  const maxp = table('maxp', 32);
  maxp.u32(0, 0x10000); maxp.u16(4, count); maxp.u16(6, 4); maxp.u16(8, 1); maxp.u16(14, 1);
  const hmtx = table('hmtx', count * 4); hmtx.u16(0, units);
  const loca = table('loca', (count + 1) * 4);
  const glyf = table('glyf', widths.length * 36);
  widths.forEach((advance,index) => {
    hmtx.u16((index+1)*4,advance);
    loca.u32((index+2)*4,(index+1)*36);
    const at=index*36;
    glyf.u16(at,1); glyf.u16(at+6,advance); glyf.u16(at+8,units); glyf.u16(at+10,3);
    glyf.bytes.set([1,1,1,1],at+14);
    [0,advance,0,-advance,0,0,units,0].forEach((value,i)=>glyf.u16(at+18+2*i,value));
  });
  const cmap = table('cmap', 44);
  cmap.u16(2, 1); cmap.u16(4, 3); cmap.u16(6, 1); cmap.u32(8, 12);
  cmap.u16(12, 4); cmap.u16(14, 32); cmap.u16(18, 4); cmap.u16(20, 4); cmap.u16(22, 1);
  cmap.u16(26, 32); cmap.u16(28, 65535); cmap.u16(32, 32); cmap.u16(34, 65535);
  cmap.u16(36, -31); cmap.u16(38, 1);
  const os2 = table('OS/2', 78);
  os2.u16(2, units); os2.u16(4, 400); os2.u16(6, 5); os2.u16(62, 64);
  os2.u16(64, 32); os2.u16(66, 32); os2.u16(68, units); os2.u16(74, units);
  const post = table('post', 32); post.u32(0, 0x30000);
  const nameText = 'ScribdSelection';
  const name = table('name', 30 + nameText.length * 2);
  name.u16(2, 2); name.u16(4, 30);
  [1, 6].forEach((id, i) => {
    const at = 6 + i * 12;
    name.u16(at, 3); name.u16(at + 2, 1); name.u16(at + 4, 0x409);
    name.u16(at + 6, id); name.u16(at + 8, nameText.length * 2);
  });
  [...nameText].forEach((c, i) => name.u16(30 + i * 2, c.charCodeAt(0)));
  const entries = [...tables].sort(([a], [b]) => a.localeCompare(b));
  let size = 12 + entries.length * 16;
  for (const [, bytes] of entries) size += (bytes.length + 3) & ~3;
  const result = new Uint8Array(size), view = new DataView(result.buffer);
  view.setUint32(0, 0x10000); view.setUint16(4, entries.length);
  const power = Math.floor(Math.log2(entries.length));
  view.setUint16(6, 16 * 2 ** power); view.setUint16(8, power); view.setUint16(10, entries.length * 16 - 16 * 2 ** power);
  const checksum = bytes => {
    let sum = 0;
    for (let i = 0; i < bytes.length; i += 4) {
      let word = 0;
      for (let j = 0; j < 4; j++) word = (word << 8) | (bytes[i + j] || 0);
      sum = (sum + (word >>> 0)) >>> 0;
    }
    return sum;
  };
  let offset = 12 + entries.length * 16, headOffset;
  entries.forEach(([tag, bytes], i) => {
    const at = 12 + i * 16;
    [...tag].forEach((c, j) => result[at + j] = c.charCodeAt(0));
    view.setUint32(at + 4, checksum(bytes)); view.setUint32(at + 8, offset); view.setUint32(at + 12, bytes.length);
    result.set(bytes, offset);
    if (tag === 'head') headOffset = offset;
    offset += (bytes.length + 3) & ~3;
  });
  view.setUint32(headOffset + 8, (0xb1b0afba - checksum(result)) >>> 0);
  return result;
}

function makeToUnicodeCMap(characters) {
  const entries = Array.isArray(characters) ? characters : [...characters.entries()];
  let cmap = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /ScribdText-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n";
  for (let start = 0; start < entries.length; start += 100) {
    const group = entries.slice(start, start + 100);
    cmap += `${group.length} beginbfchar\n`;
    for (const [character, cid] of group) {
      cmap += `<${cid.toString(16).padStart(4, "0")}> <${unicodeHex(character)}>\n`;
    }
    cmap += "endbfchar\n";
  }
  return `${cmap}endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`;
}

function unicodeHex(character) {
  const point = character.codePointAt(0);
  if (point <= 0xffff) return point.toString(16).padStart(4, "0");
  const adjusted = point - 0x10000;
  const high = 0xd800 + (adjusted >> 10);
  const low = 0xdc00 + (adjusted & 0x3ff);
  return high.toString(16).padStart(4, "0") + low.toString(16).padStart(4, "0");
}

function pdfNumber(value) {
  return Number(value.toFixed(3)).toString();
}
