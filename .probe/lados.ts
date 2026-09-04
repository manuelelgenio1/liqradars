/*
  LOS DOS AGUJEROS QUE QUEDAN EN 4H Y DIARIO.

  De dónde viene esto. `deriva.ts` contestó la pregunta correcta —¿la señal
  elige MEJORES momentos para estar largo que el azar?— y dio que sí en los
  largos: +0,065R con t=3,41 en 4H. Pero ese número tiene dos problemas que no
  son del mercado sino MÍOS, y hasta que no se tapen no se puede firmar nada.

  AGUJERO 1 · SE MIDIÓ SOBRE TODA LA HISTORIA, DE UNA. Las veintisiete familias
  anteriores se partieron 65/35: se busca en el primer tramo y se CONFIRMA en el
  segundo, que no se tocó al elegir. La celda de 4H largos —la única que ha
  cruzado el listón en todo el proyecto— nunca pasó por ahí. Un efecto que solo
  existe en la mitad donde lo buscaste no es un efecto.

  AGUJERO 2 · «LOS CORTOS DAN t=0,57» NO ES UNA CONCLUSIÓN. Son dos cosas muy
  distintas con el mismo aspecto:
      a) los cortos no tienen ventaja  → la asimetría es real, y una ventaja que
         solo existe en un lado no es habilidad direccional, es sesgo largo
      b) hay pocos cortos para verla   → no sabemos nada todavía
  Se separan con el EFECTO MÍNIMO DETECTABLE: listón × error típico. Si en los
  cortos el mínimo detectable es 0,03R, teníamos potencia de sobra para ver un
  +0,065R y no está: es (a). Si es 0,12R, jamás lo habríamos visto: es (b).

  Y LA PRUEBA QUE LO DECIDE: la DIFERENCIA entre los dos lados, con su propio
  error. Es la pregunta de verdad, y nunca se ha hecho. Si largos y cortos son
  estadísticamente distintos, la ventaja es de un solo lado y no es habilidad.
  Si no son distintos, las dos celdas son la misma cosa medida dos veces y lo
  que manda es la estimación conjunta.

  CAMBIO RESPECTO A `deriva.ts`, y es a peor para la hipótesis: allí la
  referencia incondicional se promediaba vela a vela y se trataba como fija.
  Aquí se agrupa por suceso igual que el grupo con señal, y su incertidumbre SÍ
  entra en la cuenta. Es lo correcto: las barras incondicionales se solapan
  entre ellas tanto como las otras.

  PREREGISTRO. Cuentan las celdas de CONFIRMA: 2 marcos × 2 lados = 4 pruebas,
  listón 2,50 sigmas. Se firma si y solo si CONFIRMA cruza el listón en los dos
  lados del mismo marco. El tramo `busca` se imprime para ver si el signo se
  mantiene; no vale como prueba.
*/
import { computeAll, configFor, type Bundle, type IndicatorConfig } from "../src/lib/indicators";
import { MAX_BARS } from "../src/lib/signals";
import { requiredSigma } from "../src/lib/indicatorScore";
import type { Candle } from "../src/lib/types";

