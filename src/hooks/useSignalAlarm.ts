import { useCallback, useEffect, useRef, useState } from "react";
import { useLatest } from "./useLatest";
import * as alarm from "../lib/alarm";
import type { SignalState } from "../lib/desksignals";
import type { Side } from "../lib/types";

/*
  Avisa cuando aparece una señal nueva.

  SE LLEVA LA CUENTA DE TODOS LOS PARES SIEMPRE, aunque solo se avise de uno.
  Si solo se registraran los ids del par en pantalla, cambiar el alcance a
  "todos" haría sonar de golpe las cien señales que ya existían. Aquí se apunta
  todo y se filtra solo a la hora de pitar.

  Y POR LA MISMA RAZÓN SE APUNTA CON LA ALARMA APAGADA: al encenderla no debe
  sonar el pasado.

  ADEMÁS DEL PITIDO, EL TÍTULO DE LA PESTAÑA Y UNA LISTA. El caso en el que una
  alarma sirve es aquel en el que no estás mirando; si vuelves cinco minutos
  después, el sonido ya pasó y no queda rastro. El contador aguanta hasta que
  vuelves, y la lista dice QUÉ par avisó — un pitido a secas no lo dice.
*/

const TITULO = "LIQRADAR · Liquidez y liquidaciones reales";

/**
 * Tope de pitidos por tanda.
 *
 * Las cripto se mueven juntas: un giro general pare señales en casi los veinte
 * pares a la vez. Sin tope sonarían cien seguidos y eso no es un aviso, es una
 * alarma de incendios. Se pitan los primeros y el resto queda en la lista.
 */
export const MAX_PITIDOS = 3;

/** Cuántos avisos se recuerdan para enseñar. */
const MAX_AVISOS = 12;

export type Alcance = "par" | "todos";

export interface Aviso {
  id: string;
  symbol: string;
  timeframe: string;
  side: Side;
  at: number;
}

interface Opciones {
  enabled: boolean;
  alcance: Alcance;
  /** el par que se está mirando, para el alcance "par" */
  symbol: string;
}

export function useSignalAlarm(signals: SignalState[], opts: Opciones) {
  const seen = useRef<string[] | null>(null);
  const pendientes = useRef(0);
  const optsRef = useLatest(opts);
  const [avisos, setAvisos] = useState<Aviso[]>([]);

  const limpiarAvisos = useCallback(() => setAvisos([]), []);

  // ---------- limpiar el título al volver a la pestaña ----------
  useEffect(() => {
    const alVolver = () => {
      if (document.visibilityState !== "visible") return;
      pendientes.current = 0;
      document.title = TITULO;
    };
    document.addEventListener("visibilitychange", alVolver);
    return () => document.removeEventListener("visibilitychange", alVolver);
  }, []);

  // ---------- detectar y avisar ----------
  useEffect(() => {
    const d = alarm.detect(
      seen.current,
      signals.map((s) => s.signal.id)
    );
    seen.current = d.seen;
    if (!d.nuevas.length) return;

    const { enabled, alcance, symbol } = optsRef.current;
    const nuevas = d.nuevas
      .map((id) => signals.find((x) => x.signal.id === id))
      .filter((s): s is SignalState => !!s)
      .filter((s) => alcance === "todos" || s.signal.symbol === symbol);
    if (!nuevas.length) return;

    setAvisos((prev) =>
      [
        ...nuevas.map((s) => ({
          id: s.signal.id,
          symbol: s.signal.symbol,
          timeframe: s.signal.timeframe,
          side: s.signal.side,
          at: s.signal.bornAt,
        })),
        ...prev,
      ].slice(0, MAX_AVISOS)
    );

    if (enabled) {
      /*
        Separados en el tiempo: si nacen varias a la vez —que es lo normal,
        porque el consenso gira en varios marcos y pares casi a la par—
        sonarían encimadas y se oiría un ruido en vez de N avisos.
      */
      nuevas.slice(0, MAX_PITIDOS).forEach((s, i) => {
        window.setTimeout(() => alarm.beep(s.signal.side), i * 420);
      });
    }

    if (document.visibilityState !== "visible") {
      pendientes.current += nuevas.length;
      document.title = `(${pendientes.current}) ${TITULO}`;
    }
  }, [signals, optsRef]);

  return { avisos, limpiarAvisos };
}
