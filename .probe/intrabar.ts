/*
  ENTRADAS DENTRO DE LA VELA — la limitación más real de todo lo anterior.

  EL AGUJERO. Los veinticuatro estudios previos deciden AL CIERRE de la vela de
  cinco minutos y entran ahí mismo. Un scalper no hace eso: espera un
  disparador dentro de la vela siguiente. Todo lo medido puede estar juzgando
  un método que nadie usa.

  Y HAY UN SEGUNDO ARREGLO, quizá más importante que el primero. Al resolver el
  stop y el objetivo con velas de UN minuto en vez de cinco, casi desaparece la
  "vela ambigua" —la que contiene ambos niveles y que yo venía contando SIEMPRE
  como pérdida—. Ese supuesto era conservador a propósito, pero con velas de
  cinco minutos se aplicaba tantas veces que podía estar castigando el
  resultado más de lo justo. Se cuenta cuántas quedan.

  TRES DISPARADORES, fijados antes de mirar:

    inmediata      entrar al cierre de la vela de 5m — lo de siempre, como
                   referencia, pero ya resuelto a un minuto
    retroceso      dejar una orden limitada a 0,3 ATR a favor tuyo y entrar
                   solo si el precio va a buscarla en los 5 minutos siguientes.
                   Mejor precio Y comisión maker; a cambio, muchas se escapan
    confirmacion   entrar solo si el precio SUPERA el extremo de la vela de 5m
                   dentro de los 5 minutos siguientes. Peor precio, pero exige
                   que el movimiento se confirme

  COSTES SEGÚN CÓMO SE ENTRA, que es justo lo que cambia entre disparadores:
    inmediata/confirmacion  taker + taker + medio spread ×2 = 0,11 %
    retroceso               maker + taker + medio spread   = 0,075 %

  El objetivo y el stop siguen siendo los de la app (2,0 y 1,2 ATR de 5m) para
  que la comparación sea limpia: lo único que cambia es CÓMO se entra.
*/
import { computeAll, configFor, type Bundle, type IndicatorConfig } from "../src/lib/indicators";
import { MAX_BARS } from "../src/lib/signals";
import { requiredSigma } from "../src/lib/indicatorScore";
import type { Candle } from "../src/lib/types";

const PARES = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "SUIUSDT", "LINKUSDT", "AVAXUSDT",
];
const PAGINAS = 30;              // 45.000 velas de 1 minuto ≈ 31 días por par
const STOP_ATR = 1.2;
const TARGET_ATR = 2.0;
const RETROCESO_ATR = 0.3;       // a cuánto se deja la orden limitada
const ESPERA_MIN = 5;            // minutos que se espera al disparador
const MAX_MIN = MAX_BARS * 5;    // misma vida que antes, contada en minutos

