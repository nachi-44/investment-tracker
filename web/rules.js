// Rules-based portfolio checks and calculators. They compute facts from the user's own rules
// (targets, limits). They never recommend specific investments. Not financial advice.
import { isStale } from "./core.js";

/** "X-ray" style checks. Returns [{level:"warn"|"info", title, detail}] */
export function checks(db, R, T) {
  const r = db.rules, out = [];
  if (T.missing.length) out.push({ level: "warn", title: `Missing exchange rate for ${T.missing.join(", ")}`, detail: "Those positions are left out of the totals until a rate is available." });
  // Single-company risk only: funds, ETFs and the ULIP are already diversified.
  for (const x of R.filter((x) => x.weight > r.maxWeight && x.cls === "Stock"))
    out.push({ level: "warn", title: `${x.sym} is ${x.weight.toFixed(1)}% of the portfolio`, detail: `Above your single-stock limit of ${r.maxWeight}%.` });
  const est = R.filter((x) => x.est);
  if (est.length) out.push({ level: "info", title: `${est.length} position(s) with unknown purchase cost (~)`, detail: `Gains for ${est.map((x) => x.sym).join(", ")} are estimates. Add the real buy prices to fix this.` });
  const stale = R.filter((x) => isStale(x, r.staleDays));
  if (stale.length) out.push({ level: "info", title: `${stale.length} price(s) older than ${r.staleDays} days`, detail: stale.map((x) => `${x.sym} (${x.price_date || "no date"})`).join(", ") });
  for (const x of R.filter((x) => !x.est && x.gainPct >= r.takeProfitPct))
    out.push({ level: "info", title: `${x.sym} is up ${x.gainPct.toFixed(0)}%`, detail: `Above your review threshold of ${r.takeProfitPct}%. Consider whether it still fits your plan.` });
  const byCcy = {};
  for (const x of R) if (x.valEUR != null) byCcy[x.ccy] = (byCcy[x.ccy] || 0) + x.valEUR;
  for (const [c, v] of Object.entries(byCcy)) if (T.value && v / T.value > 0.8 && Object.keys(byCcy).length > 1)
    out.push({ level: "info", title: `${((v / T.value) * 100).toFixed(0)}% of the portfolio is in ${c}`, detail: "Currency concentration." });
  return out;
}

/**
 * Allocation by asset class vs. targets with 5/25 bands.
 * Returns [{cls, value, pct, target, diffPct, diffEUR, outside}] (target null when none set).
 */
export function allocation(db, R, T) {
  const t = db.rules.targets || {};
  const by = {};
  for (const x of R) if (x.valEUR != null) by[x.cls] = (by[x.cls] || 0) + x.valEUR;
  const classes = [...new Set([...Object.keys(by), ...Object.keys(t)])];
  return classes.map((cls) => {
    const value = by[cls] || 0, pct = T.value ? (value / T.value) * 100 : 0;
    const target = t[cls] ?? null;
    if (target == null) return { cls, value, pct, target, diffPct: null, diffEUR: null, outside: false };
    const diffPct = pct - target;
    const band = Math.min(db.rules.bandAbs, (target * db.rules.bandRel) / 100);
    return { cls, value, pct, target, diffPct, diffEUR: (diffPct / 100) * T.value, outside: Math.abs(diffPct) > band, band };
  }).sort((a, b) => b.value - a.value);
}

/**
 * Split new money across classes that are below target, so the portfolio moves toward the targets.
 * Pure arithmetic on the user's targets. Returns [{cls, amount}].
 */
export function splitNewMoney(alloc, total, amount) {
  const withT = alloc.filter((a) => a.target != null);
  const sumT = withT.reduce((s, a) => s + a.target, 0);
  if (!withT.length || sumT <= 0) return [];
  const newTotal = total + amount;
  // shortfall of each class at the new total
  const need = withT.map((a) => ({ cls: a.cls, gap: Math.max(0, (a.target / sumT) * newTotal - a.value) }));
  const gapSum = need.reduce((s, n) => s + n.gap, 0);
  if (gapSum <= 0) return withT.map((a) => ({ cls: a.cls, amount: (amount * a.target) / sumT }));
  return need.filter((n) => n.gap > 0).map((n) => ({ cls: n.cls, amount: (amount * n.gap) / gapSum })).sort((a, b) => b.amount - a.amount);
}
