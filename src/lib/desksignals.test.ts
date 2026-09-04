import { describe, expect, it } from "vitest";
import type { Candle } from "./types";
import {
  candlesFor,
  type CandleStore,
  EMPTY_STORE,
  ENFRIANDO_MAX_R,
  evaluateSignal,
  FRESCA_MAX_R,
  MAX_BARS,
  dropUnresolvable,
  latestFor,
  maybeBirth,
  RESOLVE_GRACE,
  type DeskSignal,
} from "./desksignals";

const T = 1_800_000_000_000;

/** Largo desde 100: arriesga 2, gana 4. */
const larga = (over: Partial<DeskSignal> = {}): DeskSignal => ({
  id: "s1", symbol: "BTCUSDT", timeframe: "1H", tfMinutes: 60, side: "long",
  bornAt: T, entry: 100, stop: 98, target: 104, strength: 0.7, controlSide: "long", ...over,
});

const corta = (over: Partial<DeskSignal> = {}): DeskSignal =>
  larga({ side: "short", stop: 102, target: 96, ...over });

describe("cuánto se ha alejado el precio", () => {
  it("recién nacida no se ha movido nada", () => {
    const s = evaluateSignal(larga(), 100, T);
    expect(s.movedR).toBe(0);
    expect(s.freshness).toBe("fresca");
    expect(s.ageMs).toBe(0);
  });

  it("una R recorrida es exactamente la distancia al stop", () => {
    // riesgo 2 → el precio a 102 ha recorrido 1R hacia el objetivo
    expect(evaluateSignal(larga(), 102, T).movedR).toBeCloseTo(1, 8);
  });

  it("en corto se mide al revés", () => {
    // corta desde 100 con stop 102: el precio a 98 ha ganado 1R
    expect(evaluateSignal(corta(), 98, T).movedR).toBeCloseTo(1, 8);
  });

  it("moverse en contra da R negativas", () => {
    expect(evaluateSignal(larga(), 99, T).movedR).toBeCloseTo(-0.5, 8);
  });
});

describe("el R:R que tendrías AHORA", () => {
  /*
    Esto es el corazón de "¿puedo entrar todavía?". Los niveles se fijaron al
    nacer; cada punto recorrido es beneficio que ya no cobras mientras el stop
    sigue en su sitio. La misma señal deja de ser la misma operación.
  */
  it("al nacer coincide con el R:R de diseño", () => {
    expect(evaluateSignal(larga(), 100, T).rrNow).toBeCloseTo(2, 8); // 4/2
  });

  it("se degrada según el precio avanza", () => {
    const a = evaluateSignal(larga(), 100, T).rrNow;
    const b = evaluateSignal(larga(), 102, T).rrNow;
    const c = evaluateSignal(larga(), 103, T).rrNow;
    expect(b).toBeLessThan(a);
    expect(c).toBeLessThan(b);
    expect(c).toBeCloseTo(1 / 5, 8); // queda 1 por ganar, 5 por perder
  });

  it("mejora si el precio va en contra, y eso también hay que verlo", () => {
    // Contraintuitivo pero cierto: entrar más abajo da mejor R:R, aunque el
    // stop quede más cerca. La cifra lo dice; la decisión es del usuario.
    expect(evaluateSignal(larga(), 99, T).rrNow).toBeGreaterThan(2);
  });
});

describe("frescura", () => {
  it("los umbrales van en el orden esperado", () => {
    expect(FRESCA_MAX_R).toBeLessThan(ENFRIANDO_MAX_R);
  });

  it("clasifica según lo recorrido", () => {
    expect(evaluateSignal(larga(), 100.4, T).freshness).toBe("fresca"); // 0,2R
    expect(evaluateSignal(larga(), 100.9, T).freshness).toBe("enfriando"); // 0,45R
    expect(evaluateSignal(larga(), 102, T).freshness).toBe("tarde"); // 1R
  });

  it("ir en contra no la marca como tarde", () => {
    // Es una señal que aún no ha hecho nada, no una a la que llegas tarde.
    expect(evaluateSignal(larga(), 99, T).freshness).toBe("fresca");
  });
});

