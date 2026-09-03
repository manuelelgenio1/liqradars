import { useEffect, useState } from "react";

/*
  La hora actual, como estado que avanza solo.

  DOS PROBLEMAS QUE RESUELVE A LA VEZ.

  1. Un render que llama a `Date.now()` no es puro: dos renders con los mismos
     datos producen resultados distintos. React puede renderizar y descartar
     el trabajo, así que esa impureza puede acabar en inconsistencias raras y
     difíciles de reproducir.

  2. Y uno visible: una etiqueta de "hace 3 min" calculada con `Date.now()` en
     el render NO se actualiza sola. Solo cambia cuando el componente repinta
     por otro motivo — un tick de precio, un clic. En un panel tranquilo se
     queda congelada diciendo "hace 3 min" durante media hora.

  Con esto la hora es estado, el render vuelve a ser puro y las etiquetas
  avanzan de verdad.

  `everyMs` se elige según lo que se muestre: un reloj con segundos necesita
  1000; un "hace X minutos" con 30.000 va sobrado y repinta treinta veces
  menos.
*/
export function useNow(everyMs = 30_000): number {
  // Función inicializadora: si no, `Date.now()` se evalúa en CADA render
  // aunque el resultado se tire, que es justo la impureza que se quiere quitar.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);

  return now;
}
