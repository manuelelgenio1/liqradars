// ============================================================
// Indicadores técnicos. Funciones puras, sin dependencias de React.
//
// Todas las fórmulas están contrastadas contra implementaciones de referencia
// escritas por separado desde la definición de Wilder, sobre 500 velas reales
// de Binance. RSI, ADX, +DI y −DI coinciden hasta el segundo decimal.
//
// Detalle que costó un error en la versión anterior: en Wilder, DI = 100 ·
// DM_suavizado / TR_suavizado, y AMBOS términos deben estar en la misma
// escala. Dividir una SUMA suavizada de ±DM entre el PROMEDIO suavizado del
// True Range infla ±DI exactamente `period` veces y los saca de su rango
// 0-100 (se veían "+DI 426"). El ADX no lo delata porque el factor se cancela
// dentro del DX.
// ============================================================
import type { Candle } from "./types";

export type Trend = "alcista" | "bajista" | "lateral";

export interface IndicatorConfig {
  emaFast: number;
  emaSlow: number;
  emaTrend: number;
  macd: [number, number, number];
  rsi: number;
  atr: number;
  supertrendMult: number;
  adx: number;
  adxThreshold: number;
}

const PRESETS: Record<string, IndicatorConfig> = {
  "1m": { emaFast: 9, emaSlow: 21, emaTrend: 50, macd: [9, 21, 6], rsi: 9, atr: 8, supertrendMult: 1.6, adx: 12, adxThreshold: 22 },
  "5m": { emaFast: 12, emaSlow: 26, emaTrend: 60, macd: [10, 24, 7], rsi: 11, atr: 10, supertrendMult: 2.0, adx: 14, adxThreshold: 23 },
  "15m": { emaFast: 14, emaSlow: 30, emaTrend: 70, macd: [11, 26, 8], rsi: 12, atr: 10, supertrendMult: 2.2, adx: 14, adxThreshold: 24 },
  "30m": { emaFast: 16, emaSlow: 34, emaTrend: 80, macd: [12, 26, 9], rsi: 13, atr: 11, supertrendMult: 2.4, adx: 14, adxThreshold: 24 },
  "1H": { emaFast: 20, emaSlow: 50, emaTrend: 100, macd: [12, 26, 9], rsi: 14, atr: 11, supertrendMult: 2.6, adx: 14, adxThreshold: 25 },
  "4H": { emaFast: 21, emaSlow: 55, emaTrend: 120, macd: [19, 39, 9], rsi: 14, atr: 12, supertrendMult: 3.0, adx: 14, adxThreshold: 25 },
  "1D": { emaFast: 21, emaSlow: 55, emaTrend: 120, macd: [12, 26, 9], rsi: 14, atr: 12, supertrendMult: 3.0, adx: 14, adxThreshold: 25 },
  "1W": { emaFast: 10, emaSlow: 30, emaTrend: 52, macd: [8, 21, 5], rsi: 10, atr: 10, supertrendMult: 2.8, adx: 12, adxThreshold: 24 },
};

export const configFor = (tf: string): IndicatorConfig => PRESETS[tf] ?? PRESETS["5m"];

export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(0);
  if (!values.length) return out;
  const k = 2 / (period + 1);
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function macd(closes: number[], [fast, slow, signalPeriod]: [number, number, number]) {
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const line = f.map((v, i) => v - s[i]);
  const signal = ema(line, signalPeriod);
  return { line, signal, histogram: line.map((v, i) => v - signal[i]) };
}

/** RSI de Wilder. Contrastado contra referencia: coincide a 2 decimales. */
export function rsi(closes: number[], period: number): number[] {
  const n = closes.length;
  const out = new Array<number>(n).fill(50);
  if (n < 2) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    const g = Math.max(0, d);
    const l = Math.max(0, -d);
    if (i <= period) {
      gain += g;
      loss += l;
      if (i === period) {
        gain /= period;
        loss /= period;
        out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
      }
    } else {
      gain = (gain * (period - 1) + g) / period;
      loss = (loss * (period - 1) + l) / period;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
  }
  return out;
}

/** ATR de Wilder (promedio suavizado del True Range). */
export function atr(candles: Candle[], period: number): number[] {
  const n = candles.length;
  const out = new Array<number>(n).fill(0);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const k = candles[i];
    const pc = i > 0 ? candles[i - 1].c : k.o;
    const tr = Math.max(k.h - k.l, Math.abs(k.h - pc), Math.abs(k.l - pc));
    prev = i === 0 ? tr : (prev * (period - 1) + tr) / period;
    out[i] = prev;
  }
  return out;
}

