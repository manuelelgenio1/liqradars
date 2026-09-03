/*
  La ventaja se midió como "¿el precio está más arriba 12 velas después?".
  Con stop de 1,2 ATR se evapora. Falta la pregunta obvia: ¿y si se opera
  EXACTAMENTE como se midió — salida por tiempo a las 12 velas, sin stop?

  No es buscar otra combinación. Es la misma hipótesis, ejecutada tal y como
  se validó. Si tampoco aquí, la ventaja no es operable.
*/
import { computeAll, configFor } from "../src/lib/indicators";
import { ROUND_TRIP_COST_PCT } from "../src/lib/signals";
import type { Candle } from "../src/lib/types";

const SYMS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"];
const TFS: [string, string, number][] = [["15m", "15m", 15], ["1H", "1h", 60], ["4H", "4h", 240]];
const H = 12, MAX_PREFIX = 400, WARMUP = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function klines(s: string, i: string, end: number, pages: number): Promise<Candle[]> {
  const out: Candle[] = []; let e = end;
  for (let p = 0; p < pages; p++) {
    const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${s}&interval=${i}&limit=1500&endTime=${e}`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) break;
    const j = (await r.json()) as (string | number)[][];
    if (!Array.isArray(j) || !j.length) break;
    out.unshift(...j.map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] || 0, delta: 0 })));
    e = Number(j[0][0]) - 1; await sleep(90);
  }
  return [...new Map(out.map((k) => [k.t, k])).values()].sort((a, b) => a.t - b.t);
}

async function main() {
  console.log(`\n\x1b[1mSALIDA POR TIEMPO · ${H} velas, sin stop\x1b[0m`);
  console.log(`la hipótesis ejecutada tal y como se midió · coste ${ROUND_TRIP_COST_PCT} % ida y vuelta\n`);

  for (const [nombre, end] of [["2026 actual", Date.now()], ["2024", Date.UTC(2024,6,1)], ["2023", Date.UTC(2023,6,1)]] as [string, number][]) {
    // Una observación por serie: los símbolos de cripto están correlacionados.
    const porSerie: number[] = [];
    let ops = 0, brutoTot = 0, netoTot = 0;

    for (const [tf, itv, min] of TFS) {
      for (const sym of SYMS) {
        const c = await klines(sym, itv, end, 3);
        if (c.length < 500) continue;
        const cfg = configFor(tf);
        let n = 0, bruto = 0;
        let cooldown = -1;
        for (let i = WARMUP; i + H < c.length; i++) {
          if (i < cooldown) continue;
          const b = computeAll(c.slice(Math.max(0, i + 1 - MAX_PREFIX), i + 1), cfg, min);
          const ema = b.consensus.votes.find((v) => v.name === "Cruce EMA");
          const rsi = b.consensus.votes.find((v) => v.name === "RSI");
          if (!ema || !rsi || ema.trend === "lateral" || ema.trend !== rsi.trend) continue;
          // contra lo que ambos señalan
          const dir = ema.trend === "alcista" ? -1 : 1;
          bruto += (dir * (c[i + H].c - c[i].c)) / c[i].c * 100; // en % del nocional
          n++; cooldown = i + H;
        }
        if (n >= 20) {
          const medioBruto = bruto / n;
          const medioNeto = medioBruto - ROUND_TRIP_COST_PCT;
          porSerie.push(medioNeto);
          ops += n; brutoTot += bruto; netoTot += bruto - n * ROUND_TRIP_COST_PCT;
        }
      }
    }

    const k = porSerie.length;
    const mean = porSerie.reduce((a, b) => a + b, 0) / k;
    const sd = Math.sqrt(porSerie.reduce((a, b) => a + (b - mean) ** 2, 0) / (k - 1));
    const t = mean / (sd / Math.sqrt(k));
    const pos = porSerie.filter((x) => x > 0).length;
    const col = (v: number) => (v > 0 ? "\x1b[32m" : "\x1b[31m") + (v > 0 ? "+" : "") + v.toFixed(4) + "%\x1b[0m";

    console.log(`\x1b[1m${nombre}\x1b[0m  ${ops.toLocaleString()} operaciones · ${k} series`);
    console.log(`  bruto por operación  ${col(brutoTot / ops)}`);
    console.log(`  coste                -${ROUND_TRIP_COST_PCT.toFixed(2)}%`);
    console.log(`  NETO por operación   \x1b[1m${col(netoTot / ops)}\x1b[0m`);
    console.log(`  t-Student (por serie) ${t.toFixed(2)} · positivas ${pos}/${k}`);
    console.log(`  ${t > 2 && mean > 0 ? "\x1b[32m✓ operable\x1b[0m" : "\x1b[31m✗ NO operable\x1b[0m"}\n`);
  }
}
main();
