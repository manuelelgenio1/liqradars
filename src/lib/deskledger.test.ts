import { describe, expect, it } from "vitest";
import { append, momentMeans, MOMENT_MS, resolve, stats, statsByTimeframe, MIN_SAMPLE, type LedgerEntry } from "./deskledger";
import type { DeskSignal } from "./desksignals";
import type { Candle } from "./types";

const T = 1_800_000_000_000;

/** Larga desde 100: stop 98, objetivo 104. Riesgo 2, premio 4. */
const sig = (over: Partial<DeskSignal> = {}): DeskSignal => ({
  id: "d1", symbol: "BTCUSDT", timeframe: "1H", tfMinutes: 60, side: "long",
  bornAt: T, entry: 100, stop: 98, target: 104, strength: 0.7, controlSide: "long", ...over,
});

/** Velas posteriores al nacimiento, con máximo y mínimo explícitos. */
const velas = (filas: [number, number][], desde = T + 1000): Candle[] =>
  filas.map(([h, l], i) => ({ t: desde + i * 1000, o: (h + l) / 2, h, l, c: (h + l) / 2, v: 1, delta: 0 }));

describe("resolución contra velas reales", () => {
  it("sin velas posteriores no se cierra nada", () => {
    expect(resolve(sig(), [])).toBeNull();
    // velas ANTERIORES al nacimiento no cuentan
    expect(resolve(sig(), velas([[105, 95]], T - 10_000))).toBeNull();
  });

  it("tocar el objetivo es ganada, con la R de diseño", () => {
    const e = resolve(sig(), velas([[101, 99.5], [104.5, 103]]))!;
    expect(e.outcome).toBe("ganada");
    expect(e.r).toBeCloseTo(2, 8); // premio 4 / riesgo 2
  });

  it("tocar el stop es perdida de exactamente 1R", () => {
    const e = resolve(sig(), velas([[101, 97.5]]))!;
    expect(e.outcome).toBe("perdida");
    expect(e.r).toBe(-1);
  });

  it("en corto los lados se invierten", () => {
    const s = sig({ side: "short", stop: 102, target: 96 });
    expect(resolve(s, velas([[102.5, 101]]))!.outcome).toBe("perdida");
    expect(resolve(s, velas([[99, 95.5]]))!.outcome).toBe("ganada");
  });

  it("una vela con stop Y objetivo cuenta como pérdida, y se marca", () => {
    /*
      No se sabe cuál se tocó primero dentro de la vela. Suponer que ganó
      inflaría el resultado; suponer que perdió es conservador y honesto.
    */
    const e = resolve(sig(), velas([[105, 97]]))!;
    expect(e.outcome).toBe("perdida");
    expect(e.ambiguous).toBe(true);
    expect(e.r).toBe(-1);
  });
});

describe("el control se resuelve en las mismas condiciones", () => {
  it("una vela que no toca ningún nivel deja la señal viva", () => {
    // h=102,5 y l=101 no alcanzan ni el stop (98) ni el objetivo (104)
    expect(resolve(sig(), velas([[102.5, 101]]))).toBeNull();
  });

  it("el control corto usa las mismas distancias, al otro lado", () => {
    // control corto desde 100: stop 2 ARRIBA (102), objetivo 4 abajo (96)
    const e = resolve(sig({ controlSide: "short" }), velas([[97.5, 95.5]]))!;
    expect(e.outcome).toBe("perdida"); // a la larga le saltó el stop en 98
    expect(e.controlR).toBeCloseTo(2, 8); // y el corto llegó a su objetivo
  });

  it("un control del MISMO lado replica el resultado", () => {
    const e = resolve(sig({ controlSide: "long" }), velas([[104.5, 103]]))!;
    expect(e.outcome).toBe("ganada");
    expect(e.controlR).toBeCloseTo(e.r, 8);
  });

  it("PROPIEDAD ESTRUCTURAL: si la larga gana, el control corto pierde", () => {
    /*
      No es casualidad ni un fallo: comparten las mismas velas. Para que una
      larga alcance su objetivo en 104, el precio tiene que pasar por 102, que
      es donde está el stop del control corto.

      Conviene tenerlo presente al leer las cuentas: el control NO es una
      muestra independiente, es la misma película vista del revés. Sirve para
      lo que sirve —saber qué daban esos niveles por azar— y no para más.
    */
    const e = resolve(sig({ controlSide: "short" }), velas([[104.5, 103]]))!;
    expect(e.outcome).toBe("ganada");
    expect(e.controlR).toBe(-1);
  });
});

describe("el neto siempre descuenta la comisión", () => {
  it("queda por debajo del bruto, gane o pierda", () => {
    const gana = resolve(sig(), velas([[104.5, 103]]))!;
    const pierde = resolve(sig(), velas([[101, 97.5]]))!;
    expect(gana.rNet).toBeLessThan(gana.r);
    expect(pierde.rNet).toBeLessThan(pierde.r);
    expect(gana.costR).toBeGreaterThan(0);
  });

  it("un stop estrecho encarece la señal en R", () => {
    const ancho = resolve(sig(), velas([[104.5, 103]]))!;
    const estrecho = resolve(sig({ stop: 99.9, target: 100.2 }), velas([[100.3, 100]]))!;
    expect(estrecho.costR).toBeGreaterThan(ancho.costR * 10);
  });
});

