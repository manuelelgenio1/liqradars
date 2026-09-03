// ============================================================
// ¿REVIENTAN SIEMPRE LOS MISMOS?
//
// En un exchange centralizado esta pregunta no se puede hacer: las
// liquidaciones llegan anónimas. Hyperliquid es on-chain y cada una lleva el
// monedero, así que por una vez se puede mirar QUIÉN, no solo cuánto.
//
// POR QUÉ IMPORTA PARA UN RADAR DE LIQUIDEZ
// Si los cúmulos los alimenta una población recurrente —los mismos monederos
// una y otra vez— el mapa describe un comportamiento estable y tiene sentido
// mirarlo. Si cada cascada la protagoniza gente distinta, el mapa es una foto
// de un accidente irrepetible.
//
// LO QUE SE HIZO ANTES Y NO SE PUDO
// El plan original era medir la HABILIDAD de cada monedero: quién gana de
// verdad y si eso persiste. No cabe: BTC mueve entre 9.000 y 17.500
// operaciones por hora en Hyperliquid — unos 10 millones al mes — y la API
// entrega 1.000 por llamada. Un muestreo lo bastante fino sería ruido
// disfrazado de análisis, así que se cambió a la pregunta hermana, que sí se
// puede responder entera.
//
// EL DISEÑO QUE NO SE PUEDE AUTOENGAÑAR
// Se parte el mes en dos mitades. Los monederos "reincidentes" se eligen
// mirando SOLO la primera, y se comprueba si reaparecen en la segunda. Elegir
// y comprobar en el mismo periodo garantizaría un resultado bonito y falso.
// ============================================================
import { readFileSync } from "node:fs";

const DIR = "C:/Users/Manuel Quintero/.claude/projects/C--Users-Manuel-Quintero-Desktop-LIQRADARv4-liqradarv2-project-analysis-2a668--1-/e97df2ba-021e-4bdb-b256-2f43e419e807/tool-results";
const P = (f: string) => `${DIR}/mcp-ff8443a5-76d4-425f-b233-688b6a0f75e8-${f}.txt`;

const VENTANAS = [
  "get_liquidations-1788468857266",
  "get_liquidations-1788468886493",
  "get_liquidations-1788468892746",
  "get_liquidations-1788468898797",
  "get_liquidations-1788468904927",
  "get_liquidations-1788467679847",
];

/** Frontera entre las dos mitades. */
const CORTE = Date.parse("2026-08-20T00:00:00Z");

interface Liq {
  timestamp: string;
  liquidatedUser: string;
  price: string;
  size: string;
  closedPnl: string;
  direction: string;
}

// ---------- cargar y deduplicar ----------
// Las ventanas pedidas se solapan; sin deduplicar, una misma liquidación
// contaría varias veces e inflaría la reincidencia.
const vistos = new Set<string>();
const liqs: { ts: number; user: string; usd: number; pnl: number; dir: string }[] = [];

