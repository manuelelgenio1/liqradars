/*
  EL EXPONENTE DE HURST COMO CONFIRMACIÓN.

  QUÉ RESUELVE. Los cinco indicadores de la mesa dan una señal de TENDENCIA:
  "esto sube, ponte largo". Pero seguir la tendencia solo funciona si el
  mercado está en modo tendencia. El exponente de Hurst mide precisamente eso:

      H > 0,5  la serie PERSISTE: lo que sube tiende a seguir subiendo
      H = 0,5  paseo aleatorio: el pasado no dice nada
      H < 0,5  la serie REVIERTE: lo que sube tiende a devolverlo

  No es una señal más: es un juez sobre las que ya tenemos. La literatura de
  pares y de índices lo usa así — momento cuando H>0,5, reversión cuando H<0,5.

  Y ENCAJA CON LO QUE YA MEDIMOS. Encontramos reversión significativa a cinco
  minutos (t=−3,15 sobre retornos rezagados). Si a esa escala H<0,5 de forma
  sistemática, quedaría explicado por qué un consenso que sigue tendencia
  falla: estaría aplicando la herramienta correcta en el régimen equivocado.

  LA REGLA, FIJADA ANTES DE MIRAR y derivada de la teoría, no del dato:
      H > 0,5  ⇒  seguir al consenso
      H < 0,5  ⇒  hacer lo contrario

  Se reporta además el acierto por tramo de H sin aplicar la regla, para que se
  vea si la relación existe o si la regla acierta por casualidad.

  CÓMO SE CALCULA H, sin mirar al futuro: rango reescalado (R/S) sobre las 128
  velas ANTERIORES, en cuatro escalas, y la pendiente de log(R/S) contra
  log(escala) por mínimos cuadrados.

  El listón: el 44,0 % de aciertos que hace falta con $100 a 25×, entrada a
  mercado y salida con take-profit limitada.
*/
import { computeAll, configFor, type Bundle, type IndicatorConfig } from "../src/lib/indicators";
import { MAX_BARS } from "../src/lib/signals";
import type { Candle } from "../src/lib/types";

