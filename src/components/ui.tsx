import type { ReactNode } from "react";
import type { Health } from "../hooks/useMarket";

export function Card({
  title,
  sub,
  right,
  children,
  className = "",
  delay = 0,
}: {
  title?: string;
  sub?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  return (
    <section className={`card rise flex flex-col ${className}`} style={{ animationDelay: `${delay}ms` }}>
      {title && (
        <header className="card-head">
          <div className="min-w-0 leading-tight">
            <h2 className="card-title truncate">{title}</h2>
            {sub && <div className="card-sub mt-1 truncate">{sub}</div>}
          </div>
          {right && <div className="ml-auto flex shrink-0 items-center gap-2">{right}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/**
 * Etiqueta de procedencia. Es deliberadamente omnipresente: cada número de la
 * pantalla debe poder responder "¿de dónde salgo?" sin abrir el código.
 */
export function Tag({
  kind = "none",
  children,
  title,
}: {
  kind?: "real" | "partial" | "none";
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`tag tag-${kind}`} title={title}>
      {children}
    </span>
  );
}

export function Dot({ live, tone = "up" }: { live: boolean; tone?: "up" | "down" | "warn" }) {
  const color = tone === "up" ? "var(--color-up)" : tone === "down" ? "var(--color-down)" : "var(--color-warn)";
  return (
    <span
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${live ? "live-dot" : ""}`}
      style={{ background: live ? color : "var(--color-dim)" }}
    />
  );
}

/** Valor grande. Si no es finito muestra "—": nunca un número de relleno. */
export function Stat({
  label,
  value,
  hint,
  tone,
  tag,
}: {
  label: string;
  value: string;
  hint?: ReactNode;
  tone?: "up" | "down" | "warn" | "neutral";
  tag?: ReactNode;
}) {
  const color =
    tone === "up" ? "var(--color-up)" : tone === "down" ? "var(--color-down)" : tone === "warn" ? "var(--color-warn)" : "var(--color-bright)";
  const empty = value === "—";
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--color-dim)]">{label}</span>
        {tag}
      </div>
      <div
        className="tnum mt-1.5 text-xl font-bold leading-none"
        style={{ color: empty ? "var(--color-dim)" : color }}
      >
        {value}
      </div>
      {hint && <div className="mt-1.5 font-mono text-[9.5px] text-[var(--color-dim)]">{hint}</div>}
    </div>
  );
}

export function Bar({ value, tone = "up", height = 4 }: { value: number; tone?: "up" | "down" | "warn"; height?: number }) {
  const w = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) * 100 : 0;
  const color = tone === "up" ? "var(--color-up)" : tone === "down" ? "var(--color-down)" : "var(--color-warn)";
  return (
    <div className="flex-1 overflow-hidden rounded-full bg-[var(--color-surface-3)]" style={{ height }}>
      <div className="h-full rounded-full transition-all duration-500" style={{ width: `${w}%`, background: color, opacity: 0.9 }} />
    </div>
  );
}

/** Barra divergente −1..1 para señales con signo. */
export function SplitBar({ value, height = 5 }: { value: number; height?: number }) {
  const v = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  const color = v >= 0 ? "var(--color-up)" : "var(--color-down)";
  return (
    <div className="relative flex-1 overflow-hidden rounded-full bg-[var(--color-surface-3)]" style={{ height }}>
      <span className="absolute inset-y-0 left-1/2 w-px bg-[var(--color-line)]" />
      <span
        className="absolute inset-y-0 rounded-full transition-all duration-500"
        style={{
          left: v >= 0 ? "50%" : `${50 + v * 50}%`,
          width: `${Math.abs(v) * 50}%`,
          background: color,
          opacity: 0.9,
        }}
      />
    </div>
  );
}

const HEALTH_META: Record<Health, { label: string; kind: "real" | "partial" | "none" }> = {
  viva: { label: "en vivo", kind: "real" },
  degradada: { label: "degradada", kind: "partial" },
  caida: { label: "caída", kind: "none" },
  esperando: { label: "esperando", kind: "none" },
};

export function HealthTag({ name, state, title }: { name: string; state: Health; title?: string }) {
  const m = HEALTH_META[state];
  return (
    <Tag kind={m.kind} title={title}>
      <Dot live={state === "viva"} tone={state === "degradada" ? "warn" : "up"} />
      {name} · {m.label}
    </Tag>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-10 text-center font-mono text-[10px] uppercase leading-relaxed tracking-[0.14em] text-[var(--color-dim)]">
      {children}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}

/** Minigráfico de línea. Para dar contexto histórico a un número suelto. */
export function Spark({
  values,
  color = "var(--color-muted)",
  width = 70,
  height = 22,
  fill = false,
}: {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
  fill?: boolean;
}) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length < 2) return <div style={{ width, height }} />;
  const lo = Math.min(...clean);
  const hi = Math.max(...clean);
  const span = hi - lo || 1;
  const pts = clean.map((v, i) => {
    const x = (i / (clean.length - 1)) * width;
    const y = height - 1 - ((v - lo) / span) * (height - 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg width={width} height={height} className="shrink-0" aria-hidden>
      {fill && <polygon points={`0,${height} ${pts.join(" ")} ${width},${height}`} fill={color} opacity={0.14} />}
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="1.3" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Barra apilada de dos lados, con etiquetas. */
export function DualBar({
  left,
  right,
  leftLabel,
  rightLabel,
  height = 8,
}: {
  left: number;
  right: number;
  leftLabel: string;
  rightLabel: string;
  height?: number;
}) {
  const total = left + right;
  const lp = total > 0 ? (left / total) * 100 : 50;
  return (
    <div>
      <div className="flex overflow-hidden rounded-full bg-[var(--color-surface-3)]" style={{ height }}>
        <div className="transition-all duration-500" style={{ width: `${lp}%`, background: "var(--color-up)" }} />
        <div className="flex-1 transition-all duration-500" style={{ background: "var(--color-down)" }} />
      </div>
      <div className="mt-1.5 flex justify-between font-mono text-[8.5px] uppercase tracking-[0.1em]">
        <span className="up">{leftLabel}</span>
        <span className="down">{rightLabel}</span>
      </div>
    </div>
  );
}
