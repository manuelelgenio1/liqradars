/*
  ESTRUCTURA DE PRECIO: soportes y resistencias reales en vez del ATR.

  POR QUÉ ESTA Y NO OTRA. Es la última familia distinta que queda sin medir, y
  es la que usan los operadores discrecionales: no "1,2 veces la volatilidad"
  sino "el mínimo de ayer", "el techo del rango". Y ataca la columna que nunca
  se ha movido — el ACIERTO. Todo lo demás que probamos mejoraba el precio de
  entrada, el coste o la forma del pago; el acierto lleva veintiséis medidas
  clavado en el 35 %, que es lo que da una moneda.

  LA TRAMPA TÉCNICA, y es la que arruina la mayoría de los backtests de
  estructura: UN PIVOTE NO SE CONOCE CUANDO OCURRE. Un máximo local solo es
  máximo cuando han pasado K velas sin superarlo. Usarlo antes de eso es mirar
  al futuro, y da resultados preciosos y falsos. Aquí un pivote formado en la
  vela p SOLO se usa a partir de la vela p+K.

  DOS HIPÓTESIS OPUESTAS, las dos que se predican por igual:

    rebote   el precio llega a un soporte confirmado y REBOTA
             (comprar en el nivel, stop por debajo del nivel)
    rotura   el precio atraviesa una resistencia confirmada y SIGUE
             (comprar la rotura, stop de vuelta dentro)

  Que sean opuestas es lo que hace la prueba honesta: no se puede acertar por
  construcción. Si el rebote gana, la rotura pierde, y al revés.

  NIVELES ATADOS A LA ESTRUCTURA, no al ATR: el stop va al otro lado del nivel
  —que es lo que da sentido a operar estructura— más un margen de 0,3 ATR para
  no saltar por un roce. El objetivo mantiene la proporción 1,67 de la app para
  que la comparación con todo lo anterior sea limpia.

  4 pruebas (2 hipótesis × 2 marcos) ⇒ listón 2,50 sigmas. Coste 0,11 %.
*/
import { atr as atrSerie } from "../src/lib/indicators";
import { MAX_BARS } from "../src/lib/signals";
import { requiredSigma } from "../src/lib/indicatorScore";
import type { Candle } from "../src/lib/types";

const PARES = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "SUIUSDT", "LINKUSDT", "AVAXUSDT",
];
const MARCOS = ["5m", "30m"];
const PAGINAS = 20;
const ATR_LEN = 14;
const K = 5;                 // velas a cada lado para confirmar un pivote
const MARGEN_ATR = 0.3;      // cuánto más allá del nivel va el stop
const RR = 2.0 / 1.2;        // misma proporción que la app
const CERCA_ATR = 0.25;      // "el precio llega al nivel" = a esta distancia
const COSTE_PCT = 0.11;

type Hipotesis = "rebote" | "rotura";
const HIPOTESIS: Hipotesis[] = ["rebote", "rotura"];

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
    await sleep(90);
  }
  return out;
}

/**
 * Pivotes con su instante de CONFIRMACIÓN.
 *
 * `confirmadoEn[p]` es la vela a partir de la cual el pivote de la vela p puede
 * usarse sin mirar al futuro: p+K. Antes de eso nadie sabía que era un pivote.
 */
