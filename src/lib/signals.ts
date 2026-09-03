// ============================================================
// Señales de entrada y su evaluación.
//
// Reglas de honestidad, que son el motivo de que esto exista:
//
//  1. Una señal se REGISTRA en el instante en que nace, con entrada, stop y
//     objetivo ya fijados. Nada se edita después. Sin esto, el historial es
//     una colección de recuerdos favorables.
//  2. El desenlace lo decide una REGLA sobre velas reales, no un criterio.
//  3. Si una vela contiene stop y objetivo a la vez no se sabe cuál se tocó
//     primero: se cuenta como PÉRDIDA y se marca como ambigua. La suposición
//     conservadora evita inflar el resultado.
//  4. Cada señal lleva un CONTROL: una moneda al aire con el mismo stop y el
//     mismo objetivo, en el mismo instante. Sin línea base, un 55 % de acierto
//     no significa nada.
//  5. Se reporta la ESPERANZA en R, no solo el porcentaje de aciertos. Un 70 %
//     de aciertos con pérdidas grandes es un sistema perdedor.
// ============================================================
import type { Candle, Side } from "./types";
import type { Bundle, Trend } from "./indicators";

export type Outcome = "abierta" | "ganada" | "perdida" | "expirada";

/** Qué reglas generaron la señal. Permite comparar estrategias en la bitácora. */
export type Strategy = "consenso" | "contra-ema-rsi";

export const STRATEGY_LABEL: Record<Strategy, string> = {
  consenso: "Consenso ponderado",
  "contra-ema-rsi": "Contra EMA+RSI",
};

/*
  COSTES. Es la parte que decide si una ventaja estadística sirve de algo.

  Una comisión taker de Binance Futuros es 0,05 % por lado. Ida y vuelta son
  0,10 %, más el deslizamiento al entrar y salir a mercado (~0,02 % por lado en
  pares líquidos). Total ~0,14 % del nocional.

  Lo demoledor es convertirlo a R: si el stop está a 0,18 % del precio —un ATR
  típico de 5 m— ese 0,14 % es 0,78R. Casi una operación entera perdida en
  costes. En marcos mayores el stop es mucho más ancho y el coste relativo se
  desploma. Por eso el coste se calcula SIEMPRE contra la distancia al stop, no
  como un porcentaje fijo.
*/
export const ROUND_TRIP_COST_PCT = 0.14;

/** Coste de la operación expresado en múltiplos de R. */
export function costInR(entry: number, stop: number): number {
  const risk = Math.abs(entry - stop);
  if (!(risk > 0) || !(entry > 0)) return NaN;
  return (entry * (ROUND_TRIP_COST_PCT / 100)) / risk;
}

/*
  MEDIDO, NO SUPUESTO.

  Se reconstruyeron las entradas reales del panel sobre 28 días, 6 símbolos y
  tres temporalidades, llamando al mismo `buildSignal` que corre aquí. 1.471
  señales, 409 sucesos independientes.

  El resultado: la señal acierta algo más que el azar —40,4 % contra 38,5 %— y
  en bruto sale positiva (+0,089R). Y aun así pierde 0,422R por operación,
  porque el coste se lleva 0,511R.

  La causa no es la señal, es la aritmética del stop:

    marco   coste por operación   neto
    5m           -0,642R        -0,592R
    15m          -0,323R        -0,195R
    1H           -0,149R        +0,101R  (la moneda al aire hizo +0,211R)

  Un stop de 1,2 ATR en 5 minutos está a ~0,22 % del precio. Una comisión de
  ida y vuelta del 0,14 % es, por tanto, el 64 % del riesgo — antes de que el
  mercado se mueva. Ninguna estrategia de marco corto con stop ajustado puede
  ganar pagando comisión de mercado; no es opinión, es división.

  Por eso el panel enseña el coste en R junto a cada señal.
*/
export type CostVerdict = "asumible" | "alto" | "prohibitivo";

export function costVerdict(costR: number): CostVerdict {
  if (!Number.isFinite(costR)) return "alto";
  if (costR >= 0.35) return "prohibitivo";
  if (costR >= 0.15) return "alto";
  return "asumible";
}

export interface SignalReason {
  label: string;
  detail: string;
  /** aportación a la puntuación, con signo: + alcista, − bajista */
  contribution: number;
}

export interface Signal {
  id: string;
  ts: number;
  symbol: string;
  timeframe: string;
  side: Side;
  entry: number;
  stop: number;
  target: number;
  /** riesgo/beneficio comprometido de antemano */
  rr: number;
  /** 0..1, convicción en el momento de nacer */
  score: number;
  reasons: SignalReason[];
  /** qué reglas la produjeron */
  strategy: Strategy;
  /** control emparejado: misma hora, mismo stop/objetivo, lado al azar */
  controlSide: Side;

