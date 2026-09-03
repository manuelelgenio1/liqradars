import { describe, expect, it } from "vitest";
import { ago, axisTime, compact, countdown, num, pct, price, usd } from "./format";

/* ============================================================
   Los formateadores han sido fuente de dos bugs reales que solo se vieron
   ejecutando la app: un coste de funding de 0,50 $ se mostraba como "$0", y
   la columna entera de tamaños del libro salía a "0" porque en spot van en
   BTC (0,002). Ambos casos quedan fijados abajo como regresión.
   ============================================================ */

describe("usd", () => {
  it("escala a K, M y B", () => {
    expect(usd(1_500)).toBe("$1.5K");
    expect(usd(2_400_000)).toBe("$2.4M");
    expect(usd(3_100_000_000)).toBe("$3.10B");
  });

  // regresión: antes devolvía "$0"
  it("conserva los decimales de importes pequeños", () => {
    expect(usd(0.5, 2)).toBe("$0.50");
    expect(usd(0.51, 2)).toBe("$0.51");
    expect(usd(7.25, 2)).toBe("$7.25");
  });

  it("no dice cero cuando hay algo", () => {
    expect(usd(0.5, 2)).not.toBe("$0");
    expect(usd(0.02, 2)).not.toBe("$0");
  });

  it("los no finitos son guion, nunca un número", () => {
    expect(usd(NaN)).toBe("—");
    expect(usd(Infinity)).toBe("—");
  });

  it("respeta el signo negativo", () => {
    expect(usd(-2_000_000)).toContain("-");
  });
});

describe("compact", () => {
  it("escala igual que usd pero sin símbolo", () => {
    expect(compact(1_500)).toBe("1.5K");
    expect(compact(2_400_000)).toBe("2.4M");
  });

  // regresión: la columna de tamaños del libro salía toda a "0"
  it("conserva los decimales de tamaños pequeños en moneda base", () => {
    expect(compact(0.002)).toBe("0.0020");
    expect(compact(0.03)).toBe("0.030");
    expect(compact(0.533)).toBe("0.533");
    expect(compact(2.4)).toBe("2.40");
  });

  it("un tamaño real del libro nunca se redondea a cero", () => {
    for (const v of [0.0001, 0.002, 0.03, 0.5]) {
      expect(Number(compact(v))).toBeGreaterThan(0);
    }
  });

  it("el cero sigue siendo cero", () => {
    expect(compact(0)).toBe("0");
  });

  it("los no finitos son guion", () => {
    expect(compact(NaN)).toBe("—");
  });
});

describe("price", () => {
  it("usa los decimales del símbolo", () => {
    expect(price(76_814.35, 1)).toBe("76,814.4");
    expect(price(0.32812, 5)).toBe("0.32812");
  });
  it("NaN es guion", () => {
    expect(price(NaN, 2)).toBe("—");
  });
});

describe("pct", () => {
  it("añade el signo explícito", () => {
    expect(pct(1.234)).toBe("+1.23%");
    expect(pct(-0.5)).toBe("-0.50%");
  });
  it("NaN es guion", () => {
    expect(pct(NaN)).toBe("—");
  });
});

describe("num", () => {
  it("NaN es guion, no 'NaN'", () => {
    expect(num(NaN)).toBe("—");
    expect(num(12.34, 1)).toBe("12.3");
  });
});

describe("ago", () => {
  const now = 1_700_000_000_000;
  it("escala de segundos a días", () => {
    expect(ago(now - 5_000, now)).toBe("5s");
    expect(ago(now - 120_000, now)).toBe("2m");
    expect(ago(now - 3 * 3600_000, now)).toContain("3h");
    expect(ago(now - 50 * 3600_000, now)).toContain("2d");
  });
  it("no devuelve tiempos negativos", () => {
    expect(ago(now + 10_000, now)).toBe("0s");
  });
});

describe("countdown", () => {
  it("formatea hh:mm:ss", () => {
    expect(countdown(3661_000)).toBe("01:01:01");
  });
  it("nunca baja de cero", () => {
    expect(countdown(-5000)).toBe("00:00:00");
  });
});

describe("axisTime", () => {
  const ts = Date.UTC(2026, 2, 15, 9, 30);
  it("usa hora en marcos cortos y fecha en largos", () => {
    expect(axisTime(ts, 5)).toBe("09:30");
    expect(axisTime(ts, 1440)).toContain("Mar");
    expect(axisTime(ts, 10080)).toContain("'26");
  });
});
