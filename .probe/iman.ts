// ============================================================
// ¿ES EL PRECIO UN IMÁN HACIA LA LIQUIDEZ?
//
// Es LA tesis del proyecto. La app se llama LIQRADAR porque parte de que los
// cúmulos de liquidaciones atraen al precio: donde hay mucho apalancamiento
// que reventaría, el mercado tiende a ir a buscarlo.
//
// Nunca se pudo comprobar, porque los cúmulos que pinta la app son
// SINTÉTICOS: se estiman con una escalera de apalancamiento inventada. Aquí
// son reales — Hyperliquid publica las posiciones de su cámara de
// compensación, y 0xArchive las guarda cada ~45 min.
//
// EL CONTROL QUE HACE FALTA, y que ya nos mordió una vez.
//
// Los largos se liquidan por DEBAJO y los cortos por ENCIMA: es mecánico, no
// informativo. Si se compara "cúmulo más grande" contra "precio se mueve
// hacia él" sin más, gana siempre el que esté más cerca — geometría pura, no
// imán.
//
// Por eso se comparan BANDAS SIMÉTRICAS: el nocional corto entre +1 % y +5 %
// contra el nocional largo entre −1 % y −5 %. Misma distancia a cada lado, y
// lo único que varía es cuánto combustible hay.
//
//   desequilibrio = (cortos_arriba − largos_abajo) / (cortos + largos)
//
// La hipótesis del imán dice: desequilibrio positivo ⇒ el precio SUBE, porque
// arriba hay más que cazar. La contraria dice lo mismo al revés. Se contrastan
// las dos sobre los mismos datos, así que Bonferroni: listón 2,24.
// ============================================================
import { readFileSync } from "node:fs";

const DIR = "C:/Users/Manuel Quintero/.claude/projects/C--Users-Manuel-Quintero-Desktop-LIQRADARv4-liqradarv2-project-analysis-2a668--1-/e97df2ba-021e-4bdb-b256-2f43e419e807/tool-results";
const P = (f: string) => `${DIR}/mcp-ff8443a5-76d4-425f-b233-688b6a0f75e8-${f}.txt`;

const NIVELES = [
  "get_liquidation_levels_history-1788468329443",
  "get_liquidation_levels_history-1788468336717",
  "get_liquidation_levels_history-1788468343718",
  "get_liquidation_levels_history-1788468420680",
  "get_liquidation_levels_history-1788468428095",
  "get_liquidation_levels_history-1788468435711",
  "get_liquidation_levels_history-1788468442990",
];
const VELAS = "get_candles-1788467860709"; // BTC 1h, mismo mes

/** Banda de distancia. Fuera de ella no se cuenta nada. */
const BANDA_MIN = 0.01; // 1 %
const BANDA_MAX = 0.05; // 5 %
/** Horas después de las que se lee el resultado. */
const HORIZONTE_H = 4;
/** Dos snapshots más juntos que esto son el mismo estado del libro. */
const EVENTO_MS = 3 * 3600_000;
const COSTE = 0.14;
const LISTON = 2.24;

interface Nivel { price: number; long_notional: number; short_notional: number }
interface Snap { snapshot_ts: string; mid_price: number; levels: Nivel[] }

const media = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
function tStat(a: number[]) {
  const n = a.length, m = media(a);
  const sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1));
  return { n, m, t: sd > 0 ? m / (sd / Math.sqrt(n)) : NaN };
}

// ---------- velas ----------
const velas = (JSON.parse(readFileSync(P(VELAS), "utf8")).records as { timestamp: string; close: string }[])
  .map((k) => ({ t: Date.parse(k.timestamp), c: Number(k.close) }))
  .sort((a, b) => a.t - b.t);

function precioEn(ts: number): number {
  let lo = 0, hi = velas.length - 1, res: { t: number; c: number } | null = null;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (velas[m].t <= ts) { res = velas[m]; lo = m + 1; } else hi = m - 1;
  }
  return res && ts - res.t <= 2 * 3600_000 ? res.c : NaN;
}

// ---------- snapshots ----------
const snaps: Snap[] = [];
for (const f of NIVELES) {
  snaps.push(...(JSON.parse(readFileSync(P(f), "utf8")).records as Snap[]));
}
// Las ventanas pedidas se solapan a propósito para no dejar huecos: hay que
// quitar los snapshots repetidos o contarían dos veces.
const unicos = new Map<string, Snap>();
for (const s of snaps) unicos.set(s.snapshot_ts, s);
snaps.length = 0;
snaps.push(...[...unicos.values()].sort((a, b) => Date.parse(a.snapshot_ts + "Z") - Date.parse(b.snapshot_ts + "Z")));

