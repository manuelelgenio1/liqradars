// ============================================================
// Confluencia multi-temporalidad.
//
// Calcula el consenso en varias temporalidades a la vez sobre velas REALES de
// Binance. Un veredicto en 5 m dice poco si el diario va en contra; esto lo
// pone delante en vez de dejarlo a que el usuario cambie de marco uno a uno.
// ============================================================
import { useEffect, useState } from "react";
import * as binance from "../lib/sources/binance";
import { computeAll, configFor, type Trend } from "../lib/indicators";
import { symbolOf, TIMEFRAMES } from "../lib/types";

export interface ConfluenceRow {
  tf: string;
  label: string;
  trend: Trend;
  strength: number;
}

export interface ConfluenceState {
  rows: ConfluenceRow[];
  loading: boolean;
  failed: boolean;
  /** cuántas temporalidades direccionales coinciden con la mayoritaria */
  agree: number;
  total: number;
  dominant: Trend | null;
}

const TFS = ["5m", "15m", "1H", "4H", "1D"];

export function useConfluence(symbol: string, venue: binance.Venue): ConfluenceState {
  const [state, setState] = useState<ConfluenceState>({
    rows: [],
    loading: true,
    failed: false,
    agree: 0,
    total: 0,
    dominant: null,
  });

  useEffect(() => {
    let cancelled = false;
    const spec = symbolOf(symbol);

    const load = async () => {
      const results = await Promise.allSettled(
        TFS.map(async (key) => {
          const tf = TIMEFRAMES.find((t) => t.key === key)!;
          const candles = await binance.fetchCandles(spec.binance, tf.binance, 260, venue);
          const bundle = computeAll(candles, configFor(key), tf.minutes);
          return {
            tf: key,
            label: tf.label,
            trend: bundle.consensus.trend,
            strength: bundle.consensus.strength,
          } satisfies ConfluenceRow;
        })
      );
      if (cancelled) return;

      const rows = results
        .filter((r): r is PromiseFulfilledResult<ConfluenceRow> => r.status === "fulfilled")
        .map((r) => r.value);

      if (!rows.length) {
        setState({ rows: [], loading: false, failed: true, agree: 0, total: 0, dominant: null });
        return;
      }

      const directional = rows.filter((r) => r.trend !== "lateral");
      const ups = directional.filter((r) => r.trend === "alcista").length;
      const downs = directional.length - ups;
      const dominant: Trend | null =
        directional.length === 0 ? null : ups === downs ? null : ups > downs ? "alcista" : "bajista";

      setState({
        rows,
        loading: false,
        failed: false,
        agree: dominant ? Math.max(ups, downs) : 0,
        total: directional.length,
        dominant,
      });
    };

    // Marcar "cargando" antes de lanzar la descarga es el patrón que documenta React. La alternativa sería no avisar de que se está cargando.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState((s) => ({ ...s, loading: true }));
    void load();
    const id = window.setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [symbol, venue]);

  return state;
}
