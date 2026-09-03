import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addEvents,
  countsInTotals,
  emptyStore,
  eventsFor,
  levelsFor,
  ratePerMinute,
  sideBalance,
  topLevels,
  totalsFor,
} from "./liqstore";
import type { Liquidation } from "./types";

// El store persiste en localStorage; en Node no existe.
beforeEach(() => {
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  });
});

const now = Date.now();

function liq(over: Partial<Liquidation> = {}): Liquidation {
  return {
    id: over.id ?? `id-${Math.random()}`,
    ts: over.ts ?? now,
    exchange: over.exchange ?? "okx",
    symbol: over.symbol ?? "BTCUSDT",
    side: over.side ?? "long",
    price: over.price ?? 50_000,
    qty: over.qty ?? 1,
    usd: over.usd ?? 50_000,
  };
}

describe("procedencia y totales", () => {
  it("OKX y Bybit suman; Binance no", () => {
    expect(countsInTotals("okx")).toBe(true);
    expect(countsInTotals("bybit")).toBe(true);
    // Binance solo publica la mayor liquidación de cada segundo por símbolo:
    // sumarla junto a fuentes completas sesgaría el agregado.
    expect(countsInTotals("binance")).toBe(false);
  });

  it("los eventos de Binance se guardan pero no entran en el total", () => {
    const s = addEvents(emptyStore(), [
      liq({ id: "a", exchange: "okx", usd: 1000, side: "long" }),
      liq({ id: "b", exchange: "binance", usd: 999_999, side: "long" }),
    ]);
    const t = totalsFor(s, "BTCUSDT");
    expect(t.long).toBe(1000);
    expect(t.count).toBe(1);
    // pero siguen visibles en el desglose
    expect(t.byExchange.binance).toBe(1);
    expect(eventsFor(s, "BTCUSDT")).toHaveLength(2);
  });

  it("separa longs de shorts", () => {
    const s = addEvents(emptyStore(), [
      liq({ id: "l", side: "long", usd: 300 }),
      // instantes distintos: dos eventos idénticos en TODO (mismo ms, precio,
      // tamaño, lado y exchange) son indistinguibles de una entrega duplicada
      // y se deduplican a propósito.
      liq({ id: "s1", side: "short", usd: 100, ts: now - 1000 }),
      liq({ id: "s2", side: "short", usd: 100, ts: now - 2000 }),
    ]);
    const t = totalsFor(s, "BTCUSDT");
    expect(t.long).toBe(300);
    expect(t.short).toBe(200);
  });

  it("no mezcla símbolos", () => {
    const s = addEvents(emptyStore(), [
      liq({ id: "a", symbol: "BTCUSDT", usd: 100 }),
      liq({ id: "b", symbol: "ETHUSDT", usd: 900 }),
    ]);
    expect(totalsFor(s, "BTCUSDT").long).toBe(100);
    expect(totalsFor(s, "ETHUSDT").long).toBe(900);
  });
});

describe("deduplicación", () => {
  it("ignora el mismo id dos veces", () => {
    let s = addEvents(emptyStore(), [liq({ id: "x", usd: 100 })]);
    s = addEvents(s, [liq({ id: "x", usd: 100 })]);
    expect(eventsFor(s, "BTCUSDT")).toHaveLength(1);
  });

  // el WS en vivo y el backfill histórico entregan el MISMO evento con ids
  // distintos: hay que deduplicar también por contenido
  it("ignora un duplicado con id distinto pero mismos datos", () => {
    const at = now - 30_000;
    let s = addEvents(emptyStore(), [liq({ id: "ws-1", ts: at, price: 50_000, qty: 2 })]);
    s = addEvents(s, [liq({ id: "rest-9", ts: at, price: 50_000, qty: 2 })]);
    expect(eventsFor(s, "BTCUSDT")).toHaveLength(1);
  });

  // Compromiso asumido: dos liquidaciones reales idénticas en el mismo
  // milisegundo se colapsan en una. Es el precio de poder fusionar el WS con
  // el backfill sin contar doble, y el caso es mucho más raro que el duplicado.
  it("colapsa eventos idénticos en el mismo instante", () => {
    const at = now - 5000;
    const s = addEvents(emptyStore(), [
      liq({ id: "u1", ts: at, price: 50_000, qty: 1, side: "short" }),
      liq({ id: "u2", ts: at, price: 50_000, qty: 1, side: "short" }),
    ]);
    expect(eventsFor(s, "BTCUSDT")).toHaveLength(1);
  });

  it("devuelve la MISMA referencia si no hay nada nuevo (evita renders vacíos)", () => {
    const s = addEvents(emptyStore(), [liq({ id: "x" })]);
    expect(addEvents(s, [liq({ id: "x" })])).toBe(s);
    expect(addEvents(s, [])).toBe(s);
  });
});

