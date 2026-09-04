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
/** Hacen falta 30 SUCESOS independientes antes de opinar (no 30 filas). */
export const MIN_OBS = 30;

/*
  AGRUPACIÓN POR SUCESO.

  El enfriamiento es por símbolo, así que una cascada que barre el mercado
  deja una fila por cada símbolo que tocó: BTC, ETH y SOL en el mismo minuto
  son tres filas. Pero es UN solo suceso, y sus tres retornos no son datos
  nuevos — medido sobre las primeras observaciones, los símbolos de un mismo
  grupo van al mismo lado el 86 % de las veces (el 50 % sería independencia).

  Tratarlas como independientes multiplicaría la muestra por dos y la
  significación por raíz de dos. Es el mismo error que ya invalidó una
  búsqueda de combinaciones antes de detectarlo, así que aquí se corrige de
  raíz: cada cascada aporta UNA observación, la media de sus miembros.
*/
export const EVENT_WINDOW_MS = 30 * 60_000;

/** Agrupa observaciones próximas en el tiempo, sin importar el símbolo. */
export function clusterEvents<T extends { ts: number }>(obs: T[], windowMs = EVENT_WINDOW_MS): T[][] {
  const orden = [...obs].sort((a, b) => a.ts - b.ts);
  const out: T[][] = [];
  for (const o of orden) {
    const g = out[out.length - 1];
    // se compara con el INICIO del grupo: si no, una racha larga encadenaría
    // sucesos separados por horas en un solo grupo gigante
    if (g && o.ts - g[0].ts <= windowMs) g.push(o);
    else out.push([o]);
  }
  return out;
}

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

const save = (s: LiqStudy): boolean =>
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
  /** sucesos independientes: es la n que vale */
  n: number;
  /** filas en bruto, antes de agrupar cascadas */
  rawN: number;
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
  /** sucesos independientes ya cerrados */
  resolved: number;
  /** filas cerradas en bruto */
  resolvedRaw: number;
  pending: number;
  /** continuación: los largos liquidados empujan el precio ABAJO */
  momentum: SideStat | null;
  /** agotamiento: la liquidación marca el suelo y el precio REBOTA */
  reversal: SideStat | null;
  verdict: "SIN DATOS" | "MUESTRA CORTA" | "SIN VENTAJA" | "VENTAJA";
  note: string;
}

/**
 * `grupos` son los sucesos ya agrupados: cada uno aporta la media de sus
 * miembros, una sola observación. El acierto se mide igual, sobre la media
 * del suceso, para que las dos cifras hablen de lo mismo.
 */
function stat(label: string, grupos: { ret: number; dir: number }[][], baseUp: number): SideStat {
  const rets = grupos.map((g) => g.reduce((s, x) => s + x.ret, 0) / g.length);
  const dirs = grupos.map((g) => g.reduce((s, x) => s + x.dir, 0) / g.length);
  const rawN = grupos.reduce((s, g) => s + g.length, 0);

  const n = rets.length;
  const m = rets.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(rets.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)) : NaN;
  // línea base: acertar por azar, según la dirección apostada en cada caso
  const base = dirs.reduce((s, d) => s + (d > 0 ? baseUp : 1 - baseUp), 0) / n;

  return {
    label,
    n,
    rawN,
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
      resolvedRaw: 0,
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
  // Se agrupa ANTES de medir: una cascada de mercado es un solo dato.
  const grupos = clusterEvents(cerradas).map((g) =>
    g.map((o) => {
      const dir = o.dominant === "long" ? -1 : 1;
      return { ret: dir * (o.fwdPct as number), dir };
    })
  );
  const momentum = stat("Continuación · la liquidación empuja", grupos, baseUp);

  // Agotamiento: exactamente la misma señal, al revés.
  const reversal = stat(
    "Agotamiento · la liquidación marca el giro",
    grupos.map((g) => g.map((x) => ({ ret: -x.ret, dir: -x.dir }))),
    baseUp
  );

  const sucesos = grupos.length;

  if (sucesos < MIN_OBS) {
    return {
      resolved: sucesos,
      resolvedRaw: cerradas.length,
      pending,
      momentum,
      reversal,
      verdict: "MUESTRA CORTA",
      note:
        cerradas.length > sucesos
          ? `${sucesos} de ${MIN_OBS} sucesos independientes (${cerradas.length} filas: las cascadas que tocan varios símbolos a la vez cuentan como una). Por debajo de ${MIN_OBS} cualquier diferencia es ruido.`
          : `${sucesos} de ${MIN_OBS} sucesos cerrados. Por debajo de eso cualquier diferencia es ruido.`,
    };
  }

  const mejor = momentum.netPct >= reversal.netPct ? momentum : reversal;
  // Dos hipótesis opuestas contrastadas ⇒ Bonferroni: hace falta t≈2,24, no 2.
  const gana = mejor.netPct > 0 && mejor.tStat > 2.24;

  return {
    resolved: sucesos,
    resolvedRaw: cerradas.length,
    pending,
    momentum,
    reversal,
    verdict: gana ? "VENTAJA" : "SIN VENTAJA",
    note: gana
      ? `${mejor.label}: ${mejor.netPct.toFixed(3)}% neto por operación (t=${mejor.tStat.toFixed(2)}).`
      : `Ninguna de las dos hipótesis supera el coste de forma convincente. La mejor deja ${mejor.netPct.toFixed(3)}% neto con t=${Number.isFinite(mejor.tStat) ? mejor.tStat.toFixed(2) : "—"}; al contrastar dos hipótesis opuestas hace falta t>2,24.`,
  };
}
