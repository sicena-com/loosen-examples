// Smoke test of every example with Playwright (Chromium).
//
//   NODE_PATH=/path/to/node_modules node test/smoke.mjs        (any node_modules folder that has `playwright` and a Chromium)
//   ./serve.sh --with-server  must be running (DETACH=1 ./serve.sh --with-server), or set BASE / SHOP / LOOSEND.
//   The hosted demo:   BASE_URL=https://loosen.sicena.com/demo node test/smoke.mjs
//     BASE_URL sets BASE, the shop is at $BASE_URL/shop, loosend is reached through $BASE_URL/api (loosend itself is not reachable, and
//     that is checked: its /health and admin routes must NOT answer). The hosted demo has a licence key, so the "Unlicensed copy" note
//     must be absent (LICENSED=0 / LICENSED=1 override the default: unlicensed for a local run, licensed with BASE_URL).
//
// Checks per page: no console error, no page error, no failed request; a conflicting search shows the panel with chips and counts;
// a chip updates the filters and the result list; Undo restores them; hover highlights the fields (fromForm).
import {createRequire} from "node:module";
const require = createRequire(import.meta.url);        // CommonJS resolution honours NODE_PATH, ES imports do not
const {chromium} = require("playwright");

const HOSTED = !!process.env.BASE_URL;
const BASE = (process.env.BASE_URL ?? process.env.BASE ?? "http://localhost:8123").replace(/\/$/, "");
const SHOP = (process.env.SHOP ?? (HOSTED ? `${BASE}/shop` : "http://localhost:8124")).replace(/\/$/, "");
const LOOSEND = HOSTED ? null : (process.env.LOOSEND ?? "http://localhost:8130");   // hosted: loosend is private, only $BASE/api/... explain is public
const LICENSED = (process.env.LICENSED ?? (HOSTED ? "1" : "0")) === "1";
const READ_KEY = process.env.READ_KEY ?? "examples-read-key";

const results = [];
const check = (name, ok, detail = "") => { results.push({name, ok}); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + detail}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch();
async function open(url, {allowErrors = false, route} = {}) {
  const context = await browser.newContext({viewport: {width: 1280, height: 900}});
  const page = await context.newPage();
  page.problems = [];
  page.on("console", m => { if (m.type() === "error") page.problems.push(`console: ${m.text()}`); });
  page.on("pageerror", e => page.problems.push(`pageerror: ${e.message}`));
  page.on("requestfailed", r => page.problems.push(`requestfailed: ${r.url()}`));
  page.on("response", r => { if (r.status() >= 400) page.problems.push(`HTTP ${r.status()}: ${r.url()}`); });
  if (route) await route(page);
  await page.goto(url, {waitUntil: "networkidle"});
  page.context_ = context;
  return page;
}
const chips = page => page.locator("#loosen .panel > .chips > button.chip");   // the global chips (the ones under "Why?" have no count)
const countText = page => page.locator("#count").innerText();
const countNumber = async page => parseInt(await countText(page), 10);
const noProblems = (page, name) => check(`${name}: no console/page/network errors`, page.problems.length === 0, page.problems.join(" | "));
async function waitChips(page) { await chips(page).first().waitFor({timeout: 5000}); }

// The common flow of the form-like pages: preset -> panel with counts -> chip -> filters changed -> Undo restores.
async function flow(page, name, {presetIndex = 0, filterField = "max_rent", expectUnlicensed = true} = {}) {
  await page.locator("button[data-preset]").nth(presetIndex).click();
  await waitChips(page);
  const n = await chips(page).count();
  const labels = await chips(page).allInnerTexts();
  check(`${name}: conflicting search shows ${n} chips with result counts`, n >= 1 && labels.every(l => /\d+ results?/.test(l)), labels.join(" / "));
  check(`${name}: the result list is empty before the click`, (await countNumber(page)) === 0, await countText(page));
  if (expectUnlicensed) check(`${name}: "Unlicensed copy" note ${LICENSED ? "absent with the licence" : "shown without a licence"}`, (await page.locator("#loosen .unlicensed").count()) === (LICENSED ? 0 : 1));
  const before = await page.evaluate(() => JSON.stringify([...new FormData(document.getElementById("filters"))]));
  await chips(page).first().hover();
  await sleep(250);
  const marked = await page.locator("[data-loosen-preview]").count();
  await chips(page).first().click();
  await page.locator("#loosen .undo button").waitFor({timeout: 5000});
  const after = await page.evaluate(() => JSON.stringify([...new FormData(document.getElementById("filters"))]));
  check(`${name}: a chip click changes the filters`, before !== after, `${before} == ${after}`);
  check(`${name}: the result list is refreshed (${await countNumber(page)} apartments)`, (await countNumber(page)) > 0);
  check(`${name}: "Applied" line and Undo button appear`, /Applied/.test(await page.locator("#loosen .undo").innerText()));
  await page.locator("#loosen .undo button").click();
  await waitChips(page);
  const restored = await page.evaluate(() => JSON.stringify([...new FormData(document.getElementById("filters"))]));
  check(`${name}: Undo restores the filters and the panel returns`, restored === before && (await countNumber(page)) === 0, `${before} vs ${restored}`);
  return marked;
}

