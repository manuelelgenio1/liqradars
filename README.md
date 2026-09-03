# LIQRADAR FINAL

Radar de liquidez y liquidaciones cripto. Reescritura completa con una regla
innegociable: **todo lo que se muestra es un dato real de un exchange**. No hay
valores simulados, ni de relleno, ni estimaciones disfrazadas de medición. Lo
que no se ha podido medir se muestra como `—`.

## Arranque

```bash
npm install
npm run dev
```

| Script | Qué hace |
| --- | --- |
| `npm run dev` | Desarrollo en `http://localhost:3100` |
| `npm run build` | Typecheck + build de producción en `dist/` |
| `npm run preview` | Sirve el build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | 67 tests con Vitest |
| `npm run check` | typecheck + tests |

No hace falta ninguna API key. Ninguna.

## Fuentes

Todas públicas, gratuitas y verificadas contra la API real durante el
desarrollo.

| Fuente | Qué aporta |
| --- | --- |
| **Binance Futures REST** | velas, libro, funding, open interest, **OI histórico 1 h**, ratios long/short |
| **Binance Spot** | respaldo automático donde Futuros está restringido |
| **Binance WS** | precios en tiempo real |
| **OKX WS** | liquidaciones completas en vivo |
| **OKX REST** | **histórico** de liquidaciones (backfill al arrancar) |
| **Bybit WS** | liquidaciones completas, segunda fuente |

### Sobre las liquidaciones

Este es el núcleo del proyecto, así que conviene entender las decisiones.

**Binance no sirve para agregar.** Su stream `!forceOrder@arr` existe, pero la
documentación de Binance advierte que por símbolo solo publica la liquidación
más grande de cada 1000 ms y descarta el resto. Durante una cascada —justo
cuando el dato importa— pierdes la cuenta y el volumen, y el sesgo no es
aleatorio: se queda con las ballenas y borra la cola. Por eso sus eventos se
muestran marcados con `*` pero **no suman** en los totales.

**OKX y Bybit sí.** Ambos publican cada orden individual. Son la base del
agregado.

**Cuidado con las convenciones de lado**, porque no coinciden:

| Exchange | Campo | Significado |
| --- | --- | --- |
| OKX | `posSide` | lado de la posición, directo |
| Bybit | `S` | lado de la **posición** — `Buy` = se liquidó un largo |
| Binance | `S` | lado de la **orden** — `SELL` = se liquidó un largo |

Reutilizar la lógica de uno en otro invierte los lados en silencio. Está
comentado en cada fuente.

**Unidades.** El `sz` de OKX viene en contratos, no en moneda base: el nocional
es `px · sz · ctVal`, y para BTC-USDT-SWAP `ctVal` vale 0,01 BTC. Ignorarlo da
un error de 100×. Los `ctVal` se descargan de `/public/instruments` al arrancar,
con tabla de respaldo.

### Lo que este proyecto NO puede darte

El **nocional pendiente de liquidar en cada nivel** — el "liquidation heatmap"
clásico. Eso exige conocer el precio de liquidación de cada posición abierta,
que es dato privado del exchange. Nadie lo publica. Los productos que lo venden
lo **estiman** a partir del open interest con supuestos de apalancamiento.

Lo que sí se ofrece, y es real, son las liquidaciones **ya ocurridas** por nivel
de precio: mira hacia atrás, no predice. Las bandas del gráfico son eso, y su
grosor es proporcional al nocional realmente liquidado.

## Paneles

| Panel | Qué muestra |
| --- | --- |
| **Gráfico** | velas, EMAs, Supertrend, VWAP; liquidaciones como **burbujas en (tiempo, precio)** con área ∝ nocional; perfil de liquidaciones por nivel en canaleta lateral; escalera de apalancamiento; oscilador conmutable (volumen · CVD · RSI · MACD); zoom, arrastre, minimapa, pantalla completa y gestos táctiles |
| **Análisis técnico** | consenso ponderado de 5 indicadores, **confluencia multi-temporalidad** (5m→1D, clicable), RSI y ADX con minigráfico de su propia historia |
| **Liquidaciones** | histograma temporal de la última hora partido por lado, **detección de cascada**, reparto long/short, mayor evento, desglose por exchange y feed filtrable |
| **Libro de órdenes** | escalera de profundidad real con tamaño individual y acumulado, detección de **muros** por mediana, spread y desequilibrio |
| **Apalancamiento** | lectura combinada de funding + OI (régimen), posicionamiento y estado de las cuatro fuentes |

El gráfico dibuja las liquidaciones en el eje temporal porque el `timestamp` ya
venía en el dato y una raya horizontal lo desperdicia: ver el racimo apelotonado
en dos minutos es lo que distingue un barrido de un goteo.

## Indicadores

EMA, MACD, RSI, ATR, Supertrend, ADX/DI y VWAP, calculados sobre 500 velas
reales. Las fórmulas están contrastadas contra implementaciones de referencia
escritas por separado desde la definición de Wilder: RSI, ADX, +DI y −DI
coinciden hasta el segundo decimal.

Detalle que costó un error en la versión anterior del proyecto: en Wilder,
`DI = 100 · DM_suavizado / TR_suavizado`, y ambos términos deben estar en la
misma escala. Dividir una suma suavizada entre un promedio suavizado infla los
DI exactamente `period` veces y los saca de su rango 0-100. El ADX no lo delata
porque el factor se cancela dentro del DX.

## Laboratorio de validación

Responde con números a la pregunta incómoda: **¿los niveles donde ya se liquidó
a alguien vuelven a atraer al precio?**

La comparación se hace contra un **control emparejado por distancia**: mismo
lado, distancia perturbada ±33 %. Ese emparejamiento es lo único que hace válida
la prueba — un nivel cercano se toca mucho más que uno lejano por pura
geometría, así que un control sorteado uniformemente mediría distancia y no
señal, y daría "ventajas" espectaculares y falsas.

