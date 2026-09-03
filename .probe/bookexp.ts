// ============================================================
// ¿Predice el desequilibrio del libro de órdenes?
//
// data.binance.vision publica el libro histórico (`bookDepth`): una foto cada
// ~28 s con doce niveles de profundidad (±0,2 / 1 / 2 / 3 / 4 / 5 % del medio)
// y el nocional acumulado en cada uno. Está disponible desde 2023 y para todos
// los símbolos. Es lo que hace medible esta pregunta.
//
// TRES hipótesis fijadas de antemano — desequilibrio cerca del precio (±0,2 %),
// medio (±1 %) y profundo (±5 %). Tres contrastes ⇒ Bonferroni: α = 0,05/3
// ⇒ hace falta t ≈ 2,39, no 2.
//
// Y se mide LO QUE IMPORTA: el retorno medio neto de comisiones. El porcentaje
// de aciertos se reporta al lado, porque en "Contra EMA+RSI" las dos métricas
// divergieron —acertaba más veces y aun así perdía— y conviene poder verlo.
//
// Sin look-ahead: para decidir en el cierre de la vela i solo se usa la última
// foto del libro anterior o igual a ese instante, y el tipificado usa una
// ventana móvil que solo mira hacia atrás.
//
//   node_modules/.bin/esbuild .probe/bookexp.ts --bundle --platform=node \
//     --format=esm --outfile=.probe/bookexp.mjs && node .probe/bookexp.mjs
// ============================================================
import { inflateRawSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const V = "https://data.binance.vision/data/futures/um/daily";
const F = "https://fapi.binance.com";
const CACHE = ".probe/cache";

const SYMS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"];
const TFS: [string, number][] = [["5m", 300_000], ["15m", 900_000]];
const BANDAS = ["0.20", "1.00", "5.00"];
const DIAS = 30;
/** ventana del tipificado: sin ella, el sesgo estructural de cada símbolo inclinaría todo hacia un lado */
const VENTANA = 480;
const UMBRAL = 1.5;
const H = 12;
const COSTE = 0.14;
const REQ = 2.39; // Bonferroni, 3 contrastes

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const media = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

interface Snap { t: number; imb: Record<string, number> }
interface K { t: number; c: number }

function unzip(buf: Buffer): string {
  const off = buf.indexOf(Buffer.from("PK\x03\x04"));
  const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
  return inflateRawSync(buf.subarray(start)).toString("utf8");
}

/** Un día de libro. El nocional viene ACUMULADO desde el medio hacia fuera. */
async function bookDay(symbol: string, fecha: string): Promise<Snap[]> {
  mkdirSync(CACHE, { recursive: true });
  const f = `${CACHE}/${symbol}-${fecha}.json`;
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));

  const r = await fetch(`${V}/bookDepth/${symbol}/${symbol}-bookDepth-${fecha}.zip`, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) { writeFileSync(f, "[]"); return []; }

  const snaps = new Map<number, Record<string, number>>();
  for (const line of unzip(Buffer.from(await r.arrayBuffer())).split("\n").slice(1)) {
    const [ts, pct, , notional] = line.split(",");
    if (!ts || !notional) continue;
    const t = Date.parse(ts.replace(" ", "T") + "Z");
    if (!Number.isFinite(t)) continue;
    let s = snaps.get(t);
    if (!s) { s = {}; snaps.set(t, s); }
    s[pct] = Number(notional);
  }

  const out: Snap[] = [];
  for (const [t, s] of snaps) {
    const imb: Record<string, number> = {};
    for (const p of BANDAS) {
      const bid = s[`-${p}`], ask = s[p];
      if (bid > 0 && ask > 0) imb[p] = (bid - ask) / (bid + ask); // −1..1
    }
    if (Object.keys(imb).length) out.push({ t, imb });
  }
  out.sort((a, b) => a.t - b.t);
  writeFileSync(f, JSON.stringify(out));
  return out;
}

