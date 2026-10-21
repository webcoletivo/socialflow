"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLayoutEffect, useRef, useState, useTransition } from "react";
import { Button, buttonClasses } from "@/components/Button";
import { Popover } from "@/components/Popover";
import { Toast, type ToastState } from "@/components/Toast";
import { EmptyState, FormatBadge, StatusBadge } from "@/components/ui";
import { Icon } from "@/components/Icons";
import { DesignBusyArea, useDesignNav } from "./DesignFilters";
import { DrivePath, patchArt } from "./DesignQueue";
import {
  applyOverride,
  doneWhenText,
  lateText,
  whenParts,
  type ArtOverride,
  type DesignRow,
  type UserRef,
} from "./design-view";
import {
  ART_LABEL,
  buildCalendar,
  POST_LABEL,
  type ArtCell,
  type CalendarClient,
  type CalendarCounts,
  type CalendarDay,
  type CalendarMarker,
  type CalendarRow,
  type PostState,
} from "./design-calendar";

/*
 * Calendário do Design (?ver=calendario): grade cliente × dia como a planilha
 * "Controle de Gestão" e o Quadro de Produção. Cada post é um marcador de duas
 * metades (arte | postagem); o clique abre um painel com os detalhes, o arquivo
 * no Drive e "Marcar arte como feita" (PATCH /api/posts/[id]/art, otimista).
 */

/* Mapas estáticos: o Tailwind só gera classes escritas por inteiro. */
const ART_HALF: Record<ArtCell, string> = {
  feita: "bg-art-ok text-on-solid",
  a_fazer: "bg-surface text-fg-muted",
  captacao: "bg-neutral-solid text-on-solid",
};
const POST_HALF: Record<PostState, string> = {
  publicado: "bg-success-solid text-on-solid",
  agendado: "bg-info-solid text-on-solid",
  aguardando: "bg-warning-solid text-on-solid",
  a_postar: "bg-sunken text-fg-muted",
  falhou: "bg-danger-solid text-on-solid",
};

type GlyphKind = "check" | "camera" | "arrow" | "clock" | "alert";
const ART_GLYPH: Record<ArtCell, GlyphKind | null> = { feita: "check", a_fazer: null, captacao: "camera" };
const POST_GLYPH: Record<PostState, GlyphKind | null> = {
  publicado: "check",
  agendado: "arrow",
  aguardando: "clock",
  a_postar: null,
  falhou: "alert",
};

/** Glifo de 10 px (traço grosso para ler pequeno); a cor nunca é o único indicador. */
function Glyph({ kind }: { kind: GlyphKind }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={3.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-2.5"
    >
      {kind === "check" && <path d="m4 12 5 5L20 6" />}
      {kind === "arrow" && <path d="M4 12h16M14 6l6 6-6 6" />}
      {kind === "clock" && (
        <>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 8v4l3 2" />
        </>
      )}
      {kind === "alert" && <path d="M12 4v10M12 20h.01" />}
      {kind === "camera" && (
        <>
          <rect x="3" y="7" width="13" height="10" rx="2" />
          <path d="m16 11 5-3v8l-5-3" />
        </>
      )}
    </svg>
  );
}

function Halves({ art, post }: { art: ArtCell; post: PostState }) {
  const half = "grid h-full w-1/2 place-items-center";
  const artGlyph = ART_GLYPH[art];
  const postGlyph = POST_GLYPH[post];
  return (
    <>
      <span aria-hidden="true" className={`${half} ${ART_HALF[art]}`}>
        {artGlyph && <Glyph kind={artGlyph} />}
      </span>
      <span aria-hidden="true" className={`${half} border-l border-line-strong ${POST_HALF[post]}`}>
        {postGlyph && <Glyph kind={postGlyph} />}
      </span>
    </>
  );
}

const LATE_RING = "shadow-[0_0_0_2px_var(--sf-surface),0_0_0_4px_var(--sf-danger-solid)]";

