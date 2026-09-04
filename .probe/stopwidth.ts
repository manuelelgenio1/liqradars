/*
  ¿SE ARREGLA EL SCALPING DE 5 MINUTOS ENSANCHANDO EL STOP?

  LA HIPÓTESIS, fijada de antemano y con un mecanismo detrás, no a ojo. El
  registro en vivo dice que la mesa pierde 0,79R por señal en 5m y que la
  comisión se lleva 0,33R de cada una. Ese coste NO es fijo en R: es

      coste_en_R = coste_en_% × precio / distancia_al_stop

  o sea, inversamente proporcional a lo ancho que sea el stop. Con el stop a
  1,2 ATR de cinco minutos la comisión se come un tercio de R antes de empezar.
  A 4 ATR se comería la tercera parte de eso.

  LA PREGUNTA es si el bruto aguanta mientras el coste cae. No es evidente que
  sí: un stop más ancho salta menos veces, pero el objetivo también se aleja y
  más operaciones mueren de viejas a las 48 velas.

  CÓMO SE PROTEGE ESTO DE ENGAÑARSE A SÍ MISMO:

   1. PARTICIÓN. Se mide en el primer 65 % de la historia y se confirma en el
      35 % final, que no se mira hasta el último momento.
   2. BONFERRONI. Se prueban 5 anchuras, así que el listón sube de 1,96 a 2,58
      sigmas. Elegir la mejor de cinco y juzgarla con el listón de una es la
      forma más común de confundir ruido con hallazgo.
   3. SUCESOS, NO FILAS. Las cripto se mueven juntas: las señales nacidas en el
      mismo minuto en varios pares son UN suceso. La t se calcula sobre las
      medias por suceso.
   4. NETO SIEMPRE. La cifra que decide es la esperanza tras comisiones.

  SIN LOOK-AHEAD: el consenso de cada vela se calcula con los valores de los
  indicadores EN ESA VELA. Y para demostrarlo, la reconstrucción se contrasta
  contra la que hace la aplicación sobre el array completo: si no coinciden en
  la última vela, el script se planta y no reporta nada.
*/
import { computeAll, configFor, type Bundle, type IndicatorConfig } from "../src/lib/indicators";
import { MAX_BARS, ROUND_TRIP_COST_PCT } from "../src/lib/signals";
import { requiredSigma } from "../src/lib/indicatorScore";
import type { Candle } from "../src/lib/types";

const PARES = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "SUIUSDT", "LINKUSDT", "AVAXUSDT",
];
/*
  La temporalidad entra por argumento: `tsx .probe/stopwidth.ts 4h 240`.
  En 4H las 12.000 velas son unos cinco años y en diario más de treinta, así
  que el mismo estudio cubre historias muy distintas sin tocar nada más.
*/
const TF = process.argv[2] ?? "5m";
const TF_MIN = Number(process.argv[3] ?? 5);
const PAGINAS = 8; // 8 × 1500 velas = 12.000 velas por par

