import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOrderBook } from "./binance";

/*
  El fallo que esto cierra: con el libro vacío, `imbalance` valía 0.

  Cero NO es lo mismo que "no hay datos". Cero significa que hay exactamente
  tanto nocional comprando como vendiendo — una lectura real y bastante
  informativa. Devolverlo cuando no ha llegado ni un nivel convierte una
  ausencia en una medición, y el panel anunciaba "0,0 % · presión compradora"
  sin que nadie hubiera medido nada.

  Es la quinta vez que aparece este patrón en el proyecto: un valor por
  defecto que se disfraza de dato bueno.
*/

const responder = (body: unknown) =>
  vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as unknown as Response);

const nivel = (p: number, q: number): [string, string] => [String(p), String(q)];

afterEach(() => vi.unstubAllGlobals());

describe("desequilibrio del libro", () => {
  it("con libro vacío devuelve NaN, no cero", async () => {
    vi.stubGlobal("fetch", responder({ bids: [], asks: [] }));
    const b = await fetchOrderBook("BTCUSDT");
    expect(Number.isFinite(b.imbalance)).toBe(false);
    expect(b.imbalance).not.toBe(0);
  });

  it("un equilibrio REAL sí es cero", async () => {
    // Aquí sí hay datos y sí están igualados: cero es la lectura correcta.
    vi.stubGlobal("fetch", responder({ bids: [nivel(100, 5)], asks: [nivel(101, 5)] }));
    const b = await fetchOrderBook("BTCUSDT");
    expect(b.imbalance).toBe(0);
  });

  it("más compras que ventas da positivo", async () => {
    vi.stubGlobal("fetch", responder({ bids: [nivel(100, 9)], asks: [nivel(101, 1)] }));
    const b = await fetchOrderBook("BTCUSDT");
    expect(b.imbalance).toBeCloseTo(0.8, 6);
  });

  it("más ventas que compras da negativo", async () => {
    vi.stubGlobal("fetch", responder({ bids: [nivel(100, 1)], asks: [nivel(101, 9)] }));
    const b = await fetchOrderBook("BTCUSDT");
    expect(b.imbalance).toBeCloseTo(-0.8, 6);
  });

  it("un lado vacío no se confunde con equilibrio", async () => {
    // Solo compras: el desequilibrio es máximo, no cero.
    vi.stubGlobal("fetch", responder({ bids: [nivel(100, 5)], asks: [] }));
    const b = await fetchOrderBook("BTCUSDT");
    expect(b.imbalance).toBe(1);
  });

  it("una respuesta sin los campos no revienta", async () => {
    vi.stubGlobal("fetch", responder({}));
    const b = await fetchOrderBook("BTCUSDT");
    expect(b.bids).toEqual([]);
    expect(Number.isFinite(b.imbalance)).toBe(false);
  });

  it("nunca se sale del rango −1..1", async () => {
    for (const [bq, aq] of [[1, 1], [1000, 1], [1, 1000], [7, 3]]) {
      vi.stubGlobal("fetch", responder({ bids: [nivel(100, bq)], asks: [nivel(101, aq)] }));
      const b = await fetchOrderBook("BTCUSDT");
      expect(b.imbalance).toBeGreaterThanOrEqual(-1);
      expect(b.imbalance).toBeLessThanOrEqual(1);
    }
  });

  it("acumula sobre los niveles, no solo el primero", async () => {
    vi.stubGlobal("fetch", responder({
      bids: [nivel(100, 1), nivel(99, 2), nivel(98, 3)],
      asks: [nivel(101, 6)],
    }));
    const b = await fetchOrderBook("BTCUSDT");
    expect(b.bids.at(-1)!.cumulative).toBe(6);
    expect(b.imbalance).toBe(0); // 6 contra 6
  });
});
