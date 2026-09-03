// ============================================================
// Laboratorio de validación.
//
// Pregunta que responde: los niveles donde YA se liquidó a alguien, ¿vuelven a
// atraer al precio más que un nivel cualquiera a la misma distancia?
//
// Metodología, y el detalle que la hace o la rompe:
//
//   Un nivel cercano al precio se toca mucho más que uno lejano, por pura
//   geometría. Si el control se sortea uniformemente en toda la banda acaba
//   estando mucho más lejos que el nivel real medio, y la "ventaja" que sale
//   mide DISTANCIA, no señal. Por eso cada control se empareja en distancia
//   con su nivel (misma dirección, distancia perturbada ±33 %): lo único que
//   varía es QUÉ nivel se elige a esa distancia.
//
// Sin look-ahead: cada punto de prueba solo usa niveles con timestamp anterior
// a la vela evaluada.
// ============================================================
import type { Candle } from "./types";

export interface TestLevel {
  price: number;
  ts: number;
  usd: number;
}

export interface BacktestResult {
  tested: number;
  controls: number;
  hitRate: number;
  controlHitRate: number;
  edge: number;
  reversalRate: number;
  verdict: "SEÑAL" | "RUIDO" | "INDETERMINADO" | "DATOS INSUFICIENTES";
  note: string;
}

const MIN_DIST = 0.0015;
const MAX_DIST = 0.045;
const HORIZON = 20;
/** Tolerancia de toque, proporcional a la distancia y acotada. */
const touchTol = (dist: number) => Math.max(0.0004, Math.min(0.0012, dist * 0.25));
/** Umbral de reversión, en PORCENTAJE (no fracción). */
const reversalThr = (dist: number) => Math.max(0.08, Math.min(0.4, dist * 1.2));

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Índice de la primera vela en (from, from+HORIZON] que toca `level`. */
export function sweepIndex(candles: Candle[], from: number, level: number, dist: number): number {
  const tol = touchTol(dist);
  const end = Math.min(candles.length, from + 1 + HORIZON);
  for (let j = from + 1; j < end; j++) {
    const k = candles[j];
    if (Math.abs(k.c - level) / level <= tol || (k.l <= level && level <= k.h)) return j;
  }
  return -1;
}

export function runBacktest(
  candles: Candle[],
  levels: TestLevel[],
  opts: { seed?: number } = {}
): BacktestResult {
  const n = candles.length;
  const empty = (note: string): BacktestResult => ({
    tested: 0,
    controls: 0,
    hitRate: NaN,
    controlHitRate: NaN,
    edge: NaN,
    reversalRate: NaN,
    verdict: "DATOS INSUFICIENTES",
    note,
  });

  if (n < 60) return empty("Se necesitan al menos 60 velas para evaluar.");
  if (levels.length < 5) {
    return empty(
      `Solo ${levels.length} niveles reales registrados. El laboratorio necesita al menos 5: deja la app abierta para que se acumulen.`
    );
  }

  const rand = mulberry32(opts.seed ?? 1234);
  let hit = 0;
  let tested = 0;
  let reverted = 0;
  let ctrlHit = 0;
  let ctrlTested = 0;

  for (let i = 30; i < n - HORIZON; i += 3) {
    const price = candles[i].c;
    if (!(price > 0)) continue;

    // sin look-ahead: solo niveles ya conocidos en el instante de esta vela
    const known = levels.filter((l) => {
      if (l.ts > candles[i].t) return false;
      const d = Math.abs(l.price - price) / price;
      return d > MIN_DIST && d < MAX_DIST;
    });
    if (!known.length) continue;

    // el de mayor nocional, que es el que la interfaz destaca
    const lvl = known.reduce((m, l) => (l.usd > m.usd ? l : m), known[0]);
    const dist = Math.abs(lvl.price - price) / price;
    const above = lvl.price > price;

    tested += 1;
    const swept = sweepIndex(candles, i, lvl.price, dist);
    if (swept >= 0) {
      hit += 1;
      const after = candles[Math.min(n - 1, swept + 5)].c;
      const rel = ((after - lvl.price) / lvl.price) * 100;
      const thr = reversalThr(dist);
      // reversión = el precio se aleja del nivel por donde vino
      if (above ? rel < -thr : rel > thr) reverted += 1;
    }

    // control emparejado en distancia y dirección
    const ctrlDist = Math.max(MIN_DIST, Math.min(MAX_DIST, dist * (0.75 + rand() * 0.58)));
    const ctrlLevel = above ? price * (1 + ctrlDist) : price * (1 - ctrlDist);
    ctrlTested += 1;
    if (sweepIndex(candles, i, ctrlLevel, ctrlDist) >= 0) ctrlHit += 1;
  }

  if (tested < 15) {
    // se conservan los contadores reales: decir "5 pruebas" en el texto y
    // mostrar "0" en la casilla era contradictorio
    return {
      ...empty(
        `Muestra pequeña (${tested} pruebas): hacen falta más niveles o más historial para un veredicto fiable.`
      ),
      tested,
      controls: ctrlTested,
    };
  }

  const hitRate = hit / tested;
  const controlHitRate = ctrlTested ? ctrlHit / ctrlTested : NaN;
  const edge = hitRate - controlHitRate;
  const reversalRate = hit ? reverted / hit : NaN;

  let verdict: BacktestResult["verdict"];
  let note: string;
  if (edge >= 0.1) {
    verdict = "SEÑAL";
    note = `Los niveles con liquidaciones previas se tocan ${Math.round(edge * 100)} pts más que niveles al azar a la misma distancia.`;
  } else if (edge <= -0.05) {
    verdict = "RUIDO";
    note = "Los niveles con liquidaciones previas se tocan MENOS que niveles al azar equivalentes: aquí no hay ventaja.";
  } else {
    verdict = "INDETERMINADO";
    note = `Diferencia de ${(edge * 100).toFixed(0)} pts frente al control emparejado por distancia: sin ventaja medible.`;
  }

  return { tested, controls: ctrlTested, hitRate, controlHitRate, edge, reversalRate, verdict, note };
}
