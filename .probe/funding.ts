/*
  ¿PREDICE EL FUNDING EXTREMO UN MOVIMIENTO CONTRA LA MULTITUD?

  EL MECANISMO. El funding es lo que los largos pagan a los cortos (o al revés)
  cada ocho horas para mantener el perpetuo pegado al contado. Un funding muy
  positivo significa que hay MUCHOS MÁS LARGOS y que están pagando por seguir
  ahí. Eso es posicionamiento amontonado: gente apalancada en el mismo lado,
  con stops en sitios parecidos, pagando por esperar. La idea a probar es que
  esa multitud es vulnerable y que el precio tiende a ir contra ella.

  ES OTRA FAMILIA DE DATOS. No es una transformación del precio —como los cinco
  indicadores de la mesa, que murieron juntos— ni flujo agresor —como el
  footprint, que también murió—. Es posicionamiento: quién está dentro y cuánto
  le cuesta seguir.

  HIPÓTESIS FIJADA ANTES DE MIRAR: con funding en el quintil extremo, ir CONTRA
  el lado amontonado (corto si el funding es muy positivo) da movimiento
  positivo.

  DEFENSAS:
   · Partición 65/35 en el tiempo.
   · Bonferroni: 2 marcos × 3 horizontes = 6 pruebas ⇒ 2,64 sigmas.
   · Sucesos: el funding se liquida a la misma hora en todos los pares, así que
     TODOS los eventos de un mismo instante son UN suceso. Sin esto la muestra
     parecería diez veces mayor de lo que es. Aquí importa más que nunca.
   · Neto de comisiones, en ATR, para poder sumar pares distintos.
   · Umbral de "extremo" fijado con el tramo de búsqueda, nunca con el de
     confirmación.
*/
import { atr as atrSerie } from "../src/lib/indicators";
import { ROUND_TRIP_COST_PCT } from "../src/lib/signals";
import { requiredSigma } from "../src/lib/indicatorScore";
import type { Candle } from "../src/lib/types";

const PARES = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "SUIUSDT", "LINKUSDT", "AVAXUSDT",
];
/** Marco, minutos por vela, y horizontes en VELAS (≈1 h, 4 h y 8 h). */
const MARCOS: [string, number, number[]][] = [
  ["5m", 5, [12, 48, 96]],
  ["30m", 30, [2, 8, 16]],
];
const QUINTIL = 0.2;
const PAGINAS = 8;
const ATR_LEN = 14;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function klines(symbol: string, tf: string): Promise<Candle[]> {
  const out: Candle[] = [];
  let end = Date.now();
  for (let p = 0; p < PAGINAS; p++) {
    const res = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${tf}&limit=1500&endTime=${end}`);
    if (!res.ok) throw new Error(`klines HTTP ${res.status}`);
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

async function funding(symbol: string, desde: number): Promise<{ t: number; r: number }[]> {
  const out: { t: number; r: number }[] = [];
  let start = desde;
  for (let p = 0; p < 12; p++) {
    const res = await fetch(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&startTime=${start}&limit=1000`);
    if (!res.ok) throw new Error(`funding HTTP ${res.status}`);
    const raw = (await res.json()) as { fundingTime: number; fundingRate: string }[];
    if (!raw.length) break;
    for (const f of raw) out.push({ t: Number(f.fundingTime), r: +f.fundingRate });
    if (raw.length < 1000) break;
    start = Number(raw[raw.length - 1].fundingTime) + 1;
    await sleep(120);
  }
  return out;
}

const media = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

function cuantil(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))];
}

