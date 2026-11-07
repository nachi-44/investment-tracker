import { test, assert } from "./harness.js";
import { MemoryStore, Vault, VAULT_PATH, GitHubStore, ConflictError } from "../sync.js";
import { createVault, unlock } from "../vault.js";
import { migrate } from "../core.js";

const PASS = "correct horse battery staple orbit";
const seed = () => migrate({
  rates: {}, accounts: { degiro: { name: "Degiro", ccy: "EUR" } },
  positions: [{ acct: "degiro", sym: "Stock A", isin: "X1", cls: "Stock", qty: 10, cost: 1000, price: 100 }],
});

async function setup() {
  const { file } = await createVault(PASS, seed(), { iterations: 1000 });
  const store = new MemoryStore({ [VAULT_PATH]: { text: JSON.stringify(file), sha: "m0" } });
  const open = async () => { const v = new Vault(store, await unlock(file, PASS)); await v.load(); return v; };
  return { store, open };
}

test("commit saves and a second device sees it", async () => {
  const { open } = await setup();
  const a = await open();
  await a.commit({ type: "trade", side: "buy", acct: "degiro", sym: "Stock A", qty: 5, price: 100 });
  const b = await open();
  assert.eq(b.db.positions[0].qty, 15);
});

test("conflicting edits from two devices are both kept (replay)", async () => {
  const { open } = await setup();
  const phone = await open(), pc = await open();
  await phone.commit({ type: "trade", side: "buy", acct: "degiro", sym: "Stock A", qty: 1, price: 100 });
  await pc.commit({ type: "trade", side: "buy", acct: "degiro", sym: "Stock A", qty: 2, price: 100 }); // stale sha -> replay
  const check = await open();
  assert.eq(check.db.positions[0].qty, 13);
  assert.eq(check.db.trades.length, 2);
});

test("invalid op is rejected before anything is saved", async () => {
  const { open, store } = await setup();
  const v = await open();
  const before = store.files[VAULT_PATH].sha;
  await assert.rejects(() => v.commit({ type: "trade", side: "sell", acct: "degiro", sym: "Stock A", qty: 99, price: 1 }), /can't sell/);
  assert.eq(store.files[VAULT_PATH].sha, before);
  assert.eq(v.pending.length, 0);
});

test("GitHubStore maps HTTP codes and encodes content", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    if (init.method === "GET") return { status: 200, ok: true, json: async () => ({ content: btoa("hello"), sha: "s1", size: 5 }) };
    if (JSON.parse(init.body).sha === "old") return { status: 409, ok: false };
    return { status: 201, ok: true, json: async () => ({ content: { sha: "s2" } }) };
  };
  const gh = new GitHubStore({ owner: "o", repo: "r", token: "t", fetchFn: fakeFetch });
  assert.deep(await gh.read("portfolio.enc"), { text: "hello", sha: "s1" });
  assert.eq(calls[0].init.headers.Authorization, "Bearer t");
  assert.eq(await gh.write("portfolio.enc", "x", "s1", "update"), "s2");
  await assert.rejects(() => gh.write("portfolio.enc", "x", "old", "update"), /changed on another device/);
  const denied = new GitHubStore({ owner: "o", repo: "r", token: "t", fetchFn: async () => ({ status: 401, ok: false }) });
  await assert.rejects(() => denied.read("x"), /refused access/);
});

test("dispatch starts the price workflow; missing permission gives a clear message", async () => {
  let call;
  const ok = new GitHubStore({ owner: "o", repo: "r", token: "t", fetchFn: async (url, init) => { call = { url, init }; return { status: 204, ok: true }; } });
  await ok.dispatch("prices.yml");
  assert.ok(call.url.endsWith("/repos/o/r/actions/workflows/prices.yml/dispatches"));
  assert.eq(JSON.parse(call.init.body).ref, "main");
  const no = new GitHubStore({ owner: "o", repo: "r", token: "t", fetchFn: async () => ({ status: 403, ok: false }) });
  await assert.rejects(() => no.dispatch("prices.yml"), /Actions: Read and write/);
});
