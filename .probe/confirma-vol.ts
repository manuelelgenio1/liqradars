/*
  TEST PREREGISTRADO: ¿aguanta el rastro de la volatilidad en pares nuevos?

  DE DÓNDE VIENE. Midiendo el régimen de volatilidad apareció algo que NO se
  podía declarar: el bruto crecía de forma monótona con la volatilidad en 5m y
  en 30m. Era la primera vez en el proyecto que un bruto mejoraba
  sistemáticamente con una condición, pero había salido de trocear datos ya
  vistos. Declararlo allí habría sido la trampa de siempre.

  ESTO ES LO ÚNICO QUE SE PRUEBA, ESCRITO ANTES DE EJECUTAR:

    marco:      30m
    condición:  cuartil SUPERIOR de volatilidad relativa (ATR/precio)
    stop:       4 ATR, R:R 1,67 — los mismos de antes, no se tocan
    pares:      DIEZ QUE NO SE HAN USADO NUNCA en este proyecto
    hipótesis:  UNA. Esperanza neta > 0.
    listón:     1,96 sigmas, porque es una sola prueba
    unidad:     sucesos independientes, no filas

  UNA SOLA CIFRA DECIDE: la esperanza neta con el coste REAL de hoy, 0,14 %.
  Se imprimen además dos escenarios de coste más barato —entrar con orden
  limitada— pero son SENSIBILIDAD, no la prueba. Elegir el escenario que salga
  bien sería meter la trampa por la puerta de atrás.

  LO QUE ESTE TEST NO ES. Los pares de cripto están muy correlacionados entre
  sí, así que diez pares nuevos NO son evidencia independiente de diez pares
  viejos. Es mejor que volver a mirar los mismos datos y peor que esperar a
  datos del futuro. Se dice, y no se vende como lo que no es.
*/
import { computeAll, configFor, type Bundle, type IndicatorConfig } from "../src/lib/indicators";
import { MAX_BARS } from "../src/lib/signals";
import type { Candle } from "../src/lib/types";

/** Diez pares que no aparecen en ningún estudio anterior. */
const PARES = [
  "LTCUSDT", "TRXUSDT", "DOTUSDT", "NEARUSDT", "APTUSDT",
  "ARBUSDT", "OPUSDT", "FILUSDT", "ATOMUSDT", "INJUSDT",
];
const TF = "30m";
const TF_MIN = 30;
const PAGINAS = 8;
const STOP_ATR = 4;
const RR = 2.0 / 1.2;
const LISTON = 1.96;

