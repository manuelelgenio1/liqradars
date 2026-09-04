// localStorage tolerante a fallos (modo privado, cuota llena, etc.).

export function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Devuelve si se pudo guardar.
 *
 * Antes tragaba el fallo y no lo contaba a nadie. Para un ajuste de interfaz
 * da igual, pero el REGISTRO DE ACIERTOS no: en modo incógnito, o con la cuota
 * llena, dejaría de guardarse en silencio y el usuario seguiría creyendo que
 * la mesa lleva las cuentas. Quien necesite saberlo, ahora puede.
 */
export function write<T>(key: string, value: T): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* sin almacenamiento */
  }
}
