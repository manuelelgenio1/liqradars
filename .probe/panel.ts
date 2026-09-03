// ============================================================
// ¿Acierta el panel de señales?
//
// Es el panel más visible de la app: dice LONG o SHORT con un porcentaje de
// convicción, y nunca se ha comprobado si supera a una moneda al aire. Los
// pesos de `scoreSignal` los puse a ojo; el historial no ha opinado todavía.
//
// Esto reconstruye las ENTRADAS REALES del panel en cada instante del pasado
// y llama al MISMO código que corre en producción — buildSignal y
// evaluateSignal, sin copias ni versiones simplificadas.
//
// QUÉ SE PUEDE RECONSTRUIR Y QUÉ NO
//   consenso técnico   peso 0,30   ✓ velas de Binance
//   confluencia MTF    peso 0,25   ✓ velas de 5 temporalidades
//   liquidaciones      peso 0,20   ✗ NO existe histórico gratuito
//   libro de órdenes   peso 0,13   ✓ archivo bookDepth de data.binance.vision
//   apalancamiento     peso 0,12   ✓ funding + OI horario (30 días)
//
// Se reconstruye el 80 % del peso. El componente de liquidaciones entra a
// cero, así que esto mide el panel SIN esa pata — que es justo la que
// tampoco está demostrada, así que puede verse como su núcleo honesto.
//
// SIN LOOK-AHEAD en ningún punto: indicadores sobre prefijos, confluencia
// recalculada con las velas disponibles en ese instante, y del libro se toma
// la última foto ANTERIOR al cierre de la vela.
//
//   node_modules/.bin/esbuild .probe/panel.ts --bundle --platform=node \
//     --format=esm --outfile=.probe/panel.mjs && node .probe/panel.mjs
// ============================================================
import { inflateRawSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { buildSignal, computeStats, type Signal, type SignalInputs } from "../src/lib/signals";
import { computeAll, configFor, type Trend } from "../src/lib/indicators";
import type { Candle } from "../src/lib/types";

const V = "https://data.binance.vision/data/futures/um/daily";
const F = "https://fapi.binance.com";
const CACHE = ".probe/cache";

const SYMS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"];
/** Las cinco que mira la confluencia en la app, con sus minutos. */
const MTF: [string, string, number][] = [
  ["5m", "5m", 5], ["15m", "15m", 15], ["1H", "1h", 60], ["4H", "4h", 240], ["1D", "1d", 1440],
];
/*
  Configurable, porque la pregunta cambia según el marco:

    DIAS=28  ACTIVAS=5m,15m,1H   → el 80 % del peso, muestra corta por marco
    DIAS=180 ACTIVAS=1H,4H,1D    → marcos anchos, pero SIN el componente de
                                   apalancamiento antes de los últimos 30 días

  El histórico de OI de Binance son 30 días y no se puede estirar. Más allá,
  `oiDelta1hPct` entra como NaN y la pata de apalancamiento aporta cero — que
  es exactamente lo que hace la app cuando ese endpoint falla, así que no se
  está simulando nada que no pueda pasar en producción.
*/
const ACTIVAS = (process.env.ACTIVAS ?? "5m,15m,1H").split(",");
const DIAS = Number(process.env.DIAS ?? 28);

/*
  SIN_LIBRO=1 salta la descarga del archivo bookDepth.

  Hace falta para el marco diario. Con una posición a la vez y un máximo de 48
  velas abierta, una señal diaria puede durar 48 días: en 180 días caben 3 por
  símbolo, 18 en total. Eso no es una muestra, es una anécdota. Para medir el
  diario hay que irse a años — y descargar el libro de tres años son más de
  6.500 ficheros.

  El coste de saltarlo es explícito: se pierde el peso 0,13 del libro, así que
  quedan consenso (0,30) y confluencia (0,25) — el 55 % del modelo. Se dice al
  imprimir, para que nadie compare peras con manzanas.
*/
const SIN_LIBRO = process.env.SIN_LIBRO === "1";
const MAX_PREFIX = 400;
const WARMUP = 200;
/** Ventana para considerar dos señales el mismo suceso de mercado. */
const EVENTO_MS = 30 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const media = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

/** Descarga en tandas: con 180 días por símbolo, en serie tardaría horas. */
async function enTandas<A, B>(items: A[], ancho: number, fn: (a: A) => Promise<B>): Promise<B[]> {
  const out: B[] = [];
  for (let i = 0; i < items.length; i += ancho) {
    out.push(...(await Promise.all(items.slice(i, i + ancho).map(fn))));
  }
  return out;
}

// ---------------- descarga ----------------

async function getJson<T>(url: string): Promise<T | null> {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
      if (r.ok) return (await r.json()) as T;
      if (r.status !== 429 && r.status < 500) return null;
    } catch { /* reintento */ }
    await sleep(1000 * (i + 1));
  }
  return null;
}

