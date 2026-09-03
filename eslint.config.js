// ============================================================
// Reglas escogidas por los fallos que este proyecto YA ha sufrido, no por
// gusto estético. Cada bloque de abajo apunta a algo que pasó de verdad.
// ============================================================
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  // Solo se revisa código fuente. `.vercel/output` es el paquete ya construido
  // y aporta 913 avisos sobre código minificado que nadie va a leer.
  { ignores: ["dist/**", ".vercel/**", "node_modules/**", ".probe/**", "scripts/**", "data/**"] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { window: "readonly", document: "readonly", localStorage: "readonly", console: "readonly", fetch: "readonly", WebSocket: "readonly", AbortController: "readonly", DOMException: "readonly", setTimeout: "readonly", clearTimeout: "readonly", AbortSignal: "readonly" },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,

      /*
        LA REGLA QUE MÁS IMPORTA AQUÍ.

        El temporizador de señales no disparaba nunca: su `useEffect` incluía
        entre las dependencias un objeto que se recreaba cada 700 ms, así que
        el intervalo se destruía y se volvía a crear antes de cumplirse. La app
        parecía funcionar y sencillamente no generaba señales.

        No es un aviso cosmético: es la clase de fallo que no se ve.
      */
      "react-hooks/exhaustive-deps": "warn",

      /*
        Una promesa sin await ni catch se traga los errores. En este proyecto
        casi todo son descargas de red, y un fallo silencioso deja la app
        enseñando datos viejos como si fueran frescos — que es exactamente lo
        que pasó con el grabador parado.
      */
      "@typescript-eslint/no-floating-promises": "error",

      // Un `any` es una comprobación de tipos que se apaga sola.
      "@typescript-eslint/no-explicit-any": "error",

      // `catch {}` vacío es cómo se pierde la pista de un fallo real.
      "no-empty": ["error", { allowEmptyCatch: false }],

      // `==` con null/undefined ya ha causado bastantes sorpresas.
      eqeqeq: ["error", "always", { null: "ignore" }],

      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],

      /*
        Estas tres quedan en AVISO, no en error, y conviene explicar por qué en
        vez de apagarlas y olvidarlas.

        Señalan un patrón deliberado: escribir refs durante el render para que
        los temporizadores sobrevivan a datos que cambian cada 700 ms. Es la
        solución al fallo del temporizador que no disparaba nunca, así que
        "arreglarlo" a lo bruto reintroduciría aquel error.

        React tiene razón en que escribir refs en render es incorrecto y puede
        morder en modo concurrente. Es deuda real —14 sitios— pero cambiarlo
        exige rehacer los tres hooks con cuidado y medir que las señales sigan
        generándose. Se deja visible en amarillo hasta entonces, no escondida.
      */
      "react-hooks/refs": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/set-state-in-effect": "warn",
    },
  },

  {
    // Comprobación de tipos completa: no-floating-promises la necesita.
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
  },

  {
    // En los tests se permite lo que en producción no.
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  }
);