describe("caducidad", () => {
  it("caduca por tiempo a las 48 velas de SU temporalidad", () => {
    const vida = MAX_BARS * 60 * 60_000;
    expect(evaluateSignal(larga(), 100, T + vida - 1).expiredReason).toBeNull();
    expect(evaluateSignal(larga(), 100, T + vida + 1).expiredReason).toBe("tiempo");
  });

  it("la vida depende del marco, no del reloj", () => {
    const cinco = larga({ timeframe: "5m", tfMinutes: 5 });
    const dia = larga({ timeframe: "1D", tfMinutes: 1440 });
    const t = T + MAX_BARS * 5 * 60_000 + 1;
    expect(evaluateSignal(cinco, 100, t).expiredReason).toBe("tiempo");
    expect(evaluateSignal(dia, 100, t).expiredReason).toBeNull();
  });

  it("caduca si el precio ya tocó el stop", () => {
    const s = evaluateSignal(larga(), 97.9, T);
    expect(s.expiredReason).toBe("stop");
    expect(s.freshness).toBe("caducada");
  });

  it("caduca si ya alcanzó el objetivo: la operación ocurrió sin ti", () => {
    expect(evaluateSignal(larga(), 104.1, T).expiredReason).toBe("objetivo");
  });

  it("el stop de un corto está ARRIBA", () => {
    expect(evaluateSignal(corta(), 102.5, T).expiredReason).toBe("stop");
    expect(evaluateSignal(corta(), 95.5, T).expiredReason).toBe("objetivo");
  });

  it("nunca devuelve tiempo restante negativo", () => {
    expect(evaluateSignal(larga(), 100, T + 1e12).remainingMs).toBe(0);
  });
});

describe("nacimiento: solo cuando el lado CAMBIA", () => {
  const inp = (side: "long" | "short" | null) => ({
    symbol: "BTCUSDT", timeframe: "1H", tfMinutes: 60, side,
    price: 100, atr: 1.667, strength: 0.7, stopAtr: 1.2, targetAtr: 2.0,
  });

  it("sin lado no nace nada", () => {
    expect(maybeBirth(inp(null), undefined, T)).toBeNull();
  });

  it("nace la primera vez", () => {
    const s = maybeBirth(inp("long"), undefined, T);
    expect(s).not.toBeNull();
    expect(s!.side).toBe("long");
    expect(s!.bornAt).toBe(T);
  });

  it("el mismo lado NO crea una nueva: es la misma envejeciendo", () => {
    // Sin esto el contador se reiniciaría en cada vela y no mediría nada.
    const previa = larga();
    expect(maybeBirth(inp("long"), previa, T + 60_000)).toBeNull();
  });

  it("el lado contrario sí releva", () => {
    const s = maybeBirth(inp("short"), larga(), T + 60_000);
    expect(s).not.toBeNull();
    expect(s!.side).toBe("short");
  });

  it("si la anterior ya caducó, nace otra aunque coincida el lado", () => {
    const t = T + MAX_BARS * 60 * 60_000 + 1;
    expect(maybeBirth(inp("long"), larga(), t)).not.toBeNull();
  });

  it("los niveles salen del ATR, con el stop del lado correcto", () => {
    const s = maybeBirth(inp("long"), undefined, T)!;
    expect(s.stop).toBeLessThan(s.entry);
    expect(s.target).toBeGreaterThan(s.entry);
    expect(s.entry - s.stop).toBeCloseTo(1.667 * 1.2, 6);
    const c = maybeBirth(inp("short"), undefined, T)!;
    expect(c.stop).toBeGreaterThan(c.entry);
  });

  it("un ATR o precio imposibles no producen señal", () => {
    expect(maybeBirth({ ...inp("long"), atr: 0 }, undefined, T)).toBeNull();
    expect(maybeBirth({ ...inp("long"), price: 0 }, undefined, T)).toBeNull();
  });
});

