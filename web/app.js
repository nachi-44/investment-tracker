// App shell: connect / unlock, views, auto-lock. All data handling goes through core.js, vault.js and sync.js.
import { h, clear, cls, toast, donut, bars, avatar, icon, logo, heroChart, classColor } from "./ui.js";
import { migrate, rows, totals, groupBy, facets, filterRows, sortRows, money, pct, num, today, findPos } from "./core.js";
import { createVault, unlock, recover, changePassphrase, encryptData, decryptData, sealSecret, openSecret, passphraseProblem } from "./vault.js";
import { GitHubStore, MemoryStore, Vault, VAULT_PATH, AuthError } from "./sync.js";
import { degiroPortfolioOp, sha256 } from "./importers/degiro.js";
import { checks, allocation, splitNewMoney } from "./rules.js";
import * as folder from "./folder.js";
import { watchlist, mergePrices, parseHistory, valueSeries, dayChanges } from "./prices.js";

const DEVICE_KEY = "pt.device.v1";
const IDLE_MS = 5 * 60 * 1000;
const root = document.getElementById("app");

const S = {
  device: readDevice(),
  session: null, vault: null, store: null,
  view: "overview", filters: {}, sort: "valEUR:-1", openRows: new Set(),
  offline: false, demo: false, savedAt: null, recordPrefill: null,
};

// ---------- device storage (only encrypted things + repo name) ----------
function readDevice() { try { return JSON.parse(localStorage.getItem(DEVICE_KEY)) || null; } catch { return null; } }
function writeDevice(d) { S.device = d; try { d ? localStorage.setItem(DEVICE_KEY, JSON.stringify(d)) : localStorage.removeItem(DEVICE_KEY); } catch {} }
async function cacheVault() {
  if (S.demo || !S.vault) return;
  const file = await encryptData(S.session, S.vault.db);
  writeDevice({ ...S.device, cache: { text: JSON.stringify(file), sha: S.vault.sha } });
}

// ---------- theme ----------
function applyTheme() {
  let t = "dark"; try { t = localStorage.getItem("pt.theme") || "dark"; } catch {}
  if (t === "auto") document.documentElement.removeAttribute("data-theme"); else document.documentElement.dataset.theme = t;
}
applyTheme();

// ---------- auto-lock ----------
let lastActive = Date.now();
for (const ev of ["pointerdown", "keydown", "scroll"]) addEventListener(ev, () => (lastActive = Date.now()), { passive: true });
setInterval(() => { if (S.session && !S.demo && Date.now() - lastActive > IDLE_MS) lock("Locked after 5 minutes without activity."); }, 15000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && S.session && !S.demo && Date.now() - lastActive > IDLE_MS) lock("Locked after 5 minutes without activity.");
});

function lock(msg) {
  S.session = null; S.vault = null; S.store = null; S.openRows.clear();
  if (S.demo) { location.hash = ""; S.demo = false; }
  boot(msg);
}

// ---------- boot ----------
function boot(msg) {
  if (location.hash === "#demo") return startDemo();
  if (!S.device) return renderConnect(msg);
  return renderLock(msg);
}

function screen(...kids) { clear(root).append(h("div.center", logo("logo"), ...kids)); }
function field(lbl, input, hint) {
  if (!input.id) input.id = "f" + Math.random().toString(36).slice(2, 8);
  return h("div.field", h("label", { for: input.id }, lbl), input, hint && h("div.sm.mu", hint));
}
function busy(btn, on, text) { btn.disabled = on; if (text) btn.textContent = text; }
const errBox = () => h("div.err", { role: "alert" });

// ---------- connect (first time on this device) ----------
function renderConnect(msg) {
  const repo = h("input", { value: "nachi-44/investment-vault", autocomplete: "off", spellcheck: false });
  const token = h("input", { type: "password", autocomplete: "off", placeholder: "github_pat_…" });
  const pass = h("input", { type: "password", autocomplete: "current-password" });
  const err = errBox();
  const go = h("button.btn.primary", { type: "submit" }, "Connect");
  const form = h("form", {
    on: {
      submit: async (e) => {
        e.preventDefault(); err.textContent = "";
        const [owner, name] = repo.value.trim().split("/");
        if (!owner || !name) return (err.textContent = "Enter the vault repository as owner/name.");
        if (!token.value.trim()) return (err.textContent = "Enter the access token.");
        busy(go, true, "Connecting…");
        try {
          const store = new GitHubStore({ owner, repo: name, token: token.value.trim() });
          const f = await store.read(VAULT_PATH);
          if (!f) return renderCreate(store, { owner, repo: name, token: token.value.trim() });
          if (!pass.value) throw new Error("Enter your passphrase to unlock the existing vault.");
          const session = await unlock(JSON.parse(f.text), pass.value);
          writeDevice({ owner, repo: name, tokenBox: await sealSecret(session, token.value.trim()) });
          await openVault(store, session);
        } catch (e2) { err.textContent = e2.message; busy(go, false, "Connect"); }
      },
    },
  },
    field("Vault repository (private)", repo),
    field("Fine-grained access token", token, "Only for the vault repository, permission Contents: read and write. Stored on this device encrypted with your passphrase."),
    field("Passphrase", pass, "Leave empty if you are creating a new vault."),
    err, h("div.row", go, h("a.sm", { href: "#demo", on: { click: () => setTimeout(() => boot(), 0) } }, "Try with sample data")));
  screen(h("h1", "Connect this device"), msg && h("p.note", msg), h("div.card", form), privacyNote());
}

function privacyNote() {
  return h("p.sm.mu", "Your holdings are encrypted in this browser before anything is sent to GitHub. The passphrase never leaves this device. Not financial advice.");
}

// ---------- create a new vault from seed.json ----------
function renderCreate(store, conn) {
  const file = h("input", { type: "file", accept: ".json,application/json" });
  const p1 = h("input", { type: "password", autocomplete: "new-password" });
  const p2 = h("input", { type: "password", autocomplete: "new-password" });
  const err = errBox();
  const go = h("button.btn.primary", { type: "submit" }, "Create encrypted vault");
  const form = h("form", {
    on: {
      submit: async (e) => {
        e.preventDefault(); err.textContent = "";
        const problem = passphraseProblem(p1.value);
        if (problem) return (err.textContent = problem);
        if (p1.value !== p2.value) return (err.textContent = "The passphrases don't match.");
        busy(go, true, "Encrypting…");
        try {
          const data = migrate(file.files[0] ? JSON.parse(await file.files[0].text()) : emptyPortfolio());
          if (!Object.keys(data.accounts).length || !Array.isArray(data.positions)) throw new Error("seed.json needs accounts and positions.");
          const { file: vf, session, recovery } = await createVault(p1.value, data);
          const sha = await store.write(VAULT_PATH, JSON.stringify(vf), null, "create vault");
          writeDevice({ owner: conn.owner, repo: conn.repo, tokenBox: await sealSecret(session, conn.token) });
          renderRecovery(recovery, () => openVault(store, session, sha));
        } catch (e2) { err.textContent = e2.message; busy(go, false, "Create encrypted vault"); }
      },
    },
  },
    field("Starting data (optional)", file, "Leave empty to start with your three accounts (Degiro, India, SBI Life ULIP) and add holdings afterwards: import the Degiro CSV, record buys. If you have a seed.json, choose it here; it stays on this device and only the encrypted result is uploaded."),
    field("New passphrase", p1, "At least 5 random words, or 16+ varied characters."),
    field("Repeat passphrase", p2), err, go);
  screen(h("h1", "Create your vault"), h("p.mu", "No vault exists in this repository yet."), h("div.card", form), privacyNote());
}

