/*
  COMBINAR SEÑALES DÉBILES: el único camino que queda con evidencia detrás.

  POR QUÉ ESTO Y NO OTRA COSA. Hemos medido señal real a cinco minutos —la
  reversión del retorno rezagado, t=−3,15— pero vale 0,05 ATR contra un coste
  de 0,67. Hace falta un factor de diez. El coste ya está agotado: la comisión
  maker al 0 % lo baja a la mitad como mucho. Así que el factor tiene que salir
  de la SEÑAL, y la única forma documentada de agrandarla es sumar varias
  débiles — que es lo que hacen los estudios con LASSO y gradient boosting
  sobre decenas de rasgos.

  QUÉ CAMBIA RESPECTO A LA MESA. La mesa combina cinco indicadores con pesos
  que puse YO a mano (1,4 al ADX, 1,25 al Supertrend...). Aquí los pesos los
  aprende una regresión sobre los datos de entrenamiento. Si los rasgos no
  aportan, el modelo lo dirá poniéndoles peso cero.

  POR QUÉ REGRESIÓN RIDGE Y NO ALGO MÁS POTENTE. Porque con pocas
  observaciones útiles y mucho ruido, un modelo flexible encuentra estructura
  donde no la hay. La propia literatura de microestructura concluye que "los
  mejores datos de entrada importan más que apilar otra capa oculta". Ridge
  además penaliza los pesos grandes, que es justo lo que hace falta cuando los
  rasgos están correlacionados entre sí.

  RASGOS, elegidos por lo que dice la literatura y por lo que hemos medido:
    r1,r2,r3   retornos rezagados — el rasgo más predictivo según Jaquart
    imb        desequilibrio agresor (takerBuy) — medido: predice poco pero algo
    volRel     ATR/precio — el régimen que abarata el coste
    rango      amplitud de la vela anterior en ATR
    vol        volumen relativo a su media
    sin/cos    hora del día — efectos de sesión
    btc1       retorno previo de BTC — arrastre entre pares, NUNCA medido

  HONESTIDAD DEL PROCEDIMIENTO:
   · Los pesos y la estandarización se calculan SOLO con el 65 % inicial.
   · El umbral de "predicción fuerte" también sale del tramo de entrenamiento.
   · Se reporta el R² dentro y fuera de muestra: si el de dentro es mucho mayor,
     es sobreajuste y hay que decirlo.
   · UNA sola hipótesis ⇒ listón 1,96.
*/
import { atr as atrSerie, rsi as rsiSerie } from "../src/lib/indicators";
import { ROUND_TRIP_COST_PCT } from "../src/lib/signals";
import type { Candle } from "../src/lib/types";

const PARES = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "SUIUSDT", "LINKUSDT", "AVAXUSDT",
];
const TF = "5m";
const PAGINAS = 8;
const ATR_LEN = 14;
const LAMBDA = 1.0;      // penalización ridge
const LISTON = 1.96;     // una sola hipótesis
const QUINTIL = 0.2;     // se opera el quintil más fuerte de la predicción

const NOMBRES = ["r1", "r2", "r3", "imb", "volRel", "rango", "vol", "sin", "cos", "btc1", "rsiDev"];

interface Vela extends Candle { taker: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function klines(symbol: string): Promise<Vela[]> {
  const out: Vela[] = [];
  let end = Date.now();
  for (let p = 0; p < PAGINAS; p++) {
    const res = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${TF}&limit=1500&endTime=${end}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = (await res.json()) as unknown[][];
    if (!raw.length) break;
    const v: Vela[] = raw.map((k) => ({
      t: Number(k[0]), o: +String(k[1]), h: +String(k[2]), l: +String(k[3]),
      c: +String(k[4]), v: +String(k[5]), delta: 0, taker: +String(k[9]),
    }));
    out.unshift(...v);
    end = v[0].t - 1;
    await sleep(120);
  }
  return out;
}

// ---------- álgebra mínima ----------

/** Resuelve (A + λI) w = b por Gauss-Jordan con pivoteo parcial. */
function resolver(A: number[][], b: number[], lambda: number): number[] {
  const n = b.length;
  const M = A.map((fila, i) => [...fila.map((x, j) => x + (i === j ? lambda : 0)), b[i]]);
  for (let col = 0; col < n; col++) {
    let mejor = col;
    for (let f = col + 1; f < n; f++) if (Math.abs(M[f][col]) > Math.abs(M[mejor][col])) mejor = f;
    [M[col], M[mejor]] = [M[mejor], M[col]];
    const piv = M[col][col];
    if (Math.abs(piv) < 1e-12) continue;
    for (let j = col; j <= n; j++) M[col][j] /= piv;
    for (let f = 0; f < n; f++) {
      if (f === col) continue;
      const fac = M[f][col];
      if (fac === 0) continue;
      for (let j = col; j <= n; j++) M[f][j] -= fac * M[col][j];
    }
  }
  return M.map((f) => f[n]);
}

const media = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

function tDe(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = media(xs);
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
  return sd > 0 ? m / (sd / Math.sqrt(xs.length)) : NaN;
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

function cuantil(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))];
}

