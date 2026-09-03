// ============================================================
// Búsqueda de combinaciones de indicadores.
//
// El peligro que este módulo existe para evitar: probar muchas combinaciones
// sobre los mismos datos GARANTIZA encontrar alguna que parezca buena. Con 31
// combinaciones y puro azar, la mejor sacará varios puntos de ventaja aunque
// ninguna sirva. Eso no es descubrir una estrategia; es medir ruido y quedarse
// con el que más gusta.
//
// Defensa, en tres capas:
//
//  1. PARTICIÓN. Se busca en el primer 65 % de la historia y se valida en el
//     35 % final, que la búsqueda nunca ve. Una combinación solo cuenta si
//     aguanta fuera de muestra.
//  2. CAÍDA. Se reporta la diferencia entre lo que sacó buscando y lo que saca
//     validando. Una caída grande delata que era casualidad.
//  3. RECUENTO. Se dice cuántas combinaciones se probaron, para que el lector
//     descuente las comparaciones múltiples.
//
// Sin look-ahead: los votos de cada punto se calculan solo con velas previas.
// ============================================================
import { computeAll, type IndicatorConfig, type Trend } from "./indicators";
import type { Candle } from "./types";

export const INDICATOR_NAMES = ["Cruce EMA", "MACD", "RSI", "Supertrend", "ADX"] as const;
export type IndicatorName = (typeof INDICATOR_NAMES)[number];

/** Un punto de prueba: qué votó cada indicador y qué hizo el precio después. */
interface Sample {
  votes: Map<string, { trend: Trend; strength: number }>;
  /** movimiento posterior, con signo */
  move: number;
  /** movimiento en múltiplos de ATR, para comparar entre regímenes */
  moveAtr: number;
}

export interface Combo {
  /** indicadores incluidos */
  members: IndicatorName[];
  /** exige que TODOS los incluidos coincidan, en vez de ponderar */
  unanimous: boolean;
  /** invierte la dirección resultante */
  inverted: boolean;
}

export interface ComboResult {
  combo: Combo;
  label: string;
  trainCalls: number;
  trainEdge: number;
  testCalls: number;
  testEdge: number;
  /** trainEdge − testEdge: cuánto se desinfló al salir de la muestra */
  decay: number;
  testAvgAtr: number;
  /** cuántos errores estándar separa la ventaja del cero */
  sigmas: number;
  /** umbral de sigmas exigido tras corregir por comparaciones múltiples */
  requiredSigmas: number;
  significant: boolean;
}

export interface SearchReport {
  results: ComboResult[];
  tried: number;
  trainSamples: number;
  testSamples: number;
  trainUpRate: number;
  testUpRate: number;
  /** la mejor que además AGUANTA fuera de muestra */
  survivor: ComboResult | null;
  verdict: "SIN DATOS" | "NADA AGUANTA" | "CANDIDATA";
  note: string;
}

/*
  Umbrales. El de llamadas subió de 15 a 30 porque con 15 el error estándar de
  una proporción ronda los 13 puntos: una "ventaja" de 20 puntos ni siquiera
  llega a dos sigmas.
*/
const MIN_CALLS = 30;

/**
 * Sigmas exigidos tras corregir por comparaciones múltiples (Bonferroni).
 *
 * Este es el corazón del asunto. Al probar N combinaciones y quedarse con la
 * mejor, el máximo esperable POR AZAR crece con N: con 114 pruebas ronda los
 * 2,7 sigmas. Sin corregir, cualquier búsqueda amplia "encuentra" algo.
 *
 * Se exige entonces p < 0,05/N, que para 114 combinaciones son ~3,5 sigmas.
 * Aproximación de la inversa normal por el método de Beasley-Springer-Moro
 * simplificado: basta con la cola.
 */
function requiredSigmasFor(trials: number): number {
  const alpha = 0.05 / Math.max(1, trials);
  // inversa aproximada de la normal estándar para la cola de dos lados
  const p = 1 - alpha / 2;
  const t = Math.sqrt(-2 * Math.log(1 - p));
  return t - (2.30753 + 0.27061 * t) / (1 + 0.99229 * t + 0.04481 * t * t);
}

/**
 * Prefijo máximo que se pasa a los indicadores en cada punto.
 *
 * Antes se usaba TODO el pasado (`slice(0, i+1)`), lo que hace la recogida
 * O(n²): con 81 000 velas eran ~675 millones de operaciones y el navegador se
 * quedaba bloqueado 69 segundos. Las medias exponenciales, el RSI y el ATR
 * convergen mucho antes de 300 velas, así que acotar el prefijo deja los
 * valores prácticamente idénticos y convierte el coste en lineal.
 */