// ---- 0. landing ----
{
  const page = await open(`${BASE}/`);
  check("index: 9 variant cards", (await page.locator("ul.cards > li").count()) === 9);
  check("index: header navigation present", (await page.locator("header.site nav a").count()) >= 9);
  noProblems(page, "index");
  await page.context_.close();
}

// ---- 1. client mode, ES module: array, URL, async function ----
for (const mode of ["array", "url", "function"]) {
  const page = await open(`${BASE}/examples/client-module.html?data=${mode}`);
  await flow(page, `client-module (data as ${mode})`, {presetIndex: 0});
  check(`client-module (data as ${mode}): Source block shows the page script`, (await page.locator("details.source pre").evaluateAll(els => els.map(e => e.textContent))).some(t => t.includes("mount(") && t.includes("fromForm")));
  noProblems(page, `client-module (${mode})`);
  await page.context_.close();
}

// ---- 2. classic script ----
{
  const page = await open(`${BASE}/examples/classic-script.html`);
  check("classic-script: window.Loosen exists, no module needed", await page.evaluate(() => typeof window.Loosen?.mount === "function"));
  await flow(page, "classic-script", {presetIndex: 1});
  noProblems(page, "classic-script");
  await page.context_.close();
}

// ---- 3. fromForm, the thesis form: both conflicting searches of the brief ----
for (const [i, label] of [[0, "rent<=400, furnished=no, metro=yes"], [1, "rent<=600, centre<=5, parking=yes"]]) {
  const page = await open(`${BASE}/examples/form-fromform.html`);
  const marked = await flow(page, `fromForm (${label})`, {presetIndex: i});
  check(`fromForm (${label}): hovering a chip marks the fields (data-loosen-preview)`, marked > 0, String(marked));
  if (i === 0) noProblems(page, "fromForm");
  await page.context_.close();
}
{ // the 'adapt' chip writes the new bound into the number field
  const page = await open(`${BASE}/examples/form-fromform.html`);
  await page.locator("button[data-preset]").nth(1).click(); await waitChips(page);
  const adapt = chips(page).filter({hasText: "Rent ≤"}).first();
  if (await adapt.count()) {
    const old = await page.locator("[name=max_rent]").inputValue();
    await adapt.click();
    check("fromForm: an adapted chip writes the new bound into the rent field", (await page.locator("[name=max_rent]").inputValue()) !== old);
  } else check("fromForm: an adapted rent chip exists for search B", false, (await chips(page).allInnerTexts()).join(" / "));
  await page.context_.close();
}

// ---- 4. by hand ----
{
  const page = await open(`${BASE}/examples/by-hand.html`);
  const marked = await flow(page, "by-hand", {presetIndex: 0});
  check("by-hand: onPreview written by hand highlights the controls", marked > 0);
  noProblems(page, "by-hand");
  await page.context_.close();
}

// ---- 5. facet state object ----
{
  const page = await open(`${BASE}/examples/facets-state.html`);
  await page.locator("#preset-a").click(); await waitChips(page);
  check("facets: conflicting facets show chips with counts", /\d+ results?/.test(await chips(page).first().innerText()));
  const before = await page.evaluate(() => [...document.querySelectorAll("#facets input")].map(i => i.checked + ":" + i.value).join());
  await chips(page).first().click();
  await page.locator("#loosen .undo button").waitFor();
  const after = await page.evaluate(() => [...document.querySelectorAll("#facets input")].map(i => i.checked + ":" + i.value).join());
  check("facets: a chip updates the state and the facet UI", before !== after && (await countNumber(page)) > 0);
  await page.locator("#loosen .undo button").click(); await waitChips(page);
  const restored = await page.evaluate(() => [...document.querySelectorAll("#facets input")].map(i => i.checked + ":" + i.value).join());
  check("facets: Undo restores the state", restored === before && (await countNumber(page)) === 0);
  await page.locator("#facets input[data-group=town]").first().check();   // the visitor's own change goes through update()
  await sleep(300);
  check("facets: the visitor's own facet change re-analyses", (await page.locator("#results .count").innerText()).length > 0);
  noProblems(page, "facets");
  await page.context_.close();
}

