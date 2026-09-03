import { useEffect, useMemo, useState } from "react";
import { useLatest } from "./useLatest";
import { useNow } from "./useNow";
import type { MarketApi } from "./useMarket";
import {
  analyze,
  loadStudy,
  recordBurst,
  resolvePending,
  type LiqStudy,
  type StudyReport,
} from "../lib/liqstudy";
import { emptyServer, fetchServerStudy, SERVER_URL, type ServerStudy } from "../lib/liqserver";

/*
  Grabadora de estallidos de liquidaciones.

  No hay histórico gratuito de liquidaciones en ninguna parte, así que el
  registro se construye hacia delante: se vigila el flujo en vivo, se anota
  cada estallido con el precio de ese instante, y una hora después se lee el
  resultado contra velas reales.

  Solo graba cuando la fuente entrega de verdad (`hasCompleteSource`). Anotar
  un "no hubo liquidaciones" que en realidad era un socket mudo contaminaría
  la muestra con silencio disfrazado de dato.
*/

/** Ventana en la que se agregan liquidaciones para considerarlas un mismo estallido. */
const BURST_WINDOW_MS = 60_000;
const TICK_MS = 5_000;

export interface LiqStudyApi {
  /** lo grabado por ESTE navegador, solo con la pestaña abierta */
  study: LiqStudy;
  report: StudyReport;
  /** lo grabado en servidor cada hora: la muestra que manda */
  server: ServerStudy;
  serverReport: StudyReport;
  /** nocional del último minuto, por lado */
  recent: { long: number; short: number };
}

export function useLiqStudy(api: MarketApi): LiqStudyApi {
  const [study, setStudy] = useState<LiqStudy>(() => loadStudy());

  // Los datos vivos cambian cada pocos cientos de ms. Si entraran como
  // dependencias del efecto, el temporizador se destruiría y volvería a
  // crearse sin llegar a disparar nunca. `useLatest` los deja accesibles sin
  // escribir en el ref durante el render.
  const ref = useLatest({ api, study });

  /*
    `ahora` viene de estado, no de `Date.now()` en el render.

    No es solo pureza: con `Date.now()` este memo solo se recalculaba cuando
    llegaban liquidaciones NUEVAS, así que la ventana no se deslizaba sola. Un
    minuto tranquilo dejaba dentro eventos ya caducados, y el nocional del
    "último minuto" se quedaba inflado hasta que entrara algo.
  */
  const ahora = useNow(5_000);

  const recent = useMemo(() => {
    const desde = ahora - BURST_WINDOW_MS;
    let long = 0;
    let short = 0;
    for (const e of api.liqEvents) {
      if (e.ts < desde) continue;
      if (e.side === "long") long += e.usd;
      else short += e.usd;
    }
    return { long, short };
  }, [api.liqEvents, ahora]);

  const recentRef = useLatest(recent);

  useEffect(() => {
    const tick = () => {
      const { api: a, study: s } = ref.current;
      let next = s;

      // 1 · anotar un estallido si lo hay
      if (a.liqTotals.hasCompleteSource && Number.isFinite(a.price)) {
        const { long, short } = recentRef.current;
        next = recordBurst(next, a.symbol, Date.now(), a.price, long, short);
      }

      // 2 · cerrar lo que ya venció, contra velas reales
      const velas = a.snap.warm.length ? a.snap.warm : a.snap.candles;
      if (velas.length) next = resolvePending(next, a.symbol, velas);

      if (next !== s) setStudy(next);
    };

    const id = window.setInterval(tick, TICK_MS);
    tick();
    return () => window.clearInterval(id);
    // Los `*Ref` vienen de `useLatest`, que devuelve un `useRef`: el OBJETO es
  // siempre el mismo, así que incluirlos NO relanza el efecto. Lo que lo
  // relanzaría es meter el valor, y evitarlo es el motivo del ref.
  }, [recentRef, ref]);

  // ---------- registro de servidor ----------
  /*
    El estado inicial ya dice la verdad.

    Antes arrancaba vacío y un efecto lo corregía a "sin configurar" con un
    `setServer`, lo que provocaba un render de más con un estado que nunca fue
    cierto. `SERVER_URL` es una constante de módulo: se sabe desde el primer
    render.
  */
  const [server, setServer] = useState<ServerStudy>(() =>
    SERVER_URL ? emptyServer() : { ...emptyServer(), error: "sin configurar" }
  );

  useEffect(() => {
    if (!SERVER_URL) return;
    const ac = new AbortController();
    const traer = () => {
      fetchServerStudy(ac.signal).then(setServer).catch(() => {
        /* abortado al desmontar */
      });
    };
    traer();
    // El grabador escribe una vez por hora; cada diez minutos sobra de largo.
    const id = window.setInterval(traer, 10 * 60_000);
    return () => {
      ac.abort();
      window.clearInterval(id);
    };
  }, []);

  const report = useMemo(() => analyze(study), [study]);
  const serverReport = useMemo(() => analyze(server.study), [server.study]);

  return { study, report, server, serverReport, recent };
}
