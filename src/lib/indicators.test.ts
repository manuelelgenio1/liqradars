import { describe, expect, it } from "vitest";
import { adx, atr, computeAll, configFor, ema, rsi, supertrend, syncLastCandle, vwapDaily } from "./indicators";
import type { Candle } from "./types";

/* ============================================================
   Los indicadores se contrastan contra implementaciones de REFERENCIA
   escritas aquí desde la definición de Wilder, de forma independiente al
   código de producción. Si ambas coinciden es poco probable que las dos se
   equivoquen igual; si divergen, el test dice cuál y cuánto.
   ============================================================ */

// ---------- referencias independientes ----------

function refRSI(closes: number[], period: number): number {
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(0, d)) / period;
    loss = (loss * (period - 1) + Math.max(0, -d)) / period;
  }
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}

/** Wilder clásico: DI = 100 · DM_suavizado / TR_suavizado, ambos como sumas. */
function refADX(c: Candle[], period: number) {
  let tr = 0;
  let pdm = 0;
  let mdm = 0;
  for (let i = 1; i <= period; i++) {
    tr += Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
    const up = c[i].h - c[i - 1].h;
    const dn = c[i - 1].l - c[i].l;
    pdm += up > dn && up > 0 ? up : 0;
    mdm += dn > up && dn > 0 ? dn : 0;
  }
  const dxs: number[] = [];
  let plusDI = 0;
  let minusDI = 0;
  for (let i = period + 1; i < c.length; i++) {
    const t = Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
    const up = c[i].h - c[i - 1].h;
    const dn = c[i - 1].l - c[i].l;
    tr = tr - tr / period + t;
    pdm = pdm - pdm / period + (up > dn && up > 0 ? up : 0);
    mdm = mdm - mdm / period + (dn > up && dn > 0 ? dn : 0);
    plusDI = (pdm / tr) * 100;
    minusDI = (mdm / tr) * 100;
    dxs.push(plusDI + minusDI > 0 ? (Math.abs(plusDI - minusDI) / (plusDI + minusDI)) * 100 : 0);
  }
  let a = dxs.slice(0, period).reduce((s, x) => s + x, 0) / period;
  for (let i = period; i < dxs.length; i++) a = (a * (period - 1) + dxs[i]) / period;
  return { adx: a, plusDI, minusDI };
}

// ---------- datos sintéticos deterministas ----------
// Movimiento pseudoaleatorio reproducible: no es un mercado real, pero para
// comprobar que dos fórmulas coinciden basta con que las series sean
// idénticas en ambos lados.
function makeCandles(n: number, seed = 42): Candle[] {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: Candle[] = [];
  let price = 50_000;
  for (let i = 0; i < n; i++) {
    const drift = (rand() - 0.48) * 0.012;
    const o = price;
    const c = o * (1 + drift);
    const h = Math.max(o, c) * (1 + rand() * 0.004);
    const l = Math.min(o, c) * (1 - rand() * 0.004);
    const v = 100 + rand() * 400;
    out.push({ t: 1_700_000_000_000 + i * 300_000, o, h, l, c, v, delta: (c >= o ? 1 : -1) * v * 0.3 });
    price = c;
  }
  return out;
}

const candles = makeCandles(300);
const closes = candles.map((k) => k.c);

describe("EMA", () => {
  it("arranca en el primer valor y converge", () => {
    const e = ema([10, 10, 10, 10, 10], 3);
    expect(e[0]).toBe(10);
    expect(e.at(-1)).toBeCloseTo(10, 10);
  });

  it("una serie constante devuelve esa constante", () => {
    expect(ema(new Array(50).fill(7), 12).every((v) => Math.abs(v - 7) < 1e-9)).toBe(true);
  });
});

