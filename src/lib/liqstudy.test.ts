import { describe, expect, it } from "vitest";
import {
  analyze,
  BURST_USD,
  COOLDOWN_MS,
  emptyStudy,
  HORIZON_MS,
  MIN_OBS,
  recordBurst,
  resolvePending,
  type LiqObservation,
  type LiqStudy,
} from "./liqstudy";
import type { Candle } from "./types";

// En Node no existe localStorage: `storage` lo tolera y no persiste nada
// entre pruebas, que es justo el aislamiento que hace falta aquí.

const T0 = 1_700_000_000_000;
const velas = (desde: number, n: number, precio: (i: number) => number): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const c = precio(i);
    return { t: desde + i * 60_000, o: c, h: c, l: c, c, v: 1, delta: 0 };
  });

describe("anotación de estallidos", () => {
  it("ignora lo que no llega al umbral", () => {
    const s = emptyStudy();
    expect(recordBurst(s, "BTCUSDT", T0, 100, BURST_USD * 0.4, BURST_USD * 0.4)).toBe(s);
  });

  it("anota el lado dominante y su pureza", () => {
    const s = recordBurst(emptyStudy(), "BTCUSDT", T0, 100, 900_000, 100_000);
    expect(s.obs).toHaveLength(1);
    expect(s.obs[0].dominant).toBe("long");
    expect(s.obs[0].purity).toBeCloseTo(0.9, 5);
    expect(s.obs[0].notional).toBe(1_000_000);
  });

  it("el enfriamiento impide contar el mismo suceso muchas veces", () => {
    let s = recordBurst(emptyStudy(), "BTCUSDT", T0, 100, 900_000, 100_000);
    // una cascada real dispara decenas de mensajes seguidos
    for (let i = 1; i <= 20; i++) {
      s = recordBurst(s, "BTCUSDT", T0 + i * 1000, 100, 900_000, 100_000);
    }
    expect(s.obs).toHaveLength(1);

    s = recordBurst(s, "BTCUSDT", T0 + COOLDOWN_MS + 1, 100, 900_000, 100_000);
    expect(s.obs).toHaveLength(2);
  });

  it("el enfriamiento es por símbolo, no global", () => {
    let s = recordBurst(emptyStudy(), "BTCUSDT", T0, 100, 900_000, 100_000);
    s = recordBurst(s, "ETHUSDT", T0 + 1000, 50, 900_000, 100_000);
    expect(s.obs).toHaveLength(2);
  });

  it("rechaza un precio imposible", () => {
    const s = emptyStudy();
    expect(recordBurst(s, "BTCUSDT", T0, 0, 900_000, 100_000)).toBe(s);
  });
});

describe("cierre de observaciones", () => {
  it("no cierra nada antes de que venza el horizonte", () => {
    const s = recordBurst(emptyStudy(), "BTCUSDT", T0, 100, 900_000, 100_000);
    const r = resolvePending(s, "BTCUSDT", velas(T0, 30, () => 110));
    expect(r).toBe(s);
    expect(r.obs[0].fwdPct).toBeUndefined();
  });

  it("mide el retorno crudo con su signo natural", () => {
    const s = recordBurst(emptyStudy(), "BTCUSDT", T0, 100, 900_000, 100_000);
    const n = HORIZON_MS / 60_000 + 5;
    const r = resolvePending(s, "BTCUSDT", velas(T0, n, (i) => (i * 60_000 >= HORIZON_MS ? 105 : 100)));
    expect(r.obs[0].fwdPct).toBeCloseTo(5, 5); // +5 %, sin invertir por el lado
  });

  it("no toca observaciones de otro símbolo", () => {
    const s = recordBurst(emptyStudy(), "ETHUSDT", T0, 100, 900_000, 100_000);
    const n = HORIZON_MS / 60_000 + 5;
    expect(resolvePending(s, "BTCUSDT", velas(T0, n, () => 105))).toBe(s);
  });

  it("una vez cerrada, no se reescribe", () => {
    const s = recordBurst(emptyStudy(), "BTCUSDT", T0, 100, 900_000, 100_000);
    const n = HORIZON_MS / 60_000 + 5;
    const a = resolvePending(s, "BTCUSDT", velas(T0, n, (i) => (i * 60_000 >= HORIZON_MS ? 105 : 100)));
    // llega más historial, con otro precio: el resultado ya está escrito
    const b = resolvePending(a, "BTCUSDT", velas(T0, n + 50, () => 999));
    expect(b.obs[0].fwdPct).toBeCloseTo(5, 5);
  });
});

