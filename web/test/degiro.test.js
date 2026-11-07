import { test, assert } from "./harness.js";
import { parseCSV, degiroPortfolioOp } from "../importers/degiro.js";
import { migrate, applyOp } from "../core.js";

// Fake data in Degiro's German export layout.
const CSV = `Produkt,Symbol/ISIN,Anzahl,Schlusskurs,Lokaler Wert,,Wert in EUR
CASH & CASH FUND & FTX CASH (EUR),,,,EUR,"512,30","512,30"
EXAMPLE CORP,US0000000001,10,"130,00",USD,"1300,00","1.196,00"
EXAMPLE WORLD ETF,IE0000000001,"20","105,50",EUR,"2110,00","2.110,00"
NEW HOLDING AG,DE0000000009,4,"25,00",EUR,"100,00","100,00"
`;

test("CSV parser handles quotes and commas", () => {
  const r = parseCSV('a,"b,c","d ""q"""\r\n1,2,3');
  assert.deep(r, [["a", "b,c", 'd "q"'], ["1", "2", "3"]]);
});

test("Degiro import prices in EUR per unit, updates cash, flags new positions", async () => {
  const db = migrate({
    rates: {}, accounts: { degiro: { name: "Degiro", ccy: "EUR" } },
    positions: [
      { acct: "degiro", sym: "Example Corp", isin: "US0000000001", cls: "Stock", qty: 10, cost: 1000, price: 100 },
      { acct: "degiro", sym: "Example World ETF", isin: "IE0000000001", cls: "ETF", qty: 20, cost: 2000, price: 100 },
      { acct: "degiro", sym: "CASH EUR", isin: "", cls: "Cash", qty: 100, cost: 100, price: 1 },
    ],
  });
  const { op, notes } = await degiroPortfolioOp(CSV, "Portfolio.csv", "2026-11-07");
  assert.eq(op.ops.length, 4);
  assert.ok(notes[0].includes("512.30"));
  const out = applyOp(db, op).db;
  const corp = out.positions.find((p) => p.isin === "US0000000001");
  assert.near(corp.price, 119.6);
  assert.eq(corp.cost, 1000, "cost unchanged when qty unchanged");
  assert.eq(out.positions.find((p) => p.sym === "CASH EUR").qty, 512.3);
  const nw = out.positions.find((p) => p.isin === "DE0000000009");
  assert.ok(nw && nw.est, "new position is estimated");
  assert.eq(out.imports[0].hash.length, 64);
  assert.ok(applyOp(out, op).result.skipped, "same file twice is skipped");
});

test("non-Degiro file is rejected", async () => {
  await assert.rejects(() => degiroPortfolioOp("a,b\n1,2"), /doesn't look like/);
});
