import { test, assert } from "./harness.js";
import { createVault, unlock, recover, changePassphrase, decryptData, encryptData, passphraseProblem, toRecoveryString, fromRecoveryString, sealSecret, openSecret } from "../vault.js";

const PASS = "correct horse battery staple orbit";
const fast = { iterations: 1000 }; // tests only; real vaults use 600k

test("passphrase policy", () => {
  assert.ok(passphraseProblem("short"));
  assert.ok(passphraseProblem("aaaaaaaaaaaaaaaaaaaa"), "no variety");
  assert.eq(passphraseProblem(PASS), "");
  assert.eq(passphraseProblem("Xk9#mP2$vL7qR4!w"), "");
});

test("recovery key string round trip", () => {
  const b = crypto.getRandomValues(new Uint8Array(32));
  const s = toRecoveryString(b);
  assert.eq(s.replace(/-/g, "").length, 52);
  assert.deep([...fromRecoveryString(s.toLowerCase())], [...b]);
});

test("create, unlock, decrypt round trip; ciphertext has no plaintext", async () => {
  const data = { positions: [{ sym: "SecretCo", qty: 42 }] };
  const { file, recovery } = await createVault(PASS, data, fast);
  const json = JSON.stringify(file);
  assert.ok(!json.includes("SecretCo"), "plaintext leaked");
  assert.ok(recovery.length > 50);
  const s = await unlock(file, PASS);
  assert.deep(await decryptData(file, s), data);
});

test("wrong passphrase fails", async () => {
  const { file } = await createVault(PASS, { a: 1 }, fast);
  await assert.rejects(() => unlock(file, PASS + "x"), /Wrong passphrase/);
});

test("tampered ciphertext is rejected", async () => {
  const { file, session } = await createVault(PASS, { a: 1 }, fast);
  const ct = file.data.ct;
  const bad = { ...file, data: { ...file.data, ct: (ct[0] === "A" ? "B" : "A") + ct.slice(1) } };
  await assert.rejects(() => decryptData(bad, session), /could not be decrypted/);
});

test("every save uses a fresh IV", async () => {
  const { session } = await createVault(PASS, { a: 1 }, fast);
  const a = await encryptData(session, { a: 1 }), b = await encryptData(session, { a: 1 });
  assert.ok(a.data.iv !== b.data.iv && a.data.ct !== b.data.ct);
});

test("recovery key resets the passphrase; data stays readable", async () => {
  const { file, recovery } = await createVault(PASS, { a: 2 }, fast);
  const NEW = "new purple mountain river lamp";
  const r = await recover(file, recovery, NEW);
  assert.deep(await decryptData(r.file, r.session), { a: 2 });
  await assert.rejects(() => unlock(r.file, PASS), /Wrong passphrase/);
  const s = await unlock(r.file, NEW);
  assert.deep(await decryptData(r.file, s), { a: 2 });
  await assert.rejects(() => recover(file, toRecoveryString(new Uint8Array(32)), NEW), /doesn't match/);
});

test("change passphrase needs the current one", async () => {
  const { file } = await createVault(PASS, { a: 3 }, fast);
  await assert.rejects(() => changePassphrase(file, "wrong one here ok fine", "another five word phrase here"), /Current passphrase/);
  const r = await changePassphrase(file, PASS, "another five word phrase here");
  assert.ok(r.file.kdf.iter >= 600000, "upgraded to full iterations");
});

test("session adopts a newer header from another device", async () => {
  const { file, session } = await createVault(PASS, { a: 4 }, fast);
  const r = await changePassphrase(file, PASS, "another five word phrase here");
  const saved = await encryptData(r.session, { a: 5 });
  assert.deep(await decryptData(saved, session), { a: 5 });
  const next = await encryptData(session, { a: 6 });
  assert.deep(next.wraps, saved.wraps, "kept the new passphrase wrap");
});

test("local secrets are sealed with the data key", async () => {
  const { session } = await createVault(PASS, {}, fast);
  const box = await sealSecret(session, "token-value");
  assert.eq(await openSecret(session, box), "token-value");
});
