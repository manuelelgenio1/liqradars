import { describe, expect, it } from "vitest";
import { alignment, computeLevels, MIN_CANDLES, STOP_ATR, TARGET_ATR, type TradeLevels } from "./levels";
import { ROUND_TRIP_COST_PCT } from "./signals";
import type { Candle } from "./types";

/*
  Lo que estas pruebas vigilan no es que la dirección acierte —eso ya se midió
  y no lo hace— sino que los NIVELES sean coherentes. Un stop del lado
  equivocado, un R:R que no cuadra con las distancias o un coste mal escalado
  serían errores silenciosos: números creíbles y falsos.
*/

const velas = (closes: number[], amplitud = 0.004): Candle[] =>
  closes.map((c, i) => ({
    t: 1_700_000_000_000 + i * 300_000,
    o: c,
    h: c * (1 + amplitud),
    l: c * (1 - amplitud),
    c,
    v: 100,
    delta: 0,
  }));

const subida = (n: number) => velas(Array.from({ length: n }, (_, i) => 1000 + i * 3));
const bajada = (n: number) => velas(Array.from({ length: n }, (_, i) => 5000 - i * 3));
const plano = (n: number) => velas(Array.from({ length: n }, () => 2000));

describe("salvaguardas", () => {
  it("sin velas suficientes no inventa niveles", () => {
    const r = computeLevels("5m", "5 min", subida(MIN_CANDLES - 1), 5);
    expect(r.ready).toBe(false);
    expect(Number.isFinite(r.entry)).toBe(false);
    expect(r.side).toBeNull();
  });

  it("un mercado sin movimiento no produce ATR ni niveles", () => {
    // ATR cero: no hay distancia con la que construir un stop
    const quieto = Array.from({ length: 300 }, () => ({
      t: 0, o: 100, h: 100, l: 100, c: 100, v: 1, delta: 0,
    }));
    expect(computeLevels("5m", "5 min", quieto, 5).ready).toBe(false);
  });

  it("nunca devuelve un precio o un stop negativos", () => {
    for (const c of [subida(300), bajada(300), plano(300)]) {
      const r = computeLevels("1H", "1 hora", c, 60);
      if (r.ready) {
        expect(r.entry).toBeGreaterThan(0);
        expect(r.stop).toBeGreaterThan(0);
        expect(r.target).toBeGreaterThan(0);
      }
    }
  });
});

describe("geometría de los niveles", () => {
  it("en largo el stop va DEBAJO y el objetivo ARRIBA", () => {
    const r = computeLevels("1H", "1 hora", subida(300), 60);
    expect(r.ready).toBe(true);
    expect(r.side).toBe("long");
    expect(r.stop).toBeLessThan(r.entry);
    expect(r.target).toBeGreaterThan(r.entry);
  });

  it("en corto el stop va ARRIBA y el objetivo DEBAJO", () => {
    const r = computeLevels("1H", "1 hora", bajada(300), 60);
    expect(r.ready).toBe(true);
    expect(r.side).toBe("short");
    expect(r.stop).toBeGreaterThan(r.entry);
    expect(r.target).toBeLessThan(r.entry);
  });

  it("las distancias son múltiplos exactos del ATR", () => {
    const r = computeLevels("1H", "1 hora", subida(300), 60);
    expect(Math.abs(r.entry - r.stop)).toBeCloseTo(r.atr * STOP_ATR, 8);
    expect(Math.abs(r.target - r.entry)).toBeCloseTo(r.atr * TARGET_ATR, 8);
  });

  it("el R:R cuadra con las distancias reales", () => {
    const r = computeLevels("4H", "4 horas", subida(300), 240);
    expect(r.rr).toBeCloseTo(Math.abs(r.target - r.entry) / Math.abs(r.entry - r.stop), 8);
    expect(r.rr).toBeCloseTo(TARGET_ATR / STOP_ATR, 8);
  });

  it("el precio en vivo manda sobre el cierre de la última vela", () => {
    const c = subida(300);
    const ultimo = c[c.length - 1].c;
    const r = computeLevels("1H", "1 hora", c, 60, ultimo * 1.05);
    expect(r.entry).toBeCloseTo(ultimo * 1.05, 6);
    // y los niveles se recolocan con él
    expect(r.stop).toBeGreaterThan(ultimo);
  });

  it("un precio en vivo imposible se ignora en vez de romper los niveles", () => {
    const c = subida(300);
    for (const malo of [0, -5, NaN]) {
      const r = computeLevels("1H", "1 hora", c, 60, malo);
      expect(r.entry).toBeCloseTo(c[c.length - 1].c, 6);
    }
  });
});

