import { describe, expect, it } from "vitest";
import { MAX_BARS, buildContraSignal, buildSignal, computeStats, costInR, costVerdict, evaluateSignal, scoreSignal, type Signal, type SignalInputs } from "./signals";
import { computeAll, configFor } from "./indicators";
import type { Candle } from "./types";

function candles(closes: number[], startTs = 1_700_000_000_000): Candle[] {
  return closes.map((c, i) => ({
    t: startTs + i * 300_000,
    o: c,
    h: c * 1.002,
    l: c * 0.998,
    c,
    v: 100,
    delta: 0,
  }));
}

const base = candles(Array.from({ length: 200 }, (_, i) => 50_000 + Math.sin(i / 9) * 300));
const ind = computeAll(base, configFor("5m"), 5);

function inputs(over: Partial<SignalInputs> = {}): SignalInputs {
  return {
    symbol: "BTCUSDT",
    timeframe: "5m",
    price: 50_000,
    atr: 100,
    indicators: ind,
    confluenceTrend: null,
    confluenceAgreement: 0,
    liqLong: 0,
    liqShort: 0,
    bookImbalance: 0,
    fundingPct: 0,
    oiDelta1hPct: 0,
    ...over,
  };
}

describe("puntuación", () => {
  it("se mantiene dentro de −1..1 con entradas extremas", () => {
    const s = scoreSignal(inputs({
      confluenceTrend: "alcista", confluenceAgreement: 1,
      liqLong: 0, liqShort: 1e9, bookImbalance: 1, fundingPct: -0.5, oiDelta1hPct: 5,
    }));
    expect(s.score).toBeGreaterThanOrEqual(-1);
    expect(s.score).toBeLessThanOrEqual(1);
  });

  it("las liquidaciones de cortos empujan al alza y las de largos a la baja", () => {
    const up = scoreSignal(inputs({ liqShort: 1_000_000, liqLong: 0 }));
    const down = scoreSignal(inputs({ liqShort: 0, liqLong: 1_000_000 }));
    const upC = up.reasons.find((r) => r.label === "Flujo de liquidaciones")!.contribution;
    const downC = down.reasons.find((r) => r.label === "Flujo de liquidaciones")!.contribution;
    expect(upC).toBeGreaterThan(0);
    expect(downC).toBeLessThan(0);
  });

  it("el apalancamiento aglomerado empuja EN CONTRA del lado saturado", () => {
    const r = scoreSignal(inputs({ fundingPct: 0.06, oiDelta1hPct: 1 }))
      .reasons.find((x) => x.label === "Apalancamiento")!;
    expect(r.contribution).toBeLessThan(0); // largos caros → sesgo bajista
  });

  it("sin ingredientes no inventa dirección", () => {
    const flat = scoreSignal(inputs({ indicators: { ...ind, consensus: { ...ind.consensus, trend: "lateral", strength: 0 } } }));
    expect(Math.abs(flat.score)).toBeLessThan(0.2);
  });
});

describe("creación de señales", () => {
  const strong = inputs({
    confluenceTrend: "alcista", confluenceAgreement: 1,
    liqShort: 1_000_000, bookImbalance: 0.8,
    indicators: { ...ind, consensus: { ...ind.consensus, trend: "alcista", strength: 1 } },
  });

  it("no dispara por debajo del umbral", () => {
    expect(buildSignal(inputs(), Date.now(), () => 0.5)).toBeNull();
  });

  it("fija entrada, stop y objetivo de antemano y son coherentes", () => {
    const s = buildSignal(strong, 1_700_000_000_000, () => 0.5)!;
    expect(s).not.toBeNull();
    expect(s.side).toBe("long");
    expect(s.stop).toBeLessThan(s.entry);
    expect(s.target).toBeGreaterThan(s.entry);
    // riesgo/beneficio comprometido antes de conocer el resultado
    expect(s.rr).toBeCloseTo(2.0 / 1.2, 6);
    expect(s.outcome).toBe("abierta");
  });

  it("un lado corto invierte stop y objetivo", () => {
    const s = buildSignal(inputs({
      confluenceTrend: "bajista", confluenceAgreement: 1,
      liqLong: 1_000_000, bookImbalance: -0.8,
      indicators: { ...ind, consensus: { ...ind.consensus, trend: "bajista", strength: 1 } },
    }), Date.now(), () => 0.5)!;
    expect(s.side).toBe("short");
    expect(s.stop).toBeGreaterThan(s.entry);
    expect(s.target).toBeLessThan(s.entry);
  });

  it("rechaza precio o ATR inválidos", () => {
    expect(buildSignal({ ...strong, price: 0 }, Date.now())).toBeNull();
    expect(buildSignal({ ...strong, atr: NaN }, Date.now())).toBeNull();
  });
});