const MAX_PREFIX = 400;

function collect(
  candles: Candle[],
  cfg: IndicatorConfig,
  tfMinutes: number,
  horizon: number,
  step: number,
  warmup: number
): Sample[] {
  const out: Sample[] = [];
  for (let i = warmup; i + horizon < candles.length; i += step) {
    const from = Math.max(0, i + 1 - MAX_PREFIX);
    const bundle = computeAll(candles.slice(from, i + 1), cfg, tfMinutes);
    const atrNow = bundle.atr.at(-1) ?? NaN;
    const move = candles[i + horizon].c - candles[i].c;
    const votes = new Map<string, { trend: Trend; strength: number }>();
    for (const v of bundle.consensus.votes) votes.set(v.name, { trend: v.trend, strength: v.strength });
    out.push({
      votes,
      move,
      moveAtr: Number.isFinite(atrNow) && atrNow > 0 ? move / atrNow : NaN,
    });
  }
  return out;
}

/** Dirección que produce una combinación en un punto dado. */
function decide(sample: Sample, combo: Combo): Trend {
  const dirs: number[] = [];
  for (const name of combo.members) {
    const v = sample.votes.get(name);
    if (!v || v.trend === "lateral") {
      if (combo.unanimous) return "lateral"; // uno se abstiene → no hay unanimidad
      continue;
    }
    dirs.push(v.trend === "alcista" ? 1 : -1);
  }
  if (!dirs.length) return "lateral";
  if (combo.unanimous) {
    const first = dirs[0];
    if (!dirs.every((d) => d === first)) return "lateral";
    const t: Trend = first > 0 ? "alcista" : "bajista";
    return combo.inverted ? (t === "alcista" ? "bajista" : "alcista") : t;
  }
  const sum = dirs.reduce((a, b) => a + b, 0);
  if (sum === 0) return "lateral";
  const t: Trend = sum > 0 ? "alcista" : "bajista";
  return combo.inverted ? (t === "alcista" ? "bajista" : "alcista") : t;
}

function evaluate(samples: Sample[], combo: Combo, upRate: number) {
  let calls = 0;
  let hits = 0;
  let baselineSum = 0;
  let atrSum = 0;
  for (const s of samples) {
    const d = decide(s, combo);
    if (d === "lateral") continue;
    calls += 1;
    const bullish = d === "alcista";
    baselineSum += bullish ? upRate : 1 - upRate;
    const favor = bullish ? s.move : -s.move;
    if (favor > 0) hits += 1;
    if (Number.isFinite(s.moveAtr)) atrSum += bullish ? s.moveAtr : -s.moveAtr;
  }
  const hitRate = calls ? hits / calls : NaN;
  const baseline = calls ? baselineSum / calls : NaN;
  return {
    calls,
    edge: Number.isFinite(hitRate) && Number.isFinite(baseline) ? hitRate - baseline : NaN,
    avgAtr: calls ? atrSum / calls : NaN,
  };
}

function label(c: Combo): string {
  const short: Record<string, string> = {
    "Cruce EMA": "EMA",
    MACD: "MACD",
    RSI: "RSI",
    Supertrend: "ST",
    ADX: "ADX",
  };
  const names = c.members.map((m) => short[m] ?? m).join("+");
  return `${c.inverted ? "¬" : ""}${names}${c.unanimous ? " (unánime)" : ""}`;
}

/** Todos los subconjuntos no vacíos, con sus variantes unánime e invertida. */
function buildCombos(): Combo[] {
  const out: Combo[] = [];
  const n = INDICATOR_NAMES.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    const members = INDICATOR_NAMES.filter((_, i) => mask & (1 << i));
    out.push({ members, unanimous: false, inverted: false });
    out.push({ members, unanimous: false, inverted: true });
    if (members.length > 1) {
      out.push({ members, unanimous: true, inverted: false });
      out.push({ members, unanimous: true, inverted: true });
    }
  }
  return out;
}

export interface ConfirmResult {
  label: string;
  perSeries: { label: string; edge: number; calls: number }[];
  meanEdge: number;
  stdDev: number;
  tStat: number;
  positives: number;
  negatives: number;
  totalCalls: number;
  /** Sin búsqueda no hay comparaciones múltiples: basta el umbral clásico. */
  passes: boolean;
  note: string;
}

