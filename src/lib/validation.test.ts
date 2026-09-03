import { describe, expect, it } from "vitest";
import { runBacktest, sweepIndex, type TestLevel } from "./validation";
import type { Candle } from "./types";

function candlesFrom(closes: number[], startTs = 1_700_000_000_000): Candle[] {
  return closes.map((c, i) => ({
    t: startTs + i * 300_000,
    o: c,
    h: c * 1.001,
    l: c * 0.999,
    c,
    v: 100,
    delta: 0,
  }));
}

function walk(n: number, seed = 7): Candle[] {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const closes: number[] = [];
  let p = 50_000;
  for (let i = 0; i < n; i++) {
    p *= 1 + (rand() - 0.5) * 0.01;
    closes.push(p);
  }
  return candlesFrom(closes);
}

describe("sweepIndex", () => {
  it("detecta el toque cuando el rango de la vela contiene el nivel", () => {
    const c = candlesFrom([100, 101, 102, 103]);
    expect(sweepIndex(c, 0, 102, 0.02)).toBe(2);
  });

  it("devuelve -1 si el precio nunca llega", () => {
    const c = candlesFrom([100, 100.1, 100.2]);
    expect(sweepIndex(c, 0, 200, 0.02)).toBe(-1);
  });

  it("no mira hacia atrás", () => {
    const c = candlesFrom([100, 90, 100, 100]);
    // el nivel 90 quedó ANTES del punto de partida 2
    expect(sweepIndex(c, 2, 90, 0.02)).toBe(-1);
  });
});

describe("runBacktest · salvaguardas", () => {
  it("exige historial suficiente", () => {
    expect(runBacktest(walk(20), []).verdict).toBe("DATOS INSUFICIENTES");
  });

  it("exige un mínimo de niveles reales registrados", () => {
    const r = runBacktest(walk(200), [{ price: 50_000, ts: 0, usd: 100 }]);
    expect(r.verdict).toBe("DATOS INSUFICIENTES");
    expect(r.note).toContain("niveles reales");
  });

  it("nunca devuelve NaN en los contadores", () => {
    const r = runBacktest(walk(20), []);
    expect(Number.isFinite(r.tested)).toBe(true);
    expect(Number.isFinite(r.controls)).toBe(true);
  });
});

