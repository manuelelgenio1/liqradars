import { useCallback, useState, type ReactNode } from "react";
import { useNow } from "../hooks/useNow";
import { useSignalAlarm } from "../hooks/useSignalAlarm";
import * as alarm from "../lib/alarm";
import type { MarketApi } from "../hooks/useMarket";
import { DESK_TFS, type TradingDesk } from "../hooks/useTradingDesk";
import type { TradeLevels } from "../lib/levels";
import { ENFRIANDO_MAX_R, FRESCA_MAX_R, type SignalState } from "../lib/desksignals";
import { ROUND_TRIP_COST_PCT } from "../lib/signals";
import { decimalsFor } from "../lib/universe";
import * as f from "../lib/format";
import { MIN_SAMPLE, type LedgerStats } from "../lib/deskledger";

/* ============================================================
   Mesa de operaciones.

   REDISEÑO. La versión anterior tenía todo a 8-10 px y en monoespaciada: el
   precio, su etiqueta y una nota al pie pesaban lo mismo, así que había que
   leerlo entero para encontrar el dato. Parecía una consola de depuración.

   Tres reglas ahora:
     · El tamaño indica importancia. Si algo es grande, se mira primero.
     · La monoespaciada solo para NÚMEROS — sirve para alinear columnas, no
       como efecto de "terminal".
     · Las explicaciones se pliegan. Están para cuando hagan falta, no
       compitiendo con los datos.

   QUÉ ENSEÑA Y QUÉ NO PROMETE. Los niveles salen del ATR real de cada marco
   y la comisión se mide contra la distancia al stop: objetivo y comprobable.
   La dirección es una hipótesis del consenso técnico que YA se midió y pierde
   dinero. El panel lo dice, plegado pero presente.
   ============================================================ */

const colorLado = (side: "long" | "short" | null) =>
  side === "long" ? "var(--color-up)" : side === "short" ? "var(--color-down)" : "var(--color-dim)";

const textoLado = (side: "long" | "short" | null) =>
  side === "long" ? "LARGO" : side === "short" ? "CORTO" : "—";

const colorCoste = (v: TradeLevels["costVerdict"]) =>
  v === "prohibitivo" ? "var(--color-down)" : v === "alto" ? "var(--color-warn)" : "var(--color-up)";

const COLOR_FRESCURA: Record<SignalState["freshness"], string> = {
  fresca: "var(--color-up)",
  enfriando: "var(--color-warn)",
  tarde: "var(--color-down)",
  caducada: "var(--color-dim)",
};

const TEXTO_ENTRADA: Record<SignalState["freshness"], string> = {
  fresca: "se puede entrar",
  enfriando: "se está enfriando",
  tarde: "ya es tarde",
  caducada: "caducada",
};

/**
 * Distancia de un nivel a la entrada, en porcentaje y con signo.
 *
 * El precio absoluto de un stop no dice nada por sí solo: 81.200 en BTC es un
 * pelo y en otro par sería un abismo. El porcentaje es lo que se traduce en
 * tamaño de posición.
 */
function distPct(entry: number, nivel: number): string {
  if (!(entry > 0) || !Number.isFinite(nivel)) return "—";
  const p = ((nivel - entry) / entry) * 100;
  return `${p >= 0 ? "+" : ""}${p.toFixed(2)}%`;
}

