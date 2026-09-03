// ============================================================
// Motor de datos.
//
// Principios:
//  · Nada se inventa. Si un dato no llega, queda NaN y la interfaz pinta "—".
//  · Cada fuente reporta su propio estado de salud, y la interfaz lo muestra.
//  · Los sockets detectan el fallo "abierto pero mudo" y se recuperan solos.
// ============================================================
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as binance from "../lib/sources/binance";
import * as okx from "../lib/sources/okx";
import * as bybit from "../lib/sources/bybit";
import {
  addEvents,
  emptyStore,
  eventsFor,
  levelsFor,
  loadStore,
  ratePerMinute,
  totalsFor,
  type LiqStore,
} from "../lib/liqstore";
import { computeAll, configFor, sliceBundle, syncLastCandle, type Bundle } from "../lib/indicators";
import { read, write } from "../lib/storage";
import {
  SYMBOLS,
  symbolOf,
  timeframeOf,
  type Candle,
  type FundingInfo,
  type Liquidation,
  type LongShortInfo,
  type OpenInterestInfo,
  type OrderBook,
} from "../lib/types";

const CHART_CANDLES = 160;
const WARMUP = 500;

const K_SYMBOL = "liqradar:symbol";
const K_TF = "liqradar:tf";
const K_VENUE = "liqradar:venue";

export type Health = "viva" | "degradada" | "caida" | "esperando";

export interface SourceHealth {
  binanceRest: Health;
  binanceWs: Health;
  okxWs: Health;
  bybitWs: Health;
}

export interface MarketSnapshot {
  candles: Candle[];
  warm: Candle[];
  book: OrderBook | null;
  funding: FundingInfo | null;
  oi: OpenInterestInfo | null;
  longShort: LongShortInfo | null;
  price: number;
  change24h: number;
}

const emptySnapshot = (): MarketSnapshot => ({
  candles: [],
  warm: [],
  book: null,
  funding: null,
  oi: null,
  longShort: null,
  price: NaN,
  change24h: NaN,
});

