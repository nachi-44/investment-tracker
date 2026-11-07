import { run } from "./all.js";
const out = document.getElementById("out");
const lines = [];
const r = await run((l) => { lines.push(l); out.textContent = lines.join("\n"); });
document.title = `${r.fail ? "FAIL" : "PASS"} ${r.pass}/${r.pass + r.fail}`;
out.dataset.result = r.fail ? "fail" : "pass";