// ---- 6. React ----
{
  const page = await open(`${BASE}/examples/react.html`);
  check("react: React 18 and ReactDOM are loaded from vendor/", await page.evaluate(() => /^18\./.test(React.version) && typeof ReactDOM.createRoot === "function"));
  await page.locator("#preset-a").click(); await waitChips(page);
  check("react: conflicting filters show chips with counts", /\d+ results?/.test(await chips(page).first().innerText()));
  check("react: one panel only (no double mount)", (await page.locator("#loosen > div").count()) === 1);
  const rentBefore = await page.locator("[name=max_rent]").inputValue();
  await page.locator("#preset-b").click(); await sleep(300); await waitChips(page);
  const adapt = chips(page).filter({hasText: "Rent ≤"}).first();
  if (await adapt.count()) { await adapt.click(); await sleep(300); check("react: an adapted chip writes the new bound into the React state (input changes)", (await page.locator("[name=max_rent]").inputValue()) !== "600"); }
  await page.locator("#preset-a").click(); await waitChips(page);
  await chips(page).first().click();
  await page.locator("#loosen .undo button").waitFor(); await sleep(200);
  check("react: chip click re-renders the app and the list", (await countNumber(page)) > 0);
  await page.locator("#loosen .undo button").click(); await waitChips(page);
  check("react: Undo restores the React state", (await page.locator("[name=max_rent]").inputValue()) === rentBefore || (await page.locator("[name=max_rent]").inputValue()) === "400");
  await page.locator("[name=max_rent]").fill("5000"); await sleep(400);
  check("react: typing a loose filter hides the panel", (await chips(page).count()) === 0);
  noProblems(page, "react");
  await page.context_.close();
}

// ---- 7. server-rendered shop, filters in the URL ----
{
  const page = await open(`${SHOP}/?max_price=400&metro=1&parking=1`);
  check("shop: server-rendered '0 apartments' for the conflicting URL", (await countNumber(page)) === 0);
  await waitChips(page);
  check("shop: the widget reads the filters from location.search and shows chips with counts", /\d+ results?/.test(await chips(page).first().innerText()));
  check("shop: no Undo button (the page reloads; Back is the Undo)", (await page.locator("#loosen .undo button").count()) === 0);
  const startUrl = page.url();
  await Promise.all([page.waitForURL(u => u.href !== startUrl), chips(page).first().click()]);
  await page.waitForLoadState("networkidle");
  check(`shop: a chip navigates to the relaxed URL (${new URL(page.url()).search})`, page.url() !== startUrl && (await countNumber(page)) > 0);
  check("shop: results are rendered by the server for the new URL", (await page.locator("#results tbody tr").count()) > 0);
  await page.goBack(); await page.waitForLoadState("networkidle");
  check("shop: browser Back returns to the previous filters (the Undo)", page.url() === startUrl && (await countNumber(page)) === 0);
  await waitChips(page);
  const adapt = chips(page).filter({hasText: "Rent ≤"});
  if (await adapt.count()) { await Promise.all([page.waitForURL(u => /max_price=(?!400)\d+/.test(u.search)), adapt.first().click()]); check("shop: an adapted chip sets max_price in the URL", true); }
  const form = await open(`${SHOP}/?filter_town=Pully&filter_town=Renens&max_price=900`);
  check("shop: repeated filter_town parameters are parsed by Go and by the widget", (await countNumber(form)) > 0);
  noProblems(page, "shop");
  await form.context_.close();
  await page.context_.close();
}