for (const f of VENTANAS) {
  let recs: Liq[];
  try { recs = JSON.parse(readFileSync(P(f), "utf8")).records; } catch { continue; }
  for (const r of recs) {
    const ts = Date.parse(r.timestamp);
    const clave = `${ts}|${r.liquidatedUser}|${r.size}|${r.price}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    liqs.push({
      ts,
      user: r.liquidatedUser,
      usd: Math.abs(Number(r.size) * Number(r.price)),
      pnl: Number(r.closedPnl) || 0,
      dir: r.direction,
    });
  }
}
liqs.sort((a, b) => a.ts - b.ts);

const A = liqs.filter((l) => l.ts < CORTE);
const B = liqs.filter((l) => l.ts >= CORTE);

const cuenta = (xs: typeof liqs) => {
  const m = new Map<string, { n: number; usd: number; pnl: number }>();
  for (const l of xs) {
    const v = m.get(l.user) ?? { n: 0, usd: 0, pnl: 0 };
    v.n += 1; v.usd += l.usd; v.pnl += l.pnl;
    m.set(l.user, v);
  }
  return m;
};

const mA = cuenta(A), mB = cuenta(B);

console.log(`\n\x1b[1m¿REVIENTAN SIEMPRE LOS MISMOS?\x1b[0m  Hyperliquid · BTC`);
console.log(`\n  ${liqs.length.toLocaleString()} liquidaciones únicas`);
const t = liqs.map((l) => l.ts);
console.log(`  ${new Date(t[0]).toISOString().slice(0, 16)} → ${new Date(t.at(-1)!).toISOString().slice(0, 16)}`);
console.log(`  mitad A: ${A.length.toLocaleString()} liquidaciones · ${mA.size.toLocaleString()} monederos`);
console.log(`  mitad B: ${B.length.toLocaleString()} liquidaciones · ${mB.size.toLocaleString()} monederos`);

// ---------- concentración dentro de A ----------
const porA = [...mA.values()].map((v) => v.n).sort((x, y) => y - x);
const totalA = porA.reduce((s, x) => s + x, 0);
const top1 = Math.max(1, Math.round(porA.length * 0.01));
const top10 = Math.max(1, Math.round(porA.length * 0.1));
console.log(`\n\x1b[1mCONCENTRACIÓN (mitad A)\x1b[0m`);
console.log(`  el 1 % de monederos concentra el ${((porA.slice(0, top1).reduce((s, x) => s + x, 0) / totalA) * 100).toFixed(1)} % de las liquidaciones`);
console.log(`  el 10 %                        ${((porA.slice(0, top10).reduce((s, x) => s + x, 0) / totalA) * 100).toFixed(1)} %`);
console.log(`  liquidado una sola vez:        ${((porA.filter((x) => x === 1).length / porA.length) * 100).toFixed(1)} % de los monederos`);
console.log(`  máximo en un solo monedero:    ${porA[0]} liquidaciones`);

// ---------- LA PRUEBA: ¿persisten? ----------
// Los reincidentes se eligen SOLO con A. Si reaparecer en B fuera azar, la
// tasa de reaparición sería la misma para reincidentes que para el resto.
const reincidentes = [...mA.entries()].filter(([, v]) => v.n >= 3).map(([u]) => u);
const unaVez = [...mA.entries()].filter(([, v]) => v.n === 1).map(([u]) => u);

const reaparece = (us: string[]) => us.filter((u) => mB.has(u)).length / us.length;

const rRein = reaparece(reincidentes);
const rUna = reaparece(unaVez);

console.log(`\n\x1b[1mPERSISTENCIA — elegidos en A, comprobados en B\x1b[0m`);
console.log(`  reincidentes en A (3+ veces): ${reincidentes.length.toLocaleString()} monederos`);
console.log(`    reaparecen en B: \x1b[1m${(rRein * 100).toFixed(1)} %\x1b[0m`);
console.log(`  liquidados 1 vez en A:        ${unaVez.length.toLocaleString()} monederos`);
console.log(`    reaparecen en B: ${(rUna * 100).toFixed(1)} %`);

// Diferencia de dos proporciones. Es UN contraste prefijado: listón 1,96.
const se = Math.sqrt(
  (rRein * (1 - rRein)) / reincidentes.length + (rUna * (1 - rUna)) / unaVez.length
);
const z = (rRein - rUna) / se;
console.log(`\n  diferencia: ${((rRein - rUna) * 100).toFixed(1)} puntos · ${z.toFixed(2)}σ`);
console.log(`  ${Math.abs(z) > 1.96
  ? `\x1b[32m✓ los reincidentes SÍ vuelven más que el resto\x1b[0m`
  : `\x1b[31m✗ no se distingue del azar\x1b[0m`}`);

// ---------- ¿y el dinero? ----------
const perdidoA = A.reduce((s, l) => s + Math.min(0, l.pnl), 0);
const nocionalA = A.reduce((s, l) => s + l.usd, 0);
console.log(`\n\x1b[1mEL DINERO\x1b[0m`);
console.log(`  nocional liquidado en A: $${(nocionalA / 1e6).toFixed(1)}M`);
console.log(`  pérdidas realizadas:     $${(Math.abs(perdidoA) / 1e6).toFixed(2)}M`);
const peores = [...mA.entries()].sort((a, b) => a[1].pnl - b[1].pnl).slice(0, 3);
console.log(`  los tres que más perdieron en A:`);
for (const [u, v] of peores) {
  const sigue = mB.has(u);
  console.log(`    ${u.slice(0, 10)}…  ${v.n} liq · $${(Math.abs(v.pnl) / 1000).toFixed(0)}k perdidos · ${sigue ? "\x1b[33msigue en B\x1b[0m" : "\x1b[2mno vuelve\x1b[0m"}`);
}
console.log("");
