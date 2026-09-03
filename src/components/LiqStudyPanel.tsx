import { useNow } from "../hooks/useNow";
import type { MarketApi } from "../hooks/useMarket";
import type { LiqStudyApi } from "../hooks/useLiqStudy";
import { BURST_USD, HORIZON_MS, MIN_OBS, type SideStat } from "../lib/liqstudy";
import { isStale, SERVER_URL } from "../lib/liqserver";
import { ROUND_TRIP_COST_PCT } from "../lib/signals";
import * as f from "../lib/format";
import { Card, Empty, Tag } from "./ui";

/* ============================================================
   ¿Predicen algo las liquidaciones?

   Este panel es el único de la app que no puede enseñar nada el primer día,
   y es a propósito. Se comprobó fuente por fuente y no existe histórico
   gratuito de liquidaciones: Binance retiró el endpoint y también el archivo,
   Bybit no lo publica, OKX solo deja rebobinar un día y Coinglass lo cobra.

   Sin datos que rebobinar, la única alternativa honesta a inventarse un
   backtest es grabar hacia delante y esperar.

   Hay DOS registros y no se mezclan. El de servidor corre cada hora por su
   cuenta y es el que manda: no depende de que nadie tenga la pestaña abierta,
   así que su muestra no está sesgada por los horarios de nadie. El del
   navegador se conserva porque ve tres exchanges en lugar de uno, pero solo
   graba mientras miras. Sumarlos daría una muestra con dos definiciones
   distintas de "estallido" — más grande y peor.
   ============================================================ */

function Hipotesis({ s, mejor }: { s: SideStat; mejor: boolean }) {
  const gana = s.netPct > 0;
  return (
    <div
      className="border-b border-[var(--color-line-soft)] px-4 py-2.5 last:border-b-0"
      style={mejor ? { background: "rgba(255,255,255,0.02)" } : undefined}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-semibold text-[var(--color-body)]">{s.label}</span>
        <span
          className="tnum shrink-0 font-display text-sm font-bold"
          style={{ color: gana ? "var(--color-up)" : "var(--color-down)" }}
          title="Retorno medio por operación, ya descontado el coste"
        >
          {gana ? "+" : ""}
          {s.netPct.toFixed(3)}%
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[8.5px] text-[var(--color-dim)]">
        <span>
          bruto{" "}
          <b className="text-[var(--color-muted)]">
            {s.grossPct > 0 ? "+" : ""}
            {s.grossPct.toFixed(3)}%
          </b>
        </span>
        <span className="text-[var(--color-down)]">−{ROUND_TRIP_COST_PCT.toFixed(2)}% coste</span>
        <span>
          acierta <b className="text-[var(--color-muted)]">{Math.round(s.hitRate * 100)}%</b> vs{" "}
          {Math.round(s.baseline * 100)}% base
        </span>
        <span title="Por debajo de 2,24 no se distingue del azar, al contrastar dos hipótesis opuestas">
          t = <b className="text-[var(--color-muted)]">{Number.isFinite(s.tStat) ? s.tStat.toFixed(2) : "—"}</b>
        </span>
        <span title="Sucesos independientes usados para el cálculo">
          n = <b className="text-[var(--color-muted)]">{s.n}</b>
          {s.rawN > s.n && <span className="opacity-60"> de {s.rawN}</span>}
        </span>
      </div>
    </div>
  );
}

