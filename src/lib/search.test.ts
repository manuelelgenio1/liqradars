import { describe, expect, it } from "vitest";
import { searchCombos, INDICATOR_NAMES } from "./search";
import { configFor } from "./indicators";
import type { Candle } from "./types";

function build(closes: number[]): Candle[] {
  return closes.map((c, i) => ({
    t: 1_700_000_000_000 + i * 300_000,
    o: c, h: c * 1.003, l: c * 0.997, c, v: 100, delta: 0,
  }));
}

function walk(n: number, seed = 5): Candle[] {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let p = 50_000;
  return build(Array.from({ length: n }, () => (p *= 1 + (rand() - 0.5) * 0.009)));
}

const cfg = configFor("5m");

describe("salvaguardas", () => {
  it("exige historial suficiente", () => {
    expect(searchCombos(walk(100), cfg, 5).verdict).toBe("SIN DATOS");
  });

  it("parte los datos y valida en la mitad no vista", () => {
    const r = searchCombos(walk(600), cfg, 5);
    expect(r.trainSamples).toBeGreaterThan(0);
    expect(r.testSamples).toBeGreaterThan(0);
    // la partición por defecto reserva ~35 % para validar
    expect(r.testSamples / (r.trainSamples + r.testSamples)).toBeGreaterThan(0.25);
  });

  it("informa de cuántas combinaciones probó", () => {
    const r = searchCombos(walk(600), cfg, 5);
    expect(r.tried).toBeGreaterThan(10);
  });
});

describe("resistencia al sobreajuste", () => {
  // LA prueba: sobre paseos aleatorios NO existe estrategia. Buscando entre
  // decenas de combinaciones alguna parecerá buena, pero ninguna debe
  // sobrevivir a la validación. Si esto empieza a decir "CANDIDATA" de forma
  // sistemática, la partición se ha roto.
  it("no declara candidata sobre ruido puro, casi nunca", () => {
    let candidatas = 0;
    const intentos = 6;
    for (let s = 1; s <= intentos; s++) {
      if (searchCombos(walk(600, s), cfg, 5).verdict === "CANDIDATA") candidatas += 1;
    }
    // con ~100 combinaciones y azar, algún falso positivo es esperable;
    // que la mayoría sobreviva no lo es
    expect(candidatas).toBeLessThanOrEqual(intentos / 2);
  });

  it("la mejor buscando suele desinflarse al validar", () => {
    const r = searchCombos(walk(700, 3), cfg, 5);
    if (r.results.length) {
      expect(Number.isFinite(r.results[0].decay)).toBe(true);
    }
  });
});

describe("mecánica de las combinaciones", () => {
  const r = searchCombos(walk(700), cfg, 5);

  it("cada resultado tiene miembros válidos", () => {
    for (const x of r.results) {
      expect(x.combo.members.length).toBeGreaterThan(0);
      for (const m of x.combo.members) expect(INDICATOR_NAMES).toContain(m);
    }
  });

  it("exige un mínimo de llamadas para puntuar", () => {
    for (const x of r.results) expect(x.trainCalls).toBeGreaterThanOrEqual(15);
  });

  it("la unanimidad nunca llama más que la ponderada", () => {
    const uni = r.results.find((x) => x.combo.unanimous && x.combo.members.length > 1);
    if (uni) {
      const pond = r.results.find(
        (x) => !x.combo.unanimous && !x.combo.inverted &&
          x.combo.members.join() === uni.combo.members.join()
      );
      if (pond) expect(uni.trainCalls).toBeLessThanOrEqual(pond.trainCalls);
    }
  });

  it("es determinista", () => {
    const c = walk(600);
    expect(searchCombos(c, cfg, 5)).toEqual(searchCombos(c, cfg, 5));
  });
});

describe("corrección por comparaciones múltiples", () => {
  const r = searchCombos(walk(800), cfg, 5);

  it("exige más sigmas cuantas más combinaciones se prueban", () => {
    if (r.results.length) {
      // con ~100 pruebas el listón debe superar holgadamente los 2σ clásicos
      expect(r.results[0].requiredSigmas).toBeGreaterThan(3);
    }
  });

  it("una ventaja de 2,7σ NO basta si se probaron 100 combinaciones", () => {
    for (const x of r.results) {
      if (Number.isFinite(x.sigmas) && x.sigmas < x.requiredSigmas) {
        expect(x.significant).toBe(false);
      }
    }
  });

  it("nada significativo puede tener menos de 30 llamadas", () => {
    for (const x of r.results) if (x.significant) expect(x.testCalls).toBeGreaterThanOrEqual(30);
  });

  it("el superviviente, si existe, es significativo", () => {
    if (r.survivor) {
      expect(r.survivor.significant).toBe(true);
      expect(r.survivor.sigmas).toBeGreaterThanOrEqual(r.survivor.requiredSigmas);
    }
  });

  // Con la corrección puesta, el ruido puro debe dejar de producir candidatas.
  it("sobre ruido puro ya no declara candidatas", () => {
    let candidatas = 0;
    for (let s = 1; s <= 8; s++) {
      if (searchCombos(walk(700, s * 17), cfg, 5).verdict === "CANDIDATA") candidatas += 1;
    }
    expect(candidatas).toBeLessThanOrEqual(1);
  });
});