describe("evaluación contra velas reales", () => {
  const mk = (side: "long" | "short", entry = 100): Signal => ({
    id: "s1", ts: 1000, symbol: "BTCUSDT", timeframe: "5m", side,
    entry, stop: side === "long" ? 98 : 102, target: side === "long" ? 104 : 96,
    rr: 2, score: 0.6, reasons: [], strategy: "consenso", controlSide: "long", outcome: "abierta",
  });

  const bars = (rows: [number, number, number][], from = 2000): Candle[] =>
    rows.map(([h, l, c], i) => ({ t: from + i * 1000, o: c, h, l, c, v: 1, delta: 0 }));

  it("marca ganada cuando toca el objetivo", () => {
    const r = evaluateSignal(mk("long"), bars([[101, 99.5, 100], [105, 100, 104]]));
    expect(r.outcome).toBe("ganada");
    expect(r.r).toBeCloseTo(2, 6); // 4 de recorrido / 2 de riesgo
  });

  it("marca perdida cuando toca el stop", () => {
    const r = evaluateSignal(mk("long"), bars([[101, 97, 98]]));
    expect(r.outcome).toBe("perdida");
    expect(r.r).toBe(-1);
  });

  // Regla clave: si una vela contiene ambos, no se sabe el orden real.
  it("ante ambigüedad asume PÉRDIDA y lo marca", () => {
    const r = evaluateSignal(mk("long"), bars([[105, 97, 100]]));
    expect(r.outcome).toBe("perdida");
    expect(r.ambiguous).toBe(true);
    expect(r.r).toBe(-1);
  });

  it("expira a mercado tras el máximo de velas, sin ocultar el resultado", () => {
    const flat = bars(Array.from({ length: MAX_BARS }, () => [100.5, 99.5, 100] as [number, number, number]));
    const r = evaluateSignal(mk("long"), flat);
    expect(r.outcome).toBe("expirada");
    expect(Number.isFinite(r.r!)).toBe(true);
  });

  it("sigue abierta si no hay velas suficientes", () => {
    const s = mk("long");
    const r = evaluateSignal(s, bars([[101, 99.5, 100]]));
    expect(r.outcome).toBe("abierta");
    expect(r).toBe(s); // misma referencia: no provoca render
  });

  it("ignora velas anteriores al nacimiento de la señal", () => {
    const s = mk("long");
    const pasado: Candle[] = [{ t: 500, o: 100, h: 999, l: 1, c: 100, v: 1, delta: 0 }];
    expect(evaluateSignal(s, pasado).outcome).toBe("abierta");
  });

  it("un corto gana cuando el precio cae al objetivo", () => {
    const r = evaluateSignal(mk("short"), bars([[101, 95, 96]]));
    expect(r.outcome).toBe("ganada");
    expect(r.r).toBeCloseTo(2, 6);
  });

  it("resuelve también el control de la moneda al aire", () => {
    const r = evaluateSignal(mk("long"), bars([[105, 100, 104]]));
    expect(r.controlOutcome).toBeDefined();
    expect(Number.isFinite(r.controlR!)).toBe(true);
  });
});

