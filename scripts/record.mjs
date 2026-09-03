#!/usr/bin/env node
// ============================================================
// Grabador de estallidos de liquidaciones, en servidor.
//
// POR QUÉ EXISTE
// El grabador del navegador solo funciona mientras hay una pestaña abierta, y
// eso introduce un sesgo grave: solo se anota lo que ocurre cuando alguien
// está mirando. Este corre solo, cada media hora, y no depende de nadie.
//
// POR QUÉ OKX Y NO BINANCE
// Es la única fuente gratuita que deja REBOBINAR liquidaciones: paginando se
// alcanzan unas 24 horas. Binance retiró el suyo (404) y también el archivo
// diario; Bybit no publica el suyo. Al haber ventana de rebobinado, un fallo
// del programador no cuesta datos: el siguiente disparo recupera lo perdido.
//
// POR QUÉ EL PRECIO SALE DE BINANCE
// El estallido se detecta en OKX, pero el precio de entrada y el de una hora
// después se leen de las velas de Binance, que es donde mira la app. Mezclar
// el precio de un exchange con las liquidaciones de otro es correcto aquí:
// se está midiendo si el suceso predice EL MERCADO, no ese libro concreto.
//
// GARANTÍAS
//  · Idempotente. Cada ejecución relee 24 h que ya vio; los estallidos se
//    identifican por (símbolo, minuto) y no se duplican.
//  · Nada se reescribe. Una observación cerrada no se vuelve a tocar, ni
//    siquiera si llega mejor información. Hay una comprobación explícita.
//  · El historial de git es la prueba: cada commit lleva fecha y no se puede
//    alterar el pasado sin que se note.
// ============================================================
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const ARCHIVO = "data/liqstudy.json";

/** Símbolos vigilados. Los mismos que ofrece la app. */
const SIMBOLOS = [
  { key: "BTCUSDT", okxFamily: "BTC-USDT", okxInst: "BTC-USDT-SWAP" },
  { key: "ETHUSDT", okxFamily: "ETH-USDT", okxInst: "ETH-USDT-SWAP" },
  { key: "SOLUSDT", okxFamily: "SOL-USDT", okxInst: "SOL-USDT-SWAP" },
  { key: "BNBUSDT", okxFamily: "BNB-USDT", okxInst: "BNB-USDT-SWAP" },
  { key: "XRPUSDT", okxFamily: "XRP-USDT", okxInst: "XRP-USDT-SWAP" },
  { key: "DOGEUSDT", okxFamily: "DOGE-USDT", okxInst: "DOGE-USDT-SWAP" },
];

// Estos números deben coincidir con src/lib/liqstudy.ts. Si divergen, los dos
// registros dejan de ser comparables.
const BURST_USD = 250_000;
const VENTANA_MS = 60_000;
const COOLDOWN_MS = 30 * 60_000;
const HORIZON_MS = 60 * 60_000;
const MAX_OBS = 5000;

/*
  LATIDO.

  Si solo se guardara cuando hay datos nuevos, un grabador muerto y un mercado
  tranquilo se verían EXACTAMENTE IGUAL desde fuera: el mismo archivo, la misma
  fecha. No se podría distinguir "no ha pasado nada" de "lleva días roto", que
  es la clase de fallo silencioso que esta herramienta existe para no cometer.

  Así que, aunque no haya nada nuevo, cada seis horas se guarda igual solo para
  dejar constancia de que sigue vivo. Son cuatro commits al día en el peor caso
  —nada— y a cambio la app puede decir con certeza cuándo se comprobó por
  última vez, que es distinto de cuándo entró el último dato.
*/
const LATIDO_MS = 6 * 60 * 60_000;

const OKX = "https://www.okx.com/api/v5";
const BINANCE = "https://fapi.binance.com/fapi/v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, intentos = 3) {
  for (let i = 0; i < intentos; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (r.ok) return await r.json();
      // 429 o 5xx: se espera y se reintenta
      if (r.status !== 429 && r.status < 500) return null;
    } catch {
      /* red inestable: se reintenta */
    }
    await sleep(1200 * (i + 1));
  }
  return null;
}

/** ctVal: el tamaño de un contrato. Para BTC-USDT-SWAP es 0,01 BTC; ignorarlo da un error de 100×. */
async function tamanosContrato() {
  const j = await getJson(`${OKX}/public/instruments?instType=SWAP`);
  const out = {};
  for (const d of j?.data ?? []) {
    const v = Number(d.ctVal);
    if (d.instId && Number.isFinite(v) && v > 0) out[d.instId] = v;
  }
  return out;
}