function emptyPortfolio() {
  return {
    rates: {},
    accounts: { degiro: { name: "Degiro", ccy: "EUR" }, india: { name: "India", ccy: "INR" }, ulip: { name: "SBI Life ULIP", ccy: "INR" } },
    positions: [],
  };
}

function renderRecovery(code, next) {
  const ok = h("input", { type: "checkbox", id: "saved" });
  const go = h("button.btn.primary", { disabled: true, on: { click: next } }, "Continue");
  ok.addEventListener("change", () => (go.disabled = !ok.checked));
  screen(h("h1", "Save your recovery key"),
    h("div.card",
      h("p", "If you forget your passphrase, this key is the only way back in. Store it in your password manager or print it. It is shown only once."),
      h("div.recovery", code),
      h("p.row", h("button.btn", { on: { click: () => navigator.clipboard?.writeText(code).then(() => toast("Copied")) } }, "Copy")),
      h("p.row", ok, h("label", { for: "saved" }, "I have saved the recovery key")), go));
}

// ---------- unlock (device already connected) ----------
function renderLock(msg) {
  const pass = h("input", { type: "password", autocomplete: "current-password", autofocus: true });
  const err = errBox();
  const go = h("button.btn.primary", { type: "submit" }, "Unlock");
  const form = h("form", {
    on: {
      submit: async (e) => {
        e.preventDefault(); err.textContent = "";
        busy(go, true, "Unlocking…");
        try {
          const d = S.device;
          const cached = d.cache ? JSON.parse(d.cache.text) : null;
          let session, token;
          if (cached) {
            session = await unlock(cached, pass.value);
            token = await openSecret(session, d.tokenBox);
          } else {
            // no cache yet: we need the file from GitHub, but the token is sealed with the data key.
            throw new Error("This device has no saved copy. Use 'Forget this device' and connect again.");
          }
          const store = new GitHubStore({ owner: d.owner, repo: d.repo, token });
          await openVault(store, session).catch(async (e3) => {
            if (e3 instanceof AuthError) throw e3;
            // offline: open the cached copy read-only
            S.offline = true;
            S.store = store; S.session = session;
            S.vault = new Vault(store, session);
            S.vault.db = migrate(await decryptData(cached, session)); S.vault.sha = d.cache.sha;
            renderApp();
            toast("Offline: showing your last saved copy (read only).");
          });
        } catch (e2) { err.textContent = e2.message; busy(go, false, "Unlock"); pass.select(); }
      },
    },
  }, field("Passphrase", pass), err, h("div.row", go,
    h("button.btn", { type: "button", on: { click: () => renderRecover() } }, "Use recovery key")));
  screen(h("h1", "Portfolio"), msg && h("p.note.ok", msg), h("div.card", form),
    h("p.sm", h("a", { href: "#", on: { click: (e) => { e.preventDefault(); if (confirm("Remove the saved connection and encrypted copy from this device? Your vault on GitHub is not affected.")) { writeDevice(null); boot(); } } } }, "Forget this device")),
    privacyNote());
  pass.focus();
}

function renderRecover() {
  const code = h("input", { autocomplete: "off", spellcheck: false, placeholder: "XXXX-XXXX-…" });
  const p1 = h("input", { type: "password", autocomplete: "new-password" });
  const err = errBox();
  const go = h("button.btn.primary", { type: "submit" }, "Reset passphrase");
  const form = h("form", {
    on: {
      submit: async (e) => {
        e.preventDefault(); err.textContent = ""; busy(go, true, "Working…");
        try {
          const d = S.device, cached = JSON.parse(d.cache.text);
          const r0 = await recover(cached, code.value, p1.value);
          const token = await openSecret(r0.session, d.tokenBox);
          const store = new GitHubStore({ owner: d.owner, repo: d.repo, token });
          const f = await store.read(VAULT_PATH);
          const r = await recover(JSON.parse(f.text), code.value, p1.value);
          await store.write(VAULT_PATH, JSON.stringify(r.file), f.sha, "update");
          await openVault(store, r.session);
          toast("New passphrase set.");
        } catch (e2) { err.textContent = e2.message; busy(go, false, "Reset passphrase"); }
      },
    },
  }, field("Recovery key", code), field("New passphrase", p1, "At least 5 random words, or 16+ varied characters."), err,
    h("div.row", go, h("button.btn", { type: "button", on: { click: () => renderLock() } }, "Back")));
  screen(h("h1", "Recover access"), h("div.card", form));
}

async function openVault(store, session, sha) {
  const v = new Vault(store, session);
  await v.load();
  if (sha && !v.sha) v.sha = sha;
  Object.assign(S, { store, session, vault: v, offline: false, savedAt: new Date() });
  await refreshPrices();
  await cacheVault();
  renderApp();
  // The watchlist must be saved before the price job starts, or the job fetches the old list.
  syncWatchlist().catch(() => {}).finally(() => livePrices());
}

/** Read the price job's output (public market data) and apply it in memory. Returns the file's sha. */
async function refreshPrices() {
  try {
    const [latest, hist] = await Promise.all([S.store.read("prices/latest.json"), S.store.read("prices/history.csv")]);
    if (latest) {
      const r = mergePrices(S.vault.db, JSON.parse(latest.text));
      S.vault.db = r.db;
      S.prices = { updated: r.updated, applied: r.applied, misses: r.misses, lastQuote: r.lastQuote, sha: latest.sha };
    }
    if (hist) { S.hist = parseHistory(hist.text); S.histStamp = hist.sha; }
    return latest?.sha || null;
  } catch (e) { S.prices = { ...(S.prices || {}), error: e.message }; return null; }
}

