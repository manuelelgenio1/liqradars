// ============================================================
// El libro de cuentas de la mesa.
//
// La mesa emite señales, así que la mesa rinde cuentas de ellas. Hasta ahora
// caducaban y no quedaba rastro: enseñar señales sin llevar la cuenta de si
// aciertan es exactamente lo que hace el resto del sector.
//
// REGLAS, las mismas que rigen la bitácora de consenso:
//
//  1. La señal se registró al NACER, con entrada, stop y objetivo fijados.
//     Nada se edita después.
//  2. El desenlace lo decide una REGLA sobre velas reales, no un criterio.
//  3. Si una vela contiene stop y objetivo a la vez no se sabe cuál se tocó
//     primero: cuenta como PÉRDIDA y se marca ambigua. La suposición
//     conservadora evita inflar el resultado.
//  4. Cada señal arrastra su CONTROL: la moneda al aire que se lanzó en el
//     mismo instante, con los mismos niveles.
//  5. Se reporta la esperanza NETA en R. El porcentaje de aciertos se enseña
//     al lado precisamente para que se vea cuando divergen — que es lo que
//     pasa casi siempre en este proyecto.
//
// POR QUÉ SE DESGLOSA POR TEMPORALIDAD. Porque el coste no es el mismo: en
// 5 m la comisión se lleva medio R y en diario dos centésimas. Juntarlo todo
// en una cifra escondería justo lo que más decide.
// ============================================================
import type { Candle, Side } from "./types";
import { costInR, MAX_BARS, ROUND_TRIP_COST_PCT } from "./signals";
import type { DeskSignal } from "./desksignals";
import * as storage from "./storage";

const LS_KEY = "liqradar:deskledger:v1";
const MAX_ENTRIES = 500;

export type Outcome = "ganada" | "perdida" | "expirada";

export interface LedgerEntry {
  id: string;
  symbol: string;
  timeframe: string;
  side: Side;
  bornAt: number;
  resolvedAt: number;
  entry: number;
  stop: number;
  target: number;
  outcome: Outcome;
  /** resultado BRUTO en múltiplos de R */
  r: number;
  /** neto, tras comisión de ida y vuelta */
  rNet: number;
  costR: number;
  /** la vela contenía stop y objetivo: no se sabe cuál primero */
  ambiguous: boolean;
  controlSide: Side;
  controlR: number | null;
}

interface Resolution {
  outcome: Outcome;
  r: number;
  ambiguous: boolean;
  resolvedAt: number;
}

/**
 * Resuelve un lado contra las velas posteriores. Devuelve null si sigue vivo.
 *
 * `future` deben ser velas POSTERIORES al nacimiento: quien llama las filtra.
 */
function resolveSide(
  side: Side,
  entry: number,
  stop: number,
  target: number,
  future: Candle[],
  maxBars: number
): Resolution | null {
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;

  for (let i = 0; i < Math.min(future.length, maxBars); i++) {
    const k = future[i];
    const tocaObjetivo = side === "long" ? k.h >= target : k.l <= target;
    const tocaStop = side === "long" ? k.l <= stop : k.h >= stop;

    if (tocaObjetivo && tocaStop) {
      return { outcome: "perdida", r: -1, ambiguous: true, resolvedAt: k.t };
    }
    if (tocaObjetivo) {
      return { outcome: "ganada", r: Math.abs(target - entry) / risk, ambiguous: false, resolvedAt: k.t };
    }
    if (tocaStop) {
      return { outcome: "perdida", r: -1, ambiguous: false, resolvedAt: k.t };
    }
  }

  if (future.length >= maxBars) {
    // Expira a mercado: cuenta igual, no se esconde.
    const last = future[maxBars - 1];
    const mov = side === "long" ? last.c - entry : entry - last.c;
    return { outcome: "expirada", r: mov / risk, ambiguous: false, resolvedAt: last.t };
  }
  return null;
}

