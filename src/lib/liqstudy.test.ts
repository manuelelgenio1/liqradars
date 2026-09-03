import { describe, expect, it } from "vitest";
import {
  analyze,
  BURST_USD,
  COOLDOWN_MS,
  emptyStudy,
  HORIZON_MS,
  clusterEvents,
  EVENT_WINDOW_MS,
  MIN_OBS,
  recordBurst,
  resolvePending,
  type LiqObservation,
  type LiqStudy,
} from "./liqstudy";
import type { Candle } from "./types";

// En Node no existe localStorage: `storage` lo tolera y no persiste nada
// entre pruebas, que es justo el aislamiento que hace falta aquí.

const T0 = 1_700_000_000_000;
const velas = (desde: number, n: number, precio: (i: number) => number): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const c = precio(i);
    return { t: desde + i * 60_000, o: c, h: c, l: c, c, v: 1, delta: 0 };
  });

describe("anotación de estallidos", () => {
  it("ignora lo que no llega al umbral", () => {
    const s = emptyStudy();
    expect(recordBurst(s, "BTCUSDT", T0, 100, BURST_USD * 0.4, BURST_USD * 0.4)).toBe(s);
  });

  it("anota el lado dominante y su pureza", () => {
    const s = recordBurst(emptyStudy(), "BTCUSDT", T0, 100, 900_000, 100_000);
    expect(s.obs).toHaveLength(1);
    expect(s.obs[0].dominant).toBe("long");
    expect(s.obs[0].purity).toBeCloseTo(0.9, 5);
    expect(s.obs[0].notional).toBe(1_000_000);
  });

  it("el enfriamiento impide contar el mismo suceso muchas veces", () => {
    let s = recordBurst(emptyStudy(), "BTCUSDT", T0, 100, 900_000, 100_000);
    // una cascada real dispara decenas de mensajes seguidos
    for (let i = 1; i <= 20; i++) {
      s = recordBurst(s, "BTCUSDT", T0 + i * 1000, 100, 900_000, 100_000);
    }
    expect(s.obs).toHaveLength(1);

    s = recordBurst(s, "BTCUSDT", T0 + COOLDOWN_MS + 1, 100, 900_000, 100_000);
    expect(s.obs).toHaveLength(2);
  });

  it("el enfriamiento es por símbolo, no global", () => {
    let s = recordBurst(emptyStudy(), "BTCUSDT", T0, 100, 900_000, 100_000);
    s = recordBurst(s, "ETHUSDT", T0 + 1000, 50, 900_000, 100_000);
    expect(s.obs).toHaveLength(2);
  });

  it("rechaza un precio imposible", () => {
    const s = emptyStudy();
    expect(recordBurst(s, "BTCUSDT", T0, 0, 900_000, 100_000)).toBe(s);
  });
});

describe("cierre de observaciones", () => {
  it("no cierra nada antes de que venza el horizonte", () => {
    const s = recordBurst(emptyStudy(), "BTCUSDT", T0, 100, 900_000, 100_000);
    const r = resolvePending(s, "BTCUSDT", velas(T0, 30, () => 110));
    expect(r).toBe(s);
    expect(r.obs[0].fwdPct).toBeUndefined();
  });

  it("mide el retorno crudo con su signo natural", () => {
    const s = recordBurst(emptyStudy(), "BTCUSDT", T0, 100, 900_000, 100_000);
    const n = HORIZON_MS / 60_000 + 5;
    const r = resolvePending(s, "BTCUSDT", velas(T0, n, (i) => (i * 60_000 >= HORIZON_MS ? 105 : 100)));
    expect(r.obs[0].fwdPct).toBeCloseTo(5, 5); // +5 %, sin invertir por el lado
  });

  it("no toca observaciones de otro símbolo", () => {
    const s = recordBurst(emptyStudy(), "ETHUSDT", T0, 100, 900_000, 100_000);
    const n = HORIZON_MS / 60_000 + 5;
    expect(resolvePending(s, "BTCUSDT", velas(T0, n, () => 105))).toBe(s);
  });

  it("una vez cerrada, no se reescribe", () => {
    const s = recordBurst(emptyStudy(), "BTCUSDT", T0, 100, 900_000, 100_000);
    const n = HORIZON_MS / 60_000 + 5;
    const a = resolvePending(s, "BTCUSDT", velas(T0, n, (i) => (i * 60_000 >= HORIZON_MS ? 105 : 100)));
    // llega más historial, con otro precio: el resultado ya está escrito
    const b = resolvePending(a, "BTCUSDT", velas(T0, n + 50, () => 999));
    expect(b.obs[0].fwdPct).toBeCloseTo(5, 5);
  });
});

