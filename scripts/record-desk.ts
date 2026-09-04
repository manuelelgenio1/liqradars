/*
  ============================================================
  GRABADOR DEL REGISTRO DE SEÑALES.

  POR QUÉ EXISTE. El registro de aciertos vivía solo en el navegador, en el
  almacenamiento local de una pestaña. Eso significa que la única prueba capaz
  de cerrar la pregunta que quedó abierta —¿acierta la mesa en 4H?— dependía de
  que nadie cerrara una pestaña durante semanas. Cerrarla no daba error: daba
  un registro vacío y la falsa impresión de que no había pasado nada.

  Aquí corre en la nube cada hora, escribe en el propio repositorio y no le
  importa si tu ordenador está encendido.

  LO QUE LO HACE UNA PRUEBA Y NO UN ADORNO. Cada apunte queda escrito ANTES de
  conocerse el desenlace, con fecha, en un commit firmado que no se puede
  alterar sin dejar rastro. No hay muestra que recortar ni partición que
  elegir a posteriori. Es la única forma de medida de este proyecto que no
  admite trampa, ni mía ni de nadie.

  MISMO CÓDIGO QUE LA APP, y esto es deliberado: importa `computeLevels`,
  `maybeBirth` y `resolve` de `src/lib`. Reescribir la lógica aquí en JavaScript
  suelto habría ahorrado la instalación de dependencias y habría medido OTRA
  mesa: la copia se desincroniza al primer cambio y los números seguirían
  pareciendo creíbles. Ese es exactamente el fallo que este proyecto lleva
  veintinueve hipótesis intentando no cometer.

  SOLO VELAS CERRADAS. Binance devuelve la vela en curso como último elemento;
  se descarta siempre. La app usa el precio en vivo para el par que estás
  mirando, que para operar está bien pero para medir no: el precio en vivo
  hace que el mismo instante dé resultados distintos según cuándo mires. Aquí
  todo cuelga del cierre de la última vela terminada, así que dos ejecuciones
  sobre los mismos datos dan lo mismo.

  UNA DECISIÓN POR VELA. `maybeBirth` vuelve a abrir cuando la anterior ya se
  resolvió, aunque el lado no haya cambiado — en la app eso es correcto, porque
  la operación terminó de verdad y la siguiente entra a un precio nuevo. Con un
  reloj horario y precios de cierre saldrían cuatro señales idénticas por cada
  vela de 4H, que no son cuatro operaciones sino una contada cuatro veces. Por
  eso se recuerda la última vela juzgada de cada par y marco, y no se vuelve a
  mirar hasta que cierre una nueva. De paso hace la ejecución idempotente:
  repetirla dentro de la misma hora no cambia nada.

  MARCOS. 1H, 4H, diario y semanal. NO 5m ni 30m: con un despertar por hora,
  una señal de 5 minutos nace y muere entre dos ejecuciones y no habría forma
  honesta de anotarla. Antes que un registro incompleto de 5m, ninguno. La
  pregunta preregistrada que esto viene a contestar es la de 4H y diario.
  ============================================================
*/
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { computeLevels, STOP_ATR, TARGET_ATR } from "../src/lib/levels";
import { maybeBirth, latestFor, type DeskSignal } from "../src/lib/desksignals";
import { resolve as resolverSenal, append, type LedgerEntry } from "../src/lib/deskledger";
import { fetchUniverse } from "../src/lib/universe";
import { TIMEFRAMES, type Candle } from "../src/lib/types";

const FICHERO = "data/deskledger.json";
const MARCOS = ["1H", "4H", "1D", "1W"] as const;
const VELAS = 400;
const PARES = 20;
/** Tope del libro. A ~3 apuntes al día tarda años en llegar, pero un fichero
 *  que crece sin límite acaba siendo un problema de otro. */
const MAX_APUNTES = 20_000;

interface Estado {
  schema: number;
  source: string;
  marcos: string[];
  updatedAt: number;
  /** última vela YA JUZGADA de cada par y marco, indexada "SYM|TF" */
  ultimaBarra: Record<string, number>;
  abiertas: DeskSignal[];
  cerradas: LedgerEntry[];
}