function pivotes(v: Candle[]): { techos: number[]; suelos: number[] } {
  const techos = new Array<number>(v.length).fill(NaN);
  const suelos = new Array<number>(v.length).fill(NaN);
  for (let p = K; p < v.length - K; p++) {
    let esTecho = true, esSuelo = true;
    for (let q = p - K; q <= p + K; q++) {
      if (q === p) continue;
      if (v[q].h >= v[p].h) esTecho = false;
      if (v[q].l <= v[p].l) esSuelo = false;
      if (!esTecho && !esSuelo) break;
    }
    if (esTecho) techos[p + K] = v[p].h;   // se guarda en el instante en que se CONFIRMA
    if (esSuelo) suelos[p + K] = v[p].l;
  }
  return { techos, suelos };
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

interface Op { t: number; r: number; gana: boolean }

function replay(v: Candle[], a: number[], piv: { techos: number[]; suelos: number[] }, desde: number, hasta: number, hip: Hipotesis): Op[] {
  const ops: Op[] = [];
  // niveles vigentes: el último techo y el último suelo confirmados
  let techo = NaN, suelo = NaN;
  let libreDesde = -1;

  for (let i = desde; i < hasta; i++) {
    if (Number.isFinite(piv.techos[i])) techo = piv.techos[i];
    if (Number.isFinite(piv.suelos[i])) suelo = piv.suelos[i];
    const atrI = a[i];
    if (!(atrI > 0) || i <= libreDesde) continue;

    const cerca = atrI * CERCA_ATR;
    let lado: 1 | -1 | 0 = 0;
    let nivel = NaN;

    if (hip === "rebote") {
      // llega al soporte por arriba ⇒ largo · llega a la resistencia por abajo ⇒ corto
      if (Number.isFinite(suelo) && v[i].l <= suelo + cerca && v[i].c > suelo) { lado = 1; nivel = suelo; }
      else if (Number.isFinite(techo) && v[i].h >= techo - cerca && v[i].c < techo) { lado = -1; nivel = techo; }
    } else {
      // cierra por encima de la resistencia ⇒ largo · por debajo del soporte ⇒ corto
      if (Number.isFinite(techo) && v[i].c > techo) { lado = 1; nivel = techo; }
      else if (Number.isFinite(suelo) && v[i].c < suelo) { lado = -1; nivel = suelo; }
    }
    if (!lado || !Number.isFinite(nivel)) continue;

    const entrada = v[i].c;
    if (!(entrada > 0)) continue;
    // EL STOP VA AL OTRO LADO DEL NIVEL, que es lo que da sentido a operar estructura
    const stop = lado === 1 ? nivel - atrI * MARGEN_ATR : nivel + atrI * MARGEN_ATR;
    const riesgo = Math.abs(entrada - stop);
    if (!(riesgo > atrI * 0.1)) continue;          // niveles pegados al precio: sin sentido
    const obj = lado === 1 ? entrada + riesgo * RR : entrada - riesgo * RR;
    const coste = (COSTE_PCT / 100) * entrada / riesgo;

    let bruto: number | null = null;
    let j = i + 1;
    for (; j < Math.min(v.length, i + 1 + MAX_BARS); j++) {
      const c = v[j];
      const tO = lado === 1 ? c.h >= obj : c.l <= obj;
      const tS = lado === 1 ? c.l <= stop : c.h >= stop;
      if (tO && tS) { bruto = -1; break; }
      if (tO) { bruto = RR; break; }
      if (tS) { bruto = -1; break; }
    }
    if (bruto === null) {
      if (j >= v.length) continue;
      const fin = v[Math.min(v.length - 1, i + MAX_BARS)];
      bruto = (lado === 1 ? fin.c - entrada : entrada - fin.c) / riesgo;
    }
    libreDesde = j;
    ops.push({ t: v[i].t, r: bruto - coste, gana: bruto > 0 });
  }
  return ops;
}

async function main() {
  const liston = requiredSigma(HIPOTESIS.length * MARCOS.length);
  console.log("ESTRUCTURA DE PRECIO · pivotes confirmados, stop al otro lado del nivel");
  console.log(`Pivote formado en la vela p, usable solo desde p+${K}: sin mirar al futuro.`);
  console.log(`4 pruebas ⇒ listón ${liston.toFixed(2)} sigmas · las dos hipótesis son OPUESTAS\n`);

  for (const tf of MARCOS) {
    console.log(`══ ${tf} ${"═".repeat(60)}`);
    const datos: { velas: Candle[]; a: number[]; piv: ReturnType<typeof pivotes> }[] = [];
    for (const sym of PARES) {
      try {
        const velas = await klines(sym, tf);
        if (velas.length < 5000) continue;
        datos.push({ velas, a: atrSerie(velas, ATR_LEN), piv: pivotes(velas) });
      } catch (e) { console.log(`  ${sym}: ${(e as Error).message}`); }
    }
    if (!datos.length) { console.log("  sin datos\n"); continue; }
    const n = Math.min(...datos.map((d) => d.velas.length));
    const corte = Math.floor(n * 0.65);
    console.log(`  ${datos.length} pares · ${n} velas cada uno\n`);
    console.log("  hipótesis  tramo         ops  sucesos  aciertos     NETO       t");
    console.log("  " + "─".repeat(64));
    for (const hip of HIPOTESIS) {
      for (const [etq, a, z] of [["busca", ATR_LEN + K + 5, corte], ["CONFIRMA", corte, n]] as const) {
        const ops: Op[] = [];
        for (const d of datos) ops.push(...replay(d.velas, d.a, d.piv, a, z, hip));
        if (ops.length < 200) { console.log(`  ${hip.padEnd(10)} ${etq.padEnd(9)} muestra insuficiente`); continue; }
        const suc = porSuceso(ops.map((o) => ({ t: o.t, r: o.r })));
        const m = media(suc), t = tDe(suc);
        const pct = (100 * ops.filter((o) => o.gana).length) / ops.length;
        const marca = etq === "CONFIRMA" && m > 0 && t > liston ? "  ← RENTABLE" : "";
        console.log(
          `  ${hip.padEnd(10)} ${etq.padEnd(9)} ${String(ops.length).padStart(7)}  ${String(suc.length).padStart(7)}  ` +
          `${pct.toFixed(1).padStart(6)} %  ${(m >= 0 ? "+" : "") + m.toFixed(4)}  ${(t >= 0 ? "+" : "") + t.toFixed(2)}${marca}`
        );
      }
      console.log("  " + "─".repeat(64));
    }
    console.log();
  }
}

void main();
