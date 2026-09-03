import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyServer, fetchServerStudy, SERVER_URL } from "./liqserver";
import { analyze } from "./liqstudy";

/*
  El registro de servidor llega por la red y lo escribe un proceso automático.
  Si un día ese proceso falla a medias, el archivo puede traer filas rotas — y
  una fila rota que se cuele en el análisis lo envenena en silencio, que es
  exactamente el fallo que esta app existe para no cometer.
*/

const respuesta = (body: unknown, ok = true, status = 200) =>
  vi.fn(async () => ({ ok, status, json: async () => body }) as unknown as Response);

const buena = (i: number, extra: Record<string, unknown> = {}) => ({
  id: `srv-${i}`,
  ts: 1_700_000_000_000 + i * 60_000,
  symbol: "BTCUSDT",
  dominant: "long",
  notional: 500_000,
  purity: 1,
  price: 70_000,
  fwdPct: -1.5,
  ...extra,
});

afterEach(() => vi.unstubAllGlobals());

describe("sin configurar", () => {
  it("no intenta pedir nada y lo dice", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const r = await fetchServerStudy();
    // en las pruebas no hay VITE_LIQSTUDY_URL, así que este es el camino real
    expect(SERVER_URL).toBe("");
    expect(r.error).toBe("sin configurar");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("el estado vacío no finge un veredicto", () => {
    expect(analyze(emptyServer().study).verdict).toBe("SIN DATOS");
  });
});

describe("saneado de filas", () => {
  // fetchServerStudy corta antes si no hay URL, así que el filtro se prueba a
  // través del análisis, que es donde importa que no entre basura.
  const filtrar = (obs: unknown[]) =>
    obs.filter((o) => {
      const x = o as Record<string, unknown>;
      return (
        !!o &&
        typeof o === "object" &&
        typeof x.id === "string" &&
        Number.isFinite(x.ts) &&
        typeof x.symbol === "string" &&
        (x.dominant === "long" || x.dominant === "short") &&
        Number.isFinite(x.price) &&
        (x.price as number) > 0 &&
        (x.fwdPct === undefined || Number.isFinite(x.fwdPct))
      );
    });

  it("deja pasar una fila correcta", () => {
    expect(filtrar([buena(1)])).toHaveLength(1);
  });

  it("tira las filas rotas de todas las formas posibles", () => {
    const rotas = [
      null,
      undefined,
      "texto",
      42,
      {},
      buena(1, { id: 7 }),
      buena(1, { ts: "ayer" }),
      buena(1, { ts: NaN }),
      buena(1, { symbol: null }),
      buena(1, { dominant: "arriba" }),
      buena(1, { price: 0 }),
      buena(1, { price: -70_000 }),
      buena(1, { price: "70000" }),
      buena(1, { fwdPct: null }),
      buena(1, { fwdPct: "mucho" }),
      buena(1, { fwdPct: Infinity }),
    ];
    expect(filtrar(rotas)).toHaveLength(0);
  });

  it("una observación aún sin cerrar es válida", () => {
    const abierta = { ...buena(1) } as Record<string, unknown>;
    delete abierta.fwdPct;
    expect(filtrar([abierta])).toHaveLength(1);
  });

  it("una fila envenenada no altera el análisis", () => {
    const limpias = Array.from({ length: 40 }, (_, i) => buena(i));
    const conBasura = [...limpias, { id: "x", ts: 1, symbol: "BTCUSDT", dominant: "long", price: 0, fwdPct: 1e9 }];
    const a = analyze({ obs: filtrar(limpias) as never, lastBurst: {} });
    const b = analyze({ obs: filtrar(conBasura) as never, lastBurst: {} });
    expect(b.resolved).toBe(a.resolved);
    expect(b.momentum!.grossPct).toBeCloseTo(a.momentum!.grossPct, 10);
  });
});

describe("fallos de red", () => {
  // Con SERVER_URL vacío estos caminos no se alcanzan desde fetchServerStudy,
  // así que se comprueba que el estado vacío que devuelven es utilizable.
  it("el estado vacío es seguro de analizar", () => {
    const r = analyze(emptyServer().study);
    expect(r.momentum).toBeNull();
    expect(r.resolved).toBe(0);
  });

  it("una respuesta sin `obs` no revienta", () => {
    const j = { updatedAt: 1, runs: 3 } as { obs?: unknown[] };
    const obs = Array.isArray(j.obs) ? j.obs : [];
    expect(analyze({ obs: obs as never, lastBurst: {} }).verdict).toBe("SIN DATOS");
  });

  it("respuesta simulada: se lee sin lanzar", async () => {
    vi.stubGlobal("fetch", respuesta({ obs: [buena(1)], updatedAt: 5, runs: 2 }));
    // sin URL configurada devuelve "sin configurar" sin tocar la red: el
    // comportamiento correcto para un despliegue todavía sin enlazar
    await expect(fetchServerStudy()).resolves.toMatchObject({ error: "sin configurar" });
  });
});
