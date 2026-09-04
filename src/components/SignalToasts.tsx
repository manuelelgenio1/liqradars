import { useState } from "react";
import { useNow } from "../hooks/useNow";
import type { Aviso } from "../hooks/useSignalAlarm";

/* ============================================================
   Ventana flotante: QUÉ señal acaba de sonar.

   El pitido dice que ha pasado algo pero no qué. Con veinte pares vigilados
   eso lo vuelve casi inútil: te giras hacia la pantalla y tienes que ir a
   buscar cuál fue. La lista de "últimos avisos" ya lo resolvía, pero solo si
   estabas en la pestaña Operar y mirando esa zona.

   Esto flota por encima de todo, en cualquier pestaña, y se va solo.

   POR QUÉ CADUCA CONTANDO DESDE LA DETECCIÓN Y NO DESDE EL NACIMIENTO: una
   señal de 1W puede tener horas de vida cuando te enteras de ella. Si el
   temporizador contara desde que nació, aparecería ya caducada y no la verías
   nunca.

   TRES A LA VEZ COMO MUCHO. Un giro general pare señales en casi todos los
   pares a la vez; apilar veinte tarjetas taparía la aplicación entera. Se
   enseñan las más recientes y el resto queda en la lista de la pestaña.
   ============================================================ */

/** Lo que aguanta una tarjeta antes de irse sola. */
export const VIDA_MS = 12_000;

const MAX_VISIBLES = 3;

export default function SignalToasts({
  avisos,
  onIr,
}: {
  avisos: Aviso[];
  onIr: (symbol: string) => void;
}) {
  const ahora = useNow(500);
  const [cerrados, setCerrados] = useState<string[]>([]);

  const vivos = avisos
    .filter((a) => ahora - a.seenAt < VIDA_MS && !cerrados.includes(a.id))
    .slice(0, MAX_VISIBLES);

  if (!vivos.length) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {vivos.map((a) => {
        const largo = a.side === "long";
        const color = largo ? "var(--color-up)" : "var(--color-down)";
        const restante = Math.max(0, 1 - (ahora - a.seenAt) / VIDA_MS);
        return (
          <div
            key={a.id}
            className="pointer-events-auto relative w-[248px] overflow-hidden rounded-lg border bg-[rgba(13,18,29,0.97)] shadow-lg"
            style={{ borderColor: color }}
          >
            {/*
              El botón de cerrar va SUELTO y colocado encima, no dentro del
              otro: un <button> anidado en otro <button> es HTML inválido y el
              navegador se inventa cómo repararlo.
            */}
            <button
              onClick={() => setCerrados((prev) => [...prev, a.id])}
              title="Descartar este aviso"
              className="etiqueta absolute right-2.5 top-2.5 z-10 hover:text-[var(--color-body)]"
            >
              cerrar
            </button>
            <button
              onClick={() => onIr(a.symbol)}
              title={`Ir a ${a.symbol}`}
              className="block w-full px-3.5 py-3 text-left transition-colors hover:bg-[var(--color-surface-2)]"
            >
              <span className="font-display text-[11px] font-bold tracking-wide" style={{ color }}>
                {largo ? "▲ LARGO" : "▼ CORTO"}
              </span>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="dato-l">{a.symbol.replace("USDT", "")}</span>
                <span className="seccion">{a.timeframe}</span>
              </div>
              <div className="nota-sm mt-0.5">señal nueva · pulsa para ir</div>
            </button>
            {/* lo que le queda antes de irse sola */}
            <div className="h-[2px] bg-[var(--color-surface-3)]">
              <div className="h-full transition-all duration-500" style={{ width: `${restante * 100}%`, background: color }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
