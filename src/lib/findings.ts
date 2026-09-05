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
    id: "reversion-30m",
    hypothesis: "La reversión del retorno rezagado, que sí existe en 5m, también está en 30m",
    verdict: "descartada",
    sample: "4 combinaciones de rezago y horizonte · 10 pares · 2.407 a 2.409 sucesos fuera de muestra · más el modelo de once rasgos",
    numbers:
      "las t van de −0,57 a +1,59, ninguna llega al listón de 2,50 · el modelo combinado da R² FUERA de muestra de −0,091 %, negativo · el peso de r1 cambia de −0,016 en 5m a +0,012 en 30m",
    meaning:
      "Cierra un hueco propio: la reversión y el modelo combinado solo se habían medido en 5m, y eran las dos únicas cosas con señal. En 30m no están. El peso del retorno rezagado no solo se desvanece, CAMBIA DE SIGNO — de reversión a momento — lo que confirma que era un efecto de microestructura de cinco minutos y no una propiedad del mercado. Y un R² fuera de muestra negativo significa que el modelo predice peor que decir la media: solo memorizó ruido.",
  },
  {
    id: "estructura-precio",
    hypothesis: "Los soportes y resistencias predicen: el precio rebota en ellos, o los rompe y sigue",
    verdict: "descartada",
    sample: "2 hipótesis OPUESTAS × 2 marcos · 10 pares · 30.000 velas cada uno · 3.373 a 4.797 sucesos fuera de muestra",
    numbers:
      "rebote 37,5 % y rotura 38,5 % en 5m · rebote 36,7 % y rotura 37,8 % en 30m · el azar da 37,5 %",
    meaning:
      "Es la última familia distinta que quedaba y la única que usan los operadores discrecionales: niveles reales en vez de múltiplos de volatilidad. La prueba está construida para no poder acertar por casualidad — rebote y rotura son opuestas, así que si el nivel predijera algo una tendría que superar al azar y la otra quedarse debajo. Las dos caen exactamente en el azar. El nivel no contiene información: llegar a un soporte no dice nada sobre si va a aguantar o a ceder. Nota técnica que decide la validez: un pivote solo se usa K velas después de formarse, porque antes nadie sabía que lo era; saltarse eso es lo que hace que la mayoría de los backtests de estructura salgan preciosos y falsos.",
  },
  {
    id: "entradas-intrabar",
    hypothesis: "Entrar con un disparador dentro de la vela, y no al cierre, cambia el resultado",
    verdict: "no-operable",
    sample: "3 disparadores · 10 pares · 45.000 velas de 1 minuto cada uno (31 días) · 1.934 a 2.433 sucesos fuera de muestra",
    numbers:
      "entrar en retroceso mejora el neto de −0,510R a −0,353R, un 31 % · el acierto no se mueve: 35,1 %, 35,3 % y 34,1 % según el disparador",
    meaning:
      "Era la limitación más real que quedaba: todo lo anterior decidía y entraba al cierre de la vela, que no es como se opera. Y sí mejora — esperar un retroceso da mejor precio y comisión maker, la mayor ganancia que ha producido ningún cambio. Pero el acierto es idéntico con los tres disparadores, así que lo que mejoró fue el PRECIO DE ENTRADA, no la puntería. De −0,51 a −0,35 hay que repetir esa mejora tres veces más para cruzar el cero, y ya no queda de dónde: el 37 % de las señales ni siquiera llega a ejecutarse.",
  },
  {
    id: "ambiguedad-resolucion",
    hypothesis: "Contar como pérdida la vela que toca stop y objetivo estaba castigando los resultados",
    verdict: "descartada",
    sample: "resolución a 1 minuto sobre 45.000 velas por par · 5.144 operaciones fuera de muestra",
    numbers: "velas ambiguas al resolver a un minuto: 0,0 %",
    meaning:
      "Preocupación legítima sobre el propio método: con velas de cinco minutos, la que contiene ambos niveles se contaba siempre como pérdida, y eso podía estar deformando veinticuatro estudios. Resuelto a un minuto la ambigüedad desaparece por completo, así que el supuesto conservador no distorsionaba nada. Un agujero menos del que preocuparse.",
  },
  {
    id: "gestion-stop",
    hypothesis: "Mover el stop al punto de entrada da la vuelta al signo, porque baja el punto de equilibrio",
    verdict: "descartada",
    sample: "3 reglas × 2 marcos × pares grandes y pequeños · 8.815 a 13.358 operaciones por celda fuera de muestra",
    numbers:
      "el empate convierte el 26 % de las perdedoras en ceros, pero el acierto cae de 36 % a 27 % a la vez · neto −0,619 sin gestión y −0,606 con ella · el arrastre empeora a −0,874",
    meaning:
      "Era la crítica más fuerte que se le podía hacer a los veintidós estudios anteriores, todos con stop fijo, y hacía falta medirla. Hace EXACTAMENTE lo que promete: salva una de cada cuatro perdedoras. Pero te saca de otras tantas que iban a ganar, y las dos cosas se cancelan casi al decimal. No crea ventaja, reordena resultados. El stop de arrastre es peor todavía porque corta las ganadoras antes de tiempo.",
  },
  {
    id: "pares-pequenos",
    hypothesis: "En los pares de baja capitalización queda ineficiencia que en BTC ya no existe",
    verdict: "descartada",
    sample: "10 perpetuos del puesto 45 al 55 por volumen · 8.587 operaciones en 5m fuera de muestra",
    numbers: "acierto 38 % contra 36 % de los grandes, pero neto −0,838 contra −0,619: peor, no mejor",
    meaning:
      "La hipótesis era razonable —los mercados grandes son los más eficientes— y el resultado la cierra por partida doble. El acierto es prácticamente idéntico, así que no hay ineficiencia extra que explotar; y el coste relativo es mayor porque el spread es más ancho. Buscar mercados menos vigilados no ayuda cuando la señal vale cero en todos.",
  },
  {
    id: "reversion-operada",
    hypothesis: "La reversión de la vela anterior, operada con niveles propios, es rentable en 5 minutos",
    verdict: "descartada",
    sample: "6 combinaciones de objetivo y stop · 10 pares · 45.000 velas cada uno (156 días) · 33.333 operaciones y 9.953 sucesos fuera de muestra",
    numbers:
      "con objetivo 0,5 y stop 2,0 ATR se acierta el 77,3 % y aun así se pierde 0,54R · el bruto es −0,034R, negativo antes de comisiones",
    meaning:
      "Era lo único vivo del proyecto y no sobrevive al operarlo. El efecto medido era de UNA vela; aguantando doce con un stop, la volatilidad normal saca la posición antes de que el rebote llegue, y un stop lo bastante ancho para no saltar es tan ancho que 0,05 ATR de ventaja no significa nada dentro de él. Sirve además de demostración de que perseguir el acierto no sirve: 77,3 % de aciertos y pérdida, porque con esos niveles el equilibrio ANTES de comisiones ya está en el 80 %. Y sobre la muestra: cuadruplicar la historia no movió el resultado, solo estrechó el error — busca y confirmación coinciden casi decimal a decimal.",
  },
  {
    id: "hurst-confirmacion",
    hypothesis: "El exponente de Hurst confirma cuándo fiarse de la señal: seguirla si H>0,5, invertirla si H<0,5",
    verdict: "descartada",
    sample: "5 tramos de H · 10 pares · 5.876 operaciones en 5m y 5.180 en 30m, fuera de muestra",
    numbers:
      "la regla aplicada acierta 36,0 % en 5m y 36,3 % en 30m, por debajo del 37,5 % del azar y lejos del 44 % que hace falta",
    meaning:
      "Era la confirmación mejor fundamentada que ofrece la literatura: no da señal, dice cuándo la señal sirve. Y falla. Dentro de la tabla hay una trampa que merece quedar escrita: en 5m, con H bajo, la operación inversa sube a 43 % — casi el equilibrio, justo lo que predice la teoría. Pero en 30m el mismo tramo hace lo contrario. Un efecto que se da la vuelta al cambiar de marco no es un efecto. Quedándose solo con la tabla de 5m se habría anunciado un hallazgo.",
  },
  {
    id: "acuerdo-indicadores",
    hypothesis: "Exigiendo más acuerdo entre los cinco indicadores sube el porcentaje de aciertos",
    verdict: "descartada",
    sample: "5 tramos de acuerdo · 10 pares · 5.880 operaciones en 5m y 5.180 en 30m, fuera de muestra",
    numbers:
      "acierto plano entre 32 % y 36 % en los cinco tramos · con los cinco indicadores de acuerdo (0,65–1,01) sale 35,9 %, por debajo del 37,5 % que da el azar",
    meaning:
      "El umbral de 0,12 que dispara la señal estaba puesto a ojo y nunca se había comprobado. Comprobado: subirlo no sirve. Cuando los cinco indicadores gritan lo mismo se acierta igual o peor que lanzando una moneda con esos niveles. Era el sitio donde podía esconderse una solución fácil y no está.",
  },
  {
    id: "modelo-combinado-5m",
    hypothesis: "Combinar varias señales débiles con pesos aprendidos alcanza el factor de diez que falta en 5m",
    verdict: "descartada",
    sample: "11 rasgos · 10 pares · 77.636 filas de entrenamiento y 41.804 de evaluación · 2.303 sucesos independientes",
    numbers:
      "R² fuera de muestra 0,017 % · bruto +0,027 ATR con t=1,87 contra un listón de 1,96 · coste 0,564 ATR, veinte veces mayor",
    meaning:
      "El modelo APRENDE algo real: el R² fuera de muestra es positivo, así que no es sobreajuste, y el peso mayor se lo lleva el retorno rezagado con signo negativo — la regresión redescubre sola la reversión que ya habíamos medido. Pero combinar once rasgos da la misma magnitud que la señal suelta, no diez veces más. Ese era el objetivo y no se alcanzó. Con esto se agota el camino: la ventaja a cinco minutos es de 0,03 a 0,09 ATR en todo lo medido, propio y publicado, y el coste de operarla ronda 0,6. No es una carencia de modelo, es una distancia estructural.",
  },
  {
    id: "reversion-5m",
    hypothesis: "El retorno de la vela anterior predice el de la siguiente en 5 minutos",
    verdict: "no-operable",
    sample: "quintil superior del movimiento · 10 pares · 2.178 sucesos independientes fuera de muestra",
    numbers:
      "reversión de 0,052 a 0,086 ATR con t=−3,15 y −2,81 sobre un listón de 2,50 · mismo signo en las dos mitades · el coste son 0,67 ATR",
    meaning:
      "El primer hallazgo estadísticamente sólido del proyecto en dirección de precio, y llegó buscando en la literatura en vez de inventando: Jaquart et al. señalan los retornos rezagados como el rasgo más predictivo a cinco minutos. Existe, es real, sobrevive a la partición y al listón corregido — y es entre ocho y trece veces menor que el coste de operarla. Esa es exactamente la conclusión del propio estudio, que reporta 39 % mensual bruto y negativo neto por lo corto de las tenencias. La señal no es el problema; la frecuencia lo es.",
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
    sample: "24 pares · 215.372 velas desde 2019 · partido 65/35 · 2.112 sucesos en el tramo que no se tocó al elegir",
    numbers:
      "ventaja sobre el MISMO lado en momentos cualesquiera, FUERA DE MUESTRA: 4H largos +0,071R (t=2,03) · 4H cortos −0,030R (t=−0,84) · diario largos +0,013R (t=0,15) · diario cortos +0,033R (t=0,40) · listón 2,50 · mínimo detectable 0,087R",
    meaning:
      "El +0,065R con t=3,41 se había medido sobre toda la historia de una vez, sin partir. Partido 65/35, el diario se deshace —de +0,116R a +0,013R— y en 4H solo aguantan los largos, con el mismo tamaño en las dos mitades (+0,059R y +0,071R) pero sin llegar al listón en ninguna. Los cortos cambian de signo entre mitades, que es la firma del ruido. NO SE PUDO confirmar ni descartar: en el tramo de confirmación el mínimo detectable es 0,087R, mayor que el propio efecto que se buscaba, así que ese tramo nunca tuvo con qué. Lo que sí queda medido es la asimetría (largos − cortos = +0,101R, t=2,01): una ventaja de un solo lado, ya descontada la deriva, no es acierto de dirección. Lo que lo cerraría: datos hacia delante — que es justo lo que el registro está acumulando en 4H.",
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
    id: "liquidaciones-okx",
    hypothesis: "Lo mismo medido en otro mercado: el estallido se agota y el precio rebota",
    verdict: "abierta",
    sample: "46 observaciones cerradas · 23 sucesos independientes · 61 horas · 6 pares · grabador horario propio",
    numbers: "rebote +0,228 % por suceso · t = 2,70 · en Hyperliquid la MISMA lectura daba −0,201 % con 157 sucesos",
    meaning:
      "Apareció al replicar en OKX una hipótesis ya descartada, y apunta al revés que la medida de 157 sucesos. Al doblar la muestra el efecto ENCOGIÓ —de +0,273 % a +0,228 %— y la t subió solo porque hay más datos: es lo que se espera de algo que se está acercando a cero despacio, no de una ventaja. Ya pasa el mínimo de 20 sucesos del proyecto, así que la pega ya no es el tamaño: es que sesenta y una horas son un solo régimen de mercado y que un cambio de signo entre mercados es la misma firma de ruido que un cambio de signo entre mitades. No se pudo decidir contra 157 sucesos que dicen lo contrario. Si a los 60 sucesos, y con otro régimen dentro, mantiene el signo, entonces habrá algo que mirar.",
    venue: "OKX",
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
