/*
  ¿HABILIDAD O DERIVA? El test que separa una cosa de la otra.

  EL PROBLEMA. En 4H y diario la mesa supera el listón: +0,043R con t=3,04 y
  +0,118R con t=3,21. Pero el desglose por lado lo desmonta — largos +0,090R
  (t=4,69), cortos −0,021R (t=−1,04). Toda la ventaja está en un solo lado.

  Eso es lo que produce la DERIVA: las cripto subieron entre 2019 y hoy, y los
  pares se eligieron por su volumen ACTUAL, o sea los supervivientes. Estar
  largo en un mercado que sube da dinero sin predecir nada.

  LA MEDIDA CORRECTA no es comparar contra CERO, sino contra EL MISMO LADO EN
  MOMENTOS CUALESQUIERA:

      ventaja_largos = media(largo | la señal dice largo) − media(largo | todas las velas)
      ventaja_cortos = media(corto | la señal dice corto) − media(corto | todas las velas)

  El término de comparación contiene exactamente la misma deriva, el mismo
  periodo y los mismos activos supervivientes, así que la deriva se cancela
  sola. Lo que queda es la pregunta de verdad: ¿elige la señal MEJORES momentos
  para estar largo que el azar?

  SI LA VENTAJA ES REAL, LAS DOS SON POSITIVAS. Si solo lo es la de largos y la
  de cortos ronda cero, sigue siendo deriva mal repartida.

  4 comparaciones (2 marcos × 2 lados) ⇒ listón 2,50 sigmas.

  NOTA SOBRE LA t: se calcula con el error del grupo condicional y se toma la
  media incondicional como referencia fija. Es ligeramente conservador —ignora
  la incertidumbre del término de comparación— pero ese grupo tiene muchísimas
  más observaciones, así que su error es pequeño.
*/
import { computeAll, configFor, type Bundle, type IndicatorConfig } from "../src/lib/indicators";
import { MAX_BARS } from "../src/lib/signals";
import { requiredSigma } from "../src/lib/indicatorScore";
import type { Candle } from "../src/lib/types";

const MARCOS: [string, number, number][] = [["4h", 240, 4 * 3600_000], ["1d", 1440, 24 * 3600_000]];
const STOP_ATR = 3;
const RR = 2.0 / 1.2;
const COSTE_PCT = 0.11;
const MAX_PARES = 25;
const PAGINAS = 12;
const LISTON = requiredSigma(4);

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
  const ok = new Set(
    info.symbols.filter((s) => s.contractType === "PERPETUAL" && s.underlyingType === "COIN" && s.status === "TRADING").map((s) => s.symbol)
  );
  const tick = (await fetchJson("https://fapi.binance.com/fapi/v1/ticker/24hr")) as { symbol: string; quoteVolume: string }[];
  return tick.filter((t) => ok.has(t.symbol) && t.symbol.endsWith("USDT"))
    .sort((a, b) => +b.quoteVolume - +a.quoteVolume).slice(0, MAX_PARES).map((t) => t.symbol);
}

