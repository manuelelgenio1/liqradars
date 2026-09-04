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

export interface AlarmaApi {
  avisos: Aviso[];
  limpiarAvisos: () => void;
  alarmaOn: boolean;
  alternarAlarma: () => void;
  alcance: Alcance;
  alternarAlcance: () => void;
}

export function useSignalAlarm(signals: SignalState[], symbol: string): AlarmaApi {
  /*
    ESTE ESTADO VIVE EN `ChartTabs`, NO EN EL PANEL, y no es un capricho: el
    panel se monta con `tab === "trade" && ...`, así que cambiar de pestaña lo
    DESMONTABA. La alarma se apagaba sola, el alcance volvía a "este par" y la
    lista de avisos se borraba — y encima no sonaba nada mientras mirabas otra
    pestaña, que es justo cuando una alarma sirve para algo.
  */
  const [alarmaOn, setAlarmaOn] = useState(false);
  const [alcance, setAlcance] = useState<Alcance>("par");

  /*
    LA ALARMA SE ENCIENDE CON UN CLIC Y NO PUEDE SER DE OTRA FORMA. Ningún
    navegador deja sonar audio hasta que el usuario ha interactuado con la
    página, así que este clic hace dos cosas: guardar la preferencia y darle al
    navegador el gesto que exige. No se restaura activada al recargar: prometer
    un aviso que el navegador va a bloquear es peor que no prometerlo.
  */
  const alternarAlarma = useCallback(() => {
    setAlarmaOn((prev) => {
      if (prev) return false;
      const ok = alarm.unlock();
      /*
        SUENA UNA VEZ AL ACTIVARLA, y no es un adorno.

        Sin esto no hay forma de distinguir "la alarma está rota" de "todavía
        no ha nacido nada", que puede ser media hora si el alcance es de un
        solo par. El usuario se queda mirando un botón que dice ACTIVADA sin
        saber si le va a avisar. Un pitido en el momento del clic lo resuelve:
        si lo oyes, funciona; si no, es el volumen o el navegador.
      */
      if (ok) alarm.beep("long");
      return ok;
    });
  }, []);
  const alternarAlcance = useCallback(() => {
    setAlcance((a) => (a === "par" ? "todos" : "par"));
  }, []);
  const optsRef = useLatest({ enabled: alarmaOn, alcance, symbol });

  /*
    SOLO SE AVISA DE LO NACIDO DESPUÉS DE ARRANCAR.

    Sin esto, la lista mentía en cada carga. Las señales viven en disco pero
    la lista derivada llega VACÍA al primer render —hacen falta los precios,
    que son asíncronos—, así que se sembraba con nada y un segundo después las
    cien preexistentes se detectaban como recién nacidas. Se veía a simple
    vista: aparecían de golpe los seis marcos de un par, semanal incluido, y
    una señal de 1W no acaba de nacer junto a las otras cinco.

    Comparar contra el instante de arranque no depende de cuándo lleguen los
    datos, que es justo lo que hacía frágil a la siembra.
  */
  const desde = useRef(0);
  const seen = useRef<string[] | null>(null);
  const pendientes = useRef(0);
  const [avisos, setAvisos] = useState<Aviso[]>([]);

  const limpiarAvisos = useCallback(() => setAvisos([]), []);

  /*
    El instante de arranque se fija en un EFECTO, no durante el render.
    `Date.now()` en el cuerpo del componente es impuro: React puede repetir un
    render y dar un valor distinto. Va declarado antes que el efecto de
    detección para que ya esté puesto cuando aquel corra.
  */
  useEffect(() => {
    desde.current = Date.now();
  }, []);

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
      .filter((s) => s.signal.bornAt >= desde.current)
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

  return { avisos, limpiarAvisos, alarmaOn, alternarAlarma, alcance, alternarAlcance };
}