/*
  EL FUNDING SE LIQUIDA A LA MISMA HORA EN TODOS LOS PARES, así que los diez
  eventos de un mismo instante son UN suceso. Sin agrupar, la muestra parecería
  diez veces mayor y la t saldría inflada por √10.
*/
function porSuceso(ev: { t: number; r: number }[]): number[] {
  const g = new Map<number, number[]>();
  for (const e of ev) {
    const k = Math.floor(e.t / 3_600_000); // misma hora = mismo suceso
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

/** Índice de la vela cuyo cierre es el primero posterior a `t`. */
function indiceEn(velas: Candle[], t: number): number {
  let lo = 0, hi = velas.length - 1, res = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (velas[m].t >= t) { res = m; hi = m - 1; } else lo = m + 1;
  }
  return res;
}

async function main() {
  const liston = requiredSigma(6);
  console.log("¿Va el precio CONTRA la multitud cuando el funding es extremo?");
  console.log("Hipótesis fijada: funding muy positivo ⇒ largos amontonados ⇒ ir corto.");
  console.log(`2 marcos × 3 horizontes = 6 pruebas ⇒ listón ${liston.toFixed(2)} sigmas`);
  console.log("Los diez pares comparten instante de funding: eso es UN suceso, no diez.\n");

  for (const [tf, , horizontes] of MARCOS) {
    console.log(`══ ${tf} ${"═".repeat(60)}`);
    const datos: { sym: string; velas: Candle[]; a: number[]; fnd: { t: number; r: number }[] }[] = [];
    for (const sym of PARES) {
      try {
        const velas = await klines(sym, tf);
        if (velas.length < 2000) continue;
        const fnd = await funding(sym, velas[0].t);
        if (fnd.length < 50) { console.log(`  ${sym}: solo ${fnd.length} funding`); continue; }
        datos.push({ sym, velas, a: atrSerie(velas, ATR_LEN), fnd });
      } catch (e) { console.log(`  ${sym}: ${(e as Error).message}`); }
    }
    if (!datos.length) { console.log("  sin datos\n"); continue; }

    const tMin = Math.max(...datos.map((d) => d.velas[0].t));
    const tMax = Math.min(...datos.map((d) => d.velas[d.velas.length - 1].t));
    const corte = tMin + (tMax - tMin) * 0.65;

    // umbral de "extremo" SOLO con el tramo de búsqueda
    const buscaAbs: number[] = [];
    for (const d of datos) for (const f of d.fnd) if (f.t >= tMin && f.t < corte) buscaAbs.push(Math.abs(f.r));
    const umbral = cuantil(buscaAbs, 1 - QUINTIL);
    console.log(`  ${datos.length} pares · umbral |funding| ≥ ${(umbral * 100).toFixed(4)} % por periodo\n`);

    console.log("  horiz  tramo      eventos  sucesos    bruto    coste     NETO       t");
    console.log("  " + "─".repeat(68));
    for (const h of horizontes) {
      for (const [etq, a, z] of [["busca", tMin, corte], ["CONFIRMA", corte, tMax]] as const) {
        const ev: { t: number; r: number; bruto: number; coste: number }[] = [];
        for (const d of datos) {
          for (const f of d.fnd) {
            if (f.t < a || f.t >= z) continue;
            if (Math.abs(f.r) < umbral) continue;
            const i = indiceEn(d.velas, f.t);
            if (i < ATR_LEN + 1 || i + h >= d.velas.length) continue;
            const atrI = d.a[i];
            const p = d.velas[i].c;
            if (!(atrI > 0) || !(p > 0)) continue;
            const lado = f.r > 0 ? -1 : 1;                     // CONTRA la multitud
            const bruto = (lado * (d.velas[i + h].c - p)) / atrI;
            const coste = (ROUND_TRIP_COST_PCT / 100) * p / atrI;
            ev.push({ t: f.t, r: bruto - coste, bruto, coste });
          }
        }
        if (ev.length < 30) { console.log(`  ${String(h).padStart(5)}  ${etq.padEnd(9)} muestra insuficiente`); continue; }
        const suc = porSuceso(ev);
        const t = tDe(suc);
        const m = media(suc);
        const f2 = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(3);
        const marca = etq === "CONFIRMA" && m > 0 && t > liston ? "  ←" : "";
        console.log(
          `  ${String(h).padStart(5)}  ${etq.padEnd(9)} ${String(ev.length).padStart(7)}  ${String(suc.length).padStart(7)}  ` +
          `${f2(media(ev.map((e) => e.bruto)))}  ${f2(-media(ev.map((e) => e.coste)))}  ${f2(m)}  ${(t >= 0 ? "+" : "") + t.toFixed(2)}${marca}`
        );
      }
      console.log("  " + "─".repeat(68));
    }
    console.log();
  }
  console.log(`Solo cuenta lo marcado con ← : neto positivo en CONFIRMA con t > ${liston.toFixed(2)}.`);
}

void main();
