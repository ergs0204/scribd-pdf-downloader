let running = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "run-job") return;
  if (running) {
    sendResponse({ ok: false, error: "The hidden renderer is already busy." });
    return;
  }
  running = true;
  runJob(message.job).catch(async error => {
    console.error(error);
    await report({ running: false, phase: "failed", message: error.message });
  }).finally(() => { running = false; });
  sendResponse({ ok: true });
});

async function runJob(job) {
  await report({
    running: true, phase: "rendering", message: `Rendering 0 / ${job.pages.length} pages…`,
    completed: 0, total: job.pages.length, textPages: 0, failures: [], title: job.title
  });

  const output = new Array(job.pages.length);
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
        output[index] = await retry(() => buildPage(page, job.token, job.jpegQuality, job.styleText), 3);
        if (output[index].texts.length) textPageCount++;
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

async function report(update) {
  await chrome.runtime.sendMessage({ type: "progress-update", update });
}

async function buildPage(page, token, quality, styleText) {
  const html = page.inlineHtml || parseJsonp(
    await fetch(withToken(page.contentUrl, token), { cache: "no-store" }).then(assertOk).then(r => r.text())
  );
  const doc = new DOMParser().parseFromString(html, "text/html");
  const images = [...doc.querySelectorAll("img[orig], img[src]")];
  const texts = await extractTextFragments(html, styleText, page);
  if (!images.length && !texts.length) throw new Error("No image or built-in text data was found.");

  const canvas = new OffscreenCanvas(page.width, page.height);
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, page.width, page.height);
  const cache = new Map();

  for (const element of images) {
    const assetUrl = normalizeAssetUrl(element.getAttribute("orig") || element.getAttribute("src"));
    let bitmap = cache.get(assetUrl);
    if (!bitmap) {
      const blob = await fetch(withToken(assetUrl, token), { cache: "force-cache" }).then(assertOk).then(r => r.blob());
      bitmap = await createImageBitmap(blob);
      cache.set(assetUrl, bitmap);
    }
    drawClippedImage(ctx, bitmap, element);
  }
  for (const bitmap of cache.values()) bitmap.close();

  drawVisibleText(ctx, texts);
  const jpeg = await canvas.convertToBlob({ type: "image/jpeg", quality });
  return { width: page.width, height: page.height, bytes: new Uint8Array(await jpeg.arrayBuffer()), texts };
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
  style.textContent = `${styleText || ""}\n.newpage{position:relative!important;margin:0!important;} .text_layer{transform-origin:top left!important;}`;
  const container = document.createElement("div");
  container.innerHTML = html;
  shadow.append(style, container);

  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 1200))]);

  const pageElement = shadow.querySelector(".newpage") || container.firstElementChild;
  const textLayer = shadow.querySelector(".text_layer");
  if (!pageElement || !textLayer) {
    host.remove();
    return [];
  }

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
      writingMode: computed.writingMode || "horizontal-tb"
    });
  }
  host.remove();
  return fragments;
}

function drawVisibleText(ctx, fragments) {
  for (const fragment of fragments) {
    const size = Math.max(1, fragment.height * 0.9);
    ctx.save();
    ctx.fillStyle = fragment.color;
    ctx.font = `${fragment.style} ${fragment.weight} ${size}px ${fragment.family}`;
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
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${response.url}`);
  return response;
}

async function retry(action, attempts) {
  let last;
  for (let n = 0; n < attempts; n++) {
    try { return await action(); }
    catch (error) {
      last = error;
      if (n + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 500 * 2 ** n));
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
