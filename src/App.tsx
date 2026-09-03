import { Component, type ErrorInfo, type ReactNode } from "react";
import { useMarket } from "./hooks/useMarket";
import { useConfluence } from "./hooks/useConfluence";
import { useSignals } from "./hooks/useSignals";
import { useLiqStudy } from "./hooks/useLiqStudy";
import TopBar from "./components/TopBar";
import ChartTabs from "./components/ChartTabs";

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

  /*
    Una sola columna: el reparto lo decide ChartTabs.

    Antes esto era una rejilla de 12 columnas con NUEVE paneles colgando
    debajo del gráfico, y App decidía a la vez qué se enseña y dónde cae cada
    cosa. Ahora App solo monta los datos y la barra; qué panel vive en qué
    pestaña es asunto de ChartTabs, que es quien sabe en qué pestaña estás.
  */
  return (
    <div className="relative min-h-screen">
      <div className="backdrop" aria-hidden />
      <TopBar api={api} />

      <main className="mx-auto max-w-[1680px] px-3 py-3 lg:px-5 lg:py-4">
        <ChartTabs api={api} sig={sig} confluence={confluence} liq={liq} />
      </main>

      <footer className="mt-6 border-t border-[var(--color-line)] bg-[rgba(10,14,23,0.6)]">
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