// ---------------- libro ----------------

/*
  Cada apunte nace en un MINUTO distinto a propósito: así cuenta como un suceso
  independiente. Las pruebas de agrupación de más abajo hacen justo lo
  contrario para comprobar que se detecta.
*/
const cerrada = (i: number, r: number, ctrl: number | null = 0, tf = "1H"): LedgerEntry => ({
  id: `e${i}`, symbol: "BTCUSDT", timeframe: tf, side: "long",
  bornAt: T + i * MOMENT_MS, resolvedAt: T + i * MOMENT_MS + 1000, entry: 100, stop: 98, target: 104,
  outcome: r > 0 ? "ganada" : "perdida", r, rNet: r - 0.07, costR: 0.07,
  ambiguous: false, controlSide: "long", controlR: ctrl,
});

describe("el libro no duplica", () => {
  it("añade solo lo que no estaba", () => {
    const a = [cerrada(1, 2)];
    const b = append(a, [cerrada(1, 2), cerrada(2, -1)]);
    expect(b).toHaveLength(2);
  });

  it("devuelve la MISMA referencia si no hay nada nuevo", () => {
    // Evita renders inútiles cada vez que se recalcula.
    const a = [cerrada(1, 2)];
    expect(append(a, [cerrada(1, 2)])).toBe(a);
  });

  it("mantiene el orden por fecha de cierre, lo más reciente primero", () => {
    const b = append([], [cerrada(1, 1), cerrada(9, 1), cerrada(5, 1)]);
    expect(b.map((e) => e.id)).toEqual(["e9", "e5", "e1"]);
  });
});

describe("cuentas", () => {
  it("sin datos no finge un veredicto", () => {
    expect(stats([]).verdict).toBe("SIN DATOS");
  });

  it("avisa de muestra corta en vez de opinar", () => {
    expect(stats([cerrada(1, 2), cerrada(2, -1)]).verdict).toBe("MUESTRA CORTA");
  });

  it("una ventaja bruta que la comisión se come acaba en PIERDE", () => {
    // +0,05R bruto con 0,07R de coste: gana en bruto, pierde en neto
    const es = Array.from({ length: 25 }, (_, i) => ({ ...cerrada(i, 0.2), rNet: 0.2 - 0.5, costR: 0.5 }));
    const s = stats(es);
    expect(s.expectancy).toBeGreaterThan(0);
    expect(s.expectancyNet).toBeLessThan(0);
    expect(s.verdict).toBe("PIERDE");
  });

  it("una ventaja dentro del ruido NO es ventaja", () => {
    // media positiva pero muy dispersa: la t no llega
    const es = Array.from({ length: 30 }, (_, i) => cerrada(i, i % 2 ? 2.4 : -1.6, -1));
    const s = stats(es);
    expect(s.expectancyNet).toBeGreaterThan(0);
    expect(s.tStat).toBeLessThan(2);
    expect(s.verdict).toBe("SIN VENTAJA");
  });

  it("cuenta ambiguas y expiradas por separado", () => {
    const es = [
      { ...cerrada(1, -1), ambiguous: true },
      { ...cerrada(2, 0.3), outcome: "expirada" as const },
      cerrada(3, 2),
    ];
    const s = stats(es);
    expect(s.ambiguous).toBe(1);
    expect(s.expired).toBe(1);
    expect(s.wins).toBe(1);
  });

  it("el desglose por temporalidad separa lo que el total escondería", () => {
    /*
      En 5m la comisión se lleva medio R y en diario dos centésimas. Una sola
      cifra global taparía justo lo que más decide.
    */
    const es = [
      ...Array.from({ length: 5 }, (_, i) => cerrada(i, 1, 0, "5m")),
      ...Array.from({ length: 3 }, (_, i) => cerrada(100 + i, 1, 0, "1D")),
    ];
    const por = statsByTimeframe(es);
    expect(por.map((x) => x.timeframe)).toEqual(["5m", "1D"]); // ordenado por muestra
    expect(por[0].stats.total).toBe(5);
    expect(por[1].stats.total).toBe(3);
  });

  it("el mínimo de muestra es coherente", () => {
    expect(MIN_SAMPLE).toBeGreaterThanOrEqual(20);
  });
});