// ---------- construcción de rasgos ----------

interface Fila { t: number; x: number[]; y: number; precio: number; atr: number }

function filas(v: Vela[], a: number[], rsi: number[], btcRet: Map<number, number>): Fila[] {
  const out: Fila[] = [];
  const volMedia: number[] = [];
  let acum = 0;
  for (let i = 0; i < v.length; i++) {
    acum += v[i].v;
    if (i >= 50) acum -= v[i - 50].v;
    volMedia[i] = i >= 50 ? acum / 50 : NaN;
  }
  const ret = (j: number) => (a[j] > 0 ? (v[j].c - v[j].o) / a[j] : NaN);

  for (let i = 55; i < v.length - 1; i++) {
    const atrI = a[i];
    if (!(atrI > 0) || !(v[i].c > 0) || !(volMedia[i] > 0)) continue;
    const imb = v[i].v > 0 ? (2 * v[i].taker - v[i].v) / v[i].v : NaN;
    const hora = new Date(v[i].t).getUTCHours() + new Date(v[i].t).getUTCMinutes() / 60;
    const x = [
      ret(i), ret(i - 1), ret(i - 2),
      imb,
      atrI / v[i].c,
      (v[i].h - v[i].l) / atrI,
      v[i].v / volMedia[i],
      Math.sin((2 * Math.PI * hora) / 24),
      Math.cos((2 * Math.PI * hora) / 24),
      btcRet.get(v[i].t) ?? 0,
      (rsi[i] - 50) / 50,
    ];
    if (x.some((z) => !Number.isFinite(z))) continue;
    // objetivo: retorno de la SIGUIENTE vela, en ATR
    out.push({ t: v[i].t, x, y: (v[i + 1].c - v[i].c) / atrI, precio: v[i].c, atr: atrI });
  }
  return out;
}