  // --- se rellenan al resolverse, nunca antes ---
  outcome: Outcome;
  resolvedTs?: number;
  exitPrice?: number;
  /** resultado BRUTO en múltiplos de R (1R = la distancia al stop) */
  r?: number;
  /** resultado NETO, tras descontar comisiones y deslizamiento */
  rNet?: number;
  /** coste de la operación en R, fijado al nacer */
  costR?: number;
  /** true si la vela contenía stop y objetivo: desenlace no determinable */
  ambiguous?: boolean;
  controlOutcome?: Outcome;
  controlR?: number;
}

// ---------------- generación ----------------

export interface SignalInputs {
  symbol: string;
  timeframe: string;
  price: number;
  atr: number;
  indicators: Bundle;
  /** dirección dominante de las temporalidades mayores */
  confluenceTrend: Trend | null;
  confluenceAgreement: number; // 0..1
  /** nocional liquidado recientemente por lado */
  liqLong: number;
  liqShort: number;
  /** (bids − asks) / total, −1..1 */
  bookImbalance: number;
  fundingPct: number;
  oiDelta1hPct: number;
}

export const MIN_SCORE = 0.42;
const STOP_ATR = 1.2;
const TARGET_ATR = 2.0;

/**
 * Puntuación de −1 (bajista) a +1 (alcista). Cada componente es un dato real
 * de la app; los pesos son una hipótesis explícita, y el historial es quien
 * dictamina si valen algo.
 */
export function scoreSignal(inp: SignalInputs): { score: number; reasons: SignalReason[] } {
  const reasons: SignalReason[] = [];
  const add = (label: string, detail: string, contribution: number) => {
    if (Number.isFinite(contribution) && contribution !== 0) reasons.push({ label, detail, contribution });
  };

  // 1 · consenso técnico del marco activo
  const cons = inp.indicators.consensus;
  const consSign = cons.trend === "alcista" ? 1 : cons.trend === "bajista" ? -1 : 0;
  add("Consenso técnico", `${cons.trend} · ${Math.round(cons.strength * 100)}%`, consSign * cons.strength * 0.30);

  // 2 · confluencia con temporalidades mayores
  if (inp.confluenceTrend && inp.confluenceTrend !== "lateral") {
    const s = inp.confluenceTrend === "alcista" ? 1 : -1;
    add("Confluencia MTF", `${inp.confluenceTrend} · ${Math.round(inp.confluenceAgreement * 100)}% de acuerdo`,
      s * inp.confluenceAgreement * 0.25);
  }

  // 3 · flujo forzado de liquidaciones
  // Hipótesis: liquidar cortos obliga a COMPRAR → presión alcista inmediata.
  const liqTotal = inp.liqLong + inp.liqShort;
  if (liqTotal > 0) {
    const imb = (inp.liqShort - inp.liqLong) / liqTotal; // + = se liquidan cortos
    add("Flujo de liquidaciones", imb > 0 ? "cortos liquidados → compra forzada" : "largos liquidados → venta forzada",
      imb * 0.20);
  }

  // 4 · desequilibrio del libro
  if (Number.isFinite(inp.bookImbalance)) {
    add("Libro de órdenes", inp.bookImbalance >= 0 ? "presión compradora" : "presión vendedora",
      Math.max(-1, Math.min(1, inp.bookImbalance)) * 0.13);
  }

  // 5 · apalancamiento aglomerado, en contra
  // Funding caro con OI subiendo = muchos largos nuevos pagando prima: frágil.
  if (Number.isFinite(inp.fundingPct) && Number.isFinite(inp.oiDelta1hPct)) {
    if (Math.abs(inp.fundingPct) > 0.03 && inp.oiDelta1hPct > 0.4) {
      const s = inp.fundingPct > 0 ? -1 : 1; // contrario al lado aglomerado
      add("Apalancamiento", inp.fundingPct > 0 ? "largos aglomerados y caros" : "cortos aglomerados y caros", s * 0.12);
    }
  }

  const score = Math.max(-1, Math.min(1, reasons.reduce((s, r) => s + r.contribution, 0)));
  return { score, reasons };
}