/** Un dato con su etiqueta encima, discreta. */
function Dato({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div title={title}>
      <div className="etiqueta">{label}</div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

// ---------------- señal viva ----------------

function SenalViva({ s, dec }: { s: SignalState; dec: number }) {
  const col = COLOR_FRESCURA[s.freshness];
  const largo = s.signal.side === "long";
  const progreso = Math.min(1, Math.max(0, s.movedR / ENFRIANDO_MAX_R));

  return (
    <div
      className="senal px-4 py-3.5"
      style={{ borderColor: s.freshness === "tarde" ? "rgba(255,84,112,0.3)" : undefined }}
    >
      <div className="flex items-center gap-3">
        <span
          className="rounded px-2 py-0.5 font-display text-[11px] font-bold tracking-wide"
          style={{
            color: largo ? "var(--color-up)" : "var(--color-down)",
            background: largo ? "var(--color-up-soft)" : "var(--color-down-soft)",
          }}
        >
          {largo ? "LARGO" : "CORTO"}
        </span>
        <span className="seccion">{s.signal.timeframe}</span>
        <span className="ml-auto font-display text-[11px] font-bold uppercase tracking-[0.1em]" style={{ color: col }}>
          {TEXTO_ENTRADA[s.freshness]}
        </span>
      </div>

      {/*
        LOS TRES NIVELES, que es lo que hace falta para operar. Antes esta
        tarjeta enseñaba "Nació en" y nada más: sabías que había señal pero no
        dónde poner el stop ni dónde salir, y había que ir a la tabla de abajo
        a buscarlo. La entrada ES el precio de nacimiento, así que enseñar las
        dos cosas era repetir el mismo dato con dos nombres.

        Bajo el stop y el objetivo va su distancia en porcentaje: el precio
        absoluto no dice si el stop está a un pelo o a un mundo, y esa
        distancia es la que decide el tamaño de la posición.
      */}
      <div className="mt-3 grid grid-cols-3 gap-x-4 rounded-md bg-[var(--color-surface-3)] px-3 py-2.5">
        <Dato label="Entrada" title="Precio en el instante en que apareció la señal. Los niveles se fijaron aquí y no se tocan.">
          <span className="dato-l">{f.price(s.signal.entry, dec)}</span>
        </Dato>
        <Dato label="Stop" title="Dónde se admite que la señal falló. Debajo, a qué distancia está en porcentaje.">
          <span className="dato-l" style={{ color: "var(--color-down)" }}>
            {f.price(s.signal.stop, dec)}
          </span>
          <div className="nota-sm">{distPct(s.signal.entry, s.signal.stop)}</div>
        </Dato>
        <Dato label="Objetivo" title="Dónde se recoge. Debajo, a qué distancia está en porcentaje.">
          <span className="dato-l" style={{ color: "var(--color-up)" }}>
            {f.price(s.signal.target, dec)}
          </span>
          <div className="nota-sm">{distPct(s.signal.entry, s.signal.target)}</div>
        </Dato>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-x-4 gap-y-3">
        <Dato label="Hace" title="Tiempo transcurrido desde que apareció">
          <span className="dato-l" style={{ color: "var(--color-muted)" }}>
            {f.countdown(s.ageMs)}
          </span>
        </Dato>
        <Dato label="Recorrido" title="Cuánto ha avanzado el precio hacia el objetivo, en múltiplos de riesgo">
          <span className="dato-l" style={{ color: s.movedR > FRESCA_MAX_R ? col : "var(--color-body)" }}>
            {s.movedR >= 0 ? "+" : ""}
            {s.movedR.toFixed(2)}R
          </span>
        </Dato>
        <Dato label="R:R ahora" title="Riesgo/beneficio ENTRANDO AHORA, con el stop y el objetivo originales">
          <span className="dato-l" style={{ color: s.rrNow < 1 ? "var(--color-down)" : "var(--color-bright)" }}>
            {Number.isFinite(s.rrNow) ? s.rrNow.toFixed(2) : "—"}
          </span>
        </Dato>
      </div>

      {/* cuánto se ha alejado el precio de donde nació */}
      <div className="mt-3 h-[3px] overflow-hidden rounded-full bg-[var(--color-surface-3)]">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${progreso * 100}%`, background: col }}
        />
      </div>

      <div className="mt-2 flex items-baseline justify-between gap-3">
        <span className="nota-sm">caduca en {f.countdown(s.remainingMs)}</span>
        {s.freshness === "tarde" && (
          <span className="nota-sm text-right" style={{ color: "var(--color-down)" }}>
            arriesgas más de lo que queda por ganar
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------- fila de temporalidad ----------------

function FilaMarco({ r, dec, activa, onClick }: { r: TradeLevels; dec: number; activa: boolean; onClick: () => void }) {
  if (!r.ready) {
    return (
      <div className="flex items-center gap-3 border-b border-[var(--color-line-soft)] px-4 py-3 last:border-b-0">
        <span className="seccion w-14 shrink-0">{r.timeframe}</span>
        <span className="nota-sm">
          {r.candles === 0 ? "sin datos todavía" : `solo ${r.candles} velas · hacen falta 120`}
        </span>
      </div>
    );
  }

  return (
    <button
      onClick={onClick}
      title={r.votes.map((v) => `${v.name}: ${v.trend}`).join("\n")}
      className={`flex w-full items-center gap-3 border-b border-[var(--color-line-soft)] px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-[var(--color-surface-2)] ${
        activa ? "bg-[var(--color-surface-2)]" : ""
      }`}
    >
      <span className="seccion w-14 shrink-0" style={{ color: activa ? "var(--color-white)" : undefined }}>
        {r.timeframe}
      </span>
      <span className="w-20 shrink-0 font-display text-[11px] font-bold" style={{ color: colorLado(r.side) }}>
        {textoLado(r.side)}
        {r.side && <span className="ml-1.5 font-normal opacity-50">{Math.round(r.strength * 100)}</span>}
      </span>

      <span className="dato-m ml-auto hidden w-20 text-right sm:inline" style={{ color: "var(--color-down)" }}>
        {f.price(r.stop, dec)}
      </span>
      <span className="dato-l w-24 shrink-0 text-right">{f.price(r.entry, dec)}</span>
      <span className="dato-m hidden w-20 shrink-0 text-right sm:inline" style={{ color: "var(--color-up)" }}>
        {f.price(r.target, dec)}
      </span>
      <span
        className="dato-l w-16 shrink-0 text-right"
        style={{ color: colorCoste(r.costVerdict) }}
        title={`La comisión se lleva el ${Math.round(r.costR * 100)} % de tu riesgo`}
      >
        −{r.costR.toFixed(2)}R
      </span>
    </button>
  );
}

// ---------------- registro de aciertos ----------------

const COLOR_VEREDICTO: Record<LedgerStats["verdict"], string> = {
  "SIN DATOS": "var(--color-dim)",
  "MUESTRA CORTA": "var(--color-muted)",
  "SIN VENTAJA": "var(--color-warn)",
  PIERDE: "var(--color-down)",
  VENTAJA: "var(--color-up)",
};

/*
  El libro de cuentas de la mesa.

  La mesa emite señales, así que rinde cuentas de ellas. Se cierran contra
  velas reales con una regla, no con un criterio, y arrastran su moneda al
  aire para que el porcentaje signifique algo.

  Se desglosa por temporalidad porque el coste no es el mismo: en 5 m la
  comisión se lleva medio R y en diario dos centésimas. Una sola cifra global
  escondería justo lo que más decide.
*/
function Registro({ desk }: { desk: TradingDesk }) {
  const s = desk.ledgerStats;
  const col = COLOR_VEREDICTO[s.verdict];

  return (
    <div className="rounded-xl border border-[var(--color-line)] bg-[rgba(15,21,34,0.55)]">
      <div className="flex items-center gap-3 border-b border-[var(--color-line-soft)] px-4 py-3">
        <span className="seccion">Aciertos de estas señales</span>
        <span className="ml-auto font-display text-[10px] font-bold uppercase tracking-[0.12em]" style={{ color: col }}>
          {s.verdict}
        </span>
        {s.total > 0 && (
          <button
            onClick={desk.clearLedger}
            className="etiqueta transition-colors hover:text-[var(--color-down)]"
            title="Borra el registro y empieza de cero"
          >
            borrar
          </button>
        )}
      </div>

      {s.total === 0 ? (
        <div className="px-4 py-4">
          <p className="nota">{s.note}</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-3.5 sm:grid-cols-4">
            <Dato label="Esperanza neta" title="Media de R por señal, ya descontada la comisión. Es LA cifra.">
              <span
                className="dato-l"
                style={{ color: s.expectancyNet > 0 ? "var(--color-up)" : "var(--color-down)" }}
              >
                {s.expectancyNet > 0 ? "+" : ""}
                {s.expectancyNet.toFixed(2)}R
              </span>
            </Dato>
            <Dato label="Aciertos" title="Porcentaje bruto. Engaña por sí solo: mira la esperanza.">
              <span className="dato-l">{Math.round(s.hitRate * 100)}%</span>
            </Dato>
            <Dato label="Moneda al aire" title="Lo que daban esos mismos niveles lanzando una moneda">
              <span className="dato-l" style={{ color: "var(--color-muted)" }}>
                {Number.isFinite(s.controlExpectancy)
                  ? `${s.controlExpectancy > 0 ? "+" : ""}${s.controlExpectancy.toFixed(2)}R`
                  : "—"}
              </span>
            </Dato>
            <Dato label="Cerradas" title={`${s.wins} ganadas · ${s.losses} perdidas · ${s.expired} expiradas`}>
              <span className="dato-l">
                {s.total}
                {s.total < MIN_SAMPLE && (
                  <span className="ml-1 text-[11px] font-normal text-[var(--color-dim)]">/ {MIN_SAMPLE}</span>
                )}
              </span>
            </Dato>
          </div>

          <div className="border-t border-[var(--color-line-soft)] px-4 py-2.5">
            <p className="nota-sm">{s.note}</p>
          </div>

          {desk.ledgerByTf.length > 1 && (
            <div className="border-t border-[var(--color-line-soft)]">
              <div className="px-4 pt-2.5">
                <span className="etiqueta">Por temporalidad</span>
              </div>
              {desk.ledgerByTf.map(({ timeframe, stats: t }) => (
                <div key={timeframe} className="flex items-center gap-3 px-4 py-2">
                  <span className="seccion w-14 shrink-0">{timeframe}</span>
                  <span className="dato-m w-14 shrink-0" style={{ color: "var(--color-dim)" }}>
                    {t.total} ops
                  </span>
                  <span className="dato-m ml-auto" style={{ color: "var(--color-dim)" }}>
                    −{t.avgCostR.toFixed(2)}R coste
                  </span>
                  <span
                    className="dato-l w-20 shrink-0 text-right"
                    style={{ color: t.expectancyNet > 0 ? "var(--color-up)" : "var(--color-down)" }}
                  >
                    {t.expectancyNet > 0 ? "+" : ""}
                    {t.expectancyNet.toFixed(2)}R
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <div className="border-t border-[var(--color-line-soft)] px-4 py-2.5">
        <p className="nota-sm">
          Cada señal se cierra contra velas reales con una regla, no con un criterio. Si una vela contiene stop y
          objetivo no se sabe cuál se tocó primero y cuenta como <b>pérdida</b>: la suposición conservadora evita
          inflar el resultado. El <b>porcentaje de aciertos engaña</b> — en este proyecto ha divergido de la esperanza
          una y otra vez.
        </p>
      </div>
    </div>
  );
}

// ---------------- panel ----------------

export default function TradingPanel({ api, desk }: { api: MarketApi; desk: TradingDesk }) {
  const ahora = useNow(30_000);
  const dec = api.spec.decimals;
  const { align } = desk;
  const [verPorque, setVerPorque] = useState(false);

  /*
    LA ALARMA SE ENCIENDE CON UN CLIC Y NO PUEDE SER DE OTRA FORMA. Ningún
    navegador deja sonar audio hasta que el usuario ha interactuado con la
    página, así que este clic hace dos cosas a la vez: guardar la preferencia
    y darle al navegador el gesto que exige. Si se activara sola al cargar, el
    primer aviso se perdería en silencio y parecería que no funciona.

    Se restaura apagada aunque estuviera activa: al recargar no hay gesto
    todavía. Prometer un aviso que el navegador va a bloquear es peor que no
    prometerlo.
  */
  const [alarmaOn, setAlarmaOn] = useState(false);
  const alternarAlarma = useCallback(() => {
    setAlarmaOn((prev) => {
      if (prev) return false;
      return alarm.unlock();
    });
  }, []);
  useSignalAlarm(desk.signals, alarmaOn);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto pb-2">
      {/* ---------- cabecera ---------- */}
      <div className="rounded-xl border border-[var(--color-line)] bg-[rgba(15,21,34,0.55)] px-5 py-4">
        <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
          <div>
            <div className="etiqueta">{api.tfSpec.label}</div>
            <div className="mt-1.5 flex items-baseline gap-3">
              <span className="font-display text-[15px] font-bold tracking-wide text-[var(--color-white)]">
                {api.spec.key}
              </span>
              <span className="dato-xl">{f.price(api.price, dec)}</span>
            </div>
          </div>

          <div className="ml-auto text-right">
            <div className="etiqueta">Sesgo</div>
            {align.dominant ? (
              <div className="mt-1.5">
                <span
                  className="font-display text-[15px] font-bold"
                  style={{ color: align.dominant === "alcista" ? "var(--color-up)" : "var(--color-down)" }}
                >
                  {align.dominant === "alcista" ? "▲ LARGO" : "▼ CORTO"}
                </span>
                <span className="nota-sm ml-2">
                  {align.agree} de {align.total}
                </span>
              </div>
            ) : (
              <div className="mt-1.5 nota-sm">los marcos se contradicen</div>
            )}
          </div>
        </div>

        {align.against.length > 0 && (
          <p className="nota-sm mt-3" style={{ color: "var(--color-warn)" }}>
            En contra: <b>{align.against.join(", ")}</b>. Operar con estos marcos enfrente es una operación distinta, y
            peor, que la misma entrada con todo alineado.
          </p>
        )}
      </div>

      {/* ---------- señales vivas ---------- */}
      <div>
        <div className="mb-2.5 flex items-baseline gap-2 px-1">
          <span className="seccion">Señales vivas</span>
          {desk.signals.length > 0 && (
            <span className="dato-m" style={{ color: "var(--color-dim)" }}>
              {desk.signals.length}
            </span>
          )}
          <button
            onClick={alternarAlarma}
            title={
              alarmaOn
                ? "Suena un aviso cuando nace una señal. Sube para largo, baja para corto."
                : "Activar el aviso sonoro. El navegador exige este clic: sin él no puede sonar nada."
            }
            className="ml-auto rounded border px-2.5 py-1 font-display text-[10px] font-bold uppercase tracking-[0.12em] transition-colors"
            style={{
              color: alarmaOn ? "var(--color-up)" : "var(--color-dim)",
              borderColor: alarmaOn ? "rgba(33,212,160,0.45)" : "var(--color-line)",
              background: alarmaOn ? "var(--color-up-soft)" : "transparent",
            }}
          >
            {alarmaOn ? "Alarma activada" : "Alarma apagada"}
          </button>
        </div>

        {desk.signals.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--color-line)] px-5 py-6 text-center">
            <p className="nota">
              Ninguna ahora mismo. Nace una cuando el consenso de alguna temporalidad{" "}
              <b className="text-[var(--color-bright)]">cambia de lado</b>.
            </p>
            <p className="nota-sm mt-1.5">
              Mientras siga diciendo lo mismo es la misma señal envejeciendo, no una nueva.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {desk.signals.map((s) => (
              <SenalViva key={s.signal.id} s={s} dec={dec} />
            ))}
          </div>
        )}
      </div>

      {/* ---------- registro de aciertos ---------- */}
      <Registro desk={desk} />

      {/* ---------- niveles por temporalidad ---------- */}
      <div className="rounded-xl border border-[var(--color-line)] bg-[rgba(15,21,34,0.55)]">
        <div className="flex items-center gap-3 border-b border-[var(--color-line-soft)] px-4 py-3">
          <span className="seccion">Niveles por temporalidad</span>
          <span className="etiqueta ml-auto hidden sm:inline">stop · entrada · objetivo · comisión</span>
        </div>

        {desk.rows.map((r) => (
          <FilaMarco
            key={r.timeframe}
            r={r}
            dec={dec}
            activa={api.tf === r.timeframe}
            onClick={() => api.setTf(r.timeframe)}
          />
        ))}
      </div>

      {/* ---------- escáner ---------- */}
      <div className="rounded-xl border border-[var(--color-line)] bg-[rgba(15,21,34,0.55)]">
        <div className="flex flex-wrap items-center gap-3 border-b border-[var(--color-line-soft)] px-4 py-3">
          <span className="seccion">Los 20 con más volumen</span>

          <div className="ml-auto flex items-stretch overflow-hidden rounded-md border border-[var(--color-line)]">
            {DESK_TFS.map((k) => (
              <button
                key={k}
                onClick={() => desk.setScanTf(k)}
                className={`px-2 py-1 font-mono text-[10px] font-semibold transition-colors ${
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
            className={`rounded-md border px-3 py-1.5 font-display text-[10px] font-bold uppercase tracking-[0.1em] transition-colors ${
              desk.scanning || !desk.universe.length
                ? "cursor-not-allowed border-[var(--color-line)] text-[var(--color-dim)]"
                : "border-[rgba(33,212,160,0.4)] bg-[var(--color-up-soft)] text-[var(--color-up)] hover:brightness-125"
            }`}
          >
            {desk.scanning ? `${desk.scan.length}/20` : "escanear"}
          </button>
        </div>

        {desk.scan.length === 0 ? (
          <div className="px-4 py-4">
            <p className="nota">
              {desk.universeLoading
                ? "Cargando el ranking por volumen…"
                : `${desk.universe.length} perpetuos de cripto ordenados por volumen real de 24 h.`}
            </p>
          </div>
        ) : (
          <>
            {[...desk.scan]
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
                    title={`Volumen 24 h: ${f.usd(row.entry.quoteVolume)}\nRecorrido del día: ${row.entry.rangePct.toFixed(2)} %`}
                    className="flex w-full items-center gap-3 border-b border-[var(--color-line-soft)] px-4 py-2.5 text-left transition-colors last:border-b-0 hover:bg-[var(--color-surface-2)]"
                  >
                    <span className="w-20 shrink-0 font-display text-[12px] font-bold text-[var(--color-body)]">
                      {row.entry.base}
                    </span>

                    {row.error || !L?.ready ? (
                      <span className="nota-sm">{row.error ? "no cargó" : "sin historial"}</span>
                    ) : (
                      <>
                        <span
                          className="w-16 shrink-0 font-display text-[11px] font-bold"
                          style={{ color: colorLado(L.side) }}
                        >
                          {textoLado(L.side)}
                        </span>
                        <span className="dato-m ml-auto">{f.price(L.entry, d)}</span>
                        <span
                          className="dato-m w-14 shrink-0 text-right"
                          style={{ color: row.entry.changePct >= 0 ? "var(--color-up)" : "var(--color-down)" }}
                        >
                          {row.entry.changePct >= 0 ? "+" : ""}
                          {row.entry.changePct.toFixed(1)}%
                        </span>
                        <span className="dato-l w-16 shrink-0 text-right" style={{ color: colorCoste(L.costVerdict) }}>
                          −{L.costR.toFixed(2)}R
                        </span>
                      </>
                    )}
                  </button>
                );
              })}

            {desk.scannedAt > 0 && !desk.scanning && (
              <div className="px-4 py-2.5">
                <p className="nota-sm">
                  Escaneado hace {f.ago(desk.scannedAt, ahora)} en {desk.scanTf} · ordenado por comisión más baja.
                </p>
              </div>
            )}
          </>
        )}
      </div>

      {/* ---------- el porqué, plegado ---------- */}
      <div className="rounded-xl border border-[rgba(255,181,69,0.28)] bg-[rgba(255,181,69,0.04)]">
        <button onClick={() => setVerPorque(!verPorque)} className="flex w-full items-center gap-2 px-4 py-3 text-left">
          <span className="seccion" style={{ color: "var(--color-warn)" }}>
            Qué está medido y qué no
          </span>
          <span className="ml-auto font-mono text-[13px] text-[var(--color-dim)]">{verPorque ? "−" : "+"}</span>
        </button>

        {verPorque && (
          <div className="border-t border-[rgba(255,181,69,0.18)] px-4 py-3.5">
            <p className="nota">
              <b className="text-[var(--color-bright)]">Los niveles y la comisión son objetivos.</b> Salen del ATR real
              de cada marco —stop a 1,2 ATR, objetivo a 2,0— y se comprueban con una calculadora. La comisión de{" "}
              {ROUND_TRIP_COST_PCT.toFixed(2)} % se mide contra la distancia al stop, por eso en marcos cortos pesa
              tantísimo más.
            </p>
            <p className="nota mt-2.5" style={{ color: "var(--color-warn)" }}>
              <b>La dirección no está demostrada.</b> Estas reglas se midieron sobre 28 días y 409 sucesos
              independientes: acertaban algo más que el azar (40,4 % contra 38,5 %) y aun así perdían 0,42R por
              operación. En 180 días, el marco de 4 h igualó exactamente a una moneda al aire.
            </p>
            <p className="nota-sm mt-2.5">
              Úsalo para saber dónde poner los niveles y cuánto te cuesta cada marco. La decisión de entrar es tuya, y
              la bitácora irá midiendo si aciertas.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
