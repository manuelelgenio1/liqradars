import type { MarketApi } from "../hooks/useMarket";
import type { ConfluenceState } from "../hooks/useConfluence";
import type { Trend } from "../lib/indicators";
import * as f from "../lib/format";
import { Bar, Card, Empty, Spark, Tag } from "./ui";

const TREND: Record<Trend, { label: string; color: string; arrow: string }> = {
  alcista: { label: "Alcista", color: "var(--color-up)", arrow: "▲" },
  bajista: { label: "Bajista", color: "var(--color-down)", arrow: "▼" },
  lateral: { label: "Lateral", color: "var(--color-warn)", arrow: "—" },
};

export default function AnalysisPanel({ api, confluence }: { api: MarketApi; confluence: ConfluenceState }) {
  const ind = api.indicators;
  if (!ind) {
    return (
      <Card title="Análisis técnico" sub="5 indicadores" delay={120}>
        <Empty>calculando indicadores…</Empty>
      </Card>
    );
  }

  const c = ind.consensus;
  const meta = TREND[c.trend];
  const adxNow = ind.adx.at(-1) ?? 0;
  const plusDI = ind.plusDI.at(-1) ?? 0;
  const minusDI = ind.minusDI.at(-1) ?? 0;
  const rsiNow = ind.rsi.at(-1) ?? 50;
  const strong = adxNow >= api.cfg.adxThreshold;
  const tail = 48;

  // la confluencia refuerza o descuenta la convicción del marco activo
  const aligned =
    confluence.dominant && confluence.total > 0 ? confluence.agree / confluence.total : null;
  const adjusted =
    aligned != null && c.trend !== "lateral"
      ? Math.max(0, Math.min(1, c.strength * (0.7 + 0.6 * (confluence.dominant === c.trend ? aligned : 1 - aligned))))
      : c.strength;

  return (
    <Card
      title="Análisis técnico"
      sub={`${api.tfSpec.label} · ${api.snap.warm.length} velas reales`}
      right={
        <Tag kind="real" title="Fórmulas de Wilder contrastadas contra referencia independiente: coinciden a 2 decimales">
          verificado
        </Tag>
      }
      delay={120}
    >
      {/* ---- veredicto ---- */}
      <div className="flex items-center gap-4 border-b border-[var(--color-line-soft)] px-4 py-4">
        <div
          className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border text-2xl"
          style={{ borderColor: `${meta.color}55`, background: `${meta.color}12`, color: meta.color }}
        >
          {meta.arrow}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--color-dim)]">
            veredicto ponderado
          </div>
          <div className="font-display text-xl font-bold uppercase tracking-wide" style={{ color: meta.color }}>
            {meta.label}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Bar
              value={adjusted}
              tone={c.trend === "alcista" ? "up" : c.trend === "bajista" ? "down" : "warn"}
              height={5}
            />
            <span className="tnum shrink-0 text-[11px] font-bold text-[var(--color-bright)]">
              {Math.round(adjusted * 100)}%
            </span>
          </div>
          {aligned != null && (
            <div className="mt-1.5 font-mono text-[8.5px] uppercase tracking-[0.12em] text-[var(--color-dim)]">
              ajustado por confluencia · {confluence.agree}/{confluence.total} marcos coinciden
            </div>
          )}
        </div>
      </div>

      {/* ---- confluencia multi-temporalidad ---- */}
      <div className="border-b border-[var(--color-line-soft)] px-4 py-3">
        <div className="mb-2 flex items-baseline justify-between font-mono text-[8.5px] uppercase tracking-[0.14em] text-[var(--color-dim)]">
          <span>Confluencia multi-temporalidad</span>
          {confluence.loading && <span className="opacity-60">cargando…</span>}
          {confluence.failed && <span className="text-[var(--color-warn)]">no disponible</span>}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {confluence.rows.map((r) => {
            const m = TREND[r.trend];
            const active = r.tf === api.tf;
            return (
              <button
                key={r.tf}
                onClick={() => api.setTf(r.tf)}
                title={`${r.label} · ${m.label} · convicción ${Math.round(r.strength * 100)}%`}
                className="flex items-center gap-1.5 rounded border px-2 py-1 font-mono text-[9px] font-bold transition-colors"
                style={{
                  borderColor: active ? "var(--color-warn)" : `${m.color}44`,
                  background: active ? "var(--color-warn-soft)" : `${m.color}10`,
                  color: m.color,
                }}
              >
                <span className={active ? "text-[var(--color-warn)]" : "text-[var(--color-muted)]"}>{r.tf}</span>
                {m.arrow}
              </button>
            );
          })}
          {!confluence.rows.length && !confluence.loading && (
            <span className="font-mono text-[9px] text-[var(--color-dim)]">sin datos</span>
          )}
        </div>
      </div>

      {/* ---- votos ---- */}
      <div className="flex-1">
        {c.votes.map((v) => {
          const vm = TREND[v.trend];
          return (
            <div
              key={v.name}
              className="flex items-center gap-2.5 border-b border-[var(--color-line-soft)] px-4 py-2 last:border-b-0"
              title={`peso ×${v.weight}`}
            >
              <span className="w-[76px] shrink-0 text-[10px] font-semibold text-[var(--color-body)]">{v.name}</span>
              <span className="tnum w-[96px] shrink-0 truncate text-[9px] text-[var(--color-dim)]">{v.detail}</span>
              <span
                className="flex w-[62px] shrink-0 items-center justify-center gap-1 rounded border px-1 py-0.5 font-mono text-[8px] font-bold uppercase"
                style={{ borderColor: `${vm.color}44`, background: `${vm.color}12`, color: vm.color }}
              >
                {vm.arrow} {vm.label}
              </span>
              <Bar
                value={v.strength}
                tone={v.trend === "alcista" ? "up" : v.trend === "bajista" ? "down" : "warn"}
                height={4}
              />
              <span className="tnum w-6 shrink-0 text-right text-[9px] text-[var(--color-dim)]">
                {Math.round(v.strength * 100)}
              </span>
            </div>
          );
        })}
      </div>

      {/* ---- métricas con historia ---- */}
      <div className="grid grid-cols-2 divide-x divide-[var(--color-line-soft)] border-t border-[var(--color-line-soft)] bg-[rgba(15,21,34,0.5)]">
        <div className="px-3 py-2.5">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[8.5px] uppercase tracking-[0.14em] text-[var(--color-dim)]">RSI</span>
            <Spark
              values={ind.rsi.slice(-tail)}
              color={rsiNow > 55 ? "var(--color-up)" : rsiNow < 45 ? "var(--color-down)" : "var(--color-muted)"}
              width={54}
              height={18}
            />
          </div>
          <div
            className="tnum mt-1 font-display text-[15px] font-bold"
            style={{
              // mismo criterio que la fila de voto: 45/55
              color: rsiNow > 55 ? "var(--color-up)" : rsiNow < 45 ? "var(--color-down)" : "var(--color-bright)",
            }}
          >
            {f.num(rsiNow, 1)}
          </div>
          {/*
            La casilla usaba la escala 30/70 (sobrecompra/sobreventa) mientras
            la fila de voto usa 45/55 (sesgo). Con un RSI de 42 se leía
            "BAJISTA" arriba y "zona neutra" aquí: dos etiquetas contradictorias
            para el mismo número. Ahora se muestran AMBAS escalas y cuál manda.
          */}
          <div className="mt-0.5 text-[8.5px] leading-tight text-[var(--color-dim)]">
            <span style={{ color: rsiNow > 55 ? "var(--color-up)" : rsiNow < 45 ? "var(--color-down)" : undefined }}>
              {rsiNow > 55 ? "sesgo alcista" : rsiNow < 45 ? "sesgo bajista" : "sin sesgo"}
            </span>
            <span className="opacity-70"> · 45/55</span>
            <br />
            <span className="opacity-70">
              {rsiNow > 70 ? "sobrecompra ≥70" : rsiNow < 30 ? "sobreventa ≤30" : "sin extremo (30-70)"}
            </span>
          </div>
        </div>

        <div className="px-3 py-2.5">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[8.5px] uppercase tracking-[0.14em] text-[var(--color-dim)]">ADX</span>
            <Spark
              values={ind.adx.slice(-tail)}
              color={strong ? "var(--color-warn)" : "var(--color-muted)"}
              width={54}
              height={18}
            />
          </div>
          <div
            className="tnum mt-1 font-display text-[15px] font-bold"
            style={{ color: strong ? "var(--color-warn)" : "var(--color-bright)" }}
          >
            {f.num(adxNow, 1)}
          </div>
          <div className="mt-0.5 flex items-baseline gap-1 text-[8.5px] text-[var(--color-dim)]">
            <span style={{ color: strong ? "var(--color-warn)" : undefined }}>
              {strong ? "tendencia" : "rango"} · {api.cfg.adxThreshold}
            </span>
            <span className="tnum">
              · <span className="up">{f.num(plusDI, 0)}</span>/<span className="down">{f.num(minusDI, 0)}</span> DI
            </span>
          </div>
        </div>
      </div>
    </Card>
  );
}
