import { describe, expect, it } from "vitest";
import {
  ENFRIANDO_MAX_R,
  evaluateSignal,
  FRESCA_MAX_R,
  MAX_BARS,
  maybeBirth,
  prune,
  type DeskSignal,
} from "./desksignals";

const T = 1_800_000_000_000;

/** Largo desde 100: arriesga 2, gana 4. */
const larga = (over: Partial<DeskSignal> = {}): DeskSignal => ({
  id: "s1", symbol: "BTCUSDT", timeframe: "1H", tfMinutes: 60, side: "long",
  bornAt: T, entry: 100, stop: 98, target: 104, strength: 0.7, ...over,
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

describe("limpieza", () => {
  it("descarta las caducadas y las de otro par", () => {
    const vivas = prune(
      [larga(), larga({ id: "s2", bornAt: T - MAX_BARS * 60 * 60_000 - 1 }), larga({ id: "s3", symbol: "ETHUSDT" })],
      "BTCUSDT",
      100,
      T
    );
    expect(vivas.map((s) => s.id)).toEqual(["s1"]);
  });

  it("conserva las vivas aunque vayan en contra", () => {
    // Ir perdiendo no es caducar: mientras no toque el stop, sigue viva.
    expect(prune([larga()], "BTCUSDT", 98.5, T)).toHaveLength(1);
  });
});
