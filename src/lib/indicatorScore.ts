// ============================================================
// Acierto histórico de CADA indicador, por separado.
//
// Responde a: cuando el RSI dice "alcista", ¿sube el precio?
//
// La trampa que este módulo evita: si el precio sube el 55 % de las veces y un
// indicador grita "alcista" casi siempre, acertará ~55 % sin saber nada. Un
// porcentaje de aciertos suelto es, por tanto, inútil.
//
// Por eso cada indicador se compara contra su LÍNEA BASE: la probabilidad de
// que el precio se mueva en la dirección que él predijo, medida en la misma
// muestra. La ventaja es la diferencia. Cero ventaja = no aporta nada, por
// alto que sea su porcentaje.
//
// Sin look-ahead: en cada punto los indicadores se recalculan usando solo las
// velas anteriores.
// ============================================================
import { computeAll, type IndicatorConfig } from "./indicators";
import type { Candle } from "./types";

export interface IndicatorRecord {
  name: string;
  /** veces que se pronunció (excluye "lateral") */
  calls: number;
  hits: number;
  /** llamadas laterales: ni acierta ni falla, pero dice cuánto calla */
  neutrals: number;
  hitRate: number;
  /** acierto esperable sin ninguna habilidad, dado lo que predijo */
  baseline: number;
  /** hitRate − baseline. Es LA cifra... pero no vale sola: mira `sigma`. */
  edge: number;
  /*
    Cuántas desviaciones típicas se aparta la ventaja de cero.

    Sin esto, `edge` engaña de una forma muy concreta: con 100 llamadas el
    error típico de una diferencia de proporciones ronda el 5 %, así que una
    ventaja de 5 puntos —que parece mucho— es UN sigma. Ruido.

    Dos correcciones que no son opcionales aquí:

    1. Las muestras se solapan. Con horizonte 12 y paso 3, cada movimiento se
       cuenta cuatro veces, así que la muestra efectiva es cuatro veces menor
       que el número de llamadas. Ignorarlo dobla el sigma.
    2. Se corona al mejor de cinco indicadores. Elegir el máximo de cinco
       sube el listón: con Bonferroni, α = 0,05/5 ⇒ hacen falta 2,58 sigmas,
       no 1,96.
  */
  sigma: number;
  /** muestra efectiva, ya descontado el solapamiento */
  effectiveN: number;
  /** recorrido medio a favor, en múltiplos de ATR */
  avgMove: number;
  longCalls: number;
  shortCalls: number;
}

export interface ScoreReport {
  records: IndicatorRecord[];
  /** sigmas que hacen falta para coronar al mejor de N indicadores */
  requiredSigma: number;
  samples: number;
  horizon: number;
  /** proporción de veces que el precio subió en el horizonte */
  upRate: number;
  verdict: "SIN DATOS" | "MUESTRA CORTA" | "LISTO";
  note: string;
}

const MIN_SAMPLES = 25;

/**
 * Listón con Bonferroni para elegir el mejor de `k` indicadores, bilateral.
 * Con k=5: α = 0,01 ⇒ 2,58 sigmas.
 */
export function requiredSigma(k: number): number {
  const tabla: Record<number, number> = { 1: 1.96, 2: 2.24, 3: 2.39, 4: 2.5, 5: 2.58, 6: 2.64 };
  return tabla[Math.max(1, Math.round(k))] ?? 3.0;
}

const empty = (verdict: ScoreReport["verdict"], note: string, horizon: number): ScoreReport => ({
  records: [],
  requiredSigma: NaN,
  samples: 0,
  horizon,
  upRate: NaN,
  verdict,
  note,
});

/**
 * Recorre el historial recalculando los indicadores en cada punto y anota, para
 * cada uno, si su dirección acertó `horizon` velas después.
 *
 * `step` controla el coste: recalcular todo en cada vela es O(n²).
 */
