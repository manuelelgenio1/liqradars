import { confirmCombo, type Series, type Combo } from "../src/lib/search";
import { configFor } from "../src/lib/indicators";
import type { Candle } from "../src/lib/types";

const SYMS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"];
const TFS: [string, string, number][] = [["15m", "15m", 15], ["1H", "1h", 60], ["4H", "4h", 240]];

// LA HIPÓTESIS, fijada de antemano. No se busca nada más.
const COMBO: Combo = { members: ["Cruce EMA", "RSI"], unanimous: true, inverted: true };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function klines(symbol: string, interval: string, endTime: number, pages: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let end = endTime;
  for (let p = 0; p < pages; p++) {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=1500&endTime=${end}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
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
  const m = new Map(out.map((k) => [k.t, k]));
  return [...m.values()].sort((a, b) => a.t - b.t);
}

async function build(label: string, endTime: number): Promise<Series[]> {
  const series: Series[] = [];
  let velas = 0;
  for (const [tf, itv, min] of TFS) {
    for (const sym of SYMS) {
      try {
        const c = await klines(sym, itv, endTime, 3);
        if (c.length >= 500) {
          series.push({ label: `${sym} ${tf}`, candles: c, cfg: configFor(tf), tfMinutes: min });
          velas += c.length;
        }
      } catch { /* se salta esa serie */ }
    }
  }
  const desde = series[0]?.candles[0]?.t;
  const hasta = series[0]?.candles.at(-1)?.t;
  console.log(`\x1b[1m${label}\x1b[0m  ${series.length} series · ${velas.toLocaleString()} velas · ` +
    `${desde ? new Date(desde).toISOString().slice(0,10) : "?"} → ${hasta ? new Date(hasta).toISOString().slice(0,10) : "?"}`);
  return series;
}

function report(title: string, r: ReturnType<typeof confirmCombo>) {
  console.log(`\n  ${title}`);
  console.log(`  ${"─".repeat(58)}`);
  const ok = r.passes;
  console.log(`  media       ${(r.meanEdge * 100).toFixed(2)} pts`);
  console.log(`  t-Student   ${r.tStat.toFixed(2)}   ${ok ? "\x1b[32m(supera 2)\x1b[0m" : "\x1b[31m(no llega a 2)\x1b[0m"}`);
  console.log(`  positivas   ${r.positives}/${r.perSeries.length} series`);
  console.log(`  llamadas    ${r.totalCalls.toLocaleString()}`);
  console.log(`  ${ok ? "\x1b[32m✓ SE CONFIRMA\x1b[0m" : "\x1b[31m✗ NO SE CONFIRMA\x1b[0m"}`);
  const orden = [...r.perSeries].sort((a, b) => b.edge - a.edge);
  console.log(`  mejor: ${orden.slice(0,3).map(x=>`${x.label} ${(x.edge*100).toFixed(1)}`).join(" · ")}`);
  console.log(`  peor:  ${orden.slice(-3).map(x=>`${x.label} ${(x.edge*100).toFixed(1)}`).join(" · ")}`);
}

async function main() {
  console.log(`\n\x1b[1mHIPÓTESIS FIJADA: ¬EMA+RSI (unánime)\x1b[0m`);
  console.log(`Una sola hipótesis → sin comparaciones múltiples → listón clásico t>2\n`);

  const periodos: [string, number][] = [
    ["2024 (mediados)", Date.UTC(2024, 6, 1)],
    ["2023 (mediados)", Date.UTC(2023, 6, 1)],
  ];

  for (const [nombre, end] of periodos) {
    const s = await build(nombre, end);
    if (s.length < 3) { console.log("  sin datos suficientes\n"); continue; }
    report(nombre, confirmCombo(s, COMBO, { horizon: 12, step: 4 }));
    console.log("");
  }
}
main();
