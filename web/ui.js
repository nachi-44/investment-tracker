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

// Stable colour per asset class, so a class looks the same in every chart and avatar.
const CLASS_COLOR = { Stock: 1, ETF: 2, Gold: 3, "Equity fund": 5, "Debt fund": 6, "Hybrid fund": 4, Cash: 7, "Insurance (ULIP)": 4, Other: 7 };
export const classColor = (cls, i = 0) => `var(--c${CLASS_COLOR[cls] ?? (i % 7) + 1})`;

/** Rounded-square avatar with initials, coloured by asset class. */
export function avatar(name, cls) {
  const words = String(name).replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const ini = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || "?").slice(0, 2)).toUpperCase();
  const c = classColor(cls);
  return h("div.av", { "aria-hidden": "true", style: { background: `linear-gradient(135deg, ${c}, color-mix(in srgb, ${c} 55%, #000))` } }, ini);
}

/** Small inline icons (stroke style). */
const ICONS = {
  overview: "M3 12l9-8 9 8M5 10v10h5v-6h4v6h5V10",
  holdings: "M4 6h16M4 12h16M4 18h10",
  record: "M12 5v14M5 12h14",
  plan: "M12 3a9 9 0 1 0 9 9M12 7a5 5 0 1 0 5 5M12 11a1 1 0 1 0 1 1M21 3l-9 9",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  refresh: "M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5",
  lock: "M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4",
};
export function icon(name) {
  return s("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 1.9, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" },
    s("path", { d: ICONS[name] }));
}

/** App logo (same as the home-screen icon). */
export function logo(cls = "") {
  const id = "lg" + Math.random().toString(36).slice(2, 7);
  return s("svg", { viewBox: "0 0 64 64", class: cls, "aria-hidden": "true" },
    s("defs", {}, s("linearGradient", { id, x1: 0, y1: 0, x2: 1, y2: 1 },
      s("stop", { offset: "0", "stop-color": "#4F46E5" }), s("stop", { offset: ".55", "stop-color": "#7C3AED" }), s("stop", { offset: "1", "stop-color": "#0EA5E9" }))),
    s("rect", { width: 64, height: 64, rx: 18, fill: `url(#${id})` }),
    s("path", { d: "M14 44l12-13 9 8 15-19", fill: "none", stroke: "#fff", "stroke-width": 5, "stroke-linecap": "round", "stroke-linejoin": "round" }),
    s("circle", { cx: 50, cy: 20, r: 4, fill: "#5EEAD4" }));
}

/** Donut with a centre label and legend. items: [[label, value]]; colorOf(label, i) */
export function donut(items, total, { center, sub, colorOf = (n, i) => color(i) } = {}) {
  const R = 54, C = 2 * Math.PI * R;
  const svg = s("svg", { viewBox: "0 0 140 140", role: "img", "aria-label": "Allocation chart" },
    s("circle", { cx: 70, cy: 70, r: R, fill: "none", stroke: "var(--s2)", "stroke-width": 16 }));
  let off = 0;
  items.forEach(([n, v], i) => {
    const len = (v / total) * C;
    svg.append(s("circle", {
      cx: 70, cy: 70, r: R, fill: "none", stroke: colorOf(n, i), "stroke-width": 16, "stroke-linecap": items.length > 1 ? "butt" : "round",
      "stroke-dasharray": `${Math.max(0, len - 2).toFixed(2)} ${(C - len + 2).toFixed(2)}`,
      "stroke-dashoffset": (-off).toFixed(2), transform: "rotate(-90 70 70)",
    }));
    off += len;
  });
  const legend = h("ul.lg", items.map(([n, v], i) =>
    h("li", h("i", { style: { background: colorOf(n, i) } }), n, h("span", ((v / total) * 100).toFixed(1) + "%"))));
  return h("div.dn", h("div.ring", svg, center && h("div.center", h("b", center), sub && h("span", sub))), legend);
}

