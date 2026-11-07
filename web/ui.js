// DOM helpers and inline-SVG charts. Text is always set with textContent (never innerHTML),
// so names from imported files can't inject markup.
const SVG = "http://www.w3.org/2000/svg";

/** h("div.card#id", {attrs, on:{click}}, ...children) */
export function h(tag, props, ...kids) {
  if (props == null || typeof props !== "object" || props instanceof Node || Array.isArray(props)) { kids.unshift(props); props = {}; }
  const [name, ...rest] = tag.split(/(?=[.#])/);
  const el = document.createElement(name || "div");
  for (const r of rest) r[0] === "." ? el.classList.add(r.slice(1)) : (el.id = r.slice(1));
  setProps(el, props);
  append(el, kids);
  return el;
}
export function s(tag, props = {}, ...kids) {
  const el = document.createElementNS(SVG, tag);
  setProps(el, props);
  append(el, kids);
  return el;
}
function setProps(el, props) {
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === "style") Object.assign(el.style, v);          // CSSOM: allowed by the CSP
    else if (k === "class") el.setAttribute("class", v);
    else if (k in el && !(el instanceof SVGElement) && k !== "list") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
}
function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}
export const clear = (el) => { while (el.firstChild) el.firstChild.remove(); return el; };
export const cls = (v) => (v > 0 ? "gain" : v < 0 ? "loss" : "");

let toastTimer;
export function toast(msg) {
  document.querySelector(".toast")?.remove();
  const t = h("div.toast", { role: "status" }, msg);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 3500);
}

const color = (i) => `var(--c${(i % 7) + 1})`;

/** Donut with legend. items: [[label, value]] */
export function donut(items, total) {
  const R = 52, C = 2 * Math.PI * R;
  const svg = s("svg", { viewBox: "0 0 140 140", role: "img", "aria-label": "Allocation chart" },
    s("circle", { cx: 70, cy: 70, r: R, fill: "none", stroke: "var(--s2)", "stroke-width": 22 }));
  let off = 0;
  items.forEach(([, v], i) => {
    const len = (v / total) * C;
    svg.append(s("circle", {
      cx: 70, cy: 70, r: R, fill: "none", stroke: color(i), "stroke-width": 22,
      "stroke-dasharray": `${Math.max(0, len - 1).toFixed(2)} ${(C - len + 1).toFixed(2)}`,
      "stroke-dashoffset": (-off).toFixed(2), transform: "rotate(-90 70 70)",
    }));
    off += len;
  });
  const legend = h("ul.lg", items.map(([n, v], i) =>
    h("li", h("i", { style: { background: color(i) } }), n, h("span", ((v / total) * 100).toFixed(1) + "%"))));
  return h("div.dn", svg, legend);
}

/** Horizontal bars. items: [[label, value]]; fmt(value); colorFn(value, i) */
export function bars(items, fmt, colorFn = (v, i) => color(i)) {
  const max = Math.max(...items.map(([, v]) => Math.abs(v)), 1e-9);
  return h("div", items.map(([n, v], i) =>
    h("div.br", h("span.bl", { title: n }, n),
      h("div.bt", h("div.bf", { style: { width: Math.max(1, (Math.abs(v) / max) * 100).toFixed(1) + "%", background: colorFn(v, i) } })),
      h("span.bv", fmt(v)))));
}

/** Simple line chart. points: [[dateString, value]] */
export function line(points, fmt) {
  if (points.length < 2) return h("p.mu.sm", "Not enough history yet. A point is added each day prices are refreshed.");
  const W = 600, H = 160, P = 6;
  const xs = points.map((p) => Date.parse(p[0])), ys = points.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const X = (x) => P + ((x - x0) / (x1 - x0 || 1)) * (W - 2 * P), Y = (y) => H - P - ((y - y0) / (y1 - y0 || 1)) * (H - 2 * P);
  const d = points.map((p, i) => `${i ? "L" : "M"}${X(xs[i]).toFixed(1)},${Y(ys[i]).toFixed(1)}`).join("");
  return h("div.line",
    s("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", role: "img", "aria-label": "Value over time" },
      s("path", { d, fill: "none", stroke: "var(--c1)", "stroke-width": 2, "vector-effect": "non-scaling-stroke" })),
    h("div.row.sm.mu", h("span", points[0][0]), h("span.grow.right", `${fmt(y0)} – ${fmt(y1)}`), h("span", points.at(-1)[0])));
}
