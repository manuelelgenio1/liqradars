import { useEffect, useRef, useState } from "react";
import type { MarketApi } from "../hooks/useMarket";
import { symbolOf } from "../lib/types";

/* ============================================================
   TradingView incrustado.

   Para lo que el gráfico propio no da: cien indicadores largos, herramientas
   de dibujo, Fibonacci, perfiles de volumen, comparativas. Es el widget
   oficial y gratuito de TradingView, sin clave ni cuenta.

   LO QUE NO PUEDE HACER, y por eso el gráfico propio sigue estando:
   va dentro de un iframe cerrado de otro dominio, así que NO se puede dibujar
   nada encima. Las liquidaciones, los clústeres de liquidez y el CVD que
   pintamos nosotros no existen aquí. De ahí las dos pestañas: esta para
   analizar precio, la otra para ver dónde está la liquidez.

   Se sincroniza con el símbolo y la temporalidad de la app, así que cambiar
   arriba cambia los dos gráficos a la vez.
   ============================================================ */

/** Nuestras claves → intervalos de TradingView. */
const TF_TO_TV: Record<string, string> = {
  "1m": "1",
  "5m": "5",
  "15m": "15",
  "1H": "60",
  "4H": "240",
  "1D": "D",
  "1W": "W",
};

/*
  `.P` es el perpetuo. Sin ese sufijo TradingView muestra el spot de Binance, y
  estarías analizando un instrumento distinto del que operas: el perpetuo tiene
  su propio precio, su funding y sus liquidaciones. Es una diferencia pequeña
  en el gráfico y grande en la cuenta.
*/
const tvSymbol = (key: string): string => `BINANCE:${symbolOf(key).binance}.P`;

const SCRIPT_SRC = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";

export default function TradingViewChart({ api }: { api: MarketApi }) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  const symbol = tvSymbol(api.spec.key);
  const interval = TF_TO_TV[api.tfSpec.key] ?? "60";

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    setFailed(false);

    // El widget no tiene API para cambiar de símbolo: se recrea entero.
    el.innerHTML = "";
    const mount = document.createElement("div");
    mount.style.height = "100%";
    el.appendChild(mount);

    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.type = "text/javascript";
    script.innerHTML = JSON.stringify({
      symbol,
      interval,
      theme: "dark",
      style: "1",
      locale: "es",
      timezone: "Etc/UTC",
      autosize: true,
      hide_side_toolbar: false, // las herramientas de dibujo son media razón de estar aquí
      allow_symbol_change: false, // el símbolo lo manda la app, para no descuadrar los paneles
      details: false,
      withdateranges: true,
      save_image: true,
      studies: ["STD;EMA", "STD;RSI", "STD;MACD"],
      backgroundColor: "rgba(10,14,23,1)",
      gridColor: "rgba(255,255,255,0.05)",
    });

    // Si TradingView no carga —red, bloqueador, corte— hay que decirlo en vez
    // de dejar un rectángulo negro que parece un gráfico vacío.
    script.onerror = () => setFailed(true);
    const aviso = window.setTimeout(() => {
      if (!mount.querySelector("iframe")) setFailed(true);
    }, 8000);

    mount.appendChild(script);

    return () => {
      window.clearTimeout(aviso);
      el.innerHTML = "";
    };
  }, [symbol, interval]);

  return (
    <div className="relative h-full min-h-[520px] w-full overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-1)]">
      <div ref={host} className="h-full w-full" />

      {failed && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[var(--color-surface-1)] px-6 text-center">
          <p className="font-mono text-[11px] font-bold text-[var(--color-warn)]">
            TradingView no ha cargado
          </p>
          <p className="max-w-sm font-mono text-[9.5px] leading-relaxed text-[var(--color-muted)]">
            Suele ser un bloqueador de anuncios o una red que filtra su dominio. El gráfico propio de la otra pestaña
            sigue funcionando: usa datos que descarga esta misma app, sin depender de nadie más.
          </p>
        </div>
      )}

      <div className="pointer-events-none absolute bottom-0 left-0 right-0 border-t border-[var(--color-line-soft)] bg-[rgba(10,14,23,0.92)] px-3 py-1.5">
        <p className="font-mono text-[8px] leading-relaxed text-[var(--color-dim)]">
          Widget oficial de TradingView · <b className="text-[var(--color-muted)]">{symbol}</b> perpetuo, sincronizado
          con el símbolo y la temporalidad de arriba. Aquí no se pueden dibujar las liquidaciones ni los clústeres de
          liquidez: eso está en la pestaña <b className="text-[var(--color-muted)]">Liquidez</b>.
        </p>
      </div>
    </div>
  );
}
