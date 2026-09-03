// ============================================================
// Tipos compartidos.
//
// Regla de oro del proyecto: un número que no se ha medido vale NaN, nunca
// un valor de relleno. La interfaz pinta NaN como "—". Si un dato no está
// disponible, se dice; no se inventa.
// ============================================================

export type Side = "long" | "short";

/** De dónde salió un dato. La interfaz lo muestra siempre. */
export type Provenance =
  | "binance"
  | "okx"
  | "bybit"
  | "hyperliquid"
  | "coinglass"
  | "derivado" // calculado por nosotros a partir de datos reales
  | "sin-dato";

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  /** volumen comprador − vendedor (taker). Real: viene de la vela de Binance. */
  delta: number;
}

export interface BookLevel {
  price: number;
  size: number;
  cumulative: number;
}

export interface OrderBook {
  bids: BookLevel[];
  asks: BookLevel[];
  /**
   * (bids − asks) / (bids + asks) sobre la profundidad visible.
   * NaN si no llegó ningún nivel: cero sería una lectura real ("equilibrio
   * perfecto") y confundiría la ausencia de datos con una medición.
   */
  imbalance: number;
  ts: number;
}

/** Liquidación individual, tal cual la publicó un exchange. Nunca sintética. */
export interface Liquidation {
  id: string;
  ts: number;
  exchange: Provenance;
  symbol: string;
  /** lado de la POSICIÓN liquidada */
  side: Side;
  price: number;
  /** cantidad en moneda base, ya convertida desde contratos si hacía falta */
  qty: number;
  usd: number;
}

export interface FundingInfo {
  rate: number; // %
  nextMs: number;
  source: Provenance;
}

export interface OpenInterestInfo {
  usd: number;
  /** variación real en 1 h, del histórico del exchange. NaN si no hay dato. */
  delta1hPct: number;
  source: Provenance;
}

export interface LongShortInfo {
  ratio: number;
  longPct: number;
  topTraderRatio: number;
  source: Provenance;
}

export interface SymbolSpec {
  /** clave interna, siempre estilo Binance */
  key: string;
  base: string;
  name: string;
  decimals: number;
  binance: string;
  okx: string;
  bybit: string;
}

export const SYMBOLS: SymbolSpec[] = [
  { key: "BTCUSDT", base: "BTC", name: "Bitcoin", decimals: 1, binance: "BTCUSDT", okx: "BTC-USDT-SWAP", bybit: "BTCUSDT" },
  { key: "ETHUSDT", base: "ETH", name: "Ethereum", decimals: 2, binance: "ETHUSDT", okx: "ETH-USDT-SWAP", bybit: "ETHUSDT" },
  { key: "SOLUSDT", base: "SOL", name: "Solana", decimals: 2, binance: "SOLUSDT", okx: "SOL-USDT-SWAP", bybit: "SOLUSDT" },
  { key: "BNBUSDT", base: "BNB", name: "BNB", decimals: 2, binance: "BNBUSDT", okx: "BNB-USDT-SWAP", bybit: "BNBUSDT" },
  { key: "XRPUSDT", base: "XRP", name: "XRP", decimals: 4, binance: "XRPUSDT", okx: "XRP-USDT-SWAP", bybit: "XRPUSDT" },
  { key: "DOGEUSDT", base: "DOGE", name: "Dogecoin", decimals: 5, binance: "DOGEUSDT", okx: "DOGE-USDT-SWAP", bybit: "DOGEUSDT" },
];

/*
  Los seis de `SYMBOLS` son los que tienen mapeo en los tres exchanges, así que
  son los únicos con liquidaciones de OKX y Bybit.

  Pero la mesa de operaciones trabaja con los 20 perpetuos de más volumen, y
  esos salen del ranking de Binance en vivo. Para ellos se sintetiza un spec:
  precio, velas, indicadores y niveles funcionan igual —todo eso sale de
  Binance— y las liquidaciones simplemente no aparecen, porque no hay a qué
  suscribirse.

  Antes esta función devolvía `SYMBOLS[0]` para cualquier clave desconocida.
  Eso significaba que pulsar un par del escáner te cambiaba a BTC EN SILENCIO,
  con el gráfico y los niveles de BTC mientras la lista decía otro nombre. Un
  fallback que se disfraza de éxito es peor que un error.
*/
export const isCurated = (key: string): boolean => SYMBOLS.some((s) => s.key === key);

export const symbolOf = (key: string): SymbolSpec => {
  const conocido = SYMBOLS.find((s) => s.key === key);
  if (conocido) return conocido;
  if (!/^[A-Z0-9]{2,20}USDT$/.test(key)) return SYMBOLS[0]; // basura: se cae al de siempre
  const base = key.replace(/USDT$/, "");
  return {
    key,
    base,
    name: base,
    // Sin precio no se pueden decidir los decimales aquí; los paneles que
    // muestran precios usan `decimalsFor(precio)` cuando les importa.
    decimals: 4,
    binance: key,
    // Vacíos a propósito: no hay mapeo verificado en estos exchanges, y
    // adivinarlo produciría suscripciones a instrumentos inexistentes.
    okx: "",
    bybit: "",
  };
};

export interface Timeframe {
  key: string;
  minutes: number;
  binance: string;
  label: string;
}

export const TIMEFRAMES: Timeframe[] = [
  { key: "1m", minutes: 1, binance: "1m", label: "1 min" },
  { key: "5m", minutes: 5, binance: "5m", label: "5 min" },
  { key: "15m", minutes: 15, binance: "15m", label: "15 min" },
  { key: "30m", minutes: 30, binance: "30m", label: "30 min" },
  { key: "1H", minutes: 60, binance: "1h", label: "1 hora" },
  { key: "4H", minutes: 240, binance: "4h", label: "4 horas" },
  { key: "1D", minutes: 1440, binance: "1d", label: "1 día" },
  { key: "1W", minutes: 10080, binance: "1w", label: "1 semana" },
];

export const timeframeOf = (key: string): Timeframe =>
  TIMEFRAMES.find((t) => t.key === key) ?? TIMEFRAMES[1];

/**
 * Escalera de apalancamiento: una posición xN se liquida aproximadamente a
 * 1/N del precio de entrada. x100 → 1 %, x5 → 20 %.
 */
export const LEVERAGES = [100, 50, 20, 10, 5] as const;
export const levDistancePct = (lev: number) => 100 / lev;