Sin look-ahead: cada prueba usa solo niveles con marca de tiempo anterior a la
vela evaluada. Un veredicto **INDETERMINADO** es legítimo y frecuente; significa
que en esa ventana el radar no aporta ventaja medible.

## Señales y bitácora

La app genera señales de entrada (largo/corto) combinando lo que ya mide:
consenso técnico, confluencia multi-temporalidad, flujo forzado de
liquidaciones, desequilibrio del libro y aglomeración de apalancamiento. Los
pesos son una **hipótesis explícita**, no una verdad conocida.

Lo que hace que esto sirva de algo es la bitácora, construida para no poder
mentir:

- Cada señal se **registra al nacer** con entrada, stop y objetivo fijos. Nada
  se edita después: sin esto el historial es una colección de recuerdos
  favorables.
- El desenlace lo decide una **regla sobre velas reales**, no un criterio.
- Si una vela contiene stop y objetivo, no se sabe cuál se tocó primero: se
  cuenta como **pérdida** y se marca como ambigua. La suposición conservadora
  evita inflar el resultado.
- Cada señal lleva un **control**: una moneda al aire con el mismo stop y
  objetivo, en el mismo instante. Sin línea base, un 55 % de aciertos no
  significa nada.
- La métrica principal es la **esperanza en R**, no el porcentaje de aciertos.
  Un 70 % de aciertos con pérdidas grandes es un sistema perdedor, y hay un
  test que lo comprueba.

Veredictos posibles: `SIN DATOS`, `MUESTRA CORTA` (menos de 20 resueltas),
`PIERDE`, `SIN VENTAJA` y `VENTAJA`. Los tres últimos exigen muestra suficiente,
y `VENTAJA` exige además superar claramente al control.

**Aviso**: que la app dibuje una entrada no la convierte en buena. La bitácora
existe precisamente para que puedas comprobar si lo es, y puede perfectamente
decirte que no.

## Tests

```bash
npm test
```

90 tests sobre `src/lib/`, que es todo funciones puras. Cubren:

- **Indicadores** contrastados contra implementaciones de referencia escritas
  por separado desde la definición de Wilder. Incluye el test que fija que
  `+DI`/`−DI` estén en 0-100 y no inflados por el periodo.
- **Formateadores**, con regresión para los dos bugs reales que aparecieron
  ejecutando la app: `$0.50` mostrándose como `$0`, y los tamaños del libro en
  BTC (`0.002`) redondeados a `0`.
- **Agregador de liquidaciones**: deduplicación, ventana de 24 h, exclusión de
  Binance de los totales, agrupación por nivel.
- **Señales**: puntuación acotada, stop/objetivo coherentes por lado, resolución
  contra velas reales, ambigüedad contada como pérdida, expiración a mercado, y
  la prueba de que un 70 % de aciertos con pérdidas grandes se reporta como
  `PIERDE`.
- **Laboratorio**: emparejamiento 1 a 1 de controles, determinismo, ausencia de
  look-ahead, y una prueba que verifica que **no encuentra ventaja donde no la
  hay** sobre paseos aleatorios. Si esa empieza a fallar, el control se ha
  desemparejado.

Los tests ya encontraron un bug real: la huella de deduplicación omitía símbolo
y lado, así que dos liquidaciones distintas podían colisionar.

## Resistencia a fallos

### Preferencia de mercado vs. respaldo

`venuePref` (PERP o SPOT) es **tu elección** y se persiste. La degradación a
spot cuando futuros no responde vive **solo en memoria**, se anuncia en la
interfaz (`usando spot · futuros no responde`) y se reintenta cada 60 s hasta
recuperarse sola.

Antes el respaldo escribía la preferencia en `localStorage`: un único fallo de
red temporal te dejaba en spot para siempre, en todas las sesiones futuras, sin
explicación y sin vuelta atrás salvo pulsando PERP a mano.

### Sockets mudos

Los sockets detectan el modo de fallo **"abierto pero mudo"**: en varias redes
Binance Futuros deja abrir la conexión y luego filtra los datos. Sin vigilante,
la app se quedaba anunciando "en vivo" con un feed congelado. Ahora, si no llega
nada en 15 s con el socket abierto, se reconecta, y tras varios intentos cae a
spot automáticamente. El estado de cada fuente se muestra en la interfaz.

## Coinglass (opcional, de pago)

[Coinglass no tiene plan gratuito](https://www.coinglass.com/pricing): el más
barato son $29/mes. La app está diseñada para no necesitarlo.

Si algún día contratas uno, `api/coinglass.ts` es una Vercel Function lista:
cachea por ruta, restringe las rutas alcanzables y mantiene la clave en el
servidor. Hace falta un proxy porque Coinglass responde **403 al preflight
CORS** — el navegador no puede llamarles directamente aunque tengas clave.

Configura `COINGLASS_API_KEY` en Vercel → Settings → Environment Variables.
**Nunca** con prefijo `VITE_`: eso la metería en el bundle público.

## Estructura

```
src/lib/types.ts        modelo de datos y símbolos
src/lib/net.ts          fetch con timeout + socket con vigilante de silencio
src/lib/sources/        una fuente por exchange, con sus rarezas documentadas
src/lib/liqstore.ts     agregador multi-exchange de liquidaciones reales
src/lib/indicators.ts   indicadores puros, contrastados
src/hooks/useMarket.ts  motor de datos
src/components/         interfaz
api/coinglass.ts        proxy opcional
```

## Aviso

Herramienta de análisis y visualización. No es asesoramiento financiero. Que un
dato sea real no lo convierte en una predicción.
