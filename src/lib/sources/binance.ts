// ============================================================
// Binance · gratis, sin API key.
//
// Endpoints verificados en vivo:
//   fapi.binance.com/fapi/v1/klines | depth | premiumIndex | openInterest
//   fapi.binance.com/futures/data/openInterestHist        (OI histórico REAL)
//   fapi.binance.com/futures/data/globalLongShortAccountRatio
//   fapi.binance.com/futures/data/topLongShortPositionRatio
//   data-api.binance.vision/api/v3/...                    (spot, respaldo geo)
//
// Nota sobre liquidaciones: Binance publica `!forceOrder@arr`, pero su propia
// documentación advierte que por símbolo solo empuja la liquidación MÁS GRANDE
// de cada 1000 ms y descarta el resto. Sirve para detectar eventos grandes,
// nunca para contar ni sumar volumen. Se marca como "recortado" allí donde se
// use, y el agregado se apoya en OKX y Bybit.
// ============================================================
import { getJson, openSocket, type SocketHandle } from "../net";
import type {
  Candle,
  FundingInfo,
  Liquidation,
  LongShortInfo,
  OpenInterestInfo,
  OrderBook,
} from "../types";

export type Venue = "perp" | "spot";

const REST_PERP = "https://fapi.binance.com/fapi/v1";
const REST_DATA = "https://fapi.binance.com/futures/data";
const REST_SPOT = "https://data-api.binance.vision/api/v3";
const WS_PERP = "wss://fstream.binance.com/stream?streams=";
const WS_SPOT = "wss://data-stream.binance.vision/stream?streams=";

const rest = (v: Venue) => (v === "perp" ? REST_PERP : REST_SPOT);
const wsBase = (v: Venue) => (v === "perp" ? WS_PERP : WS_SPOT);

type RawKline = (string | number)[];