/** Las anchuras a probar, en ATR. La primera es la que usa la app hoy. */
const ANCHURAS = [1.2, 2, 3, 4, 6];
/** Se mantiene la proporción premio/riesgo de la app: 2,0 / 1,2. */
const RR = 2.0 / 1.2;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function klines(symbol: string): Promise<Candle[]> {
  const out: Candle[] = [];
  let end = Date.now();
  for (let p = 0; p < PAGINAS; p++) {
    const u = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${TF}&limit=1500&endTime=${end}`;
    const res = await fetch(u);
    if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
    const raw = (await res.json()) as unknown[][];
    if (!raw.length) break;
    const velas: Candle[] = raw.map((k) => ({
      t: Number(k[0]), o: +String(k[1]), h: +String(k[2]),
      l: +String(k[3]), c: +String(k[4]), v: +String(k[5]), delta: 0,
    }));
    out.unshift(...velas);
    end = velas[0].t - 1;
    await sleep(120);
  }
  return out;
}

// ---------- consenso en una vela concreta, sin mirar al futuro ----------

const finito = (x: number) => (Number.isFinite(x) ? x : 0);

function scoreEn(b: Bundle, i: number, cfg: IndicatorConfig, tfMinutes: number): number {
  const umbral = 0.0006 * Math.sqrt(tfMinutes / 5);
  const votos: { signo: number; peso: number; fuerza: number }[] = [];

  const rapida = finito(b.emaFast[i]);
  const lenta = finito(b.emaSlow[i]);
  const sep = lenta !== 0 ? (rapida - lenta) / lenta : 0;
  votos.push({
    signo: sep > umbral ? 1 : sep < -umbral ? -1 : 0,
    peso: 1,
    fuerza: Math.min(1, Math.abs(sep) / (umbral * 4)),
  });

  const hist = finito(b.macdHist[i]);
  const atrI = finito(b.atr[i]);
  votos.push({
    signo: hist > 0 ? 1 : hist < 0 ? -1 : 0,
    peso: 1,
    fuerza: Math.min(1, Math.abs(hist) / (atrI * 0.5 + 1e-9)),
  });

  const rv = finito(b.rsi[i]);
  votos.push({
    signo: rv > 55 ? 1 : rv < 45 ? -1 : 0,
    peso: 0.8,
    fuerza: Math.min(1, Math.abs(rv - 50) / 30),
  });

  const st = b.stConfirmed[i] ?? true;
  votos.push({ signo: st ? 1 : -1, peso: 1.25, fuerza: 1 });

  const adxI = finito(b.adx[i]);
  const fuerte = adxI >= cfg.adxThreshold;
  votos.push({
    signo: !fuerte ? 0 : finito(b.plusDI[i]) > finito(b.minusDI[i]) ? 1 : -1,
    peso: 1.4,
    fuerza: fuerte
      ? Math.min(1, adxI / 50)
      : Math.max(0, (cfg.adxThreshold - adxI) / cfg.adxThreshold),
  });

  let num = 0;
  let den = 0;
  for (const v of votos) {
    num += v.signo * v.peso * v.fuerza;
    den += v.peso;
  }
  const s = den ? num / den : 0;
  return Number.isFinite(s) ? s : 0;
}

const ladoDe = (score: number): "long" | "short" | null =>
  score > 0.12 ? "long" : score < -0.12 ? "short" : null;

// ---------- estadística ----------

const media = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

/** Señales nacidas en el mismo minuto son UN suceso, no N. */
function porSuceso(ops: { t: number; r: number }[]): number[] {
  const g = new Map<number, number[]>();
  for (const o of ops) {
    const k = Math.floor(o.t / 60_000);
    const prev = g.get(k);
    if (prev) prev.push(o.r);
    else g.set(k, [o.r]);
  }
  return [...g.values()].map(media);
}

function tDe(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = media(xs);
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
  return sd > 0 ? m / (sd / Math.sqrt(xs.length)) : NaN;
}

// ---------- replay ----------

interface Op { t: number; r: number; bruto: number; coste: number; salida: string }

function replay(velas: Candle[], b: Bundle, cfg: IndicatorConfig, desde: number, hasta: number, k: number): Op[] {
  const ops: Op[] = [];
  let ladoAnterior: "long" | "short" | null = null;
  let vivaHasta = -1;

  for (let i = desde; i < hasta; i++) {
    const lado = ladoDe(scoreEn(b, i, cfg, TF_MIN));
    const atrI = b.atr[i];
    if (!lado || !(atrI > 0)) { ladoAnterior = lado; continue; }

    // nace solo cuando CAMBIA de lado, o cuando la anterior ya terminó
    const relevo = lado !== ladoAnterior || i > vivaHasta;
    ladoAnterior = lado;
    if (!relevo) continue;

    const entrada = velas[i].c;
    const riesgo = atrI * k;
    const premio = riesgo * RR;
    if (!(riesgo > 0) || !(entrada > 0)) continue;
    const stop = lado === "long" ? entrada - riesgo : entrada + riesgo;
    const objetivo = lado === "long" ? entrada + premio : entrada - premio;
    const coste = (ROUND_TRIP_COST_PCT / 100) * entrada / riesgo;

    let bruto: number | null = null;
    let salida = "";
    let j = i + 1;
    for (; j < Math.min(velas.length, i + 1 + MAX_BARS); j++) {
      const c = velas[j];
      const tocaObj = lado === "long" ? c.h >= objetivo : c.l <= objetivo;
      const tocaStop = lado === "long" ? c.l <= stop : c.h >= stop;
      if (tocaObj && tocaStop) { bruto = -1; salida = "ambigua"; break; }  // conservador, igual que la app
      if (tocaObj) { bruto = RR; salida = "objetivo"; break; }
      if (tocaStop) { bruto = -1; salida = "stop"; break; }
    }
    if (bruto === null) {
      const fin = velas[Math.min(velas.length - 1, i + MAX_BARS)];
      if (!fin || j >= velas.length) continue;      // sin futuro suficiente: no se inventa
      const mov = lado === "long" ? fin.c - entrada : entrada - fin.c;
      bruto = mov / riesgo;
      salida = "tiempo";
    }
    vivaHasta = j;
    ops.push({ t: velas[i].t, r: bruto - coste, bruto, coste, salida });
  }
  return ops;
}

// ---------- principal ----------

async function main() {
  console.log(`Descargando ${TF} de ${PARES.length} pares…`);
  const datos: { sym: string; velas: Candle[]; b: Bundle }[] = [];
  const cfg = configFor(TF);

  for (const sym of PARES) {
    try {
      const velas = await klines(sym);
      if (velas.length < 2000) { console.log(`  ${sym}: solo ${velas.length} velas, fuera`); continue; }
      const b = computeAll(velas, cfg, TF_MIN);

      // COMPROBACIÓN ANTI-LOOK-AHEAD: la reconstrucción debe coincidir con la
      // que hace la app sobre el array completo. Si no, todo lo demás es basura.
      const mio = scoreEn(b, velas.length - 1, cfg, TF_MIN);
      const suyo = b.consensus.score;
      if (Math.abs(mio - suyo) > 1e-9) {
        throw new Error(`${sym}: la reconstrucción no cuadra (${mio} vs ${suyo}). Abortado.`);
      }
      datos.push({ sym, velas, b });
      console.log(`  ${sym}: ${velas.length} velas · reconstrucción verificada`);
    } catch (e) {
      console.log(`  ${sym}: ${(e as Error).message}`);
    }
  }
  if (!datos.length) { console.log("sin datos"); return; }

  const n = Math.min(...datos.map((d) => d.velas.length));
  const corte = Math.floor(n * 0.65);
  const calentar = 200; // que los indicadores estén formados
  console.log(`\nVelas por par: ${n} · busca [${calentar}..${corte}] · confirma [${corte}..${n}]`);
  console.log(`Listón con Bonferroni para ${ANCHURAS.length} anchuras: ${requiredSigma(ANCHURAS.length).toFixed(2)} sigmas\n`);

  const fmt = (x: number) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(3) : "  —  ");
  console.log("stop   tramo      ops  sucesos   bruto    coste     NETO      t");
  console.log("─".repeat(68));

  for (const k of ANCHURAS) {
    for (const [etiqueta, a, z] of [["busca", calentar, corte], ["CONFIRMA", corte, n]] as const) {
      const todas: Op[] = [];
      for (const d of datos) todas.push(...replay(d.velas, d.b, cfg, a, z, k));
      if (!todas.length) { console.log(`${k.toFixed(1)} ATR  ${etiqueta.padEnd(9)} sin operaciones`); continue; }
      const suc = porSuceso(todas.map((o) => ({ t: o.t, r: o.r })));
      console.log(
        `${k.toFixed(1)} ATR  ${etiqueta.padEnd(9)} ${String(todas.length).padStart(4)}  ${String(suc.length).padStart(6)}  ` +
        `${fmt(media(todas.map((o) => o.bruto)))}  ${fmt(-media(todas.map((o) => o.coste)))}  ` +
        `${fmt(media(todas.map((o) => o.r)))}  ${fmt(tDe(suc))}`
      );
    }
    console.log("─".repeat(68));
  }
  console.log(
    `\nUn NETO positivo solo cuenta si aguanta en CONFIRMA y su t supera ${requiredSigma(ANCHURAS.length).toFixed(2)}.`
  );
}

void main();
