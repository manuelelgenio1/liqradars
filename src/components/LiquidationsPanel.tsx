import { useMemo, useState } from "react";
import { useNow } from "../hooks/useNow";
import type { MarketApi } from "../hooks/useMarket";
import { countsInTotals, sideBalance } from "../lib/liqstore";
import type { Provenance } from "../lib/types";
import * as f from "../lib/format";
import { Card, DualBar, Empty, Tag } from "./ui";

/* ============================================================
   Liquidaciones.

   Antes esto era una lista y cuatro números. Una lista no deja ver lo único
   que importa de verdad: si las liquidaciones llegan a goteo o de golpe.
   Ahora lo primero es un histograma temporal de los últimos 60 min, partido
   por lado, con detección de cascada.

   LO QUE SE MIDIÓ Y HAY QUE DECIR AQUÍ.

   Este panel es el corazón visual de la app, y la tesis que lo justificaba
   —que el precio va hacia los cúmulos de liquidez— se puso a prueba con
   posiciones reales de la cámara de compensación de Hyperliquid y NO se
   sostiene: −0,177 % neto, t = −0,71, con muestra suficiente para haber
   detectado cualquier efecto rentable.

   Y se sabe además por qué: los que revientan no vuelven. Elegidos en la
   primera mitad del mes, los reincidentes reaparecen en la segunda un 9,6 %
   frente al 5,0 % del resto — 1,49σ, indistinguible del azar. El mapa
   describe un accidente irrepetible, no un hábito.

   Sigue siendo un dato REAL y útil para saber qué está pasando ahora mismo.
   No es un pronóstico, y el panel lo dice.
   ============================================================ */

const EXCHANGE_LABEL: Partial<Record<Provenance, string>> = {
  okx: "OKX",
  bybit: "Bybit",
  binance: "Binance",
};

const BUCKETS = 30;
const CASCADE_MIN_USD = 250_000;
const WINDOW_MIN = 60;

type Filter = "todas" | "long" | "short" | "grandes";

