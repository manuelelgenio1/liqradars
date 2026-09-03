// Formateadores. Todo valor no finito se muestra como "—": si no se ha
// medido, no se enseña un número.

const NBSP = "\u00A0";

export function usd(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(digits)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(digits)}K`;
  // por debajo de $1000 se respetan los decimales pedidos: si no,
  // un coste de 0,50 $ se mostraba como "$0".
  if (a < 10) return `$${n.toFixed(Math.max(2, digits))}`;
  if (a < 1000) return `$${n.toFixed(a < 100 ? Math.max(1, digits) : 0)}`;
  return `$${n.toFixed(0)}`;
}

export function compact(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  // Los tamaños del libro van en moneda base: en BTC un nivel normal son
  // 0,002 BTC. Redondear a entero lo convertía en "0" y dejaba la columna
  // entera a cero. Se escalan los decimales a la magnitud del número.
  if (a === 0) return "0";
  if (a < 0.01) return n.toFixed(4);
  if (a < 1) return n.toFixed(3);
  if (a < 100) return n.toFixed(2);
  return n.toFixed(0);
}

export function price(n: number, decimals: number): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function pct(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

export function num(n: number, digits = 1): string {
  return Number.isFinite(n) ? n.toFixed(digits) : "—";
}

const p2 = (x: number) => String(x).padStart(2, "0");

export function clockUTC(ts: number): string {
  if (!Number.isFinite(ts)) return "—";
  const d = new Date(ts);
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
}

export function hhmmUTC(ts: number): string {
  if (!Number.isFinite(ts)) return "—";
  const d = new Date(ts);
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

export function ago(ts: number, now: number): string {
  if (!Number.isFinite(ts)) return "—";
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${NBSP}${m % 60}m`;
  return `${Math.floor(h / 24)}d${NBSP}${h % 24}h`;
}

export function countdown(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${p2(Math.floor(s / 3600))}:${p2(Math.floor((s % 3600) / 60))}:${p2(s % 60)}`;
}

const MESES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

export function axisTime(ts: number, tfMinutes: number): string {
  if (!Number.isFinite(ts)) return "—";
  const d = new Date(ts);
  if (tfMinutes < 60) return hhmmUTC(ts);
  if (tfMinutes < 10080) return `${d.getUTCDate()}${NBSP}${MESES[d.getUTCMonth()]}`;
  return `${MESES[d.getUTCMonth()]}${NBSP}'${String(d.getUTCFullYear()).slice(2)}`;
}
