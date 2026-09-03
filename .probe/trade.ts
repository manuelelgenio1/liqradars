/*
  Backtest OPERATIVO de "Contra EMA+RSI".

  La validación anterior medía "¿el precio está más arriba 12 velas después?".
  Esto es otra cosa: cada señal se abre, se le pone stop y objetivo, y se
  resuelve vela a vela con el MISMO código que usa la app en vivo
  (buildContraSignal + evaluateSignal). Además se descuentan comisiones.

  Y cada señal arrastra su control: una moneda al aire con el mismo stop y el
  mismo objetivo en el mismo instante.
*/
import { buildContraSignal, evaluateSignal, computeStats, type Signal, type SignalInputs } from "../src/lib/signals";
import { computeAll, configFor } from "../src/lib/indicators";
import type { Candle } from "../src/lib/types";

const SYMS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"];
const TFS: [string, string, number][] = [["15m", "15m", 15], ["1H", "1h", 60], ["4H", "4h", 240]];
const MAX_PREFIX = 400;
const WARMUP = 150;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function klines(symbol: string, interval: string, endTime: number, pages: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let end = endTime;
  for (let p = 0; p < pages; p++) {
    const r = await fetch(
      `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=1500&endTime=${end}`,
      { signal: AbortSignal.timeout(20000) }
    );
    if (!r.ok) break;
    const j = (await r.json()) as (string | number)[][];
    if (!Array.isArray(j) || !j.length) break;
    out.unshift(...j.map((k) => {
      const v = Number(k[5]) || 0, tb = Number(k[9]) || 0;
      return { t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v, delta: v > 0 ? tb * 2 - v : 0 };
    }));
    end = Number(j[0][0]) - 1;
    await sleep(90);
  }
  return [...new Map(out.map((k) => [k.t, k])).values()].sort((a, b) => a.t - b.t);
}

/** Generador determinista: sin él, el control cambiaría entre ejecuciones. */
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function runSeries(symbol: string, tf: string, candles: Candle[], tfMin: number, rand: () => number): Signal[] {
  const cfg = configFor(tf);
  const sigs: Signal[] = [];
  let cooldown = -1;

  for (let i = WARMUP; i < candles.length - 1; i++) {
    // Una posición a la vez por serie. Sin esto se cuenta 40 veces el mismo movimiento.
    if (i < cooldown) continue;

    const prefix = candles.slice(Math.max(0, i + 1 - MAX_PREFIX), i + 1); // SOLO el pasado
    const bundle = computeAll(prefix, cfg, tfMin);
    const atr = bundle.atr.at(-1) ?? NaN;
    if (!(atr > 0)) continue;

    const inp: SignalInputs = {
      symbol, timeframe: tf, price: candles[i].c, atr, indicators: bundle,
      confluenceTrend: null, confluenceAgreement: 0,
      liqLong: 0, liqShort: 0, bookImbalance: NaN, fundingPct: NaN, oiDelta1hPct: NaN,
    };
    const sig = buildContraSignal(inp, candles[i].t, rand);
    if (!sig) continue;

    const resolved = evaluateSignal(sig, candles.slice(i + 1));
    if (resolved.outcome === "abierta") continue; // sin futuro suficiente: no se cuenta
    sigs.push(resolved);

    // se bloquea hasta que la operación cerró de verdad
    const endIdx = candles.findIndex((k) => k.t === resolved.resolvedTs);
    cooldown = endIdx > i ? endIdx + 1 : i + 12;
  }
  return sigs;
}

function report(label: string, sigs: Signal[]) {
  const st = computeStats(sigs);
  const bar = (v: number) => (v > 0 ? "\x1b[32m" : "\x1b[31m") + (v > 0 ? "+" : "") + v.toFixed(3) + "R\x1b[0m";
  console.log(`\n\x1b[1m${label}\x1b[0m`);
  console.log(`  ${"─".repeat(60)}`);
  console.log(`  operaciones   ${st.resolved}   (${st.wins}G / ${st.losses}P / ${st.expired}exp · ${st.ambiguous} ambiguas)`);
  console.log(`  aciertos      ${(st.winRate * 100).toFixed(1)}%      control ${(st.controlWinRate * 100).toFixed(1)}%`);
  console.log(`  esperanza     ${bar(st.expectancy)} bruta`);
  console.log(`  coste         -${st.avgCostR.toFixed(3)}R por operación`);
  console.log(`  \x1b[1mESPERANZA NETA ${bar(st.expectancyNet)}\x1b[0m`);
  console.log(`  control       ${bar(st.controlExpectancy)} (moneda al aire)`);
  console.log(`  acumulado     ${st.totalRNet > 0 ? "+" : ""}${st.totalRNet.toFixed(1)}R neto · racha peor -${st.maxDrawdownR.toFixed(1)}R`);
  console.log(`  \x1b[1m${st.verdict}\x1b[0m`);
  return st;
}

async function main() {
  const periodos: [string, number][] = [
    ["2026 · actual", Date.now()],
    ["2024 · may-jul", Date.UTC(2024, 6, 1)],
    ["2023 · may-jul", Date.UTC(2023, 6, 1)],
  ];

  console.log(`\n\x1b[1mCONTRA EMA+RSI · operada de verdad\x1b[0m`);
  console.log(`stop 1,2 ATR · objetivo 2,0 ATR · expira a 48 velas · coste 0,14 % ida y vuelta`);
  console.log(`una posición a la vez por serie · sin look-ahead\n`);

  const porTf = new Map<string, Signal[]>();

  for (const [nombre, end] of periodos) {
    const todas: Signal[] = [];
    let n = 0;
    for (const [tf, itv, min] of TFS) {
      for (const sym of SYMS) {
        try {
          const c = await klines(sym, itv, end, 3);
          if (c.length < 500) continue;
          n += c.length;
          const s = runSeries(sym, tf, c, min, mulberry(sym.length * 977 + min));
          todas.push(...s);
          porTf.set(tf, [...(porTf.get(tf) ?? []), ...s]);
        } catch { /* serie omitida */ }
      }
    }
    console.log(`\x1b[2m${n.toLocaleString()} velas\x1b[0m`);
    report(nombre, todas);
  }

  console.log(`\n\n\x1b[1m═══ POR TEMPORALIDAD (los tres periodos juntos) ═══\x1b[0m`);
  console.log(`\x1b[2mel coste se mide contra la distancia al stop: en marcos cortos el stop\x1b[0m`);
  console.log(`\x1b[2mes estrecho y la comisión pesa muchísimo más\x1b[0m`);
  for (const [tf] of TFS) report(`Temporalidad ${tf}`, porTf.get(tf) ?? []);
}
main();