function cached<T>(clave: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(CACHE, { recursive: true });
  const f = `${CACHE}/${clave}.json`;
  if (existsSync(f)) return Promise.resolve(JSON.parse(readFileSync(f, "utf8")));
  return fn().then((v) => { writeFileSync(f, JSON.stringify(v)); return v; });
}

const klines = (symbol: string, interval: string, desde: number, hasta: number) =>
  cached(`p-k-${symbol}-${interval}-${desde}-${hasta}`, async () => {
    const out: Candle[] = [];
    let s = desde;
    while (s < hasta) {
      const j = await getJson<(string | number)[][]>(
        `${F}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=1500&startTime=${s}&endTime=${hasta}`
      );
      if (!Array.isArray(j) || !j.length) break;
      out.push(...j.map((k) => {
        const v = Number(k[5]) || 0, tb = Number(k[9]) || 0;
        return { t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v, delta: v > 0 ? tb * 2 - v : 0 };
      }));
      if (j.length < 1500) break;
      s = Number(j[j.length - 1][0]) + 1;
      await sleep(70);
    }
    return out;
  });

/** Libro histórico. Se usa la banda ±0,2 %, la más parecida a los 50 niveles que pide la app. */
const bookDay = (symbol: string, fecha: string) =>
  cached(`p-b-${symbol}-${fecha}`, async () => {
    // Con reintentos: son más de mil ficheros y un solo timeout de red tumbaba
    // la ejecución entera después de veinte minutos de descarga.
    let buf: Buffer | null = null;
    for (let i = 0; i < 4 && !buf; i++) {
      try {
        const r = await fetch(`${V}/bookDepth/${symbol}/${symbol}-bookDepth-${fecha}.zip`, { signal: AbortSignal.timeout(60000) });
        if (!r.ok) return [] as { t: number; imb: number }[]; // no existe ese día: no se reintenta
        buf = Buffer.from(await r.arrayBuffer());
      } catch {
        await sleep(1500 * (i + 1));
      }
    }
    if (!buf) {
      // Se devuelve vacío en vez de reventar: un día sin libro degrada la
      // muestra, perderlo todo la destruye.
      console.warn(`
  [33msin libro: ${symbol} ${fecha}[0m`);
      return [] as { t: number; imb: number }[];
    }
    const off = buf.indexOf(Buffer.from("PK\x03\x04"));
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const txt = inflateRawSync(buf.subarray(start)).toString("utf8");

    const snaps = new Map<number, Record<string, number>>();
    for (const line of txt.split("\n").slice(1)) {
      const [ts, pct, , notional] = line.split(",");
      if (!ts || !notional) continue;
      const t = Date.parse(ts.replace(" ", "T") + "Z");
      if (!Number.isFinite(t)) continue;
      let s = snaps.get(t);
      if (!s) { s = {}; snaps.set(t, s); }
      s[pct] = Number(notional);
    }
    const out: { t: number; imb: number }[] = [];
    for (const [t, s] of snaps) {
      const bid = s["-0.20"], ask = s["0.20"];
      if (bid > 0 && ask > 0) out.push({ t, imb: (bid - ask) / (bid + ask) });
    }
    return out.sort((a, b) => a.t - b.t);
  });

/** funding, en % — igual que `lastFundingRate * 100` en la app */
const funding = (symbol: string) =>
  cached(`p-f-${symbol}`, async () => {
    const j = await getJson<{ fundingTime: number; fundingRate: string }[]>(
      `${F}/fapi/v1/fundingRate?symbol=${symbol}&limit=1000`
    );
    return (j ?? []).map((x) => ({ t: Number(x.fundingTime), pct: Number(x.fundingRate) * 100 }))
      .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.pct)).sort((a, b) => a.t - b.t);
  });

/** variación horaria del OI, en % — igual que `delta1hPct` en la app */
const oiDelta = (symbol: string) =>
  cached(`p-oi-${symbol}`, async () => {
    const j = await getJson<{ timestamp: number; sumOpenInterestValue: string }[]>(
      `${F}/futures/data/openInterestHist?symbol=${symbol}&period=1h&limit=500`
    );
    const v = (j ?? []).map((x) => ({ t: Number(x.timestamp), oi: Number(x.sumOpenInterestValue) }))
      .filter((x) => Number.isFinite(x.t) && x.oi > 0).sort((a, b) => a.t - b.t);
    return v.slice(1).map((x, i) => ({ t: x.t, pct: ((x.oi - v[i].oi) / v[i].oi) * 100 }));
  });