/** Cierra una señal si sus velas ya la resolvieron. */
export function resolve(sig: DeskSignal, candles: Candle[]): LedgerEntry | null {
  const future = candles.filter((k) => k.t > sig.bornAt);
  if (!future.length) return null;

  const main = resolveSide(sig.side, sig.entry, sig.stop, sig.target, future, MAX_BARS);
  if (!main) return null;

  // El control usa las MISMAS distancias, en su propio lado.
  const risk = Math.abs(sig.entry - sig.stop);
  const reward = Math.abs(sig.target - sig.entry);
  const cStop = sig.controlSide === "long" ? sig.entry - risk : sig.entry + risk;
  const cTarget = sig.controlSide === "long" ? sig.entry + reward : sig.entry - reward;
  const ctrl = resolveSide(sig.controlSide, sig.entry, cStop, cTarget, future, MAX_BARS);

  const cost = costInR(sig.entry, sig.stop);
  return {
    id: sig.id,
    symbol: sig.symbol,
    timeframe: sig.timeframe,
    side: sig.side,
    bornAt: sig.bornAt,
    resolvedAt: main.resolvedAt,
    entry: sig.entry,
    stop: sig.stop,
    target: sig.target,
    outcome: main.outcome,
    r: main.r,
    rNet: Number.isFinite(cost) ? main.r - cost : main.r,
    costR: cost,
    ambiguous: main.ambiguous,
    controlSide: sig.controlSide,
    controlR: ctrl ? ctrl.r : null,
  };
}

// ---------------- persistencia ----------------

export function load(): LedgerEntry[] {
  const raw = storage.read<LedgerEntry[]>(LS_KEY, []);
  return Array.isArray(raw)
    ? raw.filter((e) => e && typeof e.id === "string" && Number.isFinite(e.r))
    : [];
}

export function save(entries: LedgerEntry[]): void {
  storage.write(LS_KEY, entries.slice(0, MAX_ENTRIES));
}

/** Añade sin duplicar. Devuelve la MISMA referencia si no hay nada nuevo. */
export function append(prev: LedgerEntry[], nuevas: LedgerEntry[]): LedgerEntry[] {
  const vistos = new Set(prev.map((e) => e.id));
  const frescas = nuevas.filter((e) => !vistos.has(e.id));
  if (!frescas.length) return prev;
  return [...frescas, ...prev].sort((a, b) => b.resolvedAt - a.resolvedAt).slice(0, MAX_ENTRIES);
}

export function clear(): void {
  storage.remove(LS_KEY);
}

// ---------------- cuentas ----------------

export interface LedgerStats {
  total: number;
  wins: number;
  losses: number;
  expired: number;
  ambiguous: number;
  hitRate: number;
  /** media de R bruta */
  expectancy: number;
  /** media de R NETA: es LA cifra */
  expectancyNet: number;
  avgCostR: number;
  totalRNet: number;
  /** esperanza de la moneda al aire, en las mismas condiciones */
  controlExpectancy: number;
  controlHitRate: number;
  /** sucesos independientes: señales nacidas a la vez cuentan como uno */
  moments: number;
  /** cuántas desviaciones típicas se aparta el neto de cero, POR SUCESO */
  tStat: number;
  verdict: "SIN DATOS" | "MUESTRA CORTA" | "SIN VENTAJA" | "PIERDE" | "VENTAJA";
  note: string;
}

/** Por debajo de esto, cualquier porcentaje es ruido. */
export const MIN_SAMPLE = 20;

/**
 * Señales nacidas a la vez son UN suceso, no N.
 *
 * ESTO NO ES UN DETALLE. La mesa vigila 20 pares y el consenso suele girar en
 * casi todos a la vez, porque las cripto se mueven juntas. Si un giro general
 * pare 120 señales y se contaran como 120 pruebas independientes, la t saldría
 * inflada por √120 y el libro cantaría VENTAJA con una muestra que en realidad
 * es un puñado de sucesos.
 *
 * Es el mismo error que ya nos salió al contar cascadas de liquidaciones: una
 * cascada que toca 15 pares es un suceso, no quince.
 *
 * Se agrupa por instante de nacimiento y se promedia dentro del grupo. Lo que
 * sale es una observación por suceso, y sobre eso sí se puede hacer una t.
 */
export const MOMENT_MS = 60_000;

export function momentMeans(entries: LedgerEntry[], bucketMs = MOMENT_MS): number[] {
  const g = new Map<number, number[]>();
  for (const e of entries) {
    const k = Math.floor(e.bornAt / bucketMs);
    const prev = g.get(k);
    if (prev) prev.push(e.rNet);
    else g.set(k, [e.rNet]);
  }
  return [...g.values()].map((v) => v.reduce((a, b) => a + b, 0) / v.length);
}

const media = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

