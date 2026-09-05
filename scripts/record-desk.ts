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

  UNA DECISIÓN POR VELA, NI MÁS NI MENOS. `maybeBirth` vuelve a abrir cuando la
  anterior ya se resolvió, aunque el lado no haya cambiado — en la app eso es
  correcto, porque la operación terminó de verdad y la siguiente entra a un
  precio nuevo. Con un reloj horario y precios de cierre saldrían cuatro
  señales idénticas por cada vela de 4H, que no son cuatro operaciones sino una
  contada cuatro veces. Por eso se recuerda la última vela juzgada de cada par
  y marco.

  Y AL REVÉS, TAMPOCO MENOS DE UNA: el cron de GitHub se salta ejecuciones —en
  este repositorio, uno horario corre de hecho cada tres horas— así que juzgar
  solo la última vela cerrada perdería velas en cada hueco. Se recuperan las
  atrasadas, cada una con las velas que había HASTA ella y ni una más, que es
  lo que hace que la decisión sea la que se habría tomado entonces.

  Las dos reglas juntas dan lo que hace falta: exactamente un juicio por vela,
  llegue el despertador puntual o con tres horas de retraso. Y de paso la
  ejecución es idempotente — repetirla no cambia nada.

  BINANCE NO DEJA DESDE LA NUBE, Y ESO SE DESCUBRIÓ AQUÍ. La primera ejecución
  en GitHub falló con 451 —«no disponible por razones legales»—: Binance
  bloquea las IP de los runners. Desde un ordenador de casa responde 200.
  Se intenta Binance primero, porque es la fuente de la app, y si bloquea se
  cae a OKX multiplicando los pares 1000X para que las velas queden en la
  MISMA escala; mezclarlas sin multiplicar no daría un error, daría pérdidas
  completas perfectamente formateadas.

  De paso destapó que el grabador de liquidaciones llevaba 37 horas roto por lo
  mismo, informando en verde con un `catch` vacío: dos observaciones suyas
  seguían sin resolverse con un horizonte de una hora.

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
import { OKX_BAR, okxCandlesUrl, okxPar, parseOkxCandles } from "../src/lib/okxklines";
import { TIMEFRAMES, type Candle } from "../src/lib/types";

const FICHERO = "data/deskledger.json";
const MARCOS = ["1H", "4H", "1D", "1W"] as const;
const VELAS = 400;
const PARES = 20;
/*
  CUÁNTAS VELAS ATRASADAS SE RECUPERAN, y por qué hay un tope.

  El cron de GitHub es "mejor esfuerzo": se retrasa y se salta ejecuciones bajo
  carga. Medido en este mismo repositorio, el grabador de liquidaciones tiene
  cron horario y corre una vez cada TRES horas. Juzgando solo la última vela
  cerrada se perderían velas de 1H en cada hueco, y de 4H en cuanto el hueco
  pase de cinco horas. Así que se recuperan todas las que quedaron sin juzgar.

  EL TOPE ESTÁ PARA QUE ESTO NO SE CONVIERTA EN HISTORIA RELLENADA. Un registro
  vale como prueba porque cada apunte se escribió ANTES de conocerse su
  desenlace. Recuperar unas pocas velas atrasadas mantiene esa propiedad —la
  regla lleva días escrita en git, así que no se pudo elegir viendo el
  resultado— pero recuperar cuatrocientas sería reconstruir el pasado, que es
  exactamente el tipo de dato que este proyecto ya tiene de sobra y que no
  cierra nada. Si el hueco pasa del tope, se salta y se anota.

  Un par que se ve por primera vez tampoco se rellena: se le marca la vela
  actual y a partir de ahí cuenta hacia delante.
*/
const MAX_ATRASO = 24;
/** Tope del libro. A ~3 apuntes al día tarda años en llegar, pero un fichero
 *  que crece sin límite acaba siendo un problema de otro. */
const MAX_APUNTES = 20_000;

