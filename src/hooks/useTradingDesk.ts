import { useCallback, useEffect, useMemo, useState } from "react";
import { useLatest } from "./useLatest";
import { useNow } from "./useNow";
import * as binance from "../lib/sources/binance";
import { alignment, computeLevels, type Alignment, type TradeLevels } from "../lib/levels";
import { fetchUniverse, type UniverseEntry } from "../lib/universe";
import { TIMEFRAMES, type Candle } from "../lib/types";
import { STOP_ATR, TARGET_ATR } from "../lib/levels";
import {
  evaluateSignal,
  maybeBirth,
  prune,
  type DeskSignal,
  type SignalState,
} from "../lib/desksignals";
import * as storage from "../lib/storage";
import * as ledger from "../lib/deskledger";

/*
  Mesa de operaciones.

  Dos cosas a la vez:

  1. Para el par elegido, los niveles de las SEIS temporalidades — cada una con
     su propio ATR, su propio stop y su propio coste. Se piden en paralelo,
     porque en serie tardaría seis veces más y esto se consulta a menudo.

  2. Un escáner de los 20 perpetuos con más volumen, para no tener que ir
     mirándolos de uno en uno. Ese barrido es caro: 20 pares × 1 temporalidad
     son 20 peticiones, así que va a mano —con un botón— y no en bucle.

  Por qué el escáner usa una sola temporalidad: barrer 20 pares × 6 marcos son
  120 peticiones, y Binance limita por peso. Se escanea el marco que elijas y,
  si algo aparece, cambias a ese par y ves sus seis marcos completos.
*/

/** Las que pediste, en orden. */
export const DESK_TFS = ["5m", "30m", "1H", "4H", "1D", "1W"] as const;

/** Velas por marco: suficientes para calentar los indicadores sin descargar de más. */
const CANDLES = 300;

export interface ScanRow {
  entry: UniverseEntry;
  levels: TradeLevels | null;
  error: boolean;
}

const LS_SIGNALS = "liqradar:desksignals:v1";

export interface TradingDesk {
  /** señales vivas del par activo, con su edad y frescura */
  signals: SignalState[];
  /** señales ya cerradas contra velas reales */
  ledger: ledger.LedgerEntry[];
  ledgerStats: ledger.LedgerStats;
  ledgerByTf: { timeframe: string; stats: ledger.LedgerStats }[];
  clearLedger: () => void;
  /** niveles del par activo, una fila por temporalidad */
  rows: TradeLevels[];
  align: Alignment;
  loading: boolean;
  /** temporalidades que no se pudieron cargar */
  failed: string[];

  universe: UniverseEntry[];
  universeLoading: boolean;

  scan: ScanRow[];
  scanning: boolean;
  scanTf: string;
  setScanTf: (tf: string) => void;
  runScan: () => void;
  scannedAt: number;
}

