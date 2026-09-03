// ============================================================
// DOS HIPÓTESIS QUE QUEDABAN
//
// 1. BARRIDO DE STOPS. Distinta de la del imán, aunque se parezca. Los
//    niveles de liquidación son FORZOSOS: los calcula el exchange desde el
//    margen. Los trigger orders son VOLUNTARIOS: los pone la gente a mano.
//    La tesis del "barrido" siempre habló de estos — que el mercado va a
//    buscar donde el minorista puso su stop.
//
//    Mecánica: el stop de un LARGO es una orden de VENTA por debajo; el de un
//    CORTO es una COMPRA por encima. Así que compras arriba = stops de cortos,
//    ventas abajo = stops de largos.
//
//    Mismo control que antes: BANDAS SIMÉTRICAS. Sin él ganaría siempre el
//    lado más cercano por pura geometría.
//
// 2. RETIRADA DE LIQUIDEZ. En una hora se ponen 2,1 millones de órdenes y se
//    cancelan 2,08 millones — el 97,8 %. La pregunta no es de dirección
//    (cancelar no tiene signo) sino de VOLATILIDAD: cuando esa proporción se
//    dispara, ¿viene un movimiento grande?
//
//    Esa pregunta sí es útil aunque no diga hacia dónde: avisa de cuándo NO
//    conviene un stop ajustado.
// ============================================================
import { readFileSync } from "node:fs";

const DIR = "C:/Users/Manuel Quintero/.claude/projects/C--Users-Manuel-Quintero-Desktop-LIQRADARv4-liqradarv2-project-analysis-2a668--1-/e97df2ba-021e-4bdb-b256-2f43e419e807/tool-results";
const P = (f: string) => `${DIR}/mcp-ff8443a5-76d4-425f-b233-688b6a0f75e8-${f}.txt`;

const TRIGGERS = [
  "get_trigger_levels_history-1788469161587",
  "get_trigger_levels_history-1788469168732",
  "get_trigger_levels_history-1788469176433",
  "get_trigger_levels_history-1788469309345",
  "get_trigger_levels_history-1788469315418",
];
const FLUJO = "get_order_flow-1788469185925";
const VELAS = "get_candles-1788467860709";

const BANDA_MIN = 0.01, BANDA_MAX = 0.05;
const HORIZONTE_H = 4;
const EVENTO_MS = 3 * 3600_000;
const COSTE = 0.14;
const LISTON = 2.24;

const media = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
function tStat(a: number[]) {
  const n = a.length, m = media(a);
  const sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1));
  return { n, m, t: sd > 0 ? m / (sd / Math.sqrt(n)) : NaN, sd };
}

// ---------- velas ----------
const velas = (JSON.parse(readFileSync(P(VELAS), "utf8")).records as { timestamp: string; close: string }[])
  .map((k) => ({ t: Date.parse(k.timestamp), c: Number(k.close) }))
  .sort((a, b) => a.t - b.t);

function precioEn(ts: number): number {
  let lo = 0, hi = velas.length - 1, res: { t: number; c: number } | null = null;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (velas[m].t <= ts) { res = velas[m]; lo = m + 1; } else hi = m - 1;
  }
  return res && ts - res.t <= 2 * 3600_000 ? res.c : NaN;
}

// ================= 1 · BARRIDO DE STOPS =================
interface TNivel { price_bucket: number; bid_size: number; ask_size: number }
interface TSnap { as_of?: string; snapshot_ts?: string; mid_price: number; levels: TNivel[] }

const tsnaps: TSnap[] = [];
for (const f of TRIGGERS) {
  try { tsnaps.push(...(JSON.parse(readFileSync(P(f), "utf8")).records as TSnap[])); } catch { /* falta */ }
}
const uniq = new Map<string, TSnap>();
for (const s of tsnaps) uniq.set(String(s.snapshot_ts ?? s.as_of), s);
const snaps = [...uniq.values()]
  .map((s) => ({ ...s, ts: Date.parse(String(s.snapshot_ts ?? s.as_of).replace(" ", "T") + (String(s.snapshot_ts ?? s.as_of).endsWith("Z") ? "" : "Z")) }))
  .filter((s) => Number.isFinite(s.ts))
  .sort((a, b) => a.ts - b.ts);

