/*
  ¿SUBE EL ACIERTO CUANDO LOS INDICADORES SE PONEN MÁS DE ACUERDO?

  LA PREGUNTA VIENE DE UNA SOSPECHA JUSTA. La app emite señal cuando el
  consenso supera 0,12 en una escala de −1 a 1. Ese 0,12 LO PUSE YO A OJO y
  nunca se comprobó. Si exigir más acuerdo mejorara el acierto, bastaría con
  subir el listón y callar el resto.

  EL NÚMERO CONTRA EL QUE SE COMPARA, calculado con el caso real del usuario:
  $100 apalancados 25×, entrada a mercado y salida con take-profit limitada.

      gana   +18,96 $   (objetivo a 2,0 ATR, comisión maker a la salida)
      pierde −14,92 $   (stop a 1,2 ATR, comisión taker a la salida)

      punto de equilibrio = 14,92 / (18,96 + 14,92) = 44,0 % de aciertos

  Y EL SUELO DEL AZAR con esos mismos niveles: como el objetivo está más lejos
  que el stop, un paseo aleatorio acierta stop/(stop+objetivo) = 1,2/3,2 =
  37,5 % de las veces. O sea que hay que superar al azar en 6,5 puntos.

  Se mide el acierto observado por tramo de acuerdo, y también la ambigua —la
  vela que contiene stop y objetivo— contada como PÉRDIDA, igual que en la app.

  DEFENSAS: partición 65/35 y los tramos fijados de antemano, no elegidos
  después de ver dónde sale bien.
*/
import { computeAll, configFor, type Bundle, type IndicatorConfig } from "../src/lib/indicators";
import { MAX_BARS } from "../src/lib/signals";
import type { Candle } from "../src/lib/types";

const PARES = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "SUIUSDT", "LINKUSDT", "AVAXUSDT",
];
const MARCOS: [string, number][] = [["5m", 5], ["30m", 30]];
const PAGINAS = 8;
const STOP_ATR = 1.2;    // los de la app
const TARGET_ATR = 2.0;

/** Tramos de acuerdo, fijados antes de mirar. 0,12 es el que usa la app hoy. */
const TRAMOS: [number, number][] = [[0.12, 0.2], [0.2, 0.3], [0.3, 0.45], [0.45, 0.65], [0.65, 1.01]];

const EQUILIBRIO = 44.0;
const AZAR = (100 * STOP_ATR) / (STOP_ATR + TARGET_ATR);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function klines(symbol: string, tf: string): Promise<Candle[]> {
  const out: Candle[] = [];
  let end = Date.now();
  for (let p = 0; p < PAGINAS; p++) {
    const res = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${tf}&limit=1500&endTime=${end}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = (await res.json()) as unknown[][];
    if (!raw.length) break;
    const v: Candle[] = raw.map((k) => ({
      t: Number(k[0]), o: +String(k[1]), h: +String(k[2]),
      l: +String(k[3]), c: +String(k[4]), v: +String(k[5]), delta: 0,
    }));
    out.unshift(...v);
    end = v[0].t - 1;
    await sleep(120);
  }
  return out;
}

const finito = (x: number) => (Number.isFinite(x) ? x : 0);

function scoreEn(b: Bundle, i: number, cfg: IndicatorConfig, tfMin: number): number {
  const umbral = 0.0006 * Math.sqrt(tfMin / 5);
  const v: { s: number; p: number; f: number }[] = [];
  const rap = finito(b.emaFast[i]);
  const len = finito(b.emaSlow[i]);
  const sep = len !== 0 ? (rap - len) / len : 0;
  v.push({ s: sep > umbral ? 1 : sep < -umbral ? -1 : 0, p: 1, f: Math.min(1, Math.abs(sep) / (umbral * 4)) });
  const hist = finito(b.macdHist[i]);
  const atrI = finito(b.atr[i]);
  v.push({ s: hist > 0 ? 1 : hist < 0 ? -1 : 0, p: 1, f: Math.min(1, Math.abs(hist) / (atrI * 0.5 + 1e-9)) });
  const rv = finito(b.rsi[i]);
  v.push({ s: rv > 55 ? 1 : rv < 45 ? -1 : 0, p: 0.8, f: Math.min(1, Math.abs(rv - 50) / 30) });
  v.push({ s: (b.stConfirmed[i] ?? true) ? 1 : -1, p: 1.25, f: 1 });
  const adxI = finito(b.adx[i]);
  const fuerte = adxI >= cfg.adxThreshold;
  v.push({
    s: !fuerte ? 0 : finito(b.plusDI[i]) > finito(b.minusDI[i]) ? 1 : -1,
    p: 1.4,
    f: fuerte ? Math.min(1, adxI / 50) : Math.max(0, (cfg.adxThreshold - adxI) / cfg.adxThreshold),
  });
  let num = 0, den = 0;
  for (const x of v) { num += x.s * x.p * x.f; den += x.p; }
  const s = den ? num / den : 0;
  return Number.isFinite(s) ? s : 0;
}

/*
  Se resuelven LAS DOS DIRECCIONES sobre la misma señal: la que dice el
  consenso y la contraria. Motivo: medimos reversión significativa a 5 minutos
  (t=−3,15) y la mesa sigue la tendencia, o sea que podría estar haciendo justo
  lo contrario de lo que conviene.

  OJO: el acierto de la contraria NO es 100 menos el de la directa. Los niveles
  son asimétricos —stop a 1,2 ATR y objetivo a 2,0— así que son dos sucesos
  distintos, no complementarios. Por eso se mide, en vez de restar.
*/
interface Op { fuerza: number; gana: boolean; ganaInv: boolean }

