import { useNow } from "../hooks/useNow";
import type { MarketApi } from "../hooks/useMarket";
import type { SignalsApi } from "../hooks/useSignals";
import * as f from "../lib/format";
import { Card, SplitBar, Tag } from "./ui";
import { costInR, costVerdict, MAX_BARS, ROUND_TRIP_COST_PCT, signalLife } from "../lib/signals";
import { timeframeOf } from "../lib/types";

/* ============================================================
   Señal en vivo.

   Muestra la puntuación SIEMPRE, aunque no llegue al umbral. Enseñar solo las
   señales que disparan oculta cuántas veces el sistema no tiene ni idea, que
   es información igual de valiosa.
   ============================================================ */

export default function SignalPanel({ api, sig }: { api: MarketApi; sig: SignalsApi }) {
  const abierta = sig.open[0] ?? null;
  const ahora = useNow(10_000);
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
            <span
              className="font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--color-dim)]"
              title={`Nació el ${f.clockUTC(abierta.ts)} UTC`}
            >
              hace {f.ago(abierta.ts, ahora)}
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

          {/* ---- cuánto le queda ---- */}
          {(() => {
            const v = signalLife(abierta.ts, timeframeOf(abierta.timeframe).minutes, ahora);
            const apurada = v.progress > 0.75;
            const col = v.expired
              ? "var(--color-dim)"
              : apurada
                ? "var(--color-warn)"
                : "var(--color-muted)";
            return (
              <div className="mt-3">
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <span className="font-mono text-[8.5px] uppercase tracking-[0.14em] text-[var(--color-dim)]">
                    {v.expired ? "Vencida" : "Le queda"}
                  </span>
                  <span className="tnum font-mono text-[11px] font-bold" style={{ color: col }}>
                    {v.expired ? "—" : f.countdown(v.remainingMs)}
                  </span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-[var(--color-surface-3)]">
                  <div
                    className="h-full rounded-full transition-all duration-700"
                    style={{ width: `${v.progress * 100}%`, background: col }}
                  />
                </div>
                <p className="mt-1 font-mono text-[8px] leading-relaxed text-[var(--color-dim)]">
                  Nació a las <b className="text-[var(--color-muted)]">{f.hhmmUTC(abierta.ts)}</b> UTC y vence a las{" "}
                  <b className="text-[var(--color-muted)]">{f.hhmmUTC(v.expiresAt)}</b>: {MAX_BARS} velas de{" "}
                  {abierta.timeframe}. Si para entonces no ha tocado stop ni objetivo, se cierra a mercado y cuenta
                  igual en la bitácora — no se esconde.
                </p>
              </div>
            );
          })()}

          {(() => {
            const c = abierta.costR ?? costInR(abierta.entry, abierta.stop);
            const v = costVerdict(c);
            const col =
              v === "prohibitivo" ? "var(--color-down)" : v === "alto" ? "var(--color-warn)" : "var(--color-muted)";
            return (
              <div
                className="mt-3 rounded border px-2.5 py-2"
                style={{ borderColor: col, background: "rgba(255,255,255,0.02)" }}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-mono text-[8.5px] uppercase tracking-[0.14em] text-[var(--color-dim)]">
                    Comisión de esta operación
                  </span>
                  <span className="tnum text-[12px] font-bold" style={{ color: col }}>
                    −{Number.isFinite(c) ? c.toFixed(2) : "?"}R
                  </span>
                </div>
                <p className="mt-1 font-mono text-[8px] leading-relaxed" style={{ color: col }}>
                  {v === "prohibitivo" ? (
                    <>
                      El stop está tan cerca que la comisión se lleva el{" "}
                      <b>{Math.round(c * 100)} %</b> de tu riesgo antes de que el mercado se mueva. Con estos números
                      hace falta acertar muchísimo solo para empatar.
                    </>
                  ) : v === "alto" ? (
                    <>
                      La comisión se lleva el <b>{Math.round(c * 100)} %</b> del riesgo. Marcos más largos tienen el
                      stop más ancho y el coste pesa mucho menos.
                    </>
                  ) : (
                    <>El coste pesa poco frente al riesgo asumido: el stop es lo bastante ancho.</>
                  )}
                </p>
              </div>
            );
          })()}

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
          conocida. Quien dictamina si valen algo es la bitácora de abajo.
        </p>
        <p className="mt-2 font-mono text-[8px] leading-relaxed text-[var(--color-warn)]">
          <b>Ya se midió, y el resultado fue malo.</b> Sobre 28 días, 6 símbolos y 409 sucesos independientes, estas
          reglas acertaron algo más que el azar (40,4 % contra 38,5 %) y aun así perdieron{" "}
          <b>0,42R por operación</b>: la comisión se llevaba 0,51R. Por temporalidad, el coste medio fue −0,64R en 5m,
          −0,32R en 15m y −0,15R en 1H. La conclusión no es que la señal sea inútil, sino que{" "}
          <b>en marcos cortos la aritmética del coste no deja margen</b> —{ROUND_TRIP_COST_PCT.toFixed(2)} % de ida y
          vuelta contra un stop de 1,2 ATR— pagando comisión de mercado.
        </p>
      </footer>
    </Card>
  );
}
