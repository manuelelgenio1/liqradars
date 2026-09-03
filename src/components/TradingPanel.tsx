import { useNow } from "../hooks/useNow";
import type { MarketApi } from "../hooks/useMarket";
import { DESK_TFS, type TradingDesk } from "../hooks/useTradingDesk";
import type { TradeLevels } from "../lib/levels";
import { ROUND_TRIP_COST_PCT } from "../lib/signals";
import { decimalsFor } from "../lib/universe";
import * as f from "../lib/format";
import { Tag } from "./ui";
import type { SignalState } from "../lib/desksignals";
import { ENFRIANDO_MAX_R, FRESCA_MAX_R } from "../lib/desksignals";

/* ============================================================
   Mesa de operaciones.

   Da lo que se necesita para decidir una entrada: dirección, entrada, stop,
   objetivo y —la columna que casi nadie enseña— cuánto de tu riesgo se lleva
   la comisión antes de que el mercado se mueva.

   Los niveles salen del ATR real de cada temporalidad. Eso es objetivo y
   comprobable: un stop de 1,2 ATR en 5 m es estrecho porque el ATR de 5 m es
   pequeño, y ahí la comisión pesa el 64 % del riesgo. En diario pesa el 2 %.

   La dirección es otra cosa, y conviene no confundirlas. Se midió sobre 28
   días y 409 sucesos: perdía 0,42R por operación. En 180 días, el marco de
   4 h igualó EXACTAMENTE a una moneda al aire. Así que la dirección es una
   HIPÓTESIS del consenso técnico, no un pronóstico fiable — y el panel lo
   dice sin adornos, porque callarlo sería lo deshonesto.
   ============================================================ */

const colorLado = (side: "long" | "short" | null) =>
  side === "long" ? "var(--color-up)" : side === "short" ? "var(--color-down)" : "var(--color-dim)";

const textoLado = (side: "long" | "short" | null) =>
  side === "long" ? "LARGO" : side === "short" ? "CORTO" : "—";

const colorCoste = (v: TradeLevels["costVerdict"]) =>
  v === "prohibitivo" ? "var(--color-down)" : v === "alto" ? "var(--color-warn)" : "var(--color-up)";

function Fila({ r, dec, activa, onClick }: { r: TradeLevels; dec: number; activa: boolean; onClick: () => void }) {
  if (!r.ready) {
    return (
      <div className="grid grid-cols-[58px_62px_1fr_1fr_1fr_54px_66px] items-center gap-2 border-b border-[var(--color-line-soft)] px-3 py-2 font-mono text-[9px] text-[var(--color-dim)]">
        <span className="font-bold text-[var(--color-muted)]">{r.label}</span>
        <span className="col-span-6">
          {r.candles === 0 ? "sin datos todavía" : `solo ${r.candles} velas · hacen falta 120`}
        </span>
      </div>
    );
  }

  return (
    <button
      onClick={onClick}
      title={`Cambiar el gráfico a ${r.label}\n\n${r.votes.map((v) => `${v.name}: ${v.trend}`).join("\n")}`}
      className={`grid w-full grid-cols-[58px_62px_1fr_1fr_1fr_54px_66px] items-center gap-2 border-b border-[var(--color-line-soft)] px-3 py-2 text-left transition-colors hover:bg-[var(--color-surface-2)] ${
        activa ? "bg-[var(--color-surface-2)]" : ""
      }`}
    >
      <span className="font-mono text-[10px] font-bold text-[var(--color-body)]">{r.label}</span>

      <span
        className="font-mono text-[9.5px] font-bold"
        style={{ color: colorLado(r.side) }}
        title={`Consenso ${r.trend} · fuerza ${Math.round(r.strength * 100)}%`}
      >
        {textoLado(r.side)}
        {r.side && <span className="ml-1 opacity-60">{Math.round(r.strength * 100)}</span>}
      </span>

      <span className="tnum text-[10px] text-[var(--color-bright)]">{f.price(r.entry, dec)}</span>
      <span className="tnum text-[10px] text-[var(--color-down)]">{f.price(r.stop, dec)}</span>
      <span className="tnum text-[10px] text-[var(--color-up)]">{f.price(r.target, dec)}</span>

      <span className="tnum text-right text-[9px] text-[var(--color-muted)]" title="Distancia al stop, en % del precio">
        {r.stopPct.toFixed(2)}%
      </span>

      <span
        className="tnum text-right text-[10px] font-bold"
        style={{ color: colorCoste(r.costVerdict) }}
        title={
          r.costVerdict === "prohibitivo"
            ? `La comisión se lleva el ${Math.round(r.costR * 100)} % de tu riesgo antes de que el mercado se mueva`
            : `La comisión se lleva el ${Math.round(r.costR * 100)} % del riesgo`
        }
      >
        −{r.costR.toFixed(2)}R
      </span>
    </button>
  );
}

