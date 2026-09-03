// ============================================================
// OKX · gratis, sin API key. La fuente PRINCIPAL de liquidaciones.
//
// Verificado en vivo contra la API real:
//   WS   wss://ws.okx.com:8443/ws/v5/public   canal `liquidation-orders`
//        Suscripción por instType:"SWAP" (NO por instId: se rechaza).
//        Payload real: data[].details[] con bkPx / sz / posSide / ts
//   REST /api/v5/public/liquidation-orders    ← HISTÓRICO (100 por página)
//   REST /api/v5/public/instruments           ← ctVal para convertir contratos
//
// `sz` viene en CONTRATOS, no en moneda base. El nocional real es
// px · sz · ctVal. Para BTC-USDT-SWAP ctVal = 0,01 BTC: ignorarlo da un
// error de 100×. Los ctVal se descargan al arrancar; la tabla de respaldo
// coincide con los valores publicados (comprobado).
// ============================================================
import { getJson, openSocket, type SocketHandle } from "../net";
import type { Liquidation, Side } from "../types";
import { SYMBOLS } from "../types";

const REST = "https://www.okx.com/api/v5";
const WS = "wss://ws.okx.com:8443/ws/v5/public";

const INST_TO_KEY = new Map(SYMBOLS.map((s) => [s.okx, s.key]));
const KEY_TO_INST = new Map(SYMBOLS.map((s) => [s.key, s.okx]));
const INSTS: string[] = SYMBOLS.map((s) => s.okx);

const CT_VAL_FALLBACK: Record<string, number> = {
  "BTC-USDT-SWAP": 0.01,
  "ETH-USDT-SWAP": 0.1,
  "SOL-USDT-SWAP": 1,
  "BNB-USDT-SWAP": 0.01,
  "XRP-USDT-SWAP": 100,
  "DOGE-USDT-SWAP": 1000,
};

let ctVals: Record<string, number> = { ...CT_VAL_FALLBACK };

export async function loadContractSizes(): Promise<Record<string, number>> {
  try {
    const j = await getJson<{ data?: { instId?: string; ctVal?: string }[] }>(
      `${REST}/public/instruments?instType=SWAP`
    );
    const next = { ...CT_VAL_FALLBACK };
    for (const d of j.data ?? []) {
      if (!d.instId || !(d.instId in next)) continue;
      const v = Number(d.ctVal);
      if (Number.isFinite(v) && v > 0) next[d.instId] = v;
    }
    ctVals = next;
  } catch {
    /* se mantiene la tabla de respaldo */
  }
  return ctVals;
}

interface OkxDetail {
  bkPx?: string;
  px?: string;
  sz?: string;
  side?: string;
  posSide?: string;
  ts?: string;
}

function toLiquidation(instId: string, d: OkxDetail, seq: number): Liquidation | null {
  const key = INST_TO_KEY.get(instId);
  if (!key) return null;
  const price = Number(d.bkPx ?? d.px);
  const contracts = Number(d.sz);
  if (!Number.isFinite(price) || !Number.isFinite(contracts) || price <= 0 || contracts <= 0) return null;
  const qty = contracts * (ctVals[instId] ?? 1);
  const side: Side =
    d.posSide === "long" || d.posSide === "short"
      ? (d.posSide as Side)
      : d.side === "sell"
        ? "long" // liquidar un LONG obliga a VENDER
        : "short";
  const ts = Number(d.ts) || Date.now();
  return {
    id: `okx-${ts}-${seq}`,
    ts,
    exchange: "okx",
    symbol: key,
    side,
    price,
    qty,
    usd: price * qty,
  };
}

/** Liquidaciones en vivo, sin recorte: cada orden individual. */
export function streamLiquidations(onLiq: (l: Liquidation) => void): SocketHandle {
  let seq = 0;
  return openSocket({
    url: WS,
    silenceMs: 180000, // el canal calla legítimamente cuando no hay liquidaciones
    keepAlive: { everyMs: 20000, payload: "ping" },
    onOpen: (send) => {
      // El canal se suscribe por instType. Un instId aquí es rechazado.
      send(JSON.stringify({ op: "subscribe", args: [{ channel: "liquidation-orders", instType: "SWAP" }] }));
    },
    onMessage: (raw) => {
      if (raw === "pong") return;
      try {
        const j = JSON.parse(raw) as {
          event?: string;
          data?: { instId?: string; details?: OkxDetail[] }[];
        };
        if (j.event) return; // ack de suscripción
        for (const row of j.data ?? []) {
          if (!row.instId) continue;
          for (const d of row.details ?? []) {
            const liq = toLiquidation(row.instId, d, ++seq);
            if (liq) onLiq(liq);
          }
        }
      } catch {
        /* mensaje ilegible */
      }
    },
  });
}

/**
 * HISTÓRICO de liquidaciones. Es lo que permite que el mapa no arranque
 * vacío: se rellena hacia atrás en vez de esperar a acumular en vivo.
 * Devuelve las más recientes primero, 100 por página.
 */
