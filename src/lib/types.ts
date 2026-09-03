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
  /** (bids − asks) / (bids + asks) sobre la profundidad visible */
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

export const symbolOf = (key: string): SymbolSpec =>
  SYMBOLS.find((s) => s.key === key) ?? SYMBOLS[0];

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
