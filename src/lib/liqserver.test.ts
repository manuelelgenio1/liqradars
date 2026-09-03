import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyServer, fetchServerStudy, isStale, SERVER_URL, STALE_MS } from "./liqserver";
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

describe("configuración", () => {
  it("trae una URL por defecto, sin depender del alojamiento", () => {
    // Si esto queda vacío, un despliegue se quedaría sin registro en silencio.
    expect(SERVER_URL).toMatch(/^https:\/\//);
  });

  it("el estado vacío no finge un veredicto", () => {
    expect(analyze(emptyServer().study).verdict).toBe("SIN DATOS");
  });
});

describe("saneado de filas", () => {
  // El filtro se prueba también a través del análisis, que es donde de verdad
  // importa que no entre basura.
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

  it("lee una respuesta correcta", async () => {
    vi.stubGlobal("fetch", respuesta({ obs: [buena(1), buena(2)], updatedAt: 5, runs: 7 }));
    const r = await fetchServerStudy();
    expect(r.error).toBeNull();
    expect(r.study.obs).toHaveLength(2);
    expect(r.updatedAt).toBe(5);
    expect(r.runs).toBe(7);
  });

  it("un 404 no rompe la app, solo lo cuenta", async () => {
    vi.stubGlobal("fetch", respuesta(null, false, 404));
    const r = await fetchServerStudy();
    expect(r.error).toBe("HTTP 404");
    expect(r.study.obs).toEqual([]);
  });

  it("si la red falla devuelve vacío en vez de lanzar", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("sin red"); }));
    const r = await fetchServerStudy();
    expect(r.error).toBe("sin respuesta");
    expect(analyze(r.study).verdict).toBe("SIN DATOS");
  });

  it("un JSON con basura se queda solo con lo válido", async () => {
    vi.stubGlobal("fetch", respuesta({ obs: [buena(1), null, { id: 5 }, buena(2, { price: 0 })] }));
    const r = await fetchServerStudy();
    expect(r.study.obs).toHaveLength(1);
  });

  it("propaga el aborto al desmontar, sin tragárselo", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new DOMException("abortado", "AbortError");
    }));
    await expect(fetchServerStudy()).rejects.toThrow();
  });
});

describe("grabador parado", () => {
  /*
    El fallo que esto vigila: un grabador muerto y un mercado tranquilo se ven
    igual desde fuera —el mismo archivo, la misma fecha— y la app enseñaría un
    registro congelado como si estuviera vivo. Por eso el grabador deja
    constancia cada seis horas aunque no encuentre nada, y aquí se comprueba
    que ese silencio se detecta.
  */
  const AHORA = 1_800_000_000_000;
  const con = (updatedAt: number) => ({ ...emptyServer(), updatedAt });

  it("recién comprobado no es sospechoso", () => {
    expect(isStale(con(AHORA - 60_000), AHORA)).toBe(false);
  });

  it("tolera que pase un latido sin novedad", () => {
    // seis horas es lo normal en mercado tranquilo: no debe alarmar
    expect(isStale(con(AHORA - 6.5 * 60 * 60_000), AHORA)).toBe(false);
  });

  it("pasado el margen, avisa", () => {
    expect(isStale(con(AHORA - STALE_MS - 1), AHORA)).toBe(true);
  });

  it("no confunde un fallo de red con un grabador parado", () => {
    const s = { ...con(AHORA - STALE_MS - 1), error: "sin respuesta" };
    expect(isStale(s, AHORA)).toBe(false);
  });

  it("un registro que nunca se ha leído no se marca como parado", () => {
    expect(isStale(emptyServer(), AHORA)).toBe(false);
  });

  it("lastDataAt se cae a updatedAt en registros antiguos que no lo traen", async () => {
    vi.stubGlobal("fetch", respuesta({ obs: [buena(1)], updatedAt: 999 }));
    const r = await fetchServerStudy();
    expect(r.lastDataAt).toBe(999);
  });

  it("distingue comprobado de último dato", async () => {
    vi.stubGlobal("fetch", respuesta({ obs: [buena(1)], updatedAt: 900, lastDataAt: 100 }));
    const r = await fetchServerStudy();
    expect(r.updatedAt).toBe(900);
    expect(r.lastDataAt).toBe(100);
  });
});