async function klines(symbol: string, interval: string, startTime: number, endTime: number): Promise<K[]> {
  mkdirSync(CACHE, { recursive: true });
  const f = `${CACHE}/k-${symbol}-${interval}-${startTime}-${endTime}.json`;
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
  const out: K[] = [];
  let s = startTime;
  while (s < endTime) {
    const r = await fetch(`${F}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=1500&startTime=${s}&endTime=${endTime}`, { signal: AbortSignal.timeout(20000) });
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

/** Tipificado móvil, mirando solo hacia atrás. */
function zscores(book: Snap[], banda: string): Map<number, number> {
  const hist: number[] = [];
  const z = new Map<number, number>();
  for (const b of book) {
    const v = b.imb[banda];
    if (!Number.isFinite(v)) continue;
    if (hist.length >= 60) {
      const w = hist.slice(-VENTANA);
      const m = media(w);
      const sd = Math.sqrt(w.reduce((s, x) => s + (x - m) ** 2, 0) / (w.length - 1));
      if (sd > 0) z.set(b.t, (v - m) / sd);
    }
    hist.push(v);
  }
  return z;
}

interface Fila { bruto: number; n: number; hr: number; base: number }

async function main() {
  const D = dias(DIAS);
  console.log(`\x1b[1mDESEQUILIBRIO DEL LIBRO\x1b[0m  ${D[0]} → ${D.at(-1)}`);
  console.log(`umbral |z|>${UMBRAL} · horizonte ${H} velas · coste ${COSTE}% ida y vuelta\n`);

  const acc = new Map<string, Fila[]>();

  for (const sym of SYMS) {
    const book = (await Promise.all(D.map((d) => bookDay(sym, d)))).flat().sort((a, b) => a.t - b.t);
    if (book.length < 5000) { console.log(`  \x1b[2m${sym}: sin libro suficiente\x1b[0m`); continue; }

    for (const [tf, ms] of TFS) {
      const k = await klines(sym, tf, book[0].t, book.at(-1)!.t);
      if (k.length < 300) continue;

      for (const banda of BANDAS) {
        const z = zscores(book, banda);
        const orden = [...z.keys()].sort((a, b) => a - b);

        const rets: number[] = [];
        let hits = 0, ups = 0, tot = 0, j = 0, cooldown = -1;
        for (let i = 0; i + H < k.length; i++) {
          const cierre = k[i].t + ms;
          while (j + 1 < orden.length && orden[j + 1] <= cierre) j++;
          if (k[i + H].c > k[i].c) ups++;
          tot++;
          if (i < cooldown) continue;
          const ts = orden[j];
          if (!(ts <= cierre) || cierre - ts > 120_000) continue; // foto demasiado vieja
          const zz = z.get(ts);
          if (!Number.isFinite(zz) || Math.abs(zz!) < UMBRAL) continue;

          // hipótesis por defecto: más compras ⇒ sube. El signo del resultado
          // dirá si en realidad ocurre lo contrario.
          const ret = ((zz! > 0 ? 1 : -1) * (k[i + H].c - k[i].c)) / k[i].c * 100;
          rets.push(ret);
          if (ret > 0) hits++;
          cooldown = i + H;
        }
        if (rets.length >= 25) {
          const key = `${banda}|${tf}`;
          if (!acc.has(key)) acc.set(key, []);
          acc.get(key)!.push({ bruto: media(rets), n: rets.length, hr: hits / rets.length, base: ups / tot });
        }
      }
    }
    process.stdout.write(`\x1b[2m${sym} \x1b[0m`);
  }
  console.log("\n");

  for (const [tf] of TFS) {
    console.log(`\x1b[1m═══ ${tf} ═══\x1b[0m`);
    for (const banda of BANDAS) {
      const filas = acc.get(`${banda}|${tf}`) ?? [];
      if (filas.length < 4) { console.log(`  ±${banda}%  sin muestra`); continue; }

      // Una observación por serie: los símbolos de cripto están correlacionados
      // y tratarlos como independientes infla la significación.
      const netos = filas.map((f) => f.bruto - COSTE);
      const n = netos.length;
      const m = media(netos);
      const sd = Math.sqrt(netos.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1));
      const t = m / (sd / Math.sqrt(n));
      const ops = filas.reduce((s, f) => s + f.n, 0);
      const vent = media(filas.map((f) => f.hr - f.base)) * 100;
      const pos = netos.filter((x) => x > 0).length;
      const c = (v: number, u = "%") => (v > 0 ? "\x1b[32m+" : "\x1b[31m") + v.toFixed(4) + u + "\x1b[0m";
      console.log(
        `  \x1b[1m±${banda}%\x1b[0m  ${String(ops).padStart(5)} op · ${n} series   ` +
        `bruto ${c(media(filas.map((f) => f.bruto)))}  neto \x1b[1m${c(m)}\x1b[0m   ` +
        `t=${t.toFixed(2)}  ${pos}/${n}+   acierto ${c(vent, "pts")}  ` +
        `${t > REQ && m > 0 ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"}`
      );
    }
    console.log("");
  }
  console.log(`\x1b[2mlistón: t>${REQ} (Bonferroni, 3 contrastes). "acierto" es la ventaja en puntos`);
  console.log(`sobre la línea base — se reporta para ver si diverge del retorno, como pasó antes.\x1b[0m`);
}

main();
