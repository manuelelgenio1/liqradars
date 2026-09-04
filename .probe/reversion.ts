/*
  LA REVERSIÓN, OPERADA CON NIVELES PENSADOS PARA ELLA — Y CON MUCHA MÁS DATA.

  DE DÓNDE VIENE. Es lo único vivo del proyecto. Tras un movimiento grande de
  cinco minutos, la siguiente vela deshace parte: bruto −0,052 a −0,086 ATR con
  t=−3,15 y −2,81, mismo signo en las dos mitades. Y la regresión ridge sobre
  once rasgos le dio POR SU CUENTA el mayor peso, con signo negativo. Dos
  métodos independientes apuntando a lo mismo.

  QUÉ CAMBIA AQUÍ RESPECTO A TODO LO ANTERIOR:

   1. NO SE USA EL CONSENSO DE INDICADORES. Veintiuna medidas dicen que vale
      cero: acierta 35 % y su inversa 38 %, ambas en el 37,5 % del azar. La
      señal es el RETORNO CRUDO de la vela anterior, y nada más.

   2. NIVELES PENSADOS PARA LA REVERSIÓN. Los 1,2/2,0 ATR de la app están
      hechos para seguir tendencia: objetivo lejos, aguantar 48 velas. La
      reversión es rápida y pequeña, así que se prueban objetivos CERCA y
      además una salida por TIEMPO, que es lo natural cuando lo que esperas es
      un rebote y no un viaje.

   3. MUCHA MÁS HISTORIA. 45.000 velas por par en vez de 12.000 — unos cinco
      meses en 5m y 450.000 barras en total. Más muestra no agranda un efecto,
      pero estrecha el error y permite afirmar o descartar con más autoridad.

  REJILLA FIJADA ANTES DE MIRAR: 3 objetivos × 2 stops = 6 pruebas ⇒ 2,64
  sigmas. Se reporta la esperanza NETA en R, que es lo único que decide, y el
  acierto al lado para que se vea cuándo divergen.

  El coste se cuenta contra la distancia al stop, como siempre.
*/
import { atr as atrSerie } from "../src/lib/indicators";
import { ROUND_TRIP_COST_PCT } from "../src/lib/signals";
import { requiredSigma } from "../src/lib/indicatorScore";
import type { Candle } from "../src/lib/types";

const PARES = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "SUIUSDT", "LINKUSDT", "AVAXUSDT",
];
const TF = "5m";
const PAGINAS = 30;              // 45.000 velas por par
const ATR_LEN = 14;
const QUINTIL = 0.2;
const OBJETIVOS = [0.5, 1.0, 1.5];
const STOPS = [1.0, 2.0];
const MAX_VELAS = 12;            // salida por tiempo: la reversión es rápida

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
    await sleep(90);
  }
  return out;
}

const media = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

function cuantil(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))];
}

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

interface Op { t: number; r: number; gana: boolean }

function replay(v: Candle[], a: number[], desde: number, hasta: number, umbral: number, obj: number, stp: number): Op[] {
  const ops: Op[] = [];
  for (let i = desde; i < Math.min(hasta, v.length - MAX_VELAS - 1); i++) {
    const atrI = a[i];
    if (!(atrI > 0)) continue;
    const señal = (v[i].c - v[i].o) / atrI;        // retorno de la vela que acaba de cerrar
    if (!Number.isFinite(señal) || Math.abs(señal) < umbral) continue;

    const lado: 1 | -1 = señal > 0 ? -1 : 1;       // FADE: contra el movimiento
    const entrada = v[i].c;
    if (!(entrada > 0)) continue;
    const riesgo = atrI * stp;
    const premio = atrI * obj;
    const stop = lado === 1 ? entrada - riesgo : entrada + riesgo;
    const objetivo = lado === 1 ? entrada + premio : entrada - premio;
    const coste = (ROUND_TRIP_COST_PCT / 100) * entrada / riesgo;

    let bruto: number | null = null;
    let gana = false;
    for (let j = i + 1; j <= i + MAX_VELAS && j < v.length; j++) {
      const c = v[j];
      const tO = lado === 1 ? c.h >= objetivo : c.l <= objetivo;
      const tS = lado === 1 ? c.l <= stop : c.h >= stop;
      if (tO && tS) { bruto = -1; break; }          // ambigua = pérdida
      if (tO) { bruto = premio / riesgo; gana = true; break; }
      if (tS) { bruto = -1; break; }
    }
    if (bruto === null) {
      // salida por TIEMPO, a mercado, al cierre de la última vela
      const fin = v[Math.min(v.length - 1, i + MAX_VELAS)];
      const mov = lado === 1 ? fin.c - entrada : entrada - fin.c;
      bruto = mov / riesgo;
      gana = bruto > 0;
    }
    ops.push({ t: v[i].t, r: bruto - coste, gana });
  }
  return ops;
}