export default function LiqStudyPanel({ api, liq }: { api: MarketApi; liq: LiqStudyApi }) {
  const { report, serverReport, server, recent, study } = liq;
  const enCurso = recent.long + recent.short;
  const grabando = api.liqTotals.hasCompleteSource;

  // El de servidor manda mientras esté disponible; si no, se cae al local.
  const ahora = useNow(30_000);
  const congelado = isStale(server, ahora);
  const servidorVivo = !!SERVER_URL && !server.error;
  const principal = servidorVivo ? serverReport : report;

  const mejorEsMomentum =
    principal.momentum && principal.reversal
      ? principal.momentum.netPct >= principal.reversal.netPct
      : false;

  const tono =
    principal.verdict === "VENTAJA" ? "real" : principal.verdict === "SIN VENTAJA" ? "partial" : "none";

  const comprobado = server.updatedAt ? `hace ${f.ago(server.updatedAt, ahora)}` : "—";
  const ultimoDato = server.lastDataAt ? `hace ${f.ago(server.lastDataAt, ahora)}` : "—";

  return (
    <Card
      title="¿Predicen las liquidaciones?"
      sub={
        servidorVivo
          ? `grabado en servidor · horizonte ${HORIZON_MS / 60_000} min · ${server.runs} ejecuciones`
          : `registro hacia delante · horizonte ${HORIZON_MS / 60_000} min`
      }
      right={
        <Tag kind={congelado ? "none" : servidorVivo ? "real" : grabando ? "partial" : "none"}>
          {congelado ? "servidor parado" : servidorVivo ? "servidor" : grabando ? "solo esta pestaña" : "sin fuente"}
        </Tag>
      }
      delay={280}
    >
      {/* ---- estado del registro ---- */}
      <div className="grid grid-cols-3 divide-x divide-[var(--color-line-soft)] border-b border-[var(--color-line-soft)]">
        <div className="px-3 py-2.5">
          <div className="font-mono text-[8.5px] uppercase tracking-[0.14em] text-[var(--color-dim)]">Sucesos</div>
          <div
            className="tnum mt-1 font-display text-lg font-bold leading-none text-[var(--color-bright)]"
            title="Sucesos independientes. Una cascada que toca varios símbolos a la vez es UNO, no varios: sus retornos no son datos nuevos."
          >
            {principal.resolved}
            <span className="text-[10px] font-normal text-[var(--color-dim)]"> / {MIN_OBS}</span>
          </div>
          {principal.resolvedRaw > principal.resolved && (
            <div className="mt-0.5 font-mono text-[8px] text-[var(--color-dim)]">
              {principal.resolvedRaw} filas agrupadas
            </div>
          )}
        </div>
        <div className="px-3 py-2.5">
          <div className="font-mono text-[8.5px] uppercase tracking-[0.14em] text-[var(--color-dim)]">Esperando</div>
          <div className="tnum mt-1 font-display text-lg font-bold leading-none text-[var(--color-muted)]">
            {principal.pending}
          </div>
        </div>
        <div className="px-3 py-2.5">
          <div className="font-mono text-[8.5px] uppercase tracking-[0.14em] text-[var(--color-dim)]">Último min.</div>
          <div
            className="tnum mt-1 font-display text-lg font-bold leading-none"
            style={{
              color: enCurso >= BURST_USD ? "var(--color-warn)" : "var(--color-dim)",
            }}
            title={`Se anota un estallido a partir de ${f.usd(BURST_USD)}`}
          >
            {enCurso > 0 ? f.usd(enCurso) : "—"}
          </div>
        </div>
      </div>

      {/* ---- barra de progreso hacia la muestra mínima ---- */}
      {principal.resolved < MIN_OBS && (
        <div className="border-b border-[var(--color-line-soft)] px-4 py-2">
          <div className="h-1 overflow-hidden rounded-full bg-[var(--color-surface-3)]">
            <div
              className="h-full rounded-full bg-[var(--color-accent)] transition-all duration-700"
              style={{ width: `${Math.min(100, (principal.resolved / MIN_OBS) * 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* ---- las dos hipótesis ---- */}
      {principal.momentum && principal.reversal ? (
        <>
          <div className="border-b border-[var(--color-line-soft)] px-4 py-1.5 font-mono text-[8.5px] uppercase tracking-[0.12em] text-[var(--color-dim)]">
            Dos lecturas opuestas del mismo dato
          </div>
          <Hipotesis s={principal.momentum} mejor={mejorEsMomentum} />
          <Hipotesis s={principal.reversal} mejor={!mejorEsMomentum} />
        </>
      ) : (
        <Empty>
          <p className="text-[10px] leading-relaxed">
            No existe histórico gratuito de liquidaciones en ningún exchange, así que no hay nada que rebobinar. Este
            registro se construye <b className="text-[var(--color-bright)]">hacia delante</b>: cada estallido queda
            anotado con su precio y una hora después se lee el resultado contra velas reales.
          </p>
          <p className="mt-2 font-mono text-[9px] leading-relaxed text-[var(--color-dim)]">
            {servidorVivo
              ? `El grabador de servidor trabaja cada hora, con o sin nadie delante. Con ${MIN_OBS} observaciones cerradas empezará a haber veredicto.`
              : `Deja la pestaña abierta. Con ${MIN_OBS} observaciones cerradas empezará a haber veredicto.`}
          </p>
        </Empty>
      )}

      <div className="border-t border-[var(--color-line-soft)] px-4 py-2.5">
        <div className="mb-1.5">
          <Tag kind={tono}>{principal.verdict}</Tag>
        </div>
        <p className="font-mono text-[9px] leading-relaxed text-[var(--color-muted)]">{principal.note}</p>
      </div>

      <footer className="mt-auto border-t border-[var(--color-line-soft)] px-4 py-2.5">
        <p className="font-mono text-[8px] leading-relaxed text-[var(--color-dim)]">
          Un estallido es más de {f.usd(BURST_USD)} liquidados en un minuto; después no se anota otro hasta pasada media
          hora, para no contar veinte veces la misma cascada. Se guarda el retorno{" "}
          <b className="text-[var(--color-muted)]">crudo</b>, de modo que las dos hipótesis opuestas se contrastan sobre
          los mismos datos sin haber elegido bando de antemano — por eso son espejo la una de la otra, y por eso el
          listón sube a t&gt;2,24. Las cascadas que barren varios símbolos a la vez cuentan como{" "}
          <b className="text-[var(--color-muted)]">un solo suceso</b>: sus retornos van casi siempre al mismo lado, así
          que sumarlos daría una muestra falsamente grande.
        </p>
        <p className="mt-2 font-mono text-[8px] leading-relaxed text-[var(--color-dim)]">
          {servidorVivo ? (
            <>
              <b style={{ color: congelado ? "var(--color-warn)" : "var(--color-up)" }}>Servidor</b> ·{" "}
              {server.study.obs.length} anotadas · comprobado {comprobado} · último dato {ultimoDato}.
              {congelado ? (
                <>
                  {" "}
                  <b className="text-[var(--color-warn)]">
                    Lleva demasiado sin dar señales de vida: el grabador puede estar parado.
                  </b>{" "}
                  Deja constancia cada seis horas aunque no encuentre nada, así que este silencio no es de un mercado
                  tranquilo.
                </>
              ) : (
                <> Corre solo cada hora, así que la muestra no depende de cuándo mires — por eso manda.</>
              )}
              {study.obs.length > 0 && (
                <>
                  {" "}Esta pestaña lleva otras {study.obs.length} por su cuenta, que se cuentan aparte: ve tres
                  exchanges en vez de uno y no son comparables.
                </>
              )}
            </>
          ) : SERVER_URL ? (
            <>
              <b className="text-[var(--color-warn)]">Servidor no disponible</b> ({server.error}). Se muestra lo grabado
              por esta pestaña: {study.obs.length} anotadas.
            </>
          ) : (
            <>
              <b className="text-[var(--color-warn)]">Sin grabador de servidor.</b> Solo cuenta lo que capture esta
              pestaña mientras esté abierta: {study.obs.length} anotadas.
            </>
          )}
        </p>
      </footer>
    </Card>
  );
}
