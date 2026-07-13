// ../../packages/protocol/dist/version.js
var PROVIDER_GLOBAL = "claude";

// ../../packages/sdk/dist/index.js
var Relay = class {
  provider;
  constructor(provider) {
    this.provider = provider;
  }
  get version() {
    return this.provider.version;
  }
  capabilities() {
    return this.provider.request({ method: "claude_capabilities" });
  }
  connect(scope) {
    return this.provider.request({ method: "claude_connect", params: scope });
  }
  /** Drop this app's connection for the current page session. The grant persists (a later connect()
   *  won't reprompt) — this is "disconnect from this tab", not "revoke". Full revoke lives in the panel. */
  disconnect() {
    return this.provider.request({ method: "claude_disconnect" });
  }
  permissions() {
    return this.provider.request({ method: "claude_permissions" });
  }
  /** The paired user's public identity (name/avatar), or null if unavailable. Convenience over
   *  capabilities().user — what the connect chip greets with ("Hi Sameep"). */
  identity() {
    return this.capabilities().then((c) => c.user ?? null).catch(() => null);
  }
  /** Synthesize speech ON-DEVICE via a local model/engine (no cloud, no connector, no credits).
   *  Returns audio as a playable data: URL, or null if no local TTS is available.
   *
   *    const clip = await relay.speak("hey, it's Maya");
   *    if (clip) new Audio(clip.audio).play();
   */
  speak(text, opts) {
    return this.provider.request({ method: "claude_speak", params: { text, voice: opts?.voice } }).catch(() => null);
  }
  listTools() {
    return this.provider.request({ method: "claude_listTools" }).then((r) => r.tools);
  }
  callTool(name, args) {
    const call = { name, arguments: args };
    return this.provider.request({ method: "claude_callTool", params: call });
  }
  complete(params) {
    return this.provider.request({ method: "claude_complete", params });
  }
  /** Streamed completion as an async iterator of deltas. Ends after a `done`/`error` delta. */
  async *stream(params) {
    const { streamId } = await this.provider.request({ method: "claude_stream", params });
    const queue = [];
    let notify = null;
    let ended = false;
    const handler = (payload) => {
      const p = payload;
      if (p.streamId !== streamId)
        return;
      queue.push(p);
      if (p.type === "done" || p.type === "error")
        ended = true;
      notify?.();
    };
    this.provider.on("delta", handler);
    try {
      while (true) {
        if (queue.length === 0) {
          if (ended)
            break;
          await new Promise((r) => notify = r);
          notify = null;
          continue;
        }
        yield queue.shift();
      }
    } finally {
      this.provider.removeListener("delta", handler);
    }
  }
  on(event, handler) {
    this.provider.on(event, handler);
  }
  /**
   * Per-origin local storage — a private on-disk key/value store for this app, plus `bind` to point
   * it at a real folder the user picks. Values are opaque strings (store JSON). Isolated per origin;
   * reads are free, writes need the site not to be read-only, and `bind` prompts for the exact path.
   *
   *   await relay.storage.set("workspace", JSON.stringify(data));
   *   const raw = await relay.storage.get("workspace");
   *   await relay.storage.bind("~/Documents/Projects/brandbrain/.data"); // existing files appear as records
   */
  get storage() {
    const req = (params) => this.provider.request({ method: "claude_storage", params });
    return {
      get: (key) => req({ op: "get", key }).then((r) => r.value ?? null),
      set: (key, value) => req({ op: "set", key, value }).then(() => void 0),
      delete: (key) => req({ op: "delete", key }).then((r) => r.ok),
      list: () => req({ op: "list" }).then((r) => r.keys ?? []),
      info: () => req({ op: "info" }).then((r) => r.info),
      /** Point this app's store at a real folder (triggers a path-consent click). */
      bind: (path) => req({ op: "bind", path }).then((r) => r.info)
    };
  }
  /**
   * Shared, cross-app context — your portable brand knowledge. Publish a whole context; read the one
   * the user selected for this app; or open the picker. Selection happens in the side panel, so an
   * app only ever receives the context the user chose to lend it — never the whole library.
   *
   *   await relay.context.publish({ name: "Aamras", kind: "brand", data: brand });
   *   const active = await relay.context.active();   // the brand the user loaded for this app, or null
   */
  get context() {
    const req = (params) => this.provider.request({ method: "claude_context", params });
    return {
      publish: (context) => req({ op: "publish", context }).then((r) => r.id),
      list: () => req({ op: "list" }).then((r) => r.contexts ?? []),
      active: () => req({ op: "active" }).then((r) => r.context ?? null),
      pick: () => req({ op: "pick" }).then((r) => r.context ?? null),
      /** Read ONE context listed via `list()` in full, and make it this app's selection. Needs the
       *  kind granted at connect (ScopeRequest.contextKinds) — powers in-app brand dropdowns. */
      use: (id) => req({ op: "use", id }).then((r) => r.context ?? null)
    };
  }
};
var DEFAULT_INSTALL_URL = "https://thelastprompt.ai/switchboard/";
function getRelay(opts) {
  const provider = globalThis[PROVIDER_GLOBAL];
  if (provider?.isRelay)
    return new Relay(provider);
  return { installed: false, installUrl: opts?.installUrl ?? DEFAULT_INSTALL_URL };
}
function whenRelayReady(timeoutMs = 3e3, opts) {
  const now = getRelay(opts);
  if (now instanceof Relay)
    return Promise.resolve(now);
  return new Promise((resolve) => {
    const onInit = () => {
      cleanup();
      resolve(getRelay(opts));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve({ installed: false, installUrl: opts?.installUrl ?? DEFAULT_INSTALL_URL });
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      window.removeEventListener(`${PROVIDER_GLOBAL}#initialized`, onInit);
    }
    window.addEventListener(`${PROVIDER_GLOBAL}#initialized`, onInit);
  });
}

