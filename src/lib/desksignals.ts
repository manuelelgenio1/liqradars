// ============================================================
// Señales de la mesa: nacen, envejecen y caducan.
//
// La mesa enseñaba niveles que se recalculan solos. Eso no dice CUÁNDO
// apareció la oportunidad, y sin eso no se puede juzgar si sigue viva.
//
// CUÁNDO NACE UNA. Cuando el consenso de esa temporalidad CAMBIA de lado.
// Mientras siga diciendo lo mismo es la misma señal envejeciendo, no una
// nueva: refrescarla en cada vela sería fabricarse una oportunidad continua
// que no existe.
//
// LA PREGUNTA "¿PUEDO ENTRAR TODAVÍA?" TIENE RESPUESTA OBJETIVA.
//
// No depende de si la señal "sigue siendo buena" —eso no se puede saber— sino
// de aritmética: los niveles se fijaron al nacer, así que cada punto que el
// precio recorre hacia el objetivo es beneficio que ya no vas a cobrar,
// mientras el stop sigue donde estaba.
//
//   nace:  entrada 100 · stop 98 · objetivo 104  →  arriesgas 2 para ganar 4
//   luego: el precio va por 103                  →  arriesgas 5 para ganar 1
//
// Es la misma señal y ya no es la misma operación. Por eso lo que se muestra
// es el R:R QUE TENDRÍAS AHORA, no el que tenía cuando nació.
//
// CUÁNDO CADUCA
//   · pasadas 48 velas de SU temporalidad — el mismo criterio que la bitácora
//   · si el consenso se da la vuelta
//   · si el precio ya tocó el stop o el objetivo: la operación ocurrió, con o
//     sin ti
// ============================================================
import type { Side } from "./types";
import { costInR } from "./signals";

/** Velas que vive una señal antes de caducar. El mismo número que en la bitácora. */
export const MAX_BARS = 48;

export interface DeskSignal {
  id: string;
  symbol: string;
  timeframe: string;
  /** minutos de esa temporalidad, para calcular la caducidad */
  tfMinutes: number;
  side: Side;
  bornAt: number;
  /** precio en el instante en que nació. NO se actualiza. */
  entry: number;
  stop: number;
  target: number;
  /** fuerza del consenso al nacer, 0..1 */
  strength: number;
  /*
    Control emparejado: una moneda al aire con el MISMO stop y el mismo
    objetivo, lanzada en el mismo instante.

    Sin él, un 45 % de aciertos no significa nada: habría que saber qué
    porcentaje sale por azar con esos niveles y ese mercado, y eso cambia con
    la volatilidad. El control lo mide en las mismas condiciones.
  */
  controlSide: Side;
}

export type Freshness = "fresca" | "enfriando" | "tarde" | "caducada";

export interface SignalState {
  signal: DeskSignal;
  ageMs: number;
  expiresAt: number;
  remainingMs: number;
  /** cuánto ha recorrido hacia el objetivo, en R. Negativo = va en contra. */
  movedR: number;
  /** R:R que tendrías entrando AHORA con los mismos niveles */
  rrNow: number;
  /** coste en R entrando ahora */
  costRNow: number;
  freshness: Freshness;
  /** por qué caducó, si caducó */
  expiredReason: "tiempo" | "stop" | "objetivo" | null;
}

/*
  Umbrales de frescura, en R recorridas hacia el objetivo.

  0,25R deja el R:R en torno a 1,4 partiendo de 1,67 — una degradación que
  todavía se puede asumir. Pasado 0,6R el R:R cae por debajo de 1 y estarías
  arriesgando más de lo que queda por ganar, que es donde deja de tener
  sentido entrar por muy buena que fuera la señal.
*/
export const FRESCA_MAX_R = 0.25;
export const ENFRIANDO_MAX_R = 0.6;