/* ------------------------------------------------------------------ *
 * Resumo e legenda
 * ------------------------------------------------------------------ */

function Summary({ counts, monthLabel }: { counts: CalendarCounts; monthLabel: string }) {
  const chip = "inline-flex h-8 items-center gap-2 rounded-control border border-line bg-surface pl-1.5 pr-3";
  const sample = "flex h-5 w-7 shrink-0 overflow-hidden rounded-chip border-[1.5px] border-line-strong";
  const items: { key: string; label: string; value: number; art: ArtCell; post: PostState }[] = [
    { key: "feita", label: "Arte ok", value: counts.artFeita, art: "feita", post: "a_postar" },
    { key: "a_fazer", label: "Arte a fazer", value: counts.artAFazer, art: "a_fazer", post: "a_postar" },
    { key: "aguardando", label: "Aguardando aprovação", value: counts.aguardando, art: "feita", post: "aguardando" },
    { key: "postados", label: "Postados", value: counts.postados, art: "feita", post: "publicado" },
  ];
  return (
    <ul aria-label={`Resumo de ${monthLabel}`} className="mb-4 flex flex-wrap gap-2">
      {items.map((it) => (
        <li key={it.key} className={chip}>
          <span aria-hidden="true" className={sample}>
            <Halves art={it.art} post={it.post} />
          </span>
          <span className="text-sm text-fg">
            {it.label}
            <span className="sr-only">:</span>
          </span>
          <span className="text-sm font-semibold tabular-nums text-fg">{it.value}</span>
        </li>
      ))}
      <li className={`${chip} ${counts.atrasadas > 0 ? "border-danger-line bg-danger-bg" : ""}`}>
        <span aria-hidden="true" className={`inline-flex size-4 shrink-0 [&>svg]:size-full ${counts.atrasadas > 0 ? "text-danger-solid" : "text-fg-muted"}`}>
          <Icon.alert />
        </span>
        <span className={`text-sm ${counts.atrasadas > 0 ? "text-danger-fg" : "text-fg"}`}>
          Artes atrasadas<span className="sr-only">:</span>
        </span>
        <span className={`text-sm font-semibold tabular-nums ${counts.atrasadas > 0 ? "text-danger-fg" : "text-fg"}`}>
          {counts.atrasadas}
        </span>
      </li>
      <li className="inline-flex h-8 items-center gap-2 px-2">
        <span className="text-sm text-fg-muted">
          Total<span className="sr-only">:</span>
        </span>
        <span className="text-sm font-semibold tabular-nums text-fg">{counts.total}</span>
      </li>
    </ul>
  );
}

function LegendItem({ sample, children }: { sample: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-3 text-sm text-fg">
      <span aria-hidden="true" className="flex h-5 w-7 shrink-0 overflow-hidden rounded-chip border-[1.5px] border-line-strong">
        {sample}
      </span>
      <span>{children}</span>
    </li>
  );
}

function HalfSample({ cls, glyph }: { cls: string; glyph: GlyphKind | null }) {
  return <span className={`grid h-full w-full place-items-center ${cls}`}>{glyph && <Glyph kind={glyph} />}</span>;
}

