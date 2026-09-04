/*
  4H Y DIARIO: el único terreno donde queda algo abierto.

  DE DÓNDE VENIMOS. En 4H y diario la mesa NO pierde: neto +0,056R con t=1,44 y
  +0,053R con t=1,31. Positivo en casi todas las anchuras de stop y con el
  bruto consistente. Pero sin llegar al listón, y la razón era falta de
  MUESTRA, no el signo — al revés que en 5m, donde había potencia de sobra para
  afirmar que la ventaja no existe.

  ASÍ QUE EL TRABAJO ES GANAR POTENCIA, y solo hay dos formas honestas:

   1. MÁS PARES. Se pasa de 10 a todos los perpetuos de cripto con historia
      suficiente. Ojo: NO multiplica la información por el número de pares,
      porque están muy correlacionados — por eso la t se calcula sobre sucesos
      y no sobre filas. Pero añade algo.
   2. TODA LA HISTORIA. Se pagina hasta agotar lo que tiene Binance, que en 4H
      son unos seis años (los futuros perpetuos arrancaron en 2019).

  Lo que NO se hace: volver a probar cinco anchuras de stop y quedarse con la
  mejor. Eso ya se hizo, y repetirlo sobre datos que se solapan sería mirar dos
  veces lo mismo. Aquí se fija UNA sola configuración de antemano.

  LA HIPÓTESIS, ESCRITA ANTES DE EJECUTAR:
      marco:      4H y diario, por separado
      stop:       3 ATR · objetivo 5 ATR (misma proporción 1,67 de la app)
      hipótesis:  esperanza neta > 0
      listón:     2,24 sigmas (dos marcos ⇒ Bonferroni)
      unidad:     sucesos independientes

  Se elige 3 ATR porque es la anchura central del rango que salió positivo, no
  la que salió mejor. Quedarse con la mejor de cinco es la trampa que este
  proyecto lleva veintiocho hipótesis evitando.
*/
import { computeAll, configFor, type Bundle, type IndicatorConfig } from "../src/lib/indicators";
import { MAX_BARS } from "../src/lib/signals";
import { requiredSigma } from "../src/lib/indicatorScore";
import type { Candle } from "../src/lib/types";

