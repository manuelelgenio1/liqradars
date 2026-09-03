import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";

// Errores asíncronos fuera del ErrorBoundary: se muestran como TEXTO, nunca
// como HTML — un mensaje de error puede venir de una respuesta remota.
function fatal(title: string, detail: string) {
  const root = document.getElementById("root");
  if (!root) return;
  const wrap = document.createElement("div");
  wrap.style.cssText =
    "min-height:100vh;display:flex;align-items:center;justify-content:center;background:#05070c;padding:24px;font-family:ui-monospace,monospace";
  const box = document.createElement("div");
  box.style.cssText =
    "max-width:460px;border:1px solid rgba(255,84,112,.5);border-radius:10px;background:#0f1522;padding:22px;color:#aebbd2";
  const h = document.createElement("div");
  h.style.cssText = "color:#ff5470;font-weight:700;letter-spacing:.16em;text-transform:uppercase;font-size:12px";
  h.textContent = title;
  const p = document.createElement("p");
  p.style.cssText = "margin-top:10px;font-size:12px;line-height:1.6;word-break:break-word";
  p.textContent = detail;
  const b = document.createElement("button");
  b.style.cssText =
    "margin-top:18px;border:1px solid rgba(33,212,160,.45);border-radius:6px;background:#0e3b31;color:#21d4a0;padding:8px 16px;cursor:pointer;font-size:11px;letter-spacing:.12em;text-transform:uppercase";
  b.textContent = "Recargar";
  b.addEventListener("click", () => window.location.reload());
  box.append(h, p, b);
  wrap.append(box);
  root.replaceChildren(wrap);
}

window.addEventListener("error", (e) => {
  if (e.message) fatal("Error interno", e.message);
});
window.addEventListener("unhandledrejection", (e) => {
  fatal("Fallo de datos", String((e.reason as Error)?.message ?? e.reason ?? "sin detalle"));
});

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
