// ============================================================
// Motor de señales y bitácora.
//
// Persiste cada señal en el momento de nacer y la reevalúa contra las velas
// reales que van llegando. Nada se reescribe: una señal resuelta queda como
// quedó, gane o pierda.
// ============================================================
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildSignal,
  computeStats,
  evaluateSignal,
  MIN_SCORE,
  scoreSignal,
  type Signal,
  type SignalInputs,
  type Stats,
} from "../lib/signals";
import { read, write } from "../lib/storage";
import type { MarketApi } from "./useMarket";
import type { ConfluenceState } from "./useConfluence";

const K_SIGNALS = "liqradar:signals:v1";
const MAX_KEPT = 500;
/** Espera mínima entre señales del mismo símbolo y marco. */
const COOLDOWN_MS = 10 * 60_000;

function load(): Signal[] {
  const raw = read<Signal[]>(K_SIGNALS, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((s) => s && typeof s.id === "string" && Number.isFinite(s.entry)).slice(0, MAX_KEPT);
}

export interface SignalsApi {
  signals: Signal[];
  /** las del símbolo activo, más reciente primero */
  visible: Signal[];
  open: Signal[];
  stats: Stats;
  /** puntuación en vivo, aunque no llegue al umbral */
  liveScore: number;
  liveReasons: ReturnType<typeof scoreSignal>["reasons"];
  threshold: number;
  autoEnabled: boolean;
  setAutoEnabled: (v: boolean) => void;
  clear: () => void;
}

export function useSignals(api: MarketApi, confluence: ConfluenceState): SignalsApi {
  const [signals, setSignals] = useState<Signal[]>(() =>
    typeof window === "undefined" ? [] : load()
  );
  const [autoEnabled, setAutoEnabledState] = useState<boolean>(() => read<boolean>("liqradar:autosig", true));
  const signalsRef = useRef(signals);
  signalsRef.current = signals;

  const setAutoEnabled = useCallback((v: boolean) => {
    setAutoEnabledState(v);
    write("liqradar:autosig", v);
  }, []);

  const persist = useCallback((next: Signal[]) => {
    const trimmed = next.slice(0, MAX_KEPT);
    setSignals(trimmed);
    write(K_SIGNALS, trimmed);
  }, []);

  // ---------- ingredientes en vivo ----------
  const inputs: SignalInputs | null = useMemo(() => {
    const ind = api.indicators;
    if (!ind || !Number.isFinite(api.price)) return null;
    const atr = ind.atr.at(-1);
    if (!Number.isFinite(atr) || !atr) return null;

    // solo liquidaciones de la última media hora: el flujo forzado caduca
    const since = Date.now() - 30 * 60_000;
    let liqLong = 0;
    let liqShort = 0;
    for (const e of api.liqEvents) {
      if (e.ts < since) continue;
      if (e.side === "long") liqLong += e.usd;
      else liqShort += e.usd;
    }

    return {
      symbol: api.symbol,
      timeframe: api.tf,
      price: api.price,
      atr,
      indicators: ind,
      confluenceTrend: confluence.dominant,
      confluenceAgreement: confluence.total ? confluence.agree / confluence.total : 0,
      liqLong,
      liqShort,
      bookImbalance: api.snap.book?.imbalance ?? NaN,
      fundingPct: api.snap.funding?.rate ?? NaN,
      oiDelta1hPct: api.snap.oi?.delta1hPct ?? NaN,
    };
  }, [api.indicators, api.price, api.symbol, api.tf, api.liqEvents, api.snap.book, api.snap.funding, api.snap.oi, confluence]);

  const live = useMemo(
    () => (inputs ? scoreSignal(inputs) : { score: 0, reasons: [] }),
    [inputs]
  );

  // Los ingredientes cambian cada vez que se mueve el precio o el libro. Si el
  // efecto de generación dependiera de ellos, destruiría y recrearía su
  // temporizador cada segundo y NUNCA llegaría a cumplir el intervalo: no se
  // registraría ni una señal. Van por ref, y el efecto se monta una sola vez.
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;
  const pausedRef = useRef(api.paused);
  pausedRef.current = api.paused;
  const autoRef = useRef(autoEnabled);
  autoRef.current = autoEnabled;

  // ---------- generación automática ----------
  useEffect(() => {
    const id = window.setInterval(() => {
      const inputs = inputsRef.current;
      if (!autoRef.current || !inputs || pausedRef.current) return;
      const now = Date.now();
      const existing = signalsRef.current;

      // no acumular señales del mismo mercado ni encadenarlas sin respiro
      const hasOpen = existing.some(
        (s) => s.outcome === "abierta" && s.symbol === inputs.symbol && s.timeframe === inputs.timeframe
      );
      if (hasOpen) return;
      const last = existing.find((s) => s.symbol === inputs.symbol && s.timeframe === inputs.timeframe);
      if (last && now - last.ts < COOLDOWN_MS) return;

      const sig = buildSignal(inputs, now);
      if (sig) persist([sig, ...existing]);
    }, 15_000);
    return () => window.clearInterval(id);
  }, [persist]);

  // ---------- resolución contra velas reales ----------
  // Mismo motivo que arriba: las velas se refrescan constantemente, así que
  // van por ref para que el temporizador sobreviva.
  const candlesRef = useRef(api.snap.warm.length ? api.snap.warm : api.snap.candles);
  candlesRef.current = api.snap.warm.length ? api.snap.warm : api.snap.candles;
  const symbolRef = useRef(api.symbol);
  symbolRef.current = api.symbol;

  useEffect(() => {
    const id = window.setInterval(() => {
      const candles = candlesRef.current;
      const symbol = symbolRef.current;
      if (candles.length < 2) return;
      const current = signalsRef.current;
      if (!current.some((s) => s.outcome === "abierta" && s.symbol === symbol)) return;

      let changed = false;
      const next = current.map((s) => {
        if (s.outcome !== "abierta" || s.symbol !== symbol) return s;
        const r = evaluateSignal(s, candles);
        if (r !== s) changed = true;
        return r;
      });
      if (changed) persist(next);
    }, 5_000);
    return () => window.clearInterval(id);
  }, [persist]);

  const visible = useMemo(
    () => signals.filter((s) => s.symbol === api.symbol).sort((a, b) => b.ts - a.ts),
    [signals, api.symbol]
  );
  const open = useMemo(() => visible.filter((s) => s.outcome === "abierta"), [visible]);
  const stats = useMemo(() => computeStats(signals), [signals]);

  const clear = useCallback(() => persist([]), [persist]);

  return {
    signals,
    visible,
    open,
    stats,
    liveScore: live.score,
    liveReasons: live.reasons,
    threshold: MIN_SCORE,
    autoEnabled,
    setAutoEnabled,
    clear,
  };
}