const VACIO: Estado = {
  schema: 1,
  source: "binance-futures · solo velas cerradas · mismo codigo que la app",
  marcos: [...MARCOS],
  updatedAt: 0,
  ultimaBarra: {},
  abiertas: [],
  cerradas: [],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function klines(symbol: string, binanceTf: string): Promise<Candle[]> {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${binanceTf}&limit=${VELAS}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${symbol} ${binanceTf}`);
  const raw = (await res.json()) as unknown[][];
  const velas: Candle[] = raw.map((k) => ({
    t: Number(k[0]),
    o: +String(k[1]),
    h: +String(k[2]),
    l: +String(k[3]),
    c: +String(k[4]),
    v: +String(k[5]),
    delta: 0,
  }));
  // La última siempre está en curso: fuera. Sin esto, el "cierre" cambiaría
  // en cada ejecución y el registro dejaría de ser reproducible.
  velas.pop();
  return velas;
}

function leerEstado(): Estado {
  if (!existsSync(FICHERO)) return { ...VACIO };
  try {
    const d = JSON.parse(readFileSync(FICHERO, "utf8")) as Partial<Estado>;
    return {
      ...VACIO,
      ...d,
      ultimaBarra: d.ultimaBarra ?? {},
      abiertas: d.abiertas ?? [],
      cerradas: d.cerradas ?? [],
    };
  } catch {
    // Un fichero corrupto no puede tumbar el grabador, pero tampoco se
    // sobreescribe en silencio: se avisa y se sigue desde cero.
    console.error("aviso: el registro no se pudo leer, se empieza de nuevo");
    return { ...VACIO };
  }
}

function salida(clave: string, valor: string): void {
  const f = process.env.GITHUB_OUTPUT;
  if (f) appendFileSync(f, `${clave}=${valor}\n`);
  else console.log(`${clave}=${valor}`);
}

async function main(): Promise<void> {
  const estado = leerEstado();
  const antesAbiertas = estado.abiertas.length;
  const antesCerradas = estado.cerradas.length;

  const universo = await fetchUniverse(PARES);
  if (!universo.length) throw new Error("el universo vino vacio");
  console.log(`${universo.length} pares · ${MARCOS.length} marcos`);

  let nacidas = 0;
  let fallos = 0;

  for (const u of universo) {
    for (const key of MARCOS) {
      const tf = TIMEFRAMES.find((t) => t.key === key);
      if (!tf) continue;
      let velas: Candle[];
      try {
        velas = await klines(u.symbol, tf.binance);
      } catch (e) {
        // Un par que falla no puede tumbar la ejecución entera: la de la hora
        // siguiente lo recupera, porque todo cuelga de velas cerradas.
        console.error(`  ${u.symbol} ${key}: ${(e as Error).message}`);
        fallos++;
        continue;
      }
      if (velas.length < 60) continue;
      await sleep(80);

      const ultima = velas[velas.length - 1];

      // 1. cerrar lo que las velas ya resolvieron
      const cerradasAhora: LedgerEntry[] = [];
      estado.abiertas = estado.abiertas.filter((s) => {
        if (s.symbol !== u.symbol || s.timeframe !== key) return true;
        const apunte = resolverSenal(s, velas);
        if (!apunte) return true;
        cerradasAhora.push(apunte);
        return false;
      });
      if (cerradasAhora.length) estado.cerradas = append(estado.cerradas, cerradasAhora);

      // 2. una decisión por vela, y solo cuando hay una nueva cerrada
      const clave = `${u.symbol}|${key}`;
      if ((estado.ultimaBarra[clave] ?? 0) >= ultima.t) continue;
      estado.ultimaBarra[clave] = ultima.t;

      const fila = computeLevels(key, tf.label, velas, tf.minutes);
      if (!fila.ready) continue;

      /*
        La señal se fecha en la APERTURA de la última vela cerrada, no en su
        cierre. Parece un detalle y no lo es: `resolve` toma como futuras las
        velas con `t > bornAt`, así que fechar en el cierre —que coincide con
        la apertura de la siguiente— se saltaría la primera vela de vida de la
        operación. Con la apertura, la resolución empieza justo en la vela
        siguiente, que es donde empieza de verdad.
      */
      const nace = maybeBirth(
        {
          symbol: u.symbol,
          timeframe: key,
          tfMinutes: tf.minutes,
          side: fila.side,
          price: fila.price,
          atr: fila.atr,
          strength: fila.strength,
          stopAtr: STOP_ATR,
          targetAtr: TARGET_ATR,
        },
        latestFor(estado.abiertas, u.symbol, key),
        ultima.t
      );
      if (nace) {
        estado.abiertas.unshift(nace);
        nacidas++;
      }
    }
  }

  if (estado.cerradas.length > MAX_APUNTES) {
    estado.cerradas = estado.cerradas.slice(-MAX_APUNTES);
  }
  estado.updatedAt = Date.now();
  estado.marcos = [...MARCOS];

  mkdirSync(dirname(FICHERO), { recursive: true });
  writeFileSync(FICHERO, `${JSON.stringify(estado, null, 2)}\n`, "utf8");

  const nuevasCerradas = estado.cerradas.length - antesCerradas;
  const cambio = nacidas > 0 || nuevasCerradas > 0 || antesAbiertas !== estado.abiertas.length;
  const resumen = cambio
    ? `${nacidas} nuevas · ${nuevasCerradas} cerradas · ${estado.abiertas.length} vivas`
    : `latido · sin novedad (${estado.abiertas.length} vivas, ${estado.cerradas.length} cerradas)`;

  console.log(resumen + (fallos ? ` · ${fallos} descargas fallidas` : ""));
  salida("changed", String(cambio));
  salida("summary", resumen);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
