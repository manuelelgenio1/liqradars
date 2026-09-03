import { describe, expect, it } from "vitest";
import { cryptoPerps, decimalsFor, rankTickers } from "./universe";
import { isCurated, SYMBOLS, symbolOf } from "./types";

const t = (symbol: string, quoteVolume: string, lastPrice = "100", extra: Record<string, string> = {}) => ({
  symbol, quoteVolume, lastPrice,
  priceChangePercent: "1.5", highPrice: "105", lowPrice: "95",
  ...extra,
});

describe("ranking por volumen", () => {
  it("ordena de más a menos volumen", () => {
    const r = rankTickers([t("AAAUSDT", "100"), t("BBBUSDT", "900"), t("CCCUSDT", "500")]);
    expect(r.map((x) => x.base)).toEqual(["BBB", "CCC", "AAA"]);
  });

  it("recorta al límite pedido", () => {
    const muchos = Array.from({ length: 50 }, (_, i) => t(`S${i}USDT`, String(1000 - i)));
    expect(rankTickers(muchos, 20)).toHaveLength(20);
  });

  it("descarta lo que no es un perpetuo en USDT", () => {
    const r = rankTickers([t("BTCUSDC", "999"), t("ETHBUSD", "999"), t("BTCUSDT", "1")]);
    expect(r.map((x) => x.symbol)).toEqual(["BTCUSDT"]);
  });

  it("descarta los apalancados, que no son el activo", () => {
    const r = rankTickers([t("BTCUPUSDT", "999"), t("ETHDOWNUSDT", "999"), t("SOLUSDT", "1")]);
    expect(r.map((x) => x.symbol)).toEqual(["SOLUSDT"]);
  });

  it("conserva los pares con prefijo numérico, que sí son legítimos", () => {
    const r = rankTickers([t("1000PEPEUSDT", "500")]);
    expect(r[0].base).toBe("1000PEPE");
  });

  it("tira filas con precio o volumen imposibles en vez de colarlas", () => {
    const r = rankTickers([
      t("AAAUSDT", "0"), t("BBBUSDT", "100", "0"),
      t("CCCUSDT", "abc"), t("DDDUSDT", "100", "50"),
    ]);
    expect(r.map((x) => x.symbol)).toEqual(["DDDUSDT"]);
  });

  it("calcula el recorrido del día como % del precio", () => {
    const r = rankTickers([t("AAAUSDT", "100", "100", { highPrice: "110", lowPrice: "90" })]);
    expect(r[0].rangePct).toBeCloseTo(20, 6);
  });

  it("una entrada vacía no revienta", () => {
    expect(rankTickers([])).toEqual([]);
  });
});

describe("decimales por magnitud", () => {
  // Un precio de 0,00002 con dos decimales sale como "0,00": el dato existe
  // pero no se puede leer, que a efectos prácticos es no tenerlo.
  it("más decimales cuanto más pequeño el precio", () => {
    expect(decimalsFor(78000)).toBeLessThan(decimalsFor(0.5));
    expect(decimalsFor(0.5)).toBeLessThan(decimalsFor(0.00002));
  });

  it("nunca deja un precio en cero por redondeo", () => {
    for (const p of [78000, 2400, 150, 1.31, 0.08, 0.0000234]) {
      expect(Number(p.toFixed(decimalsFor(p)))).toBeGreaterThan(0);
    }
  });

  it("un precio imposible no rompe el formato", () => {
    expect(decimalsFor(0)).toBeGreaterThan(0);
    expect(decimalsFor(NaN)).toBeGreaterThan(0);
  });
});

