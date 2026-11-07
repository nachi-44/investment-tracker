# Portfolio tracker

A private, encrypted portfolio dashboard for PC and phone. It combines Degiro (EUR), Indian demat and mutual funds (INR) and an SBI Life ULIP, with totals in EUR.

- **Zero-knowledge:** holdings are encrypted in your browser (AES-256-GCM, PBKDF2 600k). Only ciphertext is stored, in a *private* GitHub repo.
- **Works on the phone:** installable from the browser ("Add to Home Screen"), with read-only offline access.
- **Current prices when you open it:** opening the app (or tapping ↻) starts the price job on GitHub. About a minute later the app shows prices "as of" that time. Stocks, ETFs and FX are live to about 15 minutes; mutual funds and the ULIP have one price per day. A scheduled run also happens twice a weekday. The job uses public data only and never sees your holdings:
  - ECB and Yahoo exchange rates
  - AMFI mutual fund NAVs
  - Yahoo/Stooq quotes for stocks and ETFs
- **Record on the move:** buy, sell, ULIP payment, manual price, Degiro `Portfolio.csv` import. If two devices edit at once, both edits are kept.
- **Plan tab:** rule-based checks, allocation against your own targets (5/25 bands), and a new-money split.

The app reports facts and arithmetic from your own rules. **It is not financial advice.**

## Layout
| Repo | Visibility | Contents |
|---|---|---|
| `investment-tracker` (this one) | public | app code (`web/`), tests, price script, sample data. **Never real data.** |
| `investment-vault` | **private** | `portfolio.enc` (encrypted), `watchlist.json` (identifiers only), `prices/` (public market data), daily price workflow |

No build step, no dependencies: plain ES modules in `web/`.

## First-time setup (about 10 minutes)
1. **GitHub security:** keep your 2FA and add a passkey (Settings → Password and authentication). Store your recovery codes safely.
2. **Access token:** go to Settings → Developer settings → Fine-grained tokens → Generate.
   - Repository access: *Only select repositories* → `investment-vault`.
   - Permissions: *Contents: Read and write* and *Actions: Read and write* (Actions lets the app start the price job when you open it).
   - Expiration: 1 year.
3. Open the app (the GitHub Pages URL). Enter `nachi-44/investment-vault` and the token, leave the passphrase empty, and press **Connect**.
4. Choose your private `seed.json` (same format as `web/seed.example.json`) and set a passphrase of 5+ random words. **Save the recovery key** it shows.
5. On the phone, open the same URL, press **Connect** with the token and passphrase, then *Add to Home Screen*.
6. In the vault repo: Actions → *Daily prices* → **Run workflow** to fetch prices the first time.

## Development
```bash
python -m http.server 8765 --bind 127.0.0.1 --directory web
```
- App: http://localhost:8765/
- Sample data, no GitHub needed: http://localhost:8765/#demo
- Tests in the browser: http://localhost:8765/tests.html
- In CI: `node scripts/test.mjs` and `node scripts/fetch-prices.mjs --selftest`

## Files
- `web/core.js`: positions, FIFO lots, trades as replayable ops, totals, filters
- `web/vault.js`: envelope encryption (data key wrapped by the passphrase and by the recovery key)
- `web/sync.js`: GitHub Contents API store, conflict replay
- `web/prices.js`: watchlist, merging daily prices, value-over-time
- `web/rules.js`: checks, allocation bands, new-money split
- `web/importers/degiro.js`: Degiro `Portfolio.csv`
- `web/app.js`, `web/ui.js`, `web/styles.css`: the interface
- `scripts/fetch-prices.mjs`: the daily price job (runs in the vault repo)
- `vault-template/`: files for the private vault repo