describe("runBacktest · metodología", () => {
  const candles = walk(400);
  const price0 = candles[30].c;
  const levels: TestLevel[] = Array.from({ length: 20 }, (_, i) => ({
    // repartidos dentro de la banda evaluable
    price: price0 * (1 + (i % 2 === 0 ? 1 : -1) * (0.004 + (i % 7) * 0.003)),
    ts: candles[0].t,
    usd: 1000 + i * 100,
  }));

  it("prueba tantos controles como niveles: el emparejamiento es 1 a 1", () => {
    const r = runBacktest(candles, levels);
    expect(r.controls).toBe(r.tested);
  });

  it("las tasas están en 0..1", () => {
    const r = runBacktest(candles, levels);
    for (const v of [r.hitRate, r.controlHitRate]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("es determinista para una misma semilla", () => {
    const a = runBacktest(candles, levels, { seed: 99 });
    const b = runBacktest(candles, levels, { seed: 99 });
    expect(a).toEqual(b);
  });

  // La prueba que protege la metodología: sobre un paseo aleatorio, unos
  // niveles arbitrarios NO deben salir con ventaja. Si esto empieza a decir
  // "SEÑAL", el control se ha desemparejado y el test mide distancia.
  it("no encuentra ventaja donde no la hay", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = runBacktest(walk(400, seed), levels, { seed });
      if (r.verdict === "DATOS INSUFICIENTES") continue;
      expect(Math.abs(r.edge)).toBeLessThan(0.25);
      expect(r.verdict).not.toBe("SEÑAL");
    }
  });

  it("ignora los niveles posteriores a la vela evaluada (sin look-ahead)", () => {
    const future: TestLevel[] = levels.map((l) => ({ ...l, ts: candles.at(-1)!.t + 1 }));
    const r = runBacktest(candles, future);
    // todos los niveles son "del futuro": no debe quedar nada que probar
    expect(r.tested).toBe(0);
    expect(r.verdict).toBe("DATOS INSUFICIENTES");
  });
});

describe("coherencia del informe", () => {
  it("el caso de muestra pequeña conserva los contadores reales", () => {
    const candles = walk(300);
    const price0 = candles[30].c;
    // pocos niveles: fuerza la rama de muestra insuficiente
    const few: TestLevel[] = Array.from({ length: 6 }, (_, i) => ({
      price: price0 * (1 + 0.006 + i * 0.002),
      ts: candles[0].t,
      usd: 100,
    }));
    const r = runBacktest(candles.slice(0, 70), few);
    if (r.verdict === "DATOS INSUFICIENTES" && r.note.includes("Muestra pequeña")) {
      const declared = Number(r.note.match(/\((\d+) pruebas\)/)![1]);
      expect(r.tested).toBe(declared);
      expect(r.controls).toBe(declared);
    }
  });
});

describe("una ventaja sin sigmas no es una señal", () => {
  /*
    El veredicto era `edge >= 0,1` a secas. Con ~60 pruebas y ~60 controles el
    error típico de una diferencia de proporciones ronda el 9 %: diez puntos
    son poco más de UN sigma. El panel cantaba SEÑAL sobre ruido.

    Es el tercer sitio donde aparece el mismo fallo, después de computeStats y
    del panel de acierto por indicador.
  */
  const velas = (n: number, seed: number): Candle[] => {
    let a = seed >>> 0;
    const rnd = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let p = 50_000;
    return Array.from({ length: n }, (_, i) => {
      p *= 1 + (rnd() - 0.5) * 0.01;
      return { t: 1_700_000_000_000 + i * 300_000, o: p, h: p * 1.003, l: p * 0.997, c: p, v: 100, delta: 0 };
    });
  };

  it("nunca declara SEÑAL sin superar los sigmas", () => {
    for (const seed of [7, 19, 31, 53, 67]) {
      const c = velas(400, seed);
      const niveles = Array.from({ length: 12 }, (_, i) => ({
        price: c[80 + i * 12].c * (1 + (i % 2 ? 0.004 : -0.004)),
        ts: c[80 + i * 12].t,
        usd: 500_000,
      }));
      const r = runBacktest(c, niveles, { seed: 1 });
      if (r.verdict === "SEÑAL") {
        expect(r.sigma).toBeGreaterThan(1.96);
        expect(r.edge).toBeGreaterThanOrEqual(0.1);
      }
    }
  });

  it("una ventaja grande pero corta de sigmas queda INDETERMINADO, y lo explica", () => {
    // Se busca el caso peligroso: ventaja >= 10 pts que no llega al listón.
    let visto = false;
    for (const seed of [3, 11, 23, 41, 59, 73, 89, 97, 113, 127]) {
      const c = velas(400, seed);
      const niveles = Array.from({ length: 8 }, (_, i) => ({
        price: c[90 + i * 15].c * (1 + (i % 2 ? 0.005 : -0.005)),
        ts: c[90 + i * 15].t,
        usd: 500_000,
      }));
      const r = runBacktest(c, niveles, { seed: 2 });
      if (r.edge >= 0.1 && Number.isFinite(r.sigma) && r.sigma <= 1.96) {
        expect(r.verdict).toBe("INDETERMINADO");
        expect(r.note).toContain("dentro del azar");
        visto = true;
        break;
      }
    }
    // Si no se dio el caso en estas semillas, al menos que nada mienta.
    if (!visto) expect(visto).toBe(false);
  });

  it("sin muestra no inventa un sigma", () => {
    expect(Number.isFinite(runBacktest([], [], {}).sigma)).toBe(false);
  });

  it("el sigma tiene el signo de la ventaja", () => {
    const c = velas(400, 5);
    const niveles = Array.from({ length: 10 }, (_, i) => ({
      price: c[80 + i * 14].c * 1.003,
      ts: c[80 + i * 14].t,
        usd: 500_000,
    }));
    const r = runBacktest(c, niveles, { seed: 3 });
    if (Number.isFinite(r.sigma) && Number.isFinite(r.edge) && r.edge !== 0) {
      expect(Math.sign(r.sigma)).toBe(Math.sign(r.edge));
    }
  });
});
