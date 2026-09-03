import { useState } from "react";
import type { MarketApi } from "../hooks/useMarket";
import type { SignalsApi } from "../hooks/useSignals";
import type { ConfluenceState } from "../hooks/useConfluence";
import type { LiqStudyApi } from "../hooks/useLiqStudy";
import { useTradingDesk } from "../hooks/useTradingDesk";
import PriceChart from "./PriceChart";
import TradingViewChart from "./TradingViewChart";
import TradingPanel from "./TradingPanel";
import SignalPanel from "./SignalPanel";
import JournalPanel from "./JournalPanel";
import LiquidationsPanel from "./LiquidationsPanel";
import OrderBookPanel from "./OrderBookPanel";
import LiqStudyPanel from "./LiqStudyPanel";
import AnalysisPanel from "./AnalysisPanel";
import IndicatorScorePanel from "./IndicatorScorePanel";
import MarketPanel from "./MarketPanel";
import FindingsPanel from "./FindingsPanel";
import * as storage from "./../lib/storage";

/* ============================================================
   Cuatro espacios de trabajo, cada uno con lo que hace falta ahí.

   ANTES estaban las tres pestañas del gráfico y, debajo, NUEVE paneles
   apilados sin criterio: el libro de órdenes junto al expediente de
   hipótesis, la bitácora junto al funding. Para encontrar algo había que
   recorrer la página entera, y la mitad no tenía nada que ver con lo que
   estabas haciendo en ese momento.

   Ahora cada pestaña responde a una pregunta distinta:

     OPERAR       ¿entro, dónde y cuánto me cuesta?
     LIQUIDEZ     ¿qué está pasando en el flujo ahora mismo?
     TRADINGVIEW  quiero dibujar y usar indicadores potentes
     ANÁLISIS     ¿qué dicen los indicadores y qué hemos comprobado?

   QUÉ SE QUITÓ Y POR QUÉ. El laboratorio de niveles (ValidationPanel)
   medía si el precio va hacia los cúmulos de liquidez usando niveles
   SINTÉTICOS acumulados a mano. Esa misma pregunta se respondió después con
   las posiciones reales de la cámara de compensación de Hyperliquid: no hay
   imán (−0,177 % neto, t=−0,71, con potencia para haber visto cualquier
   efecto rentable). Mantenerlo daría a entender que la pregunta sigue
   abierta. La respuesta vive ahora en el expediente, que es donde toca.

   CÓMO SE OCULTA LO INACTIVO. Con `invisible` y posición absoluta, no con
   `display:none`. El gráfico propio mide su ancho con `clientWidth`, que en
   un elemento plegado vale 0: la primera versión dejó el lienzo con un búfer
   de 300×470 estirado, borroso y con el eje a cero.

   TradingView se monta solo al abrir su pestaña —su script tarda— pero una
   vez montado no se desmonta: perderías los dibujos.
   ============================================================ */

type Tab = "trade" | "liq" | "tv" | "analisis";
const LS_KEY = "liqradar:chartTab";
const VALIDAS: Tab[] = ["trade", "liq", "tv", "analisis"];

interface Props {
  api: MarketApi;
  sig: SignalsApi;
  confluence: ConfluenceState;
  liq: LiqStudyApi;
}

export default function ChartTabs({ api, sig, confluence, liq }: Props) {
  const guardada = storage.read<Tab>(LS_KEY, "trade");
  const [tab, setTab] = useState<Tab>(VALIDAS.includes(guardada) ? guardada : "trade");
  const desk = useTradingDesk(api.spec.binance, api.price);
  const [tvVisitada, setTvVisitada] = useState(tab === "tv");

  const cambiar = (t: Tab) => {
    setTab(t);
    if (t === "tv") setTvVisitada(true);
    storage.write(LS_KEY, t);
  };

  const boton = (t: Tab, texto: string, sub: string) => {
    const activa = tab === t;
    return (
      <button
        key={t}
        onClick={() => cambiar(t)}
        title={sub}
        className={`group flex flex-col items-start gap-0 rounded-t-md border-b-2 px-4 py-2.5 text-left transition-colors ${
          activa
            ? "border-[var(--color-accent)] bg-[var(--color-surface-2)]"
            : "border-transparent hover:bg-[var(--color-surface-2)]"
        }`}
      >
        <span
          className={`font-display text-[11.5px] font-bold uppercase tracking-[0.12em] ${
            activa ? "text-[var(--color-white)]" : "text-[var(--color-dim)] group-hover:text-[var(--color-body)]"
          }`}
        >
          {texto}
        </span>
        <span className="nota-sm hidden sm:block">{sub}</span>
      </button>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-end gap-1 overflow-x-auto border-b border-[var(--color-line)] px-1">
        {boton("trade", "Operar", "niveles, señales y aciertos")}
        {boton("liq", "Liquidez", "flujo real ahora mismo")}
        {boton("tv", "TradingView", "indicadores y dibujo")}
        {boton("analisis", "Análisis", "qué dicen y qué se ha comprobado")}

        <span className="etiqueta ml-auto shrink-0 pb-2.5 pr-2">
          {api.spec.key} · {api.tfSpec.label}
        </span>
      </div>

      <div className="relative mt-3 flex-1">
        {/* ---------- OPERAR ---------- */}
        {tab === "trade" && (
          <div className="flex flex-col gap-4">
            <TradingPanel api={api} desk={desk} />
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <SignalPanel api={api} sig={sig} />
              <JournalPanel api={api} sig={sig} />
            </div>
          </div>
        )}

        {/* ---------- LIQUIDEZ ---------- */}
        <div
          className={tab === "liq" ? "flex flex-col gap-4" : "invisible pointer-events-none absolute inset-0"}
          aria-hidden={tab !== "liq"}
        >
          <PriceChart api={api} />
          {tab === "liq" && (
            <>
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.6fr_1fr]">
                <LiquidationsPanel api={api} />
                <OrderBookPanel api={api} />
              </div>
              <LiqStudyPanel api={api} liq={liq} />
            </>
          )}
        </div>

        {/* ---------- TRADINGVIEW ---------- */}
        {tvVisitada && (
          <div
            className={tab === "tv" ? "h-full" : "invisible pointer-events-none absolute inset-0"}
            aria-hidden={tab !== "tv"}
          >
            <TradingViewChart api={api} />
          </div>
        )}

        {/* ---------- ANÁLISIS ---------- */}
        {tab === "analisis" && (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <AnalysisPanel api={api} confluence={confluence} />
              <MarketPanel api={api} />
            </div>
            <IndicatorScorePanel api={api} />
            <FindingsPanel />
          </div>
        )}
      </div>
    </div>
  );
}
