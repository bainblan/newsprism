#!/usr/bin/env node
/**
 * newsprism run-driver — launches both halves and drives the UI programmatically.
 *
 * Zero dependencies on purpose. Node 22 ships a global WebSocket and fetch, and
 * Chrome is already installed on this machine, so the browser is driven over the
 * Chrome DevTools Protocol directly rather than pulling in Playwright/Puppeteer
 * (a ~130 MB download that buys nothing here).
 *
 * Commands
 *   smoke            start API + web, drive the real UI, screenshot, tear down
 *   api              start API only, probe every contract endpoint, tear down
 *   ui [scenario]    start web in mock mode (no backend), screenshot
 *   shot <url> [out] screenshot any already-running URL; starts nothing
 *   eval <url> <js>  evaluate a JS expression in the page and print the result
 *   doctor           check prerequisites and report what is missing
 *
 * Flags
 *   --api-port N   (default 8010)   --web-port N  (default 3010)
 *   --cdp-port N   (default 9222)   --keep        leave servers running
 *   --headful                        show the browser window
 *
 * Ports default to 8010/3010, NOT the documented 8000/3000, so the driver never
 * fights a dev server a human already has open. See SKILL.md "Gotchas".
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const UNIT = resolve(HERE, "../../..");          // repo root
const BACKEND = join(UNIT, "backend");
const FRONTEND = join(UNIT, "frontend");
const SHOTS = join(HERE, "shots");

const IS_WIN = process.platform === "win32";
const VENV_PY = join(BACKEND, ".venv", IS_WIN ? "Scripts/python.exe" : "bin/python");

const CHROME_CANDIDATES = IS_WIN
  ? [
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    ]
  : ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"];

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const cmd = argv[0] ?? "smoke";
const positional = argv.slice(1).filter((a) => !a.startsWith("--"));
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const API_PORT = Number(flag("api-port", 8010));
const WEB_PORT = Number(flag("web-port", 3010));
const CDP_PORT = Number(flag("cdp-port", 9222));
const API_URL = `http://127.0.0.1:${API_PORT}`;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;

const log = (...a) => console.log(...a);
const step = (s) => console.log(`\n\x1b[36m▸ ${s}\x1b[0m`);
const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = (s) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- process mgmt
const children = [];

function startProc(name, command, args, opts = {}) {
  const p = spawn(command, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env || {}) },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  const tail = [];
  const keep = (buf) => {
    const s = buf.toString();
    tail.push(s);
    if (tail.length > 40) tail.shift();
    if (process.env.DRIVER_VERBOSE) process.stdout.write(`[${name}] ${s}`);
  };
  p.stdout.on("data", keep);
  p.stderr.on("data", keep);
  p.on("error", (e) => bad(`${name} failed to spawn: ${e.message}`));
  const rec = { name, proc: p, tail };
  children.push(rec);
  return rec;
}

/**
 * Killing the parent is not enough on Windows: `npx next dev` spawns a child
 * node process that keeps the port bound and outlives its parent. taskkill /T
 * walks the tree.
 */
function killAll() {
  for (const { proc } of children) {
    if (proc.exitCode !== null || proc.signalCode) continue;
    try {
      if (IS_WIN) {
        spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        process.kill(-proc.pid, "SIGKILL");
      }
    } catch { /* already gone */ }
  }
}

function dumpTail(rec, n = 18) {
  const text = rec.tail.join("").trim().split("\n").slice(-n).join("\n");
  if (text) console.log(`\n--- ${rec.name} output (last ${n} lines) ---\n${text}\n`);
}

async function waitForHttp(url, { timeoutMs = 90000, label = url, expect = null } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!expect || r.status === expect) {
        return { status: r.status, secs: ((Date.now() - started) / 1000).toFixed(1) };
      }
    } catch { /* not up yet */ }
    await sleep(700);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