describe("veinte pares no son veinte pruebas", () => {
  /*
    La mesa vigila 20 pares y el consenso suele girar en casi todos a la vez,
    porque las cripto se mueven juntas. Contar cada señal como una prueba
    independiente inflaría la t por √n y haría cantar VENTAJA donde solo hay un
    mercado moviéndose entero.

    Es el mismo error que ya salió contando cascadas de liquidaciones: una
    cascada que toca 15 pares es UN suceso, no quince.
  */
  const aLaVez = (n: number, r: number, t = T): LedgerEntry[] =>
    Array.from({ length: n }, (_, i) => ({
      ...cerrada(i, r),
      id: `sim${t}-${i}`,
      symbol: `PAR${i}USDT`,
      bornAt: t,
      resolvedAt: t + 1000,
    }));

  it("señales nacidas en el mismo instante son UN suceso", () => {
    expect(momentMeans(aLaVez(20, 1))).toHaveLength(1);
  });

  it("dentro de un suceso se promedia, no se suma", () => {
    const mezcla = [...aLaVez(1, 2), ...aLaVez(1, 0).map((e) => ({ ...e, id: "otro", rNet: 0 }))];
    expect(momentMeans(mezcla)[0]).toBeCloseTo((2 - 0.07 + 0) / 2, 8);
  });

  it("nacidas en minutos distintos son sucesos distintos", () => {
    const dos = [...aLaVez(5, 1, T), ...aLaVez(5, 1, T + MOMENT_MS)];
    expect(momentMeans(dos)).toHaveLength(2);
  });

  it("LA REGRESIÓN: 120 señales de un solo giro NO son muestra", () => {
    /*
      Sin agrupar, esto daría 120 filas, superaría el mínimo de 20 y emitiría
      un veredicto. Es exactamente la trampa que este proyecto lleva evitando
      desde el principio.
    */
    const s = stats(aLaVez(120, 2));
    expect(s.total).toBe(120);
    expect(s.moments).toBe(1);
    expect(s.verdict).toBe("MUESTRA CORTA");
    expect(s.note).toContain("mismo giro de mercado");
  });

  it("la t se calcula sobre sucesos: agrupar la BAJA", () => {
    /*
      Los MISMOS resultados y la MISMA media, cambiando solo cuándo nacieron.
      Repartidos hay 30 observaciones; amontonados en 3 giros, solo tres. La
      media no se mueve; lo que se desploma es la confianza, que es justo lo
      que debe pasar.
    */
    const repartidas = Array.from({ length: 30 }, (_, i) => cerrada(i, i * 0.1 - 1.0));
    // en bloques de diez consecutivos, para que los grupos no salgan idénticos
    const amontonadas = repartidas.map((e, i) => ({ ...e, bornAt: T + Math.floor(i / 10) * MOMENT_MS }));

    expect(stats(repartidas).expectancyNet).toBeCloseTo(stats(amontonadas).expectancyNet, 8);
    expect(stats(repartidas).moments).toBe(30);
    expect(stats(amontonadas).moments).toBe(3);
    expect(Math.abs(stats(amontonadas).tStat)).toBeLessThan(Math.abs(stats(repartidas).tStat));
  });

  it("el porcentaje de aciertos sigue contando SEÑALES, no sucesos", () => {
    // Para "de cada cien entradas, cuántas ganan" la unidad correcta es la
    // señal. La agrupación es para juzgar significancia, no para contar.
    expect(stats(aLaVez(120, 2)).total).toBe(120);
    expect(stats(aLaVez(120, 2)).hitRate).toBe(1);
  });
});

describe("seis marcos son seis pruebas, no una", () => {
  /*
    El desglose por temporalidad emite un veredicto por cada marco sobre los
    mismos datos. Con el listón de t>2 en todos, que alguno cruce por azar deja
    de ser improbable — la misma trampa que este proyecto lleva evitando desde
    el principio, y sería ridículo caer en ella justo en el panel que existe
    para no caer.
  */
  const serie = (n: number, tf: string, r: (i: number) => number) =>
    Array.from({ length: n }, (_, i) => ({ ...cerrada(i, r(i), -1, tf), id: `${tf}-${i}` }));

  it("el listón global es 2; con seis marcos sube", () => {
    expect(stats(serie(25, "1H", () => 1)).requiredT).toBe(2);
    const seis = ["5m", "30m", "1H", "4H", "1D", "1W"].flatMap((tf) => serie(25, tf, () => 1));
    for (const g of statsByTimeframe(seis)) expect(g.stats.requiredT).toBeCloseTo(2.64, 2);
  });

  it("con un solo marco no se castiga: no hay comparación múltiple", () => {
    const uno = statsByTimeframe(serie(25, "1H", () => 1));
    expect(uno[0].stats.requiredT).toBeCloseTo(1.96, 2);
  });

  it("una t que basta sola puede NO bastar entre seis", () => {
    // t≈2,53: cruza el listón global de 2 y se queda corta ante el corregido
    const ruidosa = (i: number) => (i % 5 === 0 ? -0.9 : 0.62);
    const datos = serie(40, "1H", ruidosa);
    const suelta = stats(datos);
    expect(suelta.tStat).toBeGreaterThan(2);
    expect(suelta.tStat).toBeLessThan(2.64);

    // el MISMO dato: veredicto opuesto según se juzgue solo o entre seis
    expect(suelta.verdict).toBe("VENTAJA");
    expect(stats(datos, 2.64).verdict).toBe("SIN VENTAJA");
  });
});
