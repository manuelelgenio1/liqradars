import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MarketApi } from "../hooks/useMarket";
import type { Liquidation } from "../lib/types";
import { LEVERAGES, levDistancePct, TIMEFRAMES } from "../lib/types";
import * as f from "../lib/format";
import { Card, Empty, Tag } from "./ui";

/* ============================================================
   Gráfico.

   Frente al enfoque anterior (lienzo fijo, sin navegación, liquidaciones como
   rayas horizontales de ancho completo) aquí:

   · Cada liquidación real se dibuja como una BURBUJA en (tiempo, precio), con
     área proporcional al nocional. El "cuándo" es dato que ya teníamos y que
     una raya horizontal desperdicia: ver la cascada agrupada en el tiempo es
     justo lo que distingue un barrido de un goteo.
   · Canaleta derecha con el PERFIL de liquidaciones por nivel de precio,
     partido por lado. Sustituye a las rayas: misma información, sin tapar las
     velas.
   · Zoom con rueda al cursor, arrastre, minimapa, pantalla completa y gestos
     táctiles (pellizco + arrastre).
   · Panel inferior de osciladores conmutable: volumen, CVD, RSI y MACD.
   ============================================================ */

const PAD_TOP = 14;
const AXIS_W = 72;
const PROFILE_W = 92;
const TIME_H = 22;
const SUB_H = 92;
const MINIMAP_H = 40;
const MIN_VISIBLE = 20;

type Osc = "vol" | "cvd" | "rsi" | "macd" | "none";
const OSCS: { id: Osc; label: string }[] = [
  { id: "vol", label: "Volumen" },
  { id: "cvd", label: "CVD" },
  { id: "rsi", label: "RSI" },
  { id: "macd", label: "MACD" },
  { id: "none", label: "Ocultar" },
];

type Layer = "bubbles" | "profile" | "lev" | "ema" | "vwap" | "st";
const LAYERS: { id: Layer; label: string; tip: string }[] = [
  { id: "bubbles", label: "Liq. en tiempo", tip: "Cada liquidación real como burbuja en (tiempo, precio). Área ∝ nocional." },
  { id: "profile", label: "Perfil liq.", tip: "Nocional liquidado por nivel de precio, en la canaleta derecha" },
  { id: "lev", label: "Escalera", tip: "Dónde se liquida una posición xN: a 1/N del precio" },
  { id: "ema", label: "EMAs", tip: "Medias exponenciales rápida, lenta y de tendencia" },
  { id: "vwap", label: "VWAP", tip: "Precio medio ponderado por volumen, diario UTC" },
  { id: "st", label: "Supertrend", tip: "Tendencia por ATR" },
];

interface Hover {
  x: number;
  y: number;
  idx: number;
  price: number;
  liq: Liquidation | null;
}

