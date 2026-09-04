import { useCallback, useEffect, useMemo, useState } from "react";
import { useLatest } from "./useLatest";
import { useNow } from "./useNow";
import * as binance from "../lib/sources/binance";
import { alignment, computeLevels, type Alignment, type TradeLevels } from "../lib/levels";
import { fetchUniverse, type UniverseEntry } from "../lib/universe";
import { TIMEFRAMES, type Candle } from "../lib/types";
import { STOP_ATR, TARGET_ATR } from "../lib/levels";
import {
  candlesFor,
  type CandleStore,
  EMPTY_STORE,
  evaluateSignal,
  maybeBirth,
  pruneAll,
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
  /** señales vivas del par ACTIVO, con su edad y frescura */
  signals: SignalState[];
  /** cuántas señales vigila la mesa en total, de todos los pares */
  liveTotal: number;
  /** cuántos pares tienen velas cargadas ahora mismo */
  tracked: number;
  sweeping: boolean;
  sweptAt: number;
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
  /*
    UN SOLO ALMACÉN, INDEXADO POR PAR. Lo llenan dos cosas: el par activo, que
    se refresca rápido porque es el que se ve, y un barrido de fondo que
    recorre los 20 del universo para que sus señales también nazcan, caduquen
    y queden anotadas aunque no los estés mirando.

    Que las velas vayan indexadas por par es además lo que impide el fallo que
    esto tenía: `symbol` cambia en el acto al pulsar otro par pero sus velas
    tardan segundos, y con un mapa plano la mesa mezclaba nombre nuevo con
    datos viejos — seis señales BTCUSDT nacidas con el precio de SOL y el ATR
    de BTC, una con el stop en −7384.
  */
  const [store, setStore] = useState<CandleStore>(EMPTY_STORE);
  const [sweptAt, setSweptAt] = useState(0);
  const [sweeping, setSweeping] = useState(false);

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
      // Se FUNDE, no se reemplaza: el resto de pares siguen vigilados.
      setStore((prev) => ({ ...prev, [symbol]: mapa }));
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
        // `candlesFor` devuelve [] si las velas son de otro par, y sin velas
        // `computeLevels` marca la fila como no lista. Nada nace de datos
        // prestados.
        return computeLevels(key, tf.label, candlesFor(store, symbol, key), tf.minutes, livePrice);
      }),
    [store, symbol, livePrice]
  );

  const align = useMemo(() => alignment(rows), [rows]);

  /*
    Filas de TODOS los pares vigilados, para que puedan nacer señales de
    cualquiera de ellos.

    OJO CON EL COSTE: son 20 pares × 6 marcos = 120 cálculos de indicadores
    sobre 300 velas cada uno. Por eso NO llevan el precio en vivo — con él
    dependerían del tick y se recalcularían enteras varias veces por segundo.
    Sin él usan el cierre de la última vela, así que esto solo se rehace cuando
    llegan velas nuevas: una vez por barrido.

    El par activo es la excepción y sigue usando `rows`, con precio en vivo,
    porque es el que se ve y el que tiene tick propio.
  */
  const allRows = useMemo(() => {
    const out: Record<string, TradeLevels[]> = {};
    for (const sym of Object.keys(store)) {
      out[sym] = DESK_TFS.map((key) => {
        const tf = TIMEFRAMES.find((t) => t.key === key)!;
        return computeLevels(key, tf.label, candlesFor(store, sym, key), tf.minutes);
      });
    }
    return out;
  }, [store]);

  /*
    ---------- señales que nacen, envejecen y caducan ----------

    Se guardan en disco porque la EDAD es el dato: si se perdieran al recargar
    la página, el contador volvería a cero y no mediría nada.

    Nace una solo cuando el consenso de esa temporalidad CAMBIA de lado.
    Mientras diga lo mismo es la misma señal envejeciendo.
  */
  const [signals, setSignals] = useState<DeskSignal[]>(() => storage.read<DeskSignal[]>(LS_SIGNALS, []));
  const [ledgerEntries, setLedger] = useState<ledger.LedgerEntry[]>(() => ledger.load());
  const storeRef = useLatest(store);
  const rowsRef = useLatest(rows);
  const signalsRef = useLatest(signals);
  const symbolRef = useLatest(symbol);
  const priceRef = useLatest(livePrice);

  const allRowsRef = useLatest(allRows);
  // Declarado aquí y no junto al escáner: el ciclo lo usa antes.
  const universeRef = useLatest(universe);

  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      const sym = symbolRef.current;
      const st = storeRef.current;
      const previas = signalsRef.current;

      /*
        UN PRECIO POR PAR. El activo lo tiene en vivo; los demás salen del
        ranking por volumen y, si un par no está ahí, del cierre de su última
        vela. Sin esto no se podría juzgar si una señal de otro par tocó su
        stop, que es justo lo que antes se resolvía borrándola.
      */
      const precios: Record<string, number> = {};
      for (const u of universeRef.current) {
        if (u.lastPrice > 0) precios[u.symbol] = u.lastPrice;
      }
      for (const otro of Object.keys(st)) {
        if (precios[otro] > 0) continue;
        const cierre = candlesFor(st, otro, DESK_TFS[0]).at(-1)?.c;
        if (cierre && cierre > 0) precios[otro] = cierre;
      }
      if (priceRef.current > 0) precios[sym] = priceRef.current;

      /*
        1. CERRAR CONTRA VELAS REALES, DE TODOS LOS PARES.

        Antes este bucle saltaba las señales de otros pares y la poda las
        borraba. Resultado: si seguías BTC, te ibas a ETH y las de BTC tocaban
        su stop mientras estabas fuera, se perdían sin quedar anotadas. El
        libro solo acumulaba las del par en el que te quedabas quieto — que no
        es una muestra de las señales de la mesa, sino de las que casualmente
        mirabas.
      */
      const cerradas: ledger.LedgerEntry[] = [];
      for (const s of previas) {
        const velas = candlesFor(st, s.symbol, s.timeframe);
        if (!velas.length) continue;
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

      // 2. retirar las caducadas, cada una con el precio de SU par
      let vivas = pruneAll(previas, precios, now).filter(
        (s) => !cerradas.some((e) => e.id === s.id)
      );
      let cambio = vivas.length !== previas.length;

      // 3. ver si nace alguna, en cualquier par vigilado
      for (const [simbolo, filasDelPar] of Object.entries(allRowsRef.current)) {
        // el activo usa sus filas con precio en vivo; los demás, las del cierre
        const filas = simbolo === sym ? rowsRef.current : filasDelPar;
        for (const r of filas) {
          if (!r.ready) continue;
          const previa = vivas.find((s) => s.symbol === simbolo && s.timeframe === r.timeframe);
          const nueva = maybeBirth(
            {
              symbol: simbolo,
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
            vivas = [
              nueva,
              ...vivas.filter((s) => !(s.symbol === simbolo && s.timeframe === r.timeframe)),
            ];
            cambio = true;
          }
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
  }, [allRowsRef, storeRef, priceRef, rowsRef, signalsRef, symbolRef, universeRef]);

  const ledgerStats = useMemo(() => ledger.stats(ledgerEntries), [ledgerEntries]);
  const ledgerByTf = useMemo(() => ledger.statsByTimeframe(ledgerEntries), [ledgerEntries]);
  const clearLedger = useCallback(() => {
    ledger.clear();
    setLedger([]);
  }, []);

  // El estado de cada señal se deriva del precio: no se guarda.
  /*
    Se ENSEÑAN solo las del par activo. La mesa vigila los 20, pero volcar 120
    tarjetas en pantalla no es informar, es esconder. Las de los demás siguen
    vivas, caducan y se anotan en el registro sin pedir sitio.
  */
  const signalStates = useMemo(
    () =>
      signals
        .filter((s) => s.symbol === symbol)
        .map((s) => evaluateSignal(s, livePrice, now))
        .filter((s) => s.expiredReason === null)
        .sort((a, b) => a.signal.tfMinutes - b.signal.tfMinutes),
    [signals, symbol, livePrice, now]
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

  /*
    ---------- barrido de fondo: los 20 pares ----------

    Sin esto, la mesa solo sabía del par que tenías delante y el registro solo
    acumulaba señales de ese. Con 20 pares vigilados el libro llega a muestra
    útil MUCHO antes, y sobre todo deja de estar sesgado por dónde tenías
    puesta la vista.

    EL COSTE, medido y no estimado: 20 pares × 6 marcos = 120 peticiones de
    velas. Con `limit=300` cada una pesa 2 en el contador de Binance, así que
    un barrido son 240 de los 2400 por minuto que permite. Cada tres minutos
    deja el gasto en 80/min: holgado.

    Va par a par, con sus seis marcos en paralelo. Seis peticiones a la vez es
    prudente; las 120 de golpe devuelven 429.

    UN SOLO `setStore` AL FINAL, y esto importa: cada cambio del almacén rehace
    las filas de los 20 pares. Guardando par a par serían veinte recálculos de
    120 marcos cada uno en cada barrido.
  */
  const universeKey = useMemo(() => universe.map((u) => u.symbol).join(","), [universe]);

  useEffect(() => {
    if (!universeKey) return;
    let cancelled = false;
    const simbolos = universeKey.split(",");

    const barrer = async () => {
      setSweeping(true);
      const acumulado: CandleStore = {};
      for (const sym of simbolos) {
        if (cancelled) return;
        const res = await Promise.allSettled(
          DESK_TFS.map(async (key) => {
            const tf = TIMEFRAMES.find((t) => t.key === key);
            if (!tf) throw new Error(`temporalidad desconocida: ${key}`);
            return [key, await binance.fetchCandles(sym, tf.binance, CANDLES, "perp")] as const;
          })
        );
        const porTf: Record<string, Candle[]> = {};
        for (const r of res) if (r.status === "fulfilled") porTf[r.value[0]] = r.value[1];
        if (Object.keys(porTf).length) acumulado[sym] = porTf;
      }
      if (cancelled) return;
      /*
        Se conserva SOLO lo del universo actual. Un par que se cae del ranking
        dejaría sus velas ahí ocupando memoria para siempre; sus señales vivas
        no se pierden — caducan por tiempo, que es lo único juzgable sin datos.
      */
      setStore((prev) => {
        const activo = prev[symbolRef.current];
        const next: CandleStore = { ...acumulado };
        if (activo && !next[symbolRef.current]) next[symbolRef.current] = activo;
        return next;
      });
      setSweptAt(Date.now());
      setSweeping(false);
    };

    void barrer();
    const id = window.setInterval(() => void barrer(), 180_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [universeKey, symbolRef]);

  // ---------- escáner ----------
  // Sin refs, `runScan` se recrearía en cada cambio del universo y el botón
  // perdería su identidad; con ellos el callback es estable.
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
    liveTotal: signals.length,
    tracked: Object.keys(store).length,
    sweeping,
    sweptAt,
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
