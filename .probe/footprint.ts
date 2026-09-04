/*
  ¿PREDICE EL DESEQUILIBRIO AGRESOR? (el núcleo del footprint)

  QUÉ SE MIDE Y QUÉ NO. El footprint son dos cosas. El núcleo es el
  DESEQUILIBRIO AGRESOR: cuánto volumen cruzó el spread comprando frente a
  vendiendo. Eso lo trae cada vela de Binance en `takerBuyVolume`, así que se
  puede medir sobre años sin pagar nada. Lo que NO se mide aquí es el detalle
  por nivel de precio dentro de la vela —absorción, imbalances apilados—, que
  necesita `aggTrades`. Si el núcleo no predice, el detalle difícilmente lo
  salvará; y si predice, entonces sí valdrá la pena pagar por el detalle.

  POR QUÉ ESTA FAMILIA Y NO OTRA. Los cinco indicadores de la mesa son todos
  transformaciones de la misma serie de cierres, y murieron juntos. Esto es
  información distinta: quién cruzó el spread no está en el precio.

  LA HIPÓTESIS, FIJADA ANTES DE MIRAR: tras una vela con desequilibrio agresor
  EXTREMO, el precio continúa en esa dirección.

  EL ESTADÍSTICO ES SIMÉTRICO Y ESO IMPORTA. No se mide "cuánto sube tras
  compra agresiva" —eso lo contamina la deriva alcista de las cripto, que
  llevaría a declarar hallazgo donde solo hay mercado subiendo—. Se mide la
  DIFERENCIA entre lo que pasa tras compra extrema y lo que pasa tras venta
  extrema. La deriva se cancela sola.

  DEFENSAS, las mismas de siempre:
   · Partición 65/35: se mira en el primer tramo, se confirma en el último.
   · Bonferroni: 2 marcos × 3 horizontes = 6 pruebas ⇒ 2,64 sigmas, no 1,96.
   · Sucesos, no filas: lo que ocurre en el mismo minuto en varios pares es UN
     suceso. Las cripto se mueven juntas.
   · Neto: se descuenta la comisión de ida y vuelta, en las mismas unidades.

  UNIDADES: todo en ATR de la vela, para que BTC y DOGE se puedan sumar.
*/
import { atr as atrSerie } from "../src/lib/indicators";
import { ROUND_TRIP_COST_PCT } from "../src/lib/signals";
import { requiredSigma } from "../src/lib/indicatorScore";
import type { Candle } from "../src/lib/types";

const PARES = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "SUIUSDT", "LINKUSDT", "AVAXUSDT",
];

/** Marcos y horizontes fijados de antemano. 2 × 3 = 6 pruebas. */
const MARCOS: [string, number][] = [["5m", 5], ["4h", 240]];
const HORIZONTES = [1, 4, 12];

/** "Extremo" = el quintil superior del desequilibrio, fijado de antemano. */
const QUINTIL = 0.2;
const PAGINAS = 8;
const ATR_LEN = 14;

