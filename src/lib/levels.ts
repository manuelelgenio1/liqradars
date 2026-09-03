// ============================================================
// Niveles de operación: dónde entrar, dónde poner el stop, dónde salir.
//
// Todo sale del ATR real de esa temporalidad, no de porcentajes inventados.
// El ATR mide cuánto se mueve ese par en ese marco, así que un stop en ATR se
// adapta solo: ancho cuando el mercado está agitado, estrecho cuando está
// dormido. Un stop del "1 %" fijo es un stop equivocado casi siempre.
//
// LO QUE ESTA HERRAMIENTA NO HACE, dicho aquí para que no se olvide al leer
// el código: no promete que la dirección acierte. Se midió el panel de
// señales sobre 28 días y 409 sucesos independientes y perdía 0,42R por
// operación; en 180 días y marcos anchos, 4H igualaba EXACTAMENTE a una
// moneda al aire (−0,049R los dos). Lo que sí aporta esto son los NIVELES y
// el COSTE, que son objetivos y verificables.
//
// El coste manda más de lo que parece. Con stop de 1,2 ATR:
//   5m   → la comisión se lleva ~64 % del riesgo
//   30m  → ~35 %
//   1H   → ~15 %
//   4H   → ~7 %
//   1D   → ~2 %
// Por eso cada fila trae su veredicto de coste: en 5 m hay que acertar
// muchísimo solo para empatar.
// ============================================================
import { computeAll, configFor, type Bundle, type Trend } from "./indicators";
import { costInR, costVerdict, type CostVerdict } from "./signals";
import type { Candle, Side } from "./types";

/** Múltiplos de ATR. Los mismos que usa `buildSignal`, para que no divergan. */
export const STOP_ATR = 1.2;
export const TARGET_ATR = 2.0;

export interface TradeLevels {
  timeframe: string;
  label: string;
  /** dirección del consenso técnico de ese marco */
  trend: Trend;
  /** cuánta fuerza tiene ese consenso, 0..1 */
  strength: number;
  /** lado a operar, o null si el marco está lateral */
  side: Side | null;

  price: number;
  atr: number;
  /** ATR como % del precio: dice de un vistazo lo agitado que está */
  atrPct: number;

  entry: number;
  stop: number;
  target: number;
  /** distancia al stop en % del precio */
  stopPct: number;
  rr: number;

  /** comisión de ida y vuelta en múltiplos de R */
  costR: number;
  costVerdict: CostVerdict;

  /** cuántas velas se necesitan y cuántas hay */
  candles: number;
  ready: boolean;
  /** votos individuales, para poder mirar por qué dice lo que dice */
  votes: Bundle["consensus"]["votes"];
}

const vacio = (timeframe: string, label: string, candles: number): TradeLevels => ({
  timeframe,
  label,
  trend: "lateral",
  strength: 0,
  side: null,
  price: NaN,
  atr: NaN,
  atrPct: NaN,
  entry: NaN,
  stop: NaN,
  target: NaN,
  stopPct: NaN,
  rr: NaN,
  costR: NaN,
  costVerdict: "alto",
  candles,
  ready: false,
  votes: [],
});

/** Velas mínimas para que los indicadores de ese marco estén calientes. */
export const MIN_CANDLES = 120;

/**
 * Calcula los niveles de un marco. `candles` deben venir CERRADAS salvo la
 * última, igual que las usa el resto de la app.
 */
export function computeLevels(
  timeframe: string,
  label: string,
  candles: Candle[],
  tfMinutes: number,
  livePrice?: number
): TradeLevels {
  if (candles.length < MIN_CANDLES) return vacio(timeframe, label, candles.length);

  const bundle = computeAll(candles, configFor(timeframe), tfMinutes);
  const atr = bundle.atr.at(-1) ?? NaN;
  const price = Number.isFinite(livePrice) && (livePrice as number) > 0
    ? (livePrice as number)
    : (candles.at(-1)?.c ?? NaN);

  if (!(atr > 0) || !(price > 0)) return vacio(timeframe, label, candles.length);

  const cons = bundle.consensus;
  const side: Side | null = cons.trend === "alcista" ? "long" : cons.trend === "bajista" ? "short" : null;

  const stopDist = atr * STOP_ATR;
  const targetDist = atr * TARGET_ATR;

  // Cuando el marco está lateral no hay lado, pero los niveles siguen siendo
  // informativos: se calculan como si fuera largo y se marca `side: null`.
  const lado: Side = side ?? "long";
  const stop = lado === "long" ? price - stopDist : price + stopDist;
  const target = lado === "long" ? price + targetDist : price - targetDist;
  const cR = costInR(price, stop);

  return {
    timeframe,
    label,
    trend: cons.trend,
    strength: cons.strength,
    side,
    price,
    atr,
    atrPct: (atr / price) * 100,
    entry: price,
    stop,
    target,
    stopPct: (stopDist / price) * 100,
    rr: targetDist / stopDist,
    costR: cR,
    costVerdict: costVerdict(cR),
    candles: candles.length,
    ready: true,
    votes: cons.votes,
  };
}

// ---------------- lectura conjunta ----------------

export interface Alignment {
  /** dirección dominante entre los marcos que se pronuncian */
  dominant: Trend | null;
  /** cuántos marcos coinciden con la dominante */
  agree: number;
  /** cuántos se pronuncian (excluye laterales) */
  total: number;
  /** marcos que van en contra */
  against: string[];
  /** el marco más barato de operar entre los que coinciden */
  cheapest: TradeLevels | null;
}

/**
 * Resume las seis temporalidades en una sola lectura.
 *
 * Lo que se busca al operar varios marcos no es que todos coincidan —eso pasa
 * poco— sino saber CONTRA qué se está operando. Entrar largo en 5 m con el
 * diario bajista es una operación distinta, y peor, que la misma entrada con
 * el diario a favor.
 */
export function alignment(rows: TradeLevels[]): Alignment {
  const listos = rows.filter((r) => r.ready && r.side);
  if (!listos.length) return { dominant: null, agree: 0, total: 0, against: [], cheapest: null };

  const ups = listos.filter((r) => r.side === "long").length;
  const downs = listos.length - ups;
  if (ups === downs) {
    return { dominant: null, agree: 0, total: listos.length, against: [], cheapest: null };
  }

  const dominant: Trend = ups > downs ? "alcista" : "bajista";
  const ladoDom: Side = ups > downs ? "long" : "short";
  const aFavor = listos.filter((r) => r.side === ladoDom);

  return {
    dominant,
    agree: aFavor.length,
    total: listos.length,
    against: listos.filter((r) => r.side !== ladoDom).map((r) => r.label),
    // El más barato de los que van a favor: es donde la comisión estorba menos.
    cheapest: aFavor.reduce<TradeLevels | null>(
      (best, r) => (!best || r.costR < best.costR ? r : best),
      null
    ),
  };
}