describe("estadísticas", () => {
  const resolved = (r: number, outcome: Signal["outcome"], controlR = 0): Signal => ({
    id: `x${Math.random()}`, ts: 1, symbol: "BTCUSDT", timeframe: "5m", side: "long",
    entry: 100, stop: 98, target: 104, rr: 2, score: 0.5, reasons: [], strategy: "consenso", controlSide: "long",
    outcome, r, controlR, controlOutcome: controlR > 0 ? "ganada" : "perdida",
  });

  it("sin datos no finge un veredicto", () => {
    expect(computeStats([]).verdict).toBe("SIN DATOS");
  });

  it("exige muestra mínima antes de opinar", () => {
    const few = Array.from({ length: 5 }, () => resolved(2, "ganada"));
    expect(computeStats(few).verdict).toBe("MUESTRA CORTA");
  });

  // Lo que impide que un buen porcentaje de aciertos disimule un sistema malo.
  it("detecta que pierde aunque acierte mucho", () => {
    // 70 % de aciertos, pero las ganancias son 0,2R y las pérdidas 1R
    const sample = [
      ...Array.from({ length: 21 }, () => resolved(0.2, "ganada")),
      ...Array.from({ length: 9 }, () => resolved(-1, "perdida")),
    ];
    const st = computeStats(sample);
    expect(st.winRate).toBeGreaterThan(0.65);
    expect(st.expectancy).toBeLessThan(0);
    expect(st.verdict).toBe("PIERDE");
  });

  it("no declara ventaja si el control lo iguala", () => {
    const sample = Array.from({ length: 30 }, (_, i) =>
      resolved(i % 3 === 0 ? 2 : -1, i % 3 === 0 ? "ganada" : "perdida", i % 3 === 0 ? 2 : -1)
    );
    const st = computeStats(sample);
    expect(st.edge).toBeCloseTo(0, 6);
    expect(st.verdict).not.toBe("VENTAJA");
  });

  it("declara ventaja solo si supera claramente al control", () => {
    // Alternar +2R y −1R deja una media de +0,5R con una dispersión de 1,5R.
    // Con 30 operaciones la t no llega a 2 y NO basta: la muestra tiene que
    // crecer para que la misma ventaja se distinga del ruido.
    const corto = Array.from({ length: 30 }, (_, i) =>
      resolved(i % 2 === 0 ? 2 : -1, i % 2 === 0 ? "ganada" : "perdida", -1)
    );
    const stCorto = computeStats(corto);
    expect(stCorto.expectancy).toBeGreaterThan(stCorto.controlExpectancy);
    expect(stCorto.tStat).toBeLessThan(2);
    expect(stCorto.verdict).toBe("SIN VENTAJA");

    const largo = Array.from({ length: 120 }, (_, i) =>
      resolved(i % 2 === 0 ? 2 : -1, i % 2 === 0 ? "ganada" : "perdida", -1)
    );
    const st = computeStats(largo);
    expect(st.tStat).toBeGreaterThan(2);
    expect(st.verdict).toBe("VENTAJA");
  });

  it("calcula la peor racha acumulada en R", () => {
    const st = computeStats([resolved(1, "ganada"), resolved(-1, "perdida"), resolved(-1, "perdida"), resolved(1, "ganada")]);
    expect(st.maxDrawdownR).toBeCloseTo(2, 6);
  });

  it("cuenta las señales abiertas aparte de las resueltas", () => {
    const open: Signal = { ...resolved(0, "abierta"), r: undefined, outcome: "abierta" };
    const st = computeStats([open, resolved(1, "ganada")]);
    expect(st.open).toBe(1);
    expect(st.resolved).toBe(1);
  });
});

