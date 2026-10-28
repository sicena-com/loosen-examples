// Page furniture shared by every example: header, theme switch, title/lead/guide link, preset buttons and the "Source" block.
// Nothing here is part of the Loosen integration; the integration is the script with id="code" in each page, which this file
// shows verbatim in the Source block.
const base = new URL("../", import.meta.url);                       // the root of the examples, whichever server serves them
const GUIDE = "https://loosen.sicena.com/docs/install";
const PAGES = [
  ["examples/client-module.html", "1 Client mode, ES module"], ["examples/classic-script.html", "2 Classic script"],
  ["examples/form-fromform.html", "3 fromForm"], ["examples/by-hand.html", "4 By hand"], ["examples/facets-state.html", "5 Facet state"],
  ["examples/react.html", "6 React"], ["examples/server.html", "8 Server mode"], ["examples/playground.html", "9 Playground"],
];
const el = (tag, attrs = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), attrs);
  e.append(...kids.filter(k => k != null));
  return e;
};

// ---- theme: light/dark follows the system; the button overrides it for this browser ----
const stored = () => { try { return localStorage.getItem("loosen-examples-theme"); } catch { return null; } };
const setTheme = t => { try { localStorage.setItem("loosen-examples-theme", t); } catch { /* storage blocked: the choice lasts for this page */ } document.documentElement.dataset.theme = t; };
if (stored()) document.documentElement.dataset.theme = stored();

// ---- header ----
const body = document.body, d = body.dataset;
const header = el("header", {className: "site"});
const nav = el("nav", {"aria-label": "Examples"});
nav.append(el("a", {href: new URL("index.html", base).href, className: "brand"}, "Loosen examples"));
for (const [path, label] of PAGES) {
  const a = el("a", {href: new URL(path, base).href}, label);
  if (location.pathname.endsWith(path)) a.setAttribute("aria-current", "page");
  nav.append(a);
}
// config.js sets LOOSEN_SHOP and LOOSEN_SERVER. Relative values are resolved against the root of the examples, so the hosted demo (served under
// https://loosen.sicena.com/demo/) says "shop/" and "api"; a local run uses the ports 8124 and 8130.
const shopLink = el("a", {href: new URL(window.LOOSEN_SHOP ?? "http://localhost:8124/", base).href}, "7 URL shop");
const shopUrl = new URL(shopLink.href, location.href);
if (location.host === shopUrl.host && location.pathname === shopUrl.pathname) shopLink.setAttribute("aria-current", "page");
nav.insertBefore(shopLink, nav.children[7]);
const toggle = el("button", {type: "button", className: "theme", title: "Light / dark", "aria-label": "Switch light/dark theme"}, "Theme");
toggle.onclick = () => setTheme((document.documentElement.dataset.theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark" ? "light" : "dark");
header.append(nav, toggle);
body.prepend(header);

// ---- title, lead, guide link ----
const main = document.querySelector("main");
if (d.title && main) {
  const intro = el("section", {className: "intro"}, el("h1", {}, d.title));
  if (d.lead) intro.append(el("p", {className: "lead"}, d.lead));
  if (d.guide) intro.append(el("p", {className: "guide"}, "Guide: ", el("a", {href: `${GUIDE}#${d.guide}`, target: "_blank", rel: "noopener"}, d.guideLabel ?? d.guide)));
  main.prepend(intro);
}

// ---- presets: <button data-preset='{"max_rent":"400","furnished":"0"}' data-form="filters"> fills a form and fires "input" ----
document.addEventListener("click", ev => {
  const preset = ev.target.closest?.("[data-preset]");
  if (preset) {
    const form = document.getElementById(preset.dataset.form ?? "filters");
    const values = JSON.parse(preset.dataset.preset);
    for (const field of form.elements) {
      if (!field.name) continue;
      const v = values[field.name];
      if (field.type === "checkbox") field.checked = Array.isArray(v) ? v.includes(field.value) : v === true || v === field.value;
      else if (field.type === "radio") field.checked = v != null && String(v) === field.value;
      else if (field.tagName === "SELECT" && field.multiple) for (const o of field.options) o.selected = Array.isArray(v) && v.includes(o.value);
      else field.value = v ?? "";
    }
    form.dispatchEvent(new Event("input", {bubbles: true}));
    if (preset.dataset.minItems) {                                  // a preset can also set "Suggest changes when fewer than N results"
      if (window.setReactMinItems) window.setReactMinItems(Number(preset.dataset.minItems));
      const box = document.getElementById("min-items");
      if (box && !window.setReactMinItems) { box.value = preset.dataset.minItems; box.dispatchEvent(new Event("change", {bubbles: true})); }
    }
  }
  const clear = ev.target.closest?.("[data-clear]");                // a "clear" button next to a yes/no radio pair
  if (clear) {
    const form = clear.closest("form");
    form.querySelectorAll(`[name="${clear.dataset.clear}"]`).forEach(r => { r.checked = false; });
    form.dispatchEvent(new Event("input", {bubbles: true}));
  }
});

// ?preset=minItems opens a page with the "one match, at least 3 results" search already done (the button marked data-min-items / #preset-c)
if (new URLSearchParams(location.search).get("preset") === "minItems") {
  const timer = setInterval(() => {                               // wait until the page's script has mounted the widget
    if (!document.getElementById("loosen")?.children.length) return;
    clearInterval(timer);
    (document.querySelector("button[data-min-items]") ?? document.getElementById("preset-c"))?.click();
  }, 100);
}

// ---- Source block ----
async function text(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.text(); }
const dedent = s => { const lines = s.replace(/^\n+|\s+$/g, "").split("\n"); const pad = Math.min(...lines.filter(l => l.trim()).map(l => l.match(/^ */)[0].length)); return lines.map(l => l.slice(pad)).join("\n"); };
const code = document.getElementById("code");
if (main && code) {
  const details = el("details", {className: "source", id: "source"}, el("summary", {}, "Source: the code that integrates the widget"));
  const add = (title, content, link) => details.append(el("h3", {}, title, link ? el("a", {href: link, className: "small"}, " (open file)") : null), el("pre", {}, el("code", {}, content)));
  for (const node of document.querySelectorAll("[data-source]")) add(node.dataset.source, dedent(node.tagName === "TEMPLATE" ? node.innerHTML : node.outerHTML));
  add("This page's script", dedent(code.textContent));
  for (const file of (d.sourceExtra ?? "").split(/\s+/).filter(Boolean)) {
    try { add(file, await text(new URL(file, base)), new URL(file, base).href); } catch (e) { add(file, `(could not load: ${e.message})`); }
  }
  main.append(details);
}
if (!("LOOSEN_LICENCE" in window)) console.info("config.js not loaded: the widget runs unlicensed (copy config.example.js to config.js)");
document.dispatchEvent(new Event("chrome-ready"));
