// ============================================================
// Los 20 perpetuos con más volumen, elegidos por el mercado y no por mí.
//
// Una lista escrita a mano envejece mal: hace seis meses habrías puesto pares
// que hoy no mueven nada, y te faltarían los que ahora concentran el flujo.
// Esto la pide a Binance en cada arranque y la ordena por volumen real de las
// últimas 24 h.
//
// Por qué el volumen importa para operar, y no es un detalle estético:
//   · El spread se ensancha donde no hay volumen, y el spread es coste.
//   · Un par ilíquido se mueve a saltos, así que el stop salta con él.
//   · Sin contrapartida, salir de una posición mueve el precio en tu contra.
//
// Se filtra a márgenes en USDT: los de USDC o los cuadráticos tienen otra
// mecánica de liquidación y mezclarlos falsearía las comparaciones.
//
// Y sobre todo se filtra a CRIPTO. Binance Futuros lista 155 acciones y
// materias primas tokenizadas —Micron, SanDisk, SK Hynix, ETF apalancados,
// crudo— y varias mueven más volumen que muchas criptos. Un ranking sin ese
// filtro devolvía SOXL, MU, SNDK y CL entre los veinte primeros, que no es lo
// que nadie pide cuando pide criptomonedas. Se distinguen por `exchangeInfo`:
//
//   cripto:  contractType PERPETUAL          · underlyingType COIN
//   TradFi:  contractType TRADIFI_PERPETUAL  · underlyingType EQUITY/COMMODITY
// ============================================================
import { getJson } from "./net";

const REST = "https://fapi.binance.com/fapi/v1";

export interface UniverseEntry {
  /** símbolo de Binance Futuros, p. ej. BTCUSDT */
  symbol: string;
  /** moneda base, para mostrar: BTC */
  base: string;
  /** volumen nocional de 24 h en USDT */
  quoteVolume: number;
  lastPrice: number;
  changePct: number;
  /** recorrido del día como % del precio: (máx − mín) / precio */
  rangePct: number;
  /** decimales sensatos para mostrar el precio */
  decimals: number;
}

/*
  Decimales por magnitud. Un precio de 0,00002 con dos decimales sale como
  "0,00" y uno de 78.000 con seis decimales es ilegible.
*/
export function decimalsFor(price: number): number {
  if (!(price > 0)) return 2;
  if (price >= 1000) return 1;
  if (price >= 100) return 2;
  if (price >= 1) return 3;
  if (price >= 0.01) return 5;
  return 7;
}

interface SymbolInfo {
  symbol: string;
  contractType?: string;
  underlyingType?: string;
  status?: string;
}

/** Perpetuos de CRIPTO en negociación, por símbolo. */
export function cryptoPerps(symbols: SymbolInfo[]): Set<string> {
  const out = new Set<string>();
  for (const s of symbols) {
    if (!s.symbol) continue;
    if (s.contractType !== "PERPETUAL") continue; // TRADIFI_PERPETUAL fuera
    if (s.underlyingType !== "COIN") continue; // EQUITY y COMMODITY fuera
    if (s.status && s.status !== "TRADING") continue; // no listar lo que no se puede operar
    out.add(s.symbol);
  }
  return out;
}

interface Ticker24h {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
  highPrice: string;
  lowPrice: string;
}

/**
 * Ordena por volumen y devuelve los `limit` primeros.
 *
 * `permitidos` es el conjunto de perpetuos de cripto de `exchangeInfo`. Si
 * llega vacío se cae a un filtro por nombre, que es peor pero mejor que
 * devolver acciones: sin él, un fallo de esa petición llenaría la lista de
 * TradFi sin avisar.
 */
export function rankTickers(rows: Ticker24h[], limit = 20, permitidos?: Set<string>): UniverseEntry[] {
  const out: UniverseEntry[] = [];
  const usarLista = !!permitidos && permitidos.size > 0;

  for (const t of rows) {
    // Solo perpetuos con margen en USDT. Se excluyen los apalancados del tipo
    // "UPUSDT"/"DOWNUSDT", que no son el activo sino un producto derivado.
    if (!t.symbol?.endsWith("USDT")) continue;
    if (/(UP|DOWN|BULL|BEAR)USDT$/.test(t.symbol)) continue;
    // Los pares con prefijo numérico (1000PEPEUSDT) son cripto legítima.
    if (usarLista && !permitidos!.has(t.symbol)) continue;

    const lastPrice = Number(t.lastPrice);
    const quoteVolume = Number(t.quoteVolume);
    const high = Number(t.highPrice);
    const low = Number(t.lowPrice);
    if (!(lastPrice > 0) || !(quoteVolume > 0)) continue;

    out.push({
      symbol: t.symbol,
      base: t.symbol.replace(/USDT$/, ""),
      quoteVolume,
      lastPrice,
      changePct: Number(t.priceChangePercent),
      rangePct: high > 0 && low > 0 ? ((high - low) / lastPrice) * 100 : NaN,
      decimals: decimalsFor(lastPrice),
    });
  }

  out.sort((a, b) => b.quoteVolume - a.quoteVolume);
  return out.slice(0, limit);
}

export async function fetchUniverse(limit = 20): Promise<UniverseEntry[]> {
  // exchangeInfo dice qué es cripto y qué es una acción tokenizada; el ticker
  // dice cuánto se mueve. Hacen falta los dos.
  const [infoRes, rowsRes] = await Promise.allSettled([
    getJson<{ symbols?: SymbolInfo[] }>(`${REST}/exchangeInfo`),
    getJson<Ticker24h[]>(`${REST}/ticker/24hr`),
  ]);

  if (rowsRes.status !== "fulfilled" || !Array.isArray(rowsRes.value)) return [];

  const permitidos =
    infoRes.status === "fulfilled" && Array.isArray(infoRes.value?.symbols)
      ? cryptoPerps(infoRes.value.symbols)
      : undefined;

  return rankTickers(rowsRes.value, limit, permitidos);
}