export default function PriceChart({ api }: { api: MarketApi }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const miniRef = useRef<HTMLCanvasElement>(null);

  const [size, setSize] = useState({ w: 900, h: 470 });
  const [fullscreen, setFullscreen] = useState(false);
  const [osc, setOsc] = useState<Osc>("vol");
  const [layers, setLayers] = useState<Record<Layer, boolean>>({
    bubbles: true,
    profile: true,
    lev: true,
    ema: true,
    vwap: false,
    st: true,
  });
  const [hover, setHover] = useState<Hover | null>(null);
  const [visible, setVisible] = useState(90);
  const [offset, setOffset] = useState(0);
  const drag = useRef<{ x: number; startOffset: number } | null>(null);
  const pinch = useRef<{ dist: number; visible: number; anchor: number } | null>(null);

  const { snap, indicators, price, spec, tfSpec, liqEvents, liqLevels } = api;
  const candles = snap.candles;
  const total = candles.length;

  // ---------- medidas ----------
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () =>
      setSize({ w: el.clientWidth, h: fullscreen ? Math.max(320, el.clientHeight) : 470 });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fullscreen]);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFullscreen(false);
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [fullscreen]);

  useEffect(() => {
    setOffset(0);
    setVisible((v) => Math.min(v, Math.max(MIN_VISIBLE, total)));
  }, [api.symbol, api.tf, total]);

  // ---------- ventana visible ----------
  const view = useMemo(() => {
    const end = Math.max(MIN_VISIBLE, total - offset);
    const start = Math.max(0, end - visible);
    const slice = candles.slice(start, end);
    let lo = Infinity;
    let hi = -Infinity;
    for (const k of slice) {
      lo = Math.min(lo, k.l);
      hi = Math.max(hi, k.h);
    }
    if (!slice.length) return { start, end, slice, lo: 0, hi: 1, t0: 0, t1: 1 };
    const pad = (hi - lo) * 0.08 || 1;
    return {
      start,
      end,
      slice,
      lo: lo - pad,
      hi: hi + pad,
      t0: slice[0].t,
      t1: slice[slice.length - 1].t + tfSpec.minutes * 60_000,
    };
  }, [candles, offset, visible, total, tfSpec.minutes]);

  const plotW = size.w - AXIS_W - (layers.profile ? PROFILE_W : 0);
  const oscOpen = osc !== "none";
  const plotH = size.h - TIME_H - PAD_TOP - (oscOpen ? SUB_H : 0) - 8;

  const toY = useCallback(
    (p: number) => PAD_TOP + ((view.hi - p) / (view.hi - view.lo || 1)) * plotH,
    [view.hi, view.lo, plotH]
  );
  const toPrice = useCallback(
    (y: number) => view.hi - ((y - PAD_TOP) / plotH) * (view.hi - view.lo),
    [view.hi, view.lo, plotH]
  );
  const toX = useCallback(
    (t: number) => ((t - view.t0) / (view.t1 - view.t0 || 1)) * plotW,
    [view.t0, view.t1, plotW]
  );

  // liquidaciones dentro de la ventana temporal visible
  const visibleLiqs = useMemo(
    () => liqEvents.filter((e) => e.ts >= view.t0 && e.ts <= view.t1),
    [liqEvents, view.t0, view.t1]
  );

  // CVD acumulado sobre las velas (delta real de taker).
  // Se acumula en un bucle explícito en vez de con una asignación dentro de
  // `map`: hace lo mismo, pero un `map` que muta una variable de fuera es un
  // efecto secundario disfrazado de transformación, y se lee peor.
  const cvd = useMemo(() => {
    const out = new Array<number>(candles.length);
    let acc = 0;
    for (let i = 0; i < candles.length; i++) {
      acc += candles[i].delta;
      out[i] = acc;
    }
    return out;
  }, [candles]);

  // ---------- dibujo ----------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !view.slice.length || plotW <= 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    ctx.font = "10px 'JetBrains Mono', monospace";
    ctx.textBaseline = "middle";

    const bottom = PAD_TOP + plotH;
    const cellW = plotW / view.slice.length;
    const profileX = plotW;

    // rejilla + eje de precios
    for (let i = 0; i <= 5; i++) {
      const gy = PAD_TOP + (plotH * i) / 5;
      ctx.strokeStyle = "rgba(29,40,60,0.5)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(plotW + (layers.profile ? PROFILE_W : 0), gy);
      ctx.stroke();
      ctx.fillStyle = "#55637d";
      ctx.textAlign = "left";
      ctx.fillText(f.price(toPrice(gy), spec.decimals), size.w - AXIS_W + 8, gy);
    }

    // ---- escalera de apalancamiento ----
    if (layers.lev && Number.isFinite(price)) {
      for (const lev of LEVERAGES) {
        const d = levDistancePct(lev) / 100;
        for (const dir of [-1, 1]) {
          const ly = toY(price * (1 + dir * d));
          if (ly < PAD_TOP + 4 || ly > bottom - 4) continue;
          ctx.strokeStyle = "rgba(255,181,69,0.22)";
          ctx.setLineDash([3, 5]);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(0, ly);
          ctx.lineTo(plotW, ly);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = "rgba(255,181,69,0.65)";
          ctx.textAlign = "left";
          ctx.font = "600 8.5px 'JetBrains Mono', monospace";
          ctx.fillText(`x${lev}`, 4, ly - 6);
          ctx.font = "10px 'JetBrains Mono', monospace";
        }
      }
    }

    // ---- velas ----
    for (let i = 0; i < view.slice.length; i++) {
      const k = view.slice[i];
      const cx = i * cellW + cellW / 2;
      const rising = k.c >= k.o;
      const col = rising ? "#21d4a0" : "#ff5470";
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, toY(k.h));
      ctx.lineTo(cx, toY(k.l));
      ctx.stroke();
      const bw = Math.max(1.2, cellW * 0.6);
      ctx.fillStyle = col;
      ctx.globalAlpha = 0.9;
      ctx.fillRect(cx - bw / 2, Math.min(toY(k.o), toY(k.c)), bw, Math.max(1.1, Math.abs(toY(k.c) - toY(k.o))));
      ctx.globalAlpha = 1;
    }

    // ---- indicadores ----
    if (indicators) {
      const drawLine = (arr: number[], color: string, width: number, dash?: number[]) => {
        ctx.beginPath();
        ctx.setLineDash(dash ?? []);
        let started = false;
        for (let i = view.start; i < view.end; i++) {
          const v = arr[i];
          if (!Number.isFinite(v)) continue;
          const px = (i - view.start) * cellW + cellW / 2;
          const py = toY(v);
          if (!started) {
            ctx.moveTo(px, py);
            started = true;
          } else ctx.lineTo(px, py);
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.stroke();
        ctx.setLineDash([]);
      };
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, PAD_TOP, plotW, plotH);
      ctx.clip();
      if (layers.ema) {
        drawLine(indicators.emaTrend, "rgba(124,139,166,0.55)", 1.1, [4, 4]);
        drawLine(indicators.emaSlow, "rgba(255,181,69,0.8)", 1.2);
        drawLine(indicators.emaFast, "rgba(87,168,255,0.85)", 1.2);
      }
      if (layers.vwap) drawLine(indicators.vwap, "rgba(223,231,244,0.5)", 1.3, [7, 4]);
      if (layers.st) {
        ctx.lineWidth = 1.4;
        for (let i = view.start + 1; i < view.end; i++) {
          ctx.strokeStyle = indicators.stUp[i] ? "rgba(33,212,160,0.7)" : "rgba(255,84,112,0.7)";
          ctx.beginPath();
          ctx.moveTo((i - 1 - view.start) * cellW + cellW / 2, toY(indicators.stLine[i - 1]));
          ctx.lineTo((i - view.start) * cellW + cellW / 2, toY(indicators.stLine[i]));
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    // ---- burbujas de liquidación en (tiempo, precio) ----
    if (layers.bubbles && visibleLiqs.length) {
      const maxUsd = Math.max(...visibleLiqs.map((l) => l.usd), 1);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, PAD_TOP, plotW, plotH);
      ctx.clip();
      for (const l of visibleLiqs) {
        const x = toX(l.ts);
        const y = toY(l.price);
        if (y < PAD_TOP - 10 || y > bottom + 10) continue;
        // área ∝ nocional → radio ∝ √nocional
        const r = 2 + Math.sqrt(l.usd / maxUsd) * 13;
        const rgb = l.side === "long" ? "33,212,160" : "255,84,112";
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${rgb},0.2)`;
        ctx.fill();
        ctx.strokeStyle = `rgba(${rgb},0.85)`;
        ctx.lineWidth = 1.1;
        ctx.stroke();
        if (l.usd >= 1e6) {
          ctx.beginPath();
          ctx.arc(x, y, r + 3.5, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(255,181,69,0.75)`;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    // ---- perfil de liquidaciones (canaleta derecha) ----
    if (layers.profile) {
      ctx.fillStyle = "rgba(15,21,34,0.55)";
      ctx.fillRect(profileX, PAD_TOP, PROFILE_W, plotH);
      ctx.strokeStyle = "rgba(29,40,60,0.8)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(profileX + 0.5, PAD_TOP);
      ctx.lineTo(profileX + 0.5, bottom);
      ctx.stroke();

      const inView = liqLevels.filter((l) => l.price >= view.lo && l.price <= view.hi);
      const maxLevel = Math.max(...inView.map((l) => l.usdLong + l.usdShort), 1);
      const mid = profileX + PROFILE_W / 2;
      for (const l of inView) {
        const y = toY(l.price);
        const hgt = Math.max(1.5, plotH / 90);
        const wl = (l.usdLong / maxLevel) * (PROFILE_W / 2 - 3);
        const ws = (l.usdShort / maxLevel) * (PROFILE_W / 2 - 3);
        if (wl > 0.4) {
          ctx.fillStyle = "rgba(33,212,160,0.75)";
          ctx.fillRect(mid - wl, y - hgt / 2, wl, hgt);
        }
        if (ws > 0.4) {
          ctx.fillStyle = "rgba(255,84,112,0.75)";
          ctx.fillRect(mid, y - hgt / 2, ws, hgt);
        }
      }
      ctx.fillStyle = "#55637d";
      ctx.textAlign = "center";
      ctx.font = "600 8px 'JetBrains Mono', monospace";
      ctx.fillText("LONGS ◄ liq ► SHORTS", mid, PAD_TOP + 8);
      ctx.font = "10px 'JetBrains Mono', monospace";
      ctx.strokeStyle = "rgba(124,139,166,0.25)";
      ctx.beginPath();
      ctx.moveTo(mid, PAD_TOP + 14);
      ctx.lineTo(mid, bottom);
      ctx.stroke();
    }

    // ---- precio actual ----
    if (Number.isFinite(price)) {
      const py = toY(price);
      if (py > PAD_TOP && py < bottom) {
        ctx.strokeStyle = "rgba(223,231,244,0.6)";
        ctx.setLineDash([2, 3]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, py);
        ctx.lineTo(size.w - AXIS_W, py);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "#dfe7f4";
        ctx.fillRect(size.w - AXIS_W, py - 9, AXIS_W, 18);
        ctx.fillStyle = "#05070c";
        ctx.font = "700 10px 'JetBrains Mono', monospace";
        ctx.textAlign = "left";
        ctx.fillText(f.price(price, spec.decimals), size.w - AXIS_W + 7, py + 0.5);
        ctx.font = "10px 'JetBrains Mono', monospace";
      }
    }

    // ---- oscilador ----
    if (oscOpen) {
      const subTop = bottom + 10;
      const subBottom = subTop + SUB_H - 18;
      ctx.strokeStyle = "rgba(29,40,60,0.7)";
      ctx.beginPath();
      ctx.moveTo(0, subTop - 5);
      ctx.lineTo(size.w - AXIS_W, subTop - 5);
      ctx.stroke();
      ctx.textAlign = "left";
      ctx.fillStyle = "#7c8ba6";

      const xOf = (i: number) => i * cellW + cellW / 2;

      if (osc === "vol") {
        const vols = view.slice.map((k) => k.v);
        const mx = Math.max(...vols, 1e-9);
        for (let i = 0; i < vols.length; i++) {
          const h = (vols[i] / mx) * (subBottom - subTop);
          ctx.fillStyle = view.slice[i].delta >= 0 ? "rgba(33,212,160,0.55)" : "rgba(255,84,112,0.55)";
          ctx.fillRect(xOf(i) - cellW * 0.3, subBottom - h, cellW * 0.6, h);
        }
        ctx.fillStyle = "#7c8ba6";
        ctx.fillText("VOLUMEN · color = delta taker real", 8, subTop + 4);
      } else if (osc === "cvd") {
        const seg = cvd.slice(view.start, view.end);
        const lo = Math.min(...seg);
        const hi = Math.max(...seg);
        const span = hi - lo || 1;
        const y = (v: number) => subTop + ((hi - v) / span) * (subBottom - subTop);
        ctx.beginPath();
        for (let i = 0; i < seg.length; i++) {
          if (i === 0) ctx.moveTo(xOf(i), y(seg[i]));
          else ctx.lineTo(xOf(i), y(seg[i]));
        }
        const rising = seg[seg.length - 1] >= seg[0];
        ctx.strokeStyle = rising ? "#21d4a0" : "#ff5470";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.fillStyle = "#7c8ba6";
        ctx.fillText(`CVD · delta acumulado real  ${f.compact(seg[seg.length - 1])}`, 8, subTop + 4);
      } else if (osc === "rsi" && indicators) {
        const seg = indicators.rsi.slice(view.start, view.end);
        const y = (v: number) => subTop + (1 - v / 100) * (subBottom - subTop);
        for (const lvl of [70, 50, 30]) {
          ctx.strokeStyle = lvl === 50 ? "rgba(124,139,166,0.35)" : "rgba(124,139,166,0.2)";
          ctx.setLineDash([3, 4]);
          ctx.beginPath();
          ctx.moveTo(0, y(lvl));
          ctx.lineTo(plotW, y(lvl));
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.beginPath();
        for (let i = 0; i < seg.length; i++) {
          if (i === 0) ctx.moveTo(xOf(i), y(seg[i]));
          else ctx.lineTo(xOf(i), y(seg[i]));
        }
        ctx.strokeStyle = "#aebbd2";
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.fillStyle = "#7c8ba6";
        ctx.fillText(`RSI ${api.cfg.rsi}  ${f.num(seg[seg.length - 1], 1)}`, 8, subTop + 4);
      } else if (osc === "macd" && indicators) {
        const hs = indicators.macdHist.slice(view.start, view.end);
        const ls = indicators.macdLine.slice(view.start, view.end);
        const ss = indicators.macdSignal.slice(view.start, view.end);
        const mx = Math.max(...hs.map(Math.abs), ...ls.map(Math.abs), ...ss.map(Math.abs), 1e-9);
        const y = (v: number) => subTop + (1 - (v / mx + 1) / 2) * (subBottom - subTop);
        const zero = y(0);
        for (let i = 0; i < hs.length; i++) {
          const hy = y(hs[i]);
          ctx.fillStyle = hs[i] >= 0 ? "rgba(33,212,160,0.5)" : "rgba(255,84,112,0.5)";
          ctx.fillRect(xOf(i) - cellW * 0.3, Math.min(hy, zero), cellW * 0.6, Math.max(1, Math.abs(hy - zero)));
        }
        const line = (arr: number[], color: string) => {
          ctx.beginPath();
          for (let i = 0; i < arr.length; i++) {
            if (i === 0) ctx.moveTo(xOf(i), y(arr[i]));
            else ctx.lineTo(xOf(i), y(arr[i]));
          }
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.2;
          ctx.stroke();
          ctx.lineWidth = 1;
        };
        line(ls, "#57a8ff");
        line(ss, "#ffb545");
        ctx.fillStyle = "#7c8ba6";
        ctx.fillText(`MACD ${api.cfg.macd.join(",")}`, 8, subTop + 4);
      }
    }

    // ---- eje temporal ----
    ctx.fillStyle = "#55637d";
    ctx.textAlign = "center";
    const step = Math.max(1, Math.round(view.slice.length / 6));
    for (let i = 0; i < view.slice.length; i += step) {
      ctx.fillText(f.axisTime(view.slice[i].t, tfSpec.minutes), xOf2(i, cellW), size.h - TIME_H / 2);
    }

    // ---- crosshair ----
    if (hover && hover.x < plotW) {
      ctx.strokeStyle = "rgba(174,187,210,0.3)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(hover.x, PAD_TOP);
      ctx.lineTo(hover.x, oscOpen ? size.h - TIME_H : bottom);
      ctx.moveTo(0, hover.y);
      ctx.lineTo(size.w - AXIS_W, hover.y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (hover.y > PAD_TOP && hover.y < bottom) {
        ctx.fillStyle = "#151d2e";
        ctx.fillRect(size.w - AXIS_W, hover.y - 9, AXIS_W, 18);
        ctx.strokeStyle = "rgba(124,139,166,0.5)";
        ctx.strokeRect(size.w - AXIS_W + 0.5, hover.y - 8.5, AXIS_W - 1, 17);
        ctx.fillStyle = "#dfe7f4";
        ctx.textAlign = "left";
        ctx.fillText(f.price(hover.price, spec.decimals), size.w - AXIS_W + 7, hover.y + 0.5);
      }
    }

    function xOf2(i: number, cw: number) {
      return i * cw + cw / 2;
    }
  }, [
    view, size, plotW, plotH, oscOpen, osc, layers, indicators, price, spec.decimals,
    tfSpec.minutes, hover, visibleLiqs, liqLevels, cvd, toY, toPrice, toX, api.cfg,
  ]);

  // ---------- minimapa ----------
  useEffect(() => {
    const canvas = miniRef.current;
    if (!canvas || !total) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size.w * dpr;
    canvas.height = MINIMAP_H * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, MINIMAP_H);
    let lo = Infinity;
    let hi = -Infinity;
    for (const k of candles) {
      lo = Math.min(lo, k.l);
      hi = Math.max(hi, k.h);
    }
    const span = hi - lo || 1;
    const bw = size.w / total;
    ctx.beginPath();
    for (let i = 0; i < total; i++) {
      const y = 4 + ((hi - candles[i].c) / span) * (MINIMAP_H - 8);
      if (i === 0) ctx.moveTo(i * bw, y);
      else ctx.lineTo(i * bw, y);
    }
    ctx.strokeStyle = "rgba(124,139,166,0.6)";
    ctx.lineWidth = 1;
    ctx.stroke();
    const x0 = view.start * bw;
    const x1 = view.end * bw;
    ctx.fillStyle = "rgba(5,7,12,0.6)";
    ctx.fillRect(0, 0, x0, MINIMAP_H);
    ctx.fillRect(x1, 0, size.w - x1, MINIMAP_H);
    ctx.strokeStyle = "rgba(33,212,160,0.75)";
    ctx.lineWidth = 1.2;
    ctx.strokeRect(x0 + 0.5, 0.5, Math.max(2, x1 - x0 - 1), MINIMAP_H - 1);
  }, [candles, total, view.start, view.end, size.w]);

  // ---------- navegación ----------
  const zoomAt = useCallback(
    (dir: number, anchor: number) => {
      setVisible((prev) => {
        const next = Math.max(MIN_VISIBLE, Math.min(total, Math.round(prev * (dir > 0 ? 1.22 : 0.82))));
        if (next === prev) return prev;
        setOffset((off) => {
          const end = total - off;
          const start = Math.max(0, end - prev);
          const newStart = Math.max(0, Math.min(total - next, Math.round(start + (prev - next) * anchor)));
          return Math.max(0, total - next - newStart);
        });
        return next;
      });
    },
    [total]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const anchor = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, plotW)));
      zoomAt(e.deltaY > 0 ? 1 : -1, anchor);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [zoomAt, plotW]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const cellW = plotW / Math.max(1, visible);
      const shift = Math.round((e.clientX - d.x) / cellW);
      setOffset(Math.max(0, Math.min(total - visible, d.startOffset + shift)));
    };
    const onUp = () => {
      drag.current = null;
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [plotW, visible, total]);

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (drag.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const cellW = plotW / Math.max(1, view.slice.length);
    const idx = Math.max(0, Math.min(view.slice.length - 1, Math.floor(x / cellW)));
    // ¿el cursor está sobre una burbuja?
    let near: Liquidation | null = null;
    if (layers.bubbles) {
      let best = 15;
      for (const l of visibleLiqs) {
        const d = Math.hypot(toX(l.ts) - x, toY(l.price) - y);
        if (d < best) {
          best = d;
          near = l;
        }
      }
    }
    setHover({ x, y, idx, price: toPrice(y), liq: near });
  };

  const jumpTo = (clientX: number, el: HTMLCanvasElement) => {
    const rect = el.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const center = Math.round(frac * total);
    const start = Math.max(0, Math.min(total - visible, center - Math.floor(visible / 2)));
    setOffset(Math.max(0, total - visible - start));
  };

  const hoveredCandle = hover ? view.slice[hover.idx] : null;
  const zoomLabel = total ? (total / Math.max(1, visible)).toFixed(1) : "1.0";
  const liqCount = api.liqTotals.count;

  const chart = (
    <>
      <div ref={wrapRef} className={fullscreen ? "relative min-h-0 flex-1" : "relative"}>
        {!candles.length ? (
          <Empty>cargando velas de binance…</Empty>
        ) : (
          <>
            <canvas
              ref={canvasRef}
              style={{
                width: "100%",
                height: fullscreen ? "100%" : size.h,
                display: "block",
                cursor: drag.current ? "grabbing" : "crosshair",
                touchAction: "pan-y",
              }}
              onMouseMove={onMouseMove}
              onMouseLeave={() => setHover(null)}
              onMouseDown={(e) => {
                drag.current = { x: e.clientX, startOffset: offset };
                document.body.style.cursor = "grabbing";
              }}
              onDoubleClick={() => {
                setVisible(Math.min(90, total));
                setOffset(0);
              }}
              onTouchStart={(e) => {
                setHover(null);
                if (e.touches.length >= 2) {
                  const dx = e.touches[0].clientX - e.touches[1].clientX;
                  const dy = e.touches[0].clientY - e.touches[1].clientY;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
                  pinch.current = {
                    dist: Math.hypot(dx, dy) || 1,
                    visible,
                    anchor: Math.max(0, Math.min(1, (cx - rect.left) / Math.max(1, plotW))),
                  };
                } else {
                  drag.current = { x: e.touches[0].clientX, startOffset: offset };
                }
              }}
              onTouchMove={(e) => {
                if (pinch.current && e.touches.length >= 2) {
                  const dx = e.touches[0].clientX - e.touches[1].clientX;
                  const dy = e.touches[0].clientY - e.touches[1].clientY;
                  const ratio = Math.hypot(dx, dy) / pinch.current.dist;
                  const next = Math.max(MIN_VISIBLE, Math.min(total, Math.round(pinch.current.visible / ratio)));
                  setVisible(next);
                  return;
                }
                const d = drag.current;
                if (d && e.touches.length === 1) {
                  const cellW = plotW / Math.max(1, visible);
                  const shift = Math.round((e.touches[0].clientX - d.x) / cellW);
                  setOffset(Math.max(0, Math.min(total - visible, d.startOffset + shift)));
                }
              }}
              onTouchEnd={() => {
                pinch.current = null;
                drag.current = null;
              }}
            />

            {offset > 0 && (
              <button
                onClick={() => setOffset(0)}
                className="absolute right-24 top-2 z-10 rounded-md border border-[rgba(255,181,69,0.5)] bg-[var(--color-warn-soft)] px-2.5 py-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-[var(--color-warn)]"
              >
                ⟶ al presente
              </button>
            )}

            {hover && (hoveredCandle || hover.liq) && (
              <div
                className="pointer-events-none absolute z-20 rounded-md border border-[var(--color-line)] bg-[rgba(10,14,23,0.97)] px-3 py-2 font-mono text-[10px] shadow-xl"
                style={{ left: Math.min(hover.x + 16, size.w - 210), top: Math.min(hover.y + 14, size.h - 150) }}
              >
                {hover.liq ? (
                  <>
                    <div className="mb-1 text-[9px] uppercase tracking-[0.14em] text-[var(--color-warn)]">
                      Liquidación real · {hover.liq.exchange}
                    </div>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                      <span className="text-[var(--color-dim)]">Lado</span>
                      <span className={`text-right font-bold ${hover.liq.side === "long" ? "up" : "down"}`}>
                        {hover.liq.side === "long" ? "LONG" : "SHORT"}
                      </span>
                      <span className="text-[var(--color-dim)]">Precio</span>
                      <span className="tnum text-right">{f.price(hover.liq.price, spec.decimals)}</span>
                      <span className="text-[var(--color-dim)]">Nocional</span>
                      <span className="tnum text-right text-[var(--color-warn)]">{f.usd(hover.liq.usd)}</span>
                      <span className="text-[var(--color-dim)]">Hora</span>
                      <span className="tnum text-right">{f.clockUTC(hover.liq.ts)}</span>
                    </div>
                  </>
                ) : (
                  hoveredCandle && (
                    <>
                      <div className="mb-1 text-[9px] uppercase tracking-[0.14em] text-[var(--color-dim)]">
                        {f.axisTime(hoveredCandle.t, tfSpec.minutes)} {f.hhmmUTC(hoveredCandle.t)} UTC
                      </div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                        {(["o", "h", "l", "c"] as const).map((k) => (
                          <span key={k} className="contents">
                            <span className="uppercase text-[var(--color-dim)]">{k}</span>
                            <span className="tnum text-right text-[var(--color-bright)]">
                              {f.price(hoveredCandle[k], spec.decimals)}
                            </span>
                          </span>
                        ))}
                        <span className="text-[var(--color-dim)]">Vol</span>
                        <span className="tnum text-right text-[var(--color-muted)]">{f.compact(hoveredCandle.v)}</span>
                      </div>
                    </>
                  )
                )}
              </div>
            )}
          </>
        )}
      </div>

      <div className="border-t border-[var(--color-line-soft)]">
        <canvas
          ref={miniRef}
          style={{ width: "100%", height: MINIMAP_H, display: "block", cursor: "ew-resize", touchAction: "pan-y" }}
          onMouseDown={(e) => {
            jumpTo(e.clientX, e.currentTarget);
            const el = e.currentTarget;
            const mv = (ev: MouseEvent) => jumpTo(ev.clientX, el);
            const up = () => {
              window.removeEventListener("mousemove", mv);
              window.removeEventListener("mouseup", up);
            };
            window.addEventListener("mousemove", mv);
            window.addEventListener("mouseup", up);
          }}
          onTouchStart={(e) => jumpTo(e.touches[0].clientX, e.currentTarget)}
          onTouchMove={(e) => jumpTo(e.touches[0].clientX, e.currentTarget)}
        />
      </div>
    </>
  );

  const toolbar = (
    <div className="slim flex items-center gap-x-3 gap-y-2 overflow-x-auto border-b border-[var(--color-line-soft)] px-4 py-2">
      {/*
        La temporalidad va PRIMERA y dentro del gráfico: es una propiedad del
        gráfico, no de la aplicación. Estaba solo en la barra superior, así que
        en pantalla completa no había manera de cambiarla, y al mirar el gráfico
        no se encontraba. Al ir la primera, sigue visible en móvil aunque la
        barra tenga scroll horizontal.
      */}
      <div className="flex shrink-0 items-stretch overflow-hidden rounded border border-[var(--color-line)]">
        {TIMEFRAMES.map((t) => (
          <button
            key={t.key}
            onClick={() => api.setTf(t.key)}
            title={t.label}
            className={`px-2 py-1 font-mono text-[10px] font-bold transition-colors ${
              t.key === api.tf
                ? "bg-[var(--color-up-soft)] text-[var(--color-up)]"
                : "text-[var(--color-dim)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-body)]"
            }`}
          >
            {t.key}
          </button>
        ))}
      </div>

      <span className="h-5 w-px shrink-0 bg-[var(--color-line)]" />

      <div className="flex shrink-0 items-center gap-1">
        {LAYERS.map((l) => (
          <button
            key={l.id}
            title={l.tip}
            onClick={() => setLayers((p) => ({ ...p, [l.id]: !p[l.id] }))}
            className={`rounded border px-2 py-1 font-mono text-[9px] font-semibold uppercase tracking-[0.08em] transition-colors ${
              layers[l.id]
                ? "border-[rgba(33,212,160,0.4)] bg-[var(--color-up-soft)] text-[var(--color-up)]"
                : "border-[var(--color-line)] text-[var(--color-dim)] hover:text-[var(--color-body)]"
            }`}
          >
            {l.label}
          </button>
        ))}
      </div>

      <span className="h-5 w-px shrink-0 bg-[var(--color-line)]" />

      <div className="flex shrink-0 items-center overflow-hidden rounded border border-[var(--color-line)]">
        {OSCS.map((o) => (
          <button
            key={o.id}
            onClick={() => setOsc(o.id)}
            className={`px-2 py-1 font-mono text-[9px] font-semibold uppercase transition-colors ${
              osc === o.id
                ? "bg-[var(--color-surface-3)] text-[var(--color-white)]"
                : "text-[var(--color-dim)] hover:text-[var(--color-body)]"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>

      <div className="flex shrink-0 items-center overflow-hidden rounded border border-[var(--color-line)]">
        <button onClick={() => zoomAt(1, 1)} className="px-2 py-1 font-mono text-[11px] font-bold text-[var(--color-muted)] hover:bg-[var(--color-surface-2)]">−</button>
        <button
          onClick={() => {
            setVisible(Math.min(90, total));
            setOffset(0);
          }}
          className="tnum border-x border-[var(--color-line)] px-2 py-1 text-[9px] font-semibold text-[var(--color-muted)] hover:bg-[var(--color-surface-2)]"
        >
          ×{zoomLabel}
        </button>
        <button onClick={() => zoomAt(-1, 1)} className="px-2 py-1 font-mono text-[11px] font-bold text-[var(--color-muted)] hover:bg-[var(--color-surface-2)]">+</button>
      </div>

      <button
        onClick={() => setFullscreen((v) => !v)}
        className="ml-auto shrink-0 rounded border border-[var(--color-line)] px-2 py-1 font-mono text-[9px] font-semibold uppercase tracking-[0.1em] text-[var(--color-muted)] hover:text-[var(--color-white)]"
      >
        {fullscreen ? "Salir · ESC" : "Ampliar"}
      </button>
    </div>
  );

  const body = (
    <>
      {toolbar}
      {chart}
      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-[var(--color-line-soft)] px-4 py-2.5 font-mono text-[9px] uppercase tracking-[0.1em] text-[var(--color-dim)]">
        {liqCount > 0 ? (
          <Tag kind="real">{visibleLiqs.length} liq. en pantalla · {liqCount} totales</Tag>
        ) : (
          <Tag kind="none">sin liquidaciones aún</Tag>
        )}
        <span>burbuja = una liquidación real · área ∝ nocional · aro ámbar = más de 1 M$</span>
        <span className="ml-auto normal-case tracking-normal">
          rueda = zoom · arrastrar = desplazar · pellizco en táctil · doble clic = reset
        </span>
      </footer>
    </>
  );

  if (fullscreen) {
    return createPortal(
      <div className="fixed inset-0 z-50 flex flex-col bg-[var(--color-bg)]">
        <div className="flex items-center gap-3 border-b border-[var(--color-line)] px-4 py-2">
          <span className="card-title">
            {spec.key} · {tfSpec.label} · {api.venue}
          </span>
          <span className="tnum ml-auto text-sm font-bold text-[var(--color-bright)]">
            {f.price(price, spec.decimals)}
          </span>
        </div>
        {body}
      </div>,
      document.body
    );
  }

  return (
    <Card
      title="Precio y liquidaciones reales"
      sub={`${spec.key} · ${tfSpec.label} · ${api.venue}`}
      delay={40}
    >
      {body}
    </Card>
  );
}