const MARCOS: [string, number, number][] = [["4h", 240, 4 * 3600_000], ["1d", 1440, 24 * 3600_000]];
const STOP_ATR = 3;
const RR = 2.0 / 1.2;
const COSTE_PCT = 0.11;
const MAX_PARES = 25;
const PAGINAS = 12;
const CORTE = 0.65;
const LISTON = requiredSigma(4);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(u: string): Promise<unknown> {
  const res = await fetch(u);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function universo(): Promise<string[]> {
  const info = (await fetchJson("https://fapi.binance.com/fapi/v1/exchangeInfo")) as {
    symbols: { symbol: string; contractType: string; underlyingType: string; status: string }[];
  };
  const ok = new Set(
    info.symbols
      .filter((s) => s.contractType === "PERPETUAL" && s.underlyingType === "COIN" && s.status === "TRADING")
      .map((s) => s.symbol)
  );
  const tick = (await fetchJson("https://fapi.binance.com/fapi/v1/ticker/24hr")) as { symbol: string; quoteVolume: string }[];
  return tick
    .filter((t) => ok.has(t.symbol) && t.symbol.endsWith("USDT"))
    .sort((a, b) => +b.quoteVolume - +a.quoteVolume)
    .slice(0, MAX_PARES)
    .map((t) => t.symbol);
}

async function klines(symbol: string, tf: string): Promise<Candle[]> {
  const out: Candle[] = [];
  let end = Date.now();
  for (let p = 0; p < PAGINAS; p++) {
    const raw = (await fetchJson(
      `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${tf}&limit=1500&endTime=${end}`
    )) as unknown[][];
    if (!raw.length) break;
    const v: Candle[] = raw.map((k) => ({
      t: Number(k[0]), o: +String(k[1]), h: +String(k[2]), l: +String(k[3]),
      c: +String(k[4]), v: +String(k[5]), delta: 0,
    }));
    out.unshift(...v);
    if (raw.length < 1500) break;
    end = v[0].t - 1;
    await sleep(90);
  }
  return out;
}

const finito = (x: number) => (Number.isFinite(x) ? x : 0);

/** El consenso de la mesa en la vela i, reconstruido sin mirar al futuro. */
function scoreEn(b: Bundle, i: number, cfg: IndicatorConfig, tfMin: number): number {
  const umbral = 0.0006 * Math.sqrt(tfMin / 5);
  const v: { s: number; p: number; f: number }[] = [];
  const rap = finito(b.emaFast[i]), len = finito(b.emaSlow[i]);
  const sep = len !== 0 ? (rap - len) / len : 0;
  v.push({ s: sep > umbral ? 1 : sep < -umbral ? -1 : 0, p: 1, f: Math.min(1, Math.abs(sep) / (umbral * 4)) });
  const hist = finito(b.macdHist[i]), atrI = finito(b.atr[i]);
  v.push({ s: hist > 0 ? 1 : hist < 0 ? -1 : 0, p: 1, f: Math.min(1, Math.abs(hist) / (atrI * 0.5 + 1e-9)) });
  const rv = finito(b.rsi[i]);
  v.push({ s: rv > 55 ? 1 : rv < 45 ? -1 : 0, p: 0.8, f: Math.min(1, Math.abs(rv - 50) / 30) });
  v.push({ s: (b.stConfirmed[i] ?? true) ? 1 : -1, p: 1.25, f: 1 });
  const adxI = finito(b.adx[i]);
  const fu = adxI >= cfg.adxThreshold;
  v.push({
    s: !fu ? 0 : finito(b.plusDI[i]) > finito(b.minusDI[i]) ? 1 : -1,
    p: 1.4,
    f: fu ? Math.min(1, adxI / 50) : Math.max(0, (cfg.adxThreshold - adxI) / cfg.adxThreshold),
  });
  let num = 0, den = 0;
  for (const x of v) { num += x.s * x.p * x.f; den += x.p; }
  const s = den ? num / den : 0;
  return Number.isFinite(s) ? s : 0;
}

function resolver(v: Candle[], atrI: number, i: number, dir: 1 | -1): number | null {
  const entrada = v[i].c;
  if (!(entrada > 0) || !(atrI > 0)) return null;
  const riesgo = atrI * STOP_ATR;
  const premio = riesgo * RR;
  const stop = dir === 1 ? entrada - riesgo : entrada + riesgo;
  const obj = dir === 1 ? entrada + premio : entrada - premio;
  const coste = (COSTE_PCT / 100) * entrada / riesgo;
  for (let j = i + 1; j < Math.min(v.length, i + 1 + MAX_BARS); j++) {
    const c = v[j];
    const tO = dir === 1 ? c.h >= obj : c.l <= obj;
    const tS = dir === 1 ? c.l <= stop : c.h >= stop;
    if (tO && tS) return -1 - coste;
    if (tO) return RR - coste;
    if (tS) return -1 - coste;
  }
  const fin = v[i + MAX_BARS];
  if (!fin) return null;
  return (dir === 1 ? fin.c - entrada : entrada - fin.c) / riesgo - coste;
}

function salidaEn(v: Candle[], atrI: number, i: number, dir: 1 | -1): number {
  const entrada = v[i].c;
  const riesgo = atrI * STOP_ATR;
  const stop = dir === 1 ? entrada - riesgo : entrada + riesgo;
  const obj = dir === 1 ? entrada + riesgo * RR : entrada - riesgo * RR;
  for (let j = i + 1; j < Math.min(v.length, i + 1 + MAX_BARS); j++) {
    const c = v[j];
    if (dir === 1 ? c.h >= obj || c.l <= stop : c.l <= obj || c.h >= stop) return j - i;
  }
  return MAX_BARS;
}

const media = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

interface Ev { t: number; r: number }

/** Medias por suceso: dos operaciones nacidas en el mismo instante son UN dato. */
function porSuceso(ev: Ev[], cubo: number): number[] {
  const g = new Map<number, number[]>();
  for (const e of ev) {
    const k = Math.floor(e.t / cubo);
    const prev = g.get(k);
    if (prev) prev.push(e.r);
    else g.set(k, [e.r]);
  }
  return [...g.values()].map(media);
}

interface Resumen { m: number; se: number; n: number }

function resumir(xs: number[]): Resumen {
  const m = media(xs);
  if (xs.length < 2) return { m, se: NaN, n: xs.length };
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
  return { m, se: sd / Math.sqrt(xs.length), n: xs.length };
}

const sg = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(4);

async function main() {
  console.log("LOS DOS AGUJEROS DE 4H Y DIARIO · particion fuera de muestra + potencia por lado");
  console.log(`Cuentan las celdas de CONFIRMA: 4 pruebas ⇒ liston ${LISTON.toFixed(2)} sigmas.`);
  console.log("Se firma solo si CONFIRMA cruza el liston en LOS DOS lados del mismo marco.\n");

  const pares = await universo();

  for (const [tf, tfMin, cubo] of MARCOS) {
    console.log(`══ ${tf} ${"═".repeat(66)}`);
    const cfg = configFor(tf === "4h" ? "4H" : "1D");
    // [tramo][lado] · tramo 0 = busca, 1 = CONFIRMA · lado 0 = largos, 1 = cortos
    const cond: Ev[][][] = [[[], []], [[], []]];
    const todos: Ev[][][] = [[[], []], [[], []]];
    let usados = 0;

    for (const sym of pares) {
      try {
        const v = await klines(sym, tf);
        if (v.length < 400) continue;
        const b = computeAll(v, cfg, tfMin);
        const corte = Math.floor(v.length * CORTE);
        let anterior: 1 | -1 | 0 = 0;
        let libre = -1;
        for (let i = 200; i < v.length - MAX_BARS - 1; i++) {
          const atrI = b.atr[i];
          if (!(atrI > 0)) continue;
          const tramo = i < corte ? 0 : 1;
          const rl = resolver(v, atrI, i, 1);
          const rs = resolver(v, atrI, i, -1);
          if (rl !== null) todos[tramo][0].push({ t: v[i].t, r: rl });
          if (rs !== null) todos[tramo][1].push({ t: v[i].t, r: rs });
          const sc = scoreEn(b, i, cfg, tfMin);
          const lado: 1 | -1 | 0 = sc > 0.12 ? 1 : sc < -0.12 ? -1 : 0;
          if (!lado) { anterior = lado; continue; }
          const relevo = lado !== anterior || i > libre;
          anterior = lado;
          if (!relevo) continue;
          const r = lado === 1 ? rl : rs;
          if (r === null) continue;
          cond[tramo][lado === 1 ? 0 : 1].push({ t: v[i].t, r });
          // Sin solape: la siguiente no nace hasta que esta cierre.
          libre = i + salidaEn(v, atrI, i, lado);
        }
        usados++;
      } catch (e) { console.log(`  ${sym}: ${(e as Error).message}`); }
    }
    if (!usados) { console.log("  sin datos\n"); continue; }
    console.log(`  ${usados} pares · corte ${Math.round(CORTE * 100)}/${100 - Math.round(CORTE * 100)}\n`);

    console.log("  tramo     lado     sucesos   VENTAJA      t     IC 95 %                 min. detect.");
    console.log("  " + "─".repeat(80));
    const guarda: Record<string, Resumen> = {};
    for (const [tramo, etq] of [[0, "busca"], [1, "CONFIRMA"]] as const) {
      for (const [ld, nombre] of [[0, "LARGOS"], [1, "CORTOS"]] as const) {
        const c = porSuceso(cond[tramo][ld], cubo);
        const u = porSuceso(todos[tramo][ld], cubo);
        if (c.length < 50) { console.log(`  ${etq.padEnd(9)} ${nombre.padEnd(8)} muestra insuficiente`); continue; }
        const rc = resumir(c), ru = resumir(u);
        // La incertidumbre de la referencia SI entra: sus barras se solapan igual.
        const se = Math.sqrt(rc.se ** 2 + ru.se ** 2);
        const ventaja = rc.m - ru.m;
        const t = se > 0 ? ventaja / se : NaN;
        guarda[`${tramo}${ld}`] = { m: ventaja, se, n: rc.n };
        const marca = tramo === 1 && t > LISTON ? "  ←" : "";
        console.log(
          `  ${etq.padEnd(9)} ${nombre.padEnd(8)} ${String(rc.n).padStart(7)}   ${sg(ventaja)}  ` +
          `${(t >= 0 ? "+" : "") + t.toFixed(2)}   [${sg(ventaja - 1.96 * se)} , ${sg(ventaja + 1.96 * se)}]        ` +
          `${(LISTON * se).toFixed(4)}${marca}`
        );
      }
      console.log("  " + "─".repeat(80));
    }

    // La pregunta que decide si esto es habilidad o sesgo largo.
    for (const [tramo, etq] of [[0, "busca"], [1, "CONFIRMA"]] as const) {
      const L = guarda[`${tramo}0`], S = guarda[`${tramo}1`];
      if (!L || !S) continue;
      const d = L.m - S.m;
      const se = Math.sqrt(L.se ** 2 + S.se ** 2);
      const t = se > 0 ? d / se : NaN;
      const veredicto = Math.abs(t) > 1.96
        ? "los lados SON distintos ⇒ ventaja de un solo lado, no es habilidad direccional"
        : "no se distinguen ⇒ compatibles con un mismo efecto en los dos";
      console.log(`  ${etq}: largos − cortos = ${sg(d)} (t=${(t >= 0 ? "+" : "") + t.toFixed(2)}) · ${veredicto}`);
    }
    console.log();
  }
  console.log("El minimo detectable dice que ventaja habriamos visto de haber existido.");
  console.log("Si en los cortos es MENOR que la de los largos, la asimetria es real y no falta muestra.");
}

void main();
