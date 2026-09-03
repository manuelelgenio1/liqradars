// @vitest-environment jsdom
// Prueba de regresión del temporizador de señales.
//
// El fallo original: un useEffect con datos cambiantes en las dependencias
// destruía y recreaba su intervalo antes de cumplirse, así que NUNCA
// generaba una señal. No se veía en pantalla — la app funcionaba y no
// producía nada.
//
// Al mover los refs de "escritura durante el render" a "escritura dentro de
// un efecto", el riesgo es reintroducirlo. Esto lo comprueba con temporizadores
// simulados: se renderiza muchas veces con datos nuevos y se verifica que el
// intervalo sigue vivo y ve el ÚLTIMO valor.
import { act, render } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLatest } from "./useLatest";

let vistos: number[] = [];

function Sonda({ valor }: { valor: number }) {
  const ref = useLatest(valor);
  const [, forzar] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      vistos.push(ref.current);
      forzar((n) => n + 1); // re-render en cada tick, como hace la app real
    }, 1000);
    return () => clearInterval(id);
  }, [ref]);
  return null;
}

beforeEach(() => {
  vistos = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("el temporizador sobrevive a los cambios de datos", () => {
  it("dispara aunque el valor cambie en cada render", () => {
    const { rerender } = render(<Sonda valor={0} />);
    for (let i = 1; i <= 30; i++) {
      act(() => { rerender(<Sonda valor={i} />); });
      act(() => { vi.advanceTimersByTime(200); }); // 5 renders por tick
    }
    // Si el efecto se recreara en cada render, esto seguiría vacío.
    expect(vistos.length).toBeGreaterThan(0);
  });

  it("el callback ve el último valor, no el del primer render", () => {
    const { rerender } = render(<Sonda valor={1} />);
    act(() => { rerender(<Sonda valor={99} />); });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(vistos.at(-1)).toBe(99);
  });

  it("deja de disparar al desmontar", () => {
    const { unmount } = render(<Sonda valor={5} />);
    act(() => { vi.advanceTimersByTime(1000); });
    const antes = vistos.length;
    unmount();
    act(() => { vi.advanceTimersByTime(5000); });
    expect(vistos.length).toBe(antes);
  });
});
