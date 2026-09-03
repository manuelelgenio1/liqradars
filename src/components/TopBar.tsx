import { useNow } from "../hooks/useNow";
import type { MarketApi } from "../hooks/useMarket";
import { SYMBOLS } from "../lib/types";
import * as f from "../lib/format";
import { Dot } from "./ui";

function Logo() {
  return (
    <svg width="30" height="30" viewBox="0 0 34 34" fill="none" aria-hidden>
      <circle cx="17" cy="17" r="14" stroke="var(--color-up)" strokeWidth="1.4" opacity="0.8" />
      <circle cx="17" cy="17" r="8" stroke="var(--color-up)" strokeWidth="0.9" opacity="0.35" />
      <g style={{ transformOrigin: "17px 17px", animation: "sweep 4s linear infinite" }}>
        <path d="M17 17 L17 3 A14 14 0 0 1 29.1 10 Z" fill="var(--color-up)" opacity="0.28" />
        <line x1="17" y1="17" x2="17" y2="3" stroke="var(--color-up)" strokeWidth="1.5" />
      </g>
      <circle cx="17" cy="17" r="2" fill="var(--color-bright)" />
    </svg>
  );
}

export default function TopBar({ api }: { api: MarketApi }) {
  const now = useNow(1000);

  const live = api.health.binanceWs === "viva";
  const up = api.snap.change24h >= 0;

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--color-line)] bg-[rgba(10,14,23,0.88)] backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-[1680px] items-center gap-3 px-3 lg:px-5">
        <div className="flex shrink-0 items-center gap-2.5">
          <Logo />
          <div className="leading-none">
            <div className="font-display text-base font-bold tracking-[0.16em] text-[var(--color-white)]">
              LIQ<span style={{ color: "var(--color-up)" }}>RADAR</span>
            </div>
            <div className="mt-1 flex items-center gap-1.5 font-mono text-[8.5px] uppercase tracking-[0.14em] text-[var(--color-dim)]">
              <Dot live={live} tone={live ? "up" : "warn"} />
              {live ? "datos en vivo" : "reconectando"}
            </div>
          </div>
        </div>

        <nav className="slim ml-1 hidden items-center gap-1 overflow-x-auto md:flex">
          {SYMBOLS.map((s) => {
            const t = api.tickers[s.binance];
            const active = s.key === api.symbol;
            return (
              <button
                key={s.key}
                onClick={() => api.setSymbol(s.key)}
                className={`shrink-0 rounded-md border px-2.5 py-1.5 font-mono text-[11px] font-semibold transition-colors ${
                  active
                    ? "border-[rgba(33,212,160,0.5)] bg-[var(--color-up-soft)] text-[var(--color-up)]"
                    : "border-transparent text-[var(--color-muted)] hover:border-[var(--color-line)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-bright)]"
                }`}
              >
                {s.base}
                {t && (
                  <span className={`ml-1.5 text-[9px] ${t.changePct >= 0 ? "up" : "down"}`}>
                    {t.changePct >= 0 ? "▲" : "▼"}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2.5">
          {/*
            El botón marca lo que TÚ elegiste, no el respaldo. Si futuros no
            responde, se avisa aparte en vez de mover el selector a spot en
            silencio y dejarte creyendo que elegiste eso.
          */}
          <div className="hidden items-center gap-2 lg:flex">
            <div className="flex items-stretch overflow-hidden rounded-md border border-[var(--color-line)]">
              {(["perp", "spot"] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => api.setVenue(v)}
                  title={v === "perp" ? "Perpetuo de Binance Futuros" : "Mercado al contado"}
                  className={`px-2.5 py-1.5 font-mono text-[9.5px] font-bold uppercase tracking-[0.1em] transition-colors ${
                    api.venuePref === v
                      ? "bg-[var(--color-surface-3)] text-[var(--color-white)]"
                      : "text-[var(--color-dim)] hover:text-[var(--color-body)]"
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
            {api.restDegraded ? (
              <span
                className="tag tag-partial"
                title="Ni el REST ni el stream de Binance Futuros responden en tu red. Todo se sirve desde spot temporalmente. Se reintenta cada minuto y vuelve solo; tu preferencia sigue siendo PERP."
              >
                todo en spot · futuros caído
              </span>
            ) : api.wsDegraded ? (
              <span
                className="tag tag-partial"
                title="Tu red bloquea el WEBSOCKET de Binance Futuros, pero su REST funciona. Velas, profundidad, funding y OI siguen siendo de FUTUROS; el tick en vivo del precio lo sirve el PERPETUO de OKX. Ambos son perpetuos, así que no hay desfase de basis."
              >
                futuros · tick vía OKX
              </span>
            ) : null}
          </div>

          <div className="text-right leading-none">
            <div className="flex items-baseline justify-end gap-2">
              <span className={`tnum text-lg font-bold ${up ? "up" : "down"}`}>
                {f.price(api.price, api.spec.decimals)}
              </span>
              <span
                className={`tnum rounded border px-1.5 py-0.5 text-[10px] font-semibold ${
                  up
                    ? "border-[rgba(33,212,160,0.35)] bg-[var(--color-up-soft)] up"
                    : "border-[rgba(255,84,112,0.35)] bg-[var(--color-down-soft)] down"
                }`}
              >
                {f.pct(api.snap.change24h)}
              </span>
            </div>
            <div className="mt-1 font-mono text-[8.5px] uppercase tracking-[0.16em] text-[var(--color-dim)]">
              {api.spec.name} · {api.venue}
              {api.restDegraded && <span className="ml-1 text-[var(--color-warn)]">(respaldo)</span>}
            </div>
          </div>

          <button
            onClick={() => api.setPaused(!api.paused)}
            title={api.paused ? "Reanudar" : "Pausar actualizaciones"}
            className={`flex shrink-0 items-center gap-2 rounded-md border px-2.5 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] transition-colors ${
              api.paused
                ? "border-[rgba(255,181,69,0.45)] bg-[var(--color-warn-soft)] text-[var(--color-warn)]"
                : "border-[rgba(33,212,160,0.35)] bg-[var(--color-up-soft)] text-[var(--color-up)]"
            }`}
          >
            <Dot live={!api.paused} tone={api.paused ? "warn" : "up"} />
            <span className="hidden sm:inline">{api.paused ? "Pausado" : "En vivo"}</span>
          </button>

          <div className="hidden leading-none xl:block">
            <div className="tnum text-xs font-medium text-[var(--color-muted)]">{f.clockUTC(now)}</div>
            <div className="mt-1 font-mono text-[8.5px] uppercase tracking-[0.16em] text-[var(--color-dim)]">UTC</div>
          </div>
        </div>
      </div>

      <nav className="slim flex items-center gap-1 overflow-x-auto border-t border-[var(--color-line-soft)] px-3 py-2 md:hidden">
        {SYMBOLS.map((s) => (
          <button
            key={s.key}
            onClick={() => api.setSymbol(s.key)}
            className={`shrink-0 rounded border px-2.5 py-1 font-mono text-[11px] font-semibold ${
              s.key === api.symbol
                ? "border-[rgba(33,212,160,0.5)] bg-[var(--color-up-soft)] text-[var(--color-up)]"
                : "border-transparent text-[var(--color-muted)]"
            }`}
          >
            {s.base}
          </button>
        ))}
      </nav>
    </header>
  );
}
