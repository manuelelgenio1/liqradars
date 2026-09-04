// ============================================================
// EL EXPEDIENTE.
//
// Todo lo que se ha puesto a prueba en este proyecto, con su muestra y su
// resultado. Vive aquí, en el código, y no en mensajes de commit que nadie va
// a leer.
//
// POR QUÉ ESTO ES UN MÓDULO Y NO UN TEXTO EN UN PANEL
//
// Una herramienta que enseña indicadores y niveles está diciendo, aunque no
// lo escriba, "esto sirve para algo". Casi ninguna dice cuánto de eso ha
// comprobado. Aquí el historial de fracasos es tan parte del producto como
// los gráficos, así que se trata como dato: con tipos, con tests y visible
// en pantalla.
//
// REGLAS QUE CUMPLE CADA ENTRADA
//   · La muestra se cuenta en SUCESOS INDEPENDIENTES, no en filas. Una
//     cascada que toca cinco pares a la vez es un suceso.
//   · El resultado va NETO de comisiones, medidas contra la distancia al stop.
//   · Cuando se contrastan varias hipótesis sobre los mismos datos, el listón
//     sube (Bonferroni). Se dice cuál se usó.
//   · "Muestra corta" y "no hay efecto" son cosas DISTINTAS y se distinguen:
//     solo se declara lo segundo cuando había potencia para ver el efecto.
// ============================================================

export type Verdict =
  /** medida con potencia suficiente: el efecto no está */
  | "descartada"
  /** el efecto existe pero no cubre el coste de operarlo */
  | "no-operable"
  /** no hay muestra suficiente para decidir */
  | "abierta"
  /** supera la prueba y sigue en pie */
  | "en-pie";

export interface Finding {
  id: string;
  /** qué se puso a prueba, en una frase */
  hypothesis: string;
  verdict: Verdict;
  /** tamaño de muestra, en sucesos independientes */
  sample: string;
  /** las cifras que sostienen el veredicto */
  numbers: string;
  /** qué significa, sin adornos */
  meaning: string;
  /** dónde se midió, cuando no es Binance */
  venue?: string;
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  descartada: "DESCARTADA",
  "no-operable": "NO OPERABLE",
  abierta: "ABIERTA",
  "en-pie": "EN PIE",
};