interface Obs { ts: number; imb: number; fwdPct: number; total: number }
const obs: Obs[] = [];
let sinBanda = 0, sinPrecio = 0;

for (const s of snaps) {
  const ts = Date.parse(s.snapshot_ts + "Z");
  const mid = s.mid_price;
  if (!(mid > 0)) continue;

  // BANDAS SIMÉTRICAS: misma distancia arriba y abajo
  let cortosArriba = 0, largosAbajo = 0;
  for (const l of s.levels) {
    const d = (l.price - mid) / mid;
    if (d > 0 && d >= BANDA_MIN && d <= BANDA_MAX) cortosArriba += l.short_notional || 0;
    if (d < 0 && -d >= BANDA_MIN && -d <= BANDA_MAX) largosAbajo += l.long_notional || 0;
  }
  const total = cortosArriba + largosAbajo;
  if (!(total > 0)) { sinBanda++; continue; }

  const p0 = precioEn(ts);
  const p1 = precioEn(ts + HORIZONTE_H * 3600_000);
  if (!(p0 > 0) || !(p1 > 0)) { sinPrecio++; continue; }

  obs.push({
    ts,
    imb: (cortosArriba - largosAbajo) / total,
    fwdPct: ((p1 - p0) / p0) * 100,
    total,
  });
}

// ---------- sucesos independientes ----------
// Snapshots consecutivos comparten casi el mismo libro y horizontes que se
// solapan: no son datos nuevos.
const grupos: Obs[][] = [];
for (const o of obs) {
  const g = grupos[grupos.length - 1];
  if (g && o.ts - g[0].ts <= EVENTO_MS) g.push(o);
  else grupos.push([o]);
}

console.log(`\n\x1b[1m¿ES EL PRECIO UN IMÁN HACIA LA LIQUIDEZ?\x1b[0m`);
console.log(`Hyperliquid · BTC · posiciones reales de la cámara de compensación`);
console.log(`bandas simétricas ±${BANDA_MIN * 100}–${BANDA_MAX * 100} % · horizonte ${HORIZONTE_H} h · coste ${COSTE} %\n`);
console.log(`  ${snaps.length} snapshots · ${obs.length} con banda y precio · ${sinBanda} sin nada en banda · ${sinPrecio} sin precio`);
console.log(`  \x1b[1m${grupos.length} sucesos independientes\x1b[0m (snapshots a menos de ${EVENTO_MS / 3600_000} h son el mismo estado)`);

if (grupos.length < 30) { console.log("\n  \x1b[31mmuestra insuficiente\x1b[0m\n"); process.exit(0); }

// Solo se opera cuando el desequilibrio es claro: con el libro a la par no
// hay tesis que probar.
const UMBRAL_IMB = 0.2;
const usables = grupos
  .map((g) => ({ imb: media(g.map((o) => o.imb)), ret: media(g.map((o) => o.fwdPct)) }))
  .filter((x) => Math.abs(x.imb) >= UMBRAL_IMB);

console.log(`  ${usables.length} con desequilibrio claro (|imb| ≥ ${UMBRAL_IMB})\n`);

if (usables.length < 30) { console.log("  \x1b[31mmuestra insuficiente tras filtrar\x1b[0m\n"); process.exit(0); }

// Imán: más cortos arriba ⇒ el precio sube a cazarlos.
const iman = usables.map((x) => (x.imb > 0 ? 1 : -1) * x.ret);
const a = tStat(iman);
const b = tStat(iman.map((x) => -x));
const baseUp = usables.filter((x) => x.ret > 0).length / usables.length;