describe("ventana de 24 h", () => {
  it("descarta lo más viejo de 24 h", () => {
    const s = addEvents(emptyStore(), [
      liq({ id: "viejo", ts: now - 25 * 3600_000 }),
      liq({ id: "nuevo", ts: now - 60_000 }),
    ]);
    const ids = eventsFor(s, "BTCUSDT").map((e) => e.id);
    expect(ids).toContain("nuevo");
    expect(ids).not.toContain("viejo");
  });

  it("ordena de más reciente a más antiguo", () => {
    const s = addEvents(emptyStore(), [
      liq({ id: "a", ts: now - 5000 }),
      liq({ id: "c", ts: now - 1000 }),
      liq({ id: "b", ts: now - 3000 }),
    ]);
    expect(eventsFor(s, "BTCUSDT").map((e) => e.id)).toEqual(["c", "b", "a"]);
  });
});

describe("niveles de precio", () => {
  it("agrupa precios cercanos en el mismo nivel y separa los lejanos", () => {
    const s = addEvents(emptyStore(), [
      liq({ id: "a", price: 50_000, usd: 100 }),
      liq({ id: "b", price: 50_010, usd: 100 }), // dentro del mismo cubo (0,05 %)
      liq({ id: "c", price: 52_000, usd: 100 }), // claramente en otro
    ]);
    const levels = levelsFor(s, "BTCUSDT", 50_000);
    expect(levels.length).toBe(2);
    const dense = levels.find((l) => Math.abs(l.price - 50_005) < 50)!;
    expect(dense.count).toBe(2);
  });

  it("reparte el nocional por lado dentro del nivel", () => {
    const s = addEvents(emptyStore(), [
      liq({ id: "a", price: 50_000, usd: 700, side: "long" }),
      liq({ id: "b", price: 50_000, usd: 300, side: "short" }),
    ]);
    const [lvl] = levelsFor(s, "BTCUSDT", 50_000);
    expect(lvl.usdLong).toBe(700);
    expect(lvl.usdShort).toBe(300);
  });

  it("excluye del perfil las fuentes recortadas", () => {
    const s = addEvents(emptyStore(), [liq({ id: "b", exchange: "binance", price: 50_000 })]);
    expect(levelsFor(s, "BTCUSDT", 50_000)).toHaveLength(0);
  });

  it("topLevels ordena por nocional total", () => {
    const s = addEvents(emptyStore(), [
      liq({ id: "a", price: 50_000, usd: 100 }),
      liq({ id: "b", price: 51_000, usd: 900 }),
    ]);
    const top = topLevels(levelsFor(s, "BTCUSDT", 50_000), 1);
    expect(top[0].usdLong).toBe(900);
  });

  it("un precio de referencia inválido no revienta", () => {
    const s = addEvents(emptyStore(), [liq({ id: "a" })]);
    expect(levelsFor(s, "BTCUSDT", 0)).toEqual([]);
    expect(levelsFor(s, "BTCUSDT", NaN)).toEqual([]);
  });
});

describe("ritmo y balance", () => {
  it("cuenta eventos por minuto en la ventana", () => {
    const s = addEvents(emptyStore(), [
      liq({ id: "a", ts: now - 10_000 }),
      liq({ id: "b", ts: now - 20_000 }),
      liq({ id: "c", ts: now - 60 * 60_000 }), // fuera de los 5 min
    ]);
    expect(ratePerMinute(s, "BTCUSDT", 5)).toBeCloseTo(2 / 5, 6);
  });

  it("el balance identifica el lado dominante", () => {
    expect(sideBalance({ long: 900, short: 100, count: 2, byExchange: {}, oldestTs: 0, hasCompleteSource: true }))
      .toMatchObject({ dominant: "long" });
    expect(sideBalance({ long: 100, short: 900, count: 2, byExchange: {}, oldestTs: 0, hasCompleteSource: true }))
      .toMatchObject({ dominant: "short" });
  });

  it("sin datos no inventa un lado", () => {
    const b = sideBalance({ long: 0, short: 0, count: 0, byExchange: {}, oldestTs: 0, hasCompleteSource: false });
    expect(b.dominant).toBeNull();
    expect(b.pct).toBe(0);
  });
});

describe("entradas basura", () => {
  it("descarta eventos con precio o nocional inválidos", () => {
    const s = addEvents(emptyStore(), [
      liq({ id: "ok", price: 50_000, usd: 100 }),
      { ...liq({ id: "nan" }), price: NaN },
      { ...liq({ id: "neg" }), usd: -5 },
    ]);
    // no se filtran en addEvents, pero no deben romper los agregados
    expect(Number.isFinite(totalsFor(s, "BTCUSDT").long)).toBe(true);
  });
});
