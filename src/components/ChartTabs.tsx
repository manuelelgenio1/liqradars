import { useState } from "react";
import type { MarketApi } from "../hooks/useMarket";
import PriceChart from "./PriceChart";
import TradingViewChart from "./TradingViewChart";
import TradingPanel from "./TradingPanel";
import { useTradingDesk } from "../hooks/useTradingDesk";
import * as storage from "./../lib/storage";

/* ============================================================
   Dos gráficos, porque ninguno solo sirve.

   TRADINGVIEW da los indicadores potentes y las herramientas de dibujo, pero
   va en un iframe cerrado: no se puede pintar nada encima.

   LIQUIDEZ es el gráfico propio, el único sitio donde se ven las
   liquidaciones reales en (tiempo, precio), los clústeres y el CVD. Eso es lo
   que TradingView no tiene y esta app sí.

   Los dos leen el mismo símbolo y la misma temporalidad, así que cambiar
   arriba mueve ambos.

   El TradingView se monta SOLO cuando se abre su pestaña: cargar su script al
   arrancar retrasaría el resto de la app sin motivo. Pero una vez montado se
   mantiene vivo aunque cambies de pestaña, porque volver a montarlo tarda
   segundos y perdería los dibujos que hubieras hecho.
   ============================================================ */

type Tab = "tv" | "liq" | "trade";
const LS_KEY = "liqradar:chartTab";

export default function ChartTabs({ api }: { api: MarketApi }) {
  const guardada = storage.read<Tab>(LS_KEY, "trade");
  const [tab, setTab] = useState<Tab>(
    guardada === "tv" || guardada === "liq" || guardada === "trade" ? guardada : "trade"
  );
  const desk = useTradingDesk(api.spec.binance, api.price);
  // Una vez abierta, la pestaña de TradingView no se desmonta: conserva zoom y dibujos.
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
        className={`group flex flex-col items-start gap-0 rounded-t-md border-b-2 px-3.5 py-2 text-left transition-colors ${
          activa
            ? "border-[var(--color-accent)] bg-[var(--color-surface-2)]"
            : "border-transparent hover:bg-[var(--color-surface-2)]"
        }`}
      >
        <span
          className={`font-mono text-[10px] font-bold uppercase tracking-[0.12em] ${
            activa ? "text-[var(--color-white)]" : "text-[var(--color-dim)] group-hover:text-[var(--color-body)]"
          }`}
        >
          {texto}
        </span>
        <span className="font-mono text-[8px] text-[var(--color-dim)]">{sub}</span>
      </button>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-end gap-1 border-b border-[var(--color-line)] px-1">
        {boton("trade", "Operar", "niveles y coste en 6 marcos")}
        {boton("liq", "Liquidez", "liquidaciones y clústeres reales")}
        {boton("tv", "TradingView", "indicadores y dibujo")}

        <span className="ml-auto pb-2 pr-2 font-mono text-[8px] text-[var(--color-dim)]">
          {api.spec.key} · {api.tfSpec.label}
        </span>
      </div>

      {/*
        Los dos se quedan montados y se oculta el inactivo. Desmontar el
        gráfico propio tiraría su zoom; desmontar TradingView borraría los
        dibujos del usuario.

        OJO con CÓMO se oculta. La primera versión usaba `display:none` y eso
        rompió el gráfico propio: mide su ancho con `clientWidth`, que en un
        elemento plegado vale 0, así que el lienzo se quedó con un búfer de
        300×150 estirado sobre 589×470 — borroso y con el eje inferior a cero.

        Por eso el inactivo se aparta con `invisible` y posición absoluta: no
        se ve ni recibe clics, pero CONSERVA SU TAMAÑO, y el observador de
        redimensionado sigue midiendo bien. El activo va en flujo normal para
        que sea él quien decida la altura del contenedor.
      */}
      <div className="relative mt-2 flex-1">
        {/* La mesa no lleva lienzo, así que se puede montar y desmontar sin coste. */}
        {tab === "trade" && <TradingPanel api={api} desk={desk} />}
        <div
          className={tab === "liq" ? "" : "invisible pointer-events-none absolute inset-0"}
          aria-hidden={tab !== "liq"}
        >
          <PriceChart api={api} />
        </div>
        {tvVisitada && (
          <div className={tab === "tv" ? "h-full" : "invisible pointer-events-none absolute inset-0"} aria-hidden={tab !== "tv"}>
            <TradingViewChart api={api} />
          </div>
        )}
      </div>
    </div>
  );
}
