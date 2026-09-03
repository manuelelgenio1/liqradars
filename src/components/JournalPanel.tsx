import { useEffect, useState } from "react";
import { useNow } from "../hooks/useNow";
import type { MarketApi } from "../hooks/useMarket";
import type { SignalsApi } from "../hooks/useSignals";
import { signalLife } from "../lib/signals";
import type { Outcome, Stats } from "../lib/signals";
import { timeframeOf } from "../lib/types";
import * as f from "../lib/format";
import { Card, Empty, Tag } from "./ui";

/* ============================================================
   Bitácora.

   La métrica principal es la ESPERANZA en R, no el porcentaje de aciertos:
   un 70 % de aciertos con pérdidas grandes pierde dinero, y eso hay que poder
   verlo de un vistazo. Al lado va siempre la moneda al aire con el mismo stop
   y objetivo — sin línea base, ningún porcentaje significa nada.
   ============================================================ */

const OUTCOME_META: Record<Outcome, { label: string; color: string }> = {
  abierta: { label: "abierta", color: "var(--color-muted)" },
  ganada: { label: "ganada", color: "var(--color-up)" },
  perdida: { label: "perdida", color: "var(--color-down)" },
  expirada: { label: "expirada", color: "var(--color-warn)" },
};

const VERDICT_META: Record<Stats["verdict"], { kind: "real" | "partial" | "none"; color: string }> = {
  VENTAJA: { kind: "real", color: "var(--color-up)" },
  PIERDE: { kind: "none", color: "var(--color-down)" },
  "SIN VENTAJA": { kind: "partial", color: "var(--color-warn)" },
  "MUESTRA CORTA": { kind: "none", color: "var(--color-muted)" },
  "SIN DATOS": { kind: "none", color: "var(--color-muted)" },
};

