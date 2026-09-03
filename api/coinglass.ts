// ============================================================
// Proxy OPCIONAL para Coinglass (Vercel Function, runtime Node).
//
// La app NO lo necesita: funciona entera con Binance, OKX y Bybit, que son
// gratis y sin clave. Esto solo existe por si algún día contratas un plan de
// Coinglass (no tienen tier gratuito; el más barato son $29/mes).
//
// Por qué un proxy y no llamar desde el navegador:
//   1. Coinglass responde 403 al preflight CORS — el navegador bloquea la
//      llamada directa, tengas clave o no. Comprobado.
//   2. Una variable VITE_* acaba dentro del bundle público: cualquiera que
//      abra la web leería tu clave. Aquí vive solo en el servidor.
//
// Configuración:
//   Vercel → Settings → Environment Variables → COINGLASS_API_KEY
//   Local  → .env.local con COINGLASS_API_KEY=...
//
// Uso desde el front:  /api/coinglass?path=/api/futures/liquidation/order&symbol=BTCUSDT
// ============================================================
import type { VercelRequest, VercelResponse } from "@vercel/node";

const UPSTREAM = "https://open-api-v4.coinglass.com";

/** Solo estas rutas son alcanzables: evita convertir el proxy en un relé abierto. */
const ALLOWED = new Set([
  "/api/futures/liquidation/order",
  "/api/futures/liquidation/history",
  "/api/futures/liquidation/exchange-list",
  "/api/futures/liquidation/aggregated-history",
  "/api/futures/liquidation/aggregated-heatmap/model2",
  "/api/futures/open-interest/exchange-list",
  "/api/futures/open-interest/aggregated-history",
  "/api/futures/funding-rate/exchange-list",
  "/api/futures/taker-buy-sell-volume/history",
]);

/** TTL por ruta, en segundos. Con 30 req/min del plan básico, cachear no es opcional. */
const TTL: Record<string, number> = {
  "/api/futures/liquidation/order": 10,
  "/api/futures/liquidation/exchange-list": 60,
  "/api/futures/liquidation/history": 300,
  "/api/futures/liquidation/aggregated-history": 300,
  "/api/futures/liquidation/aggregated-heatmap/model2": 600,
  "/api/futures/open-interest/exchange-list": 300,
  "/api/futures/open-interest/aggregated-history": 300,
  "/api/futures/funding-rate/exchange-list": 300,
  "/api/futures/taker-buy-sell-volume/history": 300,
};

interface CacheEntry {
  at: number;
  status: number;
  body: string;
}
/** Caché en memoria de la instancia. Se pierde en frío; es suficiente. */
const cache = new Map<string, CacheEntry>();

const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const key = process.env.COINGLASS_API_KEY;

  if (!key) {
    // No es un error: es el estado normal del proyecto. El front lo interpreta
    // como "Coinglass no disponible" y sigue con los exchanges gratuitos.
    res.status(501).json({
      enabled: false,
      reason: "COINGLASS_API_KEY no configurada. La app funciona sin ella usando Binance, OKX y Bybit.",
    });
    return;
  }

  const path = first(req.query.path);
  if (!ALLOWED.has(path)) {
    res.status(400).json({ error: "ruta no permitida", allowed: [...ALLOWED] });
    return;
  }

  const forward = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) {
    if (k === "path") continue;
    forward.set(k, first(v));
  }
  const target = `${UPSTREAM}${path}?${forward}`;

  const ttl = (TTL[path] ?? 60) * 1000;
  const hit = cache.get(target);
  if (hit && Date.now() - hit.at < ttl) {
    res.status(hit.status).setHeader("x-cache", "HIT");
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.send(hit.body);
    return;
  }

  try {
    const upstream = await fetch(target, {
      headers: { "CG-API-KEY": key, accept: "application/json" },
    });
    const body = await upstream.text();
    cache.set(target, { at: Date.now(), status: upstream.status, body });
    res.status(upstream.status);
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("x-cache", "MISS");
    res.setHeader("cache-control", `public, max-age=${Math.floor(ttl / 1000)}`);
    res.send(body);
  } catch (e) {
    res.status(502).json({ error: "coinglass inalcanzable", detail: String((e as Error).message) });
  }
}