/** Crea la señal si la puntuación supera el umbral. `rand` inyectable para tests. */
export function buildSignal(inp: SignalInputs, now: number, rand: () => number = Math.random): Signal | null {
  if (!(inp.price > 0) || !(inp.atr > 0)) return null;
  const { score, reasons } = scoreSignal(inp);
  if (Math.abs(score) < MIN_SCORE) return null;

  const side: Side = score > 0 ? "long" : "short";
  const stopDist = inp.atr * STOP_ATR;
  const targetDist = inp.atr * TARGET_ATR;

  return {
    id: `sig-${now}-${Math.floor(rand() * 1e6)}`,
    ts: now,
    symbol: inp.symbol,
    timeframe: inp.timeframe,
    side,
    entry: inp.price,
    stop: side === "long" ? inp.price - stopDist : inp.price + stopDist,
    target: side === "long" ? inp.price + targetDist : inp.price - targetDist,
    rr: targetDist / stopDist,
    score: Math.abs(score),
    reasons: reasons.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)),
    strategy: "consenso",
    controlSide: rand() > 0.5 ? "long" : "short",
    costR: costInR(inp.price, side === "long" ? inp.price - stopDist : inp.price + stopDist),
    outcome: "abierta",
  };
}

/*
  CONTRA EMA+RSI.

  Regla validada aparte, sobre 243.000 velas y tres periodos (2023, 2024 y
  actual): cuando el cruce de EMA y el RSI coinciden en dirección, el precio
  tiende a ir al lado CONTRARIO. Es una sola hipótesis fijada de antemano, así
  que su listón estadístico es el clásico t>2, y lo superó en los tres.

  Lo que aquello NO probó es que gane dinero: medía "¿el precio está más arriba
  12 velas después?", sin stop, sin objetivo y sin comisiones. Esto lo lleva a
  operativa real para que la bitácora dictamine.

  No lleva puntuación ni pesos: o los dos coinciden o no hay señal.
*/
export function buildContraSignal(inp: SignalInputs, now: number, rand: () => number = Math.random): Signal | null {
  if (!(inp.price > 0) || !(inp.atr > 0)) return null;

  const votes = inp.indicators.consensus.votes;
  const ema = votes.find((v) => v.name === "Cruce EMA");
  const rsi = votes.find((v) => v.name === "RSI");
  if (!ema || !rsi) return null;
  if (ema.trend === "lateral" || rsi.trend === "lateral") return null;
  if (ema.trend !== rsi.trend) return null; // hace falta unanimidad

  // el giro: se opera CONTRA lo que ambos señalan
  const side: Side = ema.trend === "alcista" ? "short" : "long";
  const stopDist = inp.atr * STOP_ATR;
  const targetDist = inp.atr * TARGET_ATR;
  const stop = side === "long" ? inp.price - stopDist : inp.price + stopDist;

  return {
    id: `con-${now}-${Math.floor(rand() * 1e6)}`,
    ts: now,
    symbol: inp.symbol,
    timeframe: inp.timeframe,
    side,
    entry: inp.price,
    stop,
    target: side === "long" ? inp.price + targetDist : inp.price - targetDist,
    rr: targetDist / stopDist,
    score: 1, // la regla no gradúa convicción: se cumple o no se cumple
    reasons: [
      {
        label: "Cruce EMA + RSI unánimes",
        detail: `ambos ${ema.trend} → se opera al contrario`,
        contribution: side === "long" ? 1 : -1,
      },
    ],
    strategy: "contra-ema-rsi",
    controlSide: rand() > 0.5 ? "long" : "short",
    costR: costInR(inp.price, stop),
    outcome: "abierta",
  };
}

// ---------------- evaluación ----------------

/** Máximo de velas que una señal permanece viva antes de expirar. */
export const MAX_BARS = 48;

interface Resolution {
  outcome: Outcome;
  exitPrice: number;
  r: number;
  ambiguous: boolean;
  resolvedTs: number;
}

function resolveSide(
  side: Side,
  entry: number,
  stop: number,
  target: number,
  future: Candle[]
): Resolution | null {
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;

  for (let i = 0; i < Math.min(future.length, MAX_BARS); i++) {
    const k = future[i];
    const hitTarget = side === "long" ? k.h >= target : k.l <= target;
    const hitStop = side === "long" ? k.l <= stop : k.h >= stop;

    if (hitTarget && hitStop) {
      // La vela contiene ambos: no se sabe cuál llegó primero. Se asume lo peor.
      return {
        outcome: "perdida",
        exitPrice: stop,
        r: -1,
        ambiguous: true,
        resolvedTs: k.t,
      };
    }
    if (hitTarget) {
      return {
        outcome: "ganada",
        exitPrice: target,
        r: Math.abs(target - entry) / risk,
        ambiguous: false,
        resolvedTs: k.t,
      };
    }
    if (hitStop) {
      return { outcome: "perdida", exitPrice: stop, r: -1, ambiguous: false, resolvedTs: k.t };
    }
  }

  if (future.length >= MAX_BARS) {
    // Expira a mercado: el resultado cuenta igual, no se esconde.
    const last = future[MAX_BARS - 1];
    const move = side === "long" ? last.c - entry : entry - last.c;
    return {
      outcome: "expirada",
      exitPrice: last.c,
      r: move / risk,
      ambiguous: false,
      resolvedTs: last.t,
    };
  }
  return null; // sigue abierta
}

