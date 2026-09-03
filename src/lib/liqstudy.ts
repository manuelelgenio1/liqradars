// ============================================================
// ¿Predicen algo las liquidaciones?
//
// Esta pregunta NO se puede responder mirando atrás. Se comprobó una por una
// cada fuente gratuita: Binance retiró `allForceOrders` (404) y también el
// archivo `liquidationSnapshot`; Bybit no publica el suyo; OKX deja ver ocho
// horas y no pagina más atrás; Coinglass exige clave de pago para el
// histórico. No hay datos que rebobinar.
//
// Así que se mide hacia DELANTE. Cada estallido de liquidaciones queda
// anotado en el instante en que ocurre, con su precio, y es el propio
// historial el que dictamina semanas después. Es lento, pero es la única
// forma que no se engaña a sí misma.
//
// Reglas, las mismas que rigen la bitácora de señales:
//   · La observación se cierra al nacer. Nada se edita luego.
//   · Se guarda el retorno CRUDO, con su signo natural. Así se pueden
//     contrastar después las dos hipótesis opuestas —continuación y
//     agotamiento— sin haber elegido bando de antemano.
//   · Se descuenta el coste. Una ventaja que no lo supera no es una ventaja.
//   · Se compara contra la línea base del propio periodo.
// ============================================================
import type { Candle, Side } from "./types";
import { ROUND_TRIP_COST_PCT } from "./signals";
import * as storage from "./storage";

const LS_KEY = "liqradar.liqstudy.v1";
const MAX_OBS = 600;

/** Nocional mínimo para considerar que hubo estallido, en USD. */
export const BURST_USD = 250_000;
/** Cuánto se espera antes de leer el resultado. */
export const HORIZON_MS = 60 * 60_000;
/** Tras un estallido no se anota otro hasta pasado esto: evita contar el mismo suceso veinte veces. */
export const COOLDOWN_MS = 30 * 60_000;
/** Hacen falta 30 observaciones cerradas antes de opinar. */
export const MIN_OBS = 30;

export interface LiqObservation {
  id: string;
  ts: number;
  symbol: string;
  /** lado liquidado dominante: "long" = largos liquidados, o sea venta forzada */
  dominant: Side;
  /** nocional del estallido, USD */
  notional: number;
  /** parte del nocional que fue del lado dominante, 0,5..1 */
  purity: number;
  price: number;

  // --- se rellena al vencer el horizonte, nunca antes ---
  /** variación CRUDA del precio en %, con su signo natural */
  fwdPct?: number;
  resolvedTs?: number;
}

export interface LiqStudy {
  obs: LiqObservation[];
  /** último instante en que se anotó un estallido, por símbolo */
  lastBurst: Record<string, number>;
}

export const emptyStudy = (): LiqStudy => ({ obs: [], lastBurst: {} });

export function loadStudy(): LiqStudy {
  const raw = storage.read<Partial<LiqStudy>>(LS_KEY, {});
  const obs = Array.isArray(raw.obs)
    ? raw.obs.filter((o) => o && Number.isFinite(o.ts) && Number.isFinite(o.price))
    : [];
  return { obs: obs.slice(0, MAX_OBS), lastBurst: raw.lastBurst ?? {} };
}

const save = (s: LiqStudy): void =>
  storage.write(LS_KEY, { obs: s.obs.slice(0, MAX_OBS), lastBurst: s.lastBurst });

export function persist(study: LiqStudy): void {
  save(study);
}

/**
 * Anota un estallido si lo hay. Devuelve la MISMA referencia cuando no procede,
 * para no provocar renders inútiles.
 */
export function recordBurst(
  study: LiqStudy,
  symbol: string,
  now: number,
  price: number,
  longUsd: number,
  shortUsd: number
): LiqStudy {
  const total = longUsd + shortUsd;
  if (!(total >= BURST_USD) || !(price > 0)) return study;
  if (now - (study.lastBurst[symbol] ?? 0) < COOLDOWN_MS) return study;

  const dominant: Side = longUsd >= shortUsd ? "long" : "short";

  const obs: LiqObservation = {
    id: `liq-${now}-${symbol}`,
    ts: now,
    symbol,
    dominant,
    notional: total,
    purity: Math.max(longUsd, shortUsd) / total,
    price,
  };
  const next: LiqStudy = {
    obs: [obs, ...study.obs].slice(0, MAX_OBS),
    lastBurst: { ...study.lastBurst, [symbol]: now },
  };
  save(next);
  return next;
}