export async function fetchLiquidationHistory(symbolKey: string, pages = 3): Promise<Liquidation[]> {
  const instId = KEY_TO_INST.get(symbolKey);
  if (!instId) return [];
  const family = instId.split("-").slice(0, 2).join("-");
  const out: Liquidation[] = [];
  let after: string | undefined;
  let seq = 0;
  /*
    Se pagina con `after` (registros MÁS ANTIGUOS que ese instante), no con
    `before`.

    Comprobado contra la API real sobre BTC: con `before` las 25 páginas
    devuelven SIEMPRE la misma —100 eventos, 9 horas— mientras que con `after`
    salen 1.266 eventos y 23,6 horas. Con `before`, este backfill pedía tres
    páginas, recibía tres veces lo mismo y creía haber paginado: el mapa de
    liquidez arrancaba con una duodécima parte de lo disponible.

    Los duplicados no inflaban los totales porque `addEvents` deduplica por
    huella de contenido, pero los datos que faltaban no estaban.
  */
  const vistos = new Set<string>();

  for (let p = 0; p < pages; p++) {
    const qs = new URLSearchParams({
      instType: "SWAP",
      instFamily: family,
      state: "filled",
      limit: "100",
    });
    if (after) qs.set("after", after);
    let j: { data?: { instId?: string; details?: OkxDetail[] }[] };
    try {
      j = await getJson(`${REST}/public/liquidation-orders?${qs}`);
    } catch {
      break;
    }
    const details: { instId: string; d: OkxDetail }[] = [];
    for (const row of j.data ?? []) {
      const id = row.instId ?? instId;
      for (const d of row.details ?? []) details.push({ instId: id, d });
    }
    if (!details.length) break;

    let nuevos = 0;
    for (const { instId: id, d } of details) {
      // Identidad de la liquidación en sí, para no rehacer trabajo si la API
      // repite filas entre páginas.
      const huella = `${id}|${d.ts}|${d.sz}|${d.bkPx ?? d.px}|${d.posSide}`;
      if (vistos.has(huella)) continue;
      vistos.add(huella);
      nuevos += 1;
      const liq = toLiquidation(id, d, ++seq);
      if (liq) out.push(liq);
    }
    // Si una página entera no aporta nada nuevo, se acabó el historial: seguir
    // pidiendo solo gastaría peticiones contra una API pública.
    if (!nuevos) break;

    // paginar hacia atrás usando el ts más antiguo de esta página
    const oldest = details.reduce(
      (min, x) => Math.min(min, Number(x.d.ts) || Infinity),
      Infinity
    );
    if (!Number.isFinite(oldest)) break;
    after = String(oldest);
  }
  return out;
}

// ---------------- tickers ----------------

export interface OkxTick {
  /** clave interna, estilo Binance */
  symbol: string;
  price: number;
  changePct: number;
  eventTime: number;
}

/**
 * Precio en vivo del PERPETUO de OKX.
 *
 * Existe como alternativa al stream de Binance Futuros, que en algunas redes
 * acepta la suscripción y luego no entrega un solo dato. Frente al respaldo
 * anterior (spot de Binance) esto es estrictamente mejor: `BTC-USDT-SWAP` es
 * un perpetuo, el mismo tipo de mercado que las velas, así que desaparece el
 * desfase del basis.
 *
 * Se eligió OKX sobre Bybit midiendo ambos: OKX manda un snapshot COMPLETO en
 * cada mensaje (`last` y `open24h`), mientras Bybit manda deltas parciales que
 * obligarían a mantener y fusionar estado.
 */
export function streamTickers(onTick: (t: OkxTick) => void): SocketHandle {
  return openSocket({
    url: WS,
    silenceMs: 20000,
    keepAlive: { everyMs: 20000, payload: "ping" },
    onOpen: (send) => {
      send(
        JSON.stringify({
          op: "subscribe",
          args: INSTS.map((instId) => ({ channel: "tickers", instId })),
        })
      );
    },
    onMessage: (raw) => {
      if (raw === "pong") return;
      try {
        const j = JSON.parse(raw) as {
          event?: string;
          arg?: { channel?: string };
          data?: { instId?: string; last?: string; open24h?: string; ts?: string }[];
        };
        if (j.event || j.arg?.channel !== "tickers") return;
        for (const d of j.data ?? []) {
          const key = INST_TO_KEY.get(d.instId ?? "");
          if (!key) continue;
          const price = Number(d.last);
          const open = Number(d.open24h);
          if (!Number.isFinite(price) || price <= 0) continue;
          onTick({
            symbol: key,
            price,
            changePct: Number.isFinite(open) && open > 0 ? ((price - open) / open) * 100 : NaN,
            eventTime: Number(d.ts) || Date.now(),
          });
        }
      } catch {
        /* mensaje ilegible */
      }
    },
  });
}
