/*
  ¿Cómo puede una regla acertar MÁS veces y aun así perder dinero?

  Midiendo las dos cosas en la MISMA muestra y con el mismo código:
  el porcentaje de aciertos y el tamaño medio de aciertos y fallos.
*/
import { computeAll, configFor } from "../src/lib/indicators";
import type { Candle } from "../src/lib/types";

const SYMS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"];
const TFS: [string, string, number][] = [["15m","15m",15],["1H","1h",60],["4H","4h",240]];
const H = 12, MAX_PREFIX = 400, WARMUP = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function klines(s: string, i: string, end: number): Promise<Candle[]> {
  const out: Candle[] = []; let e = end;
  for (let p = 0; p < 3; p++) {
    const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${s}&interval=${i}&limit=1500&endTime=${e}`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) break;
    const j = (await r.json()) as (string|number)[][];
    if (!Array.isArray(j) || !j.length) break;
    out.unshift(...j.map((k) => ({ t:+k[0], o:+k[1], h:+k[2], l:+k[3], c:+k[4], v:+k[5]||0, delta:0 })));
    e = Number(j[0][0]) - 1; await sleep(90);
  }
  return [...new Map(out.map((k)=>[k.t,k])).values()].sort((a,b)=>a.t-b.t);
}

async function main() {
  let hits = 0, calls = 0, baseSum = 0;
  const wins: number[] = [], losses: number[] = [];

  for (const [tf, itv, min] of TFS) {
    for (const sym of SYMS) {
      const c = await klines(sym, itv, Date.now());
      if (c.length < 500) continue;
      const cfg = configFor(tf);

      // tasa base de subidas en esta muestra
      let ups = 0, tot = 0;
      for (let i = WARMUP; i + H < c.length; i += 4) { if (c[i+H].c > c[i].c) ups++; tot++; }
      const upRate = ups / tot;

      for (let i = WARMUP; i + H < c.length; i += 4) {
        const b = computeAll(c.slice(Math.max(0, i+1-MAX_PREFIX), i+1), cfg, min);
        const ema = b.consensus.votes.find((v)=>v.name==="Cruce EMA");
        const rsi = b.consensus.votes.find((v)=>v.name==="RSI");
        if (!ema || !rsi || ema.trend === "lateral" || ema.trend !== rsi.trend) continue;
        const dir = ema.trend === "alcista" ? -1 : 1; // al contrario
        const ret = (dir * (c[i+H].c - c[i].c)) / c[i].c * 100;
        calls++;
        baseSum += dir > 0 ? upRate : 1 - upRate;
        if (ret > 0) { hits++; wins.push(ret); } else losses.push(ret);
      }
    }
  }

  const hr = hits / calls, base = baseSum / calls;
  const mw = wins.reduce((a,b)=>a+b,0) / wins.length;
  const ml = losses.reduce((a,b)=>a+b,0) / losses.length;
  const esp = hr * mw + (1 - hr) * ml;

  console.log(`\n\x1b[1mLA MISMA MUESTRA, LAS DOS MÉTRICAS\x1b[0m  (${calls.toLocaleString()} llamadas)\n`);
  console.log(`  \x1b[1mLo que sí es cierto — acierto\x1b[0m`);
  console.log(`    acierta          ${(hr*100).toFixed(1)}%`);
  console.log(`    línea base       ${(base*100).toFixed(1)}%`);
  console.log(`    \x1b[32mventaja         +${((hr-base)*100).toFixed(1)} puntos\x1b[0m  ← esto es lo que validamos`);
  console.log(`\n  \x1b[1mLo que no habíamos mirado — tamaño\x1b[0m`);
  console.log(`    acierto medio    \x1b[32m+${mw.toFixed(3)}%\x1b[0m`);
  console.log(`    fallo medio      \x1b[31m${ml.toFixed(3)}%\x1b[0m`);
  console.log(`    asimetría        \x1b[31m${(Math.abs(ml)/mw).toFixed(2)}× peor cuando falla\x1b[0m`);
  console.log(`\n  \x1b[1mResultado\x1b[0m`);
  console.log(`    ${(hr*100).toFixed(1)}% × +${mw.toFixed(3)}%  −  ${((1-hr)*100).toFixed(1)}% × ${Math.abs(ml).toFixed(3)}%`);
  console.log(`    = \x1b[1m\x1b[31m${esp.toFixed(4)}%\x1b[0m por operación, antes de comisiones\n`);
}
main();