export function useTradingDesk(symbol: string, livePrice: number): TradingDesk {
  // Un reloj propio: sin él los contadores solo avanzarían cuando algo más
  // provocara un repintado.
  const now = useNow(1000);
  const [failed, setFailed] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const [universe, setUniverse] = useState<UniverseEntry[]>([]);
  const [universeLoading, setUniverseLoading] = useState(true);

  const [scan, setScan] = useState<ScanRow[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanTf, setScanTf] = useState("1H");
  const [scannedAt, setScannedAt] = useState(0);

  // ---------- niveles del par activo ----------
  // Las velas se recargan al cambiar de par o cada dos minutos. El precio en
  // vivo se aplica encima sin volver a descargar: por eso no está en las
  // dependencias de este efecto.
  const [candlesByTf, setCandlesByTf] = useState<Record<string, Candle[]>>({});

  useEffect(() => {
    let cancelled = false;
    // Marcar "cargando" antes de pedir las seis temporalidades. Es el patrón habitual y la alternativa es una tabla que parece vacía sin decir por qué.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);

    const cargar = async () => {
      const resultados = await Promise.allSettled(
        DESK_TFS.map(async (key) => {
          const tf = TIMEFRAMES.find((t) => t.key === key);
          if (!tf) throw new Error(`temporalidad desconocida: ${key}`);
          const candles = await binance.fetchCandles(symbol, tf.binance, CANDLES, "perp");
          return [key, candles] as const;
        })
      );
      if (cancelled) return;

      const mapa: Record<string, Candle[]> = {};
      const fallos: string[] = [];
      resultados.forEach((r, i) => {
        if (r.status === "fulfilled") mapa[r.value[0]] = r.value[1];
        else fallos.push(DESK_TFS[i]);
      });
      setCandlesByTf(mapa);
      setFailed(fallos);
      setLoading(false);
    };

    void cargar();
    const id = window.setInterval(() => void cargar(), 120_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [symbol]);

  /*
    Derivación pura, no estado.

    Esto era `useState` + `useEffect`: se calculaban las filas en un efecto y
    se guardaban con `setRows`. Eso obliga a React a pintar dos veces cada vez
    que llega una vela o se mueve el precio — una con las filas viejas y otra
    con las nuevas. Y aquí el precio se mueve constantemente.

    Los niveles son una función de las velas y el precio: no hay nada que
    "recordar", así que van en un memo y se pinta una sola vez.
  */
  const rows = useMemo(
    () =>
      DESK_TFS.map((key) => {
        const tf = TIMEFRAMES.find((t) => t.key === key)!;
        return computeLevels(key, tf.label, candlesByTf[key] ?? [], tf.minutes, livePrice);
      }),
    [candlesByTf, livePrice]
  );

  const align = useMemo(() => alignment(rows), [rows]);

  /*
    ---------- señales que nacen, envejecen y caducan ----------

    Se guardan en disco porque la EDAD es el dato: si se perdieran al recargar
    la página, el contador volvería a cero y no mediría nada.

    Nace una solo cuando el consenso de esa temporalidad CAMBIA de lado.
    Mientras diga lo mismo es la misma señal envejeciendo.
  */
  const [signals, setSignals] = useState<DeskSignal[]>(() => storage.read<DeskSignal[]>(LS_SIGNALS, []));
  const [ledgerEntries, setLedger] = useState<ledger.LedgerEntry[]>(() => ledger.load());
  const candlesRef = useLatest(candlesByTf);
  const rowsRef = useLatest(rows);
  const signalsRef = useLatest(signals);
  const symbolRef = useLatest(symbol);
  const priceRef = useLatest(livePrice);

  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      const sym = symbolRef.current;
      const price = priceRef.current;
      if (!(price > 0)) return;

      /*
        Antes de retirar las caducadas se INTENTA CERRARLAS contra velas
        reales. Si se descartaran sin más, la mesa emitiria señales y no
        rendiria cuentas de ellas — que es justo lo que hace el resto del
        sector.
      */
      const previas = signalsRef.current;
      const cerradas: ledger.LedgerEntry[] = [];
      for (const s of previas) {
        if (s.symbol !== sym) continue;
        const velas = candlesRef.current[s.timeframe];
        if (!velas?.length) continue;
        const e = ledger.resolve(s, velas);
        if (e) cerradas.push(e);
      }
      if (cerradas.length) {
        setLedger((prev) => {
          const next = ledger.append(prev, cerradas);
          if (next !== prev) ledger.save(next);
          return next;
        });
      }

      // ahora sí: se retiran las caducadas y se mira si nace alguna
      let vivas = prune(previas, sym, price, now).filter(
        (s) => !cerradas.some((e) => e.id === s.id)
      );
      let cambio = vivas.length !== previas.length;

      for (const r of rowsRef.current) {
        if (!r.ready) continue;
        const previa = vivas.find((s) => s.timeframe === r.timeframe);
        const nueva = maybeBirth(
          {
            symbol: sym,
            timeframe: r.timeframe,
            tfMinutes: TIMEFRAMES.find((t) => t.key === r.timeframe)?.minutes ?? 60,
            side: r.side,
            price: r.price,
            atr: r.atr,
            strength: r.strength,
            stopAtr: STOP_ATR,
            targetAtr: TARGET_ATR,
          },
          previa,
          now
        );
        if (nueva) {
          vivas = [nueva, ...vivas.filter((s) => s.timeframe !== r.timeframe)];
          cambio = true;
        }
      }

      if (cambio) {
        storage.write(LS_SIGNALS, vivas);
        setSignals(vivas);
      }
    };

    const id = window.setInterval(tick, 5_000);
    tick();
    return () => window.clearInterval(id);
    // Los `*Ref` vienen de `useLatest`, que devuelve un `useRef`: el OBJETO es
    // siempre el mismo, así que incluirlos NO relanza el efecto.
  }, [candlesRef, priceRef, rowsRef, signalsRef, symbolRef]);

  const ledgerStats = useMemo(() => ledger.stats(ledgerEntries), [ledgerEntries]);
  const ledgerByTf = useMemo(() => ledger.statsByTimeframe(ledgerEntries), [ledgerEntries]);
  const clearLedger = useCallback(() => {
    ledger.clear();
    setLedger([]);
  }, []);

  // El estado de cada señal se deriva del precio: no se guarda.
  const signalStates = useMemo(
    () =>
      signals
        .map((s) => evaluateSignal(s, livePrice, now))
        .filter((s) => s.expiredReason === null)
        .sort((a, b) => a.signal.tfMinutes - b.signal.tfMinutes),
    [signals, livePrice, now]
  );

  // ---------- universo ----------
  useEffect(() => {
    let cancelled = false;
    const cargar = async () => {
      try {
        const u = await fetchUniverse(20);
        if (!cancelled) setUniverse(u);
      } catch {
        if (!cancelled) setUniverse([]);
      } finally {
        if (!cancelled) setUniverseLoading(false);
      }
    };
    void cargar();
    // El ranking por volumen se mueve despacio: cada cinco minutos sobra.
    const id = window.setInterval(() => void cargar(), 300_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // ---------- escáner ----------
  // Sin refs, `runScan` se recrearía en cada cambio del universo y el botón
  // perdería su identidad; con ellos el callback es estable.
  const universeRef = useLatest(universe);
  const scanTfRef = useLatest(scanTf);

  const runScan = useCallback(() => {
    const lista = universeRef.current;
    const key = scanTfRef.current;
    if (!lista.length || !key) return;
    const tf = TIMEFRAMES.find((t) => t.key === key);
    if (!tf) return;

    setScanning(true);
    void (async () => {
      const out: ScanRow[] = [];
      // De cinco en cinco: 20 peticiones de golpe se acercan al límite de peso
      // de Binance y empiezan a devolver 429.
      for (let i = 0; i < lista.length; i += 5) {
        const tanda = await Promise.allSettled(
          lista.slice(i, i + 5).map(async (e) => {
            const candles = await binance.fetchCandles(e.symbol, tf.binance, CANDLES, "perp");
            return { entry: e, levels: computeLevels(key, tf.label, candles, tf.minutes, e.lastPrice), error: false };
          })
        );
        tanda.forEach((r, j) => {
          if (r.status === "fulfilled") out.push(r.value);
          else out.push({ entry: lista[i + j], levels: null, error: true });
        });
        setScan([...out]); // se va enseñando lo que llega, no se espera al final
      }
      setScannedAt(Date.now());
      setScanning(false);
    })();
    // Los `*Ref` vienen de `useLatest`, que devuelve un `useRef`: el OBJETO es
  // siempre el mismo, así que incluirlos NO relanza el efecto. Lo que lo
  // relanzaría es meter el valor, y evitarlo es el motivo del ref.
  }, [scanTfRef, universeRef]);

  return {
    signals: signalStates,
    ledger: ledgerEntries,
    ledgerStats,
    ledgerByTf,
    clearLedger,
    rows,
    align,
    loading,
    failed,
    universe,
    universeLoading,
    scan,
    scanning,
    scanTf,
    setScanTf,
    runScan,
    scannedAt,
  };
}
