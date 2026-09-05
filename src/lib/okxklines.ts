/*
  ============================================================
  VELAS DE OKX CUANDO BINANCE NO DEJA.

  POR QUÉ HACE FALTA. Binance responde 451 —«no disponible por razones
  legales»— a las IP de los runners de GitHub. Desde un ordenador de casa
  responde 200; desde la nube de GitHub, no. Eso tumbó el grabador de señales
  en su primera ejecución, y lo peor: llevaba 37 horas tumbando también al
  grabador de liquidaciones, que se tragaba el fallo en un `catch` vacío y
  seguía informando en verde. Dos observaciones suyas llevaban día y medio sin
  resolverse con un horizonte de una hora.

  EL MULTIPLICADOR, QUE ES LA PARTE QUE PUEDE ROMPERLO TODO EN SILENCIO.

  Binance cotiza las monedas baratas multiplicadas: `1000PEPEUSDT` vale mil
  veces lo que un PEPE. OKX lista el par sin multiplicar, `PEPE-USDT-SWAP`.

  Mezclar las dos escalas en un mismo registro no daría un error, daría
  NÚMEROS. Una señal nacida con precios de Binance y resuelta con precios de
  OKX vería el precio dividirse por mil de golpe: stop alcanzado al instante,
  pérdida completa, apunte perfectamente formateado y perfectamente falso. Y no
  saltaría ninguna alarma, porque un precio de 0,0079 es tan válido como uno de
  7,9.

  Por eso el multiplicador se lee del propio símbolo y se aplica a los cuatro
  precios. Después de eso, una vela de OKX y una de Binance son intercambiables
  y el registro puede mezclarlas sin enterarse.

  QUÉ NO ARREGLA. El volumen no se convierte —OKX lo da en contratos y Binance
  en moneda base— así que queda a cero y se marca como tal. Ninguno de los
  indicadores de la mesa lo usa; si algún día uno lo usara, esto habría que
  mirarlo antes.
  ============================================================
*/
import type { Candle } from "./types";

/** Las temporalidades de la mesa, en la notación de OKX. */
export const OKX_BAR: Record<string, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1H": "1H",
  "4H": "4H",
  // Sin el sufijo `utc`, OKX alinea el día y la semana a Hong Kong. Binance
  // los alinea a UTC. Sin esto, las velas diarias empezarían ocho horas
  // desplazadas y no serían comparables con nada de lo medido hasta ahora.
  "1D": "1Dutc",
  "1W": "1Wutc",
};

export interface OkxPar {
  instId: string;
  /** cuánto vale un contrato de Binance en unidades de OKX */
  mult: number;
}

/**
 * Traduce un símbolo de Binance al de OKX, con su multiplicador.
 *
 * `BTCUSDT` → `BTC-USDT-SWAP` ×1 · `1000PEPEUSDT` → `PEPE-USDT-SWAP` ×1000
 *
 * Devuelve null si no acaba en USDT: el resto no se opera en esta mesa y
 * adivinar la equivalencia sería peor que no tenerla.
 */
export function okxPar(binanceSymbol: string): OkxPar | null {
  const s = binanceSymbol.toUpperCase().trim();
  if (!s.endsWith("USDT") || s.length <= 4) return null;
  let base = s.slice(0, -4);
  // Prefijo numérico: 1000PEPE, 1000000MOG. Es el multiplicador, literalmente.
  const m = /^(\d+)(.+)$/.exec(base);
  let mult = 1;
  if (m) {
    const n = Number(m[1]);
    // Solo potencias de diez son multiplicadores de verdad. Un par que
    // empezara por dígitos por otro motivo no debe colarse por aquí.
    if (Number.isFinite(n) && n >= 10 && /^10*$/.test(m[1])) {
      mult = n;
      base = m[2];
    }
  }
  if (!base) return null;
  return { instId: `${base}-USDT-SWAP`, mult };
}

/**
 * Convierte la respuesta de OKX en velas comparables con las de Binance.
 *
 * OKX entrega `[ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]`, de la más
 * NUEVA a la más vieja, y `confirm` vale "0" mientras la vela sigue abierta.
 * Aquí se descartan las abiertas, se aplica el multiplicador y se devuelve en
 * orden ascendente, que es como las espera el resto del código.
 */
export function parseOkxCandles(raw: unknown, mult: number): Candle[] {
  if (!Array.isArray(raw)) return [];
  const out: Candle[] = [];
  for (const fila of raw) {
    if (!Array.isArray(fila) || fila.length < 5) continue;
    // Solo velas CERRADAS: una en curso haría que el mismo instante diera
    // resultados distintos según cuándo se mire.
    if (fila.length > 8 && String(fila[8]) !== "1") continue;
    const t = Number(fila[0]);
    const o = Number(fila[1]) * mult;
    const h = Number(fila[2]) * mult;
    const l = Number(fila[3]) * mult;
    const c = Number(fila[4]) * mult;
    if (!Number.isFinite(t) || !(o > 0) || !(h > 0) || !(l > 0) || !(c > 0)) continue;
    // El volumen de OKX viene en contratos, no en moneda base: no es
    // convertible sin el tamaño de contrato, así que se deja a cero en vez de
    // poner un número que parecería comparable y no lo sería.
    out.push({ t, o, h, l, c, v: 0, delta: 0 });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** La dirección de la que se piden las velas. */
export function okxCandlesUrl(instId: string, bar: string, limit = 300): string {
  return `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`;
}