/**
 * Prueba CONFIRMATORIA de una única combinación fijada de antemano.
 *
 * Es distinta de `searchPooled` en lo esencial: aquí no se busca nada. Al
 * probar una sola hipótesis no hay comparaciones múltiples que corregir, así
 * que el listón vuelve a ser el clásico (~2 sigmas) en vez de 3,5.
 *
 * Cada serie aporta UNA observación, no cientos: es lo que respeta que los
 * símbolos cripto se mueven juntos y sus llamadas no son independientes.
 */
export function confirmCombo(
  series: Series[],
  combo: Combo,
  opts: { horizon?: number; step?: number; warmup?: number } = {}
): ConfirmResult {
  const horizon = opts.horizon ?? 12;
  const step = opts.step ?? 4;
  const warmup = opts.warmup ?? 120;

  const perSeries: { label: string; edge: number; calls: number }[] = [];
  let totalCalls = 0;

  for (const s of series) {
    if (s.candles.length < warmup + horizon + 40) continue;
    const samples = collect(s.candles, s.cfg, s.tfMinutes, horizon, step, warmup);
    if (samples.length < 30) continue;
    const upRate = samples.filter((x) => x.move > 0).length / samples.length;
    const r = evaluate(samples, combo, upRate);
    if (!Number.isFinite(r.edge) || r.calls < 20) continue;
    perSeries.push({ label: s.label, edge: r.edge, calls: r.calls });
    totalCalls += r.calls;
  }

  const n = perSeries.length;
  if (n < 3) {
    return {
      label: label(combo), perSeries, meanEdge: NaN, stdDev: NaN, tStat: NaN,
      positives: 0, negatives: 0, totalCalls, passes: false,
      note: `Solo ${n} series con datos suficientes: insuficiente para confirmar nada.`,
    };
  }

  const edges = perSeries.map((x) => x.edge);
  const meanEdge = edges.reduce((a, b) => a + b, 0) / n;
  const stdDev = Math.sqrt(edges.reduce((a, b) => a + (b - meanEdge) ** 2, 0) / (n - 1));
  const se = stdDev / Math.sqrt(n);
  const tStat = se > 0 ? meanEdge / se : NaN;
  const positives = edges.filter((x) => x > 0).length;
  const passes = Number.isFinite(tStat) && tStat > 2 && meanEdge > 0;

  return {
    label: label(combo), perSeries, meanEdge, stdDev, tStat,
    positives, negatives: n - positives, totalCalls, passes,
    note: passes
      ? `Se confirma: ${(meanEdge * 100).toFixed(2)} pts de media, t=${tStat.toFixed(2)} sobre ${n} series, positiva en ${positives} de ${n}.`
      : `NO se confirma: ${(meanEdge * 100).toFixed(2)} pts de media, t=${tStat.toFixed(2)} sobre ${n} series. La ventaja del periodo anterior no reaparece.`,
  };
}

export interface Series {
  label: string;
  candles: Candle[];
  cfg: IndicatorConfig;
  tfMinutes: number;
}

/**
 * Búsqueda sobre VARIAS series a la vez (distintos símbolos o temporalidades).
 *
 * La partición train/test se hace DENTRO de cada serie por separado, nunca
 * sobre el montón agrupado: mezclarlas dejaría que el pasado de un símbolo
 * validara el futuro de otro, que es look-ahead disfrazado.
 *
 * Agrupar multiplica el número de llamadas, que es justo lo que faltaba: con
 * 30 llamadas ninguna ventaja real se distingue del ruido.
 */
export function searchPooled(
  series: Series[],
  opts: { horizon?: number; step?: number; warmup?: number; trainFrac?: number } = {}
): SearchReport {
  const horizon = opts.horizon ?? 12;
  const step = opts.step ?? 3;
  const warmup = opts.warmup ?? 120;
  const trainFrac = opts.trainFrac ?? 0.65;

  const train: Sample[] = [];
  const test: Sample[] = [];
  for (const s of series) {
    if (s.candles.length < warmup + horizon + 80) continue;
    const all = collect(s.candles, s.cfg, s.tfMinutes, horizon, step, warmup);
    if (all.length < 40) continue;
    const cut = Math.floor(all.length * trainFrac);
    train.push(...all.slice(0, cut));   // pasado de ESTA serie
    test.push(...all.slice(cut));        // futuro de ESTA serie
  }

  if (!train.length || !test.length) {
    return {
      results: [], tried: 0, trainSamples: 0, testSamples: 0,
      trainUpRate: NaN, testUpRate: NaN, survivor: null,
      verdict: "SIN DATOS",
      note: "Ninguna serie tenía historial suficiente.",
    };
  }
  return finish(train, test);
}

