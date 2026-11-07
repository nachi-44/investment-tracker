// Tiny test harness that runs both in the browser (tests.html) and in Node (scripts/test.mjs).
const tests = [];
export function test(name, fn) { tests.push({ name, fn }); }

export const assert = {
  ok(v, msg = "expected truthy") { if (!v) throw new Error(msg); },
  eq(a, b, msg) { if (a !== b) throw new Error(`${msg || "not equal"}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); },
  near(a, b, eps = 1e-6, msg) { if (!(Math.abs(a - b) <= eps)) throw new Error(`${msg || "not close"}: got ${a}, expected ${b}`); },
  deep(a, b, msg) { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${msg || "not deep-equal"}: got ${x}, expected ${y}`); },
  async rejects(fn, re, msg) {
    try { await fn(); } catch (e) { if (re && !re.test(e.message)) throw new Error(`${msg || "wrong error"}: ${e.message}`); return; }
    throw new Error(msg || "expected an error");
  },
  throws(fn, re, msg) {
    try { fn(); } catch (e) { if (re && !re.test(e.message)) throw new Error(`${msg || "wrong error"}: ${e.message}`); return; }
    throw new Error(msg || "expected an error");
  },
};

export async function run(log = console.log) {
  let pass = 0, fail = 0;
  for (const t of tests) {
    try { await t.fn(); pass++; log(`ok   ${t.name}`); }
    catch (e) { fail++; log(`FAIL ${t.name}\n     ${e.message}`); }
  }
  log(`\n${pass} passed, ${fail} failed`);
  return { pass, fail };
}
