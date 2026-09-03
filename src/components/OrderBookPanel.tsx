import { useEffect, useMemo, useState } from "react";
import type { MarketApi } from "../hooks/useMarket";
import * as f from "../lib/format";
import { Card, Empty, Tag } from "./ui";

/* ============================================================
   Libro de órdenes.

   El motor ya descargaba la profundidad y no se mostraba en ninguna parte:
   dato real desperdiciado en una app que se llama "radar de liquidez".

   Se dibuja como escalera con dos capas de información en cada fila: barra de
   tamaño individual (dónde está el muro) y barra de profundidad acumulada
   (cuánto aguanta el precio hasta ahí). Los muros se detectan comparando cada
   nivel con la MEDIANA del libro, que es robusta frente a un único outlier —
   una media se dejaría arrastrar por el propio muro que intenta encontrar.
   ============================================================ */

const ROWS = 12;

export default function OrderBookPanel({ api }: { api: MarketApi }) {
  const book = api.snap.book;
  // La antigüedad del snapshot se muestra siempre: un libro es una foto, y
  // saber de cuándo es forma parte del dato.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);
  const ageMs = book ? now - book.ts : NaN;

  const model = useMemo(() => {
    if (!book || !book.bids.length || !book.asks.length) return null;
    const bids = book.bids.slice(0, ROWS);
    const asks = book.asks.slice(0, ROWS);
    const sizes = [...bids, ...asks].map((l) => l.size).sort((a, b) => a - b);
    const median = sizes[Math.floor(sizes.length / 2)] || 1;
    const maxSize = Math.max(...sizes, 1);
    const maxCum = Math.max(bids.at(-1)?.cumulative ?? 0, asks.at(-1)?.cumulative ?? 0, 1);
    const best = { bid: bids[0].price, ask: asks[0].price };
    const mid = (best.bid + best.ask) / 2;
    const spreadPct = mid > 0 ? ((best.ask - best.bid) / mid) * 100 : NaN;
    // "muro" = nivel con al menos 3× el tamaño mediano
    const isWall = (size: number) => size >= median * 3;
    return { bids, asks, median, maxSize, maxCum, mid, spreadPct, isWall };
  }, [book]);

  if (!model) {
    return (
      <Card title="Libro de órdenes" sub="profundidad real de Binance" delay={140}>
        <Empty>recibiendo profundidad…</Empty>
      </Card>
    );
  }

  const { bids, asks, maxSize, maxCum, mid, spreadPct, isWall } = model;
  const imbalance = book!.imbalance;
  const bidPct = Math.max(0, Math.min(100, 50 + imbalance * 50));

  const Row = ({ level, side }: { level: (typeof bids)[number]; side: "bid" | "ask" }) => {
    const wall = isWall(level.size);
    const rgb = side === "bid" ? "33,212,160" : "255,84,112";
    return (
      <div className="relative flex items-center gap-2 px-3 py-[3px] font-mono text-[10.5px]">
        {/* profundidad acumulada: cuánto hay que atravesar para llegar aquí */}
        <div
          className="absolute inset-y-0 right-0 transition-[width] duration-500"
          style={{ width: `${(level.cumulative / maxCum) * 100}%`, background: `rgba(${rgb},0.1)` }}
        />
        {/* tamaño individual del nivel */}
        <div
          className="absolute inset-y-[2px] right-0 transition-[width] duration-500"
          style={{ width: `${(level.size / maxSize) * 62}%`, background: `rgba(${rgb},0.26)` }}
        />
        {wall && (
          <span
            className="absolute inset-y-[2px] left-0 w-[2.5px]"
            style={{ background: `rgb(${rgb})`, boxShadow: `0 0 7px rgba(${rgb},0.8)` }}
            title="Muro: al menos 3× el tamaño mediano del libro"
          />
        )}
        <span className={`tnum relative w-[80px] shrink-0 ${side === "bid" ? "up" : "down"}`}>
          {f.price(level.price, api.spec.decimals)}
        </span>
        <span className="tnum relative flex-1 text-right text-[var(--color-body)]">{f.compact(level.size)}</span>
        <span className="tnum relative w-[58px] shrink-0 text-right text-[var(--color-dim)]">
          {f.compact(level.cumulative)}
        </span>
        <span className="relative w-8 shrink-0 text-right text-[8px] uppercase tracking-wider">
          {wall ? <span className="font-bold text-[var(--color-warn)]">muro</span> : ""}
        </span>
      </div>
    );
  };

  return (
    <Card
      title="Libro de órdenes"
      sub={`${api.spec.key} · profundidad real · ${api.venue}`}
      right={
        <Tag
          kind={ageMs < 6000 ? "real" : "partial"}
          title="Antigüedad del snapshot de /depth. Se refresca cada 2,5 s; si envejece, la conexión está fallando."
        >
          {Number.isFinite(ageMs) ? `hace ${(ageMs / 1000).toFixed(1)} s` : "sin datos"}
        </Tag>
      }
      delay={140}
      className="min-h-0"
    >
      <div className="grid grid-cols-[80px_1fr_58px_32px] gap-2 border-b border-[var(--color-line-soft)] px-3 py-1.5 font-mono text-[8.5px] uppercase tracking-[0.14em] text-[var(--color-dim)]">
        <span>Precio</span>
        <span className="text-right">Tamaño</span>
        <span className="text-right">Acum.</span>
        <span />
      </div>

      <div className="flex flex-col">
        {[...asks].reverse().map((l, i) => (
          <Row key={`a${i}`} level={l} side="ask" />
        ))}

        <div className="flex items-center gap-3 border-y border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 py-2">
          <span className={`tnum text-base font-bold ${imbalance >= 0 ? "up" : "down"}`}>
            {f.price(mid, api.spec.decimals)}
          </span>
          <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-[var(--color-dim)]">
            spread {f.num(spreadPct, 3)}%
          </span>
          <span
            className={`ml-auto font-mono text-[9px] font-semibold uppercase tracking-[0.12em] ${
              imbalance >= 0 ? "up" : "down"
            }`}
          >
            {imbalance >= 0 ? "presión compradora" : "presión vendedora"}
          </span>
        </div>

        {bids.map((l, i) => (
          <Row key={`b${i}`} level={l} side="bid" />
        ))}
      </div>

      <div className="mt-auto border-t border-[var(--color-line-soft)] px-4 py-3">
        <div className="mb-2 flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--color-dim)]">
          <span>Desequilibrio del libro</span>
          <span className={`tnum font-bold ${imbalance >= 0 ? "up" : "down"}`}>
            {imbalance >= 0 ? "+" : ""}
            {(imbalance * 100).toFixed(1)}%
          </span>
        </div>
        <div className="relative h-2 overflow-hidden rounded-full bg-[var(--color-surface-3)]">
          <div
            className="absolute inset-y-0 left-0 transition-all duration-500"
            style={{ width: `${bidPct}%`, background: "linear-gradient(90deg, rgba(33,212,160,0.3), var(--color-up))" }}
          />
          <div className="absolute inset-y-0 left-1/2 w-px bg-[var(--color-bright)] opacity-60" />
        </div>
        <p className="mt-2 font-mono text-[8px] leading-relaxed text-[var(--color-dim)]">
          Barra clara = tamaño del nivel; barra tenue = profundidad acumulada. Un{" "}
          <b className="text-[var(--color-warn)]">muro</b> es un nivel con 3× el tamaño mediano. Ojo: un muro visible
          puede retirarse antes de que el precio llegue — el libro es una foto, no un compromiso.
        </p>
      </div>
    </Card>
  );
}
