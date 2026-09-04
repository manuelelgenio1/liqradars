/*
  GESTIÓN DEL STOP — la crítica más fuerte a todo lo medido hasta ahora.

  EL AGUJERO QUE TAPA. Los veintidós estudios anteriores usan stop FIJO hasta
  el final. Nadie opera así. Mover el stop al punto de entrada cuando el precio
  avanza cambia la FORMA DEL PAGO, no solo su tamaño: la pérdida deja de ser
  siempre −1R y pasa a ser una mezcla de −1R y 0R.

  Y eso mueve la aritmética de verdad. Con ganancia de 1,67R y pérdida de 1R
  hace falta acertar el 44 %. Si la mitad de las perdedoras salen en cero, la
  pérdida media baja a −0,5R y el equilibrio cae al 30 % — por debajo del 35 %
  que la mesa acierta hoy. Es el único cambio medido que podría dar la vuelta
  al signo sin necesidad de mejorar la señal.

  TRES REGLAS, fijadas antes de mirar:
    fijo        stop a 1,2 ATR y no se toca (lo de siempre, como referencia)
    empate      al alcanzar +1,0 ATR, el stop se mueve a la entrada
    arrastre    el stop sigue al precio a 1,2 ATR de distancia, sin retroceder

  SUPUESTOS CONSERVADORES, declarados:
   · Si una vela contiene objetivo Y stop, cuenta como pérdida: no se sabe cuál
     se tocó primero.
   · Si una vela contiene el disparador del empate Y el stop original, se
     supone que saltó el STOP primero. Es lo peor para el operador, y suponer
     lo contrario seria regalarse operaciones salvadas.
   · La salida en empate paga comisión igual: cero no es gratis.

  COSTE CORREGIDO. Se venía usando 0,14 % de ida y vuelta, con 0,02 % de
  deslizamiento por lado. Para un nocional de miles de dólares en pares
  líquidos eso está inflado: no mueves el libro, pagas medio spread, ~0,005 %.
  El coste real ronda 0,11 %. Se corrige aquí.
*/
import { computeAll, configFor, type Bundle, type IndicatorConfig } from "../src/lib/indicators";
import { MAX_BARS } from "../src/lib/signals";
import { requiredSigma } from "../src/lib/indicatorScore";
import type { Candle } from "../src/lib/types";

/** Por argumento: `tsx .probe/gestionstop.ts pequenos` usa pares de baja capitalización. */
const MODO = process.argv[2] ?? "grandes";

const GRANDES = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "SUIUSDT", "LINKUSDT", "AVAXUSDT",
];

const MARCOS: [string, number][] = [["5m", 5], ["30m", 30]];
const PAGINAS = 12;
const STOP_ATR = 1.2;
const TARGET_ATR = 2.0;
const EMPATE_ATR = 1.0;      // a cuánto avance se mueve el stop a la entrada
const COSTE_PCT = 0.11;      // corregido: 0,05 % × 2 de comisión + 0,005 % × 2 de medio spread

