/*
  ============================================================
  LO QUE SE SABE DE CADA TEMPORALIDAD, DICHO DONDE SE OPERA.

  EL PROBLEMA QUE ARREGLA. La app medía veintinueve hipótesis, escribía el
  resultado en el expediente —5 minutos y 30 minutos no tienen ventaja, con
  potencia de sobra para haberla visto— y en la pestaña de al lado seguía
  pintando sus señales de 5m exactamente igual que las demás: mismo tamaño,
  mismo color, mismos niveles de entrada. Quien abriera la app sin leer el
  expediente veía una herramienta que le recomienda operar en 5m.

  Eso es una contradicción del producto consigo mismo, y la parte que engaña
  es la que más se mira.

  NO SE BORRAN LAS SEÑALES, Y ES A PROPÓSITO. Quitar 5m y 30m sería decidir por
  quien usa la app. Los niveles de esos marcos siguen siendo correctos —el ATR
  es real y el stop está donde dice— y sirven para acotar el riesgo de una
  operación que alguien vaya a hacer de todas formas. Lo que no se puede hacer
  es presentarlos como si nadie hubiera comprobado si aciertan.

  ATADO AL EXPEDIENTE, NO ESCRITO A MANO. Cada marco apunta a los HALLAZGOS que
  lo respaldan por su identificador, y una prueba comprueba que existen. Si
  alguien borra o renombra un hallazgo, salta el test en vez de quedarse una
  etiqueta afirmando algo que ya no está medido. Las dos mitades del producto
  no pueden separarse en silencio.
  ============================================================
*/
import { FINDINGS, type Finding } from "./findings";

/** Cómo de fiable es operar ese marco, según lo medido. */
export type TfTone = "descartado" | "midiendo" | "sin-medir";

export interface TfVerdict {
  /** etiqueta corta, la que cabe al lado del marco */
  short: string;
  /** una frase, para el título emergente */
  detail: string;
  tone: TfTone;
  /** hallazgos del expediente que lo sostienen */
  findings: string[];
}

/*
  1H, 4H y diario comparten estado pero NO por la misma razón, y mezclarlas
  sería mentir por resumen:

    · 4H y diario se midieron y quedaron ABIERTAS — el tramo de confirmación
      no tuvo potencia para ver el efecto que buscaba.
    · 1H y semanal no se han medido por separado nunca.

  "No se pudo comprobar" y "no se ha intentado" se parecen y no son lo mismo.
*/
const TABLA: Record<string, TfVerdict> = {
  "5m": {
    short: "sin ventaja",
    detail:
      "Medido y descartado: 1.371 sucesos fuera de muestra dan un bruto de −0,013R, y en vivo −0,79R por señal contra −0,48R de una moneda al aire. Quitando la comisión entera sigue sin haber ventaja, así que no es un problema de coste. Los niveles siguen valiendo para acotar el riesgo; el acierto no está.",
    tone: "descartado",
    findings: ["mesa-5m", "reversion-5m", "modelo-combinado-5m", "stop-ancho-5m", "entradas-intrabar"],
  },
  "30m": {
    short: "sin ventaja",
    detail:
      "Medido y descartado: 2.407 sucesos fuera de muestra, con t entre −0,57 y +1,59 frente a un listón de 2,50. Lo único que tenía señal en 5m —la reversión del retorno rezagado— aquí cambia de signo, que es lo que pasa cuando nunca fue una propiedad del mercado.",
    tone: "descartado",
    findings: ["reversion-30m", "estructura-precio", "acuerdo-indicadores"],
  },
  "1H": {
    short: "sin medir",
    detail:
      "No se ha puesto a prueba por separado. El registro del servidor lo está grabando desde ahora, así que tendrá su medida cuando haya sucesos suficientes.",
    tone: "sin-medir",
    findings: [],
  },
  "4H": {
    short: "en medición",
    detail:
      "La única que sigue abierta. Fuera de muestra los largos dan +0,071R con t=2,03 contra un listón de 2,50, y los cortos cambian de signo. No se pudo confirmar ni descartar: el mínimo detectable de ese tramo era mayor que el propio efecto. El registro del servidor está acumulando datos hacia delante para cerrarlo.",
    tone: "midiendo",
    findings: ["mesa-4h-diario"],
  },
  "1D": {
    short: "en medición",
    detail:
      "Se midió junto a 4H y quedó abierta. Partida la muestra, la ventaja de +0,116R se deshace hasta +0,013R con t=0,15: lo que parecía efecto era el haberlo medido sobre toda la historia de una vez.",
    tone: "midiendo",
    findings: ["mesa-4h-diario"],
  },
  "1W": {
    short: "sin medir",
    detail:
      "No se ha puesto a prueba por separado. A 48 velas de plazo máximo, una operación semanal tarda casi un año en resolverse, así que su medida va a tardar.",
    tone: "sin-medir",
    findings: [],
  },
};

export const COLOR_TONO: Record<TfTone, string> = {
  descartado: "var(--color-down)",
  midiendo: "var(--color-warn)",
  "sin-medir": "var(--color-dim)",
};

export function verdictFor(timeframe: string): TfVerdict | null {
  return TABLA[timeframe] ?? null;
}

/** Los hallazgos citados por un marco, ya resueltos. Vacío si no cita ninguno. */
export function findingsFor(timeframe: string): Finding[] {
  const v = TABLA[timeframe];
  if (!v) return [];
  return v.findings
    .map((id) => FINDINGS.find((f) => f.id === id))
    .filter((f): f is Finding => f !== undefined);
}

/** Todos los identificadores citados. Lo usa la prueba de integridad. */
export const CITED_IDS: string[] = [...new Set(Object.values(TABLA).flatMap((v) => v.findings))];

export const TF_KEYS = Object.keys(TABLA);