describe("costes", () => {
  // El coste NO es un porcentaje fijo del resultado: se mide contra la
  // distancia al stop. Un stop estrecho multiplica su peso.
  it("un stop estrecho encarece la operación en R", () => {
    const ancho = costInR(100, 90); // stop al 10 %
    const estrecho = costInR(100, 99.8); // stop al 0,2 %
    expect(estrecho).toBeGreaterThan(ancho * 40);
    expect(ancho).toBeLessThan(0.02);
    expect(estrecho).toBeGreaterThan(0.5); // más de media R solo en comisiones
  });

  it("no inventa un coste sin riesgo definido", () => {
    expect(Number.isFinite(costInR(100, 100))).toBe(false);
  });

  it("el neto siempre queda por debajo del bruto", () => {
    const sig: Signal = {
      id: "c1", ts: 1000, symbol: "BTCUSDT", timeframe: "5m", side: "long",
      entry: 100, stop: 98, target: 104, rr: 2, score: 1, reasons: [],
      strategy: "contra-ema-rsi", controlSide: "long", outcome: "abierta",
    };
    const velas: Candle[] = [{ t: 2000, o: 100, h: 105, l: 99, c: 104, v: 1, delta: 0 }];
    const r = evaluateSignal(sig, velas);
    expect(r.outcome).toBe("ganada");
    expect(r.rNet!).toBeLessThan(r.r!);
    expect(r.costR!).toBeGreaterThan(0);
  });

  it("el veredicto juzga el neto, no el bruto", () => {
    // Ganancia bruta mínima que las comisiones convierten en pérdida.
    const apenas = (i: number): Signal => ({
      id: `a${i}`, ts: 1, symbol: "BTCUSDT", timeframe: "5m", side: "long",
      entry: 100, stop: 99.8, target: 100.4, rr: 2, score: 1, reasons: [],
      strategy: "contra-ema-rsi", controlSide: "long", outcome: "ganada",
      r: 0.1, rNet: 0.1 - costInR(100, 99.8), costR: costInR(100, 99.8),
      controlR: 0, controlOutcome: "perdida",
    });
    const st = computeStats(Array.from({ length: 25 }, (_, i) => apenas(i)));
    expect(st.expectancy).toBeGreaterThan(0);
    expect(st.expectancyNet).toBeLessThan(0);
    expect(st.verdict).toBe("PIERDE");
  });
});

describe("contra EMA+RSI", () => {
  const votes = (ema: string, rsi: string) =>
    ({
      consensus: { trend: "lateral", strength: 0, votes: [
        { name: "Cruce EMA", trend: ema, detail: "" },
        { name: "RSI", trend: rsi, detail: "" },
      ] },
    } as unknown as SignalInputs["indicators"]);

  const inp = (ema: string, rsi: string): SignalInputs => ({
    symbol: "BTCUSDT", timeframe: "5m", price: 100, atr: 1, indicators: votes(ema, rsi),
    confluenceTrend: null, confluenceAgreement: 0,
    liqLong: 0, liqShort: 0, bookImbalance: NaN, fundingPct: NaN, oiDelta1hPct: NaN,
  });

  it("opera al CONTRARIO cuando ambos coinciden", () => {
    expect(buildContraSignal(inp("alcista", "alcista"), 1)!.side).toBe("short");
    expect(buildContraSignal(inp("bajista", "bajista"), 1)!.side).toBe("long");
  });

  it("calla si discrepan o si alguno se abstiene", () => {
    expect(buildContraSignal(inp("alcista", "bajista"), 1)).toBeNull();
    expect(buildContraSignal(inp("lateral", "alcista"), 1)).toBeNull();
    expect(buildContraSignal(inp("alcista", "lateral"), 1)).toBeNull();
  });

  it("nace etiquetada y con el coste ya fijado", () => {
    const s = buildContraSignal(inp("alcista", "alcista"), 1)!;
    expect(s.strategy).toBe("contra-ema-rsi");
    expect(s.costR).toBeGreaterThan(0);
  });
});