const COLOR_FRESCURA: Record<SignalState["freshness"], string> = {
  fresca: "var(--color-up)",
  enfriando: "var(--color-warn)",
  tarde: "var(--color-down)",
  caducada: "var(--color-dim)",
};

const TEXTO_ENTRADA: Record<SignalState["freshness"], string> = {
  fresca: "SE PUEDE ENTRAR",
  enfriando: "SE ESTÁ ENFRIANDO",
  tarde: "YA ES TARDE",
  caducada: "CADUCADA",
};

/*
  Una señal viva, con su edad y —lo que de verdad decide— cuánto se ha alejado
  el precio de donde nació.

  Los niveles se fijaron al nacer y no se mueven. Cada punto que recorre el
  precio hacia el objetivo es beneficio que ya no vas a cobrar, mientras el
  stop sigue donde estaba. Por eso lo que se enseña es el R:R QUE TENDRÍAS
  AHORA, no el que tenía cuando apareció: es la misma señal y ya no es la
  misma operación.
*/
function SenalViva({ s, dec }: { s: SignalState; dec: number }) {
  const col = COLOR_FRESCURA[s.freshness];
  const largo = s.signal.side === "long";
  const progreso = Math.min(1, Math.max(0, s.movedR / ENFRIANDO_MAX_R));

  return (
    <div className="border-b border-[var(--color-line-soft)] px-3.5 py-2.5 last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-[10px] font-bold text-[var(--color-body)]">{s.signal.timeframe}</span>
        <span
          className="font-mono text-[10px] font-bold"
          style={{ color: largo ? "var(--color-up)" : "var(--color-down)" }}
        >
          {largo ? "LARGO" : "CORTO"}
        </span>
        <span className="tnum font-mono text-[9px] text-[var(--color-dim)]" title="Tiempo desde que apareció">
          hace {f.countdown(s.ageMs)}
        </span>
        <span className="ml-auto font-mono text-[9px] font-bold" style={{ color: col }}>
          {TEXTO_ENTRADA[s.freshness]}
        </span>
      </div>

      {/* cuánto se ha alejado el precio de la entrada original */}
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--color-surface-3)]">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${progreso * 100}%`, background: col }}
        />
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[8.5px] text-[var(--color-dim)]">
        <span title="Precio en el instante en que apareció la señal">
          nació en <b className="text-[var(--color-muted)]">{f.price(s.signal.entry, dec)}</b>
        </span>
        <span
          style={{ color: s.movedR > FRESCA_MAX_R ? col : undefined }}
          title="Cuánto ha recorrido el precio hacia el objetivo, en múltiplos de riesgo"
        >
          recorrido <b>{s.movedR >= 0 ? "+" : ""}{s.movedR.toFixed(2)}R</b>
        </span>
        <span title="Riesgo/beneficio que tendrías ENTRANDO AHORA, con los mismos stop y objetivo">
          R:R ahora <b style={{ color: s.rrNow < 1 ? "var(--color-down)" : "var(--color-muted)" }}>
            {Number.isFinite(s.rrNow) ? s.rrNow.toFixed(2) : "—"}
          </b>
        </span>
        <span title="Caduca a las 48 velas de su temporalidad">
          caduca en <b className="text-[var(--color-muted)]">{f.countdown(s.remainingMs)}</b>
        </span>
      </div>

      {s.freshness === "tarde" && (
        <p className="mt-1.5 font-mono text-[8px] leading-relaxed text-[var(--color-down)]">
          El precio ya recorrió {s.movedR.toFixed(2)}R desde la entrada. Entrando ahora arriesgarías más de lo que
          queda por ganar — la señal sigue viva, pero la operación buena ya pasó.
        </p>
      )}
    </div>
  );
}

