import type { MarketApi } from "../hooks/useMarket";
import * as f from "../lib/format";
import { Card, DualBar, HealthTag, Tag } from "./ui";

/* ============================================================
   Estado del apalancamiento del mercado.

   Funding y open interest juntos cuentan algo que ninguno dice por separado:
   OI subiendo con funding caro es apalancamiento nuevo y frágil; OI cayendo es
   cierre forzado. Esa lectura se hace explícita en vez de dejar cuatro números
   sueltos para que el usuario los combine de cabeza.
   ============================================================ */

type Tone = "up" | "down" | "warn" | "neutral";

function readRegime(fundingPct: number, oiDeltaPct: number): { label: string; tone: Tone; detail: string } {
  const fr = Number.isFinite(fundingPct) ? fundingPct : 0;
  const oi = Number.isFinite(oiDeltaPct) ? oiDeltaPct : 0;
  if (!Number.isFinite(fundingPct) || !Number.isFinite(oiDeltaPct)) {
    return { label: "Sin datos", tone: "neutral", detail: "faltan funding u open interest" };
  }
  if (oi < -1.2) {
    return {
      label: "Desapalancamiento",
      tone: "warn",
      detail: "el OI cae: hay cierres forzados y el movimiento pierde combustible",
    };
  }
  if (fr > 0.03 && oi > 0.4) {
    return {
      label: "Largos aglomerados",
      tone: "down",
      detail: "funding caro con OI subiendo: subida frágil, riesgo de barrido de largos",
    };
  }
  if (fr < -0.03 && oi > 0.4) {
    return {
      label: "Cortos aglomerados",
      tone: "up",
      detail: "funding negativo con OI subiendo: bajada frágil, riesgo de squeeze",
    };
  }
  if (fr > 0.03) return { label: "Sesgo largo caro", tone: "down", detail: "los largos pagan prima: lado saturado" };
  if (fr < -0.03) return { label: "Sesgo corto caro", tone: "up", detail: "los cortos pagan prima: lado saturado" };
  if (oi > 0.8) {
    return { label: "Apalancamiento en expansión", tone: "neutral", detail: "entra dinero nuevo con funding neutro" };
  }
  return { label: "Equilibrado", tone: "neutral", detail: "sin aglomeración clara en ningún lado" };
}

const TONE_COLOR: Record<Tone, string> = {
  up: "var(--color-up)",
  down: "var(--color-down)",
  warn: "var(--color-warn)",
  neutral: "var(--color-muted)",
};