function CalendarLegend() {
  const heading = "mb-2 text-xs font-semibold uppercase tracking-overline text-fg-muted";
  return (
    <details className="group mb-4">
      <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-control text-sm font-medium text-fg sm:min-h-10 [&::-webkit-details-marker]:hidden">
        <Icon.chevronRight className="size-4 shrink-0 text-fg-muted transition-transform duration-(--sf-dur-fast) group-open:rotate-90" />
        Como ler o calendário
      </summary>
      <div className="card mt-2 grid gap-5 p-4 sm:grid-cols-2 lg:grid-cols-3">
        <section>
          <h2 className={heading}>Metade da esquerda: arte</h2>
          <ul className="space-y-2">
            <LegendItem sample={<HalfSample cls={ART_HALF.feita} glyph="check" />}>
              {ART_LABEL.feita} (roxo da planilha): marcada no Design, com mídia ou publicada
            </LegendItem>
            <LegendItem sample={<HalfSample cls={ART_HALF.a_fazer} glyph={null} />}>{ART_LABEL.a_fazer}</LegendItem>
            <LegendItem sample={<HalfSample cls={ART_HALF.captacao} glyph="camera" />}>
              {ART_LABEL.captacao}: reels gravado ainda sem arte
            </LegendItem>
          </ul>
        </section>
        <section>
          <h2 className={heading}>Metade da direita: postagem</h2>
          <ul className="space-y-2">
            {(Object.keys(POST_LABEL) as PostState[]).map((p) => (
              <LegendItem key={p} sample={<HalfSample cls={POST_HALF[p]} glyph={POST_GLYPH[p]} />}>
                {POST_LABEL[p]}
                {p === "publicado" && " (verde da planilha: “Arte postada”)"}
                {p === "aguardando" && " (amarelo da planilha)"}
              </LegendItem>
            ))}
          </ul>
        </section>
        <section className="sm:col-span-2 lg:col-span-1">
          <h2 className={heading}>Avisos</h2>
          <ul className="space-y-2">
            <li className="flex items-center gap-3 text-sm text-fg">
              <span aria-hidden="true" className={`flex h-5 w-7 shrink-0 overflow-hidden rounded-chip border-[1.5px] border-line-strong ${LATE_RING}`}>
                <HalfSample cls={ART_HALF.a_fazer} glyph={null} />
              </span>
              <span>Anel vermelho: arte atrasada (publicação em menos de 48 h ou já passou)</span>
            </li>
            <li className="flex items-center gap-3 text-sm text-fg">
              <span aria-hidden="true" className="inline-flex w-7 shrink-0 justify-center text-danger-solid [&>svg]:size-4">
                <Icon.shield />
              </span>
              <span>Seção “Com aprovação”: fazer primeiro (vermelho da planilha)</span>
            </li>
          </ul>
        </section>
      </div>
    </details>
  );
}

/* ------------------------------------------------------------------ *
 * Grade
 * ------------------------------------------------------------------ */

function ClientHeader({ line }: { line: CalendarRow }) {
  const c = line.client;
  return (
    <>
      <Link
        href={`/clients/${c.id}`}
        prefetch={false}
        title={c.name}
        className="group/cliente flex min-h-11 flex-col justify-center rounded-chip py-0.5 sm:min-h-10"
      >
        <span className="line-clamp-2 text-sm font-semibold wrap-break-word text-fg group-hover/cliente:underline">
          {c.name}
        </span>
        <span className="truncate text-xs font-normal text-fg-muted">
          {c.designer ? c.designer.name : "Sem designer"}
        </span>
      </Link>
      {!c.agencyPublishes && (
        <div className="pb-1">
          <StatusBadge kind="agencyPublishes" status="nao" size="sm" />
        </div>
      )}
    </>
  );
}

const DAY_BG = (col: CalendarDay) => (col.today ? "bg-today" : col.weekend ? "bg-sunken" : "");

function artText(row: DesignRow): string {
  if (row.artStatus === "a_fazer") return row.contentKind === "reels_gravado" ? "Captação / arte a fazer" : "A fazer";
  if (row.artSource === "marcada" && row.artDoneAt) {
    return row.artDoneBy
      ? `Feita por ${row.artDoneBy.name} em ${doneWhenText(row.artDoneAt)}`
      : `Feita em ${doneWhenText(row.artDoneAt)}`;
  }
  if (row.artSource === "publicado") return "Post já publicado";
  return "Arte já no post";
}

