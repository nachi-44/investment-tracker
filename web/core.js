// Portfolio domain logic. Pure functions, no DOM, no network: runs in the browser and in Node.
// Ported from the Python prototype (portfolio.py). Changes vs. the prototype:
//  - positions keep FIFO tax lots; cost = sum of remaining lot costs, avg cost = cost / qty
//  - every change is an "op" applied by applyOp(), so edits can be replayed after a sync conflict
//  - trades carry real dates and fees
// Money: `cost` is the TOTAL cost in the account's currency; `price` is per unit in the account's currency.

export const VERSION = 2;
export const SYM = { EUR: "€", INR: "₹", USD: "$" };
const EPS = 1e-9;

// ---------- parsing and formatting ----------

/** Parse a number written with either locale. "1.234,56" -> 1234.56, "1,234.56" -> 1234.56, "12,5" -> 12.5. */
export function num(s) {
  let t = String(s ?? "").trim().replace(/[\s '€₹$]/g, "");
  if (!t) return 0;
  const lastComma = t.lastIndexOf(","), lastDot = t.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    // both present: the later one is the decimal separator
    if (lastComma > lastDot) t = t.replace(/\./g, "").replace(",", ".");
    else t = t.replace(/,/g, "");
  } else if (lastComma > -1) {
    t = t.replace(/\./g, "").replace(",", ".");
  }
  const v = Number(t);
  if (!Number.isFinite(v)) throw new Error(`Not a number: ${s}`);
  return v;
}

export function money(n, ccy = "EUR", digits = 2) {
  if (n == null || !Number.isFinite(n)) return "–";
  const s = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return (n < 0 ? "-" : "") + (SYM[ccy] ?? ccy + " ") + s;
}

export function pct(n, signed = false) {
  if (n == null || !Number.isFinite(n)) return "–";
  return (signed && n > 0 ? "+" : "") + n.toFixed(1) + "%";
}

export const today = () => new Date().toISOString().slice(0, 10);
const clone = (o) => JSON.parse(JSON.stringify(o));
const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

// ---------- schema ----------

export function defaultRules() {
  return {
    targets: {},            // asset class -> target % of total
    bandAbs: 5,             // 5/25 rule: absolute band in percentage points
    bandRel: 25,            // ... and relative band in % of the target
    maxWeight: 10,          // single-position limit in %
    takeProfitPct: 50,      // flag positions with a gain above this
    staleDays: 4,           // flag prices older than this many days
  };
}

/** Bring any stored document up to the current schema. Never change the shape without a step here. */
export function migrate(input) {
  const db = clone(input);
  if (!db.version || db.version < 2) {
    // v1 = prototype portfolio.json: {rates, accounts, positions}
    db.positions = (db.positions || []).map((x) => {
      const p = { id: x.id || newId(), ...x };
      if (!p.lots) p.lots = p.qty > EPS || p.cost ? [{ date: null, qty: p.qty, cost: p.cost, est: !!p.est }] : [];
      return p;
    });
    db.trades = db.trades || [];
    db.imports = db.imports || [];
    db.version = 2;
  }
  db.rates = db.rates || {};
  db.accounts = db.accounts || {};
  db.rules = { ...defaultRules(), ...(db.rules || {}) };
  for (const p of db.positions) syncPosition(p);
  return db;
}

/** Recompute qty/cost/est from lots so they can never drift apart. */
function syncPosition(p) {
  p.lots = (p.lots || []).filter((l) => l.qty > EPS || Math.abs(l.cost) > EPS);
  p.qty = round(p.lots.reduce((a, l) => a + l.qty, 0));
  p.cost = round(p.lots.reduce((a, l) => a + l.cost, 0));
  p.est = p.lots.some((l) => l.est);
  return p;
}
const round = (v) => Math.round(v * 1e8) / 1e8;

// ---------- lookups ----------

export const ccyOf = (db, p) => db.accounts[p.acct]?.ccy;
/** EUR per 1 unit of currency c; undefined when unknown. */
export const rate = (db, c) => (c === "EUR" ? 1 : db.rates?.[c]);

export function findPos(db, acct, sym) {
  if (!sym) return null;
  const s = String(sym).toLowerCase();
  let m = db.positions.filter((x) => x.acct === acct && (x.id === sym || x.sym.toLowerCase() === s || (x.isin && x.isin.toLowerCase() === s)));
  if (!m.length) m = db.positions.filter((x) => x.acct === acct && x.sym.toLowerCase().includes(s));
  if (m.length > 1) throw new Error("More than one match: " + m.map((x) => x.sym).join(", "));
  return m[0] || null;
}

// ---------- operations (each is replayable) ----------

/**
 * Apply one edit op to a copy of db and return {db, result}. Throws on invalid input; db is untouched then.
 * Ops:
 *  {type:"trade", side:"buy"|"sell", acct, sym, qty, price, fee?, date?, cls?, isin?}
 *  {type:"contribution", acct, sym, amount, date?}      (ULIP instalment: adds cost, not units)
 *  {type:"price", acct, sym, price, date?, src?}
 *  {type:"position", acct, sym, patch}                  (edit name, class, isin, ticker, ...)
 *  {type:"import", file:{name, hash, date, kind}, ops:[...]}  (an import is a batch of ops)
 *  {type:"rules", patch}
 */
export function applyOp(db0, op) {
  const db = clone(db0);
  const result = applyInPlace(db, op);
  db.updated = new Date().toISOString();
  return { db, result };
}

function applyInPlace(db, op) {
  switch (op.type) {
    case "trade": return op.side === "sell" ? sell(db, op) : buy(db, op);
    case "contribution": return contribution(db, op);
    case "price": return setPrice(db, op);
    case "cost": return setCost(db, op);
    case "seed": return seedImport(db, op);
    case "position": return patchPosition(db, op);
    case "rules": db.rules = { ...db.rules, ...op.patch }; return {};
    case "import": {
      if (op.file?.hash && db.imports.some((f) => f.hash === op.file.hash)) return { skipped: true, reason: "This file was already imported." };
      const results = op.ops.map((o) => applyInPlace(db, o));
      if (op.file) db.imports.push({ ...op.file, at: new Date().toISOString(), count: op.ops.length });
      return { results };
    }
    case "sync-qty": return syncQty(db, op);
    default: throw new Error("Unknown op " + op.type);
  }
}

function requireAcct(db, acct) {
  if (!db.accounts[acct]) throw new Error("Unknown account: " + acct + ". Use one of: " + Object.keys(db.accounts).join(", "));
}
function positive(v, what) {
  if (!(Number.isFinite(v) && v > 0)) throw new Error(`${what} must be a positive number.`);
  return v;
}

function buy(db, op) {
  requireAcct(db, op.acct);
  const qty = positive(+op.qty, "Quantity"), price = positive(+op.price, "Price"), fee = +op.fee || 0;
  if (fee < 0) throw new Error("Fee can't be negative.");
  let p = findPos(db, op.acct, op.sym);
  if (!p) {
    p = { id: newId(), acct: op.acct, sym: String(op.sym).trim(), isin: op.isin || "", cls: op.cls || "Stock", qty: 0, cost: 0, price, lots: [] };
    db.positions.push(p);
  }
  const date = op.date || today();
  p.lots.push({ date, qty, cost: qty * price + fee });
  p.price = price; p.price_date = date; p.price_src = "trade";
  syncPosition(p);
  db.trades.push({ id: newId(), date, acct: op.acct, pid: p.id, sym: p.sym, side: "buy", qty, price, fee });
  return { pid: p.id };
}

/** FIFO sale. Unit-less lots (ULIP contributions, qty 0) are released in proportion to the share of units sold. */
function sell(db, op) {
  requireAcct(db, op.acct);
  const qty = positive(+op.qty, "Quantity"), price = positive(+op.price, "Price"), fee = +op.fee || 0;
  const p = findPos(db, op.acct, op.sym);
  if (!p || p.qty + EPS < qty) throw new Error(`You hold ${p ? p.qty : 0} of ${op.sym}, can't sell ${qty}.`);
  const date = op.date || today();
  const share = qty / p.qty;
  let left = qty, basis = 0, est = false;
  const consumed = [];
  for (const l of p.lots) {
    if (l.qty > EPS && left > EPS) {
      const take = Math.min(l.qty, left);
      const c = (l.cost * take) / l.qty;
      basis += c; l.cost -= c; l.qty -= take; left -= take;
      est = est || !!l.est;
      consumed.push({ date: l.date, qty: take, cost: c, est: !!l.est });
    } else if (l.qty <= EPS) {
      const c = l.cost * share;
      basis += c; l.cost -= c; est = est || !!l.est;
      consumed.push({ date: l.date, qty: 0, cost: c, est: !!l.est });
    }
  }
  const realized = qty * price - fee - basis;
  p.realized = (p.realized || 0) + realized;
  p.price = price; p.price_date = date; p.price_src = "trade";
  syncPosition(p);
  if (p.qty <= EPS) { p.qty = 0; p.cost = 0; p.lots = []; }
  db.trades.push({ id: newId(), date, acct: op.acct, pid: p.id, sym: p.sym, side: "sell", qty, price, fee, basis: round(basis), realized: round(realized), est, lots: consumed });
  return { pid: p.id, realized, basis, est };
}

function contribution(db, op) {
  const p = findPos(db, op.acct, op.sym);
  if (!p) throw new Error("Position not found: " + op.sym);
  const amount = positive(+op.amount, "Amount"), date = op.date || today();
  p.lots.push({ date, qty: 0, cost: amount });
  syncPosition(p);
  db.trades.push({ id: newId(), date, acct: op.acct, pid: p.id, sym: p.sym, side: "contribution", qty: 0, price: amount, fee: 0 });
  return { pid: p.id };
}

function setPrice(db, op) {
  const p = findPos(db, op.acct, op.sym);
  if (!p) throw new Error("Position not found: " + op.sym);
  p.price = positive(+op.price, "Price");
  p.price_date = op.date || today();
  p.price_src = op.src || "manual";
  return { pid: p.id };
}

/**
 * Add a whole starting portfolio (seed.json format, as in the prototype) to an existing vault.
 * Adds missing accounts and rates; positions already present (same account and ISIN, or same name) are skipped.
 */
function seedImport(db, op) {
  const src = op.data || {};
  if (!src.accounts || !Array.isArray(src.positions)) throw new Error("This file needs 'accounts' and 'positions'.");
  for (const [id, a] of Object.entries(src.accounts)) if (!db.accounts[id]) db.accounts[id] = { name: a.name || id, ccy: a.ccy || "EUR" };
  for (const [c, r] of Object.entries(src.rates || {})) if (db.rates[c] == null && r > 0) db.rates[c] = r;
  const added = [], skipped = [];
  for (const x of src.positions) {
    if (!x.acct || !x.sym || !db.accounts[x.acct]) throw new Error(`Position "${x.sym || "?"}" has an unknown account "${x.acct}".`);
    const qty = +x.qty || 0, cost = +x.cost || 0, price = +x.price || 0;
    if (qty < 0 || cost < 0 || price < 0 || !Number.isFinite(qty + cost + price)) throw new Error(`Position "${x.sym}" has an invalid number.`);
    const dup = db.positions.find((p) => p.acct === x.acct && ((x.isin && p.isin === x.isin) || p.sym.toLowerCase() === String(x.sym).toLowerCase()));
    if (dup) { skipped.push(x.sym); continue; }
    const p = {
      id: newId(), acct: x.acct, sym: String(x.sym).trim(), isin: (x.isin || "").trim().toUpperCase(), cls: x.cls || "Stock",
      qty, cost, price, price_date: x.price_date || null, price_src: "seed",
      lots: qty > EPS || cost > EPS ? [{ date: x.date || null, qty, cost, est: !!x.est }] : [],
    };
    if (x.ticker) p.ticker = x.ticker;
    if (x.realized) p.realized = +x.realized;
    syncPosition(p);
    db.positions.push(p);
    added.push(p.sym);
  }
  return { added, skipped };
}

/**
 * Replace a position's cost basis with the real total paid (e.g. from Degiro or a CAS statement).
 * All lots are merged into one known lot, which clears the "estimated" (~) flag.
 */
function setCost(db, op) {
  const p = findPos(db, op.acct, op.sym);
  if (!p) throw new Error("Position not found: " + op.sym);
  if (!(p.qty > 0)) throw new Error("This position has no units.");
  const cost = positive(+op.cost, "Total invested");
  p.lots = [{ date: op.date || null, qty: p.qty, cost }];
  syncPosition(p);
  return { pid: p.id };
}

function patchPosition(db, op) {
  const p = findPos(db, op.acct, op.sym);
  if (!p) throw new Error("Position not found: " + op.sym);
  const allowed = ["sym", "cls", "isin", "ticker", "units", "note"];
  for (const k of Object.keys(op.patch)) if (allowed.includes(k)) p[k] = op.patch[k];
  return { pid: p.id };
}

/**
 * Bring a position to a new quantity from a broker statement when no trade is known
 * (prototype behaviour of `degiro`). Added units get an estimated lot at today's price.
 */
function syncQty(db, op) {
  let p = op.isin ? db.positions.find((x) => x.acct === op.acct && x.isin === op.isin) : findPos(db, op.acct, op.sym);
  const date = op.date || today();
  if (!p) {
    p = { id: newId(), acct: op.acct, sym: op.sym, isin: op.isin || "", cls: op.cls || "Stock", qty: 0, cost: 0, price: op.price, lots: [] };
    db.positions.push(p);
    if (op.qty > EPS) p.lots.push({ date: null, qty: op.qty, cost: op.qty * op.price, est: true });
    p.price = op.price; p.price_date = date; p.price_src = op.src || "import";
    syncPosition(p);
    return { pid: p.id, created: true };
  }
  const diff = op.qty - p.qty;
  if (op.cash) {
    // cash: value is the quantity, cost follows value
    p.lots = op.qty > EPS ? [{ date, qty: op.qty, cost: op.qty }] : [];
  } else if (diff > EPS) {
    p.lots.push({ date: null, qty: diff, cost: diff * op.price, est: true });
  } else if (diff < -EPS) {
    let left = -diff; // remove FIFO without booking a gain (unknown sale)
    for (const l of p.lots) {
      if (l.qty <= EPS || left <= EPS) continue;
      const take = Math.min(l.qty, left);
      l.cost -= (l.cost * take) / l.qty; l.qty -= take; left -= take;
    }
  }
  p.price = op.price; p.price_date = date; p.price_src = op.src || "import";
  syncPosition(p);
  return { pid: p.id, qtyChanged: Math.abs(diff) > EPS ? diff : 0 };
}

// ---------- reporting ----------

/** One row per open position with values in account currency and EUR. */
export function rows(db) {
  const out = [];
  for (const p of db.positions) {
    if (p.qty <= EPS) continue;
    const ccy = ccyOf(db, p), f = rate(db, ccy);
    const val = p.qty * p.price, gain = val - p.cost;
    out.push({
      ...p, ccy, f, val, gain,
      gainPct: p.cost ? (gain / p.cost) * 100 : 0,
      avg: p.qty ? p.cost / p.qty : 0,
      valEUR: f == null ? null : val * f,
      costEUR: f == null ? null : p.cost * f,
      gainEUR: f == null ? null : gain * f,
      firstDate: p.lots.map((l) => l.date).filter(Boolean).sort()[0] || null,
      account: db.accounts[p.acct]?.name || p.acct,
    });
  }
  return out;
}

export function totals(db, R = rows(db)) {
  const known = R.filter((r) => r.f != null);
  const missing = [...new Set(R.filter((r) => r.f == null).map((r) => r.ccy))];
  const value = sum(known, "valEUR"), cost = sum(known, "costEUR");
  const realized = db.positions.reduce((a, p) => a + (p.realized || 0) * (rate(db, ccyOf(db, p)) ?? 0), 0);
  const estValue = sum(known.filter((r) => r.est), "valEUR");
  for (const r of known) r.weight = value ? (r.valEUR / value) * 100 : 0;
  return { value, cost, unrealized: value - cost, realized, estValue, missing, count: known.length };
}

export function groupBy(R, key) {
  const m = new Map();
  for (const r of R) if (r.valEUR != null) m.set(r[key], (m.get(r[key]) || 0) + r.valEUR);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

const sum = (a, k) => a.reduce((s, r) => s + (r[k] || 0), 0);

/** Values that drive the filters in the holdings view. */
export function facets(R) {
  const uniq = (k) => [...new Set(R.map((r) => r[k]))].sort();
  return { acct: uniq("acct"), cls: uniq("cls"), ccy: uniq("ccy") };
}

export function filterRows(R, f = {}) {
  const q = (f.q || "").trim().toLowerCase();
  return R.filter((r) =>
    (!f.acct || r.acct === f.acct) &&
    (!f.cls || r.cls === f.cls) &&
    (!f.ccy || r.ccy === f.ccy) &&
    (!f.result || (f.result === "gain" ? r.gain > 0 : f.result === "loss" ? r.gain < 0 : f.result === "est" ? r.est : true)) &&
    (!q || r.sym.toLowerCase().includes(q) || (r.isin || "").toLowerCase().includes(q))
  );
}

export function sortRows(R, key = "valEUR", dir = -1) {
  return [...R].sort((a, b) => {
    const x = a[key], y = b[key];
    if (typeof x === "string" || typeof y === "string") return dir * String(x ?? "").localeCompare(String(y ?? ""));
    return dir * ((x ?? -Infinity) - (y ?? -Infinity));
  });
}

/** Price older than `days` calendar days (or unknown). */
export function isStale(p, days, now = today()) {
  if (p.cls === "Cash") return false;
  if (!p.price_date) return true;
  return (Date.parse(now) - Date.parse(p.price_date)) / 864e5 > days;
}