/**
 * Resuelve una señal contra las velas posteriores a su nacimiento. Devuelve la
 * MISMA referencia si sigue abierta, para no provocar renders inútiles.
 */
export function evaluateSignal(sig: Signal, candles: Candle[]): Signal {
  if (sig.outcome !== "abierta") return sig;
  const future = candles.filter((k) => k.t > sig.ts);
  if (!future.length) return sig;

  const main = resolveSide(sig.side, sig.entry, sig.stop, sig.target, future);
  if (!main) return sig;

  // El control usa el MISMO stop y objetivo en distancia, en su propio lado.
  const risk = Math.abs(sig.entry - sig.stop);
  const reward = Math.abs(sig.target - sig.entry);
  const cStop = sig.controlSide === "long" ? sig.entry - risk : sig.entry + risk;
  const cTarget = sig.controlSide === "long" ? sig.entry + reward : sig.entry - reward;
  const ctrl = resolveSide(sig.controlSide, sig.entry, cStop, cTarget, future);

  // El coste se paga SIEMPRE, gane o pierda: es ida y vuelta a mercado.
  const cost = Number.isFinite(sig.costR) ? (sig.costR as number) : costInR(sig.entry, sig.stop);

  return {
    ...sig,
    outcome: main.outcome,
    exitPrice: main.exitPrice,
    r: main.r,
    rNet: Number.isFinite(cost) ? main.r - cost : main.r,
    costR: cost,
    ambiguous: main.ambiguous,
    resolvedTs: main.resolvedTs,
    controlOutcome: ctrl?.outcome,
    controlR: ctrl?.r,
  };
}

// ---------------- estadísticas ----------------

export interface Stats {
  total: number;
  open: number;
  resolved: number;
  wins: number;
  losses: number;
  expired: number;
  ambiguous: number;
  winRate: number;
  /** media de R BRUTA por operación */
  expectancy: number;
  /** media de R NETA, tras comisiones y deslizamiento. Es LA métrica. */
  expectancyNet: number;
  /** coste medio por operación, en R */
  avgCostR: number;
  totalR: number;
  totalRNet: number;
  profitFactor: number;
  maxDrawdownR: number;
  /** misma esperanza, para la moneda al aire */
  controlExpectancy: number;
  controlWinRate: number;
  /** esperanza de la señal menos la del control */
  edge: number;
  /*
    Cuántas desviaciones típicas se aparta la esperanza neta de cero.

    Sin esto, el veredicto se decidía solo con `edge >= 0,15`, y eso es un
    autoengaño garantizado: con 20 operaciones y una dispersión típica de
    ~1,2R el error estándar es 0,27R, así que 0,15R de diferencia es MEDIO
    sigma — algo que el ruido produce sin parar. La bitácora habría cantado
    VENTAJA sobre azar puro, que es justo lo que esta herramienta existe para
    no hacer.

    Se detectó midiendo el propio panel: en el marco diario salió +0,373R
    neto contra +0,157R del control y la app lo declaró VENTAJA, cuando la t
    era 1,21 sobre 38 sucesos.
  */
  tStat: number;
  verdict: "SIN DATOS" | "MUESTRA CORTA" | "SIN VENTAJA" | "PIERDE" | "VENTAJA";
  note: string;
}

const MIN_SAMPLE = 20;