function MarkerPanel({
  marker,
  nowMs,
  busy,
  onToggle,
}: {
  marker: CalendarMarker;
  nowMs: number;
  busy: boolean;
  onToggle: (row: DesignRow, done: boolean) => void;
}) {
  const row = marker.row;
  const w = whenParts(row.scheduledAt);
  const term = "text-xs font-semibold uppercase tracking-overline text-fg-muted";
  const canMark = row.artStatus === "a_fazer" && row.status !== "published";
  const canUnmark = row.artSource === "marcada" && row.status !== "published";
  return (
    <div className="grid gap-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <FormatBadge format={row.format} kind={row.contentKind} />
          <span className="text-xs text-fg-muted">
            {w.weekday}, {w.date} às {w.time}
          </span>
        </div>
        <p className="mt-1 font-semibold text-fg wrap-break-word">{row.theme?.trim() || "Post sem tema"}</p>
        <p className="text-sm text-fg-muted wrap-break-word">{row.client.name}</p>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1.5">
        <dt className={term}>Arte</dt>
        <dd className="text-sm text-fg">
          {artText(row)}
          {row.late && (
            <span className="mt-0.5 block text-xs font-medium text-danger-fg">
              Atrasada · {lateText(row.scheduledAt, nowMs)}
            </span>
          )}
        </dd>
        <dt className={term}>Postagem</dt>
        <dd className="text-sm text-fg">{POST_LABEL[marker.post]}</dd>
        <dt className={term}>Redação</dt>
        <dd>
          <StatusBadge kind="stage" status={row.stage} />
        </dd>
      </dl>
      {row.drive && <DrivePath path={row.drive.path} />}
      <div className="flex flex-wrap gap-2">
        {canMark && (
          <Button size="sm" variant="primary" leadingIcon={<Icon.check />} disabled={busy} onClick={() => onToggle(row, true)}>
            Marcar arte como feita
          </Button>
        )}
        {canUnmark && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => onToggle(row, false)}>
            Marcar como não feita
          </Button>
        )}
        <Link href={`/posts/${row.id}`} prefetch={false} className={buttonClasses({ variant: "ghost", size: "sm" })}>
          Abrir post
        </Link>
      </div>
    </div>
  );
}