function replay(velas: Candle[], b: Bundle, cfg: IndicatorConfig, tfMin: number, desde: number, hasta: number): Op[] {
  const ops: Op[] = [];
  let anterior: 1 | -1 | 0 = 0;
  let vivaHasta = -1;
  for (let i = desde; i < hasta; i++) {
    const sc = scoreEn(b, i, cfg, tfMin);
    const lado: 1 | -1 | 0 = sc > 0.12 ? 1 : sc < -0.12 ? -1 : 0;
    const atrI = b.atr[i];
    if (!lado || !(atrI > 0)) { anterior = lado; continue; }
    const relevo = lado !== anterior || i > vivaHasta;
    anterior = lado;
    if (!relevo) continue;

    const entrada = velas[i].c;
    if (!(entrada > 0)) continue;

    const resolver = (dir: 1 | -1): { gana: boolean; hasta: number } | null => {
      const stop = dir === 1 ? entrada - atrI * STOP_ATR : entrada + atrI * STOP_ATR;
      const obj = dir === 1 ? entrada + atrI * TARGET_ATR : entrada - atrI * TARGET_ATR;
      let j2 = i + 1;
      for (; j2 < Math.min(velas.length, i + 1 + MAX_BARS); j2++) {
        const c = velas[j2];
        const tObj = dir === 1 ? c.h >= obj : c.l <= obj;
        const tStop = dir === 1 ? c.l <= stop : c.h >= stop;
        if (tObj && tStop) return { gana: false, hasta: j2 };  // ambigua = pérdida
        if (tObj) return { gana: true, hasta: j2 };
        if (tStop) return { gana: false, hasta: j2 };
      }
      if (j2 >= velas.length) return null;                     // sin futuro suficiente
      return { gana: false, hasta: j2 };                        // expira sin llegar
    };

    const dir = resolver(lado);
    const inv = resolver(lado === 1 ? -1 : 1);
    if (!dir || !inv) continue;
    vivaHasta = dir.hasta;
    ops.push({ fuerza: Math.abs(sc), gana: dir.gana, ganaInv: inv.gana });
  }
  return ops;
}

async function main() {
  console.log("¿SUBE EL ACIERTO CUANDO LOS INDICADORES SE PONEN MÁS DE ACUERDO?\n");
  console.log(`  Punto de equilibrio con $100 a 25× (salida TP limitada): ${EQUILIBRIO.toFixed(1)} % de aciertos`);
  console.log(`  Suelo del azar con stop 1,2 y objetivo 2,0 ATR:           ${AZAR.toFixed(1)} %`);
  console.log(`  Hay que superar al azar en ${(EQUILIBRIO - AZAR).toFixed(1)} puntos.\n`);

  for (const [tf, tfMin] of MARCOS) {
    console.log(`══ ${tf} ${"═".repeat(58)}`);
    const cfg = configFor(tf);
    const datos: { velas: Candle[]; b: Bundle }[] = [];
    for (const sym of PARES) {
      try {
        const velas = await klines(sym, tf);
        if (velas.length < 2000) continue;
        const b = computeAll(velas, cfg, tfMin);
        if (Math.abs(scoreEn(b, velas.length - 1, cfg, tfMin) - b.consensus.score) > 1e-9)
          throw new Error("la reconstrucción no cuadra");
        datos.push({ velas, b });
      } catch (e) { console.log(`  ${sym}: ${(e as Error).message}`); }
    }
    if (!datos.length) { console.log("  sin datos\n"); continue; }
    const n = Math.min(...datos.map((d) => d.velas.length));
    const corte = Math.floor(n * 0.65);

    for (const [etq, a, z] of [["busca", 200, corte], ["CONFIRMA", corte, n]] as const) {
      const ops: Op[] = [];
      for (const d of datos) ops.push(...replay(d.velas, d.b, cfg, tfMin, a, z));
      if (ops.length < 200) { console.log(`  ${etq}: muestra insuficiente\n`); continue; }
      console.log(`\n  ${etq} · ${ops.length} operaciones`);
      console.log("  acuerdo        ops   consenso   INVERSA   vs equilibrio (44,0 %)");
      console.log("  " + "─".repeat(64));
      for (const [lo, hi] of TRAMOS) {
        const t = ops.filter((o) => o.fuerza >= lo && o.fuerza < hi);
        if (t.length < 30) { console.log(`  ${lo.toFixed(2)}–${hi.toFixed(2)}   ${String(t.length).padStart(6)}   (pocas)`); continue; }
        const pct = (100 * t.filter((o) => o.gana).length) / t.length;
        const pctInv = (100 * t.filter((o) => o.ganaInv).length) / t.length;
        const mejor = Math.max(pct, pctInv);
        const vsEq = mejor - EQUILIBRIO;
        console.log(
          `  ${lo.toFixed(2)}–${hi.toFixed(2)}   ${String(t.length).padStart(6)}   ${pct.toFixed(1).padStart(6)} %  ${pctInv.toFixed(1).padStart(6)} %   ` +
          `${(vsEq >= 0 ? "+" : "") + vsEq.toFixed(1).padStart(5)}${vsEq > 0 ? "  ← RENTABLE" : ""}`
        );
      }
    }
    console.log();
  }
  console.log("Un tramo solo sirve si supera el equilibrio en CONFIRMA, no solo en busca.");
}

void main();
