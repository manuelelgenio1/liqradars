import { useEffect, useRef } from "react";

/*
  El valor más reciente, accesible desde un temporizador o un socket.

  EL PROBLEMA QUE RESUELVE, que es real y ya nos mordió:

  Un `useEffect` que crea un `setInterval` necesita datos frescos dentro del
  callback. Si esos datos van en las dependencias, el efecto se destruye y se
  vuelve a crear cada vez que cambian — y aquí cambian cada 700 ms. El
  intervalo de señales nunca llegaba a cumplirse: la app parecía funcionar y
  sencillamente no generaba ni una señal.

  LA FORMA CORRECTA DE ARREGLARLO.

  La primera versión escribía el ref durante el render (`ref.current = x` en
  el cuerpo del componente). Funciona hoy, pero React lo prohíbe con motivo:
  en modo concurrente puede renderizar, descartar ese trabajo y volver a
  empezar, así que una escritura durante el render puede aplicarse a un
  intento que nunca se muestra. El resultado sería un ref con un valor de un
  render abortado, y eso no se detecta mirando la pantalla.

  Aquí la escritura va DENTRO de un efecto sin lista de dependencias, así que
  corre después de cada render que sí se confirma. El ref queda "atrasado"
  durante el propio render, pero eso da igual: quien lo lee es un temporizador
  que se dispara más tarde, nunca el render.
*/
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}
