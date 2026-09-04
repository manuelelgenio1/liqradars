/*
  RETORNOS REZAGADOS: el rasgo que la literatura señala como el más predictivo
  a cinco minutos.

  DE DÓNDE SALE, y no es una idea nuestra. Jaquart et al., "Short-term bitcoin
  market prediction via machine learning": con un conjunto de rasgos técnicos,
  de blockchain, de sentimiento y de activo, y probando redes recurrentes y
  gradient boosting, encuentran que EN EL HORIZONTE DE CINCO MINUTOS el rasgo
  más importante son los retornos del periodo de 10 a 5 minutos anteriores. No
  un indicador: el retorno crudo rezagado.

  Y un segundo estudio de momento en alta frecuencia reporta +9,62 % anual neto
  de un 0,5 % de coste de ida y vuelta en Ethereum.

  POR QUÉ ESTO NO ESTÁ YA MEDIDO. Todo lo que hemos probado usaba el CONSENSO
  de cinco indicadores, que son medias móviles y osciladores: series suavizadas.
  El retorno crudo de la vela anterior es información distinta — más ruidosa,
  pero sin el retraso que introduce cualquier media.

  QUÉ SE PRUEBA, fijado antes de mirar:
    · señal = signo del retorno rezagado, SOLO cuando su magnitud está en el
      quintil superior (así se replica la estrategia "por cuantiles" del
      estudio, que opera solo los extremos);
    · rezago 1 y 2 velas, horizonte 1 y 4 velas ⇒ 4 pruebas ⇒ listón 2,50.

  LA PRUEBA ES DE DOS COLAS A PROPÓSITO. No se predice si el efecto es de
  continuación o de reversión: el signo lo dice el dato. Un neto positivo
  significa que el momento funciona; uno negativo significativo, que funciona
  lo contrario. Fijar la dirección de antemano y luego cambiarla al ver el
  resultado sería hacer trampa; declarar las dos colas desde el principio, no.

  DEFENSAS: partición 65/35, sucesos en vez de filas, neto de comisiones.
*/
import { atr as atrSerie } from "../src/lib/indicators";
import { ROUND_TRIP_COST_PCT } from "../src/lib/signals";
import { requiredSigma } from "../src/lib/indicatorScore";
import type { Candle } from "../src/lib/types";