export default function MarketPanel({ api }: { api: MarketApi }) {
  const { funding, oi, longShort } = api.snap;
  const fundingRate = funding?.rate ?? NaN;
  const oiDelta = oi?.delta1hPct ?? NaN;
  const costPer10k = Number.isFinite(fundingRate) ? (fundingRate / 100) * 10_000 : NaN;
  const regime = readRegime(fundingRate, oiDelta);
  const longPct = longShort?.longPct ?? NaN;

  return (
    <Card
      title="Apalancamiento del mercado"
      sub="funding · open interest · posicionamiento"
      right={<Tag kind="real">binance</Tag>}
      delay={160}
    >
      {/* lectura combinada */}
      <div
        className="border-b border-[var(--color-line-soft)] px-4 py-3"
        style={{ background: `${TONE_COLOR[regime.tone]}0d` }}
      >
        <div className="font-mono text-[8.5px] uppercase tracking-[0.16em] text-[var(--color-dim)]">
          Régimen de apalancamiento
        </div>
        <div
          className="mt-1 font-display text-[15px] font-bold uppercase tracking-wide"
          style={{ color: TONE_COLOR[regime.tone] }}
        >
          {regime.label}
        </div>
        <p className="mt-1 font-mono text-[9px] leading-relaxed text-[var(--color-dim)]">{regime.detail}</p>
      </div>

      <div className="grid grid-cols-2 divide-x divide-[var(--color-line-soft)] border-b border-[var(--color-line-soft)]">
        <div className="px-4 py-3">
          <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--color-dim)]">Funding</div>
          <div className={`tnum mt-1.5 text-lg font-bold leading-none ${fundingRate >= 0 ? "up" : "down"}`}>
            {f.pct(fundingRate, 4)}
          </div>
          <div className="mt-1.5 font-mono text-[8.5px] leading-relaxed text-[var(--color-dim)]">
            {Number.isFinite(costPer10k)
              ? `por $10K ${costPer10k >= 0 ? "pagas" : "cobras"} ${f.usd(Math.abs(costPer10k), 2)}`
              : "sin dato"}
          </div>
          {funding && (
            <div className="tnum mt-1 font-mono text-[8.5px] text-[var(--color-dim)]">
              próximo en {f.countdown(funding.nextMs)}
            </div>
          )}
        </div>

        <div className="px-4 py-3">
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--color-dim)]">
              Open interest
            </span>
            <Tag kind="real" title="Histórico real de OI de Binance, no una estimación">
              real
            </Tag>
          </div>
          <div className="tnum mt-1.5 text-lg font-bold leading-none text-[var(--color-bright)]">
            {oi && Number.isFinite(oi.usd) ? f.usd(oi.usd, 2) : "—"}
          </div>
          <div className={`mt-1.5 tnum font-mono text-[9px] font-semibold ${oiDelta >= 0 ? "up" : "down"}`}>
            {f.pct(oiDelta)} en 1 h
          </div>
          <div className="mt-1 font-mono text-[8.5px] text-[var(--color-dim)]">contratos × precio de marca</div>
        </div>
      </div>

      {longShort && Number.isFinite(longPct) && (
        <div className="border-b border-[var(--color-line-soft)] px-4 py-3">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--color-dim)]">
              Cuentas long / short
            </span>
            <span className="tnum text-[10px] font-semibold text-[var(--color-body)]">
              {f.num(longShort.ratio, 2)}
            </span>
          </div>
          <DualBar
            left={longPct}
            right={100 - longPct}
            leftLabel={`largos ${longPct.toFixed(0)}%`}
            rightLabel={`cortos ${(100 - longPct).toFixed(0)}%`}
          />
          {Number.isFinite(longShort.topTraderRatio) && (
            <div className="mt-2 flex items-center justify-between border-t border-[var(--color-line-soft)] pt-2 font-mono text-[8.5px] uppercase tracking-[0.1em] text-[var(--color-dim)]">
              <span>Top traders · posiciones</span>
              <span className="tnum text-[var(--color-body)]">{f.num(longShort.topTraderRatio, 2)}</span>
            </div>
          )}
        </div>
      )}

      <div className="mt-auto px-4 py-3">
        <div className="mb-2 font-mono text-[8.5px] uppercase tracking-[0.16em] text-[var(--color-dim)]">
          Estado de las fuentes
        </div>
        <div className="flex flex-wrap gap-1.5">
          <HealthTag name="Binance REST" state={api.health.binanceRest} title="Velas, libro, funding, OI y ratios" />
          <HealthTag
            name="Binance WS"
            state={api.health.binanceWs}
            title="Precios en tiempo real. Detecta el socket abierto pero mudo y cae a spot."
          />
          <HealthTag name="OKX WS" state={api.health.okxWs} title="Liquidaciones completas" />
          <HealthTag
            name="OKX hist."
            state={api.health.okxRest}
            title="Backfill de 24 h de liquidaciones. Si falla, el mapa arranca vacío en vez de con un día de historial."
          />
          <HealthTag name="Bybit WS" state={api.health.bybitWs} title="Liquidaciones completas" />
        </div>
        <p className="mt-2.5 font-mono text-[8px] leading-relaxed text-[var(--color-dim)]">
          Nada en esta pantalla está simulado. Lo que no se ha medido aparece como{" "}
          <b className="text-[var(--color-muted)]">—</b>.
        </p>
      </div>
    </Card>
  );
}