export default function LiquidationsPanel({ api }: { api: MarketApi }) {
  const now = useNow(2000);
  const [filter, setFilter] = useState<Filter>("todas");

  const { liqEvents, liqTotals, liqRate, spec } = api;
  const balance = sideBalance(liqTotals);

  // histograma de los últimos 60 min, en cubos de 2 min
  const histogram = useMemo(() => {
    const width = (WINDOW_MIN * 60_000) / BUCKETS;
    const from = now - WINDOW_MIN * 60_000;
    const buckets = Array.from({ length: BUCKETS }, () => ({ long: 0, short: 0, n: 0 }));
    for (const e of liqEvents) {
      if (e.ts < from || !countsInTotals(e.exchange)) continue;
      const i = Math.min(BUCKETS - 1, Math.floor((e.ts - from) / width));
      if (i < 0) continue;
      buckets[i].n += 1;
      if (e.side === "long") buckets[i].long += e.usd;
      else buckets[i].short += e.usd;
    }
    const max = Math.max(...buckets.map((b) => b.long + b.short), 1);
    // Cascada = un intervalo concentra >35 % del nocional de la hora Y esa hora
    // mueve al menos CASCADE_MIN_USD. Sin el mínimo absoluto, con $5K en toda
    // la hora cualquier evento suelto disparaba el aviso: gritar "cascada"
    // sobre ruido lo vuelve inútil.
    const totalUsd = buckets.reduce((s, b) => s + b.long + b.short, 0);
    const cascadeIdx =
      totalUsd >= CASCADE_MIN_USD
        ? buckets.findIndex((b) => (b.long + b.short) / totalUsd > 0.35)
        : -1;
    return { buckets, max, totalUsd, cascadeIdx, width, from };
  }, [liqEvents, now]);

  const biggest = useMemo(
    () => liqEvents.filter((e) => countsInTotals(e.exchange)).reduce<null | (typeof liqEvents)[number]>(
      (m, e) => (!m || e.usd > m.usd ? e : m),
      null
    ),
    [liqEvents]
  );

  const rows = useMemo(() => {
    let base = liqEvents;
    if (filter === "long" || filter === "short") base = base.filter((e) => e.side === filter);
    if (filter === "grandes") base = base.filter((e) => e.usd >= 50_000);
    return base.slice(0, 50);
  }, [liqEvents, filter]);

  const counts = useMemo(
    () => ({
      todas: liqEvents.length,
      long: liqEvents.filter((e) => e.side === "long").length,
      short: liqEvents.filter((e) => e.side === "short").length,
      grandes: liqEvents.filter((e) => e.usd >= 50_000).length,
    }),
    [liqEvents]
  );

  const windowLabel = liqTotals.oldestTs > 0 ? `${f.ago(liqTotals.oldestTs, now)} de registro` : "sin registro";

  return (
    <Card
      title="Liquidaciones reales"
      sub={`${spec.key} · OKX + Bybit agregados · ${windowLabel}`}
      right={
        <>
          {histogram.cascadeIdx >= 0 && (
            <Tag kind="partial" title="Un solo intervalo concentra más del 35 % del nocional de la última hora, y esa hora supera los 250 000 $">
              cascada detectada
            </Tag>
          )}
          <Tag kind={liqTotals.hasCompleteSource ? "real" : "none"}>{liqRate.toFixed(1)}/min</Tag>
        </>
      }
      delay={80}
      className="min-h-0"
    >
      {/* ---- histograma temporal ---- */}
      <div className="border-b border-[var(--color-line-soft)] px-4 py-3">
        <div className="mb-2 flex items-baseline justify-between font-mono text-[8.5px] uppercase tracking-[0.14em] text-[var(--color-dim)]">
          <span>Ritmo · última hora</span>
          <span>{f.usd(histogram.totalUsd)} liquidados</span>
        </div>
        <div className="flex h-16 items-end gap-[2px]">
          {histogram.buckets.map((b, i) => {
            const total = b.long + b.short;
            const h = total > 0 ? Math.max(3, (total / histogram.max) * 60) : 2;
            const longH = total > 0 ? (b.long / total) * h : 0;
            const isCascade = i === histogram.cascadeIdx;
            const at = histogram.from + i * histogram.width;
            return (
              <div
                key={i}
                className="group relative flex-1"
                title={
                  total > 0
                    ? `${f.hhmmUTC(at)} UTC · ${f.usd(total)} · ${b.n} liq.`
                    : `${f.hhmmUTC(at)} UTC · sin liquidaciones`
                }
              >
                <div
                  className="flex w-full flex-col justify-end rounded-sm transition-all"
                  style={{ height: h, outline: isCascade ? "1px solid var(--color-warn)" : undefined }}
                >
                  <div style={{ height: h - longH, background: "rgba(255,84,112,0.75)" }} />
                  <div style={{ height: longH, background: "rgba(33,212,160,0.75)" }} />
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-1.5 flex justify-between font-mono text-[8px] uppercase tracking-[0.1em] text-[var(--color-dim)]">
          <span>−60 min</span>
          <span className="normal-case tracking-normal">
            <span className="up">verde</span> = longs liquidados · <span className="down">rojo</span> = shorts
          </span>
          <span>ahora</span>
        </div>
      </div>

      {/* ---- balance y mayor evento ---- */}
      <div className="grid grid-cols-1 divide-y divide-[var(--color-line-soft)] border-b border-[var(--color-line-soft)] sm:grid-cols-2 sm:divide-x sm:divide-y-0">
        <div className="px-4 py-3">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--color-dim)]">
              Reparto por lado
            </span>
            <span
              className={`tnum text-[11px] font-bold ${
                balance.dominant === "long" ? "up" : balance.dominant === "short" ? "down" : "text-[var(--color-dim)]"
              }`}
            >
              {balance.dominant ? `${balance.pct.toFixed(0)}% sesgo` : "—"}
            </span>
          </div>
          <DualBar
            left={liqTotals.long}
            right={liqTotals.short}
            leftLabel={`longs ${f.usd(liqTotals.long)}`}
            rightLabel={`shorts ${f.usd(liqTotals.short)}`}
          />
          <p className="mt-2 font-mono text-[8.5px] leading-relaxed text-[var(--color-dim)]">
            {balance.dominant === "long"
              ? "Se liquidan largos: presión vendedora forzada."
              : balance.dominant === "short"
                ? "Se liquidan cortos: presión compradora forzada."
                : "Sin datos suficientes."}
          </p>
        </div>

        <div className="px-4 py-3">
          <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--color-dim)]">
            Mayor liquidación
          </div>
          {biggest ? (
            <>
              <div className="tnum mt-1.5 text-xl font-bold leading-none text-[var(--color-warn)]">
                {f.usd(biggest.usd)}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 font-mono text-[9px] text-[var(--color-dim)]">
                <span className={biggest.side === "long" ? "up" : "down"}>
                  {biggest.side === "long" ? "LONG" : "SHORT"}
                </span>
                <span className="tnum">@ {f.price(biggest.price, spec.decimals)}</span>
                <span>{EXCHANGE_LABEL[biggest.exchange]}</span>
                <span>hace {f.ago(biggest.ts, now)}</span>
              </div>
            </>
          ) : (
            <div className="mt-1.5 text-xl font-bold leading-none text-[var(--color-dim)]">—</div>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {Object.entries(liqTotals.byExchange).map(([ex, n]) => (
              <Tag
                key={ex}
                kind={countsInTotals(ex as Provenance) ? "real" : "partial"}
                title={
                  countsInTotals(ex as Provenance)
                    ? "Publica todas sus liquidaciones: suma en los totales"
                    : "Binance recorta a 1 por símbolo y segundo: se muestra pero no suma"
                }
              >
                {EXCHANGE_LABEL[ex as Provenance] ?? ex} {n}
              </Tag>
            ))}
          </div>
        </div>
      </div>

      {/* ---- feed ---- */}
      <div className="flex items-center gap-1.5 border-b border-[var(--color-line-soft)] px-4 py-2">
        {(["todas", "long", "short", "grandes"] as Filter[]).map((k) => (
          <button
            key={k}
            onClick={() => setFilter(k)}
            title={k === "grandes" ? "Solo liquidaciones de 50 000 $ o más" : undefined}
            className={`rounded border px-2 py-1 font-mono text-[9px] font-semibold uppercase tracking-[0.08em] transition-colors ${
              filter === k
                ? "border-[rgba(255,181,69,0.45)] bg-[var(--color-warn-soft)] text-[var(--color-warn)]"
                : "border-[var(--color-line)] text-[var(--color-dim)] hover:text-[var(--color-body)]"
            }`}
          >
            {k} · {counts[k]}
          </button>
        ))}
      </div>

      <div className="slim max-h-[260px] min-h-[120px] flex-1 overflow-y-auto">
        {!rows.length ? (
          <Empty>
            sin liquidaciones con este filtro
            <br />
            <span className="normal-case tracking-normal opacity-70">solo se muestran eventos reales</span>
          </Empty>
        ) : (
          rows.map((e) => {
            const isLong = e.side === "long";
            const partial = !countsInTotals(e.exchange);
            const big = e.usd >= 1e6;
            return (
              <div
                key={e.id}
                className={`flex items-center gap-2 border-b border-[var(--color-line-soft)] px-3 py-[6px] transition-colors hover:bg-[var(--color-surface-2)] ${
                  partial ? "opacity-55" : ""
                }`}
              >
                {big && <span className="h-4 w-[2px] shrink-0 rounded bg-[var(--color-warn)]" />}
                <span className="tnum shrink-0 text-[9px] text-[var(--color-dim)]">{f.clockUTC(e.ts)}</span>
                <span
                  className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase ${
                    isLong
                      ? "border-[rgba(33,212,160,0.35)] bg-[var(--color-up-soft)] up"
                      : "border-[rgba(255,84,112,0.35)] bg-[var(--color-down-soft)] down"
                  }`}
                >
                  {isLong ? "LONG" : "SHORT"}
                </span>
                <span className="tnum min-w-0 flex-1 truncate text-[10px] text-[var(--color-muted)]">
                  @ {f.price(e.price, spec.decimals)}
                </span>
                <span className="shrink-0 font-mono text-[8px] uppercase tracking-[0.08em] text-[var(--color-dim)]">
                  {EXCHANGE_LABEL[e.exchange] ?? e.exchange}
                  {partial && "*"}
                </span>
                <span
                  className={`tnum w-[72px] shrink-0 text-right text-[11px] font-bold ${
                    big ? "text-[var(--color-warn)]" : "text-[var(--color-bright)]"
                  }`}
                >
                  {f.usd(e.usd)}
                </span>
              </div>
            );
          })
        )}
      </div>

      <footer className="mt-auto border-t border-[var(--color-line-soft)] px-4 py-2.5">
        <p className="font-mono text-[8px] leading-relaxed text-[var(--color-dim)]">
          Liquidaciones <b className="text-[var(--color-muted)]">reales</b> de OKX y Bybit, agregadas en vivo. Dicen
          qué está pasando ahora mismo, y para eso sirven.
        </p>
        <p className="mt-1.5 font-mono text-[8px] leading-relaxed text-[var(--color-warn)]">
          <b>No son un pronóstico.</b> La tesis de que el precio va hacia los cúmulos se midió sobre posiciones reales
          de Hyperliquid y no se sostiene (−0,18 % neto, t=−0,71, con muestra para haber visto cualquier efecto
          rentable). Y los que revientan no vuelven: los reincidentes reaparecen un 9,6 % frente al 5,0 % del resto,
          1,49σ. El mapa describe un accidente, no un hábito. Está todo en{" "}
          <b className="text-[var(--color-muted)]">Qué se ha comprobado</b>.
        </p>
      </footer>
    </Card>
  );
}