export function scoreIndicators(
  candles: Candle[],
  cfg: IndicatorConfig,
  tfMinutes: number,
  opts: { horizon?: number; step?: number; warmup?: number } = {}
): ScoreReport {
  const horizon = opts.horizon ?? 12;
  const step = opts.step ?? 3;
  const warmup = opts.warmup ?? 120;

  if (candles.length < warmup + horizon + 10) {
    return empty(
      "SIN DATOS",
      `Se necesitan al menos ${warmup + horizon + 10} velas; hay ${candles.length}.`,
      horizon
    );
  }

  interface Acc {
    calls: number;
    hits: number;
    neutrals: number;
    longCalls: number;
    shortCalls: number;
    /** suma de la probabilidad base de cada dirección predicha */
    baselineSum: number;
    moveSum: number;
  }
  const acc = new Map<string, Acc>();
  const bump = (name: string): Acc => {
    let a = acc.get(name);
    if (!a) {
      a = { calls: 0, hits: 0, neutrals: 0, longCalls: 0, shortCalls: 0, baselineSum: 0, moveSum: 0 };
      acc.set(name, a);
    }
    return a;
  };

  // Primera pasada: tasa base de subidas en esta muestra y horizonte.
  let ups = 0;
  let totalMoves = 0;
  for (let i = warmup; i + horizon < candles.length; i += step) {
    if (candles[i + horizon].c > candles[i].c) ups += 1;
    totalMoves += 1;
  }
  const upRate = totalMoves ? ups / totalMoves : NaN;
  const downRate = 1 - upRate;

  // Segunda pasada: votos sin look-ahead.
  let samples = 0;
  for (let i = warmup; i + horizon < candles.length; i += step) {
    const prefix = candles.slice(0, i + 1); // SOLO el pasado
    const bundle = computeAll(prefix, cfg, tfMinutes);
    const atrNow = bundle.atr.at(-1) ?? NaN;
    const from = candles[i].c;
    const to = candles[i + horizon].c;
    const move = to - from;
    samples += 1;

    for (const v of bundle.consensus.votes) {
      const a = bump(v.name);
      if (v.trend === "lateral") {
        a.neutrals += 1;
        continue;
      }
      a.calls += 1;
      const bullish = v.trend === "alcista";
      if (bullish) a.longCalls += 1;
      else a.shortCalls += 1;
      // línea base: acertar por azar dependiendo de lo que predijo
      a.baselineSum += bullish ? upRate : downRate;
      const favor = bullish ? move : -move;
      if (favor > 0) a.hits += 1;
      if (Number.isFinite(atrNow) && atrNow > 0) a.moveSum += favor / atrNow;
    }
  }

  // También se puntúa el veredicto combinado, para poder compararlo.
  // Cada movimiento se mide `horizon/step` veces: las ventanas se solapan y
  // esas repeticiones no son datos nuevos.
  const solapamiento = Math.max(1, horizon / step);

  const records: IndicatorRecord[] = [...acc.entries()].map(([name, a]) => {
    const hitRate = a.calls ? a.hits / a.calls : NaN;
    const baseline = a.calls ? a.baselineSum / a.calls : NaN;
    const edge = Number.isFinite(hitRate) && Number.isFinite(baseline) ? hitRate - baseline : NaN;
    const effectiveN = a.calls / solapamiento;
    const se =
      Number.isFinite(baseline) && effectiveN > 1
        ? Math.sqrt((baseline * (1 - baseline)) / effectiveN)
        : NaN;
    return {
      name,
      calls: a.calls,
      hits: a.hits,
      neutrals: a.neutrals,
      hitRate,
      baseline,
      edge,
      sigma: Number.isFinite(edge) && se > 0 ? edge / se : NaN,
      effectiveN,
      avgMove: a.calls ? a.moveSum / a.calls : NaN,
      longCalls: a.longCalls,
      shortCalls: a.shortCalls,
    };
  });

  records.sort((x, y) => (Number.isFinite(y.edge) ? y.edge : -9) - (Number.isFinite(x.edge) ? x.edge : -9));

  const req = requiredSigma(records.length);

  if (samples < MIN_SAMPLES) {
    return {
      records,
      requiredSigma: req,
      samples,
      horizon,
      upRate,
      verdict: "MUESTRA CORTA",
      note: `Solo ${samples} puntos de prueba. Por debajo de ${MIN_SAMPLES} cualquier porcentaje es ruido.`,
    };
  }

  const best = records[0];
  const gana = best && Number.isFinite(best.sigma) && best.sigma > req && best.edge > 0;

  let note: string;
  if (gana) {
    note = `${best.name} supera a su línea base en ${(best.edge * 100).toFixed(1)} puntos, y esta vez la diferencia aguanta la prueba (${best.sigma.toFixed(1)}σ sobre ${req}σ exigidos).`;
  } else if (best && Number.isFinite(best.edge) && best.edge > 0.05) {
    // El caso peligroso: parece un ganador claro y no lo es.
    note = `${best.name} va ${(best.edge * 100).toFixed(1)} puntos por encima de su línea base, pero eso son solo ${Number.isFinite(best.sigma) ? best.sigma.toFixed(1) : "—"}σ y hacen falta ${req} para coronar al mejor de ${records.length}. Con esta muestra, esa ventaja es lo que produce el azar.`;
  } else {
    note = "Ningún indicador supera claramente a su línea base en esta muestra.";
  }

  return {
    records,
    requiredSigma: req,
    samples,
    horizon,
    upRate,
    verdict: "LISTO",
    note,
  };
}