describe("el coste en R", () => {
  /*
    Es la columna que decide si una entrada tiene sentido. El coste se mide
    contra la DISTANCIA AL STOP, no como un porcentaje del precio: por eso un
    marco corto, con stop estrecho, paga muchísimo más en términos de riesgo.
  */
  it("un stop más ancho abarata la operación en R", () => {
    // mismo par, dos amplitudes: más volatilidad ⇒ stop más ancho ⇒ menos coste
    const estrecho = computeLevels("5m", "5 min", velas(Array.from({ length: 300 }, (_, i) => 1000 + i * 3), 0.0005), 5);
    const ancho = computeLevels("5m", "5 min", velas(Array.from({ length: 300 }, (_, i) => 1000 + i * 3), 0.02), 5);
    expect(estrecho.ready && ancho.ready).toBe(true);
    expect(estrecho.costR).toBeGreaterThan(ancho.costR);
  });

  it("el coste es exactamente la comisión dividida por el riesgo", () => {
    const r = computeLevels("1H", "1 hora", subida(300), 60);
    const riesgo = Math.abs(r.entry - r.stop);
    expect(r.costR).toBeCloseTo((r.entry * (ROUND_TRIP_COST_PCT / 100)) / riesgo, 8);
  });

  it("clasifica como prohibitivo lo que se come un tercio del riesgo", () => {
    const r = computeLevels("5m", "5 min", velas(Array.from({ length: 300 }, (_, i) => 1000 + i * 3), 0.0004), 5);
    expect(r.costR).toBeGreaterThan(0.35);
    expect(r.costVerdict).toBe("prohibitivo");
  });

  it("stopPct y atrPct son coherentes entre sí", () => {
    const r = computeLevels("4H", "4 horas", subida(300), 240);
    expect(r.stopPct).toBeCloseTo(r.atrPct * STOP_ATR, 6);
  });
});

describe("lectura conjunta de los marcos", () => {
  const fila = (label: string, side: "long" | "short" | null, costR = 0.1): TradeLevels => ({
    timeframe: label, label, trend: side === "long" ? "alcista" : side === "short" ? "bajista" : "lateral",
    strength: 0.5, side, price: 100, atr: 1, atrPct: 1, entry: 100,
    stop: side === "short" ? 101.2 : 98.8, target: side === "short" ? 97.6 : 102.4,
    stopPct: 1.2, rr: 1.67, costR, costVerdict: "asumible", candles: 300, ready: true, votes: [],
  });

  it("sin marcos listos no inventa una dirección", () => {
    const r = alignment([]);
    expect(r.dominant).toBeNull();
    expect(r.cheapest).toBeNull();
  });

  it("ignora los marcos laterales al contar", () => {
    const r = alignment([fila("5m", "long"), fila("1H", null), fila("4H", "long")]);
    expect(r.total).toBe(2);
    expect(r.agree).toBe(2);
  });

  it("un empate no produce dirección dominante", () => {
    const r = alignment([fila("5m", "long"), fila("4H", "short")]);
    expect(r.dominant).toBeNull();
  });

  it("nombra los marcos que van EN CONTRA, que es lo que hay que saber", () => {
    const r = alignment([fila("5m", "long"), fila("30m", "long"), fila("1D", "short")]);
    expect(r.dominant).toBe("alcista");
    expect(r.agree).toBe(2);
    expect(r.against).toEqual(["1D"]);
  });

  it("el marco más barato sale de entre los que van A FAVOR", () => {
    // el más barato en términos absolutos va en contra: no debe elegirse
    const r = alignment([
      fila("5m", "long", 0.60),
      fila("4H", "long", 0.07),
      fila("1D", "short", 0.01),
    ]);
    expect(r.cheapest!.label).toBe("4H");
  });
});