// ---------------------------------------------------------------- CDP client
function findChrome() {
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c;
  return null;
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }

  static async attach(port) {
    // The browser-level endpoint. /json/version is the one discovery route that
    // has stayed stable across Chrome versions.
    let info;
    for (let i = 0; i < 40; i++) {
      try {
        info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        break;
      } catch { await sleep(500); }
    }
    if (!info) throw new Error("Chrome never opened its debugging port");
    const ws = new WebSocket(info.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error("CDP socket failed")), { once: true });
    });
    const c = new Cdp(ws);
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      const p = c.pending.get(msg.id);
      if (p) {
        c.pending.delete(msg.id);
        msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
      }
    });
    return c;
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => {
        if (this.pending.delete(id)) rej(new Error(`CDP ${method} timed out`));
      }, 30000);
    });
  }

  async newPage() {
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank" });
    // flatten:true multiplexes the page session over the browser socket, which
    // avoids opening a second WebSocket per tab.
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    return new Page(this, sessionId);
  }

  close() { try { this.ws.close(); } catch {} }
}

class Page {
  constructor(cdp, sessionId) { this.cdp = cdp; this.sid = sessionId; }
  s(m, p) { return this.cdp.send(m, p, this.sid); }

  async goto(url) {
    await this.s("Page.enable");
    await this.s("Runtime.enable");
    await this.s("Page.navigate", { url });
    // Page.loadEventFired is unreliable for a client-rendered app; poll document
    // readiness and then let the client fetch settle via waitFor().
    for (let i = 0; i < 60; i++) {
      const st = await this.eval("document.readyState");
      if (st === "complete") return;
      await sleep(250);
    }
  }

  async eval(expression) {
    const r = await this.s("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "eval threw");
    return r.result?.value;
  }

  /** Poll a JS predicate until truthy. Returns the value. */
  async waitFor(expression, { timeoutMs = 30000, label = expression } = {}) {
    const started = Date.now();
    let last;
    while (Date.now() - started < timeoutMs) {
      try {
        last = await this.eval(expression);
        if (last) return last;
      } catch { /* page may still be swapping documents */ }
      await sleep(400);
    }
    throw new Error(`waitFor timed out: ${label} (last value: ${JSON.stringify(last)})`);
  }

  async setViewport(width, height) {
    await this.s("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: 1, mobile: false,
    });
  }