/*
  Liquidaciones de las últimas ~24 h de una familia de instrumentos.

  OKX entrega 100 por página y hay que paginar con `after` (registros MÁS
  ANTIGUOS que ese instante). Comprobado sobre BTC: una sola página da 100
  eventos y 9 h; paginando con `after` salen 1.266 eventos y 23,6 h. Sin esto
  se capturaría menos del 10 % de las liquidaciones y casi ningún estallido
  llegaría al umbral.

  Ojo: `before` NO sirve para esto — devuelve una y otra vez la misma página.
*/
const MAX_PAGINAS = 30;

async function liquidaciones(family) {
  const vistos = new Map();
  let cursor = "";

  for (let p = 0; p < MAX_PAGINAS; p++) {
    const j = await getJson(
      `${OKX}/public/liquidation-orders?instType=SWAP&instFamily=${family}&state=filled&limit=100` +
      (cursor ? `&after=${cursor}` : "")
    );
    const det = j?.data?.[0]?.details ?? [];
    if (!det.length) break;

    const antes = vistos.size;
    for (const d of det) {
      // una liquidación queda identificada por instante + tamaño + precio + lado
      vistos.set(`${d.ts}|${d.sz}|${d.bkPx}|${d.posSide}`, d);
    }
    if (vistos.size === antes) break; // la página no aportó nada: se acabó

    cursor = String(Math.min(...det.map((d) => Number(d.ts))));
    await sleep(120);
  }

  return [...vistos.values()]
    .map((d) => ({
      ts: Number(d.ts),
      px: Number(d.bkPx),
      sz: Number(d.sz),
      // posSide es el lado de la POSICIÓN liquidada, que es lo que interesa
      side: d.posSide === "long" ? "long" : "short",
    }))
    .filter((x) => Number.isFinite(x.ts) && x.px > 0 && x.sz > 0)
    .sort((a, b) => a.ts - b.ts);
}

async function velas(symbol, startTime, endTime) {
  const j = await getJson(
    `${BINANCE}/klines?symbol=${symbol}&interval=1m&limit=1500&startTime=${startTime}&endTime=${endTime}`
  );
  if (!Array.isArray(j)) return [];
  return j.map((k) => ({ t: Number(k[0]), c: Number(k[4]) }));
}

/** Precio de cierre del minuto que contiene `ts`, o el más cercano anterior. */
function precioEn(velas, ts) {
  let mejor = null;
  for (const k of velas) {
    if (k.t > ts) break;
    mejor = k;
  }
  return mejor && ts - mejor.t <= 5 * 60_000 ? mejor.c : NaN;
}

function cargar() {
  try {
    const j = JSON.parse(readFileSync(ARCHIVO, "utf8"));
    return {
      obs: Array.isArray(j.obs) ? j.obs : [],
      updatedAt: Number(j.updatedAt) || 0,
      lastDataAt: Number(j.lastDataAt) || 0,
      runs: Number(j.runs) || 0,
    };
  } catch {
    return { obs: [], updatedAt: 0, lastDataAt: 0, runs: 0 };
  }
}

function guardar(estado, huboDatos) {
  mkdirSync(dirname(ARCHIVO), { recursive: true });
  // orden estable: reduce el ruido del diff en git y hace el historial legible
  const obs = [...estado.obs].sort((a, b) => b.ts - a.ts).slice(0, MAX_OBS);
  writeFileSync(
    ARCHIVO,
    JSON.stringify(
      {
        schema: 1,
        source: "okx-liquidation-orders + binance-klines",
        burstUsd: BURST_USD,
        windowMs: VENTANA_MS,
        cooldownMs: COOLDOWN_MS,
        horizonMs: HORIZON_MS,
        // cuándo se comprobó por última vez (aunque no hubiera nada)
        updatedAt: Date.now(),
        // cuándo entró el último dato de verdad. Si se separan mucho, el
        // mercado está tranquilo; si updatedAt se congela, es que algo falla.
        lastDataAt: huboDatos ? Date.now() : estado.lastDataAt,
        runs: estado.runs + 1,
        obs,
      },
      null,
      1
    ) + "\n"
  );
}