// ---- 8. server mode against a real local loosend ----
let loosendUp = false;
if (HOSTED) loosendUp = true;
else try { loosendUp = (await fetch(`${LOOSEND}/health`)).ok; } catch { /* not running */ }
if (!loosendUp) check("server mode: loosend reachable (start with ./serve.sh --with-server)", false, LOOSEND);
else {
  const page = await open(`${BASE}/examples/server.html`);
  await page.locator("#status.good").waitFor({timeout: 5000});
  check("server: the probe of the explain endpoint succeeds (CORS, read key, catalog)", /answers at/.test(await page.locator("#status").innerText()));
  if (!HOSTED) {
    const health = await (await fetch(`${LOOSEND}/health`)).json();
    check("server: loosend holds the 186 apartments", health.items === 186 && health.catalogs.apartments.items === 186);
  } else {
    const explain = await fetch(`${BASE}/api/v1/catalogs/apartments/explain`, {method: "POST", headers: {"Content-Type": "application/json", "X-Loosen-Key": READ_KEY}, body: JSON.stringify({constraints: [{attr: "rent", op: "le", value: 400}, {attr: "metroM1", op: "eq", value: 1}, {attr: "parking", op: "eq", value: 1}]})});
    const body = await explain.json();
    check("server (hosted): loosend explains through $BASE/api over 186 items", explain.status === 200 && body.items === 186 && body.matching === 0 && body.relaxations.length > 0, JSON.stringify(body).slice(0, 200));
  }
  const reqs = [];
  page.on("request", r => { if (r.url().includes("/explain")) reqs.push(r); });
  await flow(page, "server (loosend)", {presetIndex: 0, expectUnlicensed: true});
  check("server: the widget POSTs /explain with the read key header", reqs.length > 0 && reqs[0].method() === "POST" && reqs[0].headers()["x-loosen-key"] === READ_KEY);
  if (HOSTED) check(`server (hosted): the browser calls the same origin (${reqs[0]?.url()})`, reqs[0]?.url() === `${BASE}/api/v1/catalogs/apartments/explain`, reqs[0]?.url());
  noProblems(page, "server");
  await page.context_.close();
  // wrong read key -> the widget says the explanation is unavailable, the page keeps working
  const bad = await open(`${BASE}/examples/server.html?key=wrong-key`);
  await bad.locator("button[data-preset]").nth(0).click();
  await bad.locator("#loosen .note").waitFor({timeout: 5000});
  check("server: a wrong read key gives 'explanation is unavailable', not a broken page", /unavailable/.test(await bad.locator("#loosen .note").innerText()));
  await bad.context_.close();
}

// ---- 8b. hosted only: nothing private is reachable from outside ----
if (HOSTED) {
  const status = async (method, path, init = {}) => (await fetch(`${BASE}${path}`, {method, redirect: "manual", ...init})).status;
  for (const [m, p] of [["GET", "/api/health"], ["GET", "/api/v1/catalogs"], ["GET", "/api/v1/catalogs/apartments/items"], ["GET", "/api/v1/catalogs/apartments"], ["PUT", "/api/v1/catalogs/apartments/items"],
    ["PUT", "/api/v1/catalogs/apartments/read-key"], ["DELETE", "/api/v1/catalogs/apartments"], ["POST", "/api/v1/catalogs/apartments/refresh"], ["GET", "/api/v1/admin/keys"], ["GET", "/.env"], ["GET", "/deploy/start-post.sh"], ["GET", "/bin/front"]]) {
    const code = await status(m, p, m === "GET" ? {} : {headers: {Authorization: "Bearer examples-admin-key-0000", Origin: new URL(BASE).origin}, body: "{}"});
    check(`hosted: ${m} ${p} is refused (${code})`, code === 404 || code === 405 || code === 403 || code === 401);
  }
  const get = await fetch(`${BASE}/`), head = await fetch(`${BASE}/`, {method: "HEAD"});
  check("hosted: HEAD / has the same status as GET /", get.status === head.status && head.status === 200);
  for (const p of ["/", "/examples/react.html", "/assets/chrome.js", "/shop/", "/no-such-page"]) {
    const r = await fetch(`${BASE}${p}`);
    check(`hosted: Cache-Control: no-cache on ${p} (${r.status})`, r.headers.get("cache-control") === "no-cache", r.headers.get("cache-control") ?? "none");
  }
}

