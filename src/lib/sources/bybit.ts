// ============================================================
// Bybit · gratis, sin API key. Segunda fuente de liquidaciones.
//
// Verificado capturando un mensaje real del canal `allLiquidation`:
//   {"topic":"allLiquidation.XRPUSDT","ts":...,
//    "data":[{"T":1788354415102,"s":"XRPUSDT","S":"Sell","v":"4126.9","p":"1.3321"}]}
//
// CUIDADO con `S`. La documentación de Bybit dice literalmente que un update
// con "Buy" significa que se ha liquidado una posición LARGA — es decir, `S`
// es el lado de la POSICIÓN, no el de la orden. Es la convención CONTRARIA a
// Binance (donde SELL cierra un long) y a la que usa `side` en OKX. Reutilizar
// aquí la lógica de Binance invertiría todos los lados en silencio.
//
// `v` es tamaño ejecutado en moneda base (no contratos) y `p` es el precio de
// bancarrota, así que el nocional es p · v directamente.
// ============================================================
import { getJson, openSocket, type SocketHandle } from "../net";
import type { Liquidation, Side } from "../types";
import { SYMBOLS } from "../types";

const REST = "https://api.bybit.com/v5";
const WS = "wss://stream.bybit.com/v5/public/linear";

const BYBIT_TO_KEY = new Map(SYMBOLS.map((s) => [s.bybit, s.key]));

interface BybitLiqRow {
  T?: number;
  s?: string;
  S?: string;
  v?: string;
  p?: string;
}

export function streamLiquidations(onLiq: (l: Liquidation) => void): SocketHandle {
  let seq = 0;
  return openSocket({
    url: WS,
    silenceMs: 180000,
    keepAlive: { everyMs: 20000, payload: JSON.stringify({ op: "ping" }) },
    onOpen: (send) => {
      send(
        JSON.stringify({
          op: "subscribe",
          args: SYMBOLS.map((s) => `allLiquidation.${s.bybit}`),
        })
      );
    },
    onMessage: (raw) => {
      try {
        const j = JSON.parse(raw) as { topic?: string; data?: BybitLiqRow[]; op?: string };
        if (j.op || !j.topic?.startsWith("allLiquidation")) return;
        for (const d of j.data ?? []) {
          const key = BYBIT_TO_KEY.get(d.s ?? "");
          if (!key) continue;
          const price = Number(d.p);
          const qty = Number(d.v);
          if (!Number.isFinite(price) || !Number.isFinite(qty) || price <= 0 || qty <= 0) continue;
          // `S` ya es el lado de la POSICIÓN liquidada (ver cabecera).
          const side: Side = d.S === "Buy" ? "long" : "short";
          const ts = Number(d.T) || Date.now();
          onLiq({
            id: `by-${ts}-${++seq}`,
            ts,
            exchange: "bybit",
            symbol: key,
            side,
            price,
            qty,
            usd: price * qty,
          });
        }
      } catch {
        /* mensaje ilegible */
      }
    },
  });
}

/** Open interest de Bybit, para contrastar con el de Binance. */
export async function fetchOpenInterest(symbol: string): Promise<{ usd: number; delta1hPct: number } | null> {
  try {
    const [oiRes, tickRes] = await Promise.all([
      getJson<{ result?: { list?: { openInterest?: string; timestamp?: string }[] } }>(
        `${REST}/market/open-interest?category=linear&symbol=${symbol}&intervalTime=1h&limit=2`
      ),
      getJson<{ result?: { list?: { lastPrice?: string }[] } }>(
        `${REST}/market/tickers?category=linear&symbol=${symbol}`
      ),
    ]);
    const list = oiRes.result?.list ?? [];
    const price = Number(tickRes.result?.list?.[0]?.lastPrice);
    if (!list.length || !Number.isFinite(price)) return null;
    // la lista viene de más reciente a más antigua
    const cur = Number(list[0]?.openInterest);
    const prev = Number(list[1]?.openInterest);
    if (!Number.isFinite(cur)) return null;
    const delta1hPct =
      Number.isFinite(prev) && prev > 0 ? ((cur - prev) / prev) * 100 : NaN;
    return { usd: cur * price, delta1hPct };
  } catch {
    return null;
  }
}