interface Vela extends Candle {
  /** volumen que cruzó el spread COMPRANDO */
  taker: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function klines(symbol: string, tf: string): Promise<Vela[]> {
  const out: Vela[] = [];
  let end = Date.now();
  for (let p = 0; p < PAGINAS; p++) {
    const u = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${tf}&limit=1500&endTime=${end}`;
    const res = await fetch(u);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = (await res.json()) as unknown[][];
    if (!raw.length) break;
    const velas: Vela[] = raw.map((k) => ({
      t: Number(k[0]), o: +String(k[1]), h: +String(k[2]), l: +String(k[3]),
      c: +String(k[4]), v: +String(k[5]), delta: 0,
      taker: +String(k[9]), // takerBuyBaseVolume: el agresor fue comprador
    }));
    out.unshift(...velas);
    end = velas[0].t - 1;
    await sleep(120);
  }
  return out;
}

/** Desequilibrio en [-1, 1]: +1 todo compra agresiva, −1 todo venta agresiva. */
const desequilibrio = (k: Vela): number =>
  k.v > 0 ? (2 * k.taker - k.v) / k.v : NaN;

const media = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

function cuantil(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))];
}

/** Lo que pasa en el mismo minuto en varios pares es UN suceso. */
function porSuceso(ev: { t: number; r: number }[]): number[] {
  const g = new Map<number, number[]>();
  for (const e of ev) {
    const k = Math.floor(e.t / 60_000);
    const prev = g.get(k);
    if (prev) prev.push(e.r);
    else g.set(k, [e.r]);
  }
  return [...g.values()].map(media);
}

function tDe(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = media(xs);
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
  return sd > 0 ? m / (sd / Math.sqrt(xs.length)) : NaN;
}

interface Ev { t: number; r: number; bruto: number; coste: number; lado: 1 | -1 }

function eventos(velas: Vela[], a: number[], desde: number, hasta: number, h: number, umbral: number): Ev[] {
  const out: Ev[] = [];
  for (let i = desde; i < Math.min(hasta, velas.length - h); i++) {
    const d = desequilibrio(velas[i]);
    const atrI = a[i];
    if (!Number.isFinite(d) || !(atrI > 0)) continue;
    if (Math.abs(d) < umbral) continue;

    const lado: 1 | -1 = d > 0 ? 1 : -1;
    const mov = (velas[i + h].c - velas[i].c) / atrI;      // en ATR, comparable entre pares
    const coste = (ROUND_TRIP_COST_PCT / 100) * velas[i].c / atrI;
    out.push({ t: velas[i].t, r: lado * mov - coste, bruto: lado * mov, coste, lado });
  }
  return out;
}

async function main() {
  const liston = requiredSigma(MARCOS.length * HORIZONTES.length);
  console.log(`Hipótesis fijada: tras desequilibrio agresor extremo, el precio CONTINÚA.`);
  console.log(`Estadístico simétrico (compra extrema − venta extrema): la deriva se cancela.`);
  console.log(`${MARCOS.length} marcos × ${HORIZONTES.length} horizontes = ${MARCOS.length * HORIZONTES.length} pruebas ⇒ listón ${liston.toFixed(2)} sigmas\n`);

  for (const [tf, tfMin] of MARCOS) {
    console.log(`══ ${tf} ${"═".repeat(58)}`);
    const datos: { sym: string; velas: Vela[]; a: number[] }[] = [];
    for (const sym of PARES) {
      try {
        const velas = await klines(sym, tf);
        if (velas.length < 2000) continue;
        if (!velas.some((k) => k.taker > 0)) { console.log(`  ${sym}: sin volumen agresor`); continue; }
        datos.push({ sym, velas, a: atrSerie(velas, ATR_LEN) });
      } catch (e) {
        console.log(`  ${sym}: ${(e as Error).message}`);
      }
    }
    if (!datos.length) { console.log("  sin datos\n"); continue; }

    const n = Math.min(...datos.map((d) => d.velas.length));
    const corte = Math.floor(n * 0.65);
    const calentar = ATR_LEN + 5;

    // El umbral de "extremo" se fija SOLO con el tramo de búsqueda.
    const muestra: number[] = [];
    for (const d of datos)
      for (let i = calentar; i < corte; i++) {
        const x = Math.abs(desequilibrio(d.velas[i]));
        if (Number.isFinite(x)) muestra.push(x);
      }
    const umbral = cuantil(muestra, 1 - QUINTIL);
    console.log(`  ${datos.length} pares · ${n} velas · umbral de "extremo" |d| ≥ ${umbral.toFixed(3)} (quintil superior del tramo de búsqueda)\n`);

    /*
      SE IMPRIME EL BRUTO Y EL COSTE POR SEPARADO. Con solo el neto no se
      puede distinguir "no predice nada" de "predice pero se lo come la
      comisión", y en 5m el coste vale casi un ATR entero: taparía cualquier
      señal y haría parecer que no hay ninguna.
    */
    console.log("  horiz  tramo      eventos  sucesos     bruto     coste      NETO       t");
    console.log("  " + "─".repeat(72));
    for (const h of HORIZONTES) {
      for (const [etq, a, z] of [["busca", calentar, corte], ["CONFIRMA", corte, n]] as const) {
        const ev: Ev[] = [];
        for (const d of datos) ev.push(...eventos(d.velas, d.a, a, z, h, umbral));
        if (ev.length < 30) { console.log(`  ${String(h).padStart(5)}  ${etq.padEnd(9)} muestra insuficiente`); continue; }
        const suc = porSuceso(ev);
        const m = media(suc);
        const t = tDe(suc);
        // La hipótesis era CONTINUACIÓN, así que solo cuenta un neto POSITIVO
        // que supere el listón. Marcar por valor absoluto señalaría también lo
        // contrario de lo que se predijo.
        const marca = etq === "CONFIRMA" && m > 0 && Number.isFinite(t) && t > liston ? "  ←" : "";
        const f = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(4);
        console.log(
          `  ${String(h).padStart(5)}  ${etq.padEnd(9)} ${String(ev.length).padStart(7)}  ${String(suc.length).padStart(7)}  ` +
          `${f(media(ev.map((e) => e.bruto)))}  ${f(-media(ev.map((e) => e.coste)))}  ${f(m)}  ` +
          `${(t >= 0 ? "+" : "") + t.toFixed(2)}${marca}`
        );
      }
      console.log("  " + "─".repeat(56));
    }
    console.log();
  }
  console.log(`Solo cuenta lo marcado con ← : neto positivo en CONFIRMA y |t| > ${liston.toFixed(2)}.`);
}

void main();