/** Estado de una señal frente al precio actual. */
export function evaluateSignal(sig: DeskSignal, price: number, now: number): SignalState {
  const risk = Math.abs(sig.entry - sig.stop);
  const totalMs = MAX_BARS * sig.tfMinutes * 60_000;
  const expiresAt = sig.bornAt + totalMs;
  const ageMs = Math.max(0, now - sig.bornAt);
  const remainingMs = Math.max(0, expiresAt - now);

  const dir = sig.side === "long" ? 1 : -1;
  const movedR = risk > 0 && price > 0 ? ((price - sig.entry) * dir) / risk : NaN;

  // Lo que queda por ganar y lo que se arriesga, DESDE AQUÍ.
  const quedaGanar = Math.abs(sig.target - price);
  const quedaPerder = Math.abs(price - sig.stop);
  const rrNow = quedaPerder > 0 ? quedaGanar / quedaPerder : NaN;

  let expiredReason: SignalState["expiredReason"] = null;
  if (price > 0) {
    if (dir > 0 ? price <= sig.stop : price >= sig.stop) expiredReason = "stop";
    else if (dir > 0 ? price >= sig.target : price <= sig.target) expiredReason = "objetivo";
  }
  if (!expiredReason && remainingMs <= 0) expiredReason = "tiempo";

  let freshness: Freshness;
  if (expiredReason) freshness = "caducada";
  else if (!Number.isFinite(movedR)) freshness = "enfriando";
  else if (movedR <= FRESCA_MAX_R) freshness = "fresca";
  else if (movedR <= ENFRIANDO_MAX_R) freshness = "enfriando";
  else freshness = "tarde";

  return {
    signal: sig,
    ageMs,
    expiresAt,
    remainingMs,
    movedR,
    rrNow,
    costRNow: costInR(price, sig.stop),
    freshness,
    expiredReason,
  };
}

// ---------------- nacimiento y relevo ----------------

export interface FlipInput {
  symbol: string;
  timeframe: string;
  tfMinutes: number;
  side: Side | null;
  price: number;
  atr: number;
  strength: number;
  stopAtr: number;
  targetAtr: number;
}

/**
 * Decide si nace una señal nueva para esa temporalidad.
 *
 * Devuelve null cuando el lado no ha cambiado: eso es la misma señal
 * envejeciendo. Devolver una nueva en cada vela daría un contador que se
 * reinicia solo y no mediría nada.
 */
export function maybeBirth(
  inp: FlipInput,
  anterior: DeskSignal | undefined,
  now: number,
  rand: () => number = Math.random
): DeskSignal | null {
  if (!inp.side || !(inp.price > 0) || !(inp.atr > 0)) return null;
  // mismo lado y todavía viva: no hay relevo
  if (anterior && anterior.side === inp.side) {
    const vive = now < anterior.bornAt + MAX_BARS * anterior.tfMinutes * 60_000;
    if (vive) return null;
  }

  const stopDist = inp.atr * inp.stopAtr;
  const targetDist = inp.atr * inp.targetAtr;
  const moneda: Side = rand() > 0.5 ? "long" : "short";
  return {
    id: `desk-${inp.timeframe}-${now}-${Math.floor(rand() * 1e6)}`,
    symbol: inp.symbol,
    timeframe: inp.timeframe,
    tfMinutes: inp.tfMinutes,
    side: inp.side,
    bornAt: now,
    entry: inp.price,
    stop: inp.side === "long" ? inp.price - stopDist : inp.price + stopDist,
    target: inp.side === "long" ? inp.price + targetDist : inp.price - targetDist,
    strength: inp.strength,
    controlSide: moneda,
  };
}

/** Se descartan las que ya no aportan: caducadas y de otro par. */
export function prune(sigs: DeskSignal[], symbol: string, price: number, now: number): DeskSignal[] {
  return sigs.filter((s) => {
    if (s.symbol !== symbol) return false;
    return evaluateSignal(s, price, now).expiredReason === null;
  });
}
