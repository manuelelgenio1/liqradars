import { describe, expect, it } from "vitest";
import { FINDINGS, summarize, VERDICT_LABEL, type Verdict } from "./findings";

/*
  El expediente es parte del producto, así que se comprueba como el resto.

  Lo que estas pruebas vigilan no es la redacción sino la HONESTIDAD
  estructural: que no se declare descartada una hipótesis sin decir la
  muestra, que "abierta" y "descartada" no se confundan, y que el resumen
  cuadre. Un expediente que se contradice a sí mismo es peor que no tenerlo.
*/

describe("integridad del expediente", () => {
  it("no hay identificadores repetidos", () => {
    const ids = FINDINGS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("cada entrada dice qué se probó, con qué muestra y qué salió", () => {
    for (const f of FINDINGS) {
      expect(f.hypothesis.length).toBeGreaterThan(15);
      expect(f.sample.length).toBeGreaterThan(5);
      expect(f.numbers.length).toBeGreaterThan(5);
      expect(f.meaning.length).toBeGreaterThan(30);
    }
  });

  it("todos los veredictos tienen etiqueta", () => {
    for (const f of FINDINGS) {
      expect(VERDICT_LABEL[f.verdict]).toBeTruthy();
    }
  });

  it("el resumen cuadra con las entradas", () => {
    const s = summarize();
    expect(s.total).toBe(FINDINGS.length);
    expect(s.descartadas + s.noOperables + s.abiertas + s.enPie).toBe(s.total);
  });
});

describe("distinciones que no se pueden perder", () => {
  /*
    "Muestra corta" y "no hay efecto" son cosas distintas, y confundirlas es
    el error que este proyecto ha cometido y corregido varias veces. Una
    hipótesis solo se declara DESCARTADA cuando había potencia para ver el
    efecto; si no, queda ABIERTA.
  */
  it("las abiertas explican por qué no se pudo concluir", () => {
    for (const f of FINDINGS.filter((x) => x.verdict === "abierta")) {
      const texto = `${f.sample} ${f.numbers} ${f.meaning}`.toLowerCase();
      const explica = /falta|harían falta|no se pudo|no sirve|no publica|sin muestra|no confirma/.test(texto);
      expect(explica, `"${f.id}" está abierta y no explica por qué`).toBe(true);
    }
  });

  it("una descartada nunca se justifica con muestra corta", () => {
    // Si se descarta algo diciendo "faltan datos", el veredicto está mal
    // puesto: eso es una hipótesis abierta.
    for (const f of FINDINGS.filter((x) => x.verdict === "descartada")) {
      expect(f.meaning.toLowerCase(), `"${f.id}"`).not.toMatch(/muestra corta|harían falta más/);
    }
  });

  it("la tesis que da nombre a la app está en el expediente", () => {
    // Si algún día alguien la borra, que salte una prueba.
    const iman = FINDINGS.find((f) => f.id === "iman");
    expect(iman).toBeDefined();
    expect(iman!.verdict).toBe("descartada");
  });

  it("lo que sigue en pie dice dónde se midió", () => {
    // Un hallazgo de otro exchange presentado sin decirlo sería engañoso.
    for (const f of FINDINGS.filter((x) => x.verdict === "en-pie")) {
      expect(f.venue, `"${f.id}" sigue en pie y no dice el mercado`).toBeTruthy();
    }
  });

  it("no se declara nada rentable: ninguna es 'en pie' Y de dirección", () => {
    // Lo único que sobrevive mide volatilidad, no dirección. Si algún día
    // apareciera una de dirección en pie, tendría que superar esta prueba a
    // conciencia — está aquí para obligar a pensarlo.
    for (const f of FINDINGS.filter((x) => x.verdict === "en-pie")) {
      expect(f.meaning.toLowerCase()).toMatch(/no dice dirección|no gana dinero|volatilidad/);
    }
  });
});

describe("el balance real", () => {
  it("hay más descartes que hallazgos, y eso es el resultado", () => {
    const s = summarize();
    expect(s.descartadas + s.noOperables).toBeGreaterThan(s.enPie);
  });

  it("los veredictos son solo los cuatro previstos", () => {
    const validos: Verdict[] = ["descartada", "no-operable", "abierta", "en-pie"];
    for (const f of FINDINGS) expect(validos).toContain(f.verdict);
  });
});