describe("RSI", () => {
  it("coincide con la referencia de Wilder", () => {
    for (const period of [9, 14, 21]) {
      const mine = rsi(closes, period).at(-1)!;
      expect(mine).toBeCloseTo(refRSI(closes, period), 6);
    }
  });

  it("siempre queda dentro de 0-100", () => {
    for (const v of rsi(closes, 14)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it("una subida monótona satura en 100", () => {
    const up = Array.from({ length: 60 }, (_, i) => 100 + i);
    expect(rsi(up, 14).at(-1)).toBeCloseTo(100, 6);
  });
});

describe("ATR", () => {
  it("nunca es negativo y responde al rango", () => {
    const a = atr(candles, 14);
    expect(a.every((v) => v >= 0)).toBe(true);
    expect(a.at(-1)).toBeGreaterThan(0);
  });
});

describe("ADX y direccionales", () => {
  it("ADX coincide con la referencia", () => {
    for (const period of [14, 20]) {
      expect(adx(candles, period).adx.at(-1)!).toBeCloseTo(refADX(candles, period).adx, 4);
    }
  });

  // Este es EL test que importa: la versión anterior del proyecto dividía una
  // suma suavizada de ±DM entre el PROMEDIO suavizado del TR, lo que inflaba
  // los DI exactamente `period` veces. Se veían valores como "+DI 426".
  it("+DI y −DI están en su rango 0-100, no inflados por el periodo", () => {
    const r = adx(candles, 14);
    for (const v of [...r.plusDI, ...r.minusDI]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it("+DI y −DI coinciden con la referencia", () => {
    const mine = adx(candles, 14);
    const ref = refADX(candles, 14);
    expect(mine.plusDI.at(-1)!).toBeCloseTo(ref.plusDI, 4);
    expect(mine.minusDI.at(-1)!).toBeCloseTo(ref.minusDI, 4);
  });

  it("el ADX se mantiene en 0-100", () => {
    for (const v of adx(candles, 14).adx) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });
});

describe("Supertrend", () => {
  it("la confirmación nunca adelanta al giro crudo", () => {
    const { up, confirmed } = supertrend(candles, 10, 2);
    // un giro confirmado en i exige que el crudo ya hubiera girado en i-1
    for (let i = 1; i < confirmed.length; i++) {
      if (confirmed[i] !== confirmed[i - 1]) {
        expect(up[i - 1]).toBe(confirmed[i]);
      }
    }
  });
});

describe("VWAP", () => {
  it("se reinicia en cada día UTC", () => {
    const day = 86_400_000;
    const two: Candle[] = [
      { t: 0, o: 10, h: 10, l: 10, c: 10, v: 100, delta: 0 },
      { t: 1000, o: 20, h: 20, l: 20, c: 20, v: 100, delta: 0 },
      { t: day + 1000, o: 50, h: 50, l: 50, c: 50, v: 100, delta: 0 },
    ];
    const v = vwapDaily(two);
    expect(v[1]).toBeCloseTo(15, 6); // media del primer día
    expect(v[2]).toBeCloseTo(50, 6); // reiniciado: solo la vela nueva
  });

  it("ignora el volumen negativo sin romperse", () => {
    const bad: Candle[] = [{ t: 0, o: 10, h: 10, l: 10, c: 10, v: -5, delta: 0 }];
    expect(Number.isFinite(vwapDaily(bad)[0])).toBe(true);
  });
});

describe("consenso", () => {
  it("produce un veredicto coherente con su puntuación", () => {
    const b = computeAll(candles, configFor("5m"), 5);
    const { trend, score, strength } = b.consensus;
    expect(strength).toBeGreaterThanOrEqual(0);
    expect(strength).toBeLessThanOrEqual(1);
    if (trend === "alcista") expect(score).toBeGreaterThan(0);
    if (trend === "bajista") expect(score).toBeLessThan(0);
  });

  it("pondera cinco indicadores y ninguno devuelve NaN", () => {
    const b = computeAll(candles, configFor("1H"), 60);
    expect(b.consensus.votes).toHaveLength(5);
    for (const v of b.consensus.votes) {
      expect(Number.isFinite(v.strength)).toBe(true);
      expect(v.strength).toBeGreaterThanOrEqual(0);
      expect(v.strength).toBeLessThanOrEqual(1);
    }
  });

  it("aguanta series demasiado cortas sin lanzar", () => {
    expect(() => computeAll(makeCandles(3), configFor("5m"), 5)).not.toThrow();
  });
});

describe("sincronización con el precio en vivo", () => {
  const serie = makeCandles(200);

  it("devuelve la MISMA referencia si no hay nada que cambiar", () => {
    const last = serie[serie.length - 1];
    expect(syncLastCandle(serie, last.c)).toBe(serie);
    expect(syncLastCandle(serie, NaN)).toBe(serie);
    expect(syncLastCandle(serie, 0)).toBe(serie);
    expect(syncLastCandle([], 100)).toEqual([]);
  });

  it("actualiza cierre, máximo y mínimo de la última vela", () => {
    const alto = syncLastCandle(serie, 999_999);
    expect(alto.at(-1)!.c).toBe(999_999);
    expect(alto.at(-1)!.h).toBe(999_999);
    const bajo = syncLastCandle(serie, 1);
    expect(bajo.at(-1)!.c).toBe(1);
    expect(bajo.at(-1)!.l).toBe(1);
  });

  it("no toca ninguna vela anterior", () => {
    const s2 = syncLastCandle(serie, 12_345);
    for (let i = 0; i < serie.length - 1; i++) expect(s2[i]).toBe(serie[i]);
  });

  // El bug real: el gráfico pintaba el precio en vivo y los indicadores de esa
  // misma vela respondían a un cierre de hasta 20 s antes.
  it("los indicadores REACCIONAN al precio en vivo", () => {
    const cfg = configFor("5m");
    const viejo = computeAll(serie, cfg, 5);
    const ultimo = serie.at(-1)!.c;
    const nuevo = computeAll(syncLastCandle(serie, ultimo * 1.02), cfg, 5);
    expect(nuevo.rsi.at(-1)).not.toBe(viejo.rsi.at(-1));
    expect(nuevo.emaFast.at(-1)).not.toBe(viejo.emaFast.at(-1));
    expect(nuevo.macdHist.at(-1)).not.toBe(viejo.macdHist.at(-1));
  });

  it("una subida sube el RSI y una bajada lo baja", () => {
    const cfg = configFor("5m");
    const ultimo = serie.at(-1)!.c;
    const arriba = computeAll(syncLastCandle(serie, ultimo * 1.03), cfg, 5).rsi.at(-1)!;
    const abajo = computeAll(syncLastCandle(serie, ultimo * 0.97), cfg, 5).rsi.at(-1)!;
    expect(arriba).toBeGreaterThan(abajo);
  });
});
