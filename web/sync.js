// Storage backends and the sync loop.
// The vault file (already encrypted) is stored in a private GitHub repo through the Contents API.
// Each save sends the sha it was based on; if another device (or the price job) saved in between,
// GitHub answers 409/422 and we re-fetch, replay the pending edits on the newer data and save again.
import { b64, unb64, decryptData, encryptData } from "./vault.js";
import { applyOp, migrate } from "./core.js";

const enc = new TextEncoder(), dec = new TextDecoder();

export class ConflictError extends Error {}
export class AuthError extends Error {}

export class GitHubStore {
  constructor({ owner, repo, token, branch = "main", fetchFn = globalThis.fetch.bind(globalThis) }) {
    Object.assign(this, { owner, repo, token, branch, fetchFn });
  }
  async req(method, path, body) {
    const res = await this.fetchFn(`https://api.github.com/repos/${this.owner}/${this.repo}/${path}`, {
      method, cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 || res.status === 403) throw new AuthError(`GitHub refused access (${res.status}). Check the token and its repository access.`);
    return res;
  }
  /** Returns {text, sha} or null when the file doesn't exist. */
  async read(path) {
    const res = await this.req("GET", `contents/${encodeURI(path)}?ref=${this.branch}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub read failed (${res.status}).`);
    const j = await res.json();
    let content = j.content;
    if (!content && j.size > 0) { // files over 1 MB: read the blob instead
      const blob = await this.req("GET", `git/blobs/${j.sha}`);
      if (!blob.ok) throw new Error(`GitHub blob read failed (${blob.status}).`);
      content = (await blob.json()).content;
    }
    return { text: dec.decode(unb64((content || "").replace(/\s/g, ""))), sha: j.sha };
  }
  /** Writes text; sha = the version it is based on (null for a new file). Returns the new sha. */
  async write(path, text, sha, message) {
    const res = await this.req("PUT", `contents/${encodeURI(path)}`, {
      message, branch: this.branch, content: b64(enc.encode(text)), ...(sha ? { sha } : {}),
    });
    if (res.status === 409 || res.status === 422) throw new ConflictError("The vault changed on another device.");
    if (!res.ok) throw new Error(`GitHub save failed (${res.status}).`);
    return (await res.json()).content.sha;
  }
  /** Start a workflow run (needs the token permission "Actions: read and write"). */
  async dispatch(workflow) {
    let res;
    try { res = await this.req("POST", `actions/workflows/${workflow}/dispatches`, { ref: this.branch }); }
    catch (e) { if (e instanceof AuthError) throw new AuthError("The token can't start the price job. Add the permission 'Actions: Read and write' for the vault repository."); throw e; }
    if (res.status === 404) throw new Error("Price workflow not found in the vault repository.");
    if (res.status !== 204 && !res.ok) throw new Error(`Could not start the price job (${res.status}).`);
  }
}

/** In-memory store with the same interface (tests and the local demo). */
export class MemoryStore {
  constructor(files = {}) { this.files = files; this.n = 0; }
  async read(path) { const f = this.files[path]; return f ? { ...f } : null; }
  async write(path, text, sha) {
    const cur = this.files[path];
    if ((cur?.sha || null) !== (sha || null)) throw new ConflictError("The vault changed on another device.");
    const nsha = "m" + ++this.n;
    this.files[path] = { text, sha: nsha };
    return nsha;
  }
  async dispatch(workflow) { this.dispatched = (this.dispatched || []).concat(workflow); if (this.onDispatch) await this.onDispatch(workflow); }
}

export const VAULT_PATH = "portfolio.enc";

/**
 * Holds the decrypted portfolio in memory and keeps it in step with the store.
 * Edits go through commit(op): applied locally at once, then saved; on conflict replayed on the newer data.
 */
export class Vault {
  constructor(store, session) {
    this.store = store; this.session = session;
    this.db = null; this.sha = null; this.pending = [];
  }
  async load() {
    const f = await this.store.read(VAULT_PATH);
    if (!f) throw new Error("No vault found in the repository yet.");
    this.db = migrate(await decryptData(JSON.parse(f.text), this.session));
    this.sha = f.sha;
    return this.db;
  }
  /** Preview an op without saving (throws on invalid input). */
  preview(op) { return applyOp(this.db, op); }
  async commit(op, message = describe(op)) {
    const { db, result } = applyOp(this.db, op); // validate first; throws without side effects
    this.pending.push(op);
    this.db = db;
    await this.flush(message);
    return result;
  }
  async flush(message = "update") {
    for (let attempt = 0; attempt < 4 && this.pending.length; attempt++) {
      try {
        const file = await encryptData(this.session, this.db);
        this.sha = await this.store.write(VAULT_PATH, JSON.stringify(file), this.sha, message);
        this.pending = [];
        return;
      } catch (e) {
        if (!(e instanceof ConflictError)) throw e;
        // Newer version elsewhere: take it and replay our edits on top.
        const f = await this.store.read(VAULT_PATH);
        let db = migrate(await decryptData(JSON.parse(f.text), this.session));
        for (const op of this.pending) db = applyOp(db, op).db;
        this.db = db; this.sha = f.sha;
      }
    }
    if (this.pending.length) throw new Error("Could not save after several retries. Your edit is kept on this device; try again.");
  }
}

/** Commit messages are not encrypted, so they never say what changed. */
export function describe() { return "update"; }