interface Estado {
  schema: number;
  source: string;
  marcos: string[];
  updatedAt: number;
  /** cuándo corrió por última vez, haya encontrado algo o no */
  lastRunAt: number;
  /*
    QUÉ FALLÓ EN LA ÚLTIMA VUELTA, escrito AQUÍ y no solo en los registros de
    GitHub. Los registros de Actions piden autenticación para leerse, así que
    un fallo en la nube era invisible desde fuera: la ejecución salía en rojo y
    no había forma de saber por qué sin entrar a mano. Dejarlo en el fichero lo
    pone en el historial de git, donde se lee sin permisos y queda fechado.
  */
  lastError: string | null;
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
  lastRunAt: 0,
  lastError: null,
  ultimaBarra: {},
  abiertas: [],
  cerradas: [],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function klinesBinance(symbol: string, binanceTf: string): Promise<Candle[]> {
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

async function klinesOkx(symbol: string, key: string): Promise<Candle[]> {
  const par = okxPar(symbol);
  const bar = OKX_BAR[key];
  if (!par || !bar) throw new Error(`sin equivalente en OKX: ${symbol} ${key}`);
  const res = await fetch(okxCandlesUrl(par.instId, bar, 300), { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`OKX HTTP ${res.status} en ${par.instId} ${bar}`);
  const j = (await res.json()) as { code?: string; msg?: string; data?: unknown };
  if (j.code && j.code !== "0") throw new Error(`OKX code ${j.code} ${j.msg ?? ""} en ${par.instId}`);
  // El multiplicador es lo que hace que estas velas sean intercambiables con
  // las de Binance. Sin él, un par 1000X mezclaría dos escalas de precio en el
  // mismo registro y las señales se resolverían contra la escala equivocada.
  return parseOkxCandles(j.data, par.mult);
}

/*
  BINANCE PRIMERO, OKX SI NO DEJA.

  Binance responde 451 a las IP de los runners de GitHub — comprobado: desde
  aquí da 200, desde la nube da 451. Se intenta igualmente primero porque es la
  fuente que usa la app, y solo si falla se cae a OKX, cuyas velas se
  multiplican para quedar en la misma escala.

  Se prueba en este orden y no al revés para que, si algún día Binance vuelve a
  dejar, el registro vuelva solo a la fuente de la app sin tocar nada.
*/
let binanceCaido = 0;

async function klines(symbol: string, binanceTf: string, key: string): Promise<{ velas: Candle[]; via: string }> {
  try {
    // Tres fallos seguidos y se deja de insistir en esta vuelta: cuando
    // Binance bloquea, bloquea TODO, y probar ochenta veces solo alarga la
    // ejecucion. El contador se reinicia en la siguiente, para que vuelva sola
    // a la fuente de la app en cuanto deje de bloquear.
    if (binanceCaido >= 3) throw new Error("binance descartado en esta vuelta");
    const velas = await klinesBinance(symbol, binanceTf);
    binanceCaido = 0;
    return { velas, via: "binance" };
  } catch (e) {
    binanceCaido++;
    try {
      return { velas: await klinesOkx(symbol, key), via: "okx" };
    } catch (e2) {
      // El mensaje lleva los DOS motivos porque es lo que acaba en `lastError`
      // y en el fichero: saber que falló el respaldo sin saber qué falló antes
      // no serviría de nada. `cause` conserva además la pila del segundo.
      throw new Error(`${(e as Error).message} | respaldo: ${(e2 as Error).message}`, { cause: e2 });
    }
  }
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
  // Copia intacta del estado de partida, para saber al final si cambió algo.
  const antes: Estado = JSON.parse(JSON.stringify(estado)) as Estado;
  const antesAbiertas = estado.abiertas.length;
  const antesCerradas = estado.cerradas.length;

  const errores: string[] = [];
  let nacidas = 0;
  let fallos = 0;
  let saltadas = 0;
  /** de qué fuente salió cada descarga, para que quede claro qué se está midiendo */
  const via: Record<string, number> = {};

  /*
    EL UNIVERSO NO PUEDE SER UN PUNTO ÚNICO DE FALLO.

    Era la primera llamada de red y no estaba protegida: si Binance no
    respondía —y desde un runner de GitHub puede no responder aunque desde
    aquí sí— la ejecución entera moría antes de anotar una sola vela. Con
    reintentos, y si aun así no hay universo, se sigue con los pares que ya
    están en el registro. Un grabador que solo funciona cuando todo va bien no
    sirve para dejarlo corriendo semanas.
  */
  let pares: string[] = [];
  for (let intento = 1; intento <= 3 && !pares.length; intento++) {
    try {
      pares = (await fetchUniverse(PARES)).map((u) => u.symbol);
    } catch (e) {
      const m = `universo intento ${intento}: ${(e as Error).message}`;
      console.error(m);
      if (intento === 3) errores.push(m);
      else await sleep(3000);
    }
  }
  let fuente = "universo del dia";
  if (!pares.length) {
    /*
      El universo sale del ticker de Binance, que desde la nube da 451 igual
      que las velas. No se sustituye por el de OKX a propósito: cambiar la
      LISTA DE PARES a mitad de un registro cambiaría lo que se está midiendo,
      y el orden por volumen de un mercado no es el del otro. Los pares que ya
      están en el registro son los correctos precisamente porque son los que se
      venían midiendo.
    */
    pares = [...new Set(Object.keys(estado.ultimaBarra).map((k) => k.split("|")[0]))];
    fuente = "pares ya conocidos (el universo no respondio)";
  }
  if (!pares.length) {
    errores.push("sin universo y sin pares conocidos: no hay nada que grabar");
  }
  console.log(`${pares.length} pares · ${MARCOS.length} marcos · ${fuente}`);

  for (const symbol of pares) {
    for (const key of MARCOS) {
      const tf = TIMEFRAMES.find((t) => t.key === key);
      if (!tf) continue;
      let velas: Candle[];
      try {
        const r = await klines(symbol, tf.binance, key);
        velas = r.velas;
        via[r.via] = (via[r.via] ?? 0) + 1;
      } catch (e) {
        // Un par que falla no puede tumbar la ejecución entera: la de la hora
        // siguiente lo recupera, porque todo cuelga de velas cerradas.
        const m = `${symbol} ${key}: ${(e as Error).message}`;
        console.error(`  ${m}`);
        if (fallos < 3) errores.push(m);
        fallos++;
        continue;
      }
      if (velas.length < 60) continue;
      await sleep(80);

      const clave = `${symbol}|${key}`;
      const visto = estado.ultimaBarra[clave] ?? 0;

      /*
        QUÉ VELAS HAY QUE JUZGAR. Todas las cerradas desde la última que se
        juzgó. Primera vez que se ve el par: solo la actual, sin rellenar hacia
        atrás. Hueco mayor que el tope: se salta a la actual y se avisa.
      */
      let pendientes = visto === 0 ? [velas.length - 1] : [];
      if (visto > 0) {
        for (let i = 0; i < velas.length; i++) if (velas[i].t > visto) pendientes.push(i);
        if (pendientes.length > MAX_ATRASO) {
          saltadas += pendientes.length - MAX_ATRASO;
          pendientes = pendientes.slice(-MAX_ATRASO);
        }
      }
      if (!pendientes.length) continue;

      for (const i of pendientes) {
        /*
          Las velas HASTA esa, y ni una más. Es lo que hace que la decisión sea
          la que se habría tomado en ese momento: `computeLevels` mira la
          última del trozo que se le pasa, así que recortar aquí es lo que
          impide mirar al futuro al recuperar el atraso.
        */
        const trozo = velas.slice(0, i + 1);

        // 1. cerrar lo que las velas ya resolvieron, con lo conocido entonces
        const cerradasAhora: LedgerEntry[] = [];
        estado.abiertas = estado.abiertas.filter((s) => {
          if (s.symbol !== symbol || s.timeframe !== key) return true;
          const apunte = resolverSenal(s, trozo);
          if (!apunte) return true;
          cerradasAhora.push(apunte);
          return false;
        });
        if (cerradasAhora.length) estado.cerradas = append(estado.cerradas, cerradasAhora);

        // 2. y ver si nace una en esa vela
        estado.ultimaBarra[clave] = velas[i].t;
        const fila = computeLevels(key, tf.label, trozo, tf.minutes);
        if (!fila.ready) continue;

        /*
          La señal se fecha en la APERTURA de su vela, no en el cierre. Parece
          un detalle y no lo es: `resolve` toma como futuras las velas con
          `t > bornAt`, así que fechar en el cierre —que coincide con la
          apertura de la siguiente— se saltaría la primera vela de vida de la
          operación. Con la apertura, la resolución empieza justo en la
          siguiente, que es donde empieza de verdad.
        */
        const nace = maybeBirth(
          {
            symbol,
            timeframe: key,
            tfMinutes: tf.minutes,
            side: fila.side,
            price: fila.price,
            atr: fila.atr,
            strength: fila.strength,
            stopAtr: STOP_ATR,
            targetAtr: TARGET_ATR,
          },
          latestFor(estado.abiertas, symbol, key),
          velas[i].t
        );
        if (nace) {
          estado.abiertas.unshift(nace);
          nacidas++;
        }
      }
    }
  }

  if (estado.cerradas.length > MAX_APUNTES) {
    estado.cerradas = estado.cerradas.slice(-MAX_APUNTES);
  }
  estado.updatedAt = Date.now();
  estado.lastRunAt = estado.updatedAt;
  estado.lastError = errores.length ? errores.slice(0, 4).join(" · ") : null;
  estado.marcos = [...MARCOS];

  /*
    DE DÓNDE SALIERON LAS VELAS, ESCRITO ANTES DE GUARDAR.

    Esto estaba treinta líneas más abajo, o sea DESPUÉS de escribir el fichero,
    así que no llegaba a guardarse nunca. La primera ejecución buena lo enseñó
    sola: el fichero decía «binance-futures» y `lastError` decía que Binance se
    había descartado y había entrado OKX. Un registro que se equivoca sobre su
    propia procedencia es peor que uno sin ese campo — invita a concluir cosas
    de un mercado con datos de otro.

    Puede mezclar los dos en una misma vuelta, y se admite a propósito: los
    perpetuos del mismo activo cotizan arbitrados a unos pocos puntos básicos,
    y el stop está a 1,2 ATR, que son decenas. La diferencia entre mercados
    añade ruido, no sesgo. Lo que NO se admite es no saber cuál fue.
  */
  const porVia = Object.entries(via)
    .map(([k, n]) => `${k} ${n}`)
    .join(" · ");
  estado.source = `velas cerradas · ${porVia || "sin descargas"} · mismo codigo que la app`;

  mkdirSync(dirname(FICHERO), { recursive: true });
  writeFileSync(FICHERO, `${JSON.stringify(estado, null, 2)}\n`, "utf8");

  /*
    SE GUARDA CUANDO CAMBIA EL FICHERO, no cuando hay noticias.

    Antes esto miraba solo si había nacido o cerrado algo, y se dejaba fuera un
    caso silencioso: una vela nueva que no produce señal —el lado no cambió y
    la anterior sigue en curso— igualmente ADELANTA el marcador de última vela
    juzgada. Sin guardar ese marcador, la ejecución siguiente vuelve a juzgar
    velas ya juzgadas, y si entre medias se resolvió la señal anterior nacería
    una fechada en el pasado. Comparar el contenido entero lo cubre entero.
  */
  const nuevasCerradas = estado.cerradas.length - antesCerradas;
  const cambio = JSON.stringify({ ...estado, updatedAt: 0 }) !== JSON.stringify({ ...antes, updatedAt: 0 });
  const hayNoticia = nacidas > 0 || nuevasCerradas > 0 || antesAbiertas !== estado.abiertas.length;
  const resumen = hayNoticia
    ? `${nacidas} nuevas · ${nuevasCerradas} cerradas · ${estado.abiertas.length} vivas`
    : `latido · sin novedad (${estado.abiertas.length} vivas, ${estado.cerradas.length} cerradas)`;

  console.log(resumen + (fallos ? ` · ${fallos} descargas fallidas` : "") + (saltadas ? ` · ${saltadas} velas atrasadas fuera de tope` : ""));
  salida("changed", String(cambio));
  salida("summary", resumen);
  /*
    "ok" va aparte del código de salida a propósito: el script termina bien
    para que el paso de guardar llegue a correr y el error quede escrito en el
    repositorio. El flujo mira "ok" DESPUÉS de guardar y es quien pinta la
    ejecución en rojo. Al revés —morir aquí— es lo que hacía que el fallo se
    perdiera.
  */
  if (porVia) console.log(`descargas: ${porVia}`);

  /*
    CUÁNDO SE PINTA EN ROJO, y por qué no siempre que algo falle.

    Hay pares de Binance que OKX no lista —MARSCOINUSDT, por ejemplo— así que
    con el respaldo en marcha SIEMPRE va a fallar un puñado de descargas. Si
    eso pintara la ejecución en rojo, todas saldrían en rojo, y una alarma que
    suena siempre es una alarma apagada: a la tercera se deja de mirar y el día
    que falle de verdad no se entera nadie.

    Rojo solo cuando no se pudo grabar: ni una descarga buena, o más de la
    mitad caídas. Lo demás queda escrito en `lastError`, que es donde se mira
    cuando se quiere saber, sin gritar cuando no hace falta.
  */
  const bajadas = Object.values(via).reduce((a, b) => a + b, 0);
  const roto = bajadas === 0 || fallos > bajadas;
  salida("ok", String(!roto));
  if (errores.length) console.error(`FALLOS: ${estado.lastError}`);
}

main().catch((e: unknown) => {
  // Red de seguridad: si algo se escapa de los catch de dentro, se anota en el
  // fichero igual, para que la vuelta siguiente sepa qué pasó en esta.
  console.error(e);
  try {
    const estado = leerEstado();
    estado.lastRunAt = Date.now();
    estado.lastError = `caida no controlada: ${(e as Error).message}`;
    mkdirSync(dirname(FICHERO), { recursive: true });
    writeFileSync(FICHERO, `${JSON.stringify(estado, null, 2)}
`, "utf8");
    salida("changed", "true");
    salida("summary", "caida no controlada");
  } catch {
    /* si ni eso se puede, que al menos salga en rojo */
  }
  salida("ok", "false");
});
