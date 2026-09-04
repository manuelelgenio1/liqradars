/*
  HACER MERCADO DE VERDAD: los dos lados a la vez, y quedarse plano.

  POR QUÉ ES OTRO MODELO. Todo lo anterior medía "acertar la dirección". Esto
  no: aquí el beneficio viene del NÚMERO DE VUELTAS COMPLETAS. Si en una vela
  te ejecutan la compra Y la venta, te quedas plano habiendo cobrado el spread
  entero, y da igual hacia dónde fuera el precio. La pérdida viene de las velas
  en las que solo te ejecutan UN lado: ahí te quedas con inventario justo en la
  dirección equivocada. Eso es la selección adversa, y es la única enemiga.

  Con comisión maker del 0 % —los perpetuos USDC-M de Binance— la pregunta es
  limpia: ¿cobras más spread del que te cuesta el inventario?

  EL MODELO, por vela:
    · Se cotiza al ABRIR la vela: compra en apertura − s·ATR, venta en
      apertura + s·ATR. Se cotiza ANTES de ver la vela, así que no hay
      look-ahead.
    · Si el mínimo toca la compra Y el máximo toca la venta ⇒ vuelta completa:
      +2s, plano, sin comisión.
    · Si solo toca un lado ⇒ te quedas con inventario y se liquida AL CIERRE
      pagando comisión de salida a mercado.
    · Si no toca ninguno ⇒ no pasa nada.

  Todo en ATR para poder sumar pares distintos.

  LOS SESGOS, DECLARADOS ANTES DE MIRAR, y aquí son más serios que nunca:

   1. COLA DE ÓRDENES. Que el precio toque tu nivel no significa que te
      ejecuten: delante hay una fila. Un creador de mercado real solo se llena
      cuando el precio ATRAVIESA su nivel, no cuando lo roza. Esto INFLA las
      vueltas completas, que son la fuente de beneficio.

   2. UNA COTIZACIÓN POR VELA. Un creador real recotiza continuamente. Esto ni
      lo favorece ni lo perjudica de forma obvia, pero no es lo mismo.

   3. NO HAY LÍMITE DE INVENTARIO ni coste de financiación de la posición.

  Por los sesgos 1 y 3, un resultado NEGATIVO aquí es demoledor: significa que
  ni en el mundo favorable sale. Uno positivo habría que descontarlo mucho.
*/
import { atr as atrSerie } from "../src/lib/indicators";
import { requiredSigma } from "../src/lib/indicatorScore";
import type { Candle } from "../src/lib/types";

const PARES = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "SUIUSDT", "LINKUSDT", "AVAXUSDT",
];
const MARCOS = ["5m", "30m"];
/** Medio spread cotizado, en ATR. Cuatro valores ⇒ listón 2,50. */
const SPREADS = [0.1, 0.25, 0.5, 1.0];
const PAGINAS = 8;
const ATR_LEN = 14;
/** Liquidar inventario al cierre va a mercado: 0,04 % + 0,02 % deslizamiento. */
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

interface Barra { t: number; pnl: number; vuelta: boolean; unLado: boolean }

function simular(velas: Candle[], a: number[], desde: number, hasta: number, s: number): Barra[] {
  const out: Barra[] = [];
  for (let i = desde; i < Math.min(hasta, velas.length); i++) {
    const atrI = a[i - 1];              // ATR conocido ANTES de abrir la vela
    const k = velas[i];
    if (!(atrI > 0) || !(k.o > 0)) continue;
    const compra = k.o - s * atrI;
    const venta = k.o + s * atrI;
    const tocaC = k.l <= compra;
    const tocaV = k.h >= venta;
    const coste = (COSTE_SALIDA_PCT / 100) * k.o / atrI;

    if (tocaC && tocaV) {
      // vuelta completa: se cobra el spread entero y se queda plano
      out.push({ t: k.t, pnl: 2 * s, vuelta: true, unLado: false });
    } else if (tocaC) {
      // largo en `compra`, se liquida al cierre
      out.push({ t: k.t, pnl: (k.c - compra) / atrI - coste, vuelta: false, unLado: true });
    } else if (tocaV) {
      out.push({ t: k.t, pnl: (venta - k.c) / atrI - coste, vuelta: false, unLado: true });
    } else {
      out.push({ t: k.t, pnl: 0, vuelta: false, unLado: false });
    }
  }
  return out;
}

async function main() {
  const liston = requiredSigma(SPREADS.length);
  console.log("HACER MERCADO: los dos lados a la vez, comisión maker 0 %, inventario liquidado al cierre.");
  console.log(`${SPREADS.length} spreads cotizados ⇒ listón ${liston.toFixed(2)} sigmas`);
  console.log("SESGOS A FAVOR declarados: ignora la cola de órdenes y no limita inventario.");
  console.log("Un resultado negativo aquí es demoledor; uno positivo habría que descontarlo mucho.\n");

  for (const tf of MARCOS) {
    console.log(`══ ${tf} ${"═".repeat(64)}`);
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

    console.log("  spread  tramo      barras  sucesos  %vueltas  %1lado   PNL/barra       t");
    console.log("  " + "─".repeat(72));
    for (const s of SPREADS) {
      for (const [etq, a, z] of [["busca", ATR_LEN + 2, corte], ["CONFIRMA", corte, n]] as const) {
        const bs: Barra[] = [];
        for (const d of datos) bs.push(...simular(d.velas, d.a, a, z, s));
        if (bs.length < 100) { console.log(`  ${s.toFixed(2)}    ${etq.padEnd(9)} muestra insuficiente`); continue; }
        const suc = porSuceso(bs.map((b) => ({ t: b.t, r: b.pnl })));
        const m = media(suc);
        const t = tDe(suc);
        const pv = (100 * bs.filter((b) => b.vuelta).length) / bs.length;
        const pu = (100 * bs.filter((b) => b.unLado).length) / bs.length;
        const marca = etq === "CONFIRMA" && m > 0 && t > liston ? "  ←" : "";
        console.log(
          `  ${s.toFixed(2)}    ${etq.padEnd(9)} ${String(bs.length).padStart(6)}  ${String(suc.length).padStart(7)}  ` +
          `${pv.toFixed(1).padStart(7)}%  ${pu.toFixed(1).padStart(5)}%  ${(m >= 0 ? "+" : "") + m.toFixed(4)}  ${(t >= 0 ? "+" : "") + t.toFixed(2)}${marca}`
        );
      }
      console.log("  " + "─".repeat(72));
    }
    console.log();
  }
  console.log(`Solo cuenta lo marcado con ← : PNL por barra positivo en CONFIRMA con t > ${liston.toFixed(2)}.`);
}

void main();
