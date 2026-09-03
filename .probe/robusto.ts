// ¿Aguanta el hallazgo de la cancelación fuera del umbral que elegí?
//
// Un efecto real no depende de haber puesto el listón en z≥1,5 y el horizonte
// en 4 h. Si solo aparece ahí, es que lo encontré buscando, no midiendo.
import { readFileSync } from "node:fs";
const DIR = "C:/Users/Manuel Quintero/.claude/projects/C--Users-Manuel-Quintero-Desktop-LIQRADARv4-liqradarv2-project-analysis-2a668--1-/e97df2ba-021e-4bdb-b256-2f43e419e807/tool-results";
const P = (f: string) => `${DIR}/mcp-ff8443a5-76d4-425f-b233-688b6a0f75e8-${f}.txt`;

const media = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const sdOf = (a: number[]) => { const m = media(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

const velas = (JSON.parse(readFileSync(P("get_candles-1788467860709"), "utf8")).records as { timestamp: string; close: string }[])
  .map((k) => ({ t: Date.parse(k.timestamp), c: Number(k.close) })).sort((a, b) => a.t - b.t);
const precioEn = (ts: number) => {
  let lo = 0, hi = velas.length - 1, r: { t: number; c: number } | null = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (velas[m].t <= ts) { r = velas[m]; lo = m + 1; } else hi = m - 1; }
  return r && ts - r.t <= 2 * 3600_000 ? r.c : NaN;
};

const flujo = (JSON.parse(readFileSync(P("get_order_flow-1788469185925"), "utf8")).records as {
  timestamp: string; limitOrdersPlaced: number; ordersCanceled: number;
}[]).map((f) => ({ ts: Date.parse(f.timestamp), ratio: f.limitOrdersPlaced > 0 ? f.ordersCanceled / f.limitOrdersPlaced : NaN }))
  .filter((f) => Number.isFinite(f.ratio)).sort((a, b) => a.ts - b.ts);

console.log(`\n\x1b[1mROBUSTEZ DEL HALLAZGO DE CANCELACIÓN\x1b[0m`);
console.log(`  ${"horizonte".padEnd(11)}${"umbral z".padStart(9)}${"casos".padStart(7)}${"anómalo".padStart(10)}${"resto".padStart(9)}${"σ".padStart(8)}`);
console.log(`  ${"─".repeat(54)}`);

for (const H of [1, 2, 4, 8]) {
  for (const UZ of [1.0, 1.5, 2.0]) {
    const pts: { z: number; mov: number }[] = [];
    const V = 72;
    for (let i = V; i < flujo.length - H; i++) {
      const w = flujo.slice(i - V, i).map((f) => f.ratio);
      const m = media(w), sd = sdOf(w);
      if (!(sd > 0)) continue;
      const p0 = precioEn(flujo[i].ts), p1 = precioEn(flujo[i].ts + H * 3600_000);
      if (!(p0 > 0) || !(p1 > 0)) continue;
      pts.push({ z: (flujo[i].ratio - m) / sd, mov: Math.abs(((p1 - p0) / p0) * 100) });
    }
    const alt = pts.filter((p) => p.z >= UZ).map((p) => p.mov);
    const res = pts.filter((p) => p.z < UZ).map((p) => p.mov);
    if (alt.length < 10) { console.log(`  ${(H + " h").padEnd(11)}${String(UZ).padStart(9)}${String(alt.length).padStart(7)}   pocos casos`); continue; }
    const ma = media(alt), mr = media(res);
    const se = Math.sqrt(sdOf(alt) ** 2 / alt.length + sdOf(res) ** 2 / res.length);
    const z = (ma - mr) / se;
    const col = Math.abs(z) > 1.96 ? (z < 0 ? "\x1b[32m" : "\x1b[33m") : "\x1b[2m";
    console.log(`  ${(H + " h").padEnd(11)}${String(UZ).padStart(9)}${String(alt.length).padStart(7)}` +
      `${ma.toFixed(3).padStart(10)}${mr.toFixed(3).padStart(9)}${col}${z.toFixed(2).padStart(8)}\x1b[0m`);
  }
}
console.log(`\n\x1b[2m  verde = menos volatilidad tras cancelación anómala (el efecto encontrado)`);
console.log(`  gris  = no se distingue del azar\x1b[0m\n`);