describe("aviso de coste", () => {
  /*
    Backtest de 28 días sobre el panel real: el coste medio por operación fue
    -0,642R en 5m, -0,323R en 15m y -0,149R en 1H. La señal era ligeramente
    mejor que el azar y aun así perdía. El usuario tiene que VER eso antes de
    entrar, no descubrirlo en la bitácora tres semanas después.
  */
  it("clasifica según cuánto del riesgo se come la comisión", () => {
    expect(costVerdict(0.05)).toBe("asumible");
    expect(costVerdict(0.20)).toBe("alto");
    expect(costVerdict(0.64)).toBe("prohibitivo");
  });

  it("un coste desconocido nunca se presenta como asumible", () => {
    expect(costVerdict(NaN)).toBe("alto");
  });

  it("reproduce el orden real de las temporalidades medidas", () => {
    // ATR típico como fracción del precio, con stop de 1,2 ATR
    const coste = (atrPct: number) => costInR(100, 100 - 1.2 * atrPct);
    const c5 = coste(0.18), c15 = coste(0.32), c1h = coste(0.80);
    expect(c5).toBeGreaterThan(c15);
    expect(c15).toBeGreaterThan(c1h);
    expect(costVerdict(c5)).toBe("prohibitivo");
    expect(costVerdict(c1h)).toBe("asumible");
  });
});

describe("el veredicto exige significación, no solo diferencia", () => {
  /*
    El fallo que esto cierra apareció midiendo el propio panel en marco
    diario: +0,373R neto contra +0,157R del control, y la app lo declaró
    VENTAJA. La t era 1,21 sobre 38 sucesos.

    El umbral era `edge >= 0,15` a secas. Con 20 operaciones y una dispersión
    de ~1,2R, el error estándar es 0,27R: 0,15R es medio sigma, ruido puro.
    La bitácora construida para no autoengañarse se autoengañaba.
  */
  const op = (i: number, r: number, controlR: number): Signal => ({
    id: `v${i}`, ts: i, symbol: "BTCUSDT", timeframe: "1D", side: "long",
    entry: 100, stop: 90, target: 120, rr: 2, score: 0.5, reasons: [],
    strategy: "consenso", controlSide: "long", outcome: r > 0 ? "ganada" : "perdida",
    r, rNet: r - 0.014, costR: 0.014, controlR,
    controlOutcome: controlR > 0 ? "ganada" : "perdida",
  });

  it("una ventaja aparente dentro del ruido NO es ventaja", () => {
    // muy dispersas: la media es positiva pero la t se queda corta
    const sigs = Array.from({ length: 40 }, (_, i) =>
      op(i, i % 2 ? 2.4 : -1.6, i % 3 ? -1 : 2)
    );
    const st = computeStats(sigs);
    expect(st.expectancyNet).toBeGreaterThan(0);
    expect(st.edge).toBeGreaterThan(0.15);
    expect(st.tStat).toBeLessThan(2);
    expect(st.verdict).toBe("SIN VENTAJA");
    expect(st.note).toContain("cabe dentro del azar");
  });

  it("una ventaja consistente sí lo es", () => {
    // misma media, mucha menos dispersión
    const sigs = Array.from({ length: 40 }, (_, i) => op(i, 0.5 + (i % 4) * 0.02, -1));
    const st = computeStats(sigs);
    expect(st.tStat).toBeGreaterThan(2);
    expect(st.verdict).toBe("VENTAJA");
  });

  it("la t se calcula sobre el NETO, no sobre el bruto", () => {
    // gana en bruto y pierde en neto: la t debe salir negativa
    const caros = Array.from({ length: 30 }, (_, i) => {
      const r = 0.1 + (i % 5) * 0.02; // algo de variación: sin ella no hay t
      return { ...op(i, r, 0), rNet: r - 0.6, costR: 0.6 };
    });
    const st = computeStats(caros);
    expect(st.expectancy).toBeGreaterThan(0);
    expect(st.tStat).toBeLessThan(0);
    expect(st.verdict).toBe("PIERDE");
  });

  it("con una sola operación no inventa una t", () => {
    expect(Number.isFinite(computeStats([op(1, 1, 0)]).tStat)).toBe(false);
  });
});