async function klines(symbol: string, tf: string): Promise<Candle[]> {
  const out: Candle[] = [];
  let end = Date.now();
  for (let p = 0; p < PAGINAS; p++) {
    const raw = (await fetchJson(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${tf}&limit=1500&endTime=${end}`)) as unknown[][];
    if (!raw.length) break;
    const v: Candle[] = raw.map((k) => ({
      t: Number(k[0]), o: +String(k[1]), h: +String(k[2]), l: +String(k[3]),
      c: +String(k[4]), v: +String(k[5]), delta: 0,
    }));
    out.unshift(...v);
    if (raw.length < 1500) break;
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
  v.push({ s: !fu ? 0 : finito(b.plusDI[i]) > finito(b.minusDI[i]) ? 1 : -1, p: 1.4,
    f: fu ? Math.min(1, adxI / 50) : Math.max(0, (cfg.adxThreshold - adxI) / cfg.adxThreshold) });
  let num = 0, den = 0;
  for (const x of v) { num += x.s * x.p * x.f; den += x.p; }
  const s = den ? num / den : 0;
  return Number.isFinite(s) ? s : 0;
}

/** Resultado neto de abrir en la vela i hacia `dir`, con los niveles fijados. */
function resolver(v: Candle[], atrI: number, i: number, dir: 1 | -1): number | null {
  const entrada = v[i].c;
  if (!(entrada > 0) || !(atrI > 0)) return null;
  const riesgo = atrI * STOP_ATR;
  const premio = riesgo * RR;
  const stop = dir === 1 ? entrada - riesgo : entrada + riesgo;
  const obj = dir === 1 ? entrada + premio : entrada - premio;
  const coste = (COSTE_PCT / 100) * entrada / riesgo;
  for (let j = i + 1; j < Math.min(v.length, i + 1 + MAX_BARS); j++) {
    const c = v[j];
    const tO = dir === 1 ? c.h >= obj : c.l <= obj;
    const tS = dir === 1 ? c.l <= stop : c.h >= stop;
    if (tO && tS) return -1 - coste;
    if (tO) return RR - coste;
    if (tS) return -1 - coste;
  }
  const fin = v[i + MAX_BARS];
  if (!fin) return null;
  return (dir === 1 ? fin.c - entrada : entrada - fin.c) / riesgo - coste;
}

/** Cuántas velas tarda en cerrarse la operación abierta en `i`. */
function salidaEn(v: Candle[], atrI: number, i: number, dir: 1 | -1): number {
  const entrada = v[i].c;
  const riesgo = atrI * STOP_ATR;
  const stop = dir === 1 ? entrada - riesgo : entrada + riesgo;
  const obj = dir === 1 ? entrada + riesgo * RR : entrada - riesgo * RR;
  for (let j = i + 1; j < Math.min(v.length, i + 1 + MAX_BARS); j++) {
    const c = v[j];
    if (dir === 1 ? c.h >= obj || c.l <= stop : c.l <= obj || c.h >= stop) return j - i;
  }
  return MAX_BARS;
}

const media = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

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

function errorTipico(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = media(xs);
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
  return sd / Math.sqrt(xs.length);
}

async function main() {
  console.log("¿HABILIDAD O DERIVA? · señal contra el MISMO LADO en momentos cualesquiera");
  console.log(`4 comparaciones ⇒ listón ${LISTON.toFixed(2)} sigmas`);
  console.log("Si la ventaja es real, largos Y cortos superan a su referencia.\n");

  const pares = await universo();

  for (const [tf, tfMin, cubo] of MARCOS) {
    console.log(`══ ${tf} ${"═".repeat(60)}`);
    const cfg = configFor(tf === "4h" ? "4H" : "1D");
    // condicionales (con señal) e incondicionales (todas las velas), por lado
    const cond: Record<1 | -1, { t: number; r: number }[]> = { 1: [], [-1]: [] };
    const todos: Record<1 | -1, number[]> = { 1: [], [-1]: [] };
    let usados = 0;

    for (const sym of pares) {
      try {
        const v = await klines(sym, tf);
        if (v.length < 400) continue;
        const b = computeAll(v, cfg, tfMin);
        let anterior: 1 | -1 | 0 = 0;
        let libre = -1;
        for (let i = 200; i < v.length - MAX_BARS - 1; i++) {
          const atrI = b.atr[i];
          if (!(atrI > 0)) continue;
          // INCONDICIONAL: las dos direcciones en TODAS las velas
          const rl = resolver(v, atrI, i, 1);
          const rs = resolver(v, atrI, i, -1);
          if (rl !== null) todos[1].push(rl);
          if (rs !== null) todos[-1].push(rs);
          // CONDICIONAL: solo donde la mesa emite señal, con su regla de relevo
          const sc = scoreEn(b, i, cfg, tfMin);
          const lado: 1 | -1 | 0 = sc > 0.12 ? 1 : sc < -0.12 ? -1 : 0;
          if (!lado) { anterior = lado; continue; }
          const relevo = lado !== anterior || i > libre;
          anterior = lado;
          if (!relevo) continue;
          const r = lado === 1 ? rl : rs;
          if (r === null) continue;
          cond[lado].push({ t: v[i].t, r });
          /*
            SIN SOLAPE: la siguiente señal no puede nacer hasta que ESTA haya
            cerrado. Permitir que nazca en la vela siguiente genera operaciones
            solapadas, que comparten casi las mismas velas y por tanto están
            muy correlacionadas: la muestra parece el doble de grande de lo que
            es y la t sale inflada.
          */
          libre = i + salidaEn(v, b.atr[i], i, lado);
        }
        usados++;
      } catch (e) { console.log(`  ${sym}: ${(e as Error).message}`); }
    }
    if (!usados) { console.log("  sin datos\n"); continue; }

    console.log(`  ${usados} pares · referencia incondicional: ${todos[1].length} largos y ${todos[-1].length} cortos\n`);
    console.log("  lado     con señal   sucesos   sin señal    VENTAJA       t");
    console.log("  " + "─".repeat(60));
    for (const [etq, ld] of [["LARGOS", 1], ["CORTOS", -1]] as const) {
      const c = cond[ld];
      if (c.length < 100) { console.log(`  ${etq}: pocas`); continue; }
      const suc = porSuceso(c, cubo);
      const mCond = media(suc);
      const mTodos = media(todos[ld]);
      const se = errorTipico(suc);
      const ventaja = mCond - mTodos;
      const t = se > 0 ? ventaja / se : NaN;
      const marca = t > LISTON ? "  ← HABILIDAD" : "";
      console.log(
        `  ${etq.padEnd(8)} ${(mCond >= 0 ? "+" : "") + mCond.toFixed(4)}    ${String(suc.length).padStart(6)}   ` +
        `${(mTodos >= 0 ? "+" : "") + mTodos.toFixed(4)}   ${(ventaja >= 0 ? "+" : "") + ventaja.toFixed(4)}   ${(t >= 0 ? "+" : "") + t.toFixed(2)}${marca}`
      );
    }
    console.log();
  }
  console.log("La columna VENTAJA es lo único que cuenta: cuánto añade la señal");
  console.log("sobre estar en ese mismo lado en un momento cualquiera.");
}

void main();