const obs: { ts: number; imb: number; ret: number }[] = [];
for (const s of snaps) {
  const mid = s.mid_price;
  if (!(mid > 0)) continue;
  // compras ARRIBA = stops de cortos · ventas ABAJO = stops de largos
  let comprasArriba = 0, ventasAbajo = 0;
  for (const l of s.levels ?? []) {
    const d = (l.price_bucket - mid) / mid;
    if (d >= BANDA_MIN && d <= BANDA_MAX) comprasArriba += l.bid_size || 0;
    if (-d >= BANDA_MIN && -d <= BANDA_MAX) ventasAbajo += l.ask_size || 0;
  }
  const tot = comprasArriba + ventasAbajo;
  if (!(tot > 0)) continue;
  const p0 = precioEn(s.ts), p1 = precioEn(s.ts + HORIZONTE_H * 3600_000);
  if (!(p0 > 0) || !(p1 > 0)) continue;
  obs.push({ ts: s.ts, imb: (comprasArriba - ventasAbajo) / tot, ret: ((p1 - p0) / p0) * 100 });
}

const grupos: (typeof obs)[] = [];
for (const o of obs) {
  const g = grupos[grupos.length - 1];
  if (g && o.ts - g[0].ts <= EVENTO_MS) g.push(o);
  else grupos.push([o]);
}

console.log(`\n\x1b[1m1 · ¿BARRE EL MERCADO LOS STOPS?\x1b[0m  (órdenes voluntarias, no liquidaciones)`);
console.log(`bandas simétricas ±${BANDA_MIN * 100}–${BANDA_MAX * 100} % · horizonte ${HORIZONTE_H} h\n`);
console.log(`  ${snaps.length} snapshots · ${obs.length} usables · \x1b[1m${grupos.length} sucesos independientes\x1b[0m`);

const UMBRAL = 0.1; // más bajo que en el imán: los stops se reparten a los dos lados
const usables = grupos
  .map((g) => ({ imb: media(g.map((o) => o.imb)), ret: media(g.map((o) => o.ret)) }))
  .filter((x) => Math.abs(x.imb) >= UMBRAL);
console.log(`  ${usables.length} con desequilibrio claro (|imb| ≥ ${UMBRAL})`);

if (usables.length >= 25) {
  // Barrido: más stops de cortos arriba ⇒ el precio SUBE a barrerlos.
  const r = usables.map((x) => (x.imb > 0 ? 1 : -1) * x.ret);
  const a = tStat(r), b = tStat(r.map((x) => -x));
  const c = (v: number) => (v > 0 ? "\x1b[32m+" : "\x1b[31m") + v.toFixed(4) + "%\x1b[0m";
  for (const [nom, s] of [["BARRIDO · va a por los stops", a], ["HUIDA · se aleja de ellos", b]] as [string, typeof a][]) {
    console.log(`\n  \x1b[1m${nom}\x1b[0m`);
    console.log(`    bruto ${c(s.m)} · \x1b[1mneto ${c(s.m - COSTE)}\x1b[0m · t=${s.t.toFixed(2)} ` +
      `${s.m - COSTE > 0 && s.t > LISTON ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗ no llega a " + LISTON + "\x1b[0m"}`);
  }
  const mejor = a.m >= b.m ? a : b;
  const need = (neto: number) => Math.ceil((((LISTON + 0.84) * mejor.sd) / (neto + COSTE)) ** 2);
  console.log(`\n  \x1b[2mpotencia: con ${usables.length} sucesos y dispersión ${mejor.sd.toFixed(3)} % se habría`);
  console.log(`  detectado un efecto neto de +0,20 % (harían falta ${need(0.2)}) o de +0,10 % (${need(0.1)}).\x1b[0m`);
} else {
  console.log(`  \x1b[31mmuestra insuficiente\x1b[0m`);
}

