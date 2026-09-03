import { useMemo, useState } from "react";
import type { MarketApi } from "../hooks/useMarket";
import { runBacktest, type BacktestResult, type TestLevel } from "../lib/validation";
import { Bar, Card, Tag } from "./ui";

/* ============================================================
   Laboratorio.

   Existe para responder con números a la pregunta incómoda: ¿los niveles que
   dibuja el radar sirven de algo? Compara contra un control emparejado por
   distancia, que es lo único que impide que el resultado mida geometría en
   vez de señal. Si sale INDETERMINADO, sale INDETERMINADO.
   ============================================================ */

const VERDICT_STYLE: Record<BacktestResult["verdict"], { color: string; kind: "real" | "partial" | "none" }> = {
  SEÑAL: { color: "var(--color-up)", kind: "real" },
  RUIDO: { color: "var(--color-down)", kind: "none" },
  INDETERMINADO: { color: "var(--color-warn)", kind: "partial" },
  "DATOS INSUFICIENTES": { color: "var(--color-muted)", kind: "none" },
};

export default function ValidationPanel({ api }: { api: MarketApi }) {
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [running, setRunning] = useState(false);

  const levels: TestLevel[] = useMemo(
    () => api.liqLevels.map((l) => ({ price: l.price, ts: l.lastTs, usd: l.usdLong + l.usdShort })),
    [api.liqLevels]
  );

  const candles = api.snap.warm.length ? api.snap.warm : api.snap.candles;
  const canRun = candles.length >= 60 && levels.length >= 5;

  const run = () => {
    setRunning(true);
    // fuera del hilo de pintado para que el botón no se quede congelado
    window.setTimeout(() => {
      setResult(runBacktest(candles, levels, { seed: api.symbol.length * 7919 + candles.length }));
      setRunning(false);
    }, 40);
  };

  const style = result ? VERDICT_STYLE[result.verdict] : null;

  return (
    <Card
      title="Laboratorio"
      sub={`¿los niveles ya liquidados vuelven a atraer al precio? · ${api.spec.key}`}
      right={
        <button
          onClick={run}
          disabled={!canRun || running}
          title={
            canRun
              ? "Ejecuta el backtest sobre el historial real"
              : "Hacen falta al menos 5 niveles registrados y 60 velas"
          }
          className={`rounded border px-2.5 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.1em] transition-colors ${
            canRun && !running
              ? "border-[rgba(33,212,160,0.45)] bg-[var(--color-up-soft)] text-[var(--color-up)] hover:brightness-125"
              : "cursor-not-allowed border-[var(--color-line)] text-[var(--color-dim)]"
          }`}
        >
          {running ? "calculando…" : "ejecutar"}
        </button>
      }
      delay={200}
    >
      {!result ? (
        <div className="px-4 py-5">
          <p className="font-mono text-[10px] leading-relaxed text-[var(--color-muted)]">
            Toma los niveles donde ya se liquidó a alguien y mide cuántas veces el precio vuelve a tocarlos, frente a{" "}
            <b className="text-[var(--color-bright)]">niveles al azar puestos a la misma distancia</b>.
          </p>
          <p className="mt-2 font-mono text-[9px] leading-relaxed text-[var(--color-dim)]">
            El emparejamiento por distancia es lo que hace válida la comparación: un nivel cercano se toca más que uno
            lejano por pura geometría, así que sin emparejar mediría distancia y no señal.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2 font-mono text-[9px] text-[var(--color-dim)]">
            <Tag kind={levels.length >= 5 ? "real" : "none"}>{levels.length} niveles</Tag>
            <Tag kind={candles.length >= 60 ? "real" : "none"}>{candles.length} velas</Tag>
            {!canRun && <span>· acumula más datos dejando la app abierta</span>}
          </div>
        </div>
      ) : (
        <>
          <div
            className="border-b border-[var(--color-line-soft)] px-4 py-3"
            style={{ background: `${style!.color}0d` }}
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-[8.5px] uppercase tracking-[0.16em] text-[var(--color-dim)]">
                Veredicto
              </span>
              <Tag kind={style!.kind}>{result.verdict}</Tag>
            </div>
            <p className="mt-2 font-mono text-[9.5px] leading-relaxed text-[var(--color-muted)]">{result.note}</p>
          </div>

          <div className="px-4 py-3">
            {[
              { label: "Niveles reales", value: result.hitRate, tone: "up" as const },
              { label: "Control al azar", value: result.controlHitRate, tone: "warn" as const },
              { label: "Reversión tras tocar", value: result.reversalRate, tone: "up" as const },
            ].map((row) => (
              <div key={row.label} className="mb-2.5 flex items-center gap-2.5 last:mb-0">
                <span className="w-[104px] shrink-0 font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--color-dim)]">
                  {row.label}
                </span>
                <Bar value={row.value} tone={row.tone} height={5} />
                <span className="tnum w-9 shrink-0 text-right text-[10px] font-bold text-[var(--color-bright)]">
                  {Number.isFinite(row.value) ? `${Math.round(row.value * 100)}%` : "—"}
                </span>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-2 divide-x divide-[var(--color-line-soft)] border-t border-[var(--color-line-soft)] bg-[rgba(15,21,34,0.5)]">
            <div className="px-3 py-2.5">
              <div className="font-mono text-[8.5px] uppercase tracking-[0.14em] text-[var(--color-dim)]">
                Ventaja
              </div>
              <div
                className="tnum mt-1 font-display text-[15px] font-bold"
                style={{ color: result.edge > 0 ? "var(--color-up)" : "var(--color-down)" }}
              >
                {Number.isFinite(result.edge) ? `${result.edge >= 0 ? "+" : ""}${(result.edge * 100).toFixed(1)} pts` : "—"}
              </div>
              <div className="mt-0.5 text-[8.5px] text-[var(--color-dim)]">frente al control</div>
            </div>
            <div className="px-3 py-2.5">
              <div className="font-mono text-[8.5px] uppercase tracking-[0.14em] text-[var(--color-dim)]">Muestra</div>
              <div className="tnum mt-1 font-display text-[15px] font-bold text-[var(--color-bright)]">
                {result.tested}
              </div>
              <div className="mt-0.5 text-[8.5px] text-[var(--color-dim)]">
                pruebas · {result.controls} controles
              </div>
            </div>
          </div>
        </>
      )}

      <footer className="mt-auto border-t border-[var(--color-line-soft)] px-4 py-2.5">
        <p className="font-mono text-[8px] leading-relaxed text-[var(--color-dim)]">
          Sin look-ahead: cada prueba usa solo niveles con marca de tiempo anterior a la vela evaluada. Un veredicto{" "}
          <b className="text-[var(--color-warn)]">INDETERMINADO</b> es un resultado legítimo y frecuente — significa que
          en esta ventana el radar no aporta ventaja medible, no que el test haya fallado.
        </p>
      </footer>
    </Card>
  );
}