export function stats(entries: LedgerEntry[]): LedgerStats {
  const n = entries.length;
  const wins = entries.filter((e) => e.outcome === "ganada").length;
  const losses = entries.filter((e) => e.outcome === "perdida").length;
  const expired = entries.filter((e) => e.outcome === "expirada").length;
  const ambiguous = entries.filter((e) => e.ambiguous).length;

  const rs = entries.map((e) => e.r);
  const nets = entries.map((e) => e.rNet);
  const expectancy = media(rs);
  const expectancyNet = media(nets);
  const avgCostR = media(entries.map((e) => e.costR).filter(Number.isFinite));

  const ctrl = entries.map((e) => e.controlR).filter((x): x is number => x !== null);
  const controlExpectancy = media(ctrl);
  const controlHitRate = ctrl.length ? ctrl.filter((r) => r > 0).length / ctrl.length : NaN;

  /*
    LA t SE CALCULA SOBRE SUCESOS, NO SOBRE SEÑALES. Con 20 pares correlacionados
    las filas no son independientes; usarlas todas inflaría la t por √n y haría
    cantar ventaja donde solo hay un mercado moviéndose entero.
  */
  const sucesos = momentMeans(entries);
  const mediaSucesos = media(sucesos);
  const sd =
    sucesos.length > 1
      ? Math.sqrt(sucesos.reduce((s, x) => s + (x - mediaSucesos) ** 2, 0) / (sucesos.length - 1))
      : NaN;
  const tStat = sd > 0 ? mediaSucesos / (sd / Math.sqrt(sucesos.length)) : NaN;

  const edge = expectancyNet - controlExpectancy;

  let verdict: LedgerStats["verdict"];
  let note: string;
  if (!n) {
    verdict = "SIN DATOS";
    note =
      "Todavía no se ha cerrado ninguna señal de la mesa. El registro empieza vacío a propósito: nace cuando el consenso cambia de lado y se cierra contra velas reales.";
  } else if (sucesos.length < MIN_SAMPLE) {
    /*
      El listón se pone en SUCESOS, no en señales. 120 señales nacidas en el
      mismo giro de mercado son un dato, no ciento veinte.
    */
    verdict = "MUESTRA CORTA";
    note =
      sucesos.length === n
        ? `${n} de ${MIN_SAMPLE} señales cerradas. Por debajo de eso cualquier porcentaje es ruido.`
        : `${n} señales cerradas, pero solo ${sucesos.length} de ${MIN_SAMPLE} sucesos independientes: las que nacen a la vez en varios pares son el mismo giro de mercado contado muchas veces.`;
  } else if (expectancyNet <= -0.1) {
    verdict = "PIERDE";
    note =
      expectancy > 0
        ? `Gana ${expectancy.toFixed(2)}R en bruto y pierde ${expectancyNet.toFixed(2)}R neto: se lo come la comisión (${avgCostR.toFixed(2)}R por señal).`
        : `Esperanza neta ${expectancyNet.toFixed(2)}R por señal: pierde dinero en la muestra.`;
  } else if (Number.isFinite(edge) && edge >= 0.15 && expectancyNet > 0 && tStat > 2) {
    verdict = "VENTAJA";
    note = `Esperanza neta ${expectancyNet.toFixed(2)}R contra ${controlExpectancy.toFixed(2)}R de la moneda al aire (t=${tStat.toFixed(2)}).`;
  } else if (Number.isFinite(edge) && edge >= 0.15 && expectancyNet > 0) {
    verdict = "SIN VENTAJA";
    note = `Va ${expectancyNet.toFixed(2)}R neto contra ${controlExpectancy.toFixed(2)}R del control, pero con t=${Number.isFinite(tStat) ? tStat.toFixed(2) : "—"} eso cabe dentro del azar. Hace falta t>2 y más muestra.`;
  } else {
    verdict = "SIN VENTAJA";
    note = `Esperanza neta ${expectancyNet.toFixed(2)}R vs ${controlExpectancy.toFixed(2)}R del control: la diferencia no distingue estas reglas del azar.`;
  }

  return {
    total: n,
    wins,
    losses,
    expired,
    ambiguous,
    hitRate: n ? wins / n : NaN,
    expectancy,
    expectancyNet,
    avgCostR,
    totalRNet: nets.reduce((a, b) => a + b, 0),
    controlExpectancy,
    controlHitRate,
    moments: sucesos.length,
    tStat,
    verdict,
    note,
  };
}

/** Cuentas por temporalidad: el coste cambia tanto que juntarlo lo escondería. */
export function statsByTimeframe(entries: LedgerEntry[]): { timeframe: string; stats: LedgerStats }[] {
  const grupos = new Map<string, LedgerEntry[]>();
  for (const e of entries) {
    grupos.set(e.timeframe, [...(grupos.get(e.timeframe) ?? []), e]);
  }
  return [...grupos.entries()]
    .map(([timeframe, es]) => ({ timeframe, stats: stats(es) }))
    .sort((a, b) => b.stats.total - a.stats.total);
}

export { ROUND_TRIP_COST_PCT };
