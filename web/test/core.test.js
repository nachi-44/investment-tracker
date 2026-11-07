import { test, assert } from "./harness.js";
import { num, migrate, applyOp, rows, totals, groupBy, filterRows, sortRows, money, isStale } from "../core.js";

const base = () => migrate({
  rates: { INR: 0.01 },
  accounts: { degiro: { name: "Degiro", ccy: "EUR" }, india: { name: "India", ccy: "INR" }, ulip: { name: "ULIP", ccy: "INR" } },
  positions: [
    { acct: "degiro", sym: "Stock A", isin: "US0000000001", cls: "Stock", qty: 10, cost: 1000, price: 120 },
    { acct: "india", sym: "Fund B", isin: "INF000000001", cls: "Equity fund", qty: 100, cost: 10000, price: 110, est: true },
    { acct: "ulip", sym: "ULIP", cls: "Insurance (ULIP)", qty: 1, cost: 150000, price: 160000 },
  ],
});

test("num parses German and English formats", () => {
  assert.eq(num("1.234,56"), 1234.56);
  assert.eq(num("1,234.56"), 1234.56);
  assert.eq(num("12,5"), 12.5);
  assert.eq(num("12.5"), 12.5);
  assert.eq(num(" -3,00 "), -3);
  assert.eq(num(""), 0);
  assert.eq(num("€ 1 000,10"), 1000.1);
  assert.throws(() => num("abc"), /Not a number/);
});

test("money formats EUR and INR", () => {
  assert.eq(money(1234.5), "€1,234.50");
  assert.eq(money(-5, "INR"), "-₹5.00");
});

test("migrate v1 creates lots that match qty and cost", () => {
  const db = base();
  assert.eq(db.version, 2);
  const a = db.positions[0];
  assert.eq(a.lots.length, 1);
  assert.eq(a.qty, 10); assert.eq(a.cost, 1000);
  assert.ok(db.positions[1].est, "est carried into lot");
  assert.ok(db.rules.maxWeight > 0);
});

test("buy adds a lot and updates average cost", () => {
  const { db } = applyOp(base(), { type: "trade", side: "buy", acct: "degiro", sym: "Stock A", qty: 10, price: 150, fee: 2, date: "2026-01-02" });
  const p = db.positions[0];
  assert.eq(p.qty, 20); assert.near(p.cost, 2502);
  assert.near(p.cost / p.qty, 125.1);
  assert.eq(db.trades.length, 1);
  assert.eq(db.trades[0].date, "2026-01-02");
});

test("buy of a new symbol creates a position", () => {
  const { db, result } = applyOp(base(), { type: "trade", side: "buy", acct: "degiro", sym: "New ETF", qty: 3, price: 10, cls: "ETF" });
  const p = db.positions.find((x) => x.id === result.pid);
  assert.eq(p.cls, "ETF"); assert.eq(p.qty, 3); assert.eq(p.cost, 30);
});

test("sell is FIFO and books realized gain net of fee", () => {
  let { db } = applyOp(base(), { type: "trade", side: "buy", acct: "degiro", sym: "Stock A", qty: 10, price: 200, date: "2026-02-01" });
  // lots: 10 @ 100 (unknown date), 10 @ 200. Sell 15 @ 300, fee 5 -> basis 10*100 + 5*200 = 2000
  const r = applyOp(db, { type: "trade", side: "sell", acct: "degiro", sym: "Stock A", qty: 15, price: 300, fee: 5 });
  db = r.db;
  assert.near(r.result.basis, 2000);
  assert.near(r.result.realized, 15 * 300 - 5 - 2000);
  const p = db.positions[0];
  assert.eq(p.qty, 5); assert.near(p.cost, 1000); // 5 left @ 200
  assert.near(p.realized, 2495);
});