const PARES = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "SUIUSDT", "LINKUSDT", "AVAXUSDT",
];
const TF = "5m";
const REZAGOS = [1, 2];
const HORIZONTES = [1, 4];
const QUINTIL = 0.2;
const PAGINAS = 8;
const ATR_LEN = 14;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function klines(symbol: string): Promise<Candle[]> {
  const out: Candle[] = [];
  let end = Date.now();
  for (let p = 0; p < PAGINAS; p++) {
    const res = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${TF}&limit=1500&endTime=${end}`);
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

function cuantil(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))];
}

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

/** Retorno de la vela j, normalizado por ATR para poder sumar pares. */
const retorno = (v: Candle[], a: number[], j: number): number =>
  a[j] > 0 ? (v[j].c - v[j].o) / a[j] : NaN;

interface Ev { t: number; bruto: number; neto: number }

function eventos(v: Candle[], a: number[], desde: number, hasta: number, rez: number, h: number, umbral: number): Ev[] {
  const out: Ev[] = [];
  for (let i = desde; i < Math.min(hasta, v.length - h); i++) {
    const señal = retorno(v, a, i - rez + 1);      // retorno rezagado
    const atrI = a[i];
    if (!Number.isFinite(señal) || !(atrI > 0)) continue;
    if (Math.abs(señal) < umbral) continue;         // solo el quintil extremo

    const lado = señal > 0 ? 1 : -1;                // momento: seguir el signo
    const bruto = (lado * (v[i + h].c - v[i].c)) / atrI;
    const coste = (ROUND_TRIP_COST_PCT / 100) * v[i].c / atrI;
    out.push({ t: v[i].t, bruto, neto: bruto - coste });
  }
  return out;
}

async function main() {
  const liston = requiredSigma(REZAGOS.length * HORIZONTES.length);
  console.log("RETORNOS REZAGADOS a 5 minutos — el rasgo que la literatura señala como el más predictivo.");
  console.log(`4 pruebas ⇒ listón ${liston.toFixed(2)} sigmas · DOS COLAS: el signo lo dice el dato, no yo.`);
  console.log("Neto positivo ⇒ funciona el momento. Neto negativo significativo ⇒ funciona la reversión.\n");

  const datos: { velas: Candle[]; a: number[] }[] = [];
  for (const sym of PARES) {
    try {
      const velas = await klines(sym);
      if (velas.length < 2000) continue;
      datos.push({ velas, a: atrSerie(velas, ATR_LEN) });
    } catch (e) { console.log(`  ${sym}: ${(e as Error).message}`); }
  }
  if (!datos.length) { console.log("sin datos"); return; }
  const n = Math.min(...datos.map((d) => d.velas.length));
  const corte = Math.floor(n * 0.65);
  const calentar = ATR_LEN + 5;

  /*
    LA t VA SOBRE EL BRUTO, NO SOBRE EL NETO, y esto es una corrección de un
    error propio. La primera versión contrastaba el neto, que lleva un coste
    casi constante de −0,67 ATR: con eso la t sale enormemente negativa SIEMPRE,
    prediga la señal o no. No detectaba reversión, detectaba la comisión.

    La pregunta "¿predice?" se responde con el bruto. La pregunta "¿es
    operable?" se responde después, mirando si ese bruto cubre el coste.
  */
  console.log("  rez  horiz  tramo      eventos  sucesos    bruto   t(bruto)     NETO");
  console.log("  " + "─".repeat(68));
  for (const rez of REZAGOS) {
    // umbral del quintil, fijado SOLO con el tramo de búsqueda
    const muestra: number[] = [];
    for (const d of datos)
      for (let i = calentar; i < corte; i++) {
        const x = Math.abs(retorno(d.velas, d.a, i - rez + 1));
        if (Number.isFinite(x)) muestra.push(x);
      }
    const umbral = cuantil(muestra, 1 - QUINTIL);

    for (const h of HORIZONTES) {
      for (const [etq, a, z] of [["busca", calentar, corte], ["CONFIRMA", corte, n]] as const) {
        const ev: Ev[] = [];
        for (const d of datos) ev.push(...eventos(d.velas, d.a, a, z, rez, h, umbral));
        if (ev.length < 100) { console.log(`  ${rez}    ${String(h).padStart(5)}  ${etq.padEnd(9)} muestra insuficiente`); continue; }
        const sucB = porSuceso(ev.map((e) => ({ t: e.t, r: e.bruto })));
        const sucN = porSuceso(ev.map((e) => ({ t: e.t, r: e.neto })));
        const mB = media(sucB);
        const tB = tDe(sucB);
        const mN = media(sucN);
        const f = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(4);
        const predice = etq === "CONFIRMA" && Number.isFinite(tB) && Math.abs(tB) > liston;
        const marca = !predice ? "" : mB > 0 ? "  ← predice (momento)" : "  ← predice (reversión)";
        console.log(
          `  ${rez}    ${String(h).padStart(5)}  ${etq.padEnd(9)} ${String(ev.length).padStart(7)}  ${String(sucB.length).padStart(7)}  ` +
          `${f(mB)}  ${(tB >= 0 ? "+" : "") + tB.toFixed(2).padStart(6)}  ${f(mN)}${marca}`
        );
      }
      console.log("  " + "─".repeat(66));
    }
  }
  console.log(`\nSolo cuenta lo marcado: |t| > ${liston.toFixed(2)} en CONFIRMA.`);
  console.log("Ojo: si sale REVERSIÓN, el neto que se lee es el de la estrategia CONTRARIA,");
  console.log("y hay que restarle el coste otra vez — no es simétrico. Se mediría aparte.");
}

void main();
