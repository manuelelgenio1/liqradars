import type { MarketApi } from "../hooks/useMarket";
import type { SignalsApi } from "../hooks/useSignals";
import * as f from "../lib/format";
import { Card, SplitBar, Tag } from "./ui";

/* ============================================================
   Señal en vivo.

   Muestra la puntuación SIEMPRE, aunque no llegue al umbral. Enseñar solo las
   señales que disparan oculta cuántas veces el sistema no tiene ni idea, que
   es información igual de valiosa.
   ============================================================ */

export default function SignalPanel({ api, sig }: { api: MarketApi; sig: SignalsApi }) {
  const abierta = sig.open[0] ?? null;
  const score = sig.liveScore;
  const dir = score > 0 ? "long" : "short";
  const armed = Math.abs(score) >= sig.threshold;

  return (
    <Card
      title="Señal de entrada"
      sub={`${api.spec.key} · ${api.tfSpec.label} · umbral ${Math.round(sig.threshold * 100)}`}
      right={
        <>
          <Tag kind={armed ? "real" : "none"}>
            {armed ? `${dir === "long" ? "LARGO" : "CORTO"} armado` : "sin señal"}
          </Tag>
          <button
            onClick={() => sig.setAutoEnabled(!sig.autoEnabled)}
            title="Generación automática de señales"
            className={`rounded border px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.1em] transition-colors ${
              sig.autoEnabled
                ? "border-[rgba(33,212,160,0.45)] bg-[var(--color-up-soft)] text-[var(--color-up)]"
                : "border-[var(--color-line)] text-[var(--color-dim)]"
            }`}
          >
            auto {sig.autoEnabled ? "on" : "off"}
          </button>
        </>
      }
      delay={60}
    >
      {/* ---- operación abierta ---- */}
      {abierta ? (
        <div
          className="border-b border-[var(--color-line-soft)] px-4 py-3"
          style={{ background: abierta.side === "long" ? "rgba(33,212,160,0.06)" : "rgba(255,84,112,0.06)" }}
        >
          <div className="flex items-center gap-2">
            <span
              className="rounded border px-2 py-0.5 font-display text-[13px] font-bold uppercase tracking-wide"
              style={{
                borderColor: abierta.side === "long" ? "rgba(33,212,160,0.5)" : "rgba(255,84,112,0.5)",
                color: abierta.side === "long" ? "var(--color-up)" : "var(--color-down)",
              }}
            >
              {abierta.side === "long" ? "LARGO" : "CORTO"}
            </span>
            <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--color-dim)]">
              abierta hace {f.ago(abierta.ts, Date.now())}
            </span>
            <span className="tnum ml-auto text-[10px] font-bold text-[var(--color-bright)]">
              R:R {f.num(abierta.rr, 2)}
            </span>
          </div>

          <div className="mt-3 grid grid-cols-3 gap-2">
            {[
              { l: "Entrada", v: abierta.entry, c: "var(--color-bright)" },
              { l: "Stop", v: abierta.stop, c: "var(--color-down)" },
              { l: "Objetivo", v: abierta.target, c: "var(--color-up)" },
            ].map((x) => (
              <div key={x.l}>
                <div className="font-mono text-[8.5px] uppercase tracking-[0.14em] text-[var(--color-dim)]">{x.l}</div>
                <div className="tnum mt-0.5 text-[13px] font-bold" style={{ color: x.c }}>
                  {f.price(x.v, api.spec.decimals)}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-2 font-mono text-[8.5px] leading-relaxed text-[var(--color-dim)]">
            Fijados al nacer la señal. No se mueven: si el stop se moviera, el historial dejaría de significar nada.
          </div>
        </div>
      ) : null}

      {/* ---- puntuación en vivo ---- */}
      <div className="px-4 py-3">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--color-dim)]">
            Sesgo actual · corto ↔ largo
          </span>
          <span
            className="tnum text-[12px] font-bold"
            style={{ color: armed ? (score > 0 ? "var(--color-up)" : "var(--color-down)") : "var(--color-muted)" }}
          >
            {score >= 0 ? "+" : ""}
            {Math.round(score * 100)}
          </span>
        </div>
        <SplitBar value={score} height={7} />
        <div className="mt-1.5 flex justify-between font-mono text-[8px] uppercase tracking-[0.1em] text-[var(--color-dim)]">
          <span className="down">corto</span>
          <span>{armed ? "umbral superado" : `necesita ${Math.round(sig.threshold * 100)}`}</span>
          <span className="up">largo</span>
        </div>
      </div>

      {/* ---- desglose ---- */}
      <div className="border-t border-[var(--color-line-soft)]">
        {sig.liveReasons.length ? (
          sig.liveReasons.map((r) => (
            <div
              key={r.label}
              className="flex items-center gap-2.5 border-b border-[var(--color-line-soft)] px-4 py-1.5 last:border-b-0"
              title={r.detail}
            >
              <span className="w-[104px] shrink-0 text-[10px] font-semibold text-[var(--color-body)]">{r.label}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[9px] text-[var(--color-dim)]">{r.detail}</span>
              <span
                className="tnum w-9 shrink-0 text-right text-[10px] font-bold"
                style={{ color: r.contribution > 0 ? "var(--color-up)" : "var(--color-down)" }}
              >
                {r.contribution > 0 ? "+" : ""}
                {Math.round(r.contribution * 100)}
              </span>
            </div>
          ))
        ) : (
          <div className="px-4 py-3 font-mono text-[9px] text-[var(--color-dim)]">
            Sin ingredientes suficientes todavía.
          </div>
        )}
      </div>

      <footer className="mt-auto border-t border-[var(--color-line-soft)] px-4 py-2.5">
        <p className="font-mono text-[8px] leading-relaxed text-[var(--color-dim)]">
          Los pesos de cada componente son una <b className="text-[var(--color-muted)]">hipótesis</b>, no una verdad
          conocida. Quien dictamina si valen algo es la bitácora de abajo — y puede perfectamente decir que no.
        </p>
      </footer>
    </Card>
  );
}
