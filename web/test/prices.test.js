import { test, assert } from "./harness.js";
import { watchlist, mergePrices, parseHistory, valueSeries, dayChanges } from "../prices.js";
import { migrate, applyOp } from "../core.js";
import { splitNewMoney, allocation, checks } from "../rules.js";
import { rows, totals } from "../core.js";

const db0 = () => migrate({
  rates: { INR: 0.01 },
  accounts: { degiro: { name: "Degiro", ccy: "EUR" }, india: { name: "India", ccy: "INR" }, ulip: { name: "ULIP", ccy: "INR" } },
  positions: [
    { acct: "degiro", sym: "US Stock", isin: "US0000000001", cls: "Stock", qty: 10, cost: 1000, price: 100 },
    { acct: "degiro", sym: "CASH EUR", isin: "", cls: "Cash", qty: 50, cost: 50, price: 1 },
    { acct: "india", sym: "Fund", isin: "INF000000001", cls: "Equity fund", qty: 100, cost: 10000, price: 100 },
    { acct: "ulip", sym: "ULIP", cls: "Insurance (ULIP)", qty: 1, cost: 1000, price: 1000 },
  ],
});

test("watchlist holds identifiers only, no quantities or values", () => {
  const w = watchlist(db0());
  assert.deep(w.items, [{ isin: "INF000000001" }, { isin: "US0000000001" }]);
  assert.ok(w.fx.includes("INR") && w.fx.includes("USD") && !w.fx.includes("EUR"));
  const s = JSON.stringify(w);
  assert.ok(!/qty|cost|price|1000/.test(s), "leaks amounts");
});

test("mergePrices converts USD quotes into the EUR account and updates FX", () => {
  const latest = { updated: "x", fx: { USD: { rate: 0.9, date: "2026-11-06" }, INR: { rate: 0.0105, date: "2026-11-06" } },
    quotes: { US0000000001: { price: 200, ccy: "USD", date: "2026-11-06", src: "yahoo" }, INF000000001: { price: 120, ccy: "INR", date: "2026-11-06", src: "amfi" } } };
  const { db, applied } = mergePrices(db0(), latest);
  assert.eq(applied, 2);
  assert.near(db.positions[0].price, 180);
  assert.near(db.positions[2].price, 120);
  assert.eq(db.rates.INR, 0.0105);
});

test("a newer manual price is not overwritten by an older quote", () => {
  const d = applyOp(db0(), { type: "price", acct: "india", sym: "Fund", price: 130, date: "2026-11-07" }).db;
  const { db } = mergePrices(d, { fx: {}, quotes: { INF000000001: { price: 120, ccy: "INR", date: "2026-11-06", src: "amfi" } } });
  assert.eq(db.positions[2].price, 130);
});

test("value series uses history and adds back later sales", () => {
  let db = db0();
  db = applyOp(db, { type: "trade", side: "sell", acct: "degiro", sym: "US Stock", qty: 5, price: 100, date: "2026-11-05" }).db;
  const hist = parseHistory("date,key,price,ccy\n2026-11-04,US0000000001,100,EUR\n2026-11-06,US0000000001,110,EUR\n2026-11-04,FX:INR,0.01,EUR\n");
  const s = valueSeries(db, hist);
  assert.eq(s[0][0], "2026-11-04");
  // 11-04: 10 units (sale on 11-05 added back) *100 + cash 50 + fund 100*100*0.01 + ulip 1000*0.01
  assert.near(s[0][1], 1000 + 50 + 100 + 10);
  // 11-06: 5 units * 110
  assert.near(s[1][1], 550 + 50 + 100 + 10);
});

test("day change compares with the previous close, converted to the account currency", () => {
  let db = db0();
  db = mergePrices(db, { fx: { USD: { rate: 0.9, date: "2026-11-06" } }, quotes: { US0000000001: { price: 110, ccy: "USD", date: "2026-11-06", src: "yahoo" } } }).db;
  // current: 110 USD = 99 EUR; previous close (11-05): 100 USD at 0.9 = 90 EUR -> +10%
  const hist = parseHistory("date,key,price,ccy\n2026-11-05,US0000000001,100,USD\n2026-11-06,US0000000001,110,USD\n2026-11-05,FX:USD,0.9,EUR\n");
  const dc = dayChanges(db, hist).get(db.positions[0].id);
  assert.near(dc.pct, 10, 1e-9);
  assert.near(dc.eur, 10 * 9);
});

test("new money goes to classes below target", () => {
  const db = applyOp(db0(), { type: "rules", patch: { targets: { Stock: 50, "Equity fund": 40, Cash: 5, "Insurance (ULIP)": 5 } } }).db;
  const R = rows(db), T = totals(db, R);
  const A = allocation(db, R, T);
  const split = splitNewMoney(A, T.value, 1000);
  assert.near(split.reduce((a, s) => a + s.amount, 0), 1000);
  assert.eq(split[0].cls, "Equity fund");
});

test("single-stock limit ignores funds and the ULIP", () => {
  const db = db0(); const R = rows(db), T = totals(db, R);
  const c = checks(db, R, T);
  assert.ok(c.some((x) => x.title.startsWith("US Stock")));
  assert.ok(!c.some((x) => x.title.startsWith("Fund ")));
});
