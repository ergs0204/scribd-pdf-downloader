// The same prepareJob -> runJob -> makePdf pipeline as the extension, with only
// network transport and browser Save replaced by a loopback test server.
const originalFetch = window.fetch.bind(window);
window.fetch = (input, options) => {
  let url = new URL(String(input), location.href);
  if (url.origin === location.origin && /^\/(document|embeds)\//.test(url.pathname)) {
    url = new URL(url.pathname + url.search, "https://www.scribd.com");
  }
  if (url.origin !== location.origin) {
    return originalFetch(`/proxy?url=${encodeURIComponent(url.href)}`, options);
  }
  return originalFetch(url.href, options);
};
window.chrome = {runtime:{
  onMessage:{addListener(){}},
  async sendMessage(message){
    if(message.type === "progress-update") {
      document.querySelector("#status").textContent = message.update.message;
      return {ok:true};
    }
    if(message.type === "save-pdf") {
      const blob = await originalFetch(message.url).then(r=>r.blob());
      return originalFetch("/save?name=full-export.pdf",{method:"POST",body:blob}).then(r=>r.json());
    }
    return {ok:true};
  }
}};

async function runFullExport() {
  try {
    const fixture = await originalFetch("/fixture").then(r=>r.json());
    const parsed = new DOMParser().parseFromString(fixture.preview,"text/html");
    const root = document.querySelector("#fixture");
    for(const page of parsed.querySelectorAll(".newpage")) {
      const cloned = page.cloneNode(true);
      if(new URLSearchParams(location.search).has("zoom")) cloned.style.transform="scale(0.757206)";
      root.append(cloned);
    }
    // Scribd's live font-loader adds these rules dynamically. Keep them in the
    // live DOM so prepareJob must retain them, just as on the official page.
    const liveStyle = document.createElement("style");
    const fonts = [...fixture.preview.matchAll(/docManager\.addFont\(\s*\d+\s*,\s*"[^"]*"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/g)];
    liveStyle.textContent = fonts.map(m=>`div.${m[1]} span{font-family:${m[1]},${m[2]};font-weight:${m[3]};font-style:${m[4]}}`).join("\n");
    document.head.append(liveStyle);
    const prefix = fixture.preview.match(/docManager\.assetPrefix\s*=\s*"([^"]+)"/)[1];
    const ids = fonts.map(m=>(m[3] === "bold" ? "b" : "") + (m[4] === "italic" ? "i" : "") + m[0].match(/addFont\(\s*(\d+)/)[1]).sort();
    const link = document.createElement("link");
    link.rel="stylesheet";
    link.href=`https://html.scribdassets.com/${prefix}/${ids.join(',')}/12/ttfs.css`;
    if(!new URLSearchParams(location.search).has("cold")) root.append(link);
    const job = await prepareJob();
    window.__preparedJob = job;
    document.querySelector("#details").textContent=JSON.stringify({pages:job.pages.length,fontStylesheets:job.fontStylesheets.length,containsFontFamilyRules:/div\.ff6\s+span/.test(job.styleText)},null,2);
    await runJob(job);
    document.body.dataset.done="true";
  } catch(error) {
    document.querySelector("#status").textContent=`FAIL: ${error.message.replace(/token=[^&\s]+/g,'token=<REDACTED>')}`;
    document.body.dataset.done="true";
    document.body.dataset.error="true";
  }
}