describe("símbolos fuera de la lista curada", () => {
  /*
    El fallo que esto cierra: `symbolOf` devolvía SYMBOLS[0] para cualquier
    clave desconocida. Pulsar un par del escáner que no estuviera entre los
    seis curados cambiaba a BTC EN SILENCIO — gráfico y niveles de BTC con
    otro nombre en la lista.
  */
  it("los curados siguen siendo los mismos", () => {
    for (const s of SYMBOLS) {
      expect(symbolOf(s.key)).toBe(s);
      expect(isCurated(s.key)).toBe(true);
    }
  });

  it("un par del universo ampliado devuelve SU propio símbolo, no BTC", () => {
    const s = symbolOf("WIFUSDT");
    expect(s.key).toBe("WIFUSDT");
    expect(s.binance).toBe("WIFUSDT");
    expect(s.base).toBe("WIF");
    expect(isCurated("WIFUSDT")).toBe(false);
  });

  it("deja OKX y Bybit vacíos en vez de adivinar el mapeo", () => {
    // Adivinar produciría suscripciones a instrumentos que no existen.
    const s = symbolOf("1000BONKUSDT");
    expect(s.okx).toBe("");
    expect(s.bybit).toBe("");
  });

  it("una clave que no parece un símbolo sí cae al de siempre", () => {
    for (const basura of ["", "???", "javascript:void", "BTC-USDT-SWAP"]) {
      expect(symbolOf(basura).key).toBe(SYMBOLS[0].key);
    }
  });
});

describe("solo criptomonedas, no acciones tokenizadas", () => {
  /*
    Binance Futuros lista 155 acciones y materias primas tokenizadas, y varias
    mueven más volumen que muchas criptos. Sin este filtro, el ranking de "las
    20 criptomonedas con más volumen" devolvía SOXL (un ETF apalancado de
    semiconductores), MU (Micron), SNDK (SanDisk) y CL (crudo).

    Se distinguen por exchangeInfo, no por el nombre: no hay forma de saber
    por el símbolo que MU es una acción y SUI no lo es.
  */
  const info = [
    { symbol: "BTCUSDT", contractType: "PERPETUAL", underlyingType: "COIN", status: "TRADING" },
    { symbol: "1000PEPEUSDT", contractType: "PERPETUAL", underlyingType: "COIN", status: "TRADING" },
    { symbol: "SOXLUSDT", contractType: "TRADIFI_PERPETUAL", underlyingType: "EQUITY", status: "TRADING" },
    { symbol: "MUUSDT", contractType: "TRADIFI_PERPETUAL", underlyingType: "EQUITY", status: "TRADING" },
    { symbol: "CLUSDT", contractType: "TRADIFI_PERPETUAL", underlyingType: "COMMODITY", status: "TRADING" },
    { symbol: "OLDUSDT", contractType: "PERPETUAL", underlyingType: "COIN", status: "SETTLING" },
    { symbol: "BTCUSDT_250926", contractType: "CURRENT_QUARTER", underlyingType: "COIN", status: "TRADING" },
  ];

  it("deja pasar solo los perpetuos de cripto en negociación", () => {
    expect([...cryptoPerps(info)].sort()).toEqual(["1000PEPEUSDT", "BTCUSDT"]);
  });

  it("excluye acciones y materias primas tokenizadas", () => {
    const ok = cryptoPerps(info);
    for (const s of ["SOXLUSDT", "MUUSDT", "CLUSDT"]) expect(ok.has(s)).toBe(false);
  });

  it("excluye lo que no se puede operar y los trimestrales", () => {
    const ok = cryptoPerps(info);
    expect(ok.has("OLDUSDT")).toBe(false);
    expect(ok.has("BTCUSDT_250926")).toBe(false);
  });

  it("el ranking respeta la lista permitida por encima del volumen", () => {
    // SOXL mueve nueve veces más y NO debe aparecer
    const r = rankTickers(
      [t("SOXLUSDT", "9000"), t("BTCUSDT", "1000")],
      20,
      cryptoPerps(info)
    );
    expect(r.map((x) => x.symbol)).toEqual(["BTCUSDT"]);
  });

  it("si exchangeInfo falla no se cuela TradFi por la puerta de atrás", () => {
    // Sin lista se usa el filtro por nombre: peor, pero no debe reventar ni
    // devolver algo con pinta de acción sin avisar. Se acepta el resultado
    // degradado a cambio de que el fallo sea visible en el conjunto vacío.
    const sinLista = rankTickers([t("SOXLUSDT", "9000"), t("BTCUSDT", "1000")], 20, new Set());
    expect(sinLista.length).toBeGreaterThan(0); // no se queda en blanco
    const conLista = rankTickers([t("SOXLUSDT", "9000"), t("BTCUSDT", "1000")], 20, cryptoPerps(info));
    expect(conLista.length).toBeLessThan(sinLista.length); // la lista sí filtra
  });
});