const LIVE_MAX_AGE = 15 * 60 * 1000; // quotes from free sources are up to ~15 min delayed anyway
const LIVE_TIMEOUT = 150 * 1000;

/**
 * Ask GitHub to run the price job now, then wait for its result (about 30–60 s).
 * Automatic on unlock and when the app comes back to the foreground, if prices are older than 15 minutes.
 */
async function livePrices({ force = false } = {}) {
  if (S.demo || S.offline || !S.store?.dispatch) return;
  if (S.pricesBusy) { if (force) S.pricesAgain = true; return; }
  const age = S.prices?.updated ? Date.now() - Date.parse(S.prices.updated) : Infinity;
  if (!force && age < LIVE_MAX_AGE) return;
  S.pricesBusy = true; S.pricesError = null; drawStatus();
  const before = S.prices?.sha || null;
  try {
    await S.store.dispatch("prices.yml");
    const t0 = Date.now();
    let sha = before;
    while (sha === before && Date.now() - t0 < LIVE_TIMEOUT) {
      await new Promise((r) => setTimeout(r, 8000));
      if (!S.vault) return; // locked meanwhile
      sha = (await S.store.read("prices/latest.json"))?.sha || null;
    }
    if (sha === before) throw new Error("The price job is taking longer than usual. Prices will update on the next refresh.");
    await refreshPrices();
    await cacheVault();
    toast(`Prices updated (${timeOf(S.prices.lastQuote || S.prices.updated)}).`);
  } catch (e) { S.pricesError = e.message; toast(e.message); }
  finally {
    S.pricesBusy = false;
    if (S.vault) S.view === "record" ? drawStatus() : renderApp();
    if (S.pricesAgain && S.vault) { S.pricesAgain = false; livePrices({ force: true }); }
  }
}
const timeOf = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "–");
const dayTime = (iso) => {
  if (!iso) return "–";
  const d = new Date(iso), same = d.toDateString() === new Date().toDateString();
  return same ? `today ${timeOf(iso)}` : d.toLocaleDateString([], { day: "numeric", month: "short" }) + " " + timeOf(iso);
};

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && S.vault && !S.demo) livePrices();
});

/** Keep watchlist.json (identifiers only) in step with the positions, so the price job knows what to fetch. */
async function syncWatchlist() {
  if (S.demo || S.offline) return false;
  const want = JSON.stringify(watchlist(S.vault.db), null, 1) + "\n";
  const cur = await S.store.read("watchlist.json");
  if (cur?.text === want) return false;
  await S.store.write("watchlist.json", want, cur?.sha || null, "update");
  return true;
}

async function startDemo() {
  S.demo = true;
  const seed = migrate(await (await fetch("seed.example.json")).json());
  const { file, session } = await createVault("demo demo demo demo demo", seed, { iterations: 1000 });
  const store = new MemoryStore({ [VAULT_PATH]: { text: JSON.stringify(file), sha: "m0" } });
  const v = new Vault(store, session); await v.load();
  Object.assign(S, { store, session, vault: v, offline: false, savedAt: null, hist: demoHistory(v.db) });
  renderApp();
}

/** Made-up price history for the demo (a gentle random walk ending at today's sample prices). */
function demoHistory(db) {
  const hist = new Map(), days = [];
  for (let d = new Date(Date.now() - 864e5); days.length < 400; d = new Date(d - 864e5)) if (d.getDay() % 6) days.unshift(d.toISOString().slice(0, 10));
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  for (const p of db.positions) {
    if (!p.isin) continue;
    const ccy = db.accounts[p.acct].ccy, series = [];
    let price = p.price / (1.004 + rnd() * 0.012); // yesterday's close, so "today" shows a change
    for (let i = days.length - 1; i >= 0; i--) { series.unshift([days[i], price, ccy]); price = price / (1 + 0.0012 + rnd() * 0.022); }
    series.push([today(), p.price, ccy]);
    p.price_date = today();
    hist.set(p.isin, series);
  }
  hist.set("FX:INR", days.map((d) => [d, db.rates.INR, "EUR"]));
  return hist;
}

// ---------- commit helper ----------
async function commit(op, okMsg) {
  if (S.offline) throw new Error("You're offline. Reconnect to save changes.");
  const res = await S.vault.commit(op);
  S.savedAt = new Date();
  await cacheVault();
  // A new holding changes the watchlist: fetch its price right away.
  syncWatchlist().then((changed) => changed && livePrices({ force: true })).catch(() => {});
  if (okMsg) toast(okMsg);
  return res;
}

// ---------- app shell ----------
const VIEWS = [["overview", "Overview"], ["holdings", "Holdings"], ["record", "Record"], ["plan", "Plan"], ["settings", "Settings"]];

function renderApp() {
  const db = S.vault.db;
  const R = rows(db), T = totals(db, R);
  const top = h("header.top", h("div.page",
    h("div.brand", logo(), h("h1", "Portfolio")), h("div.status#status"), h("button.btn.icon#refresh", {
      title: "Refresh prices now", "aria-label": "Refresh prices now", hidden: S.demo || S.offline,
      on: { click: () => livePrices({ force: true }) },
    }, icon("refresh"))));
  const tabs = h("nav.tabs", { role: "tablist" }, VIEWS.map(([id, label]) =>
    h("button", { role: "tab", "aria-selected": String(S.view === id), on: { click: () => { S.view = id; renderApp(); scrollTo(0, 0); } } }, icon(id), h("span", label))));
  const main = h("main.page");
  ({ overview, holdings, record, plan, settings })[S.view](main, db, R, T);
  main.append(h("footer", "Facts about your holdings, calculated from your own rules. Not financial advice."));
  clear(root).append(top, tabs, main);
  drawStatus();
}

/** Header status: total value plus how fresh the prices are. Redrawn without touching the open view. */
function drawStatus() {
  const el = document.getElementById("status");
  if (!el || !S.vault) return;
  const T = totals(S.vault.db);
  const line2 = S.demo ? "Demo · sample data, nothing is saved"
    : S.offline ? "Offline · read only"
    : S.pricesBusy ? "Updating prices…"
    : S.prices?.updated ? `Prices ${dayTime(S.prices.lastQuote || S.prices.updated)}`
    : "No prices fetched yet";
  el.className = "status" + (S.offline || S.pricesError ? " err" : "");
  const dot = !S.demo && !S.offline && h("i.live" + (S.pricesBusy ? ".busy" : ""), { "aria-hidden": "true" });
  clear(el).append(h("b", money(T.value)), h("div.line2", dot, line2));
  const btn = document.getElementById("refresh");
  if (btn) { btn.disabled = !!S.pricesBusy; btn.classList.toggle("spin", !!S.pricesBusy); }
}