describe("análisis", () => {
  // Separadas más allá de la ventana de agrupación: cada una es un suceso
  // independiente. Ponerlas juntas las convertiría en uno solo, que es
  // precisamente lo que comprueba el bloque "sucesos independientes".
  const PASO = EVENT_WINDOW_MS + 60_000;
  const cerrada = (i: number, dominant: "long" | "short", fwdPct: number): LiqObservation => ({
    id: `o${i}`, ts: T0 + i * PASO, symbol: "BTCUSDT", dominant,
    notional: 1e6, purity: 0.9, price: 100, fwdPct, resolvedTs: T0 + i * PASO + HORIZON_MS,
  });
  const study = (obs: LiqObservation[]): LiqStudy => ({ obs, lastBurst: {} });

  it("sin datos no finge un veredicto", () => {
    expect(analyze(emptyStudy()).verdict).toBe("SIN DATOS");
  });

  it("avisa de muestra corta en vez de opinar", () => {
    const r = analyze(study(Array.from({ length: 5 }, (_, i) => cerrada(i, "long", -1))));
    expect(r.verdict).toBe("MUESTRA CORTA");
    expect(r.momentum).not.toBeNull(); // las cifras se enseñan igual, con la advertencia
  });

  it("las dos hipótesis son espejo exacto la una de la otra", () => {
    const obs = Array.from({ length: 40 }, (_, i) => cerrada(i, i % 2 ? "long" : "short", i % 3 - 1));
    const r = analyze(study(obs));
    expect(r.momentum!.grossPct).toBeCloseTo(-r.reversal!.grossPct, 10);
    expect(r.momentum!.tStat).toBeCloseTo(-r.reversal!.tStat, 10);
  });

  it("detecta la continuación cuando existe de verdad", () => {
    // largos liquidados y el precio se hunde siempre: la continuación acierta
    const obs = Array.from({ length: 40 }, (_, i) => cerrada(i, "long", -2 - (i % 5) * 0.1));
    const r = analyze(study(obs));
    expect(r.momentum!.grossPct).toBeGreaterThan(2);
    expect(r.momentum!.hitRate).toBe(1);
    expect(r.verdict).toBe("VENTAJA");
  });

  it("una ventaja que no cubre el coste no es ventaja", () => {
    // +0,10 % constante: por debajo del 0,14 % de ida y vuelta
    const obs = Array.from({ length: 40 }, (_, i) => cerrada(i, "short", 0.1));
    const r = analyze(study(obs));
    expect(r.momentum!.grossPct).toBeCloseTo(0.1, 5);
    expect(r.momentum!.netPct).toBeLessThan(0);
    expect(r.verdict).toBe("SIN VENTAJA");
  });

  it("puro ruido no produce un veredicto favorable", () => {
    const obs = Array.from({ length: 60 }, (_, i) =>
      cerrada(i, i % 2 ? "long" : "short", Math.sin(i * 2.7) * 3)
    );
    expect(analyze(study(obs)).verdict).toBe("SIN VENTAJA");
  });

  it("cuenta aparte lo cerrado y lo pendiente", () => {
    const obs = [
      ...Array.from({ length: MIN_OBS }, (_, i) => cerrada(i, "long", -1)),
      { ...cerrada(99, "long", 0), fwdPct: undefined, resolvedTs: undefined },
    ];
    const r = analyze(study(obs));
    expect(r.resolved).toBe(MIN_OBS);
    expect(r.pending).toBe(1);
  });
});

