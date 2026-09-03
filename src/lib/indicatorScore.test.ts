import { describe, expect, it } from "vitest";
import { scoreIndicators } from "./indicatorScore";
import { configFor } from "./indicators";
import type { Candle } from "./types";

function build(closes: number[]): Candle[] {
  return closes.map((c, i) => ({
    t: 1_700_000_000_000 + i * 300_000,
    o: c,
    h: c * 1.002,
    l: c * 0.998,
    c,
    v: 100,
    delta: 0,
  }));
}

function walk(n: number, seed = 11): Candle[] {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let p = 50_000;
  return build(Array.from({ length: n }, () => (p *= 1 + (rand() - 0.5) * 0.008)));
}

const cfg = configFor("5m");

describe("salvaguardas", () => {
  it("exige historial suficiente", () => {
    const r = scoreIndicators(walk(50), cfg, 5);
    expect(r.verdict).toBe("SIN DATOS");
    expect(r.records).toEqual([]);
  });

  it("avisa de muestra corta en vez de opinar", () => {
    const r = scoreIndicators(walk(160), cfg, 5, { warmup: 120, horizon: 12, step: 3 });
    if (r.samples < 25) expect(r.verdict).toBe("MUESTRA CORTA");
  });

  it("nunca devuelve porcentajes fuera de 0..1", () => {
    const r = scoreIndicators(walk(400), cfg, 5);
    for (const x of r.records) {
      for (const v of [x.hitRate, x.baseline]) {
        if (Number.isFinite(v)) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe("contabilidad", () => {
  const r = scoreIndicators(walk(500), cfg, 5);

  it("puntúa los cinco indicadores", () => {
    expect(r.records).toHaveLength(5);
    const names = r.records.map((x) => x.name).sort();
    expect(names).toEqual(["ADX", "Cruce EMA", "MACD", "RSI", "Supertrend"].sort());
  });

  it("llamadas + laterales cuadra con el número de muestras", () => {
    for (const x of r.records) expect(x.calls + x.neutrals).toBe(r.samples);
  });

  it("los aciertos nunca superan las llamadas", () => {
    for (const x of r.records) expect(x.hits).toBeLessThanOrEqual(x.calls);
  });

  it("largos + cortos suma las llamadas direccionales", () => {
    for (const x of r.records) expect(x.longCalls + x.shortCalls).toBe(x.calls);
  });

  it("ordena por ventaja descendente", () => {
    const edges = r.records.map((x) => x.edge).filter(Number.isFinite);
    for (let i = 1; i < edges.length; i++) expect(edges[i - 1]).toBeGreaterThanOrEqual(edges[i]);
  });
});

describe("la línea base hace su trabajo", () => {
  // En una tendencia alcista pura el precio sube casi siempre: un indicador
  // que diga "alcista" acertará ~100 %. Sin línea base parecería genial; con
  // ella, su ventaja debe quedar cerca de cero, porque no aporta nada que no
  // aportara adivinar "sube" a ciegas.
  it("una tendencia perfecta no regala ventaja", () => {
    const subida = build(Array.from({ length: 500 }, (_, i) => 1000 + i * 2));
    const r = scoreIndicators(subida, cfg, 5);
    expect(r.upRate).toBeGreaterThan(0.95);
    for (const x of r.records) {
      if (x.calls > 10 && Number.isFinite(x.edge)) {
        expect(x.edge).toBeLessThan(0.25);
      }
    }
  });

  it("la tasa de subidas se mide sobre la misma muestra", () => {
    const bajada = build(Array.from({ length: 500 }, (_, i) => 5000 - i * 2));
    expect(scoreIndicators(bajada, cfg, 5).upRate).toBeLessThan(0.05);
  });
});

describe("sin look-ahead", () => {
  // Si la evaluación mirase al futuro, cambiar SOLO las velas posteriores al
  // último punto de prueba alteraría el resultado. No debe.
  it("las velas del final no afectan a los votos ya emitidos", () => {
    const base = walk(400);
    const r1 = scoreIndicators(base, cfg, 5, { warmup: 120, horizon: 12, step: 3 });

    // se altera brutalmente la cola, más allá del último punto evaluado
    const tocado = base.slice();
    for (let i = 390; i < tocado.length; i++) {
      tocado[i] = { ...tocado[i], c: 1, h: 1.1, l: 0.9 };
    }
    const r2 = scoreIndicators(tocado, cfg, 5, { warmup: 120, horizon: 12, step: 3 });

    // el número de llamadas de cada indicador no puede cambiar por el futuro
    const calls1 = r1.records.map((x) => `${x.name}:${x.calls}`).sort();
    const calls2 = r2.records.map((x) => `${x.name}:${x.calls}`).sort();
    expect(calls2).toEqual(calls1);
  });

  it("es determinista", () => {
    const c = walk(400);
    expect(scoreIndicators(c, cfg, 5)).toEqual(scoreIndicators(c, cfg, 5));
  });
});
