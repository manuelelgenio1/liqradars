// ============================================================
// Agregador de liquidaciones REALES multi-exchange.
//
// Es lo que Coinglass vende, hecho con las APIs gratuitas: se juntan OKX
// (completo, en vivo + histórico), Bybit (completo, en vivo) y Binance
// (recortado por el exchange a 1/símbolo/segundo, así que solo se usa para
// avisos, nunca para sumar).
//
// Todo lo que hay aquí son eventos que ocurrieron de verdad. No hay ni un
// solo valor generado.
// ============================================================
import type { Liquidation, Provenance, Side } from "./types";

const LS_KEY = "liqradar:liqs:v1";
const WINDOW_MS = 24 * 3600_000;
const MAX_EVENTS = 4000;

/**
 * Binance recorta su stream: por símbolo publica solo la liquidación MÁS
 * GRANDE de cada segundo y descarta el resto. Incluirla en los totales
 * mezclaría una muestra sesgada con dos fuentes completas, así que se guarda
 * y se muestra, pero NO suma en los agregados.
 */
const COUNTS_IN_TOTALS: Record<string, boolean> = {
  okx: true,
  bybit: true,
  binance: false,
};

export const countsInTotals = (ex: Provenance) => COUNTS_IN_TOTALS[ex] ?? false;

export interface LiqLevel {
  price: number;
  usdLong: number;
  usdShort: number;
  count: number;
  lastTs: number;
}

export interface LiqTotals {
  long: number;
  short: number;
  count: number;
  /** eventos por exchange, incluidos los que no suman */
  byExchange: Record<string, number>;
  oldestTs: number;
  /** true si algún exchange completo está entregando */
  hasCompleteSource: boolean;
}

export interface LiqStore {
  /** eventos crudos, más reciente primero */
  events: Liquidation[];
}

export const emptyStore = (): LiqStore => ({ events: [] });

export function loadStore(): LiqStore {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return emptyStore();
    const p = JSON.parse(raw) as Liquidation[];
    if (!Array.isArray(p)) return emptyStore();
    const cutoff = Date.now() - WINDOW_MS;
    const events = p
      .filter(
        (e) =>
          e &&
          Number.isFinite(e.ts) &&
          e.ts >= cutoff &&
          Number.isFinite(e.price) &&
          Number.isFinite(e.usd)
      )
      .slice(0, MAX_EVENTS);
    return { events };
  } catch {
    return emptyStore();
  }
}

function persist(store: LiqStore): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(store.events.slice(0, MAX_EVENTS)));
  } catch {
    /* sin almacenamiento */
  }
}

/**
 * Añade eventos evitando duplicados. Devuelve la MISMA referencia si no hubo
 * nada nuevo, para no provocar renders vacíos.
 */
export function addEvents(store: LiqStore, incoming: Liquidation[]): LiqStore {
  if (!incoming.length) return store;
  const seen = new Set(store.events.map((e) => e.id));
  // El mismo evento puede llegar por WS y por el backfill histórico con ids
  // distintos, así que se deduplica también por contenido. La huella DEBE
  // incluir símbolo y lado: sin ellos, dos liquidaciones de pares distintos
  // —o de lados opuestos— con el mismo instante, precio y tamaño se
  // descartaban como si fueran la misma.
  const print = (e: Liquidation) =>
    `${e.exchange}|${e.symbol}|${e.side}|${e.ts}|${e.price}|${e.qty}`;
  const fingerprint = new Set(store.events.map(print));
  const fresh = incoming.filter((e) => {
    const fp = print(e);
    if (seen.has(e.id) || fingerprint.has(fp)) return false;
    seen.add(e.id);
    fingerprint.add(fp);
    return true;
  });
  if (!fresh.length) return store;

  const cutoff = Date.now() - WINDOW_MS;
  const events = [...fresh, ...store.events]
    .filter((e) => e.ts >= cutoff)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_EVENTS);

  const next = { events };
  persist(next);
  return next;
}

export function eventsFor(store: LiqStore, symbol: string): Liquidation[] {
  return store.events.filter((e) => e.symbol === symbol);
}

export function totalsFor(store: LiqStore, symbol: string): LiqTotals {
  let long = 0;
  let short = 0;
  let count = 0;
  let oldestTs = Infinity;
  const byExchange: Record<string, number> = {};
  let hasCompleteSource = false;

  for (const e of store.events) {
    if (e.symbol !== symbol) continue;
    byExchange[e.exchange] = (byExchange[e.exchange] ?? 0) + 1;
    oldestTs = Math.min(oldestTs, e.ts);
    if (!countsInTotals(e.exchange)) continue;
    hasCompleteSource = true;
    count += 1;
    if (e.side === "long") long += e.usd;
    else short += e.usd;
  }

  return {
    long,
    short,
    count,
    byExchange,
    oldestTs: Number.isFinite(oldestTs) ? oldestTs : 0,
    hasCompleteSource,
  };
}

/**
 * Agrupa las liquidaciones reales en niveles de precio. ESTE es el mapa de
 * liquidaciones: no una estimación a partir del open interest, sino dónde se
 * liquidó de verdad. Mira hacia atrás, no predice.
 */
export function levelsFor(
  store: LiqStore,
  symbol: string,
  refPrice: number,
  bucketPct = 0.0005
): LiqLevel[] {
  if (!(refPrice > 0)) return [];
  const step = refPrice * bucketPct;
  const map = new Map<number, LiqLevel>();
  for (const e of store.events) {
    if (e.symbol !== symbol || !countsInTotals(e.exchange)) continue;
    const k = Math.round(e.price / step);
    const cur = map.get(k);
    if (cur) {
      cur.price = (cur.price * cur.count + e.price) / (cur.count + 1);
      cur.count += 1;
      cur.lastTs = Math.max(cur.lastTs, e.ts);
      if (e.side === "long") cur.usdLong += e.usd;
      else cur.usdShort += e.usd;
    } else {
      map.set(k, {
        price: e.price,
        usdLong: e.side === "long" ? e.usd : 0,
        usdShort: e.side === "short" ? e.usd : 0,
        count: 1,
        lastTs: e.ts,
      });
    }
  }
  return [...map.values()].sort((a, b) => a.price - b.price);
}

/** Los niveles con más nocional liquidado, para dibujarlos sobre el gráfico. */
export function topLevels(levels: LiqLevel[], limit = 8): LiqLevel[] {
  return [...levels]
    .sort((a, b) => b.usdLong + b.usdShort - (a.usdLong + a.usdShort))
    .slice(0, limit);
}

/** Ritmo real de liquidaciones (eventos/min) en los últimos `windowMin`. */
export function ratePerMinute(store: LiqStore, symbol: string, windowMin = 5): number {
  const cutoff = Date.now() - windowMin * 60_000;
  let n = 0;
  for (const e of store.events) {
    if (e.symbol === symbol && e.ts >= cutoff && countsInTotals(e.exchange)) n += 1;
  }
  return n / windowMin;
}

export function sideBalance(totals: LiqTotals): { dominant: Side | null; pct: number } {
  const sum = totals.long + totals.short;
  if (sum <= 0) return { dominant: null, pct: 0 };
  const pct = (Math.abs(totals.long - totals.short) / sum) * 100;
  return { dominant: totals.long > totals.short ? "long" : "short", pct };
}
