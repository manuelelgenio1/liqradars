// ============================================================
// ¿O ES SOLO QUE LA VOLATILIDAD SE AGRUPA?
//
// En Binance salió que MÁS rotación del libro predice MÁS volatilidad
// (+2,89σ a 2 h) — el signo contrario al de Hyperliquid. Antes de contarlo
// como hallazgo hay que descartar lo obvio.
//
// LA SOSPECHA. La rotación del libro sube cuando el precio se mueve: los
// creadores recolocan sus órdenes porque el mercado se ha ido. Y la
// volatilidad se AGRUPA — a una hora movida le sigue otra movida, cosa
// conocida desde los años ochenta.
//
// Así que "rotación alta predice volatilidad" podría ser sencillamente "hora
// volátil predice hora volátil", disfrazado de descubrimiento.
//
// CÓMO SE SEPARA. Se compara rotación alta contra el resto DENTRO de terciles
// de volatilidad actual. Si el efecto sobrevive con la volatilidad de la hora
// en curso ya fijada, la rotación aporta algo propio. Si se evapora, era
// agrupamiento.
// ============================================================
import { existsSync, readFileSync } from "node:fs";

const CACHE = ".probe/cache";
const SIM = "BTCUSDT";
const VENTANA = 72;
const H = 2;
const UZ = 1.0;

const media = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const sdOf = (a: number[]) => {
  const m = media(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

const dias = (n: number, hasta = Date.now() - 2 * 864e5) =>
  Array.from({ length: n }, (_, i) => new Date(hasta - (n - 1 - i) * 864e5).toISOString().slice(0, 10));

// ---------- de la caché ----------
const fotos: { t: number; usd: number }[] = [];
for (const d of dias(30)) {
  const f = `${CACHE}/churn-${SIM}-${d}.json`;
  if (existsSync(f)) fotos.push(...JSON.parse(readFileSync(f, "utf8")));
}
fotos.sort((a, b) => a.t - b.t);

const kf = require("node:fs").readdirSync(CACHE).find((x: string) => x.startsWith(`churn-k-${SIM}-`));
const vel = (JSON.parse(readFileSync(`${CACHE}/${kf}`, "utf8")) as { t: number; c: number }[]).sort((a, b) => a.t - b.t);

const precioEn = (ts: number) => {
  let lo = 0, hi = vel.length - 1, r: { t: number; c: number } | null = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (vel[m].t <= ts) { r = vel[m]; lo = m + 1; } else hi = m - 1; }
  return r && ts - r.t <= 2 * 3600_000 ? r.c : NaN;
};

// ---------- rotación por hora ----------
const porHora = new Map<number, number[]>();
for (let i = 1; i < fotos.length; i++) {
  const dt = fotos[i].t - fotos[i - 1].t;
  if (dt <= 0 || dt > 120_000) continue;
  const prev = fotos[i - 1].usd;
  if (!(prev > 0)) continue;
  const h = Math.floor(fotos[i].t / 3600_000) * 3600_000;
  const v = porHora.get(h) ?? [];
  v.push(Math.abs(fotos[i].usd - prev) / prev);
  porHora.set(h, v);
}
const serie = [...porHora.entries()]
  .filter(([, v]) => v.length >= 30)
  .map(([t, v]) => ({ t, churn: media(v) }))
  .sort((a, b) => a.t - b.t);

// ---------- puntos con volatilidad actual ----------
const pts: { z: number; mov: number; actual: number }[] = [];
for (let i = VENTANA; i < serie.length - H; i++) {
  const w = serie.slice(i - VENTANA, i).map((s) => s.churn);
  const m = media(w), sd = sdOf(w);
  if (!(sd > 0)) continue;
  const pPrev = precioEn(serie[i].t - 3600_000);
  const p0 = precioEn(serie[i].t);
  const p1 = precioEn(serie[i].t + H * 3600_000);
  if (!(p0 > 0) || !(p1 > 0) || !(pPrev > 0)) continue;
  pts.push({
    z: (serie[i].churn - m) / sd,
    mov: Math.abs(((p1 - p0) / p0) * 100),
    actual: Math.abs(((p0 - pPrev) / pPrev) * 100),
  });
}

console.log(`\n\x1b[1m¿O ES SOLO QUE LA VOLATILIDAD SE AGRUPA?\x1b[0m`);
console.log(`${SIM} · horizonte ${H} h · umbral z≥${UZ} · ${pts.length} puntos\n`);

// Primero, lo evidente: ¿la rotación va con la volatilidad actual?
const corr = (() => {
  const x = pts.map((p) => p.z), y = pts.map((p) => p.actual);
  const mx = media(x), my = media(y);
  const num = x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0);
  return num / Math.sqrt(x.reduce((s, v) => s + (v - mx) ** 2, 0) * y.reduce((s, v) => s + (v - my) ** 2, 0));
})();
console.log(`  correlación entre rotación y volatilidad ACTUAL: \x1b[1m${corr.toFixed(3)}\x1b[0m`);
console.log(`  \x1b[2m${corr > 0.3 ? "alta: la rotación es en gran medida un reflejo de lo que ya pasó" : "baja: la rotación mide algo distinto"}\x1b[0m\n`);