describe("nada se tira antes de poder anotarlo", () => {
  /*
    El agujero por el que se escapaba casi todo el registro. Medido en
    producción: 100 señales vivas, 94 nacidas en los últimos diez minutos,
    mediana de tres — y TRES apuntes en el libro.

    La causa era mezclar dos preguntas:
      ¿sigue siendo entrable?  con el precio EN VIVO, al instante
      ¿cómo acabó?             con VELAS, que llegan cada dos o tres minutos
    La poda usaba la primera para tirar la señal, así que la borraba mucho
    antes de que las velas pudieran certificar el desenlace.
  */
  const vidaMs = (tfMin: number) => tfMin * MAX_BARS * 60_000;

  it("LA REGRESIÓN: una señal que YA tocó su objetivo se conserva", () => {
    // Deja de enseñarse —eso lo decide evaluateSignal— pero sigue en la lista
    // hasta que las velas la cierren.
    const tocada = larga();
    expect(evaluateSignal(tocada, 104.1, T).expiredReason).toBe("objetivo");
    expect(dropUnresolvable([tocada], T)).toHaveLength(1);
  });

  it("también se conserva la que tocó el stop", () => {
    const tocada = larga();
    expect(evaluateSignal(tocada, 97.9, T).expiredReason).toBe("stop");
    expect(dropUnresolvable([tocada], T)).toHaveLength(1);
  });

  it("se conserva incluso pasada su vida: las velas aún pueden cerrarla", () => {
    // A las 48 velas el libro la cierra como expirada, y para eso tiene que
    // seguir estando.
    expect(dropUnresolvable([larga()], T + vidaMs(60) + 1)).toHaveLength(1);
  });

  it("se descarta cuando ya no queda esperanza de resolverla", () => {
    const muyPasada = T + vidaMs(60) * RESOLVE_GRACE + 1;
    expect(dropUnresolvable([larga()], muyPasada)).toEqual([]);
  });

  it("la holgura se mide en la vida de SU marco, no en horas de reloj", () => {
    const cinco = larga({ timeframe: "5m", tfMinutes: 5 });
    const t = T + vidaMs(5) * RESOLVE_GRACE + 1;
    expect(dropUnresolvable([cinco], t)).toEqual([]);
    expect(dropUnresolvable([larga()], t)).toHaveLength(1); // la de 1H aguanta
  });

  it("conserva las de otros pares: antes se perdían sin registrar", () => {
    const dos = [larga(), larga({ id: "s3", symbol: "ETHUSDT" })];
    expect(dropUnresolvable(dos, T).map((s) => s.id)).toEqual(["s1", "s3"]);
  });
});

describe("cuál es la señal vigente", () => {
  it("la más reciente del par y marco, no la primera de la lista", () => {
    /*
      Ahora puede haber varias del mismo par y marco: la actual y alguna
      esperando a que las velas la cierren. Coger la primera haría nacer una
      nueva en cada ciclo, para siempre.
    */
    const vieja = larga({ id: "vieja", bornAt: T });
    const nueva = larga({ id: "nueva", bornAt: T + 60_000 });
    expect(latestFor([vieja, nueva], "BTCUSDT", "1H")?.id).toBe("nueva");
    expect(latestFor([nueva, vieja], "BTCUSDT", "1H")?.id).toBe("nueva");
  });

  it("no confunde pares ni marcos", () => {
    const otras = [larga({ id: "eth", symbol: "ETHUSDT" }), larga({ id: "d", timeframe: "1D" })];
    expect(latestFor(otras, "BTCUSDT", "1H")).toBeUndefined();
  });

  it("sin ninguna devuelve undefined, que es lo que hace nacer la primera", () => {
    expect(latestFor([], "BTCUSDT", "1H")).toBeUndefined();
  });
});

