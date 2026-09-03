import { Component, type ErrorInfo, type ReactNode } from "react";
import { useMarket } from "./hooks/useMarket";
import { useConfluence } from "./hooks/useConfluence";
import { useSignals } from "./hooks/useSignals";
import { useLiqStudy } from "./hooks/useLiqStudy";
import TopBar from "./components/TopBar";
import PriceChart from "./components/PriceChart";
import LiquidationsPanel from "./components/LiquidationsPanel";
import AnalysisPanel from "./components/AnalysisPanel";
import MarketPanel from "./components/MarketPanel";
import OrderBookPanel from "./components/OrderBookPanel";
import ValidationPanel from "./components/ValidationPanel";
import IndicatorScorePanel from "./components/IndicatorScorePanel";
import LiqStudyPanel from "./components/LiqStudyPanel";
import SignalPanel from "./components/SignalPanel";
import JournalPanel from "./components/JournalPanel";

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[LIQRADAR]", error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen items-center justify-center p-6">
          <div className="card max-w-md p-6 text-center">
            <div className="font-display text-sm font-bold uppercase tracking-[0.16em] down">Error en la interfaz</div>
            <p className="mt-3 font-mono text-[11px] leading-relaxed text-[var(--color-muted)]">
              {this.state.error.message}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="mt-5 rounded-md border border-[rgba(33,212,160,0.45)] bg-[var(--color-up-soft)] px-4 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.14em] up"
            >
              Recargar
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function Dashboard() {
  const api = useMarket();
  const confluence = useConfluence(api.symbol, api.venue);
  const liq = useLiqStudy(api);
  const sig = useSignals(api, confluence);

  return (
    <div className="relative min-h-screen">
      <div className="backdrop" aria-hidden />
      <TopBar api={api} />

      {/*
        Rejilla de 12 columnas: el gráfico manda (8 col), la columna de
        contexto acompaña (4 col), y las liquidaciones y el libro quedan
        debajo repartidos. En pantallas medianas cae a 2 columnas y en
        móvil a una sola, sin que ningún panel se rompa.
      */}
      <main className="mx-auto grid max-w-[1680px] grid-cols-1 gap-3 px-3 py-3 md:grid-cols-2 lg:px-5 lg:py-4 xl:grid-cols-12">
        <div className="md:col-span-2 xl:col-span-8">
          <PriceChart api={api} />
        </div>

        <div className="flex flex-col gap-3 md:col-span-2 xl:col-span-4">
          <SignalPanel api={api} sig={sig} />
          <AnalysisPanel api={api} confluence={confluence} />
        </div>

        <div className="md:col-span-1 xl:col-span-5">
          <LiquidationsPanel api={api} />
        </div>

        <div className="md:col-span-1 xl:col-span-3">
          <OrderBookPanel api={api} />
        </div>

        <div className="md:col-span-2 xl:col-span-4">
          <MarketPanel api={api} />
        </div>

        <div className="md:col-span-2 xl:col-span-7">
          <JournalPanel api={api} sig={sig} />
        </div>

        <div className="md:col-span-1 xl:col-span-5">
          <ValidationPanel api={api} />
        </div>

        <div className="md:col-span-1 xl:col-span-7">
          <IndicatorScorePanel api={api} />
        </div>

        <div className="md:col-span-2 xl:col-span-5">
          <LiqStudyPanel api={api} liq={liq} />
        </div>
      </main>

      <footer className="border-t border-[var(--color-line)] bg-[rgba(10,14,23,0.6)]">
        <div className="mx-auto flex max-w-[1680px] flex-wrap items-center justify-between gap-2 px-4 py-4 font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--color-dim)] lg:px-5">
          <span>LIQRADAR · liquidez y liquidaciones reales</span>
          <span className="normal-case tracking-normal">
            Binance · OKX · Bybit — APIs públicas, sin claves, sin datos simulados
          </span>
          <span className="normal-case tracking-normal opacity-70">
            Herramienta de análisis. No es asesoramiento financiero.
          </span>
        </div>
      </footer>
    </div>
  );
}

export default function App() {
  return (
    <Boundary>
      <Dashboard />
    </Boundary>
  );
}