async function main() {
  const estado = cargar();
  const previas = estado.obs.length;
  const ctVals = await tamanosContrato();

  // clave de identidad de un estallido: símbolo + minuto exacto
  const vistos = new Set(estado.obs.map((o) => `${o.symbol}|${o.ts}`));
  let nuevos = 0;
  let cerrados = 0;

  for (const s of SIMBOLOS) {
    const eventos = await liquidaciones(s.okxFamily);
    if (!eventos.length) {
      console.log(`  ${s.key.padEnd(9)} sin liquidaciones en la ventana`);
      continue;
    }
    const ctVal = ctVals[s.okxInst] ?? 1;

    // --- agrupar por minuto ---
    const cubos = new Map();
    for (const e of eventos) {
      const min = Math.floor(e.ts / VENTANA_MS) * VENTANA_MS;
      let c = cubos.get(min);
      if (!c) { c = { long: 0, short: 0 }; cubos.set(min, c); }
      c[e.side] += e.sz * ctVal * e.px; // contratos → moneda → USD
    }

    // --- estallidos, en orden cronológico y con enfriamiento ---
    const candidatos = [...cubos.entries()]
      .filter(([, c]) => c.long + c.short >= BURST_USD)
      .sort((a, b) => a[0] - b[0]);

    // El enfriamiento debe respetar también lo ya grabado en ejecuciones
    // anteriores, o cada disparo volvería a abrir la misma cascada.
    let ultimo = Math.max(
      0,
      ...estado.obs.filter((o) => o.symbol === s.key).map((o) => o.ts)
    );

    const aceptados = [];
    for (const [min, c] of candidatos) {
      if (min - ultimo < COOLDOWN_MS) continue;
      if (vistos.has(`${s.key}|${min}`)) { ultimo = min; continue; }
      aceptados.push([min, c]);
      ultimo = min;
    }

    // --- precio en el instante de cada estallido ---
    if (aceptados.length) {
      const desde = aceptados[0][0] - 5 * 60_000;
      const hasta = aceptados[aceptados.length - 1][0] + 5 * 60_000;
      const k = await velas(s.key, desde, hasta);
      for (const [min, c] of aceptados) {
        const price = precioEn(k, min);
        if (!(price > 0)) continue; // sin precio fiable no se anota nada
        const total = c.long + c.short;
        estado.obs.push({
          id: `srv-${min}-${s.key}`,
          ts: min,
          symbol: s.key,
          dominant: c.long >= c.short ? "long" : "short",
          notional: Math.round(total),
          purity: Number((Math.max(c.long, c.short) / total).toFixed(4)),
          price,
        });
        vistos.add(`${s.key}|${min}`);
        nuevos++;
      }
    }

    // --- cerrar las que ya vencieron ---
    const pendientes = estado.obs.filter(
      (o) => o.symbol === s.key && (o.fwdPct === undefined || o.fwdPct === null) && Date.now() >= o.ts + HORIZON_MS
    );
    if (pendientes.length) {
      const desde = Math.min(...pendientes.map((o) => o.ts)) + HORIZON_MS - 60_000;
      const hasta = Math.max(...pendientes.map((o) => o.ts)) + HORIZON_MS + 5 * 60_000;
      const k = await velas(s.key, desde, hasta);
      for (const o of pendientes) {
        // Una observación cerrada NUNCA se reescribe.
        if (o.fwdPct !== undefined && o.fwdPct !== null) continue;
        const objetivo = o.ts + HORIZON_MS;
        const vela = k.find((x) => x.t >= objetivo);
        if (!vela) continue;
        o.fwdPct = Number((((vela.c - o.price) / o.price) * 100).toFixed(4));
        o.resolvedTs = vela.t;
        cerrados++;
      }
    }

    const abiertas = estado.obs.filter((o) => o.symbol === s.key && (o.fwdPct === undefined || o.fwdPct === null)).length;
    console.log(
      `  ${s.key.padEnd(9)} ${String(eventos.length).padStart(4)} liq · ` +
      `${String(cubos.size).padStart(3)} min con actividad · ` +
      `${String(aceptados.length).padStart(2)} nuevos · ${abiertas} abiertas`
    );
    await sleep(250); // no castigar las APIs públicas
  }

  const huboDatos = nuevos + cerrados > 0;
  // Se guarda si hay datos nuevos o si toca dejar constancia de que sigue vivo.
  const tocaLatido = Date.now() - estado.updatedAt >= LATIDO_MS;
  guardar(estado, huboDatos);
  const cerradasAhora = estado.obs.filter((o) => o.fwdPct !== undefined && o.fwdPct !== null).length;
  console.log(
    `\n${previas} → ${estado.obs.length} observaciones ` +
    `(+${nuevos} nuevas, +${cerrados} cerradas) · ` +
    `${cerradasAhora} cerradas en total, ${estado.obs.length - cerradasAhora} esperando`
  );
  console.log(
    `ejecución nº ${estado.runs + 1} · ` +
    (huboDatos ? "se guarda" : tocaLatido ? "sin novedad, se guarda igual (latido)" : "sin novedad, no se guarda")
  );

  // Lo usa el flujo de trabajo para no hacer un commit vacío.
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(
      process.env.GITHUB_OUTPUT,
      `changed=${nuevos + cerrados > 0 ? "true" : "false"}\n` +
      `summary=+${nuevos} nuevas, +${cerrados} cerradas (${cerradasAhora} cerradas de ${estado.obs.length})\n`,
      { flag: "a" }
    );
  }
}

main().catch((e) => {
  console.error("fallo del grabador:", e);
  process.exit(1);
});