describe("las velas saben de qué par son", () => {
  /*
    La regresión que esto vigila se observó en vivo: al pasar de SOL a BTC
    nacieron seis señales etiquetadas BTCUSDT con el precio de SOL y el ATR de
    BTC, una de ellas con el stop en −7384. Un precio negativo. `symbol`
    cambia en el acto y las velas tardan unos segundos; durante esa ventana la
    mesa mezclaba nombre nuevo con datos viejos.
  */
  const vela = (c: number): Candle => ({ t: T, o: c, h: c, l: c, c, v: 1, delta: 0 });
  const store: CandleStore = {
    SOLUSDT: { "1H": [vela(103)] },
    BTCUSDT: { "1H": [vela(80795)] },
  };

  it("sirve las del par que se le pide", () => {
    expect(candlesFor(store, "SOLUSDT", "1H")[0].c).toBe(103);
    expect(candlesFor(store, "BTCUSDT", "1H")[0].c).toBe(80795);
  });

  it("un par que no está cargado devuelve vacío: es lo que fabricaba stops negativos", () => {
    expect(candlesFor(store, "ETHUSDT", "1H")).toEqual([]);
  });

  it("un marco que no está cargado devuelve vacío, no undefined", () => {
    // Quien llama hace `candles.length`: un undefined aquí tumbaría la mesa.
    expect(candlesFor(store, "SOLUSDT", "4H")).toEqual([]);
  });

  it("el almacén vacío no sirve nada a nadie", () => {
    expect(candlesFor(EMPTY_STORE, "BTCUSDT", "1H")).toEqual([]);
  });
});

describe("una operación terminada libera el hueco", () => {
  /*
    Antes "sigue viva" se decidía SOLO con el reloj: 48 velas desde que nació.
    Así que una señal que ya había alcanzado su objetivo seguía ocupando el
    hueco de su par y marco durante dos días en 1H, o cuarenta y ocho en
    diario, sin que naciera la siguiente. La operación había terminado y la
    mesa la trataba como si siguiera abierta.
  */
  const inp = (side: "long" | "short", price: number) => ({
    symbol: "BTCUSDT", timeframe: "1H", tfMinutes: 60, side,
    price, atr: 1.667, strength: 0.7, stopAtr: 1.2, targetAtr: 2.0,
  });

  it("tras alcanzar el OBJETIVO nace otra, aunque el lado no cambie", () => {
    // larga desde 100 con objetivo en 104: a 104,5 la operación acabó
    const nueva = maybeBirth(inp("long", 104.5), larga(), T + 60_000);
    expect(nueva).not.toBeNull();
    expect(nueva!.side).toBe("long");
    expect(nueva!.entry).toBe(104.5); // niveles recalculados desde el precio de ahora
  });

  it("tras saltar el STOP también, y sin esperar 48 velas", () => {
    expect(maybeBirth(inp("long", 97.5), larga(), T + 60_000)).not.toBeNull();
  });

  it("pero mientras la operación sigue EN CURSO no hay relevo", () => {
    // 102 está entre el stop (98) y el objetivo (104): no ha pasado nada
    expect(maybeBirth(inp("long", 102), larga(), T + 60_000)).toBeNull();
  });

  it("ir en contra sin tocar el stop tampoco releva", () => {
    expect(maybeBirth(inp("long", 98.5), larga(), T + 60_000)).toBeNull();
  });

  it("la caducidad por tiempo sigue funcionando", () => {
    const t = T + MAX_BARS * 60 * 60_000 + 1;
    expect(maybeBirth(inp("long", 100), larga(), t)).not.toBeNull();
  });

  it("la nueva no hereda nada de la vieja: id y nacimiento propios", () => {
    // Si compartieran id, el libro creería que ya la anotó y perdería una.
    const vieja = larga();
    const nueva = maybeBirth(inp("long", 104.5), vieja, T + 60_000)!;
    expect(nueva.id).not.toBe(vieja.id);
    expect(nueva.bornAt).toBe(T + 60_000);
  });
});
