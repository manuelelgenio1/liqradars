import { useMemo, useState } from "react";
import type { MarketApi } from "../hooks/useMarket";
import { scoreIndicators, type ScoreReport } from "../lib/indicatorScore";
import * as f from "../lib/format";
import { Card, SplitBar, Tag } from "./ui";

/* ============================================================
   Acierto por indicador.

   La columna que manda es VENTAJA, no ACIERTOS. Si el precio sube el 60 % de
   las veces, un indicador que grite "alcista" siempre acertará el 60 % sin
   saber nada. La ventaja resta esa línea base y deja lo que de verdad aporta.
   ============================================================ */

export default function IndicatorScorePanel({ api }: { api: MarketApi }) {
  const [report, setReport] = useState<ScoreReport | null>(null);
  const [running, setRunning] = useState(false);
  const [horizon, setHorizon] = useState(12);

  const candles = api.snap.warm.length ? api.snap.warm : api.snap.candles;
  const canRun = candles.length >= 200;

  const run = useMemo(
    () => () => {
      setRunning(true);
      // fuera del hilo de pintado: recalcula los indicadores en cada punto
      window.setTimeout(() => {
        setReport(scoreIndicators(candles, api.cfg, api.tfSpec.minutes, { horizon }));
        setRunning(false);
      }, 40);
    },
    [candles, api.cfg, api.tfSpec.minutes, horizon]
  );

  return (
    <Card
      title="Acierto por indicador"
      sub={`¿cuándo dice "alcista", sube? · ${api.spec.key} · ${api.tfSpec.label}`}
      right={
        <>
          <div className="flex items-stretch overflow-hidden rounded border border-[var(--color-line)]">
            {[6, 12, 24].map((h) => (
              <button
                key={h}
                onClick={() => setHorizon(h)}
                title={`Mide el acierto ${h} velas después`}
                className={`px-2 py-1 font-mono text-[9px] font-bold transition-colors ${
                  horizon === h
                    ? "bg-[var(--color-surface-3)] text-[var(--color-white)]"
                    : "text-[var(--color-dim)] hover:text-[var(--color-body)]"
                }`}
              >
                {h}v
              </button>
            ))}
          </div>
          <button
            onClick={run}
            disabled={!canRun || running}
            className={`rounded border px-2.5 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.1em] transition-colors ${
              canRun && !running
                ? "border-[rgba(33,212,160,0.45)] bg-[var(--color-up-soft)] text-[var(--color-up)] hover:brightness-125"
                : "cursor-not-allowed border-[var(--color-line)] text-[var(--color-dim)]"
            }`}
          >
            {running ? "midiendo…" : "medir"}
          </button>
        </>
      }
      delay={240}
    >
      {!report ? (
        <div className="px-4 py-5">
          <p className="font-mono text-[10px] leading-relaxed text-[var(--color-muted)]">
            Recorre el historial recalculando los indicadores en cada punto —{" "}
            <b className="text-[var(--color-bright)]">usando solo velas anteriores</b> — y comprueba si su dirección
            acertó unas velas después.
          </p>
          <p className="mt-2 font-mono text-[9px] leading-relaxed text-[var(--color-dim)]">
            Cada indicador se compara contra su línea base: si el precio sube el 60 % de las veces, decir siempre
            "alcista" acierta un 60 % sin saber nada. Lo que cuenta es cuánto la supera.
          </p>
          <div className="mt-3 font-mono text-[9px] text-[var(--color-dim)]">
            <Tag kind={canRun ? "real" : "none"}>{candles.length} velas reales</Tag>
            {!canRun && <span className="ml-2">· hacen falta 200</span>}
          </div>
        </div>
      ) : report.records.length === 0 ? (
        <div className="px-4 py-5 font-mono text-[10px] text-[var(--color-muted)]">{report.note}</div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-line-soft)] px-4 py-2.5">
            <Tag kind={report.verdict === "LISTO" ? "real" : "partial"}>{report.verdict}</Tag>
            <span className="font-mono text-[9px] text-[var(--color-dim)]">
              {report.samples} puntos · horizonte {report.horizon} velas · el precio subió{" "}
              <b className="text-[var(--color-muted)]">{Math.round(report.upRate * 100)}%</b> de las veces
            </span>
          </div>

          <div className="grid grid-cols-[86px_1fr_46px_46px_54px] gap-2 border-b border-[var(--color-line-soft)] px-4 py-1.5 font-mono text-[8.5px] uppercase tracking-[0.12em] text-[var(--color-dim)]">
            <span>Indicador</span>
            <span>Ventaja sobre su línea base</span>
            <span className="text-right">Acierta</span>
            <span className="text-right">Base</span>
            <span className="text-right">Llamadas</span>
          </div>

          {report.records.map((r) => {
            const good = Number.isFinite(r.edge) && r.edge > 0.03;
            const bad = Number.isFinite(r.edge) && r.edge < -0.03;
            return (
              <div
                key={r.name}
                className="grid grid-cols-[86px_1fr_46px_46px_54px] items-center gap-2 border-b border-[var(--color-line-soft)] px-4 py-2 last:border-b-0"
                title={`${r.longCalls} alcistas · ${r.shortCalls} bajistas · ${r.neutrals} veces se abstuvo\nRecorrido medio a favor: ${f.num(r.avgMove, 2)} ATR`}
              >
                <span className="text-[10px] font-semibold text-[var(--color-body)]">{r.name}</span>
                <div className="flex items-center gap-2">
                  {/* escala ±20 puntos: más allá sería sospechoso */}
                  <SplitBar value={Number.isFinite(r.edge) ? r.edge / 0.2 : 0} height={5} />
                  <span
                    className="tnum w-11 shrink-0 text-right text-[10px] font-bold"
                    style={{
                      color: good ? "var(--color-up)" : bad ? "var(--color-down)" : "var(--color-dim)",
                    }}
                  >
                    {Number.isFinite(r.edge) ? `${r.edge > 0 ? "+" : ""}${(r.edge * 100).toFixed(1)}` : "—"}
                  </span>
                </div>
                <span className="tnum text-right text-[10px] text-[var(--color-bright)]">
                  {Number.isFinite(r.hitRate) ? `${Math.round(r.hitRate * 100)}%` : "—"}
                </span>
                <span className="tnum text-right text-[10px] text-[var(--color-dim)]">
                  {Number.isFinite(r.baseline) ? `${Math.round(r.baseline * 100)}%` : "—"}
                </span>
                <span className="tnum text-right text-[9px] text-[var(--color-dim)]">
                  {r.calls}
                  <span className="opacity-60"> / {r.neutrals}n</span>
                </span>
              </div>
            );
          })}

          <div className="border-t border-[var(--color-line-soft)] px-4 py-2.5">
            <p className="font-mono text-[9px] leading-relaxed text-[var(--color-muted)]">{report.note}</p>
          </div>
        </>
      )}

      <footer className="mt-auto border-t border-[var(--color-line-soft)] px-4 py-2.5">
        <p className="font-mono text-[8px] leading-relaxed text-[var(--color-dim)]">
          <b className="text-[var(--color-muted)]">Acierta</b> es el porcentaje bruto y engaña por sí solo.{" "}
          <b className="text-[var(--color-muted)]">Base</b> es lo que habría acertado sin ninguna habilidad, dada la
          dirección que predijo. La <b className="text-[var(--color-muted)]">ventaja</b> es la resta, y es lo único que
          mide aportación real. Sin look-ahead: cada voto se emite viendo solo el pasado.
        </p>
      </footer>
    </Card>
  );
}