describe("análisis", () => {
  const cerrada = (i: number, dominant: "long" | "short", fwdPct: number): LiqObservation => ({
    id: `o${i}`, ts: T0 + i * 1000, symbol: "BTCUSDT", dominant,
    notional: 1e6, purity: 0.9, price: 100, fwdPct, resolvedTs: T0 + i * 1000 + HORIZON_MS,
  });
  const study = (obs: LiqObservation[]): LiqStudy => ({ obs, lastBurst: {} });

  it("sin datos no finge un veredicto", () => {
    expect(analyze(emptyStudy()).verdict).toBe("SIN DATOS");
  });

  it("avisa de muestra corta en vez de opinar", () => {
    const r = analyze(study(Array.from({ length: 5 }, (_, i) => cerrada(i, "long", -1))));
    expect(r.verdict).toBe("MUESTRA CORTA");
    expect(r.momentum).not.toBeNull(); // las cifras se enseñan igual, con la advertencia
  });

  it("las dos hipótesis son espejo exacto la una de la otra", () => {
    const obs = Array.from({ length: 40 }, (_, i) => cerrada(i, i % 2 ? "long" : "short", i % 3 - 1));
    const r = analyze(study(obs));
    expect(r.momentum!.grossPct).toBeCloseTo(-r.reversal!.grossPct, 10);
    expect(r.momentum!.tStat).toBeCloseTo(-r.reversal!.tStat, 10);
  });

  it("detecta la continuación cuando existe de verdad", () => {
    // largos liquidados y el precio se hunde siempre: la continuación acierta
    const obs = Array.from({ length: 40 }, (_, i) => cerrada(i, "long", -2 - (i % 5) * 0.1));
    const r = analyze(study(obs));
    expect(r.momentum!.grossPct).toBeGreaterThan(2);
    expect(r.momentum!.hitRate).toBe(1);
    expect(r.verdict).toBe("VENTAJA");
  });

  it("una ventaja que no cubre el coste no es ventaja", () => {
    // +0,10 % constante: por debajo del 0,14 % de ida y vuelta
    const obs = Array.from({ length: 40 }, (_, i) => cerrada(i, "short", 0.1));
    const r = analyze(study(obs));
    expect(r.momentum!.grossPct).toBeCloseTo(0.1, 5);
    expect(r.momentum!.netPct).toBeLessThan(0);
    expect(r.verdict).toBe("SIN VENTAJA");
  });

  it("puro ruido no produce un veredicto favorable", () => {
    const obs = Array.from({ length: 60 }, (_, i) =>
      cerrada(i, i % 2 ? "long" : "short", Math.sin(i * 2.7) * 3)
    );
    expect(analyze(study(obs)).verdict).toBe("SIN VENTAJA");
  });

  it("cuenta aparte lo cerrado y lo pendiente", () => {
    const obs = [
      ...Array.from({ length: MIN_OBS }, (_, i) => cerrada(i, "long", -1)),
      { ...cerrada(99, "long", 0), fwdPct: undefined, resolvedTs: undefined },
    ];
    const r = analyze(study(obs));
    expect(r.resolved).toBe(MIN_OBS);
    expect(r.pending).toBe(1);
  });
});