// ---------- overview ----------
function overview(m, db, R, T) {
  // ----- hero: total, today's change, all-time gain, value chart -----
  const series = seriesFor(db);
  const DC = dayChanges(db, S.hist);
  const dayChg = DC.size ? [...DC.values()].reduce((a, c) => a + c.eur, 0) : null;
  const prevTotal = dayChg != null ? T.value - dayChg : 0;
  const gainPct = T.cost ? (T.unrealized / T.cost) * 100 : 0;
  const pill = (v, text) => h("span.pill" + (v > 0 ? ".up" : v < 0 ? ".down" : ""), text);
  const lbl = h("div.lbl", "Total value"), big = h("div.big");
  const setBig = (v) => { const [whole, cents] = money(v).split("."); clear(big).append(whole, cents && h("span.cents", "." + cents)); };
  setBig(T.value);
  const rangeChg = h("span.rchg");
  const hero = h("section.hero", lbl, big, h("div.pills",
    dayChg != null && pill(dayChg, `${signed(dayChg)} (${pct(prevTotal ? (dayChg / prevTotal) * 100 : 0, true)}) today`),
    rangeChg));
  m.append(hero);

  // value chart with ranges (1W … All) and tap/drag to inspect a date
  const full = [...series.filter(([d]) => d < today()), [today(), T.value]];
  if (full.length >= 3) {
    const chartBox = h("div.chart"), axis = h("div.axis");
    const chips = h("div.ranges", { role: "group", "aria-label": "Chart range" });
    const draw = () => {
      const pts = inRange(full, S.range);
      const first = pts[0][1], last = pts.at(-1)[1], d = last - first;
      clear(rangeChg).append(pill(d, `${signed(d)} (${pct(first ? (d / first) * 100 : 0, true)}) ${S.range === "All" ? "all" : S.range}`));
      clear(chips).append(...RANGES.map(([k]) => h("button", { "aria-pressed": String(S.range === k), on: { click: () => { S.range = k; try { localStorage.setItem("pt.range", k); } catch {} draw(); } } }, k)));
      clear(chartBox).append(heroChart(pts, (i) => {
        if (i == null) { lbl.textContent = "Total value"; setBig(T.value); return; }
        lbl.textContent = fmtDate(pts[i][0]); setBig(pts[i][1]);
      }));
      clear(axis).append(h("span", fmtDate(pts[0][0])), h("span", fmtDate(pts.at(-1)[0])));
    };
    hero.append(h("div.rangebar", chips), chartBox, axis);
    draw();
  } else hero.append(h("div.empty", S.demo ? "" : "Loading your price history. The chart appears after the next price refresh (about a minute)."));

  m.append(h("div.kpis",
    kpi("Invested", money(T.cost, "EUR", 0)),
    kpi("Unrealized", money(T.unrealized, "EUR", 0), h("span.pill." + (cls(T.unrealized) || "neutral"), pct(gainPct, true))),
    kpi("Realized", money(T.realized, "EUR", 0)),
    kpi("Holdings", String(R.length), h("span.pill.neutral", `${Object.keys(db.accounts).length} accounts`))));

  if (T.missing.length) m.append(h("p.note", `Missing exchange rate for ${T.missing.join(", ")}. Those positions are not in the totals yet.`));
  if (!R.length) return m.append(h("div.card", h("p.mu", "No holdings yet. Go to Record → Import file to add them.")));

  // ----- top holdings with today's move -----
  const topRows = sortRows(R, "valEUR").slice(0, 8);
  const moveOf = (r) => DC.get(r.id);
  m.append(h("div.sect", h("h2", "Top holdings"), h("button.link", { on: { click: () => { S.view = "holdings"; renderApp(); scrollTo(0, 0); } } }, `All ${R.length} →`)),
    h("div.tops", topRows.map((r) => {
      const mv = moveOf(r);
      return h("button.top-row", { on: { click: () => { S.openRows.add(r.id); S.view = "holdings"; renderApp(); } } },
        avatar(r.sym, r.cls),
        h("div.nm", h("b", r.sym), h("span", `${r.cls} · ${r.weight?.toFixed(1) ?? "–"}%`)),
        h("div.val", h("b", money(r.valEUR ?? r.val, r.valEUR == null ? r.ccy : "EUR", 0)),
          mv ? h("span." + (cls(mv.pct) || "mu"), `${mv.pct > 0 ? "▲" : mv.pct < 0 ? "▼" : ""} ${pct(Math.abs(mv.pct))} · ${signed(mv.eur)}`)
            : h("span.mu", r.cls === "Cash" ? "cash" : r.cls === "Insurance (ULIP)" ? "value set by you" : "no change yet")));
    })));
  if (T.estValue) m.append(h("p.note", `~ marks holdings whose purchase price is unknown (${((T.estValue / T.value) * 100).toFixed(0)}% of the portfolio). Their gains are estimates. Fix them via Holdings → Set real cost.`));

  const byCls = groupBy(R, "cls"), byAcct = groupBy(R, "acct");
  const known = sortRows(R.filter((r) => !r.est && Math.abs(r.gainPct) > 0.05), "gainPct");
  const movers = known.length > 6 ? [...known.slice(0, 3), ...known.slice(-3)] : known;
  m.append(h("div.grid", { style: { marginTop: "14px" } },
    h("div.card", h("h3", "Allocation"), donut(byCls, T.value, { center: compact(T.value), sub: `${byCls.length} types`, colorOf: (n, i) => classColor(n, i) })),
    h("div.card", h("h3", "Best and worst (known cost)"), movers.length
      ? h("div.movers", movers.map((r) => h("div.mover", avatar(r.sym, r.cls), h("div.nm", r.sym), h("span.pill." + (cls(r.gain) || "neutral"), pct(r.gainPct, true)))))
      : h("p.mu.sm", "Appears once holdings have real purchase costs.")),
    h("div.card", h("h3", "By account"), bars(byAcct.map(([a, v]) => [db.accounts[a]?.name || a, v]), (v) => compact(v)))));
  if (S.prices?.updated) m.append(h("p.sm.mu", `Stocks, ETFs and exchange rates: latest quotes, as of ${dayTime(S.prices.lastQuote || S.prices.updated)} (free sources can be up to 15 minutes delayed). Mutual funds and the ULIP have one price per day.` + (S.prices.misses?.length ? ` Not found: ${S.prices.misses.join(", ")}.` : "")));
  else if (!S.demo) m.append(h("p.sm.mu", S.prices?.error ? `Prices could not be loaded: ${S.prices.error}` : "No prices yet. Tap ↻ to fetch them (takes about a minute)."));
  if (S.pricesError) m.append(h("p.note", S.pricesError));
}
const RANGES = [["1W", 7], ["1M", 30], ["3M", 91], ["YTD", null], ["1Y", 365], ["All", Infinity]];
try { S.range = localStorage.getItem("pt.range") || "1Y"; } catch { S.range = "1Y"; }
function inRange(pts, key) {
  const days = RANGES.find(([k]) => k === key)?.[1];
  const from = days === null ? new Date().getFullYear() + "-01-01"
    : days === Infinity ? "0000" : new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const out = pts.filter(([d]) => d >= from);
  return out.length >= 2 ? out : pts.slice(-2);
}
const fmtDate = (d) => new Date(d + "T12:00:00").toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
/** Value series is costly with years of history: compute once per data/history change. */
let seriesCache = { key: null, val: [] };
function seriesFor(db) {
  if (!S.hist) return [];
  const key = `${db.updated}|${S.hist.size}|${S.histStamp || ""}|${db.positions.length}`;
  if (seriesCache.key !== key) seriesCache = { key, val: valueSeries(db, S.hist) };
  return seriesCache.val;
}