export function computeStats(signals: Signal[]): Stats {
  const resolvedList = signals.filter((s) => s.outcome !== "abierta" && Number.isFinite(s.r));
  const open = signals.length - resolvedList.length;
  const wins = resolvedList.filter((s) => s.outcome === "ganada").length;
  const losses = resolvedList.filter((s) => s.outcome === "perdida").length;
  const expired = resolvedList.filter((s) => s.outcome === "expirada").length;
  const ambiguous = resolvedList.filter((s) => s.ambiguous).length;

  const rs = resolvedList.map((s) => s.r as number);
  const totalR = rs.reduce((a, b) => a + b, 0);
  const expectancy = rs.length ? totalR / rs.length : NaN;

  // Neto. Si una señal antigua no lo trae, se recalcula desde su stop.
  const netOf = (x: Signal): number =>
    Number.isFinite(x.rNet) ? (x.rNet as number) : (x.r as number) - costInR(x.entry, x.stop);
  const netRs = resolvedList.map(netOf).filter(Number.isFinite);
  const totalRNet = netRs.reduce((a, b) => a + b, 0);
  const expectancyNet = netRs.length ? totalRNet / netRs.length : NaN;
  const costs = resolvedList
    .map((x) => (Number.isFinite(x.costR) ? (x.costR as number) : costInR(x.entry, x.stop)))
    .filter(Number.isFinite);
  const avgCostR = costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : NaN;

  const gains = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const drawdownSource = rs.filter((r) => r < 0).reduce((a, b) => a + Math.abs(b), 0);
  const profitFactor = drawdownSource > 0 ? gains / drawdownSource : NaN;

  // peor racha acumulada, en R
  let peak = 0;
  let equity = 0;
  let maxDrawdownR = 0;
  for (const r of rs) {
    equity += r;
    peak = Math.max(peak, equity);
    maxDrawdownR = Math.max(maxDrawdownR, peak - equity);
  }

  const ctrlRs = resolvedList.filter((s) => Number.isFinite(s.controlR)).map((s) => s.controlR as number);
  const controlExpectancy = ctrlRs.length ? ctrlRs.reduce((a, b) => a + b, 0) / ctrlRs.length : NaN;
  const controlWins = resolvedList.filter((s) => s.controlOutcome === "ganada").length;
  const controlWinRate = resolvedList.length ? controlWins / resolvedList.length : NaN;

  const edge = Number.isFinite(expectancy) && Number.isFinite(controlExpectancy)
    ? expectancy - controlExpectancy
    : NaN;

  const sdNet =
    netRs.length > 1
      ? Math.sqrt(netRs.reduce((s, x) => s + (x - expectancyNet) ** 2, 0) / (netRs.length - 1))
      : NaN;
  const tStat = sdNet > 0 ? expectancyNet / (sdNet / Math.sqrt(netRs.length)) : NaN;

  let verdict: Stats["verdict"];
  let note: string;
  if (!resolvedList.length) {
    verdict = "SIN DATOS";
    note = "Todavía no se ha resuelto ninguna señal. El historial empieza vacío a propósito.";
  } else if (resolvedList.length < MIN_SAMPLE) {
    verdict = "MUESTRA CORTA";
    note = `${resolvedList.length} de ${MIN_SAMPLE} señales resueltas. Por debajo de eso cualquier porcentaje es ruido.`;
  } else if (expectancyNet <= -0.1) {
    verdict = "PIERDE";
    note =
      expectancy > 0
        ? `Gana ${expectancy.toFixed(2)}R en bruto pero pierde ${expectancyNet.toFixed(2)}R neto: se lo comen las comisiones (${avgCostR.toFixed(2)}R por operación).`
        : `Esperanza neta ${expectancyNet.toFixed(2)}R por operación: pierde dinero en la muestra.`;
  } else if (Number.isFinite(edge) && edge >= 0.15 && expectancyNet > 0 && tStat > 2) {
    verdict = "VENTAJA";
    note = `Esperanza neta ${expectancyNet.toFixed(2)}R frente a ${controlExpectancy.toFixed(2)}R de la moneda al aire, ya descontado el coste (t=${tStat.toFixed(2)}).`;
  } else if (Number.isFinite(edge) && edge >= 0.15 && expectancyNet > 0) {
    // Va por delante del control, pero la diferencia todavía cabe dentro del ruido.
    verdict = "SIN VENTAJA";
    note = `Va ${expectancyNet.toFixed(2)}R neto contra ${controlExpectancy.toFixed(2)}R del control, pero con t=${Number.isFinite(tStat) ? tStat.toFixed(2) : "—"} eso todavía cabe dentro del azar. Hace falta t>2 y más muestra.`;
  } else {
    verdict = "SIN VENTAJA";
    note = `Esperanza neta ${expectancyNet.toFixed(2)}R vs ${controlExpectancy.toFixed(2)}R del control: la diferencia no distingue estas reglas del azar.`;
  }

  return {
    total: signals.length,
    open,
    resolved: resolvedList.length,
    wins,
    losses,
    expired,
    ambiguous,
    winRate: resolvedList.length ? wins / resolvedList.length : NaN,
    expectancy,
    expectancyNet,
    avgCostR,
    totalR,
    totalRNet,
    profitFactor,
    maxDrawdownR,
    controlExpectancy,
    controlWinRate,
    edge,
    tStat,
    verdict,
    note,
  };
}