type Disparo = "inmediata" | "retroceso" | "confirmacion";
const DISPAROS: Disparo[] = ["inmediata", "retroceso", "confirmacion"];
const COSTE: Record<Disparo, number> = { inmediata: 0.11, retroceso: 0.075, confirmacion: 0.11 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function klines1m(symbol: string): Promise<Candle[]> {
  const out: Candle[] = [];
  let end = Date.now();
  for (let p = 0; p < PAGINAS; p++) {
    const res = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1m&limit=1500&endTime=${end}`);
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

/** Agrupa velas de 1 minuto en velas de 5, alineadas al reloj. */
function a5m(m1: Candle[]): { velas: Candle[]; indice: number[] } {
  const velas: Candle[] = [];
  const indice: number[] = [];   // posición en m1 de la ÚLTIMA vela de cada grupo
  let i = 0;
  while (i < m1.length) {
    if (m1[i].t % 300_000 !== 0) { i++; continue; }
    const grupo = m1.slice(i, i + 5);
    if (grupo.length < 5 || grupo[4].t - grupo[0].t !== 240_000) { i++; continue; }
    velas.push({
      t: grupo[0].t, o: grupo[0].o,
      h: Math.max(...grupo.map((k) => k.h)),
      l: Math.min(...grupo.map((k) => k.l)),
      c: grupo[4].c, v: grupo.reduce((s, k) => s + k.v, 0), delta: 0,
    });
    indice.push(i + 4);
    i += 5;
  }
  return { velas, indice };
}

const finito = (x: number) => (Number.isFinite(x) ? x : 0);

function scoreEn(b: Bundle, i: number, cfg: IndicatorConfig): number {
  const umbral = 0.0006;
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

interface Op { t: number; r: number; gana: boolean; ambigua: boolean }

function replay(
  m1: Candle[], v5: Candle[], idx: number[], b: Bundle, cfg: IndicatorConfig,
  desde: number, hasta: number, disparo: Disparo
): { ops: Op[]; perdidas: number } {
  const ops: Op[] = [];
  let perdidas = 0;               // señales que no llegaron a disparar
  let anterior: 1 | -1 | 0 = 0;
  let libreDesde = -1;
  const coste = COSTE[disparo] / 100;

  for (let i = desde; i < hasta; i++) {
    const sc = scoreEn(b, i, cfg);
    const lado: 1 | -1 | 0 = sc > 0.12 ? 1 : sc < -0.12 ? -1 : 0;
    const atrI = b.atr[i];
    if (!lado || !(atrI > 0)) { anterior = lado; continue; }
    const relevo = lado !== anterior || idx[i] > libreDesde;
    anterior = lado;
    if (!relevo) continue;

    const cierre = v5[i].c;
    const m0 = idx[i];            // última vela de 1m de la señal
    if (!(cierre > 0) || m0 + 1 >= m1.length) continue;

    // ---------- disparador ----------
    let entrada: number | null = null;
    let mEntrada = -1;
    if (disparo === "inmediata") {
      entrada = cierre;
      mEntrada = m0;
    } else {
      const nivel = disparo === "retroceso"
        ? (lado === 1 ? cierre - atrI * RETROCESO_ATR : cierre + atrI * RETROCESO_ATR)
        : (lado === 1 ? v5[i].h : v5[i].l);
      for (let j = m0 + 1; j <= m0 + ESPERA_MIN && j < m1.length; j++) {
        const toca = disparo === "retroceso"
          ? (lado === 1 ? m1[j].l <= nivel : m1[j].h >= nivel)
          : (lado === 1 ? m1[j].h >= nivel : m1[j].l <= nivel);
        if (toca) { entrada = nivel; mEntrada = j; break; }
      }
    }
    if (entrada === null) { perdidas++; continue; }

    const riesgo = atrI * STOP_ATR;
    const premio = atrI * TARGET_ATR;
    const stop = lado === 1 ? entrada - riesgo : entrada + riesgo;
    const obj = lado === 1 ? entrada + premio : entrada - premio;
    const costeR = coste * entrada / riesgo;

    let bruto: number | null = null;
    let ambigua = false;
    let j = mEntrada + 1;
    for (; j <= mEntrada + MAX_MIN && j < m1.length; j++) {
      const c = m1[j];
      const tO = lado === 1 ? c.h >= obj : c.l <= obj;
      const tS = lado === 1 ? c.l <= stop : c.h >= stop;
      if (tO && tS) { bruto = -1; ambigua = true; break; }
      if (tO) { bruto = premio / riesgo; break; }
      if (tS) { bruto = -1; break; }
    }
    if (bruto === null) {
      if (j >= m1.length) continue;
      const fin = m1[Math.min(m1.length - 1, mEntrada + MAX_MIN)];
      bruto = (lado === 1 ? fin.c - entrada : entrada - fin.c) / riesgo;
    }
    libreDesde = j;
    ops.push({ t: m1[mEntrada].t, r: bruto - costeR, gana: bruto > 0, ambigua });
  }
  return { ops, perdidas };
}

async function main() {
  const liston = requiredSigma(DISPAROS.length);
  console.log("ENTRADAS DENTRO DE LA VELA · señal en 5m, ejecución y resolución a 1 minuto");
  console.log(`3 disparadores ⇒ listón ${liston.toFixed(2)} sigmas\n`);

  const datos: { m1: Candle[]; v5: Candle[]; idx: number[]; b: Bundle }[] = [];
  const cfg = configFor("5m");
  for (const sym of PARES) {
    try {
      const m1 = await klines1m(sym);
      if (m1.length < 20000) { console.log(`  ${sym}: solo ${m1.length} velas de 1m`); continue; }
      const { velas, indice } = a5m(m1);
      if (velas.length < 3000) { console.log(`  ${sym}: solo ${velas.length} velas de 5m`); continue; }
      datos.push({ m1, v5: velas, idx: indice, b: computeAll(velas, cfg, 5) });
      console.log(`  ${sym}: ${m1.length} velas de 1m → ${velas.length} de 5m (${(m1.length / 1440).toFixed(0)} días)`);
    } catch (e) { console.log(`  ${sym}: ${(e as Error).message}`); }
  }
  if (!datos.length) { console.log("sin datos"); return; }

  const n = Math.min(...datos.map((d) => d.v5.length));
  const corte = Math.floor(n * 0.65);
  console.log(`\n  disparador     tramo         ops  sucesos  sin disparar  ambiguas  aciertos     NETO       t`);
  console.log("  " + "─".repeat(88));
  for (const disparo of DISPAROS) {
    for (const [etq, a, z] of [["busca", 200, corte], ["CONFIRMA", corte, n]] as const) {
      const ops: Op[] = [];
      let perdidas = 0;
      for (const d of datos) {
        const r = replay(d.m1, d.v5, d.idx, d.b, cfg, a, z, disparo);
        ops.push(...r.ops);
        perdidas += r.perdidas;
      }
      if (ops.length < 200) { console.log(`  ${disparo.padEnd(13)} ${etq.padEnd(9)} muestra insuficiente`); continue; }
      const suc = porSuceso(ops.map((o) => ({ t: o.t, r: o.r })));
      const m = media(suc), t = tDe(suc);
      const pct = (100 * ops.filter((o) => o.gana).length) / ops.length;
      const amb = (100 * ops.filter((o) => o.ambigua).length) / ops.length;
      const sinD = (100 * perdidas) / (perdidas + ops.length);
      const marca = etq === "CONFIRMA" && m > 0 && t > liston ? "  ← RENTABLE" : "";
      console.log(
        `  ${disparo.padEnd(13)} ${etq.padEnd(9)} ${String(ops.length).padStart(7)}  ${String(suc.length).padStart(7)}  ` +
        `${sinD.toFixed(0).padStart(10)}%  ${amb.toFixed(1).padStart(7)}%  ${pct.toFixed(1).padStart(6)} %  ` +
        `${(m >= 0 ? "+" : "") + m.toFixed(4)}  ${(t >= 0 ? "+" : "") + t.toFixed(2)}${marca}`
      );
    }
    console.log("  " + "─".repeat(88));
  }
}

void main();
