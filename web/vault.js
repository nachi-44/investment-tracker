// Envelope encryption for the portfolio (WebCrypto only; same code in the browser and in Node 20+).
//
//   data key (DEK): random 256-bit AES-GCM key, encrypts the portfolio JSON
//   DEK wrapped by: passphrase  -> PBKDF2-SHA256 (600k iterations, random salt) -> AES-GCM
//                   recovery key (random 256-bit, shown once to the user)        -> AES-GCM
//
// File format (JSON, safe to store anywhere):
//   {format:"pt-vault", v:1, kdf:{name, hash, iter, salt}, wraps:{pass:{iv,ct}, recovery:{iv,ct}}, data:{iv,ct}}
// Every save uses a fresh random IV. AES-GCM authenticates: any tampering makes decryption fail.

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder(), dec = new TextDecoder();
export const ITERATIONS = 600_000;
const AAD_DATA = enc.encode("pt-vault-v1:data");
const AAD_WRAP = enc.encode("pt-vault-v1:dek");

// ---------- encoding helpers ----------
export function b64(bytes) {
  bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

// Recovery key: 32 random bytes in Crockford base32, groups of 4 (52 chars). Easy to print and retype.
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function toRecoveryString(bytes) {
  let bits = 0, val = 0, out = "";
  for (const b of bytes) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out.match(/.{1,4}/g).join("-");
}
export function fromRecoveryString(s) {
  const clean = s.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  let bits = 0, val = 0; const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("Recovery key contains an invalid character.");
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  if (out.length !== 32) throw new Error("Recovery key has the wrong length.");
  return new Uint8Array(out);
}

// ---------- keys ----------
async function passKEK(passphrase, salt, iter) {
  const base = await subtle.importKey("raw", enc.encode(passphrase.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
const rawKEK = (bytes) => subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
const dataKey = (bytes) => subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

async function seal(key, bytes, aad) {
  const iv = rand(12);
  const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, bytes);
  return { iv: b64(iv), ct: b64(ct) };
}
async function open(key, box, aad) {
  return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: unb64(box.iv), additionalData: aad }, key, unb64(box.ct)));
}

/** Passphrase policy: 5+ words, or 16+ characters with some variety. Returns an error message or "". */
export function passphraseProblem(p) {
  if (!p) return "Enter a passphrase.";
  const words = p.trim().split(/[\s\-_.]+/).filter((w) => w.length >= 3);
  if (words.length >= 5) return "";
  if (p.length >= 16 && new Set(p).size >= 10) return "";
  return "Use at least 5 random words (e.g. from a dice list) or 16+ varied characters.";
}

// ---------- vault ----------

/** Create a new vault. Returns {file, session, recovery} — show `recovery` to the user once. */
export async function createVault(passphrase, data, { iterations = ITERATIONS } = {}) {
  const problem = passphraseProblem(passphrase);
  if (problem) throw new Error(problem);
  const dek = rand(32), rec = rand(32), salt = rand(16);
  const file = {
    format: "pt-vault", v: 1,
    kdf: { name: "PBKDF2", hash: "SHA-256", iter: iterations, salt: b64(salt) },
    wraps: {
      pass: await seal(await passKEK(passphrase, salt, iterations), dek, AAD_WRAP),
      recovery: await seal(await rawKEK(rec), dek, AAD_WRAP),
    },
  };
  const session = { key: await dataKey(dek), header: headerOf(file) };
  dek.fill(0);
  file.data = await seal(session.key, enc.encode(JSON.stringify(data)), AAD_DATA);
  return { file, session, recovery: toRecoveryString(rec) };
}

const headerOf = (file) => ({ format: file.format, v: file.v, kdf: file.kdf, wraps: file.wraps });
const sameHeader = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Unlock with the passphrase. Returns a session {key, header}. Wrong passphrase -> Error("Wrong passphrase"). */
export async function unlock(file, passphrase) {
  check(file);
  const kek = await passKEK(passphrase, unb64(file.kdf.salt), file.kdf.iter);
  let dek;
  try { dek = await open(kek, file.wraps.pass, AAD_WRAP); }
  catch { throw new Error("Wrong passphrase."); }
  const session = { key: await dataKey(dek), header: headerOf(file) };
  dek.fill(0);
  return session;
}

/** Unlock with the recovery key and set a new passphrase. Returns {file, session} (file must be saved). */
export async function recover(file, recoveryString, newPassphrase) {
  check(file);
  const problem = passphraseProblem(newPassphrase);
  if (problem) throw new Error(problem);
  let dek;
  try { dek = await open(await rawKEK(fromRecoveryString(recoveryString)), file.wraps.recovery, AAD_WRAP); }
  catch (e) { throw new Error(e.message.startsWith("Recovery") ? e.message : "Recovery key doesn't match this vault."); }
  return rewrap(file, dek, newPassphrase);
}

/** Change the passphrase (needs the current one). Data stays encrypted with the same data key. */
export async function changePassphrase(file, oldPassphrase, newPassphrase) {
  check(file);
  const problem = passphraseProblem(newPassphrase);
  if (problem) throw new Error(problem);
  const kek = await passKEK(oldPassphrase, unb64(file.kdf.salt), file.kdf.iter);
  let dek;
  try { dek = await open(kek, file.wraps.pass, AAD_WRAP); } catch { throw new Error("Current passphrase is wrong."); }
  return rewrap(file, dek, newPassphrase);
}

async function rewrap(file, dek, passphrase) {
  const salt = rand(16), iter = Math.max(file.kdf.iter, ITERATIONS);
  const out = { ...file, kdf: { ...file.kdf, iter, salt: b64(salt) }, wraps: { ...file.wraps, pass: await seal(await passKEK(passphrase, salt, iter), dek, AAD_WRAP) } };
  const session = { key: await dataKey(dek), header: headerOf(out) };
  dek.fill(0);
  return { file: out, session };
}

export async function decryptData(file, session) {
  check(file);
  let data;
  try { data = JSON.parse(dec.decode(await open(session.key, file.data, AAD_DATA))); }
  catch (e) { throw new Error("Vault data could not be decrypted (damaged, tampered, or re-keyed elsewhere)."); }
  // Same data key, possibly a new passphrase wrap from another device: adopt the newer header so a save keeps it.
  if (!sameHeader(headerOf(file), session.header)) session.header = headerOf(file);
  return data;
}

export async function encryptData(session, data) {
  return { ...session.header, data: await seal(session.key, enc.encode(JSON.stringify(data)), AAD_DATA) };
}

/** Encrypt/decrypt small local secrets (the GitHub token) with the session's data key. */
export async function sealSecret(session, text) { return seal(session.key, enc.encode(text), enc.encode("pt-vault-v1:local")); }
export async function openSecret(session, box) { return dec.decode(await open(session.key, box, enc.encode("pt-vault-v1:local"))); }

function check(file) {
  if (!file || file.format !== "pt-vault" || file.v !== 1) throw new Error("Not a portfolio vault file.");
}