export const FINDINGS: Finding[] = [
  {
    id: "mesa-5m",
    hypothesis: "Las señales de la mesa sirven para hacer scalping en 5 minutos",
    verdict: "descartada",
    sample: "en vivo: 52 operaciones · 22 sucesos · replay: 2.512 operaciones · 1.371 sucesos fuera de muestra",
    numbers: "en vivo −0,79R por señal contra −0,48R de la moneda al aire · en replay el BRUTO fuera de muestra es −0,013R",
    meaning:
      "Se apuntó primero como problema de coste y resultó no serlo. El replay separa las dos cosas: quitando la comisión entera, la ventaja bruta sigue siendo cero o negativa. No hay nada que proteger, así que ningún ajuste de stop, objetivo o tamaño puede salvarlo.",
  },
  {
    id: "creador-mercado-vela",
    hypothesis: "Hacer mercado en velas de 5 y 30 minutos es rentable con comisión maker del 0 %",
    verdict: "descartada",
    sample: "4 spreads × 2 marcos · 10 pares · 4.200 sucesos por celda fuera de muestra · 16 combinaciones, todas negativas",
    numbers:
      "con spread de 0,10 ATR se cobra la vuelta completa el 64 % de las veces, pero el 36 % de un solo lado pierde −0,80 ATR de media · PNL por barra entre −0,033 y −0,214",
    meaning:
      "El modelo es el correcto —cobrar el spread en ida y vuelta, no acertar la dirección— y aun así pierde en las dieciséis celdas. La razón es estructural y explica por qué esto no es un negocio de gráficos: cuando solo te ejecutan un lado cargas con el inventario equivocado LA VELA ENTERA, mientras que un creador real recotiza cada milisegundo y se queda plano en segundos. La pérdida por selección adversa es cuatro veces mayor que el spread cobrado. Y sale así con dos sesgos a favor: la simulación ignora la cola de órdenes y no limita el inventario.",
  },
  {
    id: "maker-selec-adversa",
    hypothesis: "Poner el spread en vez de pagarlo rescata el corto plazo, porque la comisión maker es cero",
    verdict: "no-operable",
    sample: "12 combinaciones de distancia y horizonte · 10 pares · 2.563 a 4.198 sucesos fuera de muestra",
    numbers:
      "bruto tras ejecución pasiva: −0,023 ATR a 0,25 ATR de distancia y +0,044 a 1 ATR · neto negativo en las doce, porque la salida a mercado cuesta ~0,15 ATR",
    meaning:
      "La idea venía de la literatura, que sitúa la ventaja predecible a corto plazo en 0,5 puntos básicos contra 5 de comisión taker y la propone como input de ejecución, no como estrategia. Medido: la SELECCIÓN ADVERSA es real y queda cuantificada — pegado al precio te ejecutan y el precio sigue en tu contra. Lejos del precio el bruto se vuelve positivo, pero ni alcanza significación ni cubre el coste de salir a mercado. Entrar gratis no basta si sales pagando. La simulación tiene dos sesgos A FAVOR: ignora la cola de órdenes y el orden dentro de la vela, así que la realidad es peor.",
  },
  {
    id: "vol-regimen",
    hypothesis: "Operar solo cuando hay volatilidad rescata el scalping, porque abarata la operación",
    verdict: "descartada",
    sample: "4 cuartiles · 10 pares · y confirmación preregistrada en 10 pares NUEVOS con 1.007 sucesos",
    numbers:
      "el coste cae de 0,272R a 0,064R y el neto sube de −0,312R a −0,035R, pero nunca cruza el cero · el bruto del cuartil alto pasó de +0,045R a −0,033R en los pares nuevos",
    meaning:
      "El mecanismo del coste es aritmético y se cumple: en los tramos volátiles la misma comisión pesa cuatro veces menos. Pero se predijo por escrito que si el bruto era cero el neto subiría hacia el cero sin cruzarlo, y eso fue lo que pasó. Apareció además un rastro tentador —el bruto crecía con la volatilidad— que se puso a prueba en diez pares nunca usados: EL SIGNO SE DIO LA VUELTA. Era ruido de trocear datos ya vistos. Y la sensibilidad remata la cuestión del coste: ni con ambas órdenes limitadas se sale del negativo, porque abaratar la ejecución no salva un bruto negativo.",
  },
  {
    id: "funding-contrario",
    hypothesis: "Con funding extremo el precio va contra el lado amontonado",
    verdict: "descartada",
    sample: "quintil extremo de funding · 10 pares · 207 sucesos en 30m fuera de muestra",
    numbers: "bruto −0,060 ATR en 30m contra un coste de 0,230 · negativo en los seis casos medidos",
    meaning:
      "El posicionamiento es otra familia de datos —quién está dentro y cuánto paga por seguir— y merecía probarse. No predice ir contra la multitud. En 30m hay potencia para descartarlo: el bruto tendría que estar 5,4 errores típicos más arriba. En 5m NO la hay, porque el funding se liquida a la misma hora en todos los pares y agrupar por suceso deja solo 40 observaciones; ahí no se afirma nada.",
  },
  {
    id: "footprint-agresor",
    hypothesis: "El desequilibrio agresor del footprint anticipa la continuación del precio",
    verdict: "descartada",
    sample: "quintil superior del desequilibrio · 10 pares · 2.459 sucesos en 5m y 2.647 en 4H, fuera de muestra",
    numbers:
      "bruto +0,016 ATR en el mejor caso (t≈1,2) contra un coste de 0,087 ATR en 4H y 0,762 en 5m",
    meaning:
      "Es de otra familia que los indicadores de precio —quién cruzó el spread no está en la serie de cierres— y por eso merecía medirse. Pero el bruto está pegado a cero en los dos marcos y ni siquiera es significativo por sí solo. Para cubrir el coste tendría que ser cinco veces mayor, y hay potencia para descartarlo: está a casi siete errores típicos. En 5m el coste vale 0,76 ATR por operación, así que ninguna señal de esa escala sobrevive prediga lo que prediga.",
  },
  {
    id: "mesa-4h-diario",
    hypothesis: "La misma mesa sí funciona en 4H y diario, donde el coste es veinte veces menor",
    verdict: "abierta",
    sample: "12.000 velas × 10 pares en cada marco · 908 sucesos en 4H y 258 en diario, fuera de muestra",
    numbers:
      "4H +0,056R netos con t=1,44 · diario +0,053R con t=1,31 · el listón, tras probar 3 marcos × 5 anchuras, está en 2,9 sigmas",
    meaning:
      "Sigue ABIERTA y no descartada, y la diferencia es real: en 5m hay potencia para afirmar que la ventaja no existe, aquí no. El neto sale positivo en casi todas las anchuras y el bruto es consistente, pero el ruido es demasiado grande para distinguirlo de cero. Hacen falta unas tres veces más sucesos, y reutilizar estos mismos datos para volver a mirar sería justo la trampa que este expediente existe para evitar.",
  },
  {
    id: "stop-ancho-5m",
    hypothesis: "Ensanchar el stop en 5 minutos rescata el scalping, porque diluye la comisión",
    verdict: "descartada",
    sample: "5 anchuras de stop · 1,2 a 6 ATR · 12.000 velas × 10 pares · 1.309-2.430 sucesos fuera de muestra",
    numbers:
      "el coste cae de 1,003R a 0,205R como predice la aritmética, pero el neto solo mejora de −0,541R a −0,110R: nunca cruza el cero",
    meaning:
      "El mecanismo era correcto y la conclusión es la contraria a la esperada. El coste en R es inversamente proporcional a lo ancho que sea el stop, así que ensancharlo lo diluye de verdad — pero solo sirve para perder más despacio. Con un bruto de −0,013R y un error típico de 0,024R hay potencia para descartar cualquier ventaja que cubriese siquiera el coste más barato de los cinco.",
  },
  {
    id: "indicadores",
    hypothesis: "Los indicadores clásicos aciertan la dirección",
    verdict: "descartada",
    sample: "25 mediciones sobre 6 pares",
    numbers: "19 de 25 por debajo de su propia línea base",
    meaning:
      "Un indicador que grita «alcista» casi siempre acierta tanto como el mercado suba. Restada esa línea base, la mayoría aporta menos que nada.",
  },
  {
    id: "contra-ema-rsi",
    hypothesis: "Cuando EMA y RSI coinciden, conviene hacer lo contrario",
    verdict: "no-operable",
    sample: "243.000 velas · 2023, 2024 y 2026",
    numbers: "+4,3 puntos de acierto · esperanza NEGATIVA antes de comisiones",
    meaning:
      "Acierta más veces y pierde 1,27× más cuando falla. Es la trampa que más se repite: el porcentaje sube y la cuenta baja.",
  },
  {
    id: "libro",
    hypothesis: "El desequilibrio del libro predice la dirección",
    verdict: "no-operable",
    sample: "30 días · 6 símbolos · libro histórico real",
    numbers: "+0,026 % bruto contra un coste de 0,14 %",
    meaning:
      "Sí predice, y el efecto crece cuanto más cerca del precio se mira. Pero es cinco veces menor que la comisión: los creadores de mercado ya se comieron ese margen.",
  },
  {
    id: "panel-señales",
    hypothesis: "El consenso ponderado de esta app gana dinero",
    verdict: "descartada",
    sample: "409 sucesos independientes · 28 días",
    numbers: "acierta 40,4 % contra 38,5 % del azar · −0,42R por operación",
    meaning:
      "La señal es algo mejor que una moneda al aire. La comisión se lleva 0,51R y la deja en pérdidas.",
  },
  {
    id: "marcos-anchos",
    hypothesis: "En marcos anchos el coste deja margen y la señal funciona",
    verdict: "descartada",
    sample: "180 días · 1H, 4H y diario",
    numbers: "en 4H: −0,049R la señal, −0,049R la moneda al aire",
    meaning:
      "El coste baja de 0,64R en 5m a 0,02R en diario, como se esperaba. Pero debajo no aparece ninguna ventaja: en 4H iguala al azar con cinco decimales.",
  },
  {
    id: "liquidaciones",
    hypothesis: "Un estallido de liquidaciones anticipa el movimiento",
    verdict: "descartada",
    sample: "157 sucesos independientes · 30 días",
    numbers: "continuación −0,079 % neto · agotamiento −0,201 % · t máx. 0,77",
    meaning:
      "Ninguna de las dos lecturas opuestas se acerca al listón. Y el agotamiento acierta 56,1 % contra 53,0 % de base con retorno negativo: la trampa otra vez.",
    venue: "Hyperliquid",
  },
  {
    id: "iman",
    hypothesis: "El precio va hacia los cúmulos de liquidez",
    verdict: "descartada",
    sample: "62 sucesos · posiciones reales de la cámara de compensación",
    numbers: "−0,177 % neto · t = −0,71 · potencia para ver +0,05 %",
    meaning:
      "Es la tesis que da nombre a esta app y no se sostiene. Con la muestra que hay se habría detectado cualquier efecto rentable, así que no es «no se sabe»: es que no está.",
    venue: "Hyperliquid",
  },
  {
    id: "monederos",
    hypothesis: "Los cúmulos los alimenta una población recurrente",
    verdict: "descartada",
    sample: "5.892 liquidaciones · 21 días · elegidos en la 1ª mitad, comprobados en la 2ª",
    numbers: "reincidentes vuelven 9,6 % · resto 5,0 % · diferencia 1,49σ",
    meaning:
      "Los que revientan no vuelven. El que acumuló 137 liquidaciones y 144.000 $ de pérdidas desaparece. El mapa describe un accidente irrepetible, no un hábito — y eso explica que no prediga.",
    venue: "Hyperliquid",
  },
  {
    id: "barrido-stops",
    hypothesis: "El mercado va a buscar donde están los stops voluntarios",
    verdict: "abierta",
    sample: "33 sucesos · harían falta 51",
    numbers: "t = 1,08 · dispersión 0,781 %",
    meaning:
      "Aquí sí falta muestra: con estos datos no se podría ver un efecto de +0,20 % aunque existiera. Es lo único que queda sin responder, no un descarte.",
    venue: "Hyperliquid",
  },
  {
    id: "cancelaciones",
    hypothesis: "Una cancelación anómala de órdenes anticipa volatilidad",
    verdict: "en-pie",
    sample: "88 casos · 12 combinaciones de horizonte y umbral",
    numbers: "−3,3σ a 1, 2 y 4 h · las 12 con el mismo signo · decae a las 8 h",
    meaning:
      "Sale al revés de lo esperado: tras cancelar mucho el mercado se mueve MENOS. Cuadra con que cancelar sea síntoma de calma — en volatilidad las órdenes se ejecutan en vez de cancelarse. No dice dirección, así que no gana dinero sola: sirve para dimensionar el stop.",
    venue: "Hyperliquid",
  },
  {
    id: "replica-binance",
    hypothesis: "Ese mismo patrón aparece en Binance",
    verdict: "abierta",
    sample: "646 puntos · sustituto: rotación del libro",
    numbers: "el +2,89σ inicial se evapora al controlar por volatilidad actual (correlación 0,43)",
    meaning:
      "Binance no publica cuentas de cancelación. El sustituto mezcla recotización con ejecución, así que no sirve para replicar. No confirma ni refuta: falta el dato.",
  },
];

export interface FindingsSummary {
  total: number;
  descartadas: number;
  noOperables: number;
  abiertas: number;
  enPie: number;
}

export function summarize(fs: Finding[] = FINDINGS): FindingsSummary {
  return {
    total: fs.length,
    descartadas: fs.filter((f) => f.verdict === "descartada").length,
    noOperables: fs.filter((f) => f.verdict === "no-operable").length,
    abiertas: fs.filter((f) => f.verdict === "abierta").length,
    enPie: fs.filter((f) => f.verdict === "en-pie").length,
  };
}
