#!/usr/bin/env node
// Daily price job. Runs in the PRIVATE vault repo's GitHub Action, Node 20+, built-ins only.
// It never sees the passphrase or any quantities: it reads watchlist.json (identifiers only)
// and writes public market data to prices/latest.json and prices/history.csv.
//
// Sources (public, no login):
//   ECB daily reference rates (FX)         https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml
//   AMFI NAVAll.txt (Indian mutual funds)  https://www.amfiindia.com/spages/NAVAll.txt
//   Yahoo Finance search + chart (unofficial) for stocks/ETFs/ETCs by ISIN; Stooq CSV as fallback
//
// Usage: node fetch-prices.mjs <vault-dir>       (expects <vault-dir>/watchlist.json)
//        node fetch-prices.mjs --selftest         (parsers only, no network)
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const UA = "Mozilla/5.0 (compatible; personal-portfolio-price-job)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, { json = false, tries = 3 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: json ? "application/json" : "*/*" }, signal: AbortSignal.timeout(30000) });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.final = true; throw e; }
      return json ? await res.json() : await res.text();
    } catch (e) { last = e; if (e.final) break; await sleep(1500 * (i + 1)); }
  }
  throw new Error(`${url.split("?")[0]}: ${last.message}`);
}

// ---------- parsers (pure; covered by --selftest) ----------

/** ECB XML -> {CCY: EUR per 1 unit}, date */
export function parseECB(xml) {
  const date = (xml.match(/time=['"](\d{4}-\d{2}-\d{2})['"]/) || [])[1];
  const fx = {};
  for (const m of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) fx[m[1]] = 1 / parseFloat(m[2]);
  return { date, fx };
}

/**
 * AMFI NAVAll.txt -> Map(ISIN -> {nav, date}).
 * Columns are read from the header line, because AMFI changes them (Nov 2026 added "Plan;Option" before the NAV):
 *   Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;[Plan;Option;]Net Asset Value;Date
 */
export function parseAMFI(txt) {
  const out = new Map();
  const lines = txt.split(/\r?\n/);
  const head = (lines.find((l) => /net asset value/i.test(l)) || "").split(";").map((s) => s.trim().toLowerCase());
  const iNav = head.findIndex((s) => s.startsWith("net asset value"));
  const iDate = head.findIndex((s) => s === "date");
  for (const line of lines) {
    const p = line.split(";");
    if (p.length < 6) continue;
    const navCol = iNav >= 0 && p.length === head.length ? iNav : p.length - 2; // fallback: NAV and date are the last two
    const dateCol = iDate >= 0 && p.length === head.length ? iDate : p.length - 1;
    const nav = parseFloat(p[navCol]);
    if (!Number.isFinite(nav)) continue;
    const date = amfiDate(p[dateCol].trim());
    for (const isin of [p[1].trim(), p[2].trim()]) if (/^[A-Z]{2}[A-Z0-9]{10}$/.test(isin)) out.set(isin, { nav, date });
  }
  return out;
}
const MON = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
function amfiDate(s) { const m = s.match(/^(\d{2})-([A-Za-z]{3})-(\d{4})$/); return m ? `${m[3]}-${MON[m[2]]}-${m[1]}` : s; }

/** Exchange preference when an ISIN trades in several places. EUR listings first (Degiro, Munich). */
const PREF = [".DE", ".F", ".AS", ".PA", ".MI", ".BR", ".MC", ".VI", ".SW", ".L", "", ".NS", ".BO"];
export function pickSymbol(quotes, preferIndia) {
  const ok = quotes.filter((q) => q.symbol && ["EQUITY", "ETF", "MUTUALFUND", "INDEX"].includes(q.quoteType ?? "EQUITY"));
  const suffix = (s) => (s.includes(".") ? s.slice(s.lastIndexOf(".")) : "");
  const order = preferIndia ? [".NS", ".BO", ...PREF] : PREF;
  const rank = (q) => { const i = order.indexOf(suffix(q.symbol)); return i < 0 ? 99 : i; };
  return ok.sort((a, b) => rank(a) - rank(b))[0]?.symbol || null;
}

/** OpenFIGI exchange code -> Yahoo suffix (only the exchanges relevant here). */
const FIGI_EXCH = { GY: ".DE", GR: ".DE", GF: ".F", NA: ".AS", FP: ".PA", IM: ".MI", BB: ".BR", SM: ".MC", AV: ".VI", SW: ".SW", SE: ".SW", LN: ".L", US: "", UN: "", UW: "", UQ: "", UA: "", IS: ".NS", IB: ".BO" };
/** OpenFIGI mapping response -> Yahoo symbol, preferring the same order as pickSymbol. */
export function figiToYahoo(data, preferIndia) {
  const cands = (data || []).filter((d) => d.ticker && d.exchCode in FIGI_EXCH)
    .map((d) => ({ symbol: d.ticker.replace(/\s+/g, "-").replace(/\/.*$/, "") + FIGI_EXCH[d.exchCode], quoteType: "EQUITY" }));
  return pickSymbol(cands, preferIndia);
}

/** Yahoo chart JSON -> {price, ccy, date}; converts pence (GBp) to GBP. */
export function parseYahooChart(j) {
  const m = j?.chart?.result?.[0]?.meta;
  if (!m || !Number.isFinite(m.regularMarketPrice)) return null;
  let price = m.regularMarketPrice, ccy = m.currency;
  if (ccy === "GBp" || ccy === "GBX") { price /= 100; ccy = "GBP"; }
  if (ccy === "ZAc") { price /= 100; ccy = "ZAR"; }
  const t = new Date(m.regularMarketTime * 1000).toISOString();
  return { price, ccy, date: t.slice(0, 10), time: t };
}

/** Stooq symbol from a Yahoo symbol (SAP.DE -> sap.de, AAPL -> aapl.us). */
export function stooqSymbol(y) {
  const s = y.toLowerCase();
  if (!s.includes(".")) return s + ".us";
  return s.replace(/\.l$/, ".uk");
}
export function parseStooq(csv) {
  const [head, row] = csv.trim().split(/\r?\n/);
  if (!row) return null;
  const h = head.split(","), v = row.split(",");
  const close = parseFloat(v[h.indexOf("Close")]), date = v[h.indexOf("Date")];
  return Number.isFinite(close) ? { price: close, date } : null;
}

// ---------- job ----------

async function run(dir) {
  const wl = JSON.parse(await readFile(join(dir, "watchlist.json"), "utf8"));
  const outDir = join(dir, "prices");
  await mkdir(outDir, { recursive: true });
  const symPath = join(outDir, "symbols.json");
  const symbols = existsSync(symPath) ? JSON.parse(await readFile(symPath, "utf8")) : {};
  const prevPath = join(outDir, "latest.json");
  const prev = existsSync(prevPath) ? JSON.parse(await readFile(prevPath, "utf8")) : { fx: {}, quotes: {} };
  const out = { updated: new Date().toISOString(), fx: { ...prev.fx }, quotes: { ...prev.quotes }, misses: [] };
  const log = (...a) => console.log(...a);

  // FX: ECB reference rates (official, once a day), then live Yahoo rates on top where available.
  try {
    const { date, fx } = parseECB(await get("https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"));
    for (const c of wl.fx || []) if (fx[c]) out.fx[c] = { rate: fx[c], date, src: "ecb" };
  } catch (e) { log("ECB failed:", e.message); }
  for (const c of wl.fx || []) {
    try {
      const q = parseYahooChart(await get(`https://query1.finance.yahoo.com/v8/finance/chart/EUR${c}=X?range=1d&interval=1d`, { json: true, tries: 2 }));
      if (q && q.price > 0) out.fx[c] = { rate: 1 / q.price, date: q.date, time: q.time, src: "yahoo" };
      await sleep(300);
    } catch (e) { log(`  live FX ${c}: ${e.message} (keeping ECB)`); }
  }
  if (!Object.keys(out.fx).length && (wl.fx || []).length) out.misses.push("FX");
  log("FX: " + (wl.fx || []).map((c) => `${c}=${out.fx[c]?.rate?.toFixed(6) ?? "?"} (${out.fx[c]?.src ?? "-"})`).join(" "));

  // Mutual funds (AMFI)
  const funds = (wl.items || []).filter((x) => x.isin?.startsWith("INF"));
  if (funds.length) {
    let navs = null;
    for (const u of ["https://portal.amfiindia.com/spages/NAVAll.txt", "https://www.amfiindia.com/spages/NAVAll.txt"]) {
      try {
        const m = parseAMFI(await get(u));
        if (m.size > 1000) { navs = m; break; }
        log(`AMFI: ${u} returned only ${m.size} NAVs, trying the next address`);
      } catch (e) { log("AMFI:", e.message); }
    }
    for (const f of funds) {
      const n = navs?.get(f.isin);
      if (n) out.quotes[f.isin] = { price: n.nav, ccy: "INR", date: n.date, src: "amfi" };
      else out.misses.push(f.isin);
    }
    log(`AMFI: ${funds.length - funds.filter((f) => out.misses.includes(f.isin)).length}/${funds.length} funds priced`);
  }

  // Stocks, ETFs, ETCs (Yahoo, Stooq fallback)
  for (const it of (wl.items || []).filter((x) => !x.isin?.startsWith("INF"))) {
    const key = it.isin || it.ticker;
    try {
      let sym = it.ticker || symbols[key];
      if (!sym && it.isin) {
        const j = await get(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(it.isin)}&quotesCount=10&newsCount=0`, { json: true });
        sym = pickSymbol(j.quotes || [], it.isin.startsWith("IN"));
        await sleep(400);
        if (!sym) { // Yahoo's search doesn't know every ISIN (e.g. some ETCs): ask OpenFIGI (public, no key)
          try {
            const res = await fetch("https://api.openfigi.com/v3/mapping", {
              method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA },
              body: JSON.stringify([{ idType: "ID_ISIN", idValue: it.isin }]), signal: AbortSignal.timeout(30000),
            });
            if (res.ok) sym = figiToYahoo((await res.json())[0]?.data, it.isin.startsWith("IN"));
            if (sym) log(`  ${it.isin}: symbol ${sym} via OpenFIGI`);
          } catch (e) { log(`  openfigi ${it.isin}: ${e.message}`); }
        }
        if (sym) symbols[key] = sym;
      }
      if (!sym) throw new Error("no symbol found");
      let q = null;
      try { q = parseYahooChart(await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`, { json: true })); }
      catch (e) { log(`  yahoo ${sym}: ${e.message}`); }
      if (q) out.quotes[key] = { ...q, src: "yahoo", symbol: sym };
      else {
        const s = parseStooq(await get(`https://stooq.com/q/l/?s=${encodeURIComponent(stooqSymbol(sym))}&f=sd2t2ohlcv&h&e=csv`));
        if (!s) throw new Error("no quote from Yahoo or Stooq");
        out.quotes[key] = { ...s, ccy: it.ccy || prev.quotes[key]?.ccy || "EUR", src: "stooq", symbol: sym };
      }
      await sleep(400);
    } catch (e) { log(`  miss ${key}: ${e.message}`); out.misses.push(key); }
  }
  const total = (wl.items || []).length;
  log(`Priced ${total - out.misses.filter((m) => m !== "FX").length}/${total}.` + (out.misses.length ? ` Missing: ${out.misses.join(", ")}` : ""));

  await writeFile(prevPath, JSON.stringify(out, null, 1) + "\n");
  await writeFile(symPath, JSON.stringify(symbols, null, 1) + "\n");
  // History: one line per instrument per day (date,key,price,ccy); intraday runs overwrite that day's line,
  // so the last run of a day leaves the closing price. Public data, used for the value chart.
  const histPath = join(outDir, "history.csv");
  const old = existsSync(histPath) ? await readFile(histPath, "utf8") : "";
  await writeFile(histPath, mergeHistory(old, out));
  if (total && out.misses.length === total) process.exitCode = 1;
}

export function mergeHistory(csv, latest) {
  const m = new Map();
  for (const line of csv.split(/\r?\n/).slice(1)) {
    const p = line.split(",");
    if (p.length >= 4 && p[0]) m.set(`${p[0]},${p[1]}`, line);
  }
  for (const [c, v] of Object.entries(latest.fx || {})) if (v.date) m.set(`${v.date},FX:${c}`, `${v.date},FX:${c},${v.rate},EUR`);
  for (const [k, v] of Object.entries(latest.quotes || {})) if (v.date) m.set(`${v.date},${k}`, `${v.date},${k},${v.price},${v.ccy}`);
  return "date,key,price,ccy\n" + [...m.values()].sort().join("\n") + "\n";
}

function selftest() {
  const assert = (c, m) => { if (!c) { console.error("FAIL", m); process.exit(1); } };
  const e = parseECB(`<Cube time='2026-11-06'><Cube currency='USD' rate='1.0800'/><Cube currency='INR' rate='95.00'/></Cube>`);
  assert(e.date === "2026-11-06" && Math.abs(e.fx.INR - 1 / 95) < 1e-12, "ECB");
  const a = parseAMFI("Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date\n\n119551;INF209KA12Z1;-;Some Fund - Growth;123.4567;06-Nov-2026\n1;INF000000009;;Bad;N.A.;06-Nov-2026");
  assert(a.get("INF209KA12Z1")?.nav === 123.4567 && a.get("INF209KA12Z1").date === "2026-11-06" && !a.has("INF000000009"), "AMFI");
  const a2 = parseAMFI("Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date\r\n \r\nAxis Mutual Fund\r\n100528;INF090I01DG6;-;Franklin India Corporate Bond Fund;Regular Plan;Growth;107.0500;06-Nov-2026\n127039;INF247L01411;-;Motilal Oswal Midcap Fund;;;102.8412;06-Nov-2026");
  assert(a2.get("INF090I01DG6")?.nav === 107.05 && a2.get("INF247L01411")?.nav === 102.8412 && a2.get("INF090I01DG6").date === "2026-11-06", "AMFI with Plan/Option columns");
  assert(figiToYahoo([{ ticker: "4GLD", exchCode: "GY" }, { ticker: "4GLD", exchCode: "GF" }]) === "4GLD.DE", "openfigi xetra");
  assert(pickSymbol([{ symbol: "IWDA.L", quoteType: "ETF" }, { symbol: "EUNL.DE", quoteType: "ETF" }]) === "EUNL.DE", "prefer Xetra");
  assert(pickSymbol([{ symbol: "KTKBANK.BO" }, { symbol: "KTKBANK.NS" }], true) === "KTKBANK.NS", "prefer NSE");
  const y = parseYahooChart({ chart: { result: [{ meta: { regularMarketPrice: 7550, currency: "GBp", regularMarketTime: 1794000000 } }] } });
  assert(y.price === 75.5 && y.ccy === "GBP" && y.time.startsWith(y.date), "pence");
  const h1 = mergeHistory("date,key,price,ccy\n2026-11-06,X,1,EUR\n", { fx: {}, quotes: { X: { date: "2026-11-06", price: 2, ccy: "EUR" }, Y: { date: "2026-11-06", price: 3, ccy: "USD" } } });
  assert(h1 === "date,key,price,ccy\n2026-11-06,X,2,EUR\n2026-11-06,Y,3,USD\n", "history overwrite: " + h1);
  assert(stooqSymbol("AAPL") === "aapl.us" && stooqSymbol("SAP.DE") === "sap.de" && stooqSymbol("VUSA.L") === "vusa.uk", "stooq");
  assert(parseStooq("Symbol,Date,Time,Open,High,Low,Close,Volume\nSAP.DE,2026-11-06,17:35:00,1,2,0.5,200.5,100").price === 200.5, "stooq csv");
  console.log("selftest ok");
}

const arg = process.argv[2];
if (arg === "--selftest") selftest();
else if (arg) await run(arg);
else { console.error("Usage: node fetch-prices.mjs <vault-dir> | --selftest"); process.exit(2); }