test("selling more than held fails and leaves data untouched", () => {
  const db = base();
  assert.throws(() => applyOp(db, { type: "trade", side: "sell", acct: "degiro", sym: "Stock A", qty: 11, price: 1 }), /can't sell/);
  assert.eq(db.positions[0].qty, 10);
});

test("invalid inputs are rejected", () => {
  assert.throws(() => applyOp(base(), { type: "trade", side: "buy", acct: "degiro", sym: "X", qty: 0, price: 1 }), /Quantity/);
  assert.throws(() => applyOp(base(), { type: "trade", side: "buy", acct: "nope", sym: "X", qty: 1, price: 1 }), /Unknown account/);
  assert.throws(() => applyOp(base(), { type: "trade", side: "buy", acct: "degiro", sym: "X", qty: 1, price: -1 }), /Price/);
});

test("ULIP contribution adds cost but no units; full surrender releases all cost", () => {
  let { db } = applyOp(base(), { type: "contribution", acct: "ulip", sym: "ULIP", amount: 150000, date: "2026-04-05" });
  const p = db.positions[2];
  assert.eq(p.qty, 1); assert.eq(p.cost, 300000);
  const r = applyOp(db, { type: "trade", side: "sell", acct: "ulip", sym: "ULIP", qty: 1, price: 320000 });
  assert.near(r.result.basis, 300000);
  assert.near(r.result.realized, 20000);
});

test("selling an estimated lot marks the realized gain as estimated", () => {
  const r = applyOp(base(), { type: "trade", side: "sell", acct: "india", sym: "Fund B", qty: 10, price: 120 });
  assert.ok(r.result.est);
});

test("totals convert to EUR and exclude currencies without a rate", () => {
  const db = base();
  let t = totals(db);
  // 10*120 + 100*110*0.01 + 160000*0.01 = 1200 + 110 + 1600
  assert.near(t.value, 2910);
  assert.near(t.cost, 1000 + 100 + 1500);
  assert.near(t.estValue, 110);
  db.rates = {};
  t = totals(db);
  assert.near(t.value, 1200);
  assert.deep(t.missing, ["INR"]);
});

test("weights add up to 100 and groupBy sorts by value", () => {
  const db = base(); const R = rows(db); totals(db, R);
  assert.near(R.reduce((a, r) => a + r.weight, 0), 100);
  const g = groupBy(R, "acct");
  assert.eq(g[0][0], "ulip");
});

test("filters and sorting", () => {
  const R = rows(base());
  assert.eq(filterRows(R, { acct: "india" }).length, 1);
  assert.eq(filterRows(R, { result: "est" }).length, 1);
  assert.eq(filterRows(R, { q: "us000" }).length, 1);
  assert.eq(filterRows(R, { result: "loss" }).length, 0);
  assert.eq(sortRows(R, "sym", 1)[0].sym, "Fund B");
});

test("price op and stale check", () => {
  const { db } = applyOp(base(), { type: "price", acct: "india", sym: "Fund B", price: 130, date: "2026-11-01" });
  assert.eq(db.positions[1].price, 130);
  assert.eq(db.positions[1].price_src, "manual");
  assert.ok(!isStale(db.positions[1], 4, "2026-11-04"));
  assert.ok(isStale(db.positions[1], 4, "2026-11-10"));
});

test("sync-qty: added units become an estimated lot, cash follows value", () => {
  let { db } = applyOp(base(), { type: "sync-qty", acct: "degiro", isin: "US0000000001", sym: "Stock A", qty: 12, price: 130 });
  const p = db.positions[0];
  assert.eq(p.qty, 12); assert.near(p.cost, 1000 + 2 * 130); assert.ok(p.est);
  db = applyOp(db, { type: "sync-qty", acct: "degiro", sym: "CASH EUR", cls: "Cash", qty: 250, price: 1, cash: true }).db;
  const c = db.positions.find((x) => x.sym === "CASH EUR");
  assert.eq(c.qty, 250); assert.eq(c.cost, 250);
});

test("import op is skipped when the same file hash was imported before", () => {
  const op = { type: "import", file: { name: "a.csv", hash: "abc" }, ops: [{ type: "price", acct: "degiro", sym: "Stock A", price: 1 }] };
  const { db } = applyOp(base(), op);
  assert.eq(db.imports.length, 1);
  const r = applyOp(db, op);
  assert.ok(r.result.skipped);
});