// ================= 2 · RETIRADA DE LIQUIDEZ =================
interface Flujo {
  timestamp: string;
  limitOrdersPlaced: number;
  ordersCanceled: number;
  ordersFilled: number;
  ordersForceCanceled: number;
}
const flujo = (JSON.parse(readFileSync(P(FLUJO), "utf8")).records as Flujo[])
  .map((f) => ({ ts: Date.parse(f.timestamp), ratio: f.limitOrdersPlaced > 0 ? f.ordersCanceled / f.limitOrdersPlaced : NaN }))
  .filter((f) => Number.isFinite(f.ts) && Number.isFinite(f.ratio))
  .sort((a, b) => a.ts - b.ts);

console.log(`\n\n\x1b[1m2 · ¿AVISA LA RETIRADA DE LIQUIDEZ?\x1b[0m`);
console.log(`la cancelación no tiene dirección, así que se mide VOLATILIDAD, no signo\n`);

const rr = flujo.map((f) => f.ratio);
console.log(`  ${flujo.length} horas · proporción de cancelación: mediana ${(rr.slice().sort((a, b) => a - b)[rr.length >> 1] * 100).toFixed(2)} % · rango ${(Math.min(...rr) * 100).toFixed(1)}–${(Math.max(...rr) * 100).toFixed(1)} %`);

// tipificado móvil, solo con el pasado
const VENT = 72; // tres días
const puntos: { z: number; mov: number }[] = [];
for (let i = VENT; i < flujo.length - HORIZONTE_H; i++) {
  const w = flujo.slice(i - VENT, i).map((f) => f.ratio);
  const m = media(w);
  const sd = Math.sqrt(w.reduce((s, x) => s + (x - m) ** 2, 0) / (w.length - 1));
  if (!(sd > 0)) continue;
  const z = (flujo[i].ratio - m) / sd;
  const p0 = precioEn(flujo[i].ts), p1 = precioEn(flujo[i].ts + HORIZONTE_H * 3600_000);
  if (!(p0 > 0) || !(p1 > 0)) continue;
  puntos.push({ z, mov: Math.abs(((p1 - p0) / p0) * 100) }); // movimiento ABSOLUTO
}

if (puntos.length >= 40) {
  const altos = puntos.filter((p) => p.z >= 1.5).map((p) => p.mov);
  const resto = puntos.filter((p) => p.z < 1.5).map((p) => p.mov);
  console.log(`  ${puntos.length} puntos · ${altos.length} con cancelación anómala (z≥1,5)`);
  if (altos.length >= 12) {
    const a = tStat(altos), b = tStat(resto);
    const se = Math.sqrt(a.sd ** 2 / a.n + b.sd ** 2 / b.n);
    const z = (a.m - b.m) / se;
    console.log(`\n  movimiento medio a ${HORIZONTE_H} h:`);
    console.log(`    tras cancelación anómala: \x1b[1m${a.m.toFixed(3)} %\x1b[0m (${a.n} casos)`);
    console.log(`    resto del tiempo:         ${b.m.toFixed(3)} % (${b.n} casos)`);
    console.log(`    diferencia ${(a.m - b.m).toFixed(3)} puntos · ${z.toFixed(2)}σ ` +
      `${Math.abs(z) > 1.96 ? "\x1b[32m✓ avisa de volatilidad\x1b[0m" : "\x1b[31m✗ no se distingue del azar\x1b[0m"}`);
  } else {
    console.log(`  \x1b[31msolo ${altos.length} casos anómalos: muestra corta\x1b[0m`);
  }
} else {
  console.log(`  \x1b[31mmuestra insuficiente\x1b[0m`);
}
console.log("");
