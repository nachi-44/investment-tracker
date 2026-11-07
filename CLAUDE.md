# Handover: portfolio tracker (v2, web app)

## What this is and who it's for
A private tracker for one person's portfolio, with totals in EUR. The owner lives in Munich.
- **Degiro** (Germany, EUR): stocks, ETFs, gold ETC, cash.
- **India (INR):** NSDL demat (one stock plus four mutual funds) and seven mutual-fund folios (CAMS/KFintech).
- **SBI Life Smart Wealth Builder ULIP (INR):** ₹1.5 lakh each April since 2024. It is one position, qty 1. Each payment is a `contribution` op (adds cost), and the price is the total fund value.

The goal is one dashboard on PC and phone, quick recording on the move, and rule-based decision support.

## Privacy and security rules (hard constraints)
- **This repo is public.** Never commit real holdings: no `seed.json`, CSV, PDF, `.enc`, `data/` or `portfolio.json`. Both `.gitignore` and CI enforce this. Only `web/seed.example.json` (fake) is committed.
- Real data lives only in the **private** `nachi-44/investment-vault` repo, and only as `portfolio.enc` (encrypted in the browser).
- The price job must **never** get the passphrase or decrypt anything. It reads `watchlist.json`, which holds identifiers only.
- Never ask for or store broker or bank logins, and don't scrape behind logins. Use public sources only.
- Never handle the user's real token, passphrase, recovery key or seed. The user enters them in the app.
- Redact PAN, folio and account numbers anywhere they are pasted.
- Commit messages to the vault are always `update` (they are not encrypted).
- Keep the CSP (`connect-src 'self' https://api.github.com`) and the no-third-party-scripts rule. Build DOM with `h()`/textContent, never `innerHTML` with data.
- Not financial advice: report facts and arithmetic on the user's own rules. Never name products to buy.

## Architecture
- `web/`: static app (ES modules, no build), served by GitHub Pages from this repo (`pages.yml`).
- `core.js`: the schema (`version: 2`) and **ops**. Every edit is an op applied by `applyOp(db, op)`, a pure function that copies `db`, so it can be replayed after a sync conflict.
  - Ops: `trade` (buy/sell), `contribution`, `price`, `position`, `sync-qty`, `import` (a batch, deduped by file hash), `rules`.
  - Positions: `{id, acct, sym, isin, cls, ticker?, qty, cost, price, price_date, price_src, realized?, lots:[{date, qty, cost, est?}]}`. `qty`, `cost` and `est` are derived from `lots`.
  - **FIFO lots** (German §20 EStG and Indian rules). Average cost = cost / qty, for display.
  - `est` lot = purchase price unknown (cost set to the value at import). Shown with `~` and excluded from the gains chart.
  - `cost` is the TOTAL in the account's currency. `price` is per unit in the account's currency. **Degiro positions are priced in EUR** (Portfolio.csv: value EUR / qty).
  - `rates[C]` = EUR per 1 C. A missing rate excludes that account from totals (with a warning).
  - Never change the stored shape without a step in `migrate()`.
- `vault.js`: envelope encryption.
  - The data key (AES-GCM-256) is wrapped by the passphrase (PBKDF2-SHA256, 600k) and by a recovery key (Crockford base32, shown once).
  - The GitHub token is stored on the device, sealed with the data key.
- `sync.js`: `GitHubStore` (Contents API with sha; 409/422 → `ConflictError`), `MemoryStore` (tests and `#demo`), and `Vault` (commit → on conflict re-read, replay pending ops, retry).
- `prices.js`: builds `watchlist`, merges `prices/latest.json` in memory (converted to the account currency; a newer manual price wins), and computes `valueSeries` from `prices/history.csv`.
- `rules.js`: X-ray checks, allocation with 5/25 bands, new-money split.
- `scripts/fetch-prices.mjs`: runs in the vault repo (`vault-template/.github/workflows/prices.yml`). Sources:
  - ECB for FX;
  - AMFI `NAVAll.txt` by ISIN;
  - Yahoo search (ISIN → symbol, preferring EUR listings, or NSE for INE ISINs), then Yahoo chart, with Stooq as fallback.
  Symbols are cached in `prices/symbols.json`. A position's `ticker` overrides the lookup.

## Known gaps / not yet verified
1. The price job hasn't had a live run yet. Yahoo is unofficial and may rate-limit. Watch the "Missing:" line in the Action log.
2. ULIP is priced by hand ("Set price" = total fund value). SBI Life publishes daily fund NAVs publicly; automating that (units per fund × NAV) is open.
3. The trade dates of the starting positions are unknown (lot date `null`), so holding periods are unknown.
4. Five Indian demat positions have estimated costs (`est`): Karnataka Bank, Franklin India Corporate Bond, Nippon India Large Cap, SBI Debt Hybrid, SBI Gold Fund.
5. Sale proceeds aren't added to a cash position automatically.

## Backlog (rough priority)
1. Tax estimates in a what-if sale. Research the current rules first and cite them, keeping everything configurable:
   - DE: Abgeltungsteuer + Soli (+ church tax), Sparer-Pauschbetrag used, Teilfreistellung;
   - IN: equity STCG/LTCG, the ₹1.25L exemption, debt and gold fund rules.
2. Take-money-out planner (sales that restore targets with the least tax). XIRR and TWR.
3. Degiro `Transactions.csv` importer (ask the user for the header row only). Dedupe on date + ISIN + qty + price.
4. Local CAS PDF parsing (NSDL/CAMS) in the browser.
5. ULIP NAV automation, price alerts, an edit/delete-trade op (with replay).

## Conventions
- No dependencies, no build. Node 20+ built-ins only for scripts.
- Money: `€1,234.56`, `₹` for INR. Tabular numbers.
- Before finishing a change, run the tests in both places, and check `#demo` at 375px width (no horizontal scroll):
  - `web/tests.html` (python http.server);
  - CI (`node scripts/test.mjs`, `--selftest`).

## History
- v0: a claude.ai page using localStorage.
- v1: a Python CLI (`portfolio.py`, stdlib) writing `report.html`. Its logic was ported to `core.js` and `importers/degiro.js`, and it is retired.