async function main() {
  console.log("MODELO LINEAL sobre los rasgos que la literatura señala. Ridge, pesos aprendidos.");
  console.log(`Una sola hipótesis ⇒ listón ${LISTON} sigmas. Entrenamiento 65 % / evaluación 35 %.\n`);

  // BTC primero: su retorno es rasgo de los demás (arrastre entre pares)
  const btc = await klines("BTCUSDT");
  const btcA = atrSerie(btc, ATR_LEN);
  const btcRet = new Map<number, number>();
  for (let i = 1; i < btc.length; i++) {
    if (btcA[i - 1] > 0) btcRet.set(btc[i].t, (btc[i - 1].c - btc[i - 1].o) / btcA[i - 1]);
  }
  console.log(`  BTCUSDT: ${btc.length} velas (referencia de arrastre)`);

  const todas: Fila[] = [];
  for (const sym of PARES) {
    try {
      const v = sym === "BTCUSDT" ? btc : await klines(sym);
      if (v.length < 2000) continue;
      const a = atrSerie(v, ATR_LEN);
      const r = rsiSerie(v.map((k) => k.c), 14);
      const f = filas(v, a, r, btcRet);
      todas.push(...f);
      console.log(`  ${sym}: ${f.length} filas`);
    } catch (e) { console.log(`  ${sym}: ${(e as Error).message}`); }
  }
  if (todas.length < 5000) { console.log("muestra insuficiente"); return; }

  todas.sort((p, q) => p.t - q.t);
  const corte = Math.floor(todas.length * 0.65);
  const tren = todas.slice(0, corte);
  const test = todas.slice(corte);
  const k = NOMBRES.length;

  // estandarización SOLO con entrenamiento
  const mu = Array.from({ length: k }, (_, j) => media(tren.map((f) => f.x[j])));
  const sg = Array.from({ length: k }, (_, j) => {
    const m = mu[j];
    const s = Math.sqrt(media(tren.map((f) => (f.x[j] - m) ** 2)));
    return s > 1e-12 ? s : 1;
  });
  const z = (f: Fila) => f.x.map((v2, j) => (v2 - mu[j]) / sg[j]);

  // ridge por ecuaciones normales
  const XtX = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const Xty = new Array<number>(k).fill(0);
  for (const f of tren) {
    const xs = z(f);
    for (let i = 0; i < k; i++) {
      Xty[i] += xs[i] * f.y;
      for (let j = 0; j < k; j++) XtX[i][j] += xs[i] * xs[j];
    }
  }
  const w = resolver(XtX, Xty, LAMBDA);

  console.log(`\n  ${tren.length} filas de entrenamiento · ${test.length} de evaluación`);
  console.log("\n  PESOS APRENDIDOS (estandarizados)");
  NOMBRES.map((n, i) => [n, w[i]] as const)
    .sort((p, q) => Math.abs(q[1]) - Math.abs(p[1]))
    .forEach(([n, peso]) => console.log(`    ${n.padEnd(8)} ${(peso >= 0 ? "+" : "") + peso.toFixed(5)}`));

  const r2 = (fs: Fila[]) => {
    const ys = fs.map((f) => f.y);
    const my = media(ys);
    let ss = 0, st = 0;
    for (const f of fs) {
      const p = z(f).reduce((s, v2, i) => s + v2 * w[i], 0);
      ss += (f.y - p) ** 2;
      st += (f.y - my) ** 2;
    }
    return 1 - ss / st;
  };
  console.log(`\n  R² dentro de muestra: ${(100 * r2(tren)).toFixed(3)} %`);
  console.log(`  R² FUERA de muestra:  ${(100 * r2(test)).toFixed(3)} %`);

  // operar el quintil más fuerte; el umbral sale del ENTRENAMIENTO
  const predTren = tren.map((f) => Math.abs(z(f).reduce((s, v2, i) => s + v2 * w[i], 0)));
  const umbral = cuantil(predTren, 1 - QUINTIL);

  const ev: { t: number; bruto: number; neto: number }[] = [];
  for (const f of test) {
    const p = z(f).reduce((s, v2, i) => s + v2 * w[i], 0);
    if (Math.abs(p) < umbral) continue;
    const lado = p > 0 ? 1 : -1;
    const bruto = lado * f.y;
    const coste = (ROUND_TRIP_COST_PCT / 100) * f.precio / f.atr;
    ev.push({ t: f.t, bruto, neto: bruto - coste });
  }
  if (ev.length < 100) { console.log("\n  sin operaciones suficientes"); return; }

  const sucB = porSuceso(ev.map((e) => ({ t: e.t, r: e.bruto })));
  const sucN = porSuceso(ev.map((e) => ({ t: e.t, r: e.neto })));
  const mB = media(sucB), tB = tDe(sucB);
  const mN = media(sucN);
  const costeMedio = media(ev.map((e) => e.bruto - e.neto));

  console.log(`\n  OPERANDO EL QUINTIL MÁS FUERTE, FUERA DE MUESTRA`);
  console.log(`    operaciones: ${ev.length} · sucesos independientes: ${sucB.length}`);
  console.log(`    BRUTO por operación: ${(mB >= 0 ? "+" : "") + mB.toFixed(4)} ATR   (t = ${tB.toFixed(2)})`);
  console.log(`    coste medio:         −${costeMedio.toFixed(4)} ATR`);
  console.log(`    NETO por operación:  ${(mN >= 0 ? "+" : "") + mN.toFixed(4)} ATR`);
  console.log(`\n  ¿predice?  ${Math.abs(tB) > LISTON ? "SÍ, |t| supera " + LISTON : "no, |t| no llega a " + LISTON}`);
  console.log(`  ¿es operable?  ${mN > 0 ? "SÍ" : "NO — el bruto es " + (costeMedio / Math.max(1e-9, Math.abs(mB))).toFixed(1) + "× menor que el coste"}`);
}

void main();
