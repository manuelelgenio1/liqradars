// ============================================================
// Aviso sonoro cuando aparece una señal nueva.
//
// DOS PROBLEMAS QUE PARECEN TONTOS Y NO LO SON:
//
// 1. La primera vez NO debe sonar. Las señales viven en disco, así que al
//    recargar la página la lista llega llena. Sin sembrar el estado, cada
//    recarga dispararía una ráfaga de pitidos por señales que ya conocías.
//    Por eso `detect` distingue "todavía no sé nada" (null) de "sé que no hay
//    ninguna" ([]).
//
// 2. Una señal puede DESAPARECER Y VOLVER. El estado se deriva del precio: si
//    roza el stop y se recupera antes de que la poda la retire, sale de la
//    lista y vuelve a entrar. Si olvidáramos los ids al vuelo, eso sonaría dos
//    veces. Por eso se recuerdan aunque ya no estén, con un tope para que la
//    lista no crezca sin fin.
//
// EL SONIDO SE SINTETIZA, no se descarga: sin fichero que empaquetar y sin
// petición que pueda fallar. Sube para largo y baja para corto, así sabes la
// dirección sin mirar la pantalla — que es justo el caso en el que sirve una
// alarma.
// ============================================================
import type { Side } from "./types";

/**
 * Cuántos ids YA DESAPARECIDOS se recuerdan.
 *
 * El tope NO se aplica a los que siguen presentes, y esa distinción arregla un
 * fallo real: con ~100 señales vivas y casi cien nacimientos cada diez
 * minutos, en media hora se agotaban los 300 huecos. Las señales viejas pero
 * VIVAS caían de la lista y volvían a avisar como si acabaran de nacer.
 */
export const MAX_RECORDADAS = 300;

export interface Deteccion {
  /** ids conocidos tras esta pasada */
  seen: string[];
  /** los que no estaban antes */
  nuevas: string[];
}

/**
 * Compara la lista actual con lo ya conocido.
 *
 * `seen === null` significa que es la primera pasada: siembra y NO avisa.
 * Devuelve la MISMA referencia de `seen` si no hay novedad, para no provocar
 * repintados inútiles.
 */
export function detect(seen: string[] | null, ids: string[]): Deteccion {
  if (seen === null) return { seen: [...ids], nuevas: [] };
  const conocidos = new Set(seen);
  const nuevas = ids.filter((id) => !conocidos.has(id));
  if (!nuevas.length) return { seen, nuevas };

  // Lo que sigue presente NUNCA se olvida; el tope solo poda lo que ya no está.
  const presentes = new Set(ids);
  const todos = [...nuevas, ...seen];
  const vivos = todos.filter((id) => presentes.has(id));
  const idos = todos.filter((id) => !presentes.has(id));
  return { seen: [...vivos, ...idos.slice(0, MAX_RECORDADAS)], nuevas };
}

// ---------------- sonido ----------------

type Ctor = typeof AudioContext;
let ctx: AudioContext | null = null;

function crearCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const W = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  const C = W.AudioContext ?? W.webkitAudioContext;
  if (!C) return null;
  try {
    return new C();
  } catch {
    return null;
  }
}

/**
 * Prepara el audio. HAY QUE LLAMARLO DESDE UN CLIC.
 *
 * Los navegadores no dejan sonar nada hasta que el usuario ha interactuado con
 * la página. Por eso la alarma se activa con un botón: ese clic es a la vez la
 * preferencia y el permiso. Sin él, el primer aviso se perdería en silencio.
 */
export function unlock(): boolean {
  ctx ??= crearCtx();
  if (!ctx) return false;
  if (ctx.state === "suspended") void ctx.resume();
  return true;
}

export function isReady(): boolean {
  return ctx !== null && ctx.state === "running";
}

/** Solo para las pruebas: devuelve el módulo a su estado inicial. */
export function reset(): void {
  ctx = null;
}

function tono(freq: number, inicio: number, dur: number): void {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, inicio);
  // Envolvente: sin ella el corte seco del oscilador suena a chasquido.
  gain.gain.setValueAtTime(0, inicio);
  gain.gain.linearRampToValueAtTime(0.18, inicio + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.001, inicio + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(inicio);
  osc.stop(inicio + dur + 0.02);
}

/** Dos notas: ascendentes para largo, descendentes para corto. */
export function beep(side: Side): void {
  if (!ctx || ctx.state !== "running") return;
  const t0 = ctx.currentTime;
  const [a, b] = side === "long" ? [660, 990] : [660, 440];
  tono(a, t0, 0.1);
  tono(b, t0 + 0.11, 0.16);
}
