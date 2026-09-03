// ============================================================
// ¿APARECE EN BINANCE EL PATRÓN DE HYPERLIQUID?
//
// EL HALLAZGO A CONFIRMAR. En Hyperliquid, cuando la proporción de órdenes
// canceladas se dispara, el mercado se mueve MENOS en las horas siguientes:
// −3,3σ a 1, 2 y 4 horas, doce celdas con el mismo signo.
//
// La explicación mecánica era que una cancelación alta es síntoma de calma:
// los creadores de mercado cotizan y recotizan sin parar. Cuando llega
// volatilidad las órdenes se EJECUTAN en vez de cancelarse.
//
// EL PROBLEMA. Binance no publica cuentas de órdenes puestas ni canceladas.
// No hay forma de medir lo mismo.
//
// EL SUSTITUTO, y sus límites. `bookDepth` de data.binance.vision da una foto
// del libro cada ~28 s. Si los creadores recotizan mucho, el nocional en cada
// nivel BAILA entre fotos consecutivas. Esa rotación es el eco observable de
// la actividad de cotización.
//
// No es la misma medida y conviene decirlo: la rotación mezcla recotización
// con ejecución, mientras que la proporción de cancelaciones las separa. Si
// el patrón aparece igual, refuerza el hallazgo; si no aparece, no lo
// refuta — puede ser que el sustituto no sirva.
//
//   node_modules/.bin/esbuild .probe/churn.ts --bundle --platform=node \
//     --format=esm --outfile=.probe/churn.mjs && node .probe/churn.mjs
// ============================================================
import { inflateRawSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const V = "https://data.binance.vision/data/futures/um/daily";
const F = "https://fapi.binance.com/fapi/v1";
const CACHE = ".probe/cache";
const DIAS = 30;
/** Ventana del tipificado móvil, en horas. La misma que en Hyperliquid. */
const VENTANA = 72;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const media = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const sdOf = (a: number[]) => {
  const m = media(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

async function enTandas<A, B>(items: A[], ancho: number, fn: (a: A) => Promise<B>): Promise<B[]> {
  const out: B[] = [];
  for (let i = 0; i < items.length; i += ancho) out.push(...(await Promise.all(items.slice(i, i + ancho).map(fn))));
  return out;
}

/** Nocional total del libro en cada foto. */
async function bookDay(symbol: string, fecha: string): Promise<{ t: number; usd: number }[]> {
  mkdirSync(CACHE, { recursive: true });
  const f = `${CACHE}/churn-${symbol}-${fecha}.json`;
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));

  let buf: Buffer | null = null;
  for (let i = 0; i < 4 && !buf; i++) {
    try {
      const r = await fetch(`${V}/bookDepth/${symbol}/${symbol}-bookDepth-${fecha}.zip`, { signal: AbortSignal.timeout(60000) });
      if (!r.ok) { writeFileSync(f, "[]"); return []; }
      buf = Buffer.from(await r.arrayBuffer());
    } catch { await sleep(1500 * (i + 1)); }
  }
  if (!buf) { return []; }

  const off = buf.indexOf(Buffer.from("PK\x03\x04"));
  const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
  const txt = inflateRawSync(buf.subarray(start)).toString("utf8");

  // Se usa la banda ±1 %: es donde los creadores de mercado recotizan de
  // verdad. Más lejos las órdenes se quedan quietas y no reflejan actividad.
  const acc = new Map<number, number>();
  for (const line of txt.split("\n").slice(1)) {
    const [ts, pct, , notional] = line.split(",");
    if (!ts || !notional) continue;
    if (pct !== "-1.00" && pct !== "1.00") continue;
    const t = Date.parse(ts.replace(" ", "T") + "Z");
    if (!Number.isFinite(t)) continue;
    acc.set(t, (acc.get(t) ?? 0) + Number(notional));
  }
  const out = [...acc.entries()].map(([t, usd]) => ({ t, usd })).sort((a, b) => a.t - b.t);
  writeFileSync(f, JSON.stringify(out));
  return out;
}

async function klines(symbol: string, desde: number, hasta: number) {
  mkdirSync(CACHE, { recursive: true });
  const f = `${CACHE}/churn-k-${symbol}-${desde}-${hasta}.json`;
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8")) as { t: number; c: number }[];
  const out: { t: number; c: number }[] = [];
  let s = desde;
  while (s < hasta) {
    const r = await fetch(`${F}/klines?symbol=${symbol}&interval=1h&limit=1500&startTime=${s}&endTime=${hasta}`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) break;
    const j = (await r.json()) as (string | number)[][];
    if (!Array.isArray(j) || !j.length) break;
    out.push(...j.map((k) => ({ t: +k[0], c: +k[4] })));
    if (j.length < 1500) break;
    s = Number(j[j.length - 1][0]) + 1;
    await sleep(80);
  }
  writeFileSync(f, JSON.stringify(out));
  return out;
}

const dias = (n: number, hasta = Date.now() - 2 * 864e5) =>
  Array.from({ length: n }, (_, i) => new Date(hasta - (n - 1 - i) * 864e5).toISOString().slice(0, 10));

async function main() {
  const SIM = "BTCUSDT";
  const D = dias(DIAS);
  console.log(`\n\x1b[1m¿APARECE EN BINANCE?\x1b[0m  ${SIM} · ${D[0]} → ${D.at(-1)}`);
  console.log(`\x1b[2msustituto: rotación del libro entre fotos de 28 s, banda ±1 %\x1b[0m`);
  process.stdout.write(`\x1b[2mdescargando ${DIAS} días… \x1b[0m`);

  const fotos = (await enTandas(D, 8, (d) => bookDay(SIM, d))).flat().sort((a, b) => a.t - b.t);
  if (fotos.length < 5000) { console.log("sin libro suficiente"); return; }
  const vel = await klines(SIM, fotos[0].t, fotos[fotos.length - 1].t);
  console.log(`${fotos.length.toLocaleString()} fotos · ${vel.length} velas\n`);

  // ---------- rotación por hora ----------
  // |cambio| relativo del nocional entre fotos consecutivas, promediado.
  const porHora = new Map<number, number[]>();
  for (let i = 1; i < fotos.length; i++) {
    const dt = fotos[i].t - fotos[i - 1].t;
    if (dt <= 0 || dt > 120_000) continue; // hueco en los datos: no es rotación
    const prev = fotos[i - 1].usd;
    if (!(prev > 0)) continue;
    const h = Math.floor(fotos[i].t / 3600_000) * 3600_000;
    const v = porHora.get(h) ?? [];
    v.push(Math.abs(fotos[i].usd - prev) / prev);
    porHora.set(h, v);
  }
  const serie = [...porHora.entries()]
    .filter(([, v]) => v.length >= 30) // horas con pocas fotos no son fiables
    .map(([t, v]) => ({ t, churn: media(v) }))
    .sort((a, b) => a.t - b.t);

  const precioEn = (ts: number) => {
    let lo = 0, hi = vel.length - 1, r: { t: number; c: number } | null = null;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (vel[m].t <= ts) { r = vel[m]; lo = m + 1; } else hi = m - 1; }
    return r && ts - r.t <= 2 * 3600_000 ? r.c : NaN;
  };

  const ch = serie.map((s) => s.churn);
  console.log(`  ${serie.length} horas útiles · rotación mediana ${(ch.slice().sort((a, b) => a - b)[ch.length >> 1] * 100).toFixed(2)} % por foto\n`);

  console.log(`  ${"horizonte".padEnd(11)}${"umbral z".padStart(9)}${"casos".padStart(7)}${"alta rot.".padStart(11)}${"resto".padStart(9)}${"σ".padStart(8)}`);
  console.log(`  ${"─".repeat(55)}`);

  for (const H of [1, 2, 4, 8]) {
    for (const UZ of [1.0, 1.5]) {
      const pts: { z: number; mov: number }[] = [];
      for (let i = VENTANA; i < serie.length - H; i++) {
        const w = serie.slice(i - VENTANA, i).map((s) => s.churn);
        const m = media(w), sd = sdOf(w);
        if (!(sd > 0)) continue;
        const p0 = precioEn(serie[i].t), p1 = precioEn(serie[i].t + H * 3600_000);
        if (!(p0 > 0) || !(p1 > 0)) continue;
        pts.push({ z: (serie[i].churn - m) / sd, mov: Math.abs(((p1 - p0) / p0) * 100) });
      }
      const alt = pts.filter((p) => p.z >= UZ).map((p) => p.mov);
      const res = pts.filter((p) => p.z < UZ).map((p) => p.mov);
      if (alt.length < 10) { console.log(`  ${(H + " h").padEnd(11)}${String(UZ).padStart(9)}${String(alt.length).padStart(7)}   pocos casos`); continue; }
      const ma = media(alt), mr = media(res);
      const se = Math.sqrt(sdOf(alt) ** 2 / alt.length + sdOf(res) ** 2 / res.length);
      const z = (ma - mr) / se;
      const col = Math.abs(z) > 1.96 ? (z < 0 ? "\x1b[32m" : "\x1b[33m") : "\x1b[2m";
      console.log(`  ${(H + " h").padEnd(11)}${String(UZ).padStart(9)}${String(alt.length).padStart(7)}` +
        `${ma.toFixed(3).padStart(11)}${mr.toFixed(3).padStart(9)}${col}${z.toFixed(2).padStart(8)}\x1b[0m`);
    }
  }
  console.log(`\n\x1b[2m  verde = MENOS volatilidad tras rotación alta (replicaría Hyperliquid)`);
  console.log(`  ámbar = MÁS volatilidad (lo contrario)   ·   gris = indistinguible del azar\x1b[0m\n`);
}

main();