export default function JournalPanel({ api, sig }: { api: MarketApi; sig: SignalsApi }) {
  const now = useNow(2000);
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => {
    if (!confirmClear) return;
    const t = window.setTimeout(() => setConfirmClear(false), 4000);
    return () => window.clearTimeout(t);
  }, [confirmClear]);

  const s = sig.stats;
  const vm = VERDICT_META[s.verdict];

  return (
    <Card
      title="Bitácora de señales"
      sub={`${s.total} registradas · ${s.resolved} resueltas · ${s.open} abiertas`}
      right={
        <>
          <Tag kind={vm.kind}>{s.verdict}</Tag>
          <button
            onClick={() => (confirmClear ? sig.clear() : setConfirmClear(true))}
            className={`rounded border px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.1em] transition-colors ${
              confirmClear
                ? "border-[rgba(255,84,112,0.6)] bg-[var(--color-down-soft)] text-[var(--color-down)]"
                : "border-[var(--color-line)] text-[var(--color-dim)] hover:text-[var(--color-body)]"
            }`}
          >
            {confirmClear ? "¿seguro?" : "borrar"}
          </button>
        </>
      }
      delay={220}
      className="min-h-0"
    >
      {/* ---- veredicto ---- */}
      <div className="border-b border-[var(--color-line-soft)] px-4 py-3" style={{ background: `${vm.color}0d` }}>
        <p className="font-mono text-[9.5px] leading-relaxed text-[var(--color-muted)]">{s.note}</p>
      </div>

      {/* ---- métricas ---- */}
      <div className="grid grid-cols-2 divide-x divide-y divide-[var(--color-line-soft)] border-b border-[var(--color-line-soft)] sm:grid-cols-4 sm:divide-y-0">
        <div className="px-3 py-3">
          <div className="font-mono text-[8.5px] uppercase tracking-[0.14em] text-[var(--color-dim)]">
            Esperanza neta
          </div>
          <div
            className="tnum mt-1 font-display text-lg font-bold leading-none"
            style={{
              color: !Number.isFinite(s.expectancyNet)
                ? "var(--color-dim)"
                : s.expectancyNet > 0
                  ? "var(--color-up)"
                  : "var(--color-down)",
            }}
            title="Ya descontadas comisiones y deslizamiento. Es la única cifra que dice si esto gana dinero."
          >
            {Number.isFinite(s.expectancyNet) ? `${s.expectancyNet > 0 ? "+" : ""}${s.expectancyNet.toFixed(2)}R` : "—"}
          </div>
          <div className="mt-1 font-mono text-[8.5px] text-[var(--color-dim)]">
            bruto {Number.isFinite(s.expectancy) ? `${s.expectancy > 0 ? "+" : ""}${s.expectancy.toFixed(2)}R` : "—"} ·
            azar {Number.isFinite(s.controlExpectancy) ? `${s.controlExpectancy.toFixed(2)}R` : "—"}
            {Number.isFinite(s.tStat) && (
              <>
                {" · "}
                <span
                  style={{ color: s.tStat > 2 ? "var(--color-up)" : undefined }}
                  title="Cuántas desviaciones típicas se aparta de cero. Por debajo de 2, la diferencia cabe dentro del azar por muy grande que parezca."
                >
                  t {s.tStat.toFixed(2)}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="px-3 py-3">
          <div className="font-mono text-[8.5px] uppercase tracking-[0.14em] text-[var(--color-dim)]">Aciertos</div>
          <div className="tnum mt-1 font-display text-lg font-bold leading-none text-[var(--color-bright)]">
            {Number.isFinite(s.winRate) ? `${Math.round(s.winRate * 100)}%` : "—"}
          </div>
          <div className="mt-1 font-mono text-[8.5px] text-[var(--color-dim)]">
            azar {Number.isFinite(s.controlWinRate) ? `${Math.round(s.controlWinRate * 100)}%` : "—"}
          </div>
        </div>

        <div className="px-3 py-3">
          <div className="font-mono text-[8.5px] uppercase tracking-[0.14em] text-[var(--color-dim)]">Acumulado</div>
          <div
            className="tnum mt-1 font-display text-lg font-bold leading-none"
            style={{ color: s.totalRNet >= 0 ? "var(--color-up)" : "var(--color-down)" }}
            title={`Neto. En bruto serían ${s.totalR.toFixed(1)}R.`}
          >
            {s.resolved ? `${s.totalRNet > 0 ? "+" : ""}${s.totalRNet.toFixed(1)}R` : "—"}
          </div>
          <div className="mt-1 font-mono text-[8.5px] text-[var(--color-dim)]">
            {s.wins}G · {s.losses}P · {s.expired}E
            {Number.isFinite(s.avgCostR) && (
              <span className="text-[var(--color-down)]"> · −{s.avgCostR.toFixed(2)}R coste</span>
            )}
          </div>
        </div>

        <div className="px-3 py-3" title="Peor racha acumulada: cuánto habrías estado abajo en el peor momento">
          <div className="font-mono text-[8.5px] uppercase tracking-[0.14em] text-[var(--color-dim)]">Peor racha</div>
          <div className="tnum mt-1 font-display text-lg font-bold leading-none text-[var(--color-warn)]">
            {s.resolved ? `−${s.maxDrawdownR.toFixed(1)}R` : "—"}
          </div>
          <div className="mt-1 font-mono text-[8.5px] text-[var(--color-dim)]">
            PF {Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : "—"}
          </div>
        </div>
      </div>

      {/* ---- listado ---- */}
      <div className="grid grid-cols-[52px_44px_1fr_58px_50px_44px] gap-2 border-b border-[var(--color-line-soft)] px-3 py-1.5 font-mono text-[8.5px] uppercase tracking-[0.12em] text-[var(--color-dim)]">
        <span>Hora</span>
        <span>Lado</span>
        <span>Entrada → salida</span>
        <span>Estado</span>
        <span className="text-right">R</span>
        <span className="text-right">Azar</span>
      </div>

      <div className="slim max-h-[250px] min-h-[110px] flex-1 overflow-y-auto">
        {!sig.visible.length ? (
          <Empty>
            sin señales registradas para {api.spec.key}
            <br />
            <span className="normal-case tracking-normal opacity-70">
              se registran solas cuando el sesgo supera el umbral
            </span>
          </Empty>
        ) : (
          sig.visible.slice(0, 60).map((x) => {
            const om = OUTCOME_META[x.outcome];
            return (
              <div
                key={x.id}
                className="grid grid-cols-[52px_44px_1fr_58px_50px_44px] items-center gap-2 border-b border-[var(--color-line-soft)] px-3 py-[6px] transition-colors hover:bg-[var(--color-surface-2)]"
                title={x.reasons.map((r) => `${r.label}: ${r.detail}`).join("\n")}
              >
                <span className="tnum text-[9px] text-[var(--color-dim)]">{f.hhmmUTC(x.ts)}</span>
                <span
                  className="rounded border px-1 py-0.5 text-center font-mono text-[8px] font-bold uppercase"
                  style={{
                    borderColor: x.side === "long" ? "rgba(33,212,160,0.35)" : "rgba(255,84,112,0.35)",
                    color: x.side === "long" ? "var(--color-up)" : "var(--color-down)",
                  }}
                >
                  {x.side === "long" ? "L" : "S"}
                </span>
                <span className="tnum min-w-0 truncate text-[9.5px] text-[var(--color-muted)]">
                  {f.price(x.entry, api.spec.decimals)}
                  {x.exitPrice != null && ` → ${f.price(x.exitPrice, api.spec.decimals)}`}
                  {x.ambiguous && <span className="ml-1 text-[var(--color-warn)]" title="La vela contenía stop y objetivo: contada como pérdida">◆</span>}
                </span>
                {/*
                  Para una señal abierta, lo útil no es cuánto lleva sino
                  cuánto le queda: a las 48 velas se cierra a mercado. Se
                  muestra en ámbar cuando ha consumido más de tres cuartos de
                  su vida.
                */}
                <span
                  className="font-mono text-[8px] uppercase tracking-wider"
                  style={{
                    color:
                      x.outcome === "abierta"
                        ? signalLife(x.ts, timeframeOf(x.timeframe).minutes, now).progress > 0.75
                          ? "var(--color-warn)"
                          : om.color
                        : om.color,
                  }}
                  title={
                    x.outcome === "abierta"
                      ? `Nació a las ${f.hhmmUTC(x.ts)} UTC · vence a las ${f.hhmmUTC(
                          signalLife(x.ts, timeframeOf(x.timeframe).minutes, now).expiresAt
                        )}`
                      : `Nació a las ${f.hhmmUTC(x.ts)} UTC${x.resolvedTs ? ` · cerrada a las ${f.hhmmUTC(x.resolvedTs)}` : ""}`
                  }
                >
                  {x.outcome === "abierta"
                    ? `queda ${f.ago(now, signalLife(x.ts, timeframeOf(x.timeframe).minutes, now).expiresAt)}`
                    : om.label}
                </span>
                <span
                  className="tnum text-right text-[10px] font-bold"
                  style={{ color: (x.r ?? 0) > 0 ? "var(--color-up)" : (x.r ?? 0) < 0 ? "var(--color-down)" : "var(--color-dim)" }}
                >
                  {Number.isFinite(x.r) ? `${x.r! > 0 ? "+" : ""}${x.r!.toFixed(2)}` : "—"}
                </span>
                <span
                  className="tnum text-right text-[9px]"
                  style={{ color: (x.controlR ?? 0) > 0 ? "rgba(33,212,160,0.6)" : "rgba(255,84,112,0.6)" }}
                >
                  {Number.isFinite(x.controlR) ? `${x.controlR! > 0 ? "+" : ""}${x.controlR!.toFixed(2)}` : "—"}
                </span>
              </div>
            );
          })
        )}
      </div>

      <footer className="border-t border-[var(--color-line-soft)] px-4 py-2.5">
        <p className="font-mono text-[8px] leading-relaxed text-[var(--color-dim)]">
          Cada señal se registra al nacer con stop y objetivo fijos, y se resuelve por regla sobre velas reales. Si una
          vela contiene stop y objetivo (<span className="text-[var(--color-warn)]">◆</span>) no se sabe cuál llegó
          primero y se cuenta como <b className="text-[var(--color-down)]">pérdida</b>. La columna{" "}
          <b className="text-[var(--color-muted)]">Azar</b> es una moneda al aire con el mismo stop y objetivo: si tu
          esperanza no la supera, estas reglas no aportan nada. Y superarla tampoco basta: hace falta que la diferencia
          aguante una prueba de significación (<b className="text-[var(--color-muted)]">t&gt;2</b>), porque con pocas
          operaciones el azar produce ventajas aparentes muy grandes. Todas las cifras principales van{" "}
          <b className="text-[var(--color-muted)]">netas</b>: se descuenta un 0,14 % de ida y vuelta por comisión y
          deslizamiento, medido contra la distancia al stop — por eso un stop estrecho encarece tanto la operación.{" "}
          {s.ambiguous > 0 && `${s.ambiguous} ambiguas.`}
        </p>
      </footer>
    </Card>
  );
}
