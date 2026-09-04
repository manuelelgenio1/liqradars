import { describe, expect, it } from "vitest";
import { FINDINGS } from "./findings";
import { CITED_IDS, COLOR_TONO, findingsFor, TF_KEYS, verdictFor } from "./tfverdict";
import { DESK_TFS } from "../hooks/useTradingDesk";

/*
  Estas pruebas vigilan la costura entre las dos mitades del producto: lo que
  se midió y lo que se enseña. Una etiqueta en pantalla que afirma algo sin
  respaldo en el expediente es peor que no poner etiqueta — parece rigor y no
  lo es.
*/

describe("las etiquetas citan hallazgos que existen", () => {
  it("todos los identificadores citados están en el expediente", () => {
    const ids = new Set(FINDINGS.map((f) => f.id));
    for (const id of CITED_IDS) {
      expect(ids.has(id), `la etiqueta cita "${id}" y no está en el expediente`).toBe(true);
    }
  });

  it("los marcos descartados citan al menos un hallazgo", () => {
    // Decir "sin ventaja" sin poder señalar dónde se midió sería una opinión.
    for (const key of TF_KEYS) {
      const v = verdictFor(key)!;
      if (v.tone !== "descartado") continue;
      expect(v.findings.length, `"${key}" dice sin ventaja y no cita nada`).toBeGreaterThan(0);
      expect(findingsFor(key).length).toBe(v.findings.length);
    }
  });

  it("lo que se marca descartado está descartado en el expediente", () => {
    for (const key of TF_KEYS) {
      const v = verdictFor(key)!;
      if (v.tone !== "descartado") continue;
      const hallazgos = findingsFor(key);
      // Basta con que el hallazgo PRINCIPAL —el primero— lo esté: los demás
      // acompañan. Si el principal pasara a "abierta", la etiqueta miente.
      expect(hallazgos[0].verdict, `"${key}" cita "${hallazgos[0].id}"`).toBe("descartada");
    }
  });

  it("lo que se marca en medición sigue abierto en el expediente", () => {
    for (const key of TF_KEYS) {
      const v = verdictFor(key)!;
      if (v.tone !== "midiendo") continue;
      const hallazgos = findingsFor(key);
      expect(hallazgos.length).toBeGreaterThan(0);
      expect(hallazgos[0].verdict, `"${key}" cita "${hallazgos[0].id}"`).toBe("abierta");
    }
  });

  it("lo que se marca sin medir no cita nada", () => {
    // Si algún día se mide, hay que cambiar la etiqueta a la vez.
    for (const key of TF_KEYS) {
      const v = verdictFor(key)!;
      if (v.tone !== "sin-medir") continue;
      expect(v.findings, `"${key}" dice sin medir y cita hallazgos`).toEqual([]);
    }
  });
});

describe("cobertura y forma", () => {
  it("cada temporalidad de la mesa tiene su etiqueta", () => {
    // Si mañana se añade un marco a la mesa, esta prueba obliga a decidir qué
    // se sabe de él antes de enseñarlo.
    for (const k of DESK_TFS) {
      expect(verdictFor(k), `falta la etiqueta de "${k}"`).not.toBeNull();
    }
  });

  it("un marco desconocido no inventa veredicto", () => {
    expect(verdictFor("3s")).toBeNull();
    expect(findingsFor("3s")).toEqual([]);
  });

  it("las etiquetas son cortas y las explicaciones no", () => {
    for (const key of TF_KEYS) {
      const v = verdictFor(key)!;
      expect(v.short.length).toBeLessThanOrEqual(14);
      expect(v.detail.length).toBeGreaterThan(60);
      expect(COLOR_TONO[v.tone]).toBeTruthy();
    }
  });
});
