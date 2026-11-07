// Runs the shared test suite in Node 20+ (used by CI): node scripts/test.mjs
import { run } from "../web/test/all.js";
const { fail } = await run();
process.exit(fail ? 1 : 0);