const PARES = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "SUIUSDT", "LINKUSDT", "AVAXUSDT",
];
const MARCOS: [string, number][] = [["5m", 5], ["30m", 30]];
const PAGINAS = 8;
const STOP_ATR = 1.2;
const TARGET_ATR = 2.0;
const VENTANA = 128;
const ESCALAS = [8, 16, 32, 64];
const EQUILIBRIO = 44.0;
const AZAR = (100 * STOP_ATR) / (STOP_ATR + TARGET_ATR);
const TRAMOS: [number, number][] = [[0, 0.42], [0.42, 0.48], [0.48, 0.52], [0.52, 0.58], [0.58, 2]];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function klines(symbol: string, tf: string): Promise<Candle[]> {
  const out: Candle[] = [];
  let end = Date.now();
  for (let p = 0; p < PAGINAS; p++) {
    const res = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${tf}&limit=1500&endTime=${end}`);
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

/** R/S de un trozo de retornos: rango de la desviación acumulada sobre su desviación típica. */
function rs(x: number[]): number {
  const n = x.length;
  if (n < 4) return NaN;
  const m = x.reduce((a, b) => a + b, 0) / n;
  let acum = 0, min = Infinity, max = -Infinity, ss = 0;
  for (const v of x) {
    acum += v - m;
    if (acum < min) min = acum;
    if (acum > max) max = acum;
    ss += (v - m) ** 2;
  }
  const sd = Math.sqrt(ss / n);
  return sd > 0 ? (max - min) / sd : NaN;
}

/** Serie de Hurst, calculada SOLO con velas anteriores a cada punto. */
function hurstSerie(velas: Candle[]): number[] {
  const n = velas.length;
  const ret: number[] = new Array(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    if (velas[i - 1].c > 0) ret[i] = Math.log(velas[i].c / velas[i - 1].c);
  }
  const H: number[] = new Array(n).fill(NaN);
  for (let i = VENTANA; i < n; i++) {
    const win = ret.slice(i - VENTANA + 1, i + 1);
    if (win.some((v) => !Number.isFinite(v))) continue;
    const xs: number[] = [];
    const ys: number[] = [];
    for (const e of ESCALAS) {
      const trozos = Math.floor(VENTANA / e);
      const vals: number[] = [];
      for (let t = 0; t < trozos; t++) {
        const r = rs(win.slice(t * e, (t + 1) * e));
        if (Number.isFinite(r) && r > 0) vals.push(r);
      }
      if (!vals.length) continue;
      xs.push(Math.log(e));
      ys.push(Math.log(vals.reduce((a, b) => a + b, 0) / vals.length));
    }
    if (xs.length < 3) continue;
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let num = 0, den = 0;
    for (let k = 0; k < xs.length; k++) { num += (xs[k] - mx) * (ys[k] - my); den += (xs[k] - mx) ** 2; }
    if (den > 0) H[i] = num / den;
  }
  return H;
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

interface Op { H: number; gana: boolean; ganaInv: boolean }

function replay(velas: Candle[], b: Bundle, H: number[], cfg: IndicatorConfig, tfMin: number, desde: number, hasta: number): Op[] {
  const ops: Op[] = [];
  let anterior: 1 | -1 | 0 = 0;
  let vivaHasta = -1;
  for (let i = desde; i < hasta; i++) {
    const sc = scoreEn(b, i, cfg, tfMin);
    const lado: 1 | -1 | 0 = sc > 0.12 ? 1 : sc < -0.12 ? -1 : 0;
    const atrI = b.atr[i];
    if (!lado || !(atrI > 0) || !Number.isFinite(H[i])) { anterior = lado; continue; }
    const relevo = lado !== anterior || i > vivaHasta;
    anterior = lado;
    if (!relevo) continue;
    const entrada = velas[i].c;
    if (!(entrada > 0)) continue;

    const res = (dir: 1 | -1): { gana: boolean; hasta: number } | null => {
      const stop = dir === 1 ? entrada - atrI * STOP_ATR : entrada + atrI * STOP_ATR;
      const obj = dir === 1 ? entrada + atrI * TARGET_ATR : entrada - atrI * TARGET_ATR;
      let j = i + 1;
      for (; j < Math.min(velas.length, i + 1 + MAX_BARS); j++) {
        const c = velas[j];
        const tO = dir === 1 ? c.h >= obj : c.l <= obj;
        const tS = dir === 1 ? c.l <= stop : c.h >= stop;
        if (tO && tS) return { gana: false, hasta: j };
        if (tO) return { gana: true, hasta: j };
        if (tS) return { gana: false, hasta: j };
      }
      if (j >= velas.length) return null;
      return { gana: false, hasta: j };
    };
    const d = res(lado), inv = res(lado === 1 ? -1 : 1);
    if (!d || !inv) continue;
    vivaHasta = d.hasta;
    ops.push({ H: H[i], gana: d.gana, ganaInv: inv.gana });
  }
  return ops;
}

async function main() {
  console.log("EL EXPONENTE DE HURST COMO CONFIRMACIÓN DE LA SEÑAL\n");
  console.log(`  Regla fijada por teoría: H>0,5 ⇒ seguir al consenso · H<0,5 ⇒ hacer lo contrario`);
  console.log(`  Hace falta ${EQUILIBRIO.toFixed(1)} % de aciertos. El azar da ${AZAR.toFixed(1)} %.\n`);

  for (const [tf, tfMin] of MARCOS) {
    console.log(`══ ${tf} ${"═".repeat(60)}`);
    const cfg = configFor(tf);
    const datos: { velas: Candle[]; b: Bundle; H: number[] }[] = [];
    for (const sym of PARES) {
      try {
        const velas = await klines(sym, tf);
        if (velas.length < 2000) continue;
        const b = computeAll(velas, cfg, tfMin);
        datos.push({ velas, b, H: hurstSerie(velas) });
      } catch (e) { console.log(`  ${sym}: ${(e as Error).message}`); }
    }
    if (!datos.length) { console.log("  sin datos\n"); continue; }
    const n = Math.min(...datos.map((d) => d.velas.length));
    const corte = Math.floor(n * 0.65);

    for (const [etq, a, z] of [["busca", VENTANA + 50, corte], ["CONFIRMA", corte, n]] as const) {
      const ops: Op[] = [];
      for (const d of datos) ops.push(...replay(d.velas, d.b, d.H, cfg, tfMin, a, z));
      if (ops.length < 200) { console.log(`  ${etq}: muestra insuficiente\n`); continue; }
      const Hmedio = ops.reduce((s, o) => s + o.H, 0) / ops.length;
      console.log(`\n  ${etq} · ${ops.length} operaciones · H medio ${Hmedio.toFixed(3)}`);
      console.log("  tramo de H       ops   consenso   inversa");
      console.log("  " + "─".repeat(48));
      for (const [lo, hi] of TRAMOS) {
        const t = ops.filter((o) => o.H >= lo && o.H < hi);
        if (t.length < 30) { console.log(`  ${lo.toFixed(2)}–${hi.toFixed(2)}     ${String(t.length).padStart(6)}   (pocas)`); continue; }
        const p = (100 * t.filter((o) => o.gana).length) / t.length;
        const pi = (100 * t.filter((o) => o.ganaInv).length) / t.length;
        console.log(`  ${lo.toFixed(2)}–${hi.toFixed(2)}     ${String(t.length).padStart(6)}   ${p.toFixed(1).padStart(6)} %  ${pi.toFixed(1).padStart(6)} %`);
      }
      // la REGLA: seguir si H>0,5, invertir si H<0,5
      const aplicada = ops.map((o) => (o.H > 0.5 ? o.gana : o.ganaInv));
      const pct = (100 * aplicada.filter(Boolean).length) / aplicada.length;
      console.log(`  ${"─".repeat(48)}`);
      console.log(
        `  REGLA DE HURST APLICADA: ${pct.toFixed(1)} % de aciertos  ` +
        `(${(pct - EQUILIBRIO >= 0 ? "+" : "") + (pct - EQUILIBRIO).toFixed(1)} vs equilibrio)` +
        `${etq === "CONFIRMA" && pct > EQUILIBRIO ? "  ← RENTABLE" : ""}`
      );
    }
    console.log();
  }
}

void main();