// src/imagegen.js
var $ = (id) => document.getElementById(id);
var CONNECTOR = "mcp__claude_ai_Higgsfield__*";
var GEN = "generate_image";
var DEFAULT_STYLES = ["editorial minimal", "vibrant maximal", "matte product studio", "lifestyle candid", "bold graphic", "soft pastel"];
var relay = null;
var referenceDataUrl = null;
var brand = null;
var el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
async function onConnected(r, models) {
  relay = r;
  $("go").disabled = false;
  $("connect").hidden = true;
  setStatus(`Connected \xB7 ${models?.join(", ") || "your Claude"}`, true);
  $("note").textContent = "Load a brand to generate on-brand, or just describe an image. Each generation is a per-action consent.";
  await loadBrandContext();
}
function becomeInstallButton(installUrl) {
  setStatus("Switchboard not installed");
  const b = $("connect");
  b.textContent = "Get Switchboard \u2197";
  b.onclick = () => window.open(installUrl, "_blank", "noreferrer");
}
$("connect").addEventListener("click", async () => {
  const r = await whenRelayReady();
  if (!("connect" in r)) {
    becomeInstallButton(r.installUrl);
    return;
  }
  try {
    const grant = await r.connect({ reason: "Prism \u2014 generate on-brand images with Higgsfield", tools: [CONNECTOR], contextKinds: ["brand"] });
    await onConnected(r, grant.models);
  } catch (err) {
    setStatus(`Connect rejected (${err?.code ?? "?"})`);
  }
});
(async () => {
  const r = await whenRelayReady(2e3);
  if (!("connect" in r)) {
    becomeInstallButton(r.installUrl);
    return;
  }
  const grant = await r.permissions().catch(() => null);
  if (grant) await onConnected(r, grant.models);
})();
function setStatus(text, connected) {
  const s = $("status");
  s.hidden = false;
  $("statusText").textContent = text;
  s.querySelector(".glyph").style.background = connected ? "#3DD68C" : "#9C9AA3";
}
var brandOptions = [];
async function loadBrandContext() {
  try {
    const [ctx, metas] = await Promise.all([
      relay.context.active(),
      relay.context.list().catch(() => [])
    ]);
    brandOptions = (metas || []).filter((m) => (m.kind || "").toLowerCase() === "brand").map((m) => ({ id: m.id, name: m.name }));
    if (brandOptions.length) renderBrandSelect(ctx);
    if (ctx) applyBrand(ctx);
    else if (!brandOptions.length) revealLoadButton("Load brand");
  } catch {
    revealLoadButton("Load brand");
  }
}
function renderBrandSelect(active) {
  $("brandbar").hidden = false;
  let sel = document.getElementById("brandSel");
  if (!sel) {
    sel = document.createElement("select");
    sel.id = "brandSel";
    sel.className = "bchange";
    $("loadBrand").before(sel);
    sel.addEventListener("change", async () => {
      if (!relay || !sel.value) return;
      sel.disabled = true;
      try {
        const ctx = await relay.context.use(sel.value);
        if (ctx) applyBrand(ctx);
      } finally {
        sel.disabled = false;
      }
    });
  }
  sel.textContent = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "brand reference\u2026";
  sel.append(none);
  for (const b of brandOptions) {
    const o = document.createElement("option");
    o.value = b.id;
    o.textContent = b.name;
    if (active && active.id === b.id) o.selected = true;
    sel.append(o);
  }
  $("loadBrand").hidden = true;
}
function revealLoadButton(label) {
  const b = $("loadBrand");
  b.hidden = false;
  b.textContent = label;
  $("brandbar").hidden = false;
  $("brandFields").hidden = true;
  $("bchip").hidden = true;
}
$("loadBrand").addEventListener("click", async () => {
  if (!relay) return;
  const prev = $("loadBrand").textContent;
  $("loadBrand").textContent = "Choose in Switchboard\u2026";
  $("loadBrand").disabled = true;
  try {
    const ctx = await relay.context.pick();
    if (ctx) applyBrand(ctx);
    else {
      $("loadBrand").textContent = prev;
    }
  } finally {
    $("loadBrand").disabled = false;
  }
});
function normalizeBrand(ctx) {
  const d = ctx && ctx.data || {};
  const arr = (v) => Array.isArray(v) ? v.filter(Boolean).map(String) : [];
  const products = arr(d.products).length ? arr(d.products) : arr(d.range);
  const styles = arr(d.styles).length ? arr(d.styles) : DEFAULT_STYLES;
  return {
    name: ctx.name || d.name || "Brand",
    voice: String(d.voice || d.vibe || d.positioning || "").trim(),
    palette: arr(d.palette),
    products,
    styles
  };
}
function applyBrand(ctx) {
  brand = normalizeBrand(ctx);
  $("brandbar").hidden = false;
  $("brandFields").hidden = false;
  const chip = $("bchip");
  chip.hidden = false;
  chip.textContent = "";
  chip.append(el("span", "dot"), el("span", null, brand.name));
  if (brand.palette.length) for (const c of brand.palette.slice(0, 4)) {
    const sw = el("span", "sw");
    sw.style.background = c;
    chip.append(sw);
  }
  fillSelect($("product"), brand.products, brand.products.length ? null : "\u2014 brand has no products \u2014");
  fillSelect($("style"), brand.styles);
  if (document.getElementById("brandSel")) $("loadBrand").hidden = true;
  else {
    $("loadBrand").textContent = "Change brand";
    $("loadBrand").hidden = false;
  }
  $("prompt").placeholder = "Add art direction (optional) \u2014 e.g. on a marble surface, morning light";
  $("note").textContent = `Generating on-brand for ${brand.name}. Pick a product + style; Prism folds in the brand's voice and palette.`;
}
function fillSelect(sel, items, emptyLabel) {
  sel.textContent = "";
  if (!items.length && emptyLabel) {
    sel.append(new Option(emptyLabel, ""));
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  for (const it of items) sel.append(new Option(it, it));
}
function buildPrompt() {
  const extra = $("prompt").value.trim();
  if (!brand) return extra;
  const product = $("product").value.trim();
  const style = $("style").value.trim();
  return [
    product ? `${product} for ${brand.name}` : `${brand.name} brand image`,
    style ? `${style} style` : "",
    brand.voice ? `brand voice: ${brand.voice}` : "",
    brand.palette.length ? `brand palette: ${brand.palette.join(", ")}` : "",
    extra
  ].filter(Boolean).join(". ");
}
$("refBtn").addEventListener("click", () => $("refInput").click());
$("refInput").addEventListener("change", () => {
  const file = $("refInput").files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    referenceDataUrl = String(reader.result);
    showThumb(referenceDataUrl);
  };
  reader.readAsDataURL(file);
});
function showThumb(dataUrl) {
  const ref = $("ref");
  ref.textContent = "";
  ref.append($("refInput"));
  const thumb = el("div", "refthumb");
  const img = el("img");
  img.src = dataUrl;
  img.alt = "reference";
  const x = el("button", "x", "\xD7");
  x.title = "Remove reference";
  x.onclick = () => {
    referenceDataUrl = null;
    ref.textContent = "";
    ref.append($("refInput"), refButton());
  };
  thumb.append(img, x);
  ref.append(thumb);
}
function refButton() {
  const b = el("button", "refbtn", "\uFF0B Reference image");
  b.id = "refBtn";
  b.onclick = () => $("refInput").click();
  return b;
}
var URL_RE = /(https?:\/\/[^\s"')]+\.(?:png|jpe?g|webp))|"(?:rawUrl|url|minUrl)"\s*:\s*"([^"]+)"/i;
function extractUrl(text) {
  const m = text.match(URL_RE);
  return m ? m[1] || m[2] || m[0] : null;
}
async function downscale(dataUrl, max = 1024) {
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = dataUrl;
  });
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d").drawImage(img, 0, 0, w, h);
  return c.toDataURL("image/png");
}
$("go").addEventListener("click", async () => {
  if (!relay) return;
  const prompt = buildPrompt();
  if (!prompt) return;
  const card = el("div", "shot load");
  card.append(el("div", "scan"), el("div", "cap", referenceDataUrl ? "uploading reference\u2026" : "generating\u2026"));
  $("grid").prepend(card);
  let attachments;
  let instruction;
  if (referenceDataUrl) {
    const small = await downscale(referenceDataUrl);
    attachments = [{ handle: "ref", filename: "ref.png", contentType: "image/png", dataUrl: small }];
    instruction = `Generate an image of: "${prompt}", aspect_ratio "${$("aspect").value}", guided by a reference image.
The reference is attached as relay handle "ref". To use it, do EXACTLY:
1) Call Higgsfield media_upload({ filename: "ref.png", content_type: "image/png" }) to get a presigned upload URL.
2) Call relay put_blob({ handle: "ref", url: <that upload URL> }) to upload the bytes (do NOT use bash/curl).
3) Call Higgsfield media_confirm as instructed by the upload result to get a media_id.
4) Call Higgsfield ${GEN} with the prompt and that media_id as a reference in medias.
5) Poll job status until done, then reply with ONLY the final image URL on its own line.`;
  } else {
    instruction = `Use the Higgsfield ${GEN} tool to generate an image of: "${prompt}", aspect_ratio "${$("aspect").value}". Wait for it to finish (poll the job status if needed), then reply with ONLY the final image URL on its own line.`;
  }
  let url = null, acc = "";
  try {
    for await (const d of relay.stream({ prompt: instruction, agentic: true, attachments })) {
      if (d.type === "tool_proposed") {
        const n = d.call.name;
        if (n.endsWith("media_upload") || n.endsWith("put_blob") || n.endsWith("media_confirm")) status(card, "uploading reference\u2026");
        else if (n.endsWith(GEN)) status(card, "generating\u2026");
        else if (/status|display|wait/.test(n)) status(card, "rendering\u2026");
      } else if (d.type === "tool_result" && d.result?.ok) {
        const t = (d.result.content ?? []).map((c) => c.text ?? "").join("");
        url = extractUrl(t) || url;
      } else if (d.type === "text") {
        acc += d.text;
      } else if (d.type === "error") {
        return fail(card, `Blocked: ${d.error.message}`);
      }
    }
    url = url || extractUrl(acc);
    if (!url) return fail(card, "No image came back.");
    card.className = "shot";
    card.textContent = "";
    const img = el("img");
    img.src = url;
    img.alt = prompt;
    img.loading = "lazy";
    card.append(img, el("div", "cap", prompt));
  } catch (err) {
    fail(card, `Failed (${err?.code ?? "?"})`);
  }
});
function status(card, text) {
  const c = card.querySelector(".cap");
  if (c) c.textContent = text;
  else card.append(el("div", "cap", text));
}
function fail(card, msg) {
  card.className = "shot";
  card.textContent = "";
  const c = el("div", "cap", msg);
  c.style.color = "#c0392b";
  card.append(c);
}
//# sourceMappingURL=imagegen.js.map