export async function fetchCandles(
  symbol: string,
  interval: string,
  limit: number,
  venue: Venue = "perp"
): Promise<Candle[]> {
  const raw = await getJson<RawKline[]>(
    `${rest(venue)}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
  );
  return raw.map((k) => {
    const volume = Number(k[5]) || 0;
    const takerBuy = Number(k[9]) || 0;
    return {
      t: Number(k[0]),
      o: Number(k[1]),
      h: Number(k[2]),
      l: Number(k[3]),
      c: Number(k[4]),
      v: volume,
      // taker compra − taker venta = 2·takerBuy − volumen total
      delta: volume > 0 ? takerBuy * 2 - volume : 0,
    };
  });
}

export async function fetchOrderBook(symbol: string, venue: Venue = "perp"): Promise<OrderBook> {
  const j = await getJson<{ bids: [string, string][]; asks: [string, string][] }>(
    `${rest(venue)}/depth?symbol=${symbol}&limit=50`
  );
  const build = (rows: [string, string][]) => {
    let cumulative = 0;
    return rows.slice(0, 20).map(([p, q]) => {
      const size = Number(q);
      cumulative += size;
      return { price: Number(p), size, cumulative };
    });
  };
  const bids = build(j.bids ?? []);
  const asks = build(j.asks ?? []);
  const bidSum = bids.at(-1)?.cumulative ?? 0;
  const askSum = asks.at(-1)?.cumulative ?? 0;

  /*
    Sin libro, el desequilibrio es NaN — nunca cero.

    Cero significa "compras y ventas perfectamente igualadas", que es una
    lectura real y bastante informativa. Devolverlo cuando en realidad no ha
    llegado ningún nivel convierte la ausencia de datos en una medición, y el
    panel pintaría un "0,0 % · presión compradora" que nadie ha medido.

    `fetchFunding`, aquí al lado, ya devolvía null cuando fallaba. Esto solo
    pone al libro a la misma altura.
  */
  const total = bidSum + askSum;
  return {
    bids,
    asks,
    imbalance: total > 0 ? (bidSum - askSum) / total : NaN,
    ts: Date.now(),
  };
}

export async function fetchFunding(symbol: string): Promise<FundingInfo | null> {
  try {
    const j = await getJson<{ lastFundingRate?: string; nextFundingTime?: number; markPrice?: string }>(
      `${REST_PERP}/premiumIndex?symbol=${symbol}`
    );
    const rate = Number(j.lastFundingRate) * 100;
    if (!Number.isFinite(rate)) return null;
    return {
      rate,
      nextMs: Math.max(0, Number(j.nextFundingTime) - Date.now()),
      source: "binance",
    };
  } catch {
    return null;
  }
}

/** OI nocional actual + variación REAL en 1 h desde el histórico público. */
export async function fetchOpenInterest(symbol: string): Promise<OpenInterestInfo | null> {
  const [nowRes, histRes, markRes] = await Promise.allSettled([
    getJson<{ openInterest?: string }>(`${REST_PERP}/openInterest?symbol=${symbol}`),
    getJson<{ sumOpenInterestValue?: string }[]>(
      `${REST_DATA}/openInterestHist?symbol=${symbol}&period=1h&limit=2`
    ),
    getJson<{ markPrice?: string }>(`${REST_PERP}/premiumIndex?symbol=${symbol}`),
  ]);

  let usd = NaN;
  if (nowRes.status === "fulfilled" && markRes.status === "fulfilled") {
    const contracts = Number(nowRes.value.openInterest);
    const mark = Number(markRes.value.markPrice);
    if (Number.isFinite(contracts) && Number.isFinite(mark)) usd = contracts * mark;
  }

  let delta1hPct = NaN;
  if (histRes.status === "fulfilled" && histRes.value.length >= 2) {
    const prev = Number(histRes.value[0].sumOpenInterestValue);
    const cur = Number(histRes.value[1].sumOpenInterestValue);
    if (Number.isFinite(prev) && Number.isFinite(cur) && prev > 0) {
      delta1hPct = ((cur - prev) / prev) * 100;
      // si el nocional puntual falló, el del histórico sirve igual
      if (!Number.isFinite(usd)) usd = cur;
    }
  }

  if (!Number.isFinite(usd) && !Number.isFinite(delta1hPct)) return null;
  return { usd, delta1hPct, source: "binance" };
}

export async function fetchLongShort(symbol: string): Promise<LongShortInfo | null> {
  const [acc, top] = await Promise.allSettled([
    getJson<{ longShortRatio?: string; longAccount?: string }[]>(
      `${REST_DATA}/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=1`
    ),
    getJson<{ longShortRatio?: string }[]>(
      `${REST_DATA}/topLongShortPositionRatio?symbol=${symbol}&period=5m&limit=1`
    ),
  ]);
  let ratio = NaN;
  let longPct = NaN;
  let topTraderRatio = NaN;
  if (acc.status === "fulfilled" && acc.value.length) {
    ratio = Number(acc.value[0].longShortRatio);
    longPct = Number(acc.value[0].longAccount) * 100;
  }
  if (top.status === "fulfilled" && top.value.length) {
    topTraderRatio = Number(top.value[0].longShortRatio);
  }
  if (!Number.isFinite(ratio) || !Number.isFinite(longPct)) return null;
  return { ratio, longPct, topTraderRatio, source: "binance" };
}

// ---------------- WebSocket ----------------

export interface Ticker {
  symbol: string;
  price: number;
  changePct: number;
  eventTime: number;
}

export function streamTickers(
  symbols: string[],
  onTick: (t: Ticker) => void,
  venue: Venue,
  onGiveUp?: () => void
): SocketHandle {
  const streams = symbols.map((s) => `${s.toLowerCase()}@miniTicker`).join("/");
  return openSocket({
    url: wsBase(venue) + streams,
    silenceMs: 15000,
    onGiveUp,
    onMessage: (raw) => {
      try {
        // `@miniTicker` NO incluye el campo P (eso es de `@ticker`), pero sí
        // trae la apertura de 24 h: el porcentaje se calcula de ahí en vez de
        // leer un campo inexistente que daba NaN y pintaba "—" siempre.
        const j = JSON.parse(raw) as { data?: { s: string; c: string; o: string; E?: number } };
        const d = j.data;
        if (!d?.s || !d.c) return;
        const close = Number(d.c);
        const open = Number(d.o);
        onTick({
          symbol: d.s,
          price: close,
          changePct: Number.isFinite(open) && open > 0 ? ((close - open) / open) * 100 : NaN,
          eventTime: d.E ?? Date.now(),
        });
      } catch {
        /* mensaje ilegible */
      }
    },
  });
}

/** Delta de flujo real (aggTrade). Positivo = agresión compradora. */
export function streamTrades(
  symbol: string,
  onDelta: (notionalDelta: number) => void,
  venue: Venue
): SocketHandle {
  return openSocket({
    url: wsBase(venue) + `${symbol.toLowerCase()}@aggTrade`,
    silenceMs: 30000,
    onMessage: (raw) => {
      try {
        const j = JSON.parse(raw) as { data?: { p: string; q: string; m: boolean } };
        const d = j.data;
        if (!d?.p || !d.q) return;
        const notional = Number(d.p) * Number(d.q);
        if (!Number.isFinite(notional)) return;
        onDelta(d.m ? -notional : notional);
      } catch {
        /* mensaje ilegible */
      }
    },
  });
}

/**
 * Liquidaciones de Binance. RECORTADAS por diseño del exchange: 1 por símbolo
 * y segundo, la mayor. Útil para avisos de eventos grandes; inútil para contar.
 */
export function streamLiquidations(
  onLiq: (l: Liquidation) => void,
  venue: Venue = "perp"
): SocketHandle {
  let seq = 0;
  return openSocket({
    url: wsBase(venue) + "!forceOrder@arr",
    silenceMs: 120000, // puede pasar mucho rato sin liquidaciones legítimamente
    onMessage: (raw) => {
      try {
        const j = JSON.parse(raw) as {
          data?: { o?: { s: string; S: string; ap: string; p: string; q: string; T: number } };
        };
        const o = j.data?.o;
        if (!o) return;
        const price = Number(o.ap) || Number(o.p);
        const qty = Number(o.q);
        if (!Number.isFinite(price) || !Number.isFinite(qty)) return;
        onLiq({
          id: `bn-${o.T}-${++seq}`,
          ts: o.T,
          exchange: "binance",
          symbol: o.s,
          // el lado de la ORDEN es el contrario al de la posición liquidada
          side: o.S === "SELL" ? "long" : "short",
          price,
          qty,
          usd: price * qty,
        });
      } catch {
        /* mensaje ilegible */
      }
    },
  });
}