describe("sucesos independientes", () => {
  /*
    Lo que esto vigila: el enfriamiento es POR SÍMBOLO, así que una cascada de
    mercado deja una fila por símbolo. Medido sobre las primeras observaciones
    reales, los símbolos de un mismo grupo iban al mismo lado el 86 % de las
    veces. Si se cuentan como independientes, la muestra se dobla y la
    significación se multiplica por raíz de dos — un falso positivo servido.
  */
  const en = (min: number, symbol = "BTCUSDT") => ({ ts: T0 + min * 60_000, symbol });

  it("agrupa lo simultáneo aunque sean símbolos distintos", () => {
    const g = clusterEvents([en(0, "BTCUSDT"), en(1, "ETHUSDT"), en(2, "SOLUSDT")]);
    expect(g).toHaveLength(1);
    expect(g[0]).toHaveLength(3);
  });

  it("separa lo que está lejos en el tiempo", () => {
    const lejos = EVENT_WINDOW_MS / 60_000 + 1;
    expect(clusterEvents([en(0), en(lejos), en(lejos * 2)])).toHaveLength(3);
  });

  it("mide desde el inicio del grupo, no en cadena", () => {
    // Sin esto, una racha de estallidos separados por 29 min encadenaría
    // horas enteras en un solo grupo y se perdería casi toda la muestra.
    const paso = EVENT_WINDOW_MS / 60_000 - 1;
    const g = clusterEvents([en(0), en(paso), en(paso * 2), en(paso * 3)]);
    expect(g.length).toBeGreaterThan(1);
  });

  it("no depende del orden de entrada", () => {
    const a = clusterEvents([en(0), en(1), en(200)]).map((g) => g.length);
    const b = clusterEvents([en(200), en(1), en(0)]).map((g) => g.length);
    expect(b).toEqual(a);
  });

  it("una cascada cuenta como UNA observación, no como tres", () => {
    // 30 cascadas de 3 símbolos = 90 filas, pero solo 30 sucesos.
    const obs: LiqObservation[] = [];
    for (let i = 0; i < 30; i++) {
      for (const sym of ["BTCUSDT", "ETHUSDT", "SOLUSDT"]) {
        obs.push({
          id: `${i}-${sym}`, ts: T0 + i * 3 * EVENT_WINDOW_MS, symbol: sym,
          dominant: "long", notional: 1e6, purity: 1, price: 100,
          fwdPct: -1.2, resolvedTs: T0,
        });
      }
    }
    const r = analyze({ obs, lastBurst: {} });
    expect(r.resolvedRaw).toBe(90);
    expect(r.resolved).toBe(30);
    expect(r.momentum!.n).toBe(30);
    expect(r.momentum!.rawN).toBe(90);
  });

  it("agrupar reduce la significación, no la aumenta", () => {
    // mismos datos, una vez juntos en cascadas y otra vez bien separados
    const mk = (i: number, sym: string, ts: number): LiqObservation => ({
      id: `${i}-${sym}`, ts, symbol: sym, dominant: "long", notional: 1e6,
      purity: 1, price: 100, fwdPct: -1 - (i % 4) * 0.1, resolvedTs: ts,
    });
    const juntas: LiqObservation[] = [];
    const sueltas: LiqObservation[] = [];
    let k = 0;
    for (let i = 0; i < 30; i++) {
      for (const sym of ["BTCUSDT", "ETHUSDT", "SOLUSDT"]) {
        juntas.push(mk(i, sym, T0 + i * 3 * EVENT_WINDOW_MS));
        sueltas.push(mk(i, sym, T0 + k++ * 3 * EVENT_WINDOW_MS));
      }
    }
    const a = analyze({ obs: juntas, lastBurst: {} });
    const b = analyze({ obs: sueltas, lastBurst: {} });
    expect(a.resolved).toBe(30);
    expect(b.resolved).toBe(90);
    // la t crece con la raíz de n: separadas dan una t mayor con los mismos datos
    expect(Math.abs(b.momentum!.tStat)).toBeGreaterThan(Math.abs(a.momentum!.tStat));
  });

  it("el umbral se aplica a sucesos, no a filas", () => {
    // 87 filas pero solo 29 sucesos: todavía no hay muestra
    const obs: LiqObservation[] = [];
    for (let i = 0; i < 29; i++) {
      for (const sym of ["BTCUSDT", "ETHUSDT", "SOLUSDT"]) {
        obs.push({
          id: `${i}-${sym}`, ts: T0 + i * 3 * EVENT_WINDOW_MS, symbol: sym,
          dominant: "long", notional: 1e6, purity: 1, price: 100,
          fwdPct: -3, resolvedTs: T0,
        });
      }
    }
    const r = analyze({ obs, lastBurst: {} });
    expect(r.resolvedRaw).toBe(87);
    expect(r.verdict).toBe("MUESTRA CORTA");
    expect(r.note).toContain("87 filas");
  });
});