export default function DesignCalendar({
  rows,
  clients,
  month,
  monthLabel,
  todayKey,
  nowMs,
  me,
}: {
  /** todos os posts do mês dos clientes filtrados (publicados inclusive) */
  rows: DesignRow[];
  /** clientes filtrados (uma linha cada, mesmo sem post) */
  clients: CalendarClient[];
  /** "AAAA-MM" */
  month: string;
  monthLabel: string;
  todayKey: string;
  nowMs: number;
  me: UserRef | null;
}) {
  const router = useRouter();
  const [, startRefresh] = useTransition();
  const { filtersOpen } = useDesignNav();
  const regionRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  // mesmas regras do otimismo da fila: com dados novos só ficam as mudanças em andamento
  const [overrides, setOverrides] = useState<ReadonlyMap<string, ArtOverride>>(() => new Map());
  const [inflight, setInflight] = useState<ReadonlySet<string>>(() => new Set());
  const [seenRows, setSeenRows] = useState(rows);
  if (seenRows !== rows) {
    setSeenRows(rows);
    setOverrides(new Map([...overrides].filter(([id]) => inflight.has(id))));
  }
  const [toast, setToast] = useState<ToastState>(null);

  const effective = rows.map((r) => applyOverride(r, overrides.get(r.id), nowMs));
  const model = buildCalendar({ month, todayKey, clients, rows: effective });
  const markers = new Map<string, CalendarMarker>();
  for (const s of model.sections) for (const l of s.rows) for (const list of l.days.values()) for (const m of list) markers.set(m.row.id, m);
  const openMarker = openId ? (markers.get(openId) ?? null) : null;

  // abre o mês atual com "hoje − 2" logo depois da coluna de clientes (como na Produção)
  useLayoutEffect(() => {
    const region = regionRef.current;
    const anchor = region?.querySelector<HTMLElement>("[data-scroll-anchor]");
    const sticky = region?.querySelector<HTMLElement>("thead th");
    if (!region || !anchor || !sticky) return;
    const delta = anchor.getBoundingClientRect().left - region.getBoundingClientRect().left - region.clientLeft - sticky.offsetWidth;
    region.scrollLeft = Math.max(0, region.scrollLeft + delta);
  }, [month]);

  async function toggle(row: DesignRow, done: boolean) {
    if (inflight.has(row.id)) return;
    const previous = overrides.get(row.id);
    setOverrides((prev) =>
      new Map(prev).set(row.id, { done, artDoneAt: done ? new Date().toISOString() : null, artDoneBy: done ? me : null }),
    );
    setInflight((prev) => new Set(prev).add(row.id));
    const result = await patchArt(row.id, done);
    setInflight((prev) => {
      const next = new Set(prev);
      next.delete(row.id);
      return next;
    });
    const theme = row.theme?.trim() || "Post sem tema";
    if (!result.ok) {
      setOverrides((prev) => {
        const next = new Map(prev);
        if (previous) next.set(row.id, previous);
        else next.delete(row.id);
        return next;
      });
      setToast({
        kind: "error",
        text: `Não foi possível marcar a arte de «${theme}» como ${done ? "feita" : "não feita"}. ${result.message}`,
      });
      return;
    }
    setOverrides((prev) => new Map(prev).set(row.id, { done, artDoneAt: result.artDoneAt, artDoneBy: result.artDoneBy }));
    setToast({ kind: "success", text: done ? "Arte marcada como feita." : "Arte marcada como não feita." });
    startRefresh(() => router.refresh());
  }

  const colCount = model.days.length + 2;

  if (model.sections.length === 0) {
    return (
      <DesignBusyArea>
        <EmptyState
          headingLevel={2}
          icon={<Icon.calendar />}
          title="Nenhum cliente com esses filtros"
          description={`Não há clientes ativos com esses filtros em ${monthLabel}. Mude ou limpe os filtros.`}
        />
      </DesignBusyArea>
    );
  }

  return (
    <>
      <DesignBusyArea>
        <Summary counts={model.counts} monthLabel={monthLabel} />
        <CalendarLegend />
        <div
          ref={regionRef}
          role="region"
          aria-label={`Calendário de artes de ${monthLabel}`}
          tabIndex={0}
          className="relative overflow-auto rounded-card border border-line bg-surface"
          style={{ maxHeight: "calc(100dvh - 14rem)" }}
        >
          <table className="w-full min-w-max border-separate border-spacing-0 text-sm">
            <caption className="sr-only">
              Calendário de artes de {monthLabel}: uma linha por cliente e uma coluna por dia. Cada post é um botão com a
              situação da arte e da postagem.
            </caption>
            <thead>
              <tr>
                <th
                  scope="col"
                  className="sticky left-0 top-0 z-20 w-32 min-w-32 border-b border-r border-line bg-surface px-2 text-left text-xs font-semibold text-fg-muted md:w-44 md:min-w-44 md:px-3"
                >
                  Cliente
                </th>
                {model.days.map((col) => (
                  <th
                    key={col.day}
                    scope="col"
                    aria-current={col.today ? "date" : undefined}
                    data-scroll-anchor={col.scrollAnchor ? "" : undefined}
                    className={`sticky top-0 z-10 h-12 min-w-12 border-b border-r border-line px-0 text-center align-middle font-normal md:min-w-10 ${
                      col.today ? "bg-surface bg-linear-to-b from-today to-today" : col.weekend ? "bg-sunken" : "bg-surface"
                    }`}
                  >
                    <abbr title={col.weekdayFull} className="block text-xs text-fg-muted no-underline">
                      {col.weekday}
                    </abbr>
                    <span
                      className={`inline-block text-xs font-semibold tabular-nums ${
                        col.today ? "rounded-chip bg-brand px-1 text-on-brand" : "text-fg"
                      }`}
                    >
                      {col.day}
                    </span>
                  </th>
                ))}
                <th
                  scope="col"
                  className="sticky top-0 z-10 w-24 min-w-24 border-b border-line bg-surface px-2 text-left text-xs font-semibold text-fg-muted md:px-3"
                >
                  Total
                </th>
              </tr>
            </thead>
            {model.sections.map((section) => (
              <tbody key={section.key}>
                <tr>
                  <th
                    scope="colgroup"
                    colSpan={colCount}
                    className="border-b border-line bg-sunken p-0 text-left text-xs font-semibold uppercase tracking-overline text-fg-muted"
                  >
                    {/* o rótulo fica preso à esquerda enquanto a grade rola na horizontal */}
                    <span className="sticky left-0 inline-flex items-center gap-1.5 px-2 py-1.5 md:px-3">
                      {section.key === "aprovacao" && (
                        <span aria-hidden="true" className="inline-flex size-3.5 text-danger-solid [&>svg]:size-full">
                          <Icon.shield />
                        </span>
                      )}
                      {section.title} · {section.rows.length}
                    </span>
                  </th>
                </tr>
                {section.rows.map((line) => (
                  <tr key={line.client.id} className="h-13 md:h-11">
                    <th
                      scope="row"
                      className="sticky left-0 z-10 w-32 min-w-32 max-w-32 border-b border-r border-line bg-surface px-2 text-left align-middle font-normal md:w-44 md:min-w-44 md:max-w-44 md:px-3"
                    >
                      <ClientHeader line={line} />
                    </th>
                    {model.days.map((col) => {
                      const list = line.days.get(col.day);
                      return (
                        <td key={col.day} className={`border-b border-r border-line p-0 align-middle ${DAY_BG(col)}`}>
                          {list && list.length > 0 && (
                            <div className="flex flex-col items-center gap-2 py-1.5">
                              {list.map((m) => (
                                <button
                                  key={m.row.id}
                                  type="button"
                                  aria-label={m.ariaLabel}
                                  title={m.ariaLabel}
                                  aria-haspopup="dialog"
                                  aria-expanded={openId === m.row.id}
                                  onClick={(e) => {
                                    anchorRef.current = e.currentTarget;
                                    setOpenId((cur) => (cur === m.row.id ? null : m.row.id));
                                  }}
                                  className={`flex h-10 w-10 shrink-0 overflow-hidden rounded-chip border-[1.5px] border-line-strong transition-shadow duration-(--sf-dur-fast) hover:shadow-raised focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-focus md:h-6 md:w-8 ${
                                    m.row.late ? LATE_RING : ""
                                  } ${inflight.has(m.row.id) ? "opacity-60" : ""}`}
                                >
                                  <Halves art={m.art} post={m.post} />
                                </button>
                              ))}
                            </div>
                          )}
                        </td>
                      );
                    })}
                    <td className="border-b border-line px-2 align-middle md:px-3">
                      <p className="text-sm text-fg">
                        <span className="font-semibold">{line.total}</span> {line.total === 1 ? "post" : "posts"}
                      </p>
                      {line.total > 0 && (
                        <p className="text-xs tabular-nums text-fg-muted">
                          {line.artDone} {line.artDone === 1 ? "arte ok" : "artes ok"}
                        </p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      </DesignBusyArea>

      <Popover
        open={!!openMarker}
        onOpenChange={(open) => {
          if (!open) setOpenId(null);
        }}
        anchorRef={anchorRef}
        aria-label={openMarker ? openMarker.ariaLabel : "Post"}
        className="w-80 max-w-[calc(100vw-1rem)] p-4"
      >
        {openMarker && (
          <MarkerPanel
            marker={openMarker}
            nowMs={nowMs}
            busy={inflight.has(openMarker.row.id)}
            onToggle={(r, d) => void toggle(r, d)}
          />
        )}
      </Popover>

      <Toast toast={filtersOpen ? null : toast} onClose={() => setToast(null)} />
    </>
  );
}