function kpi(label, value, extra) { return h("div.kpi", h("span", label), h("b", value), extra); }
const signed = (v, ccy = "EUR") => (v > 0 ? "+" : "") + money(v, ccy, Math.abs(v) < 10 ? 2 : 0);
function compact(v) {
  const a = Math.abs(v);
  return a >= 1e6 ? "€" + (v / 1e6).toFixed(2) + "M" : a >= 1e4 ? "€" + (v / 1e3).toFixed(1) + "k" : money(v, "EUR", 0);
}

// ---------- holdings ----------
function holdings(m, db, R, T) {
  const f = S.filters, F = facets(R);
  const sel = (key, label, opts, fmt = (x) => x) => {
    const el = h("select", { "aria-label": label, on: { change: () => { f[key] = el.value || undefined; renderApp(); } } },
      h("option", { value: "" }, label), opts.map((o) => h("option", { value: o, selected: f[key] === o }, fmt(o))));
    return el;
  };
  const q = h("input.search", { type: "search", placeholder: "Search name or ISIN", value: f.q || "", "aria-label": "Search" });
  q.addEventListener("input", () => { f.q = q.value; drawList(); });
  const sortSel = h("select", { "aria-label": "Sort", on: { change: () => { S.sort = sortSel.value; drawList(); } } },
    [["valEUR:-1", "Value ↓"], ["gainPct:-1", "Gain % ↓"], ["gainPct:1", "Gain % ↑"], ["gainEUR:-1", "Gain € ↓"], ["weight:-1", "Weight ↓"], ["sym:1", "Name A–Z"], ["firstDate:1", "Oldest first"]]
      .map(([v, l]) => h("option", { value: v, selected: S.sort === v }, l)));
  m.append(h("div.filters", q,
    sel("acct", "All accounts", F.acct, (a) => db.accounts[a]?.name || a), sel("cls", "All types", F.cls), sel("ccy", "All currencies", F.ccy),
    sel("result", "Gain or loss", ["gain", "loss", "est"], (x) => ({ gain: "Gains only", loss: "Losses only", est: "Estimated cost (~)" })[x]), sortSel));
  const head = h("div.listhead"), list = h("div.list");
  m.append(head, list);
  function drawList() {
    const [k, d] = S.sort.split(":");
    const shown = sortRows(filterRows(R, f), k, +d);
    const v = shown.reduce((a, r) => a + (r.valEUR || 0), 0), g = shown.reduce((a, r) => a + (r.gainEUR || 0), 0);
    clear(head).append(h("span", `${shown.length} of ${R.length} positions`), h("span", money(v), " · ", h("span." + (cls(g) || "mu"), money(g))));
    clear(list).append(...(shown.length ? shown.map((r) => item(r, db)) : [h("p.mu.sm.page", "No positions match these filters.")]));
  }
  drawList();
}

function item(r, db) {
  const open = S.openRows.has(r.id);
  const el = h("div.item");
  const btn = h("button", { "aria-expanded": String(open), on: { click: () => { open ? S.openRows.delete(r.id) : S.openRows.add(r.id); el.replaceWith(item(r, db)); } } },
    avatar(r.sym, r.cls),
    h("div.nm", r.sym, r.est && h("span.badge.warn", { title: "Purchase price unknown" }, "~ est")),
    h("div.v", money(r.valEUR ?? r.val, r.valEUR == null ? r.ccy : "EUR")),
    h("div.sub", `${r.account} · ${r.cls} · ${r.weight != null ? r.weight.toFixed(1) + "%" : "–"}`),
    h("div.g", h("span.pill." + (cls(r.gain) || "neutral"), (r.est ? "~" : "") + pct(r.gainPct, true))));
  el.append(btn);
  if (open) {
    const trades = db.trades.filter((t) => t.pid === r.id).slice(-10).reverse();
    el.append(h("div.detail",
      h("div.kv",
        kv("Quantity", r.qty.toLocaleString("en-US", { maximumFractionDigits: 4 })), kv("Avg cost", money(r.avg, r.ccy)),
        kv("Price", money(r.price, r.ccy)), kv("Price as of", (r.price_time ? dayTime(r.price_time) : r.price_date || "unknown") + (r.price_src ? ` (${r.price_src})` : "")),
        kv("Value", money(r.val, r.ccy)), kv("Invested", money(r.cost, r.ccy)),
        kv("ISIN", r.isin || "–"), kv("Held since", r.firstDate || "unknown")),
      r.lots.length > 1 && h("details", h("summary.sm", `${r.lots.length} purchase lots (FIFO)`), h("div.scroll", h("table.mini",
        h("tr", h("th", "Date"), h("th", "Qty"), h("th", "Cost")),
        r.lots.map((l) => h("tr", h("td", (l.date || "unknown") + (l.est ? " ~" : "")), h("td", l.qty ? l.qty.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "–"), h("td", money(l.cost, r.ccy))))))),
      trades.length > 0 && h("details", h("summary.sm", "Recent transactions"), h("div.scroll", h("table.mini",
        h("tr", h("th", "Date"), h("th", "Type"), h("th", "Qty"), h("th", "Price"), h("th", "Realized")),
        trades.map((t) => h("tr", h("td", t.date), h("td", t.side), h("td", t.qty || "–"), h("td", money(t.price, r.ccy)), h("td." + cls(t.realized || 0), t.realized != null ? (t.est ? "~" : "") + money(t.realized, r.ccy) : "")))))),
      h("div.row", { style: { marginTop: "8px" } },
        r.cls === "Insurance (ULIP)" && h("button.btn", { on: { click: () => goRecord({ kind: "contribution", acct: r.acct, pid: r.id }) } }, "Add payment"),
        h("button.btn", { on: { click: () => goRecord({ kind: "buy", acct: r.acct, pid: r.id }) } }, "Buy"),
        h("button.btn", { on: { click: () => goRecord({ kind: "sell", acct: r.acct, pid: r.id }) } }, "Sell"),
        h("button.btn", { on: { click: () => goRecord({ kind: "price", acct: r.acct, pid: r.id }) } }, "Set price"),
        h("button.btn", { on: { click: () => goRecord({ kind: "cost", acct: r.acct, pid: r.id }) } }, r.est ? "Set real cost" : "Set cost"))));
  }
  return el;
}
const kv = (k, v) => h("div", h("span", k), v);
function goRecord(prefill) { S.recordPrefill = prefill; S.view = "record"; renderApp(); scrollTo(0, 0); }

