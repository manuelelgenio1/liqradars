import { useCallback, useEffect, useRef, useState } from "react";
import { useLatest } from "./useLatest";
import * as alarm from "../lib/alarm";
import * as storage from "../lib/storage";
import { DESK_TFS } from "./useTradingDesk";
import { verdictFor } from "../lib/tfverdict";
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

const LS_PARES = "liqradar:alarma:pares";
const LS_MARCOS = "liqradar:alarma:marcos";

/*
  DE QUÉ MARCOS SUENA, POR DEFECTO.

  Salen del expediente, no de aquí: los que `tfverdict` da por DESCARTADOS
  —5 minutos y 30 minutos— empiezan apagados. Una alarma que te despierta por
  una señal de 5m está prometiendo algo que veintinueve medidas dicen que no
  existe, y encima ahoga las que sí importan: el registro lleva 220
  operaciones de 5m contra 5 de 4H.

  Se pueden volver a encender a mano. Lo que no puede es venir encendido de
  fábrica lo que la propia app etiqueta como sin ventaja.
*/
const MARCOS_POR_DEFECTO = DESK_TFS.filter((k) => verdictFor(k)?.tone !== "descartado");
const LS_ON = "liqradar:alarma:on";

export interface Aviso {
  id: string;
  symbol: string;
  timeframe: string;
  side: Side;
  /** cuándo NACIÓ la señal */
  at: number;
  /*
    Cuándo se DETECTÓ, que no es lo mismo. La ventana flotante caduca contando
    desde que apareció el aviso, no desde que nació la señal: una de 1W puede
    tener horas de vida y aun así acabas de enterarte.
  */
  seenAt: number;
}

export interface AlarmaApi {
  avisos: Aviso[];
  limpiarAvisos: () => void;
  alarmaOn: boolean;
  /** querías sonido pero el navegador aún no lo permite: falta un clic */
  alarmaPendiente: boolean;
  alternarAlarma: () => void;
  /** pares que avisan; el resto se vigila igual pero en silencio */
  seleccion: string[];
  /** marcos que avisan; 5m y 30m vienen apagados porque están descartados */
  marcos: string[];
  alternarMarco: (key: string) => void;
  alternarPar: (sym: string) => void;
  elegirTodos: (syms: string[]) => void;
  elegirNinguno: () => void;
  elegirSoloActual: () => void;
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
  const [alarmaPendiente, setPendiente] = useState(false);

  /*
    SE RECUERDA SI LA QUERÍAS ENCENDIDA, pero no se miente sobre si suena.

    Antes se ignoraba la preferencia al recargar, y era molesto de verdad:
    cada recarga te dejaba sin alarma en silencio. La razón original sigue en
    pie —el navegador bloquea el audio sin un gesto previo, así que restaurar
    un botón en verde sería una promesa falsa— pero se puede hacer mejor.

    Se INTENTA arrancar el audio y se comprueba si de verdad quedó sonando.
    Los navegadores lo permiten sin gesto cuando ya has usado el sitio otras
    veces. Si sale bien, la alarma vuelve encendida y funcionando. Si no, el
    botón lo dice y pide un clic, en vez de fingir.
  */
  useEffect(() => {
    if (!storage.read<boolean>(LS_ON, false)) return;
    let vivo = true;
    void alarm.tryResume().then((ok) => {
      if (!vivo) return;
      if (ok) setAlarmaOn(true);
      else setPendiente(true);
    });
    return () => {
      vivo = false;
    };
  }, []);

  /*
    QUÉ PARES AVISAN. Antes era un interruptor de dos posiciones —este par o
    los veinte— y ninguna de las dos servía: veinte es ruido y uno se queda
    corto.

    ESTA PREFERENCIA SÍ SE GUARDA entre recargas, al revés que el encendido de
    la alarma, y no es incoherencia. El encendido no se restaura porque el
    navegador bloquearía el sonido y el botón estaría mintiendo; recordar qué
    pares te importan no promete nada que no se pueda cumplir.
  */
  const [seleccion, setSeleccion] = useState<string[]>(() => {
    const guardada = storage.read<string[]>(LS_PARES, []);
    return Array.isArray(guardada) && guardada.length ? guardada : [symbol];
  });