/**
 * Interactive hero chart: area + line, a marker that follows the pointer/finger, and onHover(index|null).
 * points: [[date, value]]
 */
export function heroChart(points, onHover) {
  const W = 600, H = 120;
  const svg = heroArea(points, W, H);
  const xs = points.map((_, i) => (i / (points.length - 1)) * W);
  const ys = points.map((p) => p[1]);
  const y0 = Math.min(...ys), y1 = Math.max(...ys), pad = (y1 - y0) * 0.15 || 1;
  const Y = (y) => H - 8 - ((y - (y0 - pad)) / (y1 - y0 + 2 * pad)) * (H - 16);
  const vline = s("line", { y1: 0, y2: H, stroke: "rgba(255,255,255,.55)", "stroke-width": 1, "vector-effect": "non-scaling-stroke", "stroke-dasharray": "3 3", visibility: "hidden" });
  const dot = s("circle", { r: 5, fill: "#fff", stroke: "rgba(0,0,0,.25)", "stroke-width": 2, "vector-effect": "non-scaling-stroke", visibility: "hidden" });
  svg.append(vline, dot);
  const pick = (clientX) => {
    const r = svg.getBoundingClientRect();
    const x = ((clientX - r.left) / r.width) * W;
    let i = Math.round((x / W) * (points.length - 1));
    i = Math.max(0, Math.min(points.length - 1, i));
    vline.setAttribute("x1", xs[i]); vline.setAttribute("x2", xs[i]);
    dot.setAttribute("cx", xs[i]); dot.setAttribute("cy", Y(ys[i]));
    vline.setAttribute("visibility", "visible"); dot.setAttribute("visibility", "visible");
    onHover?.(i);
  };
  const leave = () => { vline.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); onHover?.(null); };
  svg.addEventListener("pointermove", (e) => pick(e.clientX));
  svg.addEventListener("pointerdown", (e) => { pick(e.clientX); svg.setPointerCapture?.(e.pointerId); });
  svg.addEventListener("pointerup", leave);
  svg.addEventListener("pointerleave", leave);
  svg.addEventListener("pointercancel", leave);
  svg.style.touchAction = "pan-y";
  return svg;
}

/** Area chart for the hero card (white on gradient). points: [[date, value]] */
export function heroArea(points, W = 600, H = 110) {
  const ys = points.map((p) => p[1]);
  const y0 = Math.min(...ys), y1 = Math.max(...ys), pad = (y1 - y0) * 0.15 || 1;
  const X = (i) => (i / (points.length - 1)) * W, Y = (y) => H - 8 - ((y - (y0 - pad)) / (y1 - y0 + 2 * pad)) * (H - 16);
  const pts = points.map((p, i) => [X(i), Y(p[1])]);
  // smooth path (Catmull-Rom to Bezier)
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  const id = "ha" + Math.random().toString(36).slice(2, 7);
  const last = pts.at(-1);
  return s("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", role: "img", "aria-label": "Portfolio value over time" },
    s("defs", {}, s("linearGradient", { id, x1: 0, y1: 0, x2: 0, y2: 1 },
      s("stop", { offset: "0", "stop-color": "#fff", "stop-opacity": ".35" }), s("stop", { offset: "1", "stop-color": "#fff", "stop-opacity": "0" }))),
    s("path", { d: `${d}L${W},${H}L0,${H}Z`, fill: `url(#${id})` }),
    s("path", { d, fill: "none", stroke: "#fff", "stroke-width": 2, "vector-effect": "non-scaling-stroke", "stroke-linecap": "round", "stroke-linejoin": "round" }),
    s("circle", { cx: last[0] - 4, cy: last[1], r: 4, fill: "#fff" }));
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
      s("path", { d, fill: "none", stroke: "var(--acc)", "stroke-width": 2.5, "vector-effect": "non-scaling-stroke", "stroke-linecap": "round" })),
    h("div.row.sm.mu", h("span", points[0][0]), h("span.grow.right", `${fmt(y0)} – ${fmt(y1)}`), h("span", points.at(-1)[0])));
}