const ordenados = [...pts].sort((a, b) => a.actual - b.actual);
const c1 = ordenados[Math.floor(ordenados.length / 3)].actual;
const c2 = ordenados[Math.floor((2 * ordenados.length) / 3)].actual;

console.log(`  ${"tercil de volatilidad".padEnd(24)}${"casos".padStart(7)}${"alta rot.".padStart(11)}${"resto".padStart(9)}${"σ".padStart(8)}`);
console.log(`  ${"─".repeat(59)}`);

const terciles: [string, (x: (typeof pts)[number]) => boolean][] = [
  ["bajo (hora tranquila)", (x) => x.actual <= c1],
  ["medio", (x) => x.actual > c1 && x.actual <= c2],
  ["alto (hora movida)", (x) => x.actual > c2],
];

let supervivientes = 0;
for (const [nom, filtro] of terciles) {
  const sub = pts.filter(filtro);
  const alt = sub.filter((p) => p.z >= UZ).map((p) => p.mov);
  const res = sub.filter((p) => p.z < UZ).map((p) => p.mov);
  if (alt.length < 8 || res.length < 8) {
    console.log(`  ${nom.padEnd(24)}${String(alt.length).padStart(7)}   pocos casos`);
    continue;
  }
  const ma = media(alt), mr = media(res);
  const se = Math.sqrt(sdOf(alt) ** 2 / alt.length + sdOf(res) ** 2 / res.length);
  const z = (ma - mr) / se;
  // Tres terciles son TRES contrastes, así que Bonferroni sube el listón a
  // 2,39. Con 1,96 se colaría uno de cada veinte por azar, y aquí hay tres
  // tiros: dejar el listón bajo sería fabricarse el resultado.
  if (Math.abs(z) > 2.39) supervivientes++;
  const col = Math.abs(z) > 2.39 ? "\x1b[33m" : "\x1b[2m";
  console.log(`  ${nom.padEnd(24)}${String(alt.length).padStart(7)}${ma.toFixed(3).padStart(11)}${mr.toFixed(3).padStart(9)}${col}${z.toFixed(2).padStart(8)}\x1b[0m`);
}

console.log(`\n  \x1b[1m${supervivientes === 0
  ? "\x1b[31mEl efecto se evapora al controlar por la volatilidad actual\x1b[0m"
  : `\x1b[33mSobrevive en ${supervivientes} de 3 terciles\x1b[0m`}\x1b[0m`);
console.log(`  \x1b[2m${supervivientes === 0
  ? "Era agrupamiento de volatilidad, no información nueva. El sustituto de\n  Binance no mide lo mismo que la proporción de cancelaciones."
  : "La rotación aporta algo por encima del agrupamiento."}\x1b[0m\n`);