/** Cierra las observaciones cuyo horizonte ya venció, usando velas reales. */
export function resolvePending(study: LiqStudy, symbol: string, candles: Candle[]): LiqStudy {
  if (!candles.length) return study;
  const last = candles[candles.length - 1].t;
  let tocado = false;

  const obs = study.obs.map((o) => {
    if (o.fwdPct !== undefined || o.symbol !== symbol) return o;
    const objetivo = o.ts + HORIZON_MS;
    if (last < objetivo) return o;
    const k = candles.find((c) => c.t >= objetivo); // primera vela tras el vencimiento
    if (!k) return o;
    tocado = true;
    return { ...o, fwdPct: ((k.c - o.price) / o.price) * 100, resolvedTs: k.t };
  });

  if (!tocado) return study;
  const next = { ...study, obs };
  save(next);
  return next;
}

// ---------------- análisis ----------------

export interface SideStat {
  /** hipótesis contrastada */
  label: string;
  n: number;
  /** retorno medio BRUTO a favor de la hipótesis, en % */
  grossPct: number;
  /** ídem, descontado el coste de ida y vuelta */
  netPct: number;
  hitRate: number;
  /** cuánto habría acertado sin habilidad, en esta misma muestra */
  baseline: number;
  tStat: number;
}

export interface StudyReport {
  resolved: number;
  pending: number;
  /** continuación: los largos liquidados empujan el precio ABAJO */
  momentum: SideStat | null;
  /** agotamiento: la liquidación marca el suelo y el precio REBOTA */
  reversal: SideStat | null;
  verdict: "SIN DATOS" | "MUESTRA CORTA" | "SIN VENTAJA" | "VENTAJA";
  note: string;
}

function stat(label: string, rets: number[], baseUp: number, dirs: number[]): SideStat {
  const n = rets.length;
  const m = rets.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(rets.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)) : NaN;
  // línea base: acertar por azar, según la dirección apostada en cada caso
  const base = dirs.reduce((s, d) => s + (d > 0 ? baseUp : 1 - baseUp), 0) / n;
  return {
    label,
    n,
    grossPct: m,
    netPct: m - ROUND_TRIP_COST_PCT,
    hitRate: rets.filter((r) => r > 0).length / n,
    baseline: base,
    tStat: sd > 0 ? m / (sd / Math.sqrt(n)) : NaN,
  };
}

export function analyze(study: LiqStudy): StudyReport {
  const cerradas = study.obs.filter((o) => Number.isFinite(o.fwdPct));
  const pending = study.obs.length - cerradas.length;

  if (!cerradas.length) {
    return {
      resolved: 0,
      pending,
      momentum: null,
      reversal: null,
      verdict: "SIN DATOS",
      note: "Todavía no ha vencido ninguna observación. El registro empieza vacío a propósito: no existe histórico gratuito de liquidaciones que rebobinar.",
    };
  }

  // Línea base del propio periodo: cuántas veces subió el precio.
  const baseUp = cerradas.filter((o) => (o.fwdPct as number) > 0).length / cerradas.length;

  // Continuación: largos liquidados ⇒ venta forzada ⇒ se apuesta a la BAJA.
  const dirMom = cerradas.map((o) => (o.dominant === "long" ? -1 : 1));
  const retMom = cerradas.map((o, i) => dirMom[i] * (o.fwdPct as number));
  const momentum = stat("Continuación · la liquidación empuja", retMom, baseUp, dirMom);

  // Agotamiento: exactamente la misma señal, al revés.
  const reversal = stat(
    "Agotamiento · la liquidación marca el giro",
    retMom.map((r) => -r),
    baseUp,
    dirMom.map((d) => -d)
  );

  if (cerradas.length < MIN_OBS) {
    return {
      resolved: cerradas.length,
      pending,
      momentum,
      reversal,
      verdict: "MUESTRA CORTA",
      note: `${cerradas.length} de ${MIN_OBS} observaciones cerradas. Por debajo de eso cualquier diferencia es ruido.`,
    };
  }

  const mejor = momentum.netPct >= reversal.netPct ? momentum : reversal;
  // Dos hipótesis opuestas contrastadas ⇒ Bonferroni: hace falta t≈2,24, no 2.
  const gana = mejor.netPct > 0 && mejor.tStat > 2.24;

  return {
    resolved: cerradas.length,
    pending,
    momentum,
    reversal,
    verdict: gana ? "VENTAJA" : "SIN VENTAJA",
    note: gana
      ? `${mejor.label}: ${mejor.netPct.toFixed(3)}% neto por operación (t=${mejor.tStat.toFixed(2)}).`
      : `Ninguna de las dos hipótesis supera el coste de forma convincente. La mejor deja ${mejor.netPct.toFixed(3)}% neto con t=${Number.isFinite(mejor.tStat) ? mejor.tStat.toFixed(2) : "—"}; al contrastar dos hipótesis opuestas hace falta t>2,24.`,
  };
}
