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

/**
 * URL del registro. Se configura en Vercel como variable de entorno
 * `VITE_LIQSTUDY_URL`. Es una URL pública, no un secreto: puede ir en el
 * paquete del navegador sin problema.
 */
export const SERVER_URL = (import.meta.env.VITE_LIQSTUDY_URL as string | undefined)?.trim() || "";

export interface ServerStudy {
  study: LiqStudy;
  updatedAt: number;
  runs: number;
  /** null mientras no se ha intentado; string con el motivo si falló */
  error: string | null;
}

export const emptyServer = (): ServerStudy => ({
  study: { obs: [], lastBurst: {} },
  updatedAt: 0,
  runs: 0,
  error: null,
});

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
    const j = (await r.json()) as { obs?: unknown[]; updatedAt?: number; runs?: number };
    const obs = Array.isArray(j.obs) ? j.obs.filter(sane) : [];
    return {
      study: { obs, lastBurst: {} },
      updatedAt: Number(j.updatedAt) || 0,
      runs: Number(j.runs) || 0,
      error: null,
    };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    return { ...emptyServer(), error: "sin respuesta" };
  }
}
