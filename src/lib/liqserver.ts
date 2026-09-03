// ============================================================
// Registro de liquidaciones grabado en servidor.
//
// El grabador del navegador (`liqstudy.ts`) solo anota mientras hay una
// pestaña abierta, y eso sesga la muestra: solo entra lo que pasa cuando
// alguien mira. El de servidor corre cada hora por su cuenta y no depende de
// nadie, así que es el registro que MANDA.
//
// Los dos se muestran, pero NO se mezclan: el de servidor ve solo OKX, el del
// navegador ve además Binance y Bybit. Sumarlos daría una muestra con dos
// definiciones distintas de "estallido" — un número más grande y peor.
//
// Se lee de raw.githubusercontent, no del propio despliegue, para que llegue
// fresco sin tener que reconstruir la app en cada grabación.
// ============================================================
import type { LiqObservation, LiqStudy } from "./liqstudy";

/*
  URL del registro.

  Va escrita aquí en vez de depender solo de una variable de entorno, y es a
  propósito: no es un secreto —apunta a un archivo público del repositorio— y
  dejarla en la configuración del alojamiento la vuelve frágil. Se comprobó
  que `build.env` de vercel.json NO se aplica cuando el paquete se construye
  en local, así que un despliegue desde la línea de órdenes se quedaría sin
  registro y sin avisar.

  `VITE_LIQSTUDY_URL` sigue funcionando por encima, para quien bifurque el
  proyecto y grabe su propio registro.
*/
const POR_DEFECTO = "https://raw.githubusercontent.com/manuelelgenio1/liqradars/main/data/liqstudy.json";

export const SERVER_URL =
  (import.meta.env.VITE_LIQSTUDY_URL as string | undefined)?.trim() || POR_DEFECTO;

export interface ServerStudy {
  study: LiqStudy;
  /** última vez que el grabador COMPROBÓ, haya encontrado algo o no */
  updatedAt: number;
  /** última vez que entró un dato de verdad */
  lastDataAt: number;
  runs: number;
  /** null mientras no se ha intentado; string con el motivo si falló */
  error: string | null;
}

export const emptyServer = (): ServerStudy => ({
  study: { obs: [], lastBurst: {} },
  updatedAt: 0,
  lastDataAt: 0,
  runs: 0,
  error: null,
});

/*
  El grabador deja constancia cada seis horas como mucho, aunque no encuentre
  nada. Si `updatedAt` se queda más atrás que eso con holgura, es que dejó de
  correr — y hay que decirlo, porque un registro congelado que parece vivo es
  peor que no tener registro.
*/
export const STALE_MS = 9 * 60 * 60_000;

export const isStale = (s: ServerStudy, now: number): boolean =>
  !s.error && s.updatedAt > 0 && now - s.updatedAt > STALE_MS;

/** Descarta cualquier fila que no cuadre. Un registro corrupto no debe contaminar el análisis. */
function sane(o: unknown): o is LiqObservation {
  if (!o || typeof o !== "object") return false;
  const x = o as Record<string, unknown>;
  return (
    typeof x.id === "string" &&
    Number.isFinite(x.ts) &&
    typeof x.symbol === "string" &&
    (x.dominant === "long" || x.dominant === "short") &&
    Number.isFinite(x.price) &&
    (x.price as number) > 0 &&
    (x.fwdPct === undefined || Number.isFinite(x.fwdPct))
  );
}

export async function fetchServerStudy(signal?: AbortSignal): Promise<ServerStudy> {
  if (!SERVER_URL) {
    return { ...emptyServer(), error: "sin configurar" };
  }
  try {
    const r = await fetch(SERVER_URL, { signal, cache: "no-store" });
    if (!r.ok) return { ...emptyServer(), error: `HTTP ${r.status}` };
    const j = (await r.json()) as {
      obs?: unknown[];
      updatedAt?: number;
      lastDataAt?: number;
      runs?: number;
    };
    const obs = Array.isArray(j.obs) ? j.obs.filter(sane) : [];
    const updatedAt = Number(j.updatedAt) || 0;
    return {
      study: { obs, lastBurst: {} },
      updatedAt,
      // registros antiguos no traen lastDataAt: se cae a updatedAt
      lastDataAt: Number(j.lastDataAt) || updatedAt,
      runs: Number(j.runs) || 0,
      error: null,
    };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    return { ...emptyServer(), error: "sin respuesta" };
  }
}