const fila = (nombre: string, s: ReturnType<typeof tStat>, dir: 1 | -1) => {
  const neto = s.m - COSTE;
  const aciertos = usables.filter((x) => dir * (x.imb > 0 ? 1 : -1) * x.ret > 0).length / usables.length;
  const c = (v: number) => (v > 0 ? "\x1b[32m+" : "\x1b[31m") + v.toFixed(4) + "%\x1b[0m";
  console.log(`  \x1b[1m${nombre}\x1b[0m`);
  console.log(`    bruto      ${c(s.m)}`);
  console.log(`    \x1b[1mNETO       ${c(neto)}\x1b[0m   (coste −${COSTE.toFixed(2)} %)`);
  console.log(`    acierta    ${(aciertos * 100).toFixed(1)}%   línea base ${(baseUp * 100).toFixed(1)}%`);
  console.log(`    t          ${s.t.toFixed(2)}   ${neto > 0 && s.t > LISTON ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗ no llega a " + LISTON + "\x1b[0m"}\n`);
};

fila("IMÁN · el precio va hacia la liquidez", a, 1);
fila("REPULSIÓN · el precio huye de ella", b, -1);

const mejor = a.m >= b.m ? { n: "Imán", s: a } : { n: "Repulsión", s: b };
const gana = mejor.s.m - COSTE > 0 && mejor.s.t > LISTON;
console.log(`  \x1b[1m${gana ? "\x1b[32mVENTAJA" : "\x1b[31mSIN VENTAJA"}\x1b[0m`);
console.log(`  ${gana
  ? `${mejor.n}: ${(mejor.s.m - COSTE).toFixed(4)} % neto, t=${mejor.s.t.toFixed(2)} sobre ${mejor.s.n} sucesos.`
  : `La mejor (${mejor.n}) deja ${(mejor.s.m - COSTE).toFixed(4)} % neto con t=${mejor.s.t.toFixed(2)}: cabe dentro del azar.`}\n`);

// ---------- ¿habríamos visto un efecto si existiera? ----------
//
// "No se detecta efecto" y "no hay efecto" son cosas distintas. Con muestra
// corta se puede no ver un elefante. Esto dice qué tamaño de efecto SÍ se
// habría detectado con los sucesos que hay — y por tanto si merece la pena
// pagar por más historia.
{
  const sd = Math.abs(a.m / (a.t / Math.sqrt(a.n)));
  const Z = LISTON + 0.84; // listón + 80 % de potencia
  console.log(`[1m═══ ¿HABRÍAMOS VISTO UN EFECTO? ═══[0m`);
  console.log(`  dispersión medida: ${sd.toFixed(3)} % por suceso
`);
  console.log(`  ${"efecto neto".padEnd(28)}${"sucesos".padStart(9)}   ¿lo teníamos?`);
  console.log(`  ${"─".repeat(56)}`);
  for (const [etiq, neto] of [
    ["+0,30 % (muy rentable)", 0.30],
    ["+0,20 % (rentable)", 0.20],
    ["+0,10 % (justo)", 0.10],
    ["+0,05 % (marginal)", 0.05],
  ] as [string, number][]) {
    const need = Math.ceil(((Z * sd) / (neto + COSTE)) ** 2);
    const teniamos = usables.length >= need;
    console.log(`  ${etiq.padEnd(28)}${String(need).padStart(9)}   ${teniamos ? "[32mSÍ, y no apareció[0m" : "[33mno, harían falta más[0m"}`);
  }
  console.log("");
}

// ---------- ¿y con desequilibrios extremos? ----------
console.log(`\x1b[1m═══ CUANDO EL DESEQUILIBRIO ES BRUTAL ═══\x1b[0m`);
for (const u of [0.4, 0.6, 0.8]) {
  const sub = grupos
    .map((g) => ({ imb: media(g.map((o) => o.imb)), ret: media(g.map((o) => o.fwdPct)) }))
    .filter((x) => Math.abs(x.imb) >= u);
  if (sub.length < 20) { console.log(`  |imb|≥${u}   solo ${sub.length} sucesos, muestra corta`); continue; }
  const r = sub.map((x) => (x.imb > 0 ? 1 : -1) * x.ret);
  const s = tStat(r);
  const neto = s.m - COSTE;
  const col = neto > 0 ? "\x1b[32m+" : "\x1b[31m";
  console.log(`  |imb|≥${u}   ${String(sub.length).padStart(3)} sucesos · imán ${col}${neto.toFixed(4)}%\x1b[0m neto · t=${s.t.toFixed(2)} ${neto > 0 && s.t > 2.5 ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"}`);
}
console.log(`\n\x1b[2m  Estos umbrales se eligieron DESPUÉS de ver los datos: aunque alguno saliera,`);
console.log(`  sería una hipótesis para confirmar aparte, no un hallazgo.\x1b[0m\n`);