// ---------- record ----------
const KINDS = [["buy", "Buy"], ["sell", "Sell"], ["price", "Set price"], ["cost", "Set cost"], ["contribution", "ULIP payment"], ["import", "Import file"]];

function record(m, db) {
  const pre = S.recordPrefill || {}; S.recordPrefill = null;
  let kind = pre.kind || S.lastKind || "buy";
  const seg = h("div.seg", { role: "group", "aria-label": "Type" });
  const body = h("div");
  const drawSeg = () => clear(seg).append(...KINDS.map(([k, l]) =>
    h("button", { "aria-pressed": String(kind === k), on: { click: () => { kind = k; S.lastKind = k; drawSeg(); draw(); } } }, l)));
  const draw = () => { clear(body); kind === "import" ? importForm(body) : tradeForm(body, kind, pre); };
  drawSeg(); draw();
  if (S.offline) m.append(h("p.note", "You're offline. Changes can't be saved until you reconnect."));
  m.append(seg, h("div.card", body));
}

function tradeForm(box, kind, pre) {
  const db = S.vault.db;
  const accts = Object.entries(db.accounts);
  const acct = h("select", accts.map(([id, a]) => h("option", { value: id, selected: pre.acct === id }, `${a.name} (${a.ccy})`)));
  const pos = h("select");
  const fillPos = () => {
    const list = db.positions.filter((p) => p.acct === acct.value && (kind === "buy" || p.qty > 0) && (kind !== "contribution" || p.cls === "Insurance (ULIP)" || p.qty > 0));
    clear(pos).append(...list.map((p) => h("option", { value: p.id, selected: pre.pid === p.id }, p.sym)),
      ...(kind === "buy" ? [h("option", { value: "__new" }, "New position…")] : []));
    if (!list.length && kind !== "buy") pos.append(h("option", { value: "" }, "No positions in this account"));
  };
  const name = h("input", { placeholder: "e.g. Vanguard FTSE All-World" });
  const isin = h("input", { placeholder: "e.g. INF209K01YN0", autocapitalize: "characters" });
  const clsSel = h("select", ["Stock", "ETF", "Equity fund", "Debt fund", "Hybrid fund", "Gold", "Cash", "Insurance (ULIP)", "Other"].map((c) => h("option", c)));
  const newBox = h("div.form.full", field("Name", name), field("ISIN", isin, "Needed for automatic prices. Not needed for the ULIP or cash."), field("Asset type", clsSel));
  const dec = (ph) => h("input", { inputmode: "decimal", autocomplete: "off", placeholder: ph });
  const qty = dec("0"), price = dec("0.00"), fee = dec("0.00"), amount = dec("0.00");
  const date = h("input", { type: "date", value: today(), max: today() });
  const costDate = h("input", { type: "date", max: today() });
  const preview = h("div.note.ok", { "aria-live": "polite" }, "Fill in the fields to see the result.");
  const err = errBox();
  const save = h("button.btn.primary", { type: "submit", disabled: S.offline }, "Save");

  const ccy = () => db.accounts[acct.value]?.ccy || "EUR";
  const symOf = () => (pos.value === "__new" ? name.value.trim() : pos.value);
  const op = () => {
    const base = { acct: acct.value, sym: symOf(), date: date.value || today() };
    if (!base.sym) throw new Error("Choose a position or enter a name.");
    if (kind === "buy" || kind === "sell") return { type: "trade", side: kind, ...base, qty: num(qty.value), price: num(price.value), fee: num(fee.value), ...(pos.value === "__new" ? { cls: clsSel.value, isin: isin.value.trim().toUpperCase() } : {}) };
    if (kind === "price") return { type: "price", ...base, price: num(price.value) };
    if (kind === "cost") return { type: "cost", acct: base.acct, sym: base.sym, cost: num(amount.value), date: costDate.value || null };
    return { type: "contribution", ...base, amount: num(amount.value) };
  };
  const update = () => {
    err.textContent = "";
    newBox.hidden = pos.value !== "__new";
    try {
      const o = op();
      const { db: after, result } = S.vault.preview(o);
      const p = after.positions.find((x) => x.id === result.pid);
      const c = ccy();
      const lines = [`${p.sym}: ${p.qty.toLocaleString("en-US", { maximumFractionDigits: 4 })} units, invested ${money(p.cost, c)}${p.qty ? `, avg cost ${money(p.cost / p.qty, c)}` : ""}.`];
      if (kind === "buy") lines.push(`Total paid: ${money(o.qty * o.price + (o.fee || 0), c)}.`);
      if (kind === "sell") lines.push(`Proceeds ${money(o.qty * o.price - (o.fee || 0), c)}, cost of units sold (FIFO) ${money(result.basis, c)}, realized ${result.est ? "~" : ""}${money(result.realized, c)}.`);
      if (kind === "price") lines.push(`New value ${money(p.qty * p.price, c)}.`);
      if (kind === "cost") { const g = p.qty * p.price - p.cost; lines.push(`Gain at the current price: ${money(g, c)} (${pct(p.cost ? (g / p.cost) * 100 : 0, true)}). No longer marked as estimated.`); }
      clear(preview).append(...lines.map((l) => h("div", l)));
      return o;
    } catch (e) { clear(preview).append(e.message); return null; }
  };
  const fields = [];
  fields.push(field("Account", acct), field("Position", pos), newBox);
  if (kind === "buy" || kind === "sell") fields.push(h("div.form.full", field("Quantity", qty), field("Price per unit", price, "In the account's currency (Degiro: EUR)."), field("Fees", fee), field("Date", date)));
  if (kind === "price") fields.push(h("div.form.full", field("Price per unit", price, "For the ULIP, enter the total fund value."), field("Price date", date)));
  if (kind === "cost") fields.push(h("div.form.full",
    field("Total invested", amount, "What you paid in total for the units you hold now, in the account's currency. Degiro: Wert minus Unrealisierter G/V (€)."),
    field("First bought (optional)", costDate, "Used for holding periods and tax.")));
  if (kind === "contribution") fields.push(h("div.form.full", field("Amount paid", amount, "Adds to the money invested; set the new fund value with 'Set price'."), field("Date", date)));
  const form = h("form", {
    on: {
      input: update, change: update,
      submit: async (e) => {
        e.preventDefault();
        const o = update(); if (!o) return;
        busy(save, true, "Saving…");
        try { await commit(o, "Saved."); S.recordPrefill = { kind, acct: o.acct }; renderApp(); }
        catch (e2) { err.textContent = e2.message; busy(save, false, "Save"); }
      },
    },
  }, fields, preview, err, save);
  acct.addEventListener("change", () => { fillPos(); update(); });
  fillPos();
  if (pre.pid && kind === "price") { const p = db.positions.find((x) => x.id === pre.pid); if (p) price.value = String(p.price); }
  newBox.hidden = pos.value !== "__new";
  box.append(form);
}