/** Último valor con t <= objetivo. Nunca mira hacia delante. */
function ultimoAntes<T extends { t: number }>(arr: T[], objetivo: number, maxEdadMs = Infinity): T | null {
  let lo = 0, hi = arr.length - 1, res: T | null = null;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (arr[m].t <= objetivo) { res = arr[m]; lo = m + 1; } else hi = m - 1;
  }
  return res && objetivo - res.t <= maxEdadMs ? res : null;
}

// ---------------- simulación ----------------

/** Generador determinista: el control debe ser reproducible entre ejecuciones. */
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Confluencia tal y como la calcula `useConfluence`, con las velas de ese instante. */
function confluencia(
  velasPorTf: Map<string, Candle[]>,
  hasta: number
): { trend: Trend | null; agreement: number } {
  const filas: Trend[] = [];
  for (const [tf, , min] of MTF) {
    const c = velasPorTf.get(tf);
    if (!c) continue;
    // solo velas ya CERRADAS en ese instante
    const fin = ultimoAntes(c, hasta - min * 60_000);
    if (!fin) continue;
    const idx = c.indexOf(fin);
    if (idx < 60) continue;
    const prefix = c.slice(Math.max(0, idx + 1 - 260), idx + 1);
    filas.push(computeAll(prefix, configFor(tf), min).consensus.trend);
  }
  const dir = filas.filter((t) => t !== "lateral");
  if (!dir.length) return { trend: null, agreement: 0 };
  const ups = dir.filter((t) => t === "alcista").length;
  const downs = dir.length - ups;
  if (ups === downs) return { trend: null, agreement: 0 };
  return { trend: ups > downs ? "alcista" : "bajista", agreement: Math.max(ups, downs) / dir.length };
}

interface Contexto {
  book: { t: number; imb: number }[];
  fund: { t: number; pct: number }[];
  oi: { t: number; pct: number }[];
  mtf: Map<string, Candle[]>;
}

function simular(symbol: string, tf: string, tfMin: number, velas: Candle[], ctx: Contexto, rand: () => number): Signal[] {
  const cfg = configFor(tf);
  const ms = tfMin * 60_000;
  const out: Signal[] = [];
  let cooldown = -1;

  for (let i = WARMUP; i < velas.length - 1; i++) {
    if (i < cooldown) continue; // una posición a la vez
    const cierre = velas[i].t + ms;

    const prefix = velas.slice(Math.max(0, i + 1 - MAX_PREFIX), i + 1);
    const bundle = computeAll(prefix, cfg, tfMin);
    const atr = bundle.atr.at(-1) ?? NaN;
    if (!(atr > 0)) continue;

    const conf = confluencia(ctx.mtf, cierre);
    const b = ultimoAntes(ctx.book, cierre, 5 * 60_000);
    const f = ultimoAntes(ctx.fund, cierre);
    const o = ultimoAntes(ctx.oi, cierre, 3 * 60 * 60_000);

    const inp: SignalInputs = {
      symbol, timeframe: tf, price: velas[i].c, atr, indicators: bundle,
      confluenceTrend: conf.trend,
      confluenceAgreement: conf.agreement,
      // No hay histórico de liquidaciones: esta pata entra a cero.
      liqLong: 0, liqShort: 0,
      bookImbalance: b ? b.imb : NaN,
      fundingPct: f ? f.pct : NaN,
      oiDelta1hPct: o ? o.pct : NaN,
    };

    const sig = buildSignal(inp, velas[i].t, rand);
    if (!sig) continue;

    const resuelta = evaluar(sig, velas.slice(i + 1));
    if (!resuelta) continue;
    out.push(resuelta);
    const fin = velas.findIndex((k) => k.t === resuelta.resolvedTs);
    cooldown = fin > i ? fin + 1 : i + 12;
  }
  return out;
}

// evaluateSignal filtra por ts, así que se le pasan solo las velas futuras
import { evaluateSignal } from "../src/lib/signals";
function evaluar(sig: Signal, futuro: Candle[]): Signal | null {
  const r = evaluateSignal(sig, futuro);
  return r.outcome === "abierta" ? null : r;
}

// ---------------- informe ----------------

/** Agrupa señales próximas en el tiempo: una cascada de mercado es un solo dato. */
function porSuceso(sigs: Signal[]): number[] {
  const orden = [...sigs].sort((a, b) => a.ts - b.ts);
  const grupos: Signal[][] = [];
  for (const s of orden) {
    const g = grupos[grupos.length - 1];
    if (g && s.ts - g[0].ts <= EVENTO_MS) g.push(s);
    else grupos.push([s]);
  }
  return grupos.map((g) => media(g.map((s) => (s.rNet ?? s.r ?? 0))));
}