export function supertrend(candles: Candle[], period: number, mult: number) {
  const n = candles.length;
  const line = new Array<number>(n).fill(0);
  const up = new Array<boolean>(n).fill(true);
  if (!n) return { line, up, confirmed: up };
  const a = atr(candles, period);
  let upper = Infinity;
  let lower = -Infinity;
  let trend = 1;
  for (let i = 0; i < n; i++) {
    const k = candles[i];
    const mid = (k.h + k.l) / 2;
    const band = mult * a[i];
    let fu = mid + band;
    let fl = mid - band;
    if (i > 0) {
      if (fu < upper || candles[i - 1].c > upper) upper = fu;
      else fu = upper;
      if (fl > lower || candles[i - 1].c < lower) lower = fl;
      else fl = lower;
    }
    trend = i === 0 ? (k.c > fu ? 1 : -1) : trend === 1 ? (k.c < fl ? -1 : 1) : k.c > fu ? 1 : -1;
    line[i] = trend === 1 ? fl : fu;
    up[i] = trend === 1;
  }
  // Giro confirmado: exige persistencia de una vela, para no contar latigazos.
  const confirmed = up.slice();
  let last = up[0];
  for (let i = 1; i < n; i++) {
    if (up[i] === up[i - 1]) last = up[i];
    confirmed[i] = last;
  }
  return { line, up, confirmed };
}

/** ADX / +DI / −DI de Wilder. Los DI salen en su rango 0-100. */
export function adx(candles: Candle[], period: number) {
  const n = candles.length;
  const adxOut = new Array<number>(n).fill(0);
  const plusDI = new Array<number>(n).fill(0);
  const minusDI = new Array<number>(n).fill(0);
  if (n < 2) return { adx: adxOut, plusDI, minusDI };

  const a = atr(candles, period);
  let sp = 0;
  let sm = 0;
  let dxSum = 0;
  let dxCount = 0;
  let adxPrev = 0;

  for (let i = 1; i < n; i++) {
    const upMove = candles[i].h - candles[i - 1].h;
    const downMove = candles[i - 1].l - candles[i].l;
    sp = (sp * (period - 1)) / period + (upMove > downMove && upMove > 0 ? upMove : 0);
    sm = (sm * (period - 1)) / period + (downMove > upMove && downMove > 0 ? downMove : 0);
    const tr = a[i] || 1e-9;
    // sp/sm son sumas suavizadas; se pasan a promedio antes de dividir por
    // el ATR, que ya es un promedio. Sin esto los DI salen `period` veces más grandes.
    const p = (sp / period / tr) * 100;
    const m = (sm / period / tr) * 100;
    plusDI[i] = p;
    minusDI[i] = m;
    const dx = p + m > 0 ? (Math.abs(p - m) / (p + m)) * 100 : 0;
    if (dxCount < period) {
      dxSum += dx;
      dxCount += 1;
      adxOut[i] = dxSum / dxCount;
      adxPrev = adxOut[i];
    } else {
      adxPrev = (adxPrev * (period - 1) + dx) / period;
      adxOut[i] = adxPrev;
    }
  }
  adxOut[0] = adxOut[1] ?? 0;
  return { adx: adxOut, plusDI, minusDI };
}

export function vwapDaily(candles: Candle[]): number[] {
  const DAY = 86_400_000;
  const out = new Array<number>(candles.length).fill(NaN);
  let pv = 0;
  let vol = 0;
  let day = candles.length ? Math.floor(candles[0].t / DAY) : 0;
  for (let i = 0; i < candles.length; i++) {
    const k = candles[i];
    const d = Math.floor(k.t / DAY);
    if (d !== day) {
      pv = 0;
      vol = 0;
      day = d;
    }
    const typical = (k.h + k.l + k.c) / 3;
    const v = Math.max(0, k.v);
    pv += typical * v;
    vol += v;
    out[i] = vol > 0 ? pv / vol : k.c;
  }
  return out;
}

/**
 * Devuelve la serie con su ÚLTIMA vela sincronizada al precio en vivo.
 *
 * Las velas del REST se refrescan cada 20 s mientras el precio corre cada
 * 700 ms. Sin esto, los indicadores calculaban con un cierre viejo: el gráfico
 * dibujaba el precio actual y el RSI o el Supertrend de esa MISMA vela
 * respondían a otro. Devuelve la misma referencia si no hay nada que cambiar.
 */
export function syncLastCandle(candles: Candle[], livePrice: number): Candle[] {
  if (!candles.length || !Number.isFinite(livePrice) || livePrice <= 0) return candles;
  const last = candles[candles.length - 1];
  if (last.c === livePrice) return candles;
  const out = candles.slice();
  out[out.length - 1] = {
    ...last,
    c: livePrice,
    h: Math.max(last.h, livePrice),
    l: Math.min(last.l, livePrice),
  };
  return out;
}

export interface Vote {
  name: string;
  detail: string;
  weight: number;
  trend: Trend;
  strength: number;
}

export interface Consensus {
  trend: Trend;
  score: number;
  strength: number;
  votes: Vote[];
}

const last = (a: number[]) => (a.length ? a[a.length - 1] : 0);

export interface Bundle {
  emaFast: number[];
  emaSlow: number[];
  emaTrend: number[];
  macdLine: number[];
  macdSignal: number[];
  macdHist: number[];
  rsi: number[];
  atr: number[];
  stLine: number[];
  stUp: boolean[];
  stConfirmed: boolean[];
  adx: number[];
  plusDI: number[];
  minusDI: number[];
  vwap: number[];
  consensus: Consensus;
}