function importForm(box) {
  const file = h("input", { type: "file", accept: ".csv,text/csv" });
  const out = h("div");
  const err = errBox();
  let pending = null;
  const show = async (text, name) => {
    err.textContent = ""; clear(out); pending = null;
    try {
      const { op, notes } = await degiroPortfolioOp(text, name, today());
      const { db: after, result } = S.vault.preview(op);
      if (result.skipped) return (err.textContent = result.reason);
      const before = S.vault.db;
      const changes = op.ops.map((o) => {
        const a = o.isin ? after.positions.find((p) => p.acct === "degiro" && p.isin === o.isin) : findPos(after, "degiro", o.sym);
        const b = o.isin ? before.positions.find((p) => p.acct === "degiro" && p.isin === o.isin) : findPos(before, "degiro", o.sym);
        return h("tr", h("td", a.sym, !b && h("span.badge.warn", "new ~")), h("td", b ? b.qty.toLocaleString("en-US") : "–"), h("td", a.qty.toLocaleString("en-US")), h("td", money(a.price)));
      });
      pending = op;
      out.append(h("p.sm.mu", `${name}: ${op.ops.length} rows.`, notes.length ? " " + notes.join(" · ") : ""),
        h("div.scroll", h("table.mini", h("tr", h("th", "Position"), h("th", "Qty before"), h("th", "Qty after"), h("th", "Price €")), changes)),
        h("p.sm.mu", "Quantity changes without a recorded trade are added as estimated lots (~). Record real buys and sells to keep gains exact."),
        h("button.btn.primary", { disabled: S.offline, on: { click: async (e) => {
          busy(e.target, true, "Saving…");
          try { await commit(pending, "Degiro prices updated."); renderApp(); } catch (e2) { err.textContent = e2.message; busy(e.target, false, "Apply import"); }
        } } }, "Apply import"));
    } catch (e) { err.textContent = e.message; }
  };
  file.addEventListener("change", async () => { const f = file.files[0]; if (f) show(await f.text(), f.name); });

  // seed.json: a whole starting portfolio (all accounts) in one step
  const seedFile = h("input", { type: "file", accept: ".json,application/json" });
  seedFile.addEventListener("change", async () => {
    const f = seedFile.files[0]; if (!f) return;
    err.textContent = ""; clear(out); pending = null;
    try {
      const text = await f.text();
      const op = { type: "import", file: { name: f.name, hash: await sha256(text), date: today(), kind: "seed" }, ops: [{ type: "seed", data: JSON.parse(text) }] };
      const { db: after, result } = S.vault.preview(op);
      if (result.skipped) return (err.textContent = result.reason);
      const { added, skipped } = result.results[0];
      const R2 = rows(after).filter((r) => added.includes(r.sym));
      pending = op;
      out.append(
        h("p.sm.mu", `${f.name}: ${added.length} holdings to add` + (skipped.length ? `, ${skipped.length} already in your vault and skipped (${skipped.join(", ")})` : "") + "."),
        h("div.scroll", h("table.mini", h("tr", h("th", "Holding"), h("th", "Account"), h("th", "Type"), h("th", "Qty"), h("th", "Value")),
          R2.map((r) => h("tr", h("td", r.sym, r.est && h("span.badge.warn", "~")), h("td", r.account), h("td", r.cls), h("td", r.qty.toLocaleString("en-US", { maximumFractionDigits: 4 })), h("td", money(r.val, r.ccy, 0)))))),
        h("button.btn.primary", { disabled: S.offline || !added.length, on: { click: async (e) => {
          busy(e.target, true, "Saving…");
          try { await commit(pending, `${added.length} holdings added.`); S.view = "holdings"; renderApp(); }
          catch (e2) { err.textContent = e2.message; busy(e.target, false, "Add holdings"); }
        } } }, "Add holdings"));
    } catch (e) { err.textContent = e instanceof SyntaxError ? "This file isn't valid JSON." : e.message; }
  });
  box.append(field("seed.json: all accounts at once (Degiro, India, ULIP)", seedFile, "Read on this device and saved encrypted. Holdings already in your vault are skipped."), h("hr"));

  box.append(field("Degiro Portfolio.csv", file, "Degiro → Portfolio → Export → CSV. The file is read on this device and archived inside your encrypted vault."));
  if (folder.supported()) {
    const btnPick = h("button.btn", { type: "button" }, "Choose imports folder");
    const btnLatest = h("button.btn", { type: "button" }, "Import newest from folder");
    const info = h("span.sm.mu");
    folder.name().then((n) => { info.textContent = n ? `Folder: ${n}` : "No folder chosen yet."; btnLatest.disabled = !n; });
    btnPick.addEventListener("click", async () => { try { const n = await folder.pick(); info.textContent = `Folder: ${n}`; btnLatest.disabled = false; } catch (e) { if (e.name !== "AbortError") err.textContent = e.message; } });
    btnLatest.addEventListener("click", async () => { try { const f = await folder.newest(/portfolio.*\.csv$/i); if (!f) return (err.textContent = "No Portfolio*.csv in that folder."); show(await f.text(), f.name); } catch (e) { err.textContent = e.message; } });
    box.append(h("div.row", btnPick, btnLatest, info));
  }
  box.append(err, out);
}