function informe(titulo: string, sigs: Signal[]) {
  if (sigs.length < 10) { console.log(`\n\x1b[1m${titulo}\x1b[0m  muestra insuficiente (${sigs.length})`); return; }
  const st = computeStats(sigs);
  const grupos = porSuceso(sigs);
  const n = grupos.length;
  const m = media(grupos);
  const sd = Math.sqrt(grupos.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1));
  const t = sd > 0 ? m / (sd / Math.sqrt(n)) : NaN;
  const col = (v: number) => (v > 0 ? "\x1b[32m+" : "\x1b[31m") + v.toFixed(3) + "R\x1b[0m";

  console.log(`\n\x1b[1m${titulo}\x1b[0m`);
  console.log(`  ${"─".repeat(62)}`);
  console.log(`  señales       ${st.resolved}  →  ${n} sucesos independientes`);
  console.log(`  aciertos      ${(st.winRate * 100).toFixed(1)}%      moneda al aire ${(st.controlWinRate * 100).toFixed(1)}%`);
  console.log(`  bruto         ${col(st.expectancy)}      coste -${st.avgCostR.toFixed(3)}R`);
  console.log(`  \x1b[1mNETO          ${col(st.expectancyNet)}\x1b[0m      control ${col(st.controlExpectancy)}`);
  console.log(`  t (sucesos)   ${Number.isFinite(t) ? t.toFixed(2) : "—"}   ${t > 2 && m > 0 ? "\x1b[32m✓ supera el azar\x1b[0m" : "\x1b[31m✗ no se distingue del azar\x1b[0m"}`);
  console.log(`  acumulado     ${st.totalRNet > 0 ? "+" : ""}${st.totalRNet.toFixed(1)}R neto · peor racha -${st.maxDrawdownR.toFixed(1)}R`);
  console.log(`  \x1b[1m${st.verdict}\x1b[0m`);
}

// ---------------- principal ----------------

async function main() {
  const hasta = Date.now() - 2 * 864e5;
  const desde = hasta - DIAS * 864e5;
  const fechas = Array.from({ length: DIAS }, (_, i) =>
    new Date(desde + i * 864e5).toISOString().slice(0, 10));

  console.log(`\n\x1b[1mPANEL DE SEÑALES · ¿supera a una moneda al aire?\x1b[0m`);
  console.log(`${fechas[0]} → ${fechas.at(-1)} · ${SYMS.length} símbolos · ${ACTIVAS.join(", ")}`);
  console.log(`\x1b[2mentradas reales reconstruidas: consenso, confluencia MTF, libro, funding y OI`);
  console.log(`liquidaciones a cero (no hay histórico) → se mide el 80 % del peso del modelo\x1b[0m`);

  const porTf = new Map<string, Signal[]>();
  const todas: Signal[] = [];

  for (const sym of SYMS) {
    process.stdout.write(`\n\x1b[2m${sym}\x1b[0m `);

    const mtf = new Map<string, Candle[]>();
    for (const [tf, itv] of MTF) {
      // margen extra hacia atrás para que las temporalidades altas tengan calentamiento
      // 300 velas de calentamiento por marco, en milisegundos reales
      const min = MTF.find((m) => m[0] === tf)![2];
      mtf.set(tf, await klines(sym, itv, desde - 300 * min * 60_000, hasta));
    }
    const ctx: Contexto = {
      book: SIN_LIBRO ? [] : (await enTandas(fechas, 8, (d) => bookDay(sym, d))).flat().sort((a, b) => a.t - b.t),
      fund: await funding(sym),
      oi: await oiDelta(sym),
      mtf,
    };
    process.stdout.write(`libro ${ctx.book.length} · funding ${ctx.fund.length} · oi ${ctx.oi.length} `);

    for (const tf of ACTIVAS) {
      const min = MTF.find((m) => m[0] === tf)![2];
      const velas = (mtf.get(tf) ?? []).filter((k) => k.t >= desde - MAX_PREFIX * min * 60_000);
      if (velas.length < WARMUP + 100) continue;
      const s = simular(sym, tf, min, velas, ctx, mulberry(sym.length * 7919 + min));
      todas.push(...s);
      porTf.set(tf, [...(porTf.get(tf) ?? []), ...s]);
      process.stdout.write(`· ${tf}:${s.length} `);
    }
  }

  console.log("\n");
  informe("TODO JUNTO", todas);
  for (const tf of ACTIVAS) informe(`Temporalidad ${tf}`, porTf.get(tf) ?? []);

  // ¿Sirve de algo la convicción que muestra el panel?
  const conv = todas.filter((s) => Number.isFinite(s.r));
  const alta = conv.filter((s) => s.score >= 0.55);
  const baja = conv.filter((s) => s.score < 0.55);
  console.log(`\n\x1b[1m═══ ¿VALE ALGO EL % DE CONVICCIÓN? ═══\x1b[0m`);
  informe("Convicción alta (≥55 %)", alta);
  informe("Convicción baja (<55 %)", baja);
}

main();
