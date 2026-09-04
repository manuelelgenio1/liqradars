/*
  ¿ES RENTABLE PONER EL SPREAD EN VEZ DE PAGARLO?

  POR QUÉ CAMBIA LA PREGUNTA. Todo lo medido hasta ahora asumía entrar y salir
  A MERCADO: 0,14 % de ida y vuelta, que en 5 m vale 0,76 ATR por operación.
  Con ese listón ninguna señal se acerca, y la literatura dice lo mismo — el
  componente predecible a corto plazo ronda 0,5 puntos básicos contra una
  comisión taker de 5 (arXiv 2607.09426), y sus autores lo posicionan como
  "input para ejecución y provisión de liquidez, no como estrategia autónoma".

  Si en vez de pagar el spread lo COBRAS, el listón deja de ser 5 pb y pasa a
  ser cero. Los perpetuos USDC-M de Binance están a 0,00 % maker.

  PERO LA COMISIÓN SE SUSTITUYE POR OTRO ENEMIGO: la SELECCIÓN ADVERSA. Te
  ejecutan justo cuando te equivocas, porque el que cruza contra ti suele saber
  algo. Eso no sale en ninguna tabla de comisiones y es la razón real por la
  que hacer de creador de mercado es difícil. Esto lo mide.

  CÓMO SE SIMULA UNA EJECUCIÓN PASIVA:
    · Al cierre de la vela i, con precio P, se pone compra limitada en P−k·ATR
      y venta limitada en P+k·ATR.
    · Si la vela i+1 toca ese nivel, se considera ejecutado AHÍ.
    · Se sale al cierre de la vela i+1+H, a mercado.

  DOS SESGOS QUE ESTA SIMULACIÓN TIENE A FAVOR, y hay que decirlos:
   1. Supone que si el precio toca tu nivel, te ejecutan. En la realidad hay
      COLA: si tu orden es la última de la fila y el precio solo roza el nivel,
      no te llenan. Esto sobreestima las ejecuciones buenas.
   2. Con velas no se sabe el orden dentro de la barra. Si se tocan los dos
      lados se cuentan las dos ejecuciones, que es el caso favorable.
  Por eso un resultado NEGATIVO aquí es concluyente y uno positivo pequeño no.

  ESTADÍSTICO SIMÉTRICO: se suman compras y ventas con el signo correcto, así
  la deriva alcista de las cripto se cancela y no se cuela como hallazgo.

  DEFENSAS: partición 65/35, sucesos en vez de filas, Bonferroni por las 6
  combinaciones de cada marco, y neto de comisión de salida.
*/
import { atr as atrSerie } from "../src/lib/indicators";
import { requiredSigma } from "../src/lib/indicatorScore";
import type { Candle } from "../src/lib/types";

const PARES = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "SUIUSDT", "LINKUSDT", "AVAXUSDT",
];
const MARCOS: [string, number][] = [["5m", 5], ["30m", 30]];
/** A qué distancia se pone la orden, en ATR. */
const DISTANCIAS = [0.25, 0.5, 1.0];
/** Cuántas velas se aguanta antes de salir a mercado. */
const HORIZONTES = [1, 4];
const PAGINAS = 8;
const ATR_LEN = 14;

/** Maker 0 % al entrar; salida a mercado 0,04 % + 0,02 % de deslizamiento. */
const COSTE_SALIDA_PCT = 0.06;

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

const media = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

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

interface Fill { t: number; bruto: number; neto: number }

function simular(velas: Candle[], a: number[], desde: number, hasta: number, k: number, h: number): Fill[] {
  const out: Fill[] = [];
  for (let i = desde; i < Math.min(hasta, velas.length - h - 1); i++) {
    const atrI = a[i];
    const p = velas[i].c;
    if (!(atrI > 0) || !(p > 0)) continue;
    const sig = velas[i + 1];
    const salida = velas[i + 1 + h].c;
    const coste = (COSTE_SALIDA_PCT / 100) * p / atrI;

    // COMPRA pasiva por debajo
    const compra = p - k * atrI;
    if (sig.l <= compra) {
      const bruto = (salida - compra) / atrI;
      out.push({ t: sig.t, bruto, neto: bruto - coste });
    }
    // VENTA pasiva por encima
    const venta = p + k * atrI;
    if (sig.h >= venta) {
      const bruto = (venta - salida) / atrI;
      out.push({ t: sig.t, bruto, neto: bruto - coste });
    }
  }
  return out;
}

async function main() {
  const liston = requiredSigma(DISTANCIAS.length * HORIZONTES.length);
  console.log("¿Es rentable PONER el spread en vez de pagarlo?");
  console.log("Entrada limitada (maker 0 %), salida a mercado (0,06 % con deslizamiento).");
  console.log(`${DISTANCIAS.length} distancias × ${HORIZONTES.length} horizontes = 6 pruebas por marco ⇒ listón ${liston.toFixed(2)} sigmas`);
  console.log("La simulación tiene DOS sesgos a favor (ignora la cola y el orden dentro de la vela):");
  console.log("un resultado negativo es concluyente; uno positivo pequeño, no.\n");

  for (const [tf] of MARCOS) {
    console.log(`══ ${tf} ${"═".repeat(62)}`);
    const datos: { velas: Candle[]; a: number[] }[] = [];
    for (const sym of PARES) {
      try {
        const velas = await klines(sym, tf);
        if (velas.length < 2000) continue;
        datos.push({ velas, a: atrSerie(velas, ATR_LEN) });
      } catch (e) { console.log(`  ${sym}: ${(e as Error).message}`); }
    }
    if (!datos.length) { console.log("  sin datos\n"); continue; }
    const n = Math.min(...datos.map((d) => d.velas.length));
    const corte = Math.floor(n * 0.65);

    console.log("  dist  horiz  tramo       fills  sucesos    bruto     NETO       t");
    console.log("  " + "─".repeat(66));
    for (const k of DISTANCIAS) {
      for (const h of HORIZONTES) {
        for (const [etq, a, z] of [["busca", ATR_LEN + 2, corte], ["CONFIRMA", corte, n]] as const) {
          const fills: Fill[] = [];
          for (const d of datos) fills.push(...simular(d.velas, d.a, a, z, k, h));
          if (fills.length < 50) { console.log(`  ${k.toFixed(2)}  ${String(h).padStart(5)}  ${etq.padEnd(9)} muestra insuficiente`); continue; }
          const suc = porSuceso(fills.map((f) => ({ t: f.t, r: f.neto })));
          const m = media(suc);
          const t = tDe(suc);
          const f = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(4);
          const marca = etq === "CONFIRMA" && m > 0 && t > liston ? "  ←" : "";
          console.log(
            `  ${k.toFixed(2)}  ${String(h).padStart(5)}  ${etq.padEnd(9)} ${String(fills.length).padStart(6)}  ${String(suc.length).padStart(7)}  ` +
            `${f(media(fills.map((x) => x.bruto)))}  ${f(m)}  ${(t >= 0 ? "+" : "") + t.toFixed(2)}${marca}`
          );
        }
      }
      console.log("  " + "─".repeat(66));
    }
    console.log();
  }
  console.log(`Solo cuenta lo marcado con ← : neto positivo en CONFIRMA con t > ${liston.toFixed(2)}.`);
}

void main();