  const [marcos, setMarcos] = useState<string[]>(() => {
    const g = storage.read<string[]>(LS_MARCOS, []);
    return Array.isArray(g) && g.length ? g : [...MARCOS_POR_DEFECTO];
  });

  /*
    El guardado va FUERA del actualizador, por el mismo motivo que en la
    selección de pares tres líneas más abajo: React puede invocar la función
    que se le pasa a `setEstado` dos veces, así que escribir en disco ahí
    dentro es un efecto secundario que funciona por casualidad. La lista
    vigente se lee de un ref y se guarda una sola vez, donde se ve.
  */
  const marcosRef = useLatest(marcos);
  const alternarMarco = useCallback(
    (key: string) => {
      const prev = marcosRef.current;
      const next = prev.includes(key) ? prev.filter((x) => x !== key) : [...prev, key];
      setMarcos(next);
      storage.write(LS_MARCOS, next);
    },
    [marcosRef]
  );

  const guardar = useCallback((next: string[]) => {
    setSeleccion(next);
    storage.write(LS_PARES, next);
  }, []);

  /*
    El cálculo sale del actualizador de estado a propósito. Guardar en disco
    DENTRO de `setSeleccion` es un efecto secundario en una función que React
    puede invocar dos veces: funciona por casualidad, no por diseño. La lista
    vigente se lee de un ref y el guardado ocurre una sola vez, donde se ve.
  */
  const seleccionRef = useLatest(seleccion);
  const alternarPar = useCallback(
    (sym: string) => {
      const prev = seleccionRef.current;
      guardar(prev.includes(sym) ? prev.filter((x) => x !== sym) : [...prev, sym]);
    },
    [guardar, seleccionRef]
  );
  const elegirTodos = useCallback((syms: string[]) => guardar([...syms]), [guardar]);
  const elegirNinguno = useCallback(() => guardar([]), [guardar]);
  const elegirSoloActual = useCallback(() => guardar([symbol]), [guardar, symbol]);

  /*
    LA ALARMA SE ENCIENDE CON UN CLIC Y NO PUEDE SER DE OTRA FORMA. Ningún
    navegador deja sonar audio hasta que el usuario ha interactuado con la
    página, así que este clic hace dos cosas: guardar la preferencia y darle al
    navegador el gesto que exige. No se restaura activada al recargar: prometer
    un aviso que el navegador va a bloquear es peor que no prometerlo.
  */
  const alternarAlarma = useCallback(() => {
    setAlarmaOn((prev) => {
      if (prev) {
        storage.write(LS_ON, false);
        return false;
      }
      const ok = alarm.unlock();
      storage.write(LS_ON, ok);
      setPendiente(false);
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
  const optsRef = useLatest({ enabled: alarmaOn, seleccion, marcos });

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

    const { enabled, seleccion: elegidos, marcos: marcosOn } = optsRef.current;
    const nuevas = d.nuevas
      .map((id) => signals.find((x) => x.signal.id === id))
      .filter((s): s is SignalState => !!s)
      .filter((s) => s.signal.bornAt >= desde.current)
      .filter((s) => elegidos.includes(s.signal.symbol))
      .filter((s) => marcosOn.includes(s.signal.timeframe));
    if (!nuevas.length) return;

    setAvisos((prev) =>
      [
        ...nuevas.map((s) => ({
          id: s.signal.id,
          symbol: s.signal.symbol,
          timeframe: s.signal.timeframe,
          side: s.signal.side,
          at: s.signal.bornAt,
          seenAt: Date.now(),
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

  return {
    avisos,
    limpiarAvisos,
    alarmaOn,
    alarmaPendiente,
    alternarAlarma,
    seleccion,
    marcos,
    alternarMarco,
    alternarPar,
    elegirTodos,
    elegirNinguno,
    elegirSoloActual,
  };
}
