// ============================================================
// Utilidades de red compartidas: timeouts, JSON tipado, reintentos con
// backoff, y un WebSocket que detecta el fallo "abierto pero mudo".
// ============================================================

export class HttpError extends Error {
  constructor(public status: number, url: string) {
    super(`HTTP ${status} · ${url}`);
  }
}

export async function getJson<T>(url: string, timeoutMs = 9000): Promise<T> {
  const ctrl = new AbortController();
  const id = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new HttpError(r.status, url);
    return (await r.json()) as T;
  } finally {
    window.clearTimeout(id);
  }
}

export interface SocketOptions {
  url: string;
  /** mensaje(s) a enviar nada más abrir */
  onOpen?: (send: (data: string) => void) => void;
  onMessage: (raw: string) => void;
  /** se llama cuando la conexión se considera inservible tras varios intentos */
  onGiveUp?: () => void;
  /** ping periódico para mantener viva la conexión */
  keepAlive?: { everyMs: number; payload: string };
  /**
   * Si no llega ningún mensaje en este tiempo con el socket ABIERTO, se
   * considera muerto y se reconecta. Sin esto, una red que deja abrir el
   * socket pero filtra los datos (pasa con Binance Futuros en varias
   * regiones) deja la app anunciando "en vivo" con un feed congelado.
   */
  silenceMs?: number;
  giveUpAfter?: number;
}

export interface SocketHandle {
  close(): void;
  /** true si ha entregado al menos un mensaje desde que abrió */
  isDelivering(): boolean;
  stats(): { messages: number; reconnects: number; connectedMs: number };
}

export function openSocket(opts: SocketOptions): SocketHandle {
  const { url, onOpen, onMessage, onGiveUp, keepAlive, silenceMs = 20000, giveUpAfter = 3 } = opts;

  let ws: WebSocket | null = null;
  let closed = false;
  let attempts = 0;
  let deadOpens = 0;
  let gaveUp = false;
  let lastMsg = 0;
  let openedAt = 0;
  let connectedMs = 0;
  let messages = 0;
  let reconnects = 0;
  let watchdog = 0;
  let pinger = 0;

  const clearTimers = () => {
    window.clearInterval(watchdog);
    window.clearInterval(pinger);
  };

  const connect = () => {
    if (closed) return;
    lastMsg = 0;
    ws = new WebSocket(url);

    ws.onopen = () => {
      attempts = 0;
      openedAt = Date.now();
      onOpen?.((d) => {
        try {
          ws?.send(d);
        } catch {
          /* ya cerrado */
        }
      });
      if (keepAlive) {
        pinger = window.setInterval(() => {
          try {
            ws?.send(keepAlive.payload);
          } catch {
            /* ya cerrado */
          }
        }, keepAlive.everyMs);
      }
      watchdog = window.setInterval(() => {
        if (closed) return;
        const ref = lastMsg || openedAt;
        if (Date.now() - ref > silenceMs) {
          deadOpens += 1;
          try {
            ws?.close();
          } catch {
            /* ya cerrado */
          }
        }
      }, Math.max(3000, Math.floor(silenceMs / 3)));
    };

    ws.onmessage = (ev) => {
      lastMsg = Date.now();
      messages += 1;
      onMessage(String(ev.data));
    };

    ws.onerror = () => {
      try {
        ws?.close();
      } catch {
        /* ya cerrado */
      }
    };

    ws.onclose = () => {
      clearTimers();
      if (openedAt) {
        connectedMs += Date.now() - openedAt;
        openedAt = 0;
      }
      if (closed) return;
      reconnects += 1;
      attempts += 1;
      const neverDelivered = lastMsg === 0;
      if (neverDelivered && !gaveUp && (attempts >= giveUpAfter || deadOpens >= 2)) {
        gaveUp = true;
        onGiveUp?.();
      }
      window.setTimeout(connect, Math.min(20000, 1200 * attempts));
    };
  };

  connect();

  return {
    close() {
      closed = true;
      clearTimers();
      try {
        ws?.close();
      } catch {
        /* ya cerrado */
      }
    },
    isDelivering: () => lastMsg > 0,
    stats: () => ({
      messages,
      reconnects,
      connectedMs: connectedMs + (openedAt ? Date.now() - openedAt : 0),
    }),
  };
}
