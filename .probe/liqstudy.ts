// ============================================================
// ¿Predicen las liquidaciones? — con datos históricos de verdad.
//
// Durante días la respuesta fue "no se puede saber mirando atrás": ningún
// exchange centralizado publica histórico gratuito de liquidaciones. Por eso
// se montó un grabador que va hacia delante y lleva 15 sucesos de 30.
//
// Hyperliquid sí lo publica, y el archivo de 0xArchive da 30 días. Esto es el
// MISMO estudio que hace la app, pero con la muestra ya hecha.
//
// LO QUE ESTO ES Y LO QUE NO ES
//   · Es Hyperliquid, no Binance. Otro exchange, otra mecánica de margen.
//     Encontrar un efecto aquí NO lo demuestra en Binance. No encontrarlo sí
//     sería una señal fuerte, porque Hyperliquid es transparente: se ven las
//     posiciones reales, no una estimación.
//   · Las mismas reglas de honestidad que el resto del proyecto: dos
//     hipótesis opuestas contrastadas sobre los mismos datos, corrección de
//     Bonferroni, sucesos agrupados por independencia y coste descontado.
// ============================================================
import { readFileSync } from "node:fs";

const DIR = "C:/Users/Manuel Quintero/.claude/projects/C--Users-Manuel-Quintero-Desktop-LIQRADARv4-liqradarv2-project-analysis-2a668--1-/e97df2ba-021e-4bdb-b256-2f43e419e807/tool-results";

const FUENTES = [
  { coin: "BTC", liq: "get_liquidation_volume-1788467871657", vel: "get_candles-1788467860709" },
  { coin: "ETH", liq: "get_liquidation_volume-1788467877747", vel: "get_candles-1788467883879" },
  { coin: "SOL", liq: "get_liquidation_volume-1788467889992", vel: "get_candles-1788467896765" },
];

/** Nocional mínimo para llamarlo estallido. El mismo umbral que usa la app. */
const BURST_USD = 250_000;
/** Horas después de las que se lee el resultado. El mismo horizonte de la app. */
const HORIZON_H = 1;
/** Dos estallidos separados por menos de esto son el mismo suceso. */
const EVENTO_MS = 30 * 60_000;
/** Comisión de ida y vuelta, en % del nocional. */
const COSTE = 0.14;
/** Bonferroni para dos hipótesis opuestas. */
const LISTON = 2.24;

const leer = (f) => JSON.parse(readFileSync(`${DIR}/mcp-ff8443a5-76d4-425f-b233-688b6a0f75e8-${f}.txt`, "utf8")).records;

const media = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function tStat(a) {
  const n = a.length, m = media(a);
  const sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1));
  return { n, m, t: sd > 0 ? m / (sd / Math.sqrt(n)) : NaN };
}

// ---------- construir observaciones ----------

const obs = [];
let totalBuckets = 0, totalEstallidos = 0;

for (const src of FUENTES) {
  const liq = leer(src.liq);
  const vel = leer(src.vel).map((k) => ({ t: Date.parse(k.timestamp), c: Number(k.close) }))
    .sort((a, b) => a.t - b.t);
  totalBuckets += liq.length;

  // precio en un instante: cierre de la última vela horaria en o antes
  const precioEn = (ts) => {
    let lo = 0, hi = vel.length - 1, res = null;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (vel[m].t <= ts) { res = vel[m]; lo = m + 1; } else hi = m - 1;
    }
    return res && ts - res.t <= 2 * 3600_000 ? res.c : NaN;
  };

  // estallidos, con enfriamiento por moneda igual que en la app
  let ultimo = 0;
  for (const b of liq.map((x) => ({ ...x, ts: Date.parse(x.timestamp) })).sort((a, b) => a.ts - b.ts)) {
    const total = Number(b.totalUsd);
    if (!(total >= BURST_USD)) continue;
    totalEstallidos++;
    if (b.ts - ultimo < EVENTO_MS) continue;
    ultimo = b.ts;

    const p0 = precioEn(b.ts);
    const p1 = precioEn(b.ts + HORIZON_H * 3600_000);
    if (!(p0 > 0) || !(p1 > 0)) continue;

    const long = Number(b.longUsd), short = Number(b.shortUsd);
    obs.push({
      coin: src.coin,
      ts: b.ts,
      dominant: long >= short ? "long" : "short",
      purity: Math.max(long, short) / total,
      notional: total,
      fwdPct: ((p1 - p0) / p0) * 100, // retorno CRUDO, con su signo natural
    });
  }
}

// ---------- agrupar por suceso ----------
// Una cascada que barre el mercado toca BTC, ETH y SOL a la vez: son tres
// filas y UN suceso. Contarlas sueltas infla la significación.
const orden = [...obs].sort((a, b) => a.ts - b.ts);
const grupos = [];
for (const o of orden) {
  const g = grupos[grupos.length - 1];
  if (g && o.ts - g[0].ts <= EVENTO_MS) g.push(o);
  else grupos.push([o]);
}

