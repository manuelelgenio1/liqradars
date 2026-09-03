import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as binance from "../lib/sources/binance";
import { alignment, computeLevels, type Alignment, type TradeLevels } from "../lib/levels";
import { fetchUniverse, type UniverseEntry } from "../lib/universe";
import { TIMEFRAMES, type Candle } from "../lib/types";

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

export interface TradingDesk {
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
  const [rows, setRows] = useState<TradeLevels[]>([]);
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

  // Los niveles se recalculan cuando llegan velas nuevas o cambia el precio.
  useEffect(() => {
    const out: TradeLevels[] = [];
    for (const key of DESK_TFS) {
      const tf = TIMEFRAMES.find((t) => t.key === key)!;
      const candles = candlesByTf[key] ?? [];
      out.push(computeLevels(key, tf.label, candles, tf.minutes, livePrice));
    }
    setRows(out);
  }, [candlesByTf, livePrice]);

  const align = useMemo(() => alignment(rows), [rows]);

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
  const universeRef = useRef(universe);
  universeRef.current = universe;
  const scanTfRef = useRef(scanTf);
  scanTfRef.current = scanTf;

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
  }, []);

  return {
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