  async screenshot(file) {
    mkdirSync(SHOTS, { recursive: true });
    // keep the driver's own output out of git without touching the repo .gitignore
    writeFileSync(join(SHOTS, ".gitignore"), "*\n");
    const { data } = await this.s("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    const out = join(SHOTS, file);
    writeFileSync(out, Buffer.from(data, "base64"));
    return out;
  }

  async text() { return this.eval("document.body.innerText"); }

  /**
   * Every page here is client-fetched, so `document.readyState === "complete"`
   * fires while the list is still skeleton placeholders. Wait until the text
   * stops changing AND no loading affordance is on screen; fall through after
   * the timeout so a stuck page still yields a screenshot to look at.
   */
  async settle({ timeoutMs = 20000 } = {}) {
    const started = Date.now();
    let prev = "", stable = 0;
    while (Date.now() - started < timeoutMs) {
      const t = (await this.eval("document.body.innerText")) || "";
      const loading = /Loading|Loading stories|…\s*$/i.test(t) && t.length < 400;
      if (t === prev && !loading) {
        if (++stable >= 2) return true;
      } else {
        stable = 0;
      }
      prev = t;
      await sleep(500);
    }
    return false;
  }
}

async function withBrowser(fn) {
  const chrome = findChrome();
  if (!chrome) throw new Error(`no Chrome/Edge found; looked in:\n  ${CHROME_CANDIDATES.join("\n  ")}`);
  const profile = join(process.env.TEMP || "/tmp", `newsprism-cdp-${Date.now()}`);
  const args = [
    has("headful") ? "--headless=false" : "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check",
    "--disable-gpu", "--disable-dev-shm-usage",
    "--window-size=1440,1000",
    "about:blank",
  ].filter((a) => a !== "--headless=false");
  const rec = startProc("chrome", chrome, args);
  try {
    const cdp = await Cdp.attach(CDP_PORT);
    const page = await cdp.newPage();
    await page.setViewport(1440, 1000);
    const r = await fn(page);
    cdp.close();
    return r;
  } finally {
    try { if (IS_WIN) spawnSync("taskkill", ["/PID", String(rec.proc.pid), "/T", "/F"], { stdio: "ignore" }); else rec.proc.kill("SIGKILL"); } catch {}
  }
}

// ---------------------------------------------------------------- servers
function startApi(extraEnv = {}) {
  if (!existsSync(VENV_PY)) {
    throw new Error(`no venv at ${VENV_PY} — run: python -m venv .venv && .venv/Scripts/pip install -r requirements.txt`);
  }
  // The backend's CORS default only allows :3000. The driver runs the UI on
  // :3010 to stay out of a human dev server's way, so the browser would be
  // blocked by CORS with no visible error beyond an empty list. Widen it here.
  const origins = [
    `http://127.0.0.1:${WEB_PORT}`, `http://localhost:${WEB_PORT}`,
    "http://127.0.0.1:3000", "http://localhost:3000",
  ].join(",");
  return startProc("api", VENV_PY, [
    "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(API_PORT),
  ], { cwd: BACKEND, env: { NEWSPRISM_CORS_ORIGINS: origins, ...extraEnv } });
}

function startWeb(extraEnv = {}) {
  // NOT node_modules/.bin/next.cmd: since the CVE-2024-27980 fix, Node refuses
  // to spawn .cmd/.bat without shell:true and throws EINVAL. Invoking the JS
  // entry point with the current node binary sidesteps the shim entirely, and
  // is identical on Linux.
  const nextJs = join(FRONTEND, "node_modules", "next", "dist", "bin", "next");
  if (!existsSync(nextJs)) throw new Error(`next not installed — run: npm ci (in ${FRONTEND})`);
  return startProc("web", process.execPath, [
    nextJs, "dev", "--port", String(WEB_PORT), "--hostname", "127.0.0.1",
  ], {
    cwd: FRONTEND,
    env: { NEXT_PUBLIC_API_URL: API_URL, ...extraEnv },
  });
}

async function waitForWeb(rec) {
  try {
    return await waitForHttp(WEB_URL, { timeoutMs: 120000, label: "next dev", expect: 200 });
  } catch (e) {
    const joined = rec.tail.join("");
    if (/Another next dev server is already running/i.test(joined)) {
      const pid = (joined.match(/PID:\s*(\d+)/) || [])[1];
      throw new Error(
        `Next refuses to start a second dev server for this project directory, even on a\n` +
        `different port. An existing one is running${pid ? ` as PID ${pid}` : ""}.\n` +
        `Stop it first:  taskkill /PID ${pid || "<pid>"} /F      (or use: driver.mjs shot <url>)`
      );
    }
    throw e;
  }
}

// ---------------------------------------------------------------- commands
async function cmdDoctor() {
  step("Prerequisites");
  const checks = [
    ["node", process.version, true],
    ["backend venv", VENV_PY, existsSync(VENV_PY)],
    ["frontend node_modules", join(FRONTEND, "node_modules"), existsSync(join(FRONTEND, "node_modules"))],
    ["chrome/edge", findChrome() || "NOT FOUND", !!findChrome()],
    ["sqlite db", join(BACKEND, "data", "newsprism.db"), existsSync(join(BACKEND, "data", "newsprism.db"))],
  ];
  let allOk = true;
  for (const [name, detail, good] of checks) {
    good ? ok(`${name}: ${detail}`) : (bad(`${name}: ${detail}`), (allOk = false));
  }
  if (!existsSync(join(BACKEND, "data", "newsprism.db"))) {
    log("\n  note: a cold DB is fine — the API answers 503 NO_DATA until you POST /api/ingest.");
  }
  return allOk ? 0 : 1;
}

async function probeApi() {
  const results = [];
  const get = async (path, expectOneOf = [200]) => {
    const r = await fetch(`${API_URL}${path}`, { signal: AbortSignal.timeout(30000) });
    const body = await r.json().catch(() => ({}));
    const good = expectOneOf.includes(r.status);
    results.push(good);
    good ? ok(`GET ${path} → ${r.status}`) : bad(`GET ${path} → ${r.status} (wanted ${expectOneOf})`);
    return { status: r.status, body };
  };

  const health = await get("/api/health");
  if (health.body.clusterer) {
    // /api/health reports the CONFIGURED clusterer, not the constructed one —
    // it cannot detect a runtime fallback to tfidf. Surfaced, not trusted.
    log(`     clusterer (configured): ${health.body.clusterer}`);
  }
  await get("/api/outlets");
  const stories = await get("/api/stories?limit=3", [200, 503]);

  if (stories.status === 200) {
    const list = stories.body.stories || [];
    ok(`${list.length} stories returned`);
    const multi = list.find((s) => s.article_count > 1);
    if (multi) {
      const spread = Object.entries(multi.coverage).filter(([, n]) => n > 0).map(([k, n]) => `${k}:${n}`).join(" ");
      ok(`spread check — "${multi.title.slice(0, 58)}…"`);
      log(`     ${multi.article_count} articles across ${spread}`);
      const sum = Object.values(multi.coverage).reduce((a, b) => a + b, 0);
      sum === multi.article_count
        ? ok(`coverage invariant holds (${sum} === article_count)`)
        : bad(`coverage invariant BROKEN: ${sum} !== ${multi.article_count}`);
      results.push(sum === multi.article_count);
      // the durable-id lookup that slice 1.1 added
      const one = await get(`/api/stories/${multi.id}`);
      if (one.status === 200) ok(`durable id resolves: ${one.body.story?.id}`);
    } else {
      log("     (no multi-source story in this sample — try --limit higher or re-ingest)");
    }
  } else {
    log("     503 NO_DATA is the documented cold-start state; POST /api/ingest to populate.");
  }

  // On a COLD database this returns 503 NO_DATA, not 404 NOT_FOUND: the route
  // checks "nothing ingested at all" before "no such story". Both are correct
  // contract responses, so which one to demand depends on whether data exists.
  const bad404 = await fetch(`${API_URL}/api/stories/s_doesnotexist`, { signal: AbortSignal.timeout(10000) });
  const b = await bad404.json().catch(() => ({}));
  const code = b?.error?.code;
  const envelopeOk = stories.status === 200
    ? bad404.status === 404 && code === "NOT_FOUND"
    : bad404.status === 503 && code === "NO_DATA";
  envelopeOk
    ? ok(`unknown id returns the contract envelope (${bad404.status} ${code})`)
    : bad(`unknown-id envelope wrong: ${bad404.status} ${JSON.stringify(b).slice(0, 100)}`);
  results.push(envelopeOk);

  return results.every(Boolean);
}

async function cmdApi() {
  step(`Starting API on ${API_PORT}`);
  const api = startApi();
  try {
    const { secs } = await waitForHttp(`${API_URL}/api/health`, { label: "uvicorn" });
    ok(`up in ${secs}s`);
    step("Contract endpoints");
    const good = await probeApi();
    return good ? 0 : 1;
  } catch (e) {
    bad(e.message);
    dumpTail(api);
    return 1;
  }
}

async function cmdUi() {
  const scenario = positional[0] || "stories";
  step(`Starting web on ${WEB_PORT} in mock mode (scenario: ${scenario}) — no backend needed`);
  const web = startWeb({
    NEXT_PUBLIC_USE_MOCK_DATA: "true",
    NEXT_PUBLIC_MOCK_SCENARIO: scenario,
  });
  try {
    const { secs } = await waitForWeb(web);
    ok(`next dev ready in ${secs}s`);
    return await withBrowser(async (page) => {
      await page.goto(WEB_URL);
      await page.settle();
      const out = await page.screenshot(`ui-${scenario}.png`);
      ok(`screenshot → ${out}`);
      const t = await page.text();
      log(`\n--- rendered text (first 300 chars) ---\n${t.slice(0, 300)}\n`);
      return 0;
    });
  } catch (e) {
    bad(e.message);
    dumpTail(web);
    return 1;
  }
}

async function cmdEval() {
  const url = positional[0];
  const expr = positional.slice(1).join(" ");
  if (!url || !expr) { bad('usage: driver.mjs eval <url> "<js expression>"'); return 1; }
  step(`Evaluating in ${url}`);
  return await withBrowser(async (page) => {
    await page.goto(url);
    await page.settle({ timeoutMs: 8000 });
    const v = await page.eval(expr);
    log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
    return 0;
  });
}

async function cmdShot() {
  const url = positional[0];
  if (!url) { bad("usage: driver.mjs shot <url> [out.png]"); return 1; }
  const out = positional[1] || "shot.png";
  step(`Screenshotting ${url}`);
  return await withBrowser(async (page) => {
    await page.goto(url);
    const settled = await page.settle();
    if (!settled) log("  (page never settled — screenshotting anyway)");
    const f = await page.screenshot(out);
    ok(`→ ${f}`);
    const t = await page.text();
    log(`\n--- rendered text (first 400 chars) ---\n${t.slice(0, 400)}\n`);
    return 0;
  });
}

async function cmdSmoke() {
  let api, web;
  try {
    step(`Starting API on ${API_PORT}`);
    api = startApi();
    const a = await waitForHttp(`${API_URL}/api/health`, { label: "uvicorn" });
    ok(`up in ${a.secs}s`);

    step("Contract endpoints");
    const apiGood = await probeApi();

    step(`Starting web on ${WEB_PORT} → ${API_URL}`);
    web = startWeb();
    const w = await waitForWeb(web);
    ok(`next dev ready in ${w.secs}s`);

    step("Driving the real UI");
    const uiGood = await withBrowser(async (page) => {
      await page.goto(WEB_URL);

      // The list is client-fetched, so the document is "complete" long before
      // there is anything to look at. Wait on real content, not readyState.
      const heading = await page.waitFor(
        `(() => { const h = document.querySelector('h1,h2'); return h && h.innerText.trim() ? h.innerText.trim() : null; })()`,
        { label: "a heading to render" }
      );
      ok(`heading: "${heading}"`);

      const state = await page.waitFor(
        `(() => {
           const t = document.body.innerText;
           if (/No data yet|Run first ingest/i.test(t)) return 'no_data';
           if (/couldn't reach|unreachable|Failed to fetch/i.test(t)) return 'unreachable';
           const links = document.querySelectorAll('a[href^="/stories/"]');
           return links.length ? 'stories:' + links.length : null;
         })()`,
        { label: "the list to resolve to a known state" }
      );
      ok(`list state: ${state}`);

      const home = await page.screenshot("smoke-1-home.png");
      ok(`screenshot → ${home}`);

      if (!state.startsWith("stories:")) {
        log("\n  (no stories rendered — DB is probably cold. POST /api/ingest, then re-run.)");
        return false;
      }

      // real user flow: click through to a story detail page
      step("Clicking into a story");
      const href = await page.eval(`document.querySelector('a[href^="/stories/"]').getAttribute('href')`);
      await page.eval(`document.querySelector('a[href^="/stories/"]').click()`);
      await page.waitFor(`location.pathname.startsWith('/stories/')`, { label: "route change" });
      ok(`navigated to ${href}`);

      const detail = await page.waitFor(
        `(() => {
           const t = document.body.innerText;
           return /Loading/i.test(t) ? null : (t.length > 120 ? t.length : null);
         })()`,
        { label: "detail content" }
      );
      ok(`detail rendered (${detail} chars of text)`);

      const outlets = await page.eval(
        `document.querySelectorAll('a[href^="http"]').length`
      );
      ok(`${outlets} outbound source links on the detail page`);

      const shot2 = await page.screenshot("smoke-2-detail.png");
      ok(`screenshot → ${shot2}`);
      return true;
    });

    step("Result");
    if (apiGood && uiGood) { ok("end-to-end OK"); return 0; }
    bad(`api:${apiGood ? "ok" : "FAILED"} ui:${uiGood ? "ok" : "FAILED"}`);
    return 1;
  } catch (e) {
    bad(e.message);
    if (api) dumpTail(api);
    if (web) dumpTail(web);
    return 1;
  }
}

// ---------------------------------------------------------------- main
const COMMANDS = { smoke: cmdSmoke, api: cmdApi, ui: cmdUi, shot: cmdShot, eval: cmdEval, doctor: cmdDoctor };

process.on("SIGINT", () => { killAll(); process.exit(130); });

const run = COMMANDS[cmd];
if (!run) {
  console.error(`unknown command "${cmd}"\nexpected one of: ${Object.keys(COMMANDS).join(", ")}`);
  process.exit(2);
}

let code = 1;
try {
  code = await run();
} catch (e) {
  bad(e.stack || e.message);
  code = 1;
} finally {
  if (has("keep")) {
    log(`\n(--keep) leaving servers up: ${API_URL} ${WEB_URL}`);
    log(`kill them with: taskkill /PID ${children.map((c) => c.proc.pid).join(" /T /F & taskkill /PID ")} /T /F`);
  } else {
    killAll();
  }
}
process.exit(code);