type Regla = "fijo" | "empate" | "arrastre";
const REGLAS: Regla[] = ["fijo", "empate", "arrastre"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(u: string): Promise<unknown> {
  const res = await fetch(u);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Perpetuos de cripto ordenados por volumen; se toman los del puesto 45 al 75. */
async function pequenos(): Promise<string[]> {
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
    .slice(45, 75)
    .map((t) => t.symbol)
    .slice(0, 10);
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
  const fuerte = adxI >= cfg.adxThreshold;
  v.push({
    s: !fuerte ? 0 : finito(b.plusDI[i]) > finito(b.minusDI[i]) ? 1 : -1, p: 1.4,
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

interface Op { t: number; r: number; clase: "gana" | "empata" | "pierde" }

function replay(v: Candle[], b: Bundle, cfg: IndicatorConfig, tfMin: number, desde: number, hasta: number, regla: Regla): Op[] {
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

    const entrada = v[i].c;
    if (!(entrada > 0)) continue;
    const riesgo = atrI * STOP_ATR;
    const obj = lado === 1 ? entrada + atrI * TARGET_ATR : entrada - atrI * TARGET_ATR;
    const coste = (COSTE_PCT / 100) * entrada / riesgo;

    let stop = lado === 1 ? entrada - riesgo : entrada + riesgo;
    let movido = false;
    let bruto: number | null = null;
    let j = i + 1;

    for (; j < Math.min(v.length, i + 1 + MAX_BARS); j++) {
      const c = v[j];
      const tObj = lado === 1 ? c.h >= obj : c.l <= obj;
      const tStop = lado === 1 ? c.l <= stop : c.h >= stop;

      if (tObj && tStop) { bruto = movido ? 0 : -1; break; }   // ambigua: lo peor
      if (tStop) { bruto = movido ? 0 : -1; break; }
      if (tObj) { bruto = TARGET_ATR / STOP_ATR; break; }

      /*
        Gestión al cerrar la vela, y solo con lo que YA pasó dentro de ella.
        El avance favorable es el máximo para un largo y el mínimo para un
        corto — confundirlos mediría el movimiento en contra.
      */
      const avance = lado === 1 ? c.h - entrada : entrada - c.l;
      if (regla === "empate" && !movido && avance >= atrI * EMPATE_ATR) {
        stop = entrada;
        movido = true;
      } else if (regla === "arrastre") {
        const ref = lado === 1 ? c.h - atrI * STOP_ATR : c.l + atrI * STOP_ATR;
        if (lado === 1 ? ref > stop : ref < stop) stop = ref;
        // "movido" marca que el stop ya no puede dar pérdida
        movido = lado === 1 ? stop >= entrada : stop <= entrada;
      }
    }
    if (bruto === null) {
      if (j >= v.length) continue;
      const fin = v[Math.min(v.length - 1, i + MAX_BARS)];
      bruto = (lado === 1 ? fin.c - entrada : entrada - fin.c) / riesgo;
    }
    vivaHasta = j;
    const r = bruto - coste;   // el empate también paga comisión: cero no es gratis
    ops.push({ t: v[i].t, r, clase: bruto > 0.01 ? "gana" : bruto < -0.01 ? "pierde" : "empata" });
  }
  return ops;
}

async function main() {
  const liston = requiredSigma(REGLAS.length * MARCOS.length);
  const pares = MODO === "pequenos" ? await pequenos() : GRANDES;
  console.log(`GESTIÓN DEL STOP · pares ${MODO.toUpperCase()} · coste corregido ${COSTE_PCT} %`);
  console.log(`  ${pares.join(" ")}`);
  console.log(`  ${REGLAS.length} reglas × ${MARCOS.length} marcos ⇒ listón ${liston.toFixed(2)} sigmas\n`);

  for (const [tf, tfMin] of MARCOS) {
    console.log(`══ ${tf} ${"═".repeat(62)}`);
    const cfg = configFor(tf);
    const datos: { velas: Candle[]; b: Bundle }[] = [];
    for (const sym of pares) {
      try {
        const velas = await klines(sym, tf);
        if (velas.length < 3000) { console.log(`  ${sym}: solo ${velas.length} velas`); continue; }
        datos.push({ velas, b: computeAll(velas, cfg, tfMin) });
      } catch (e) { console.log(`  ${sym}: ${(e as Error).message}`); }
    }
    if (!datos.length) { console.log("  sin datos\n"); continue; }
    const n = Math.min(...datos.map((d) => d.velas.length));
    const corte = Math.floor(n * 0.65);

    console.log("  regla      tramo         ops  sucesos   gana  empata  pierde     NETO       t");
    console.log("  " + "─".repeat(76));
    for (const regla of REGLAS) {
      for (const [etq, a, z] of [["busca", 200, corte], ["CONFIRMA", corte, n]] as const) {
        const ops: Op[] = [];
        for (const d of datos) ops.push(...replay(d.velas, d.b, cfg, tfMin, a, z, regla));
        if (ops.length < 200) { console.log(`  ${regla.padEnd(10)} ${etq.padEnd(9)} muestra insuficiente`); continue; }
        const suc = porSuceso(ops.map((o) => ({ t: o.t, r: o.r })));
        const m = media(suc), t = tDe(suc);
        const pc = (c: Op["clase"]) => ((100 * ops.filter((o) => o.clase === c).length) / ops.length).toFixed(0) + "%";
        const marca = etq === "CONFIRMA" && m > 0 && t > liston ? "  ← RENTABLE" : "";
        console.log(
          `  ${regla.padEnd(10)} ${etq.padEnd(9)} ${String(ops.length).padStart(7)}  ${String(suc.length).padStart(7)}  ` +
          `${pc("gana").padStart(5)}  ${pc("empata").padStart(6)}  ${pc("pierde").padStart(6)}  ` +
          `${(m >= 0 ? "+" : "") + m.toFixed(4)}  ${(t >= 0 ? "+" : "") + t.toFixed(2)}${marca}`
        );
      }
      console.log("  " + "─".repeat(76));
    }
    console.log();
  }
}

void main();