/** Primario 0,14 %. Los otros dos son sensibilidad, no la prueba. */
const COSTES: [string, number][] = [
  ["0,14 % (a mercado, el de hoy)", 0.14],
  ["0,09 % (entrada limitada)", 0.09],
  ["0,05 % (ambas limitadas)", 0.05],
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function klines(symbol: string): Promise<Candle[]> {
  const out: Candle[] = [];
  let end = Date.now();
  for (let p = 0; p < PAGINAS; p++) {
    const res = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${TF}&limit=1500&endTime=${end}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = (await res.json()) as unknown[][];
    if (!raw.length) break;
    const v: Candle[] = raw.map((k) => ({
      t: Number(k[0]), o: +String(k[1]), h: +String(k[2]),
      l: +String(k[3]), c: +String(k[4]), v: +String(k[5]), delta: 0,
    }));
    out.unshift(...v);
    end = v[0].t - 1;
    await sleep(120);
  }
  return out;
}

const finito = (x: number) => (Number.isFinite(x) ? x : 0);

function scoreEn(b: Bundle, i: number, cfg: IndicatorConfig, tfMin: number): number {
  const umbral = 0.0006 * Math.sqrt(tfMin / 5);
  const v: { s: number; p: number; f: number }[] = [];
  const rap = finito(b.emaFast[i]);
  const len = finito(b.emaSlow[i]);
  const sep = len !== 0 ? (rap - len) / len : 0;
  v.push({ s: sep > umbral ? 1 : sep < -umbral ? -1 : 0, p: 1, f: Math.min(1, Math.abs(sep) / (umbral * 4)) });
  const hist = finito(b.macdHist[i]);
  const atrI = finito(b.atr[i]);
  v.push({ s: hist > 0 ? 1 : hist < 0 ? -1 : 0, p: 1, f: Math.min(1, Math.abs(hist) / (atrI * 0.5 + 1e-9)) });
  const rv = finito(b.rsi[i]);
  v.push({ s: rv > 55 ? 1 : rv < 45 ? -1 : 0, p: 0.8, f: Math.min(1, Math.abs(rv - 50) / 30) });
  v.push({ s: (b.stConfirmed[i] ?? true) ? 1 : -1, p: 1.25, f: 1 });
  const adxI = finito(b.adx[i]);
  const fuerte = adxI >= cfg.adxThreshold;
  v.push({
    s: !fuerte ? 0 : finito(b.plusDI[i]) > finito(b.minusDI[i]) ? 1 : -1,
    p: 1.4,
    f: fuerte ? Math.min(1, adxI / 50) : Math.max(0, (cfg.adxThreshold - adxI) / cfg.adxThreshold),
  });
  let num = 0, den = 0;
  for (const x of v) { num += x.s * x.p * x.f; den += x.p; }
  const s = den ? num / den : 0;
  return Number.isFinite(s) ? s : 0;
}

const media = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

function porSuceso(ev: { t: number; r: number }[]): number[] {
  const g = new Map<number, number[]>();
  for (const e of ev) {
    const k = Math.floor(e.t / 60_000);
    const prev = g.get(k);
    if (prev) prev.push(e.r);
    else g.set(k, [e.r]);
  }
  return [...g.values()].map(media);
}

function tDe(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = media(xs);
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
  return sd > 0 ? m / (sd / Math.sqrt(xs.length)) : NaN;
}

interface Op { t: number; bruto: number; precio: number; riesgo: number; volRel: number }

function replay(velas: Candle[], b: Bundle, cfg: IndicatorConfig): Op[] {
  const ops: Op[] = [];
  let anterior: 1 | -1 | 0 = 0;
  let vivaHasta = -1;
  for (let i = 200; i < velas.length; i++) {
    const sc = scoreEn(b, i, cfg, TF_MIN);
    const lado: 1 | -1 | 0 = sc > 0.12 ? 1 : sc < -0.12 ? -1 : 0;
    const atrI = b.atr[i];
    if (!lado || !(atrI > 0)) { anterior = lado; continue; }
    const relevo = lado !== anterior || i > vivaHasta;
    anterior = lado;
    if (!relevo) continue;

    const entrada = velas[i].c;
    if (!(entrada > 0)) continue;
    const riesgo = atrI * STOP_ATR;
    const premio = riesgo * RR;
    const stop = lado === 1 ? entrada - riesgo : entrada + riesgo;
    const obj = lado === 1 ? entrada + premio : entrada - premio;

    let bruto: number | null = null;
    let j = i + 1;
    for (; j < Math.min(velas.length, i + 1 + MAX_BARS); j++) {
      const c = velas[j];
      const tObj = lado === 1 ? c.h >= obj : c.l <= obj;
      const tStop = lado === 1 ? c.l <= stop : c.h >= stop;
      if (tObj && tStop) { bruto = -1; break; }
      if (tObj) { bruto = RR; break; }
      if (tStop) { bruto = -1; break; }
    }
    if (bruto === null) {
      if (j >= velas.length) continue;
      const fin = velas[Math.min(velas.length - 1, i + MAX_BARS)];
      bruto = (lado === 1 ? fin.c - entrada : entrada - fin.c) / riesgo;
    }
    vivaHasta = j;
    ops.push({ t: velas[i].t, bruto, precio: entrada, riesgo, volRel: atrI / entrada });
  }
  return ops;
}

async function main() {
  console.log("TEST PREREGISTRADO · 30m · cuartil superior de volatilidad · pares nuevos");
  console.log("UNA hipótesis: esperanza neta > 0 con el coste real de hoy (0,14 %). Listón 1,96.\n");

  const todas: Op[] = [];
  const cfg = configFor("30m");
  for (const sym of PARES) {
    try {
      const velas = await klines(sym);
      if (velas.length < 2000) { console.log(`  ${sym}: solo ${velas.length} velas, fuera`); continue; }
      const b = computeAll(velas, cfg, TF_MIN);
      if (Math.abs(scoreEn(b, velas.length - 1, cfg, TF_MIN) - b.consensus.score) > 1e-9)
        throw new Error("la reconstrucción no cuadra");
      const ops = replay(velas, b, cfg);
      todas.push(...ops);
      console.log(`  ${sym}: ${velas.length} velas · ${ops.length} operaciones`);
    } catch (e) { console.log(`  ${sym}: ${(e as Error).message}`); }
  }
  if (todas.length < 200) { console.log("\nmuestra insuficiente"); return; }

  // cuartil superior de volatilidad, con la regla fijada de antemano
  const orden = [...todas].sort((a, b) => a.volRel - b.volRel);
  const corte = Math.floor(orden.length * 0.75);
  const alto = orden.slice(corte);
  console.log(`\n${todas.length} operaciones · cuartil superior = ${alto.length} · vol.rel media ${(media(alto.map((o) => o.volRel)) * 100).toFixed(2)} %`);
  console.log(`bruto del cuartil: ${(media(alto.map((o) => o.bruto)) >= 0 ? "+" : "") + media(alto.map((o) => o.bruto)).toFixed(4)}R\n`);

  console.log("  coste                            sucesos     NETO       t   veredicto");
  console.log("  " + "─".repeat(70));
  COSTES.forEach(([etq, pct], idx) => {
    const ev = alto.map((o) => ({ t: o.t, r: o.bruto - (pct / 100) * o.precio / o.riesgo }));
    const suc = porSuceso(ev);
    const m = media(suc);
    const t = tDe(suc);
    const pasa = m > 0 && t > LISTON;
    const veredicto = idx === 0 ? (pasa ? "PASA ←" : "no pasa") : "(sensibilidad)";
    console.log(
      `  ${etq.padEnd(32)} ${String(suc.length).padStart(6)}  ${(m >= 0 ? "+" : "") + m.toFixed(4)}  ${(t >= 0 ? "+" : "") + t.toFixed(2)}   ${veredicto}`
    );
  });
  console.log("\nSolo la primera línea decide. Las otras dos son escenarios, no pruebas.");
}

void main();