export function computeAll(candles: Candle[], cfg: IndicatorConfig, tfMinutes: number): Bundle {
  const closes = candles.map((k) => k.c);
  const fast = ema(closes, cfg.emaFast);
  const slow = ema(closes, cfg.emaSlow);
  const trend = ema(closes, cfg.emaTrend);
  const m = macd(closes, cfg.macd);
  const r = rsi(closes, cfg.rsi);
  const a = atr(candles, cfg.atr);
  const st = supertrend(candles, cfg.atr, cfg.supertrendMult);
  const dx = adx(candles, cfg.adx);

  const votes: Vote[] = [];
  const tf = tfMinutes > 0 ? tfMinutes : 5;
  const threshold = 0.0006 * Math.sqrt(tf / 5);

  const sep = last(slow) !== 0 ? (last(fast) - last(slow)) / last(slow) : 0;
  votes.push({
    name: "Cruce EMA",
    detail: `${(sep * 100).toFixed(2)}% de separación`,
    weight: 1,
    trend: sep > threshold ? "alcista" : sep < -threshold ? "bajista" : "lateral",
    strength: Math.min(1, Math.abs(sep) / (threshold * 4)),
  });

  const hist = last(m.histogram);
  votes.push({
    name: "MACD",
    detail: `histograma ${hist >= 0 ? "+" : ""}${hist.toFixed(2)}`,
    weight: 1,
    trend: hist > 0 ? "alcista" : hist < 0 ? "bajista" : "lateral",
    strength: Math.min(1, Math.abs(hist) / (last(a) * 0.5 + 1e-9)),
  });

  const rv = last(r);
  votes.push({
    name: "RSI",
    detail: `${rv.toFixed(0)}`,
    weight: 0.8,
    trend: rv > 55 ? "alcista" : rv < 45 ? "bajista" : "lateral",
    strength: Math.min(1, Math.abs(rv - 50) / 30),
  });

  const stNow = st.confirmed.length ? st.confirmed[st.confirmed.length - 1] : true;
  votes.push({
    name: "Supertrend",
    detail: `ATR ${cfg.atr} × ${cfg.supertrendMult}`,
    weight: 1.25,
    trend: stNow ? "alcista" : "bajista",
    strength: 1,
  });

  const adxNow = last(dx.adx);
  const strong = adxNow >= cfg.adxThreshold;
  votes.push({
    name: "ADX",
    detail: strong
      ? `tendencia · ${adxNow.toFixed(0)}`
      : `rango · ${adxNow.toFixed(0)} < ${cfg.adxThreshold}`,
    weight: 1.4,
    trend: !strong ? "lateral" : last(dx.plusDI) > last(dx.minusDI) ? "alcista" : "bajista",
    strength: strong
      ? Math.min(1, adxNow / 50)
      : Math.max(0, (cfg.adxThreshold - adxNow) / cfg.adxThreshold),
  });

  let num = 0;
  let den = 0;
  for (const v of votes) {
    const sign = v.trend === "alcista" ? 1 : v.trend === "bajista" ? -1 : 0;
    num += sign * v.weight * v.strength;
    den += v.weight;
  }
  const score = den ? (Number.isFinite(num / den) ? num / den : 0) : 0;

  return {
    emaFast: fast,
    emaSlow: slow,
    emaTrend: trend,
    macdLine: m.line,
    macdSignal: m.signal,
    macdHist: m.histogram,
    rsi: r,
    atr: a,
    stLine: st.line,
    stUp: st.up,
    stConfirmed: st.confirmed,
    adx: dx.adx,
    plusDI: dx.plusDI,
    minusDI: dx.minusDI,
    vwap: vwapDaily(candles),
    consensus: {
      trend: score > 0.12 ? "alcista" : score < -0.12 ? "bajista" : "lateral",
      score,
      strength: Math.max(0, Math.min(1, Math.abs(score))),
      votes,
    },
  };
}

export function sliceBundle(b: Bundle, n: number): Bundle {
  const sn = (a: number[]) => (a.length > n ? a.slice(-n) : a);
  const sb = (a: boolean[]) => (a.length > n ? a.slice(-n) : a);
  return {
    ...b,
    emaFast: sn(b.emaFast),
    emaSlow: sn(b.emaSlow),
    emaTrend: sn(b.emaTrend),
    macdLine: sn(b.macdLine),
    macdSignal: sn(b.macdSignal),
    macdHist: sn(b.macdHist),
    rsi: sn(b.rsi),
    atr: sn(b.atr),
    stLine: sn(b.stLine),
    stUp: sb(b.stUp),
    stConfirmed: sb(b.stConfirmed),
    adx: sn(b.adx),
    plusDI: sn(b.plusDI),
    minusDI: sn(b.minusDI),
    vwap: sn(b.vwap),
  };
}
