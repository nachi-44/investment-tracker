// Market data from the vault repo's daily price job (public data, not encrypted):
//   prices/latest.json   {updated, fx:{CCY:{rate,date}}, quotes:{ISIN:{price,ccy,date,src,symbol}}, misses}
//   prices/history.csv   date,key,price,ccy   (key = ISIN or FX:CCY)
//   watchlist.json       written by the app: identifiers only, no quantities or values
import { rate } from "./core.js";

/** Which instruments the price job should fetch. Only ISINs/tickers and currencies, nothing else. */
export function watchlist(db) {
  const items = [], seen = new Set();
  for (const p of db.positions) {
    if (p.qty <= 0 || p.cls === "Cash" || p.cls === "Insurance (ULIP)") continue;
    const key = p.isin || p.ticker;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    items.push({ isin: p.isin || undefined, ticker: p.ticker || undefined });
  }
  items.sort((a, b) => (a.isin || a.ticker).localeCompare(b.isin || b.ticker));
  const fx = [...new Set(Object.values(db.accounts).map((a) => a.ccy).concat(["USD", "GBP", "CHF", "INR"]).filter((c) => c !== "EUR"))].sort();
  return { v: 1, fx, items };
}

/**
 * Apply fetched prices to an in-memory copy (not saved by itself; saved with the next edit).
 * Quotes are converted to the account currency (Degiro positions are kept in EUR).
 * A quote only replaces a price that is older or equal, so a manual price entered today wins.
 */
export function mergePrices(db, latest) {
  if (!latest) return { db, applied: 0 };
  const out = structuredClone(db);
  for (const [c, v] of Object.entries(latest.fx || {})) if (v?.rate > 0) out.rates[c] = v.rate;
  out.rates_date = Object.values(latest.fx || {})[0]?.date || out.rates_date;
  let applied = 0;
  for (const p of out.positions) {
    const q = latest.quotes?.[p.isin || p.ticker];
    if (!q || !(q.price > 0)) continue;
    if (p.price_date && p.price_date > q.date) continue;
    const acctCcy = out.accounts[p.acct]?.ccy;
    const from = rate(out, q.ccy), to = rate(out, acctCcy);
    if (from == null || to == null) continue;
    p.price = (q.price * from) / to;
    p.price_date = q.date;
    p.price_time = q.time || null;
    p.price_src = q.src;
    applied++;
  }
  const times = Object.values(latest.quotes || {}).map((q) => q.time).filter(Boolean).sort();
  return { db: out, applied, misses: latest.misses || [], updated: latest.updated, lastQuote: times.at(-1) || null };
}

export function parseHistory(csv) {
  const m = new Map(); // key -> [[date, price, ccy]] sorted
  for (const line of csv.split(/\r?\n/).slice(1)) {
    const [date, key, price, ccy] = line.split(",");
    if (!date || !key) continue;
    if (!m.has(key)) m.set(key, []);
    m.get(key).push([date, +price, ccy]);
  }
  for (const v of m.values()) v.sort((a, b) => a[0].localeCompare(b[0]));
  return m;
}

const at = (series, d) => { // last value on or before d
  if (!series) return null;
  let lo = 0, hi = series.length - 1, best = null;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (series[mid][0] <= d) { best = series[mid]; lo = mid + 1; } else hi = mid - 1; }
  return best;
};

/**
 * Change since the previous close, per position: compares the current price with the last history price
 * before the current price's date (so on a weekend it shows Friday's move).
 * Returns Map(pid -> {pct, eur}) for positions with market data.
 */
export function dayChanges(db, hist) {
  const out = new Map();
  if (!hist) return out;
  for (const p of db.positions) {
    if (!(p.qty > 0)) continue;
    const series = hist.get(p.isin || p.ticker);
    if (!series) continue;
    const ref = p.price_date || series.at(-1)?.[0];
    const prev = [...series].reverse().find(([d]) => d < ref);
    if (!prev) continue;
    const acctCcy = db.accounts[p.acct]?.ccy;
    const fx = (c, d) => (c === "EUR" ? 1 : at(hist.get("FX:" + c), d)?.[1] ?? rate(db, c));
    const prevAcct = (prev[1] * (fx(prev[2], prev[0]) ?? 0)) / (fx(acctCcy, prev[0]) || 1);
    if (!(prevAcct > 0)) continue;
    const diff = p.price - prevAcct;
    out.set(p.id, { pct: (diff / prevAcct) * 100, eur: p.qty * diff * (rate(db, acctCcy) ?? 0) });
  }
  return out;
}

/**
 * Portfolio value in EUR per history date. Quantity on a day = today's quantity minus later buys plus later sells.
 * Positions without market data (ULIP, cash) count at their current value; lots with unknown dates count as held throughout.
 */
export function valueSeries(db, hist) {
  const dates = [...new Set([...hist.values()].flatMap((s) => s.map((x) => x[0])))].sort();
  const fxAt = (ccy, d) => (ccy === "EUR" ? 1 : at(hist.get("FX:" + ccy), d)?.[1] ?? rate(db, ccy));
  return dates.map((d) => {
    let v = 0;
    for (const p of db.positions) {
      const later = db.trades.filter((t) => t.pid === p.id && t.date > d);
      const qty = p.qty - later.filter((t) => t.side === "buy").reduce((a, t) => a + t.qty, 0) + later.filter((t) => t.side === "sell").reduce((a, t) => a + t.qty, 0);
      if (qty <= 1e-9) continue;
      const q = at(hist.get(p.isin || p.ticker), d);
      const acctCcy = db.accounts[p.acct]?.ccy;
      if (q) v += qty * q[1] * (fxAt(q[2], d) ?? 0);
      else v += qty * p.price * (fxAt(acctCcy, d) ?? 0);
    }
    return [d, v];
  });
}
