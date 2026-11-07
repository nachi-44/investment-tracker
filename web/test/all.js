// Loads every test file. Used by tests.html (browser) and scripts/test.mjs (Node).
import "./core.test.js";
import "./vault.test.js";
import "./sync.test.js";
import "./degiro.test.js";
import "./prices.test.js";
export { run } from "./harness.js";
