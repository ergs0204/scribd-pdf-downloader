let processingQueue = false;
let activeDocumentId = null;
let lastProgress = {
  running: false,
  phase: "idle",
  message: "Ready for a Scribd preview.",
  completed: 0,
  total: 0,
  textPages: 0,
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
    completed: 0, total: job.pages.length, textPages: 0, failures: [], title: job.title
  });

  const output = new Array(job.pages.length);
  const fontStyleText = await loadDocumentFontStyles(job.fontStylesheets || []);
  installDocumentFontStyles(fontStyleText);
  const renderStyleText = `${job.styleText || ""}\n${fontStyleText}`;
  let completed = 0;
  let next = 0;
  let textPageCount = 0;
  const failures = [];

  async function worker() {
    while (true) {
      const index = next++;
      if (index >= job.pages.length) return;
      const page = job.pages[index];
      try {
        output[index] = await retry(() => buildPage(page, job.token, job.jpegQuality, renderStyleText), 3);
        if (output[index].texts.some(fragment => fragment.selectable !== false)) textPageCount++;
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

async function buildPage(page, token, quality, styleText) {
  const html = page.inlineHtml || parseJsonp(
    await fetchBody(withToken(page.contentUrl, token), { cache: "no-store" }, response => response.text(), "Page data")
  );
  const doc = new DOMParser().parseFromString(html, "text/html");
  const images = [...doc.querySelectorAll("img[orig], img[src]")];
  const texts = await extractTextFragments(html, styleText, page);
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

async function extractTextFragments(html, styleText, page) {
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
        selectable: !isDocumentFontFamily(computed.fontFamily)
      });
    }
    return fragments;
  } finally {
    host.remove();
  }
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
  const pageObjectStart = hasText ? 6 : 3;
  const objectCount = (hasText ? 5 : 2) + pages.length * 3;
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

  if (hasText) {
    object(3, ["<< /Type /Font /Subtype /Type0 /BaseFont /ScribdText /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 5 0 R >>"]);
    object(4, ["<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Arial /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 /CIDToGIDMap /Identity >>"]);
    const cmap = encoder.encode(makeToUnicodeCMap(codec.characters));
    object(5, [`<< /Length ${cmap.length} >>\nstream\n`, cmap, "endstream"]);
  }

  pages.forEach((page, index) => {
    const pageObj = pageObjectStart + index * 3;
    const imageObj = pageObj + 1;
    const contentObj = pageObj + 2;
    const scale = 0.75;
    const pageWidth = +(page.width * scale).toFixed(3);
    const pageHeight = +(page.height * scale).toFixed(3);
    const content = encoder.encode(makePageContent(page, codec, scale));
    const fontResource = hasText ? " /Font << /Ftxt 3 0 R >>" : "";
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
  for (const page of pages) {
    for (const fragment of page.texts) {
      if (fragment.selectable === false) continue;
      for (const character of fragment.text) {
        if (!characters.has(character)) {
          if (characters.size >= 65534) throw new Error("The document contains too many unique Unicode characters for one PDF text map.");
          characters.set(character, characters.size + 1);
        }
      }
    }
  }
  return {
    characters,
    encode(text) {
      let hex = "";
      for (const character of text) hex += characters.get(character).toString(16).padStart(4, "0");
      return hex;
    }
  };
}

function makePageContent(page, codec, scale) {
  const width = +(page.width * scale).toFixed(3);
  const height = +(page.height * scale).toFixed(3);
  let content = `q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ\n`;
  for (const fragment of page.texts) {
    if (fragment.selectable === false) continue;
    const chars = [...fragment.text].length;
    if (!chars) continue;
    const fontSize = Math.max(1, fragment.height * scale * 0.9);
    const x = Math.max(0, fragment.x * scale);
    const y = Math.max(0, (page.height - fragment.y - fragment.height) * scale);
    const naturalWidth = chars * fontSize;
    const horizontalScale = Math.max(10, Math.min(500, (fragment.width * scale / Math.max(0.01, naturalWidth)) * 100));
    content += `BT\n/Ftxt ${pdfNumber(fontSize)} Tf\n3 Tr\n${pdfNumber(horizontalScale)} Tz\n1 0 0 1 ${pdfNumber(x)} ${pdfNumber(y)} Tm\n<${codec.encode(fragment.text)}> Tj\nET\n`;
  }
  return content;
}

function makeToUnicodeCMap(characters) {
  const entries = [...characters.entries()];
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
