// @vitest-environment jsdom
// El modulo lee `window`, asi que estas pruebas necesitan un DOM.
import { afterEach, describe, expect, it } from "vitest";
import { detect, MAX_RECORDADAS } from "./alarm";
import * as alarmSound from "./alarm";

describe("qué señal es nueva", () => {
  it("la primera pasada SIEMBRA y no avisa de nada", () => {
    /*
      El caso que importa: las señales viven en disco, así que al recargar la
      página la lista llega llena. Si esto avisara, cada recarga sería una
      ráfaga de pitidos por señales que ya conocías.
    */
    const d = detect(null, ["a", "b", "c"]);
    expect(d.nuevas).toEqual([]);
    expect(d.seen).toEqual(["a", "b", "c"]);
  });

  it("distingue «no sé nada» de «sé que no hay ninguna»", () => {
    // null siembra; [] ya es conocimiento, así que lo que llegue es nuevo.
    expect(detect(null, ["a"]).nuevas).toEqual([]);
    expect(detect([], ["a"]).nuevas).toEqual(["a"]);
  });

  it("avisa solo de las que no estaban", () => {
    const d = detect(["a"], ["a", "b"]);
    expect(d.nuevas).toEqual(["b"]);
    expect(d.seen).toContain("a");
    expect(d.seen).toContain("b");
  });

  it("una señal que DESAPARECE Y VUELVE no suena dos veces", () => {
    /*
      El estado se deriva del precio: si roza el stop y se recupera antes de que
      la poda la retire, sale de la lista y vuelve a entrar. Recordar los ids
      aunque ya no estén es lo que evita el doble aviso.
    */
    const uno = detect(null, ["a"]);
    const fuera = detect(uno.seen, []); // desaparece
    const vuelve = detect(fuera.seen, ["a"]); // reaparece
    expect(vuelve.nuevas).toEqual([]);
  });

  it("sin novedad devuelve la MISMA referencia", () => {
    // Evita repintados inútiles en cada pasada del reloj.
    const seen = ["a", "b"];
    expect(detect(seen, ["a"]).seen).toBe(seen);
    expect(detect(seen, []).seen).toBe(seen);
  });

  it("varias nuevas a la vez se detectan todas", () => {
    expect(detect(["a"], ["a", "b", "c"]).nuevas).toEqual(["b", "c"]);
  });

  it("la memoria de las IDAS está acotada", () => {
    // cinco por encima del tope, para que la poda tenga algo que podar
    const viejas = Array.from({ length: MAX_RECORDADAS + 5 }, (_, i) => `v${i}`);
    const d = detect(viejas, ["nueva"]); // ninguna de las viejas sigue presente
    expect(d.seen).toHaveLength(MAX_RECORDADAS + 1); // la viva + el tope de idas
    expect(d.seen[0]).toBe("nueva");
    expect(d.seen).toContain("v0"); // la ida más reciente se conserva
    expect(d.seen).not.toContain(`v${MAX_RECORDADAS + 4}`); // la más antigua se cae
  });

  it("LA REGRESIÓN: una señal viva NUNCA se olvida, por antigua que sea", () => {
    /*
      Con ~100 señales vivas y casi cien nacimientos cada diez minutos, en
      media hora se agotaban los 300 huecos. Las viejas pero VIVAS caían de la
      lista y volvían a avisar como si acabaran de nacer.
    */
    let seen = detect(null, ["vieja"]).seen;
    for (let i = 0; i < MAX_RECORDADAS * 2; i++) {
      // "vieja" sigue presente en cada pasada, junto a una nueva cada vez
      seen = detect(seen, ["vieja", `n${i}`]).seen;
    }
    expect(detect(seen, ["vieja"]).nuevas).toEqual([]);
  });

  it("sembrar guarda todas: al arrancar nada es nuevo", () => {
    const muchas = Array.from({ length: MAX_RECORDADAS + 50 }, (_, i) => `x${i}`);
    const d = detect(null, muchas);
    expect(d.nuevas).toEqual([]);
    expect(detect(d.seen, muchas).nuevas).toEqual([]);
  });
});