export default function TradingPanel({ api, desk }: { api: MarketApi; desk: TradingDesk }) {
  const ahora = useNow(30_000);
  const dec = api.spec.decimals;
  const { align } = desk;

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto">
      {/* ---------- lectura conjunta ---------- */}
      <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-1)]">
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-line-soft)] px-3.5 py-2.5">
          <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-white)]">
            {api.spec.key}
          </span>
          <span className="tnum font-display text-sm font-bold text-[var(--color-bright)]">
            {f.price(api.price, dec)}
          </span>

          {align.dominant ? (
            <>
              <span
                className="font-mono text-[10px] font-bold"
                style={{ color: align.dominant === "alcista" ? "var(--color-up)" : "var(--color-down)" }}
              >
                {align.dominant === "alcista" ? "▲ SESGO LARGO" : "▼ SESGO CORTO"}
              </span>
              <span className="font-mono text-[9px] text-[var(--color-dim)]">
                {align.agree} de {align.total} marcos coinciden
              </span>
            </>
          ) : (
            <span className="font-mono text-[10px] text-[var(--color-dim)]">
              sin dirección dominante — los marcos se contradicen
            </span>
          )}

          <span className="ml-auto">
            {desk.loading ? (
              <Tag kind="partial">cargando</Tag>
            ) : desk.failed.length ? (
              <Tag kind="none">fallaron {desk.failed.join(", ")}</Tag>
            ) : (
              <Tag kind="real">6 marcos reales</Tag>
            )}
          </span>
        </div>

        {align.against.length > 0 && (
          <div className="border-b border-[var(--color-line-soft)] bg-[rgba(255,176,32,0.06)] px-3.5 py-2">
            <p className="font-mono text-[9px] leading-relaxed text-[var(--color-warn)]">
              <b>En contra: {align.against.join(", ")}.</b> Operar a favor del sesgo con estos marcos enfrente es una
              operación distinta —y peor— que la misma entrada con todo alineado.
            </p>
          </div>
        )}

        {align.cheapest && (
          <div className="border-b border-[var(--color-line-soft)] px-3.5 py-2">
            <p className="font-mono text-[9px] leading-relaxed text-[var(--color-muted)]">
              El marco más barato de los que van a favor es{" "}
              <b className="text-[var(--color-bright)]">{align.cheapest.label}</b>: la comisión se lleva el{" "}
              <b style={{ color: colorCoste(align.cheapest.costVerdict) }}>
                {Math.round(align.cheapest.costR * 100)} %
              </b>{" "}
              del riesgo. Es donde el coste estorba menos, no donde la señal acierte más.
            </p>
          </div>
        )}

        {/* ---------- señales vivas ---------- */}
        <div className="border-b border-[var(--color-line-soft)] px-3.5 py-1.5">
          <span className="font-mono text-[8px] uppercase tracking-[0.12em] text-[var(--color-dim)]">
            Señales vivas {desk.signals.length > 0 && `· ${desk.signals.length}`}
          </span>
        </div>
        {desk.signals.length === 0 ? (
          <div className="border-b border-[var(--color-line-soft)] px-3.5 py-2.5">
            <p className="font-mono text-[9px] leading-relaxed text-[var(--color-muted)]">
              Ninguna ahora mismo. Nace una cuando el consenso de alguna temporalidad{" "}
              <b className="text-[var(--color-bright)]">cambia de lado</b> — mientras siga diciendo lo mismo es la
              misma señal envejeciendo, no una nueva.
            </p>
          </div>
        ) : (
          desk.signals.map((s) => <SenalViva key={s.signal.id} s={s} dec={dec} />)
        )}

        {/* ---------- tabla de marcos ---------- */}
        <div className="grid grid-cols-[58px_62px_1fr_1fr_1fr_54px_66px] gap-2 border-b border-[var(--color-line-soft)] px-3 py-1.5 font-mono text-[8px] uppercase tracking-[0.1em] text-[var(--color-dim)]">
          <span>Marco</span>
          <span>Lado</span>
          <span>Entrada</span>
          <span>Stop</span>
          <span>Objetivo</span>
          <span className="text-right">Riesgo</span>
          <span className="text-right">Comisión</span>
        </div>

        {desk.rows.map((r) => (
          <Fila
            key={r.timeframe}
            r={r}
            dec={dec}
            activa={api.tf === r.timeframe}
            onClick={() => api.setTf(r.timeframe)}
          />
        ))}

        <div className="px-3.5 py-2.5">
          <p className="font-mono text-[8px] leading-relaxed text-[var(--color-dim)]">
            Todos los niveles salen del <b className="text-[var(--color-muted)]">ATR real</b> de cada marco: stop a 1,2
            ATR, objetivo a 2,0 ATR, R:R fijo de 1,67. Eso los adapta solos a la volatilidad de cada par y cada
            temporalidad — un stop del "1 %" fijo está equivocado casi siempre.{" "}
            <b className="text-[var(--color-muted)]">Comisión</b> es cuánto de tu riesgo se lleva el{" "}
            {ROUND_TRIP_COST_PCT.toFixed(2)} % de ida y vuelta: se mide contra la distancia al stop, así que en marcos
            cortos pesa muchísimo más. Pulsa una fila para llevar el gráfico a ese marco.
          </p>
        </div>
      </div>

      {/* ---------- escáner de los 20 con más volumen ---------- */}
      <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-1)]">
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-line-soft)] px-3.5 py-2.5">
          <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-white)]">
            Los 20 con más volumen
          </span>

          <div className="ml-auto flex items-stretch overflow-hidden rounded border border-[var(--color-line)]">
            {DESK_TFS.map((k) => (
              <button
                key={k}
                onClick={() => desk.setScanTf(k)}
                className={`px-1.5 py-1 font-mono text-[8.5px] font-bold transition-colors ${
                  desk.scanTf === k
                    ? "bg-[var(--color-surface-3)] text-[var(--color-white)]"
                    : "text-[var(--color-dim)] hover:text-[var(--color-body)]"
                }`}
              >
                {k}
              </button>
            ))}
          </div>

          <button
            onClick={desk.runScan}
            disabled={desk.scanning || !desk.universe.length}
            className={`rounded border px-2.5 py-1 font-mono text-[9px] font-bold uppercase tracking-[0.1em] transition-colors ${
              desk.scanning || !desk.universe.length
                ? "cursor-not-allowed border-[var(--color-line)] text-[var(--color-dim)]"
                : "border-[rgba(33,212,160,0.45)] bg-[var(--color-up-soft)] text-[var(--color-up)] hover:brightness-125"
            }`}
          >
            {desk.scanning ? `escaneando ${desk.scan.length}/20` : "escanear"}
          </button>
        </div>

        {desk.scan.length === 0 ? (
          <div className="px-3.5 py-4">
            <p className="font-mono text-[9.5px] leading-relaxed text-[var(--color-muted)]">
              {desk.universeLoading
                ? "Cargando el ranking por volumen…"
                : `${desk.universe.length} perpetuos ordenados por volumen real de 24 h. Pulsa escanear para calcular los niveles de todos en ${desk.scanTf}.`}
            </p>
            {!desk.universeLoading && desk.universe.length > 0 && (
              <p className="mt-2 font-mono text-[8.5px] leading-relaxed text-[var(--color-dim)]">
                Va a mano y no en bucle a propósito: son 20 peticiones por barrido, y hacerlo cada pocos segundos
                agotaría el límite de Binance.
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[70px_58px_1fr_1fr_1fr_54px_60px] gap-2 border-b border-[var(--color-line-soft)] px-3 py-1.5 font-mono text-[8px] uppercase tracking-[0.1em] text-[var(--color-dim)]">
              <span>Par</span>
              <span>Lado</span>
              <span>Entrada</span>
              <span>Stop</span>
              <span>Objetivo</span>
              <span className="text-right">24 h</span>
              <span className="text-right">Comisión</span>
            </div>

            {[...desk.scan]
              // Los que tienen lado primero, y dentro de esos los más baratos.
              .sort((a, b) => {
                const la = a.levels?.side ? 0 : 1;
                const lb = b.levels?.side ? 0 : 1;
                if (la !== lb) return la - lb;
                return (a.levels?.costR ?? 99) - (b.levels?.costR ?? 99);
              })
              .map((row) => {
                const L = row.levels;
                const d = decimalsFor(row.entry.lastPrice);
                return (
                  <button
                    key={row.entry.symbol}
                    onClick={() => api.setSymbol(row.entry.symbol)}
                    title={`Volumen 24 h: ${f.usd(row.entry.quoteVolume)}\nRecorrido del día: ${row.entry.rangePct.toFixed(2)} %\n\nPulsa para cambiar a este par`}
                    className="grid w-full grid-cols-[70px_58px_1fr_1fr_1fr_54px_60px] items-center gap-2 border-b border-[var(--color-line-soft)] px-3 py-1.5 text-left transition-colors last:border-b-0 hover:bg-[var(--color-surface-2)]"
                  >
                    <span className="font-mono text-[9.5px] font-bold text-[var(--color-body)]">
                      {row.entry.base}
                    </span>

                    {row.error || !L?.ready ? (
                      <span className="col-span-6 font-mono text-[8.5px] text-[var(--color-dim)]">
                        {row.error ? "no cargó" : "sin historial suficiente"}
                      </span>
                    ) : (
                      <>
                        <span className="font-mono text-[9px] font-bold" style={{ color: colorLado(L.side) }}>
                          {textoLado(L.side)}
                        </span>
                        <span className="tnum text-[9.5px] text-[var(--color-bright)]">{f.price(L.entry, d)}</span>
                        <span className="tnum text-[9.5px] text-[var(--color-down)]">{f.price(L.stop, d)}</span>
                        <span className="tnum text-[9.5px] text-[var(--color-up)]">{f.price(L.target, d)}</span>
                        <span
                          className="tnum text-right text-[9px]"
                          style={{
                            color:
                              row.entry.changePct >= 0 ? "var(--color-up)" : "var(--color-down)",
                          }}
                        >
                          {row.entry.changePct >= 0 ? "+" : ""}
                          {row.entry.changePct.toFixed(1)}%
                        </span>
                        <span
                          className="tnum text-right text-[9.5px] font-bold"
                          style={{ color: colorCoste(L.costVerdict) }}
                        >
                          −{L.costR.toFixed(2)}R
                        </span>
                      </>
                    )}
                  </button>
                );
              })}

            {desk.scannedAt > 0 && !desk.scanning && (
              <div className="px-3.5 py-2">
                <p className="font-mono text-[8px] text-[var(--color-dim)]">
                  Escaneado hace {f.ago(desk.scannedAt, ahora)} en {desk.scanTf} · ordenado por comisión más baja
                  entre los que tienen dirección. Pulsa un par para cambiar a él y ver sus seis marcos.
                </p>
              </div>
            )}
          </>
        )}
      </div>

      {/* ---------- lo que hay que saber antes de usarlo ---------- */}
      <div className="rounded-lg border border-[rgba(255,176,32,0.35)] bg-[rgba(255,176,32,0.05)] px-3.5 py-3">
        <p className="font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-[var(--color-warn)]">
          Lo que está medido y lo que no
        </p>
        <p className="mt-1.5 font-mono text-[8.5px] leading-relaxed text-[var(--color-muted)]">
          <b className="text-[var(--color-bright)]">Los niveles y la comisión son objetivos.</b> Salen del ATR real de
          cada marco y se pueden comprobar con una calculadora.
        </p>
        <p className="mt-1.5 font-mono text-[8.5px] leading-relaxed text-[var(--color-muted)]">
          <b className="text-[var(--color-warn)]">La dirección no está demostrada.</b> Estas mismas reglas se midieron
          sobre 28 días y 409 sucesos independientes: acertaban algo más que el azar (40,4 % contra 38,5 %) y aun así
          perdían 0,42R por operación, porque la comisión se llevaba 0,51R. En 180 días y marcos anchos, el de 4 h
          igualó <b>exactamente</b> a una moneda al aire: −0,049R los dos.
        </p>
        <p className="mt-1.5 font-mono text-[8.5px] leading-relaxed text-[var(--color-muted)]">
          Úsalo para saber <b className="text-[var(--color-bright)]">dónde poner los niveles</b> y{" "}
          <b className="text-[var(--color-bright)]">cuánto te cuesta cada marco</b>. La decisión de entrar es tuya, y la
          bitácora de la pestaña principal irá midiendo si aciertas.
        </p>
      </div>
    </div>
  );
}
