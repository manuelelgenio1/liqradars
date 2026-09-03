import { useState } from "react";
import { FINDINGS, summarize, VERDICT_LABEL, type Finding, type Verdict } from "../lib/findings";
import { Card, Tag } from "./ui";

/* ============================================================
   El expediente, en pantalla.

   Casi ninguna herramienta de análisis enseña lo que ha comprobado de sí
   misma. Esta lo pone delante, incluidos —sobre todo— los fracasos: la tesis
   que le da nombre está aquí, marcada como descartada.

   No es autoflagelación. Es que un usuario que sabe qué NO funciona toma
   mejores decisiones que uno al que le enseñan flechas de colores.
   ============================================================ */

const COLOR: Record<Verdict, string> = {
  descartada: "var(--color-down)",
  "no-operable": "var(--color-warn)",
  abierta: "var(--color-muted)",
  "en-pie": "var(--color-up)",
};

function Fila({ f, abierta, onToggle }: { f: Finding; abierta: boolean; onToggle: () => void }) {
  return (
    <div className="border-b border-[var(--color-line-soft)] last:border-b-0">
      <button
        onClick={onToggle}
        className="flex w-full items-start gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-[var(--color-surface-2)]"
      >
        <span
          className="mt-0.5 w-[86px] shrink-0 font-mono text-[8px] font-bold uppercase tracking-[0.1em]"
          style={{ color: COLOR[f.verdict] }}
        >
          {VERDICT_LABEL[f.verdict]}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[10.5px] font-semibold leading-snug text-[var(--color-body)]">
            {f.hypothesis}
          </span>
          <span className="mt-0.5 block font-mono text-[8.5px] leading-relaxed text-[var(--color-dim)]">
            {f.numbers}
            {f.venue && <span className="ml-1.5 opacity-70">· medido en {f.venue}</span>}
          </span>
        </span>
        <span className="mt-0.5 shrink-0 font-mono text-[9px] text-[var(--color-dim)]">{abierta ? "−" : "+"}</span>
      </button>

      {abierta && (
        <div className="border-t border-[var(--color-line-soft)] bg-[rgba(255,255,255,0.015)] px-4 py-2.5 pl-[110px]">
          <p className="font-mono text-[9px] leading-relaxed text-[var(--color-muted)]">{f.meaning}</p>
          <p className="mt-1.5 font-mono text-[8px] text-[var(--color-dim)]">muestra: {f.sample}</p>
        </div>
      )}
    </div>
  );
}

export default function FindingsPanel() {
  const [abierta, setAbierta] = useState<string | null>(null);
  const s = summarize();

  return (
    <Card
      title="Qué se ha comprobado"
      sub={`${s.total} hipótesis puestas a prueba`}
      right={<Tag kind={s.enPie > 0 ? "partial" : "none"}>{s.enPie} en pie</Tag>}
      delay={320}
    >
      <div className="grid grid-cols-4 divide-x divide-[var(--color-line-soft)] border-b border-[var(--color-line-soft)]">
        {[
          ["Descartadas", s.descartadas, "var(--color-down)"],
          ["No operables", s.noOperables, "var(--color-warn)"],
          ["Abiertas", s.abiertas, "var(--color-muted)"],
          ["En pie", s.enPie, "var(--color-up)"],
        ].map(([label, n, col]) => (
          <div key={String(label)} className="px-3 py-2.5">
            <div className="font-mono text-[8px] uppercase tracking-[0.12em] text-[var(--color-dim)]">{label}</div>
            <div className="tnum mt-1 font-display text-lg font-bold leading-none" style={{ color: String(col) }}>
              {n}
            </div>
          </div>
        ))}
      </div>

      <div className="border-b border-[var(--color-line-soft)] px-4 py-2">
        <p className="font-mono text-[8.5px] leading-relaxed text-[var(--color-muted)]">
          <b className="text-[var(--color-bright)]">Descartada</b> es distinto de{" "}
          <b className="text-[var(--color-bright)]">abierta</b>: lo primero solo se dice cuando había muestra
          suficiente para ver el efecto. Confundirlos es el error más fácil de cometer aquí.
        </p>
      </div>

      {FINDINGS.map((f) => (
        <Fila key={f.id} f={f} abierta={abierta === f.id} onToggle={() => setAbierta(abierta === f.id ? null : f.id)} />
      ))}

      <footer className="mt-auto border-t border-[var(--color-line-soft)] px-4 py-2.5">
        <p className="font-mono text-[8px] leading-relaxed text-[var(--color-dim)]">
          Todas las muestras se cuentan en <b className="text-[var(--color-muted)]">sucesos independientes</b> — una
          cascada que toca cinco pares es uno, no cinco. Los resultados van{" "}
          <b className="text-[var(--color-muted)]">netos</b> de comisión, medida contra la distancia al stop. Cuando se
          contrastan hipótesis opuestas sobre los mismos datos, el listón sube por Bonferroni.
        </p>
        <p className="mt-2 font-mono text-[8px] leading-relaxed text-[var(--color-warn)]">
          Que la tesis del imán de liquidez —la que da nombre a esta app— esté marcada como descartada no es un
          descuido. Es el resultado, y esconderlo sería lo único imperdonable.
        </p>
      </footer>
    </Card>
  );
}