const MARCOS: [string, number][] = [["4h", 240], ["1d", 1440]];
const STOP_ATR = 3;
const RR = 2.0 / 1.2;
const COSTE_PCT = 0.11;
const MAX_PARES = 25;
const PAGINAS = 12;               // hasta 18.000 velas: agota la historia en 4H y diario
const LISTON = requiredSigma(MARCOS.length);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(u: string): Promise<unknown> {
  const res = await fetch(u);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function universo(): Promise<string[]> {
  const info = (await fetchJson("https://fapi.binance.com/fapi/v1/exchangeInfo")) as {
    symbols: { symbol: string; contractType: string; underlyingType: string; status: string }[];
  };
  const validos = new Set(
    info.symbols
      .filter((s) => s.contractType === "PERPETUAL" && s.underlyingType === "COIN" && s.status === "TRADING")
      .map((s) => s.symbol)
  );
  const tick = (await fetchJson("https://fapi.binance.com/fapi/v1/ticker/24hr")) as
    { symbol: string; quoteVolume: string }[];
  return tick
    .filter((t) => validos.has(t.symbol) && t.symbol.endsWith("USDT"))
    .sort((a, b) => +b.quoteVolume - +a.quoteVolume)
    .slice(0, MAX_PARES)
    .map((t) => t.symbol);
}

async function klines(symbol: string, tf: string): Promise<Candle[]> {
  const out: Candle[] = [];
  let end = Date.now();
  for (let p = 0; p < PAGINAS; p++) {
    const raw = (await fetchJson(
      `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${tf}&limit=1500&endTime=${end}`
    )) as unknown[][];
    if (!raw.length) break;
    const v: Candle[] = raw.map((k) => ({
      t: Number(k[0]), o: +String(k[1]), h: +String(k[2]),
      l: +String(k[3]), c: +String(k[4]), v: +String(k[5]), delta: 0,
    }));
    out.unshift(...v);
    if (raw.length < 1500) break;      // se agotó la historia
    end = v[0].t - 1;
    await sleep(90);
  }
  return out;
}

const finito = (x: number) => (Number.isFinite(x) ? x : 0);

function scoreEn(b: Bundle, i: number, cfg: IndicatorConfig, tfMin: number): number {
  const umbral = 0.0006 * Math.sqrt(tfMin / 5);
  const v: { s: number; p: number; f: number }[] = [];
  const rap = finito(b.emaFast[i]), len = finito(b.emaSlow[i]);
  const sep = len !== 0 ? (rap - len) / len : 0;
  v.push({ s: sep > umbral ? 1 : sep < -umbral ? -1 : 0, p: 1, f: Math.min(1, Math.abs(sep) / (umbral * 4)) });
  const hist = finito(b.macdHist[i]), atrI = finito(b.atr[i]);
  v.push({ s: hist > 0 ? 1 : hist < 0 ? -1 : 0, p: 1, f: Math.min(1, Math.abs(hist) / (atrI * 0.5 + 1e-9)) });
  const rv = finito(b.rsi[i]);
  v.push({ s: rv > 55 ? 1 : rv < 45 ? -1 : 0, p: 0.8, f: Math.min(1, Math.abs(rv - 50) / 30) });
  v.push({ s: (b.stConfirmed[i] ?? true) ? 1 : -1, p: 1.25, f: 1 });
  const adxI = finito(b.adx[i]);
  const fu = adxI >= cfg.adxThreshold;
  v.push({
    s: !fu ? 0 : finito(b.plusDI[i]) > finito(b.minusDI[i]) ? 1 : -1, p: 1.4,
    f: fu ? Math.min(1, adxI / 50) : Math.max(0, (cfg.adxThreshold - adxI) / cfg.adxThreshold),
  });
  let num = 0, den = 0;
  for (const x of v) { num += x.s * x.p * x.f; den += x.p; }
  const s = den ? num / den : 0;
  return Number.isFinite(s) ? s : 0;
}

const media = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

/**
 * En marcos largos, "el mismo suceso" es un día entero: si el consenso gira en
 * quince pares el mismo día, eso es un giro de mercado, no quince datos.
 */
function porSuceso(ev: { t: number; r: number }[], cubo: number): number[] {
  const g = new Map<number, number[]>();
  for (const e of ev) {
    const k = Math.floor(e.t / cubo);
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

/*
  SE GUARDA EL LADO, y es la comprobación que decide si esto vale algo.

  SESGO DE SUPERVIVENCIA: los 25 pares se eligen por volumen de HOY y luego se
  usa su historia desde 2019. Los que quebraron no están. Son supervivientes —
  monedas que subieron. Una estrategia que sigue tendencia sobre activos que
  tendieron al alza gana sin predecir nada.

  La prueba: si la ventaja es real, largos Y cortos ganan. Si solo ganan los
  largos, es la deriva del mercado disfrazada de señal.
*/
interface Op { t: number; r: number; gana: boolean; lado: 1 | -1 }

function replay(v: Candle[], b: Bundle, cfg: IndicatorConfig, tfMin: number): Op[] {
  const ops: Op[] = [];
  let anterior: 1 | -1 | 0 = 0;
  let libre = -1;
  for (let i = 200; i < v.length; i++) {
    const sc = scoreEn(b, i, cfg, tfMin);
    const lado: 1 | -1 | 0 = sc > 0.12 ? 1 : sc < -0.12 ? -1 : 0;
    const atrI = b.atr[i];
    if (!lado || !(atrI > 0)) { anterior = lado; continue; }
    const relevo = lado !== anterior || i > libre;
    anterior = lado;
    if (!relevo) continue;

    const entrada = v[i].c;
    if (!(entrada > 0)) continue;
    const riesgo = atrI * STOP_ATR;
    const premio = riesgo * RR;
    const stop = lado === 1 ? entrada - riesgo : entrada + riesgo;
    const obj = lado === 1 ? entrada + premio : entrada - premio;
    const coste = (COSTE_PCT / 100) * entrada / riesgo;

    let bruto: number | null = null;
    let j = i + 1;
    for (; j < Math.min(v.length, i + 1 + MAX_BARS); j++) {
      const c = v[j];
      const tO = lado === 1 ? c.h >= obj : c.l <= obj;
      const tS = lado === 1 ? c.l <= stop : c.h >= stop;
      if (tO && tS) { bruto = -1; break; }
      if (tO) { bruto = RR; break; }
      if (tS) { bruto = -1; break; }
    }
    if (bruto === null) {
      if (j >= v.length) continue;
      const fin = v[Math.min(v.length - 1, i + MAX_BARS)];
      bruto = (lado === 1 ? fin.c - entrada : entrada - fin.c) / riesgo;
    }
    libre = j;
    ops.push({ t: v[i].t, r: bruto - coste, gana: bruto > 0, lado });
  }
  return ops;
}

async function main() {
  console.log("4H Y DIARIO · test preregistrado · stop 3 ATR, objetivo 5 ATR");
  console.log(`Una hipótesis por marco: esperanza neta > 0. Listón ${LISTON.toFixed(2)} sigmas.`);
  console.log("Toda la historia disponible y hasta 25 pares.\n");

  const pares = await universo();
  console.log(`  universo: ${pares.length} pares\n`);

  for (const [tf, tfMin] of MARCOS) {
    console.log(`══ ${tf} ${"═".repeat(60)}`);
    const cfg = configFor(tf === "4h" ? "4H" : "1D");
    const ops: Op[] = [];
    let usados = 0, velasTot = 0, desde = Infinity;
    for (const sym of pares) {
      try {
        const v = await klines(sym, tf);
        if (v.length < 400) continue;
        const b = computeAll(v, cfg, tfMin);
        const o = replay(v, b, cfg, tfMin);
        if (!o.length) continue;
        ops.push(...o);
        usados++;
        velasTot += v.length;
        desde = Math.min(desde, v[0].t);
      } catch (e) { console.log(`  ${sym}: ${(e as Error).message}`); }
    }
    if (ops.length < 200) { console.log("  muestra insuficiente\n"); continue; }

    const cubo = tf === "4h" ? 4 * 3600_000 : 24 * 3600_000;
    const suc = porSuceso(ops.map((o) => ({ t: o.t, r: o.r })), cubo);
    const m = media(suc), t = tDe(suc);
    const pct = (100 * ops.filter((o) => o.gana).length) / ops.length;

    console.log(`  ${usados} pares · ${velasTot} velas · desde ${new Date(desde).toISOString().slice(0, 10)}`);
    console.log(`  operaciones: ${ops.length} · sucesos independientes: ${suc.length}`);
    console.log(`  aciertos: ${pct.toFixed(1)} %`);
    console.log(`  NETO por operación: ${(m >= 0 ? "+" : "") + m.toFixed(4)} R   (t = ${t.toFixed(2)})`);
    const pasa = m > 0 && t > LISTON;
    console.log(`  ⇒ ${pasa ? "PASA ← esperanza positiva y significativa" : m > 0 ? "positivo pero NO significativo" : "NO pasa"}\n`);

    /*
      ---------- LA PRUEBA DEL SESGO DE SUPERVIVENCIA ----------
      Los 25 pares se eligen por volumen de HOY y se usa su historia desde
      2019: los que quebraron no están. Son supervivientes, monedas que
      subieron. Una estrategia que sigue tendencia sobre activos que tendieron
      al alza gana sin predecir nada.

      Si la ventaja es real, LARGOS Y CORTOS ganan. Si solo ganan los largos,
      es la deriva del mercado disfrazada de señal.
    */
    for (const [etq, ld] of [["LARGOS", 1], ["CORTOS", -1]] as const) {
      const dellado = ops.filter((o) => o.lado === ld);
      if (dellado.length < 100) { console.log(`     ${etq}: pocas operaciones`); continue; }
      const sl = porSuceso(dellado.map((o) => ({ t: o.t, r: o.r })), cubo);
      const ml = media(sl), tl = tDe(sl);
      const pl = (100 * dellado.filter((o) => o.gana).length) / dellado.length;
      console.log(
        `     ${etq.padEnd(7)} ${String(dellado.length).padStart(5)} ops · ${String(sl.length).padStart(5)} sucesos · ` +
        `${pl.toFixed(1)} % aciertos · ${(ml >= 0 ? "+" : "") + ml.toFixed(4)}R · t=${tl.toFixed(2)}`
      );
    }
    console.log("     Si solo los LARGOS ganan, es deriva del mercado y no señal.");
  }
}

void main();
