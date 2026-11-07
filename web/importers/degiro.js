// Degiro "Portfolio.csv" export (German locale, decimal comma).
// Columns: product, symbol/ISIN, qty, close price, currency, value local, value EUR.
// Price per unit is stored in EUR for all Degiro positions (value EUR / qty), as in the prototype.
import { num } from "../core.js";

/** Minimal RFC 4180 CSV parser (quotes, escaped quotes, CRLF). */
export function parseCSV(text) {
  const rows = []; let row = [], cell = "", q = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

export async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const title = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 28);

/**
 * Turn the CSV into one "import" op. Nothing is applied here; the caller previews and then applies.
 * Quantity changes without a recorded trade become estimated lots (marked ~), as in the prototype.
 */
export async function degiroPortfolioOp(text, fileName = "Portfolio.csv", date) {
  const rows = parseCSV(text);
  if (rows.length < 2 || rows[0].length < 7) throw new Error("This doesn't look like a Degiro Portfolio.csv (expected 7 columns).");
  const ops = [], notes = [];
  for (const r of rows.slice(1)) {
    if (r.length < 7) continue;
    const [name, isin, qty, , cur, , veur] = r.slice(0, 7).map((c) => c.trim());
    const val = num(veur);
    if (!isin) {
      if (name.toUpperCase().includes("CASH") && (cur === "EUR" || !cur)) {
        ops.push({ type: "sync-qty", acct: "degiro", sym: "CASH EUR", cls: "Cash", qty: val, price: 1, cash: true, date, src: "degiro-csv" });
        notes.push(`Cash: ${val.toFixed(2)} EUR`);
      }
      continue;
    }
    const q = num(qty);
    if (!q) continue;
    ops.push({ type: "sync-qty", acct: "degiro", isin, sym: title(name), qty: q, price: val / q, date, src: "degiro-csv" });
  }
  if (!ops.length) throw new Error("No positions found in the file.");
  return {
    op: { type: "import", file: { name: fileName, hash: await sha256(text), date, kind: "degiro-portfolio", content: text }, ops },
    notes,
  };
}