// ---------- plan ----------
function plan(m, db, R, T) {
  const C = checks(db, R, T);
  m.append(h("h2", "Checks"), C.length
    ? h("div.list", C.map((c) => h("div.item", h("div.detail", { style: { paddingTop: "10px" } }, h("div", h("b", c.title), c.level === "warn" && h("span.badge.warn", "attention")), h("div.mu", c.detail)))))
    : h("p.note.ok", "Nothing to flag under your current rules."));

  const A = allocation(db, R, T);
  const inputs = {};
  m.append(h("h2", "Allocation vs. your targets"),
    h("p.sm.mu", `Rebalancing band: ${db.rules.bandAbs} points absolute or ${db.rules.bandRel}% of the target, whichever is smaller (the 5/25 rule).`),
    h("div.card.scroll", h("table.mini",
      h("tr", h("th", "Asset type"), h("th", "Value"), h("th", "Now"), h("th", "Target %"), h("th", "Difference")),
      A.map((a) => {
        inputs[a.cls] = h("input", { inputmode: "decimal", value: a.target ?? "", style: { width: "72px", minHeight: "32px", padding: "4px 6px" }, "aria-label": `Target for ${a.cls}` });
        return h("tr", h("td", a.cls), h("td", money(a.value, "EUR", 0)), h("td", a.pct.toFixed(1) + "%"), h("td", inputs[a.cls]),
          h("td." + (a.outside ? "loss" : "mu"), a.diffPct == null ? "–" : `${a.diffPct > 0 ? "+" : ""}${a.diffPct.toFixed(1)} pts (${money(a.diffEUR, "EUR", 0)})${a.outside ? " outside band" : ""}`));
      }))),
    h("div.row", { style: { marginTop: "8px" } }, h("button.btn", { on: { click: async () => {
      const targets = {};
      for (const [k, el] of Object.entries(inputs)) if (el.value.trim()) targets[k] = num(el.value);
      const sum = Object.values(targets).reduce((a, b) => a + b, 0);
      if (Object.keys(targets).length && Math.abs(sum - 100) > 0.5) return toast(`Targets add up to ${sum.toFixed(1)}%, not 100%.`);
      try { await commit({ type: "rules", patch: { targets } }, "Targets saved."); renderApp(); } catch (e) { toast(e.message); }
    } } }, "Save targets")));

  const amt = h("input", { inputmode: "decimal", placeholder: "e.g. 2000" });
  const res = h("div");
  amt.addEventListener("input", () => {
    clear(res);
    const x = num(amt.value || "0");
    if (!x) return;
    const split = splitNewMoney(A, T.value, x);
    res.append(split.length ? h("table.mini", split.map((s2) => h("tr", h("td", s2.cls), h("td", money(s2.amount, "EUR", 0)))))
      : h("p.sm.mu", "Set targets above first."));
  });
  m.append(h("h2", "New money"), h("div.card", field("Amount to invest (EUR)", amt, "Splits the amount across asset types below target, so the mix moves toward your targets. It doesn't pick products."), res));

  const rf = (k, label, hint) => { const el = h("input", { inputmode: "decimal", value: db.rules[k] }); el.dataset.k = k; return field(label, el, hint); };
  const rulesForm = h("form.form", {
    on: { submit: async (e) => {
      e.preventDefault();
      const patch = {};
      for (const el of rulesForm.querySelectorAll("input[data-k]")) patch[el.dataset.k] = num(el.value);
      try { await commit({ type: "rules", patch }, "Rules saved."); renderApp(); } catch (e2) { toast(e2.message); }
    } },
  }, rf("maxWeight", "Single-stock limit (%)"), rf("takeProfitPct", "Review gains above (%)"), rf("bandAbs", "Band, absolute (pts)"), rf("bandRel", "Band, relative (%)"), rf("staleDays", "Price is stale after (days)"),
    h("div.full", h("button.btn", { type: "submit" }, "Save rules")));
  m.append(h("h2", "Your rules"), h("div.card", rulesForm),
    h("p.sm.mu", "Coming next: tax estimates for a sale (Germany and India), take-money-out planner, XIRR and time-weighted return."));
}

// ---------- settings ----------
function settings(m, db) {
  const d = S.device || {};
  let theme = "dark"; try { theme = localStorage.getItem("pt.theme") || "dark"; } catch {}
  const themeSel = h("select", { on: { change: () => { try { localStorage.setItem("pt.theme", themeSel.value); } catch {} applyTheme(); } } },
    [["dark", "Dark"], ["light", "Light"], ["auto", "Match system"]].map(([v, l]) => h("option", { value: v, selected: theme === v }, l)));
  m.append(h("h2", "This device"), h("div.card",
    h("div.kv", kv("Vault", S.demo ? "Demo (in memory)" : `${d.owner}/${d.repo}`), kv("Positions", String(db.positions.filter((p) => p.qty > 0).length)), kv("Transactions", String(db.trades.length)), kv("Imports", String(db.imports.length)), kv("App version", document.querySelector('meta[name="app-version"]')?.content || "dev")),
    field("Appearance", themeSel),
    h("div.row", h("button.btn", { on: { click: () => lock("Locked.") } }, "Lock now"),
      !S.demo && h("button.btn", { on: { click: exportBackup } }, "Download encrypted backup"))));

  if (S.demo) return;
  const oldP = h("input", { type: "password", autocomplete: "current-password" });
  const newP = h("input", { type: "password", autocomplete: "new-password" });
  const err = errBox();
  const go = h("button.btn", { type: "submit" }, "Change passphrase");
  m.append(h("h2", "Passphrase"), h("div.card", h("form", {
    on: { submit: async (e) => {
      e.preventDefault(); err.textContent = ""; busy(go, true, "Working…");
      try {
        const f = await S.store.read(VAULT_PATH);
        const r = await changePassphrase(JSON.parse(f.text), oldP.value, newP.value);
        await S.store.write(VAULT_PATH, JSON.stringify(r.file), f.sha, "update");
        S.session = r.session; S.vault.session = r.session; await S.vault.load(); await cacheVault();
        toast("Passphrase changed. Other devices need the new one next time."); renderApp();
      } catch (e2) { err.textContent = e2.message; busy(go, false, "Change passphrase"); }
    } },
  }, field("Current passphrase", oldP), field("New passphrase", newP, "Your recovery key keeps working."), err, go)));
  m.append(h("h2", "Remove"), h("div.card", h("p.sm.mu", "Removes the saved connection and encrypted copy from this browser. The vault on GitHub is not touched."),
    h("button.btn.danger", { on: { click: () => { if (confirm("Forget this device?")) { writeDevice(null); lock(); } } } }, "Forget this device")));
}

async function exportBackup() {
  const file = await encryptData(S.session, S.vault.db);
  const a = h("a", { href: URL.createObjectURL(new Blob([JSON.stringify(file)], { type: "application/octet-stream" })), download: `portfolio-${today()}.enc` });
  document.body.append(a); a.click(); a.remove();
}

addEventListener("hashchange", () => { if (location.hash === "#demo" && !S.session) boot(); });
boot();