// ---------- análisis ----------
console.log(`\n\x1b[1m¿PREDICEN LAS LIQUIDACIONES?\x1b[0m  Hyperliquid · 30 días · BTC, ETH, SOL`);
console.log(`umbral ${(BURST_USD / 1000).toFixed(0)}k$ · horizonte ${HORIZON_H} h · coste ${COSTE} % ida y vuelta\n`);
console.log(`  ${totalBuckets.toLocaleString()} intervalos de 5 min con liquidaciones`);
console.log(`  ${totalEstallidos.toLocaleString()} superan el umbral`);
console.log(`  ${obs.length} tras el enfriamiento por moneda`);
console.log(`  \x1b[1m${grupos.length} sucesos independientes\x1b[0m tras agrupar cascadas de mercado`);

if (grupos.length < 30) {
  console.log(`\n  \x1b[31mmuestra insuficiente\x1b[0m`);
  process.exit(0);
}

// Continuación: largos liquidados ⇒ venta forzada ⇒ se apuesta a la BAJA.
const porSuceso = grupos.map((g) => {
  const r = g.map((o) => (o.dominant === "long" ? -1 : 1) * o.fwdPct);
  return media(r);
});

const cont = tStat(porSuceso);
const agot = tStat(porSuceso.map((x) => -x));
const baseUp = obs.filter((o) => o.fwdPct > 0).length / obs.length;

const fila = (nombre, s) => {
  const neto = s.m - COSTE;
  const acierta = porSuceso.filter((x) => (nombre === "Continuación" ? x > 0 : -x > 0)).length / s.n;
  const ok = neto > 0 && s.t > LISTON;
  const c = (v) => (v > 0 ? "\x1b[32m+" : "\x1b[31m") + v.toFixed(4) + "%\x1b[0m";
  console.log(`\n  \x1b[1m${nombre}\x1b[0m`);
  console.log(`    bruto      ${c(s.m)}`);
  console.log(`    coste      \x1b[31m-${COSTE.toFixed(2)}%\x1b[0m`);
  console.log(`    \x1b[1mNETO       ${c(neto)}\x1b[0m`);
  console.log(`    acierta    ${(acierta * 100).toFixed(1)}%   línea base ${(baseUp * 100).toFixed(1)}%`);
  console.log(`    t          ${s.t.toFixed(2)}   ${ok ? "\x1b[32m✓ supera " + LISTON + "\x1b[0m" : "\x1b[31m✗ no llega a " + LISTON + "\x1b[0m"}`);
};

fila("Continuación", cont);
fila("Agotamiento", agot);

const mejor = cont.m - COSTE >= agot.m - COSTE ? { n: "Continuación", s: cont } : { n: "Agotamiento", s: agot };
const gana = mejor.s.m - COSTE > 0 && mejor.s.t > LISTON;
console.log(`\n  \x1b[1m${gana ? "\x1b[32mVENTAJA" : "\x1b[31mSIN VENTAJA"}\x1b[0m`);
console.log(`  ${gana
  ? `${mejor.n} deja ${(mejor.s.m - COSTE).toFixed(4)} % neto con t=${mejor.s.t.toFixed(2)} sobre ${mejor.s.n} sucesos.`
  : `La mejor (${mejor.n}) deja ${(mejor.s.m - COSTE).toFixed(4)} % neto con t=${mejor.s.t.toFixed(2)}: cabe dentro del azar.`}`);

// ---------- ¿y si solo los estallidos grandes? ----------
// Pregunta legítima y prefijada: quizá el efecto exista solo en las cascadas
// serias. Es UN contraste más, así que el listón sube un poco.
console.log(`\n\x1b[1m═══ SOLO LAS CASCADAS GRANDES ═══\x1b[0m`);
for (const min of [1e6, 5e6, 2e7]) {
  const g2 = grupos.filter((g) => g.reduce((s, o) => s + o.notional, 0) >= min);
  if (g2.length < 12) { console.log(`  >$${(min / 1e6).toFixed(0)}M   solo ${g2.length} sucesos, muestra corta`); continue; }
  const r = g2.map((g) => media(g.map((o) => (o.dominant === "long" ? -1 : 1) * o.fwdPct)));
  const a = tStat(r), b = tStat(r.map((x) => -x));
  const mejor2 = a.m >= b.m ? { n: "continuación", s: a } : { n: "agotamiento", s: b };
  const neto = mejor2.s.m - COSTE;
  const col = neto > 0 ? "\x1b[32m+" : "\x1b[31m";
  console.log(`  >$${String((min / 1e6).toFixed(0)).padStart(2)}M   ${String(g2.length).padStart(3)} sucesos · ` +
    `${mejor2.n.padEnd(13)} ${col}${neto.toFixed(4)}%\x1b[0m neto · t=${mejor2.s.t.toFixed(2)} ` +
    `${neto > 0 && mejor2.s.t > 2.4 ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"}`);
}
console.log(`\n\x1b[2m  Al mirar varios umbrales hay más contrastes, así que el listón sube a ~2,4.`);
console.log(`  Y el filtro se eligió DESPUÉS de ver los datos: aunque algo pasara, seria`);
console.log(`  una hipótesis para confirmar aparte, no un hallazgo.\x1b[0m\n`);
