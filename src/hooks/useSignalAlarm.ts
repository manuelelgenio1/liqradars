import { useEffect, useRef } from "react";
import { useLatest } from "./useLatest";
import * as alarm from "../lib/alarm";
import type { SignalState } from "../lib/desksignals";

/*
  Avisa cuando aparece una señal nueva.

  SE LLEVA LA CUENTA AUNQUE LA ALARMA ESTÉ APAGADA. Si solo se registraran los
  ids con el sonido activo, al encenderla sonarían de golpe todas las que
  nacieron mientras estaba en silencio. Aquí se apunta siempre y se suena solo
  si toca.

  ADEMÁS DEL PITIDO, EL TÍTULO DE LA PESTAÑA. El caso en el que una alarma
  sirve es justamente aquel en el que no estás mirando la página; si vuelves
  cinco minutos después, el sonido ya pasó y no queda rastro. El contador en el
  título aguanta hasta que vuelves, y se limpia solo al mirar.
*/

const TITULO = "LIQRADAR · Liquidez y liquidaciones reales";

export function useSignalAlarm(signals: SignalState[], enabled: boolean): void {
  const seen = useRef<string[] | null>(null);
  const pendientes = useRef(0);
  const enabledRef = useLatest(enabled);

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
    const d = alarm.detect(seen.current, signals.map((s) => s.signal.id));
    seen.current = d.seen;
    if (!d.nuevas.length) return;

    if (enabledRef.current) {
      /*
        Un pitido por señal, separados en el tiempo. Si nacen varias a la vez
        —cosa que pasa: el consenso suele girar en varios marcos casi a la
        par— sonarían encimadas y se oiría un ruido en vez de N avisos.
      */
      d.nuevas.forEach((id, i) => {
        const s = signals.find((x) => x.signal.id === id);
        if (!s) return;
        window.setTimeout(() => alarm.beep(s.signal.side), i * 420);
      });
    }

    if (document.visibilityState !== "visible") {
      pendientes.current += d.nuevas.length;
      document.title = `(${pendientes.current}) ${TITULO}`;
    }
  }, [signals, enabledRef]);
}