export function useMarket() {
  const [symbol, setSymbolState] = useState(() => {
    const s = read<string>(K_SYMBOL, "BTCUSDT");
    return SYMBOLS.some((x) => x.key === s) ? s : "BTCUSDT";
  });
  const [tf, setTfState] = useState(() => read<string>(K_TF, "5m"));

  /*
    Dos conceptos distintos que antes estaban mezclados:
      · venuePref — lo que TÚ elegiste. Se persiste. Solo lo cambias tú.
      · degraded  — el respaldo automático cuando el mercado elegido no
                    responde. NO se persiste y se reintenta solo.

    Antes el respaldo llamaba a setVenue("spot"), que escribía en
    localStorage: un único fallo de red temporal te dejaba en spot para
    siempre, en todas las sesiones futuras, sin explicación. Ahora la
    degradación vive solo en memoria y se recupera sola.
  */
  const [venuePref, setVenuePrefState] = useState<binance.Venue>(() => {
    const v = read<string>(K_VENUE, "perp");
    return v === "spot" ? "spot" : "perp";
  });

  /*
    La degradación se lleva por SEPARADO para REST y WebSocket, porque fallan
    por separado. El caso real medido: hay redes donde el REST de Binance
    Futuros responde perfectamente y solo el WebSocket queda bloqueado (abre la
    conexión y no entrega un byte).

    Degradar todo a spot en ese caso era sobre-corregir: al usuario de
    perpetuos se le mostraban velas y profundidad de SPOT pudiendo darle las de
    futuros. Ahora solo cae el stream, y la interfaz lo dice: los fundamentales
    siguen siendo de futuros, y únicamente el tick en vivo viene de spot.
  */
  const [restDegraded, setRestDegraded] = useState(false);
  const [wsDegraded, setWsDegraded] = useState(false);
  const venue: binance.Venue = restDegraded && venuePref === "perp" ? "spot" : venuePref;
  /*
    Cuando el stream de Binance no entrega, el tick lo sirve el PERPETUO de OKX
    en vez del spot de Binance. Es estrictamente mejor: mismo tipo de mercado
    que las velas, así que desaparece el desfase del basis.

    Se eligió OKX sobre Bybit midiendo ambos en vivo: OKX manda un snapshot
    completo (`last` + `open24h`) en cada mensaje, mientras Bybit manda deltas
    parciales que obligarían a mantener y fusionar estado.
  */
  const tickFromOkx = wsDegraded && venuePref === "perp";
  const degraded = restDegraded || wsDegraded;
  const [paused, setPaused] = useState(false);

  const setSymbol = useCallback((s: string) => {
    setSymbolState(s);
    write(K_SYMBOL, s);
  }, []);
  const setTf = useCallback((t: string) => {
    setTfState(t);
    write(K_TF, t);
  }, []);
  // Elección explícita del usuario: se persiste y cancela cualquier degradación.
  const setVenue = useCallback((v: binance.Venue) => {
    setVenuePrefState(v);
    write(K_VENUE, v);
    setRestDegraded(false);
    setWsDegraded(false);
  }, []);

  const [snap, setSnap] = useState<MarketSnapshot>(emptySnapshot);
  const [loading, setLoading] = useState(true);
  const [tickers, setTickers] = useState<Record<string, binance.Ticker>>({});
  const [store, setStore] = useState<LiqStore>(() => (typeof window === "undefined" ? emptyStore() : loadStore()));
  const [health, setHealth] = useState<SourceHealth>({
    binanceRest: "esperando",
    binanceWs: "esperando",
    okxWs: "esperando",
    bybitWs: "esperando",
  });

  const storeRef = useRef(store);
  storeRef.current = store;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const venueRef = useRef(venue);
  venueRef.current = venue;
  const venuePrefRef = useRef(venuePref);
  venuePrefRef.current = venuePref;
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;

  // buffer de liquidaciones: se vuelca a intervalo fijo para no re-renderizar
  // en cada evento suelto
  const liqBuffer = useRef<Liquidation[]>([]);
  const tradeDelta = useRef(0);
  const [realFlow, setRealFlow] = useState(false);
  const flowCount = useRef(0);

  const spec = symbolOf(symbol);
  const tfSpec = timeframeOf(tf);

  // ---------- carga REST del símbolo / temporalidad ----------
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const warm = await binance.fetchCandles(spec.binance, tfSpec.binance, WARMUP, venue);
        if (cancelled) return;
        setSnap((s) => ({ ...s, warm, candles: warm.slice(-CHART_CANDLES) }));
        setHealth((h) => ({ ...h, binanceRest: "viva" }));
      } catch {
        if (cancelled) return;
        // el perpetuo está restringido en algunas regiones: se prueba spot
        if (venueRef.current === "perp") {
          try {
            const warm = await binance.fetchCandles(spec.binance, tfSpec.binance, WARMUP, "spot");
            if (cancelled) return;
            setSnap((s) => ({ ...s, warm, candles: warm.slice(-CHART_CANDLES) }));
            setRestDegraded(true); // temporal, no se guarda
            setHealth((h) => ({ ...h, binanceRest: "degradada" }));
          } catch {
            if (!cancelled) setHealth((h) => ({ ...h, binanceRest: "caida" }));
          }
        } else {
          setHealth((h) => ({ ...h, binanceRest: "caida" }));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [spec.binance, tfSpec.binance, venue, setVenue]);

  // ---------- libro de órdenes ----------
  // Va en su PROPIO intervalo, rápido. Antes compartía los 30 s de funding y
  // OI, y el libro llegaba a mostrar un mid casi un 0,1 % desviado del precio
  // de la cabecera: un "muro" podía llevar medio minuto sin existir. El funding
  // y el OI cambian cada horas; la profundidad, cada segundo.
  useEffect(() => {
    let cancelled = false;
    const pull = async () => {
      try {
        const book = await binance.fetchOrderBook(spec.binance, venueRef.current);
        if (!cancelled) setSnap((s) => ({ ...s, book }));
      } catch {
        /* se conserva el último snapshot; su antigüedad se muestra en el panel */
      }
    };
    void pull();
    const id = window.setInterval(() => {
      if (!pausedRef.current) void pull();
    }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [spec.binance]);

  // ---------- métricas lentas (funding, OI, posicionamiento) ----------
  useEffect(() => {
    let cancelled = false;
    const pull = async () => {
      const [funding, oi, ls] = await Promise.allSettled([
        binance.fetchFunding(spec.binance),
        binance.fetchOpenInterest(spec.binance),
        binance.fetchLongShort(spec.binance),
      ]);
      if (cancelled) return;
      setSnap((s) => ({
        ...s,
        funding: funding.status === "fulfilled" ? funding.value : s.funding,
        oi: oi.status === "fulfilled" ? oi.value : s.oi,
        longShort: ls.status === "fulfilled" ? ls.value : s.longShort,
      }));
    };
    void pull();
    const id = window.setInterval(() => {
      if (!pausedRef.current) void pull();
    }, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [spec.binance]);

  // ---------- reintento del mercado preferido ----------
  // Mientras estemos degradados, se sondea futuros con una llamada barata. En
  // cuanto vuelva a responder, se recupera solo: la degradación no debe ser
  // una condena permanente.
  useEffect(() => {
    if (!restDegraded || venuePref !== "perp") return;
    const id = window.setInterval(async () => {
      try {
        await binance.fetchCandles(spec.binance, "1m", 1, "perp");
        setRestDegraded(false);
        setHealth((h) => ({ ...h, binanceRest: "viva" }));
      } catch {
        /* sigue caído; se reintenta al siguiente ciclo */
      }
    }, 60_000);
    return () => window.clearInterval(id);
  }, [restDegraded, venuePref, spec.binance]);

  // ---------- refresco de velas ----------
  useEffect(() => {
    const id = window.setInterval(async () => {
      if (pausedRef.current) return;
      try {
        const warm = await binance.fetchCandles(spec.binance, tfSpec.binance, WARMUP, venueRef.current);
        setSnap((s) => ({ ...s, warm, candles: warm.slice(-CHART_CANDLES) }));
      } catch {
        /* el websocket sigue moviendo el precio */
      }
    }, 20_000);
    return () => window.clearInterval(id);
  }, [spec.binance, tfSpec.binance]);

  // ---------- precios en vivo ----------
  // Mientras Binance entregue, el tick viene de Binance. Si su stream se queda
  // mudo, lo sirve el PERPETUO de OKX, sin arrastrar consigo velas ni libro.
  useEffect(() => {
    const pending: Record<string, binance.Ticker> = {};
    let dirty = false;
    const flush = window.setInterval(() => {
      if (!dirty) return;
      const batch = { ...pending };
      for (const k of Object.keys(pending)) delete pending[k];
      dirty = false;
      setTickers((p) => ({ ...p, ...batch }));
    }, 300);

    const sock = tickFromOkx
      ? okx.streamTickers((t) => {
          // la clave interna ya viene en estilo Binance; se reindexa para que
          // el resto de la app no necesite saber quién sirve el tick
          const spec = SYMBOLS.find((x) => x.key === t.symbol);
          if (!spec) return;
          pending[spec.binance] = {
            symbol: spec.binance,
            price: t.price,
            changePct: t.changePct,
            eventTime: t.eventTime,
          };
          dirty = true;
        })
      : binance.streamTickers(
          SYMBOLS.map((s) => s.binance),
          (t) => {
            pending[t.symbol] = t;
            dirty = true;
          },
          venue,
          () => {
            // socket inservible (no abre, o abre y no entrega nada)
            setHealth((h) => ({ ...h, binanceWs: "degradada" }));
            // Solo cae el stream: el REST puede seguir sirviendo futuros.
            if (venuePrefRef.current === "perp") setWsDegraded(true);
          }
        );

    const probe = window.setInterval(() => {
      setHealth((h) => ({
        ...h,
        binanceWs: tickFromOkx ? "degradada" : sock.isDelivering() ? "viva" : "esperando",
      }));
    }, 3000);

    return () => {
      window.clearInterval(flush);
      window.clearInterval(probe);
      sock.close();
    };
  }, [tickFromOkx, venue]);

  // ---------- flujo real (aggTrade) ----------
  useEffect(() => {
    tradeDelta.current = 0;
    flowCount.current = 0;
    setRealFlow(false);
    const sock = binance.streamTrades(
      spec.binance,
      (d) => {
        tradeDelta.current += d;
        flowCount.current += 1;
        if (flowCount.current === 30) setRealFlow(true);
      },
      venue
    );
    return () => sock.close();
  }, [spec.binance, venue]);

  // ---------- liquidaciones reales: OKX + Bybit + Binance ----------
  useEffect(() => {
    void okx.loadContractSizes();
    const push = (l: Liquidation) => {
      liqBuffer.current.push(l);
      if (liqBuffer.current.length > 500) liqBuffer.current.shift();
    };
    const sockets = [
      okx.streamLiquidations(push),
      bybit.streamLiquidations(push),
      binance.streamLiquidations(push, "perp"),
    ];
    const probe = window.setInterval(() => {
      setHealth((h) => ({
        ...h,
        /*
          `connectedMs > 0` solo decía "llegó a conectar alguna vez", así que
          un socket abierto pero mudo se anunciaba como EN VIVO — justo la
          mentira que esta app no debe contar. `isDelivering()` exige haber
          recibido algo.

          No da falsos positivos en mercados tranquilos: ambos exchanges
          responden con un ACK a la suscripción, así que el canal cuenta como
          vivo desde el primer instante; el silencio posterior es legítimo
          (no hubo liquidaciones), no una avería.
        */
        okxWs: sockets[0].isDelivering() ? "viva" : "esperando",
        bybitWs: sockets[1].isDelivering() ? "viva" : "esperando",
      }));
    }, 4000);
    return () => {
      window.clearInterval(probe);
      for (const s of sockets) s.close();
    };
  }, []);

  // ---------- backfill histórico de OKX ----------
  // Sin esto el mapa arranca vacío y no vale nada el primer día.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const past = await okx.fetchLiquidationHistory(symbol, 3);
      if (cancelled || !past.length) return;
      setStore((s) => addEvents(s, past));
    })();
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  // ---------- volcado del buffer ----------
  useEffect(() => {
    const id = window.setInterval(() => {
      const batch = liqBuffer.current;
      if (!batch.length) return;
      liqBuffer.current = [];
      setStore((s) => addEvents(s, batch));
    }, 1500);
    return () => window.clearInterval(id);
  }, []);

  // ---------- precio en vivo sobre la última vela ----------
  useEffect(() => {
    if (paused) return;
    const id = window.setInterval(() => {
      const t = tickers[spec.binance];
      if (!t) return;
      const delta = tradeDelta.current;
      tradeDelta.current = 0;
      setSnap((s) => {
        if (!s.candles.length) return { ...s, price: t.price, change24h: t.changePct };
        const candles = s.candles.slice();
        const lastIdx = candles.length - 1;
        const k = { ...candles[lastIdx] };
        k.c = t.price;
        k.h = Math.max(k.h, t.price);
        k.l = Math.min(k.l, t.price);
        if (delta !== 0) k.delta += delta;
        candles[lastIdx] = k;
        return { ...s, candles, price: t.price, change24h: t.changePct };
      });
    }, 700);
    return () => window.clearInterval(id);
  }, [paused, tickers, spec.binance]);

  // ---------- indicadores ----------
  const cfg = useMemo(() => configFor(tf), [tf]);
  const indicators: Bundle | null = useMemo(() => {
    const base = snap.warm.length >= CHART_CANDLES ? snap.warm : snap.candles;
    if (base.length < 30) return null;

    /*
      `warm` viene del REST y solo se refresca cada 20 s, mientras el precio
      corre en vivo cada 700 ms. Calcular los indicadores tal cual dejaba la
      última vela con un cierre de hasta 20 segundos de antigüedad: el gráfico
      dibujaba el precio actual y el RSI, MACD, Supertrend y ADX de esa MISMA
      vela respondían a otro precio. En un movimiento rápido el veredicto
      contradecía lo que se veía.

      Se sincroniza la última vela con el precio en vivo antes de calcular,
      igual que ya se hace con `candles` para dibujar.
    */
    const src = syncLastCandle(base, snap.price);
    const full = computeAll(src, cfg, tfSpec.minutes);
    return src.length > CHART_CANDLES ? sliceBundle(full, CHART_CANDLES) : full;
  }, [snap.warm, snap.candles, snap.price, cfg, tfSpec.minutes]);

  // ---------- derivados de liquidaciones ----------
  const price = Number.isFinite(snap.price)
    ? snap.price
    : (snap.candles.at(-1)?.c ?? NaN);

  const liqEvents = useMemo(() => eventsFor(store, symbol), [store, symbol]);
  const liqTotals = useMemo(() => totalsFor(store, symbol), [store, symbol]);
  const liqLevels = useMemo(
    () => (Number.isFinite(price) ? levelsFor(store, symbol, price) : []),
    [store, symbol, price]
  );
  const liqRate = useMemo(() => ratePerMinute(store, symbol), [store, symbol]);

  return {
    symbol,
    setSymbol,
    tf,
    setTf,
    venue,
    tickFromOkx,
    venuePref,
    degraded,
    restDegraded,
    wsDegraded,
    setVenue,
    paused,
    setPaused,
    spec,
    tfSpec,
    snap,
    price,
    loading,
    tickers,
    indicators,
    cfg,
    realFlow,
    health,
    liqEvents,
    liqTotals,
    liqLevels,
    liqRate,
  };
}

export type MarketApi = ReturnType<typeof useMarket>;