export function searchCombos(
  candles: Candle[],
  cfg: IndicatorConfig,
  tfMinutes: number,
  opts: { horizon?: number; step?: number; warmup?: number; trainFrac?: number } = {}
): SearchReport {
  const horizon = opts.horizon ?? 12;
  const step = opts.step ?? 3;
  const warmup = opts.warmup ?? 120;
  const trainFrac = opts.trainFrac ?? 0.65;

  const empty = (note: string): SearchReport => ({
    results: [],
    tried: 0,
    trainSamples: 0,
    testSamples: 0,
    trainUpRate: NaN,
    testUpRate: NaN,
    survivor: null,
    verdict: "SIN DATOS",
    note,
  });

  if (candles.length < warmup + horizon + 80) {
    return empty(`Se necesitan al menos ${warmup + horizon + 80} velas; hay ${candles.length}.`);
  }

  const all = collect(candles, cfg, tfMinutes, horizon, step, warmup);
  if (all.length < 40) return empty(`Solo ${all.length} puntos de prueba: insuficiente para partir en dos.`);

  const cut = Math.floor(all.length * trainFrac);
  return finish(all.slice(0, cut), all.slice(cut));
}

/** Evalúa todas las combinaciones sobre una partición ya hecha. */
function finish(train: Sample[], test: Sample[]): SearchReport {
  const rate = (s: Sample[]) => s.filter((x) => x.move > 0).length / (s.length || 1);
  const trainUpRate = rate(train);
  const testUpRate = rate(test);

  const combos = buildCombos();
  const results: ComboResult[] = [];
  for (const combo of combos) {
    const tr = evaluate(train, combo, trainUpRate);
    if (tr.calls < MIN_CALLS || !Number.isFinite(tr.edge)) continue;
    const te = evaluate(test, combo, testUpRate);
    // error estándar conservador de una proporción (p=0,5, el peor caso)
    const se = te.calls > 0 ? Math.sqrt(0.25 / te.calls) : NaN;
    const sigmas = Number.isFinite(te.edge) && Number.isFinite(se) && se > 0 ? te.edge / se : NaN;
    results.push({
      combo,
      label: label(combo),
      trainCalls: tr.calls,
      trainEdge: tr.edge,
      testCalls: te.calls,
      testEdge: te.edge,
      decay: Number.isFinite(te.edge) ? tr.edge - te.edge : NaN,
      testAvgAtr: te.avgAtr,
      sigmas,
      requiredSigmas: NaN, // se rellena abajo, cuando se sabe cuántas se probaron
      significant: false,
    });
  }

  // Se ordena por lo que sacó BUSCANDO — así se ve luego cuánto se desinfla.
  results.sort((a, b) => b.trainEdge - a.trainEdge);

  // Ahora que se sabe cuántas combinaciones entraron en la búsqueda, se fija el
  // listón: cuantas más se prueban, más alto tiene que estar.
  const required = requiredSigmasFor(results.length);
  for (const r of results) {
    r.requiredSigmas = required;
    r.significant =
      Number.isFinite(r.sigmas) && r.sigmas >= required && r.testCalls >= MIN_CALLS && r.testEdge > 0;
  }

  // Superviviente: aguanta fuera de muestra Y supera el listón corregido.
  const survivor = results.find((r) => r.significant && r.trainEdge > 0) ?? null;

  return {
    results: results.slice(0, 12),
    tried: results.length,
    trainSamples: train.length,
    testSamples: test.length,
    trainUpRate,
    testUpRate,
    survivor,
    verdict: survivor ? "CANDIDATA" : "NADA AGUANTA",
    note: survivor
      ? `«${survivor.label}» mantiene ${(survivor.testEdge * 100).toFixed(1)} pts en datos que nunca vio, con ${survivor.sigmas.toFixed(2)}σ sobre el listón de ${required.toFixed(2)}σ exigido por haber probado ${results.length} combinaciones. Sigue siendo una candidata, no una certeza: confírmala en otro periodo antes de fiarte.`
      : `Ninguna de las ${results.length} combinaciones supera el listón. Con tantas pruebas, el azar produce hasta ${required.toFixed(2)}σ por sí solo, así que se exige más que eso — y nada llega.`,
  };
}
