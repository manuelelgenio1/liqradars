import { describe, expect, it } from "vitest";
import { OKX_BAR, okxCandlesUrl, okxPar, parseOkxCandles } from "./okxklines";
import { DESK_TFS } from "../hooks/useTradingDesk";

/*
  Lo que estas pruebas protegen es UNA cosa por encima de las demás: que no se
  mezclen dos escalas de precio en el mismo registro.

  Binance cotiza `1000PEPEUSDT` mil veces por encima de lo que OKX cotiza
  `PEPE-USDT-SWAP`. Una señal nacida con una escala y resuelta con la otra no
  da un error: da una pérdida completa con todos sus campos bien puestos. Es
  el tipo de fallo que este proyecto lleva evitando desde el principio —
  números creíbles y falsos— y aquí entraría por la puerta de atrás.
*/

describe("traducción de símbolos", () => {
  it("un par normal va sin multiplicador", () => {
    expect(okxPar("BTCUSDT")).toEqual({ instId: "BTC-USDT-SWAP", mult: 1 });
    expect(okxPar("ETHUSDT")).toEqual({ instId: "ETH-USDT-SWAP", mult: 1 });
  });

  it("el prefijo numérico ES el multiplicador", () => {
    expect(okxPar("1000PEPEUSDT")).toEqual({ instId: "PEPE-USDT-SWAP", mult: 1000 });
    expect(okxPar("1000BONKUSDT")).toEqual({ instId: "BONK-USDT-SWAP", mult: 1000 });
    expect(okxPar("1000000MOGUSDT")).toEqual({ instId: "MOG-USDT-SWAP", mult: 1000000 });
  });

  it("solo las potencias de diez cuentan como multiplicador", () => {
    // Un par que empiece por dígitos por cualquier otro motivo no debe
    // perderlos: "1INCH" es el nombre de la moneda, no un factor.
    expect(okxPar("1INCHUSDT")).toEqual({ instId: "1INCH-USDT-SWAP", mult: 1 });
  });

  it("lo que no es USDT no se traduce a ciegas", () => {
    expect(okxPar("BTCUSDC")).toBeNull();
    expect(okxPar("USDT")).toBeNull();
    expect(okxPar("")).toBeNull();
  });
});

describe("conversión de velas", () => {
  // [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm] — de nueva a vieja
  const cruda = [
    ["1700003600000", "2", "3", "1", "2.5", "9", "9", "9", "0"], // en curso
    ["1700000000000", "1", "2", "0.5", "1.5", "9", "9", "9", "1"],
    ["1699996400000", "0.5", "1", "0.25", "0.75", "9", "9", "9", "1"],
  ];

  it("descarta la vela en curso", () => {
    const v = parseOkxCandles(cruda, 1);
    expect(v).toHaveLength(2);
    expect(v.some((c) => c.t === 1700003600000)).toBe(false);
  });

  it("devuelve en orden ascendente, que es como lo espera todo lo demás", () => {
    const v = parseOkxCandles(cruda, 1);
    expect(v[0].t).toBeLessThan(v[1].t);
  });

  it("aplica el multiplicador a los CUATRO precios", () => {
    const v = parseOkxCandles(cruda, 1000);
    expect(v[1]).toMatchObject({ o: 1000, h: 2000, l: 500, c: 1500 });
  });

  it("una vela de OKX multiplicada equivale a la de Binance", () => {
    // El caso que importa: mismo instante, precios comparables.
    const okx = parseOkxCandles([["1700000000000", "0.001", "0.002", "0.0005", "0.0015", "0", "0", "0", "1"]], 1000);
    expect(okx[0].c).toBeCloseTo(1.5, 10);
  });

  it("el volumen se anula en vez de mentir", () => {
    // OKX lo da en contratos; dejarlo pasar lo haría parecer comparable.
    expect(parseOkxCandles(cruda, 1).every((c) => c.v === 0)).toBe(true);
  });

  it("las filas rotas se caen solas", () => {
    expect(parseOkxCandles([["x", "y", "z"]], 1)).toEqual([]);
    expect(parseOkxCandles([["1700000000000", "0", "0", "0", "0", "", "", "", "1"]], 1)).toEqual([]);
    expect(parseOkxCandles(null, 1)).toEqual([]);
    expect(parseOkxCandles("nada", 1)).toEqual([]);
  });
});

describe("temporalidades", () => {
  it("el día y la semana van alineados a UTC", () => {
    // Sin el sufijo, OKX los alinea a Hong Kong: ocho horas de desfase que no
    // darían error, solo velas incomparables con todo lo ya medido.
    expect(OKX_BAR["1D"]).toBe("1Dutc");
    expect(OKX_BAR["1W"]).toBe("1Wutc");
  });

  it("cada temporalidad de la mesa tiene traducción", () => {
    for (const k of DESK_TFS) expect(OKX_BAR[k], `falta "${k}"`).toBeTruthy();
  });

  it("la dirección se arma bien", () => {
    expect(okxCandlesUrl("BTC-USDT-SWAP", "4H", 300)).toContain("instId=BTC-USDT-SWAP");
    expect(okxCandlesUrl("BTC-USDT-SWAP", "4H", 300)).toContain("bar=4H");
  });
});
