/*
  ¿FUNCIONA LA MESA SI SOLO OPERA CUANDO HAY VOLATILIDAD?

  EL MECANISMO ES ARITMÉTICA, NO FE:

      coste_en_ATR = 0,14 % × precio / ATR

  El coste en ATR NO es constante: depende de lo grande que sea el ATR frente
  al precio. En 5 m el ATR típico ronda el 0,15 % del precio, así que el coste
  vale 0,76 ATR por operación. Pero en los tramos más volátiles el ATR puede
  triplicarse, y entonces el MISMO coste vale un tercio.

  Así que operar solo cuando hay movimiento abarata la operación de verdad, sin
  cambiar nada del broker. La pregunta es si eso basta.

  PREDICCIÓN FIJADA ANTES DE MIRAR, para no poder escurrirse después:
   · Si el bruto es cero en todos los regímenes, el neto subirá hacia cero al
     aumentar la volatilidad pero NUNCA lo cruzará. Eso confirmaría que el
     problema no era el coste.
   · Si lo cruza, es que la señal es mejor cuando hay movimiento, y eso sí
     sería un hallazgo.

  DEFENSAS: partición 65/35, sucesos en vez de filas, y el listón subido por
  Bonferroni según cuántos deciles se juzgan.

  El decil de volatilidad se calcula con el ATR relativo (ATR/precio) EN ESA
  VELA, así que no mira al futuro.
*/
import { computeAll, configFor, type Bundle, type IndicatorConfig } from "../src/lib/indicators";
import { MAX_BARS, ROUND_TRIP_COST_PCT } from "../src/lib/signals";
import { requiredSigma } from "../src/lib/indicatorScore";
import type { Candle } from "../src/lib/types";

const PARES = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "SUIUSDT", "LINKUSDT", "AVAXUSDT",
];
const MARCOS: [string, number][] = [["5m", 5], ["30m", 30]];
const PAGINAS = 8;
/** Anchura de stop fijada: la que menos perdía en el estudio anterior. */
const STOP_ATR = 4;
const RR = 2.0 / 1.2;
/** Cuartiles de volatilidad. Cuatro grupos ⇒ el listón sube a 2,50 sigmas. */
const GRUPOS = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function klines(symbol: string, tf: string): Promise<Candle[]> {
  const out: Candle[] = [];
  let end = Date.now();
  for (let p = 0; p < PAGINAS; p++) {
    const u = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${tf}&limit=1500&endTime=${end}`;
    const res = await fetch(u);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = (await res.json()) as unknown[][];
    if (!raw.length) break;
    const velas: Candle[] = raw.map((k) => ({
      t: Number(k[0]), o: +String(k[1]), h: +String(k[2]),
      l: +String(k[3]), c: +String(k[4]), v: +String(k[5]), delta: 0,
    }));
    out.unshift(...velas);
    end = velas[0].t - 1;
    await sleep(120);
  }
  return out;
}

const finito = (x: number) => (Number.isFinite(x) ? x : 0);

/** El consenso de la app, reconstruido en una vela concreta. */
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

interface Op { t: number; r: number; bruto: number; coste: number; volRel: number }

function replay(velas: Candle[], b: Bundle, cfg: IndicatorConfig, tfMin: number, desde: number, hasta: number): Op[] {
  const ops: Op[] = [];
  let anterior: 1 | -1 | 0 = 0;
  let vivaHasta = -1;
  for (let i = desde; i < hasta; i++) {
    const sc = scoreEn(b, i, cfg, tfMin);
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
    const coste = (ROUND_TRIP_COST_PCT / 100) * entrada / riesgo;

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
    // volatilidad RELATIVA en esa vela: es lo que gobierna el coste
    ops.push({ t: velas[i].t, r: bruto - coste, bruto, coste, volRel: atrI / entrada });
  }
  return ops;
}

async function main() {
  const liston = requiredSigma(GRUPOS);
  console.log("¿Basta con operar solo cuando hay volatilidad?");
  console.log(`Stop fijado en ${STOP_ATR} ATR · ${GRUPOS} cuartiles de volatilidad ⇒ listón ${liston.toFixed(2)} sigmas`);
  console.log("PREDICCIÓN: si el bruto es cero, el neto subirá hacia cero sin cruzarlo.\n");

  for (const [tf, tfMin] of MARCOS) {
    console.log(`══ ${tf} ${"═".repeat(62)}`);
    const cfg = configFor(tf === "5m" ? "5m" : "30m");
    const datos: { velas: Candle[]; b: Bundle }[] = [];
    for (const sym of PARES) {
      try {
        const velas = await klines(sym, tf);
        if (velas.length < 2000) continue;
        const b = computeAll(velas, cfg, tfMin);
        if (Math.abs(scoreEn(b, velas.length - 1, cfg, tfMin) - b.consensus.score) > 1e-9)
          throw new Error("la reconstrucción no cuadra");
        datos.push({ velas, b });
      } catch (e) { console.log(`  ${sym}: ${(e as Error).message}`); }
    }
    if (!datos.length) { console.log("  sin datos\n"); continue; }

    const n = Math.min(...datos.map((d) => d.velas.length));
    const corte = Math.floor(n * 0.65);

    for (const [etq, a, z] of [["busca", 200, corte], ["CONFIRMA", corte, n]] as const) {
      const ops: Op[] = [];
      for (const d of datos) ops.push(...replay(d.velas, d.b, cfg, tfMin, a, z));
      if (ops.length < 100) { console.log(`  ${etq}: muestra insuficiente\n`); continue; }

      // cuartiles por volatilidad relativa
      const orden = [...ops].sort((x, y) => x.volRel - y.volRel);
      const tam = Math.floor(orden.length / GRUPOS);
      console.log(`\n  ${etq} · ${ops.length} operaciones`);
      console.log("  cuartil   vol.rel     ops  sucesos    bruto    coste     NETO       t");
      console.log("  " + "─".repeat(70));
      for (let g = 0; g < GRUPOS; g++) {
        const trozo = orden.slice(g * tam, g === GRUPOS - 1 ? orden.length : (g + 1) * tam);
        const suc = porSuceso(trozo.map((o) => ({ t: o.t, r: o.r })));
        const f = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(3);
        const t = tDe(suc);
        const marca = etq === "CONFIRMA" && media(trozo.map((o) => o.r)) > 0 && t > liston ? "  ←" : "";
        console.log(
          `  ${g === GRUPOS - 1 ? "más vol" : String(g + 1).padEnd(7)}  ${(media(trozo.map((o) => o.volRel)) * 100).toFixed(2)}%   ` +
          `${String(trozo.length).padStart(5)}  ${String(suc.length).padStart(7)}  ${f(media(trozo.map((o) => o.bruto)))}  ` +
          `${f(-media(trozo.map((o) => o.coste)))}  ${f(media(trozo.map((o) => o.r)))}  ${(t >= 0 ? "+" : "") + t.toFixed(2)}${marca}`
        );
      }
    }
    console.log();
  }
  console.log(`Solo cuenta lo marcado con ← : neto positivo en CONFIRMA con t > ${liston.toFixed(2)}.`);
}

void main();