// ---- 9. playground ----
{
  const page = await open(`${BASE}/examples/playground.html`);
  await page.locator("button[data-preset]").nth(0).click(); await waitChips(page);
  const log = () => page.locator("#log li").allInnerTexts();
  check("playground: events stream shows licence and panel_shown", (await log()).some(l => l.startsWith("licence")) && (await log()).some(l => l.startsWith("panel_shown")));
  await page.selectOption("[name=why]", "expanded"); await waitChips(page);
  check("playground: why=expanded lists the conflicts without a click", (await page.locator("#loosen ul.why").isVisible()) && (await page.locator("#loosen .why-toggle").count()) === 0);
  await page.selectOption("[name=why]", "hidden"); await waitChips(page);
  check("playground: why=hidden removes the block", (await page.locator("#loosen ul.why").count()) === 0 && (await page.locator("#loosen .why-toggle").count()) === 0);
  await page.selectOption("[name=why]", "collapsed"); await waitChips(page);
  await page.locator("#loosen .why-toggle").click();
  check("playground: why=collapsed opens on click (aria-expanded)", (await page.locator("#loosen .why-toggle").getAttribute("aria-expanded")) === "true");
  await page.selectOption("[name=original]", "inline"); await waitChips(page);
  check("playground: original=inline writes '(was ...)' in adapted chips", (await chips(page).allInnerTexts()).some(t => /\(was/.test(t)));
  await page.selectOption("[name=original]", "none"); await waitChips(page);
  check("playground: original=none hides it", !(await chips(page).allInnerTexts()).some(t => /\(was/.test(t)));
  await page.uncheck("[name=showResults]"); await waitChips(page);
  check("playground: showResults off removes the counts", !(await chips(page).allInnerTexts()).some(t => /results?/.test(t)));
  await page.check("[name=showResults]");
  await page.selectOption("[name=order]", "canonical"); await waitChips(page);
  check("playground: order=canonical works", (await chips(page).count()) > 0);
  await page.fill("[name=limit]", "1"); await page.locator("[name=limit]").dispatchEvent("change"); await waitChips(page);
  check("playground: limit=1 keeps one chip per block and says 'and N more'", (await page.locator("#loosen .more").count()) > 0);
  await page.fill("[name=limit]", "8"); await page.locator("[name=limit]").dispatchEvent("change");
  await page.selectOption("[name=texts]", "fr"); await waitChips(page);
  check("playground: texts override (French)", /Pourquoi/.test(await page.locator("#loosen .why-toggle").innerText()) && /Un de ces changements/.test(await page.locator("#loosen .title").first().innerText()));
  await page.selectOption("[name=texts]", "en");
  await page.selectOption("[name=theme]", "dark"); await waitChips(page);
  const bg = await page.evaluate(() => getComputedStyle(document.querySelector("#loosen").firstElementChild.shadowRoot.querySelector(".panel") ?? document.body).backgroundColor);
  check(`playground: theming with --loosen-* custom properties (panel background ${bg})`, bg === "rgb(15, 23, 42)", bg);
  await page.selectOption("[name=theme]", "default");
  // autoUpdate off: the page calls update() itself, the panel must still refresh
  await page.uncheck("[name=autoUpdate]"); await waitChips(page);
  await chips(page).first().click(); await page.locator("#loosen .undo button").waitFor();
  check("playground: autoUpdate=false and the page's own update() gives the same result", (await countNumber(page)) > 0);
  await page.locator("#loosen .undo button").click(); await waitChips(page);
  await page.check("[name=autoUpdate]");
  // keyboard: Tab-reachable real buttons; Enter applies; focus moves to Undo
  await chips(page).first().focus();
  await page.keyboard.press("Enter");
  await page.locator("#loosen .undo button").waitFor();
  const focusOnUndo = await page.evaluate(() => { let a = document.activeElement; while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement; return a?.tagName === "BUTTON" && /Undo/.test(a.textContent); });
  check("playground (keyboard): Enter on a chip applies it and the focus moves to Undo", focusOnUndo);
  await page.keyboard.press("Enter"); await waitChips(page);
  check("playground (keyboard): Enter on Undo restores and the panel returns", (await countNumber(page)) === 0);
  const regionOk = await page.evaluate(() => { const r = document.querySelector("#loosen").firstElementChild.shadowRoot.querySelector("[role=region]"); return !!r && r.getAttribute("aria-live") === "polite"; });
  check("playground (a11y): the panel is a role=region with aria-live=polite", regionOk);
  await page.uncheck("[name=undo]"); await waitChips(page);
  await chips(page).first().click(); await sleep(300);
  check("playground: restoreConstraints off removes Undo", (await page.locator("#loosen .undo button").count()) === 0);
  await page.locator("#clear-log").click();
  check("playground: events log can be cleared", (await page.locator("#log li").count()) === 0);
  noProblems(page, "playground");
  await page.context_.close();
}

// ---- 10. licence from config.js ----
{
  const route = page => page.route("**/config.js", r => r.fulfill({contentType: "text/javascript", body: 'window.LOOSEN_LICENCE = "LSN1.not-a-real-key.xyz";'}));
  const page = await open(`${BASE}/examples/playground.html`, {route});
  await page.locator("button[data-preset]").nth(0).click(); await waitChips(page);
  const licenceEvent = (await page.locator("#log li[data-type=licence]").allInnerTexts())[0] ?? "";
  check(`config.js: window.LOOSEN_LICENCE reaches the widget (event: ${licenceEvent})`, /unlicensed/.test(licenceEvent) && !/missing/.test(licenceEvent), licenceEvent);
  await page.context_.close();
}

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