// ---------------- el sonido ----------------

/*
  El navegador no se puede escuchar desde una prueba, así que se comprueba lo
  que sí es verificable: que se pide el número de osciladores esperado y con
  qué frecuencias. Que suba para largo y baje para corto no es adorno — es lo
  que te dice la dirección sin mirar la pantalla, que es el caso en el que una
  alarma sirve para algo.
*/
class ParamFalso {
  valores: number[] = [];
  setValueAtTime(v: number) {
    this.valores.push(v);
  }
  linearRampToValueAtTime() {}
  exponentialRampToValueAtTime() {}
}

class OscFalso {
  type = "";
  frequency = new ParamFalso();
  arrancado: number[] = [];
  connect(n: unknown) {
    return n;
  }
  start(t: number) {
    this.arrancado.push(t);
  }
  stop() {}
}

class CtxFalso {
  state = "running";
  currentTime = 0;
  destination = {};
  osciladores: OscFalso[] = [];
  createOscillator() {
    const o = new OscFalso();
    this.osciladores.push(o);
    return o;
  }
  createGain() {
    return { gain: new ParamFalso(), connect: (n: unknown) => n };
  }
  resume() {}
}

/*
  Se parchea `window` y NO `globalThis`: en jsdom no son el mismo objeto, y el
  módulo lee `window.AudioContext`. Con globalThis dos de estas pruebas pasaban
  por el motivo equivocado — no porque el falso funcionara, sino porque no
  había AudioContext en absoluto.
*/
function montar(): CtxFalso {
  let creado!: CtxFalso;
  (window as unknown as { AudioContext: unknown }).AudioContext = function () {
    creado = new CtxFalso();
    return creado;
  };
  alarmSound.reset();
  alarmSound.unlock();
  return creado;
}

describe("el aviso sonoro", () => {
  afterEach(() => {
    alarmSound.reset();
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  });

  it("sin soporte de audio no revienta, solo dice que no", () => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    alarmSound.reset();
    expect(alarmSound.unlock()).toBe(false);
    expect(alarmSound.isReady()).toBe(false);
  });

  it("un constructor que lanza tampoco tumba la página", () => {
    (window as unknown as { AudioContext: unknown }).AudioContext = function () {
      throw new Error("bloqueado por la política del navegador");
    };
    alarmSound.reset();
    expect(alarmSound.unlock()).toBe(false);
  });

  it("largo suena ASCENDENTE: 660 y luego 990", () => {
    const ctx = montar();
    alarmSound.beep("long");
    expect(ctx.osciladores).toHaveLength(2);
    expect(ctx.osciladores[0].frequency.valores[0]).toBe(660);
    expect(ctx.osciladores[1].frequency.valores[0]).toBe(990);
  });

  it("corto suena DESCENDENTE: 660 y luego 440", () => {
    const ctx = montar();
    alarmSound.beep("short");
    expect(ctx.osciladores[0].frequency.valores[0]).toBe(660);
    expect(ctx.osciladores[1].frequency.valores[0]).toBe(440);
  });

  it("las dos notas van SEGUIDAS, no a la vez", () => {
    // Solapadas sonarían a acorde y no se distinguiría la dirección.
    const ctx = montar();
    alarmSound.beep("long");
    expect(ctx.osciladores[1].arrancado[0]).toBeGreaterThan(ctx.osciladores[0].arrancado[0]);
  });

  it("sin desbloquear NO suena nada", () => {
    // El navegador lo bloquearía igual; mejor no fingir que sonó.
    alarmSound.reset();
    expect(() => alarmSound.beep("long")).not.toThrow();
  });

  it("desbloquear dos veces reutiliza el mismo contexto", () => {
    let n = 0;
    (window as unknown as { AudioContext: unknown }).AudioContext = function () {
      n++;
      return new CtxFalso();
    };
    alarmSound.reset();
    alarmSound.unlock();
    alarmSound.unlock();
    expect(n).toBe(1);
  });
});