async function main() {
  const liston = requiredSigma(OBJETIVOS.length * STOPS.length);
  console.log("LA REVERSIÓN CON NIVELES PROPIOS · señal = retorno crudo de la vela anterior");
  console.log(`Sin consenso de indicadores. Salida por tiempo a las ${MAX_VELAS} velas.`);
  console.log(`6 combinaciones ⇒ listón ${liston.toFixed(2)} sigmas.\n`);

  const datos: { velas: Candle[]; a: number[] }[] = [];
  for (const sym of PARES) {
    try {
      const velas = await klines(sym);
      if (velas.length < 10000) { console.log(`  ${sym}: solo ${velas.length} velas`); continue; }
      datos.push({ velas, a: atrSerie(velas, ATR_LEN) });
      console.log(`  ${sym}: ${velas.length} velas (${(velas.length * 5 / 1440).toFixed(0)} días)`);
    } catch (e) { console.log(`  ${sym}: ${(e as Error).message}`); }
  }
  if (!datos.length) { console.log("sin datos"); return; }

  const n = Math.min(...datos.map((d) => d.velas.length));
  const corte = Math.floor(n * 0.65);
  const calentar = ATR_LEN + 5;

  const muestra: number[] = [];
  for (const d of datos)
    for (let i = calentar; i < corte; i++) {
      const x = d.a[i] > 0 ? Math.abs((d.velas[i].c - d.velas[i].o) / d.a[i]) : NaN;
      if (Number.isFinite(x)) muestra.push(x);
    }
  const umbral = cuantil(muestra, 1 - QUINTIL);
  console.log(`\n  ${datos.length} pares · ${n} velas cada uno · umbral |retorno| ≥ ${umbral.toFixed(3)} ATR\n`);

  console.log("  obj  stop  tramo         ops  sucesos  aciertos    NETO(R)       t");
  console.log("  " + "─".repeat(66));
  for (const obj of OBJETIVOS) {
    for (const stp of STOPS) {
      for (const [etq, a, z] of [["busca", calentar, corte], ["CONFIRMA", corte, n]] as const) {
        const ops: Op[] = [];
        for (const d of datos) ops.push(...replay(d.velas, d.a, a, z, umbral, obj, stp));
        if (ops.length < 200) { console.log(`  ${obj.toFixed(1)}  ${stp.toFixed(1)}   ${etq.padEnd(9)} muestra insuficiente`); continue; }
        const suc = porSuceso(ops.map((o) => ({ t: o.t, r: o.r })));
        const m = media(suc);
        const t = tDe(suc);
        const pct = (100 * ops.filter((o) => o.gana).length) / ops.length;
        const marca = etq === "CONFIRMA" && m > 0 && t > liston ? "  ← RENTABLE" : "";
        console.log(
          `  ${obj.toFixed(1)}  ${stp.toFixed(1)}   ${etq.padEnd(9)} ${String(ops.length).padStart(7)}  ${String(suc.length).padStart(7)}  ` +
          `${pct.toFixed(1).padStart(6)} %  ${(m >= 0 ? "+" : "") + m.toFixed(4)}  ${(t >= 0 ? "+" : "") + t.toFixed(2)}${marca}`
        );
      }
      console.log("  " + "─".repeat(66));
    }
  }
  console.log(`\nSolo cuenta lo marcado: neto positivo en CONFIRMA con t > ${liston.toFixed(2)}.`);
}

void main();
