"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { Button } from "@/components/Button";
import { Callout } from "@/components/Callout";
import { Icon } from "@/components/Icons";
import { Toast, type ToastState } from "@/components/Toast";
import { EmptyState, FormatBadge, StatusBadge, ToneBadge } from "@/components/ui";
import { formatMeta } from "@/lib/formats";
import { toUserMessage } from "@/lib/user-facing-error";
import { DesignBusyArea, useDesignNav } from "./DesignFilters";
import {
  adjustCounts,
  applyOverride,
  compareRows,
  DESIGNER_ALL,
  designHref,
  doneWhenText,
  groupByDay,
  lateText,
  lateWarning,
  matchesShow,
  plural,
  whenParts,
  type ArtOverride,
  type ArtSource,
  type DesignCounts,
  type DesignFilterValues,
  type DesignRow,
  type UserRef,
} from "./design-view";

/*
 * Fila de artes da equipe de design (/design): avisos (resumo + atrasadas), lista
 * agrupada por dia e "Marcar como feita" otimista (PATCH /api/posts/[id]/art).
 * Também exporta o painel do cartão "Arte" do detalhe do post (ArtStatusPanel).
 */

/* ------------------------------------------------------------------ *
 * API da arte (PATCH /api/posts/[id]/art) — N-14: só `error` em texto
 * ------------------------------------------------------------------ */

const NETWORK_ERROR = "Não foi possível falar com o servidor. Verifique a conexão e tente de novo.";
const FALLBACK_ERROR = "Tente de novo em instantes.";

export type PatchArtResult =
  | { ok: true; artDoneAt: string | null; artDoneBy: UserRef | null }
  | { ok: false; message: string };

/** Termina a frase com ponto (as mensagens da API podem vir sem). */
function sentence(s: string): string {
  const t = s.trim();
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

function asUserRef(v: unknown): UserRef | null {
  if (!v || typeof v !== "object") return null;
  const o = v as { id?: unknown; name?: unknown };
  return typeof o.id === "string" && typeof o.name === "string" ? { id: o.id, name: o.name } : null;
}

/** Marca (done=true) ou desmarca a arte de um post. Nunca lança; erro vira frase pt-BR. */
export async function patchArt(postId: string, done: boolean): Promise<PatchArtResult> {
  let res: Response;
  try {
    res = await fetch(`/api/posts/${postId}/art`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ done }),
    });
  } catch {
    return { ok: false, message: NETWORK_ERROR };
  }
  const body: unknown = await res.json().catch(() => null);
  const obj = body && typeof body === "object" ? (body as { error?: unknown; artDoneAt?: unknown; artDoneBy?: unknown }) : {};
  if (!res.ok) {
    if (res.status === 401) return { ok: false, message: "Sua sessão expirou. Entre de novo para continuar." };
    const error = typeof obj.error === "string" ? obj.error : undefined;
    return { ok: false, message: sentence(toUserMessage(error, FALLBACK_ERROR)) };
  }
  return {
    ok: true,
    artDoneAt: typeof obj.artDoneAt === "string" ? obj.artDoneAt : null,
    artDoneBy: asUserRef(obj.artDoneBy),
  };
}

/* ------------------------------------------------------------------ *
 * Caminho do arquivo no Drive + "Copiar caminho"
 * ------------------------------------------------------------------ */

type CopyState = "idle" | "copied" | "selected";

/**
 * Nome esperado do arquivo no Drive e o botão "Copiar caminho" (área de
 * transferência; sem ela, seleciona o texto para o Ctrl+C). `compactFrom="xl"`:
 * a partir de xl o botão vira só ícone, ao lado do caminho.
 */
export function DrivePath({ path, compactFrom }: { path: string; compactFrom?: "xl" }) {
  const codeId = useId();
  const fileId = `${codeId}-arquivo`;
  const [state, setState] = useState<CopyState>("idle");

  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 3000);
    return () => clearTimeout(t);
  }, [state]);

  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("sem área de transferência");
      await navigator.clipboard.writeText(path);
      setState("copied");
    } catch {
      // pasta e arquivo ficam em <code> separados: seleciona do início da pasta ao fim do arquivo
      const start = document.getElementById(codeId);
      const end = document.getElementById(fileId);
      const selection = window.getSelection();
      if (start && end && selection) {
        const range = document.createRange();
        range.setStart(start, 0);
        range.setEnd(end, end.childNodes.length);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      setState("selected");
    }
  }

  const done = state !== "idle";
  const feedback = state === "copied" ? "Caminho copiado." : state === "selected" ? "Caminho selecionado: copie com Ctrl+C." : "";
  const textLabel = state === "copied" ? "Copiado" : state === "selected" ? "Selecionado" : "Copiar caminho";
  const compact = compactFrom === "xl";
  // pasta + arquivo: o nome do arquivo (em destaque) nunca quebra; a pasta quebra nas barras
  // ("Bergamo/2026/" + "10 - Outubro/"), não no meio de "10 - Outubro". Trecho muito longo
  // (nome de cliente comprido) pode quebrar por dentro para não estourar o celular.
  const cut = path.lastIndexOf("/", path.endsWith("/") ? path.length - 2 : path.length - 1);
  const folder = path.slice(0, cut + 1);
  const file = path.slice(cut + 1);
  const segments = folder.match(/[^/]*\//g) ?? [];

  return (
    <div className="grid min-w-0 justify-items-start gap-1">
      <p className="flex min-w-0 max-w-full items-start gap-1.5">
        <span aria-hidden="true" className="mt-0.5 inline-flex size-4 shrink-0 text-fg-muted [&>svg]:size-full">
          <Icon.folder />
        </span>
        {/* caminho e botão (≥ xl) no mesmo fluxo de texto: o botão acompanha o fim do caminho, mesmo quando ele quebra */}
        {/* text-xs/leading-5 aqui também: a linha do caminho não herda os 24 px do texto base */}
        <span className="min-w-0 text-xs leading-5">
          <span className="sr-only">Arquivo no Drive: </span>
          {/* spans em linha (sem flex): a seleção do fallback copia o caminho sem quebra de linha */}
          <code id={codeId} title={path} className="font-mono wrap-anywhere">
            {segments.map((seg, i) => (
              <span key={i}>
                <span className={`text-fg-muted ${seg.length <= 24 ? "whitespace-nowrap" : ""}`}>{seg}</span>
                <wbr />
              </span>
            ))}
          </code>
          {/* arquivo + botão juntos: o ícone nunca desce sozinho para a linha de baixo */}
          <span className="whitespace-nowrap">
            <code id={fileId} title={path} className="font-mono font-semibold text-fg">
              {file}
            </code>
            {compact && (
              <span className="ml-1 hidden items-center align-middle xl:inline-flex">
                <Button
                  iconOnly
                  variant="ghost"
                  size="sm"
                  aria-label={`Copiar caminho: ${file}`}
                  title="Copiar caminho"
                  onClick={copy}
                  className="-my-1.5"
                >
                  {done ? <Icon.check /> : <Icon.copy />}
                </Button>
              </span>
            )}
          </span>
          {compact && done && (
            <span aria-hidden="true" className="ml-1 hidden font-medium text-success-fg xl:inline">
              {state === "copied" ? "Copiado" : "Selecionado"}
            </span>
          )}
        </span>
      </p>
      <Button
        size="md"
        variant="ghost"
        leadingIcon={done ? <Icon.check /> : <Icon.copy />}
        aria-label={`${textLabel}: ${file}`}
        onClick={copy}
        className={`-ml-3 ${compact ? "xl:hidden" : ""}`}
      >
        {textLabel}
      </Button>
      <span role="status" className="sr-only">
        {feedback}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Textos da arte
 * ------------------------------------------------------------------ */

function doneText(row: { artSource: ArtSource; artDoneAt: string | null; artDoneBy: UserRef | null }): string {
  if (row.artSource === "marcada" && row.artDoneAt) {
    return row.artDoneBy
      ? `Feita por ${row.artDoneBy.name} em ${doneWhenText(row.artDoneAt)}`
      : `Feita em ${doneWhenText(row.artDoneAt)}`;
  }
  if (row.artSource === "publicado") return "Post já publicado";
  return "Arte já no post";
}

function itemLabel(row: DesignRow): string {
  const w = whenParts(row.scheduledAt);
  // formato e hora: feed e stories do mesmo tema no mesmo dia têm nomes distintos
  return `${row.theme?.trim() || "Post sem tema"} (${formatMeta(row.format).label}, ${row.client.name}, ${w.date} às ${w.time})`;
}

/* ------------------------------------------------------------------ *
 * Item da fila
 * ------------------------------------------------------------------ */

function DesignItem({
  row,
  nowMs,
  onToggle,
}: {
  row: DesignRow;
  nowMs: number;
  onToggle: (row: DesignRow, done: boolean) => void;
}) {
  const w = whenParts(row.scheduledAt);
  const theme = row.theme?.trim() || "Post sem tema";
  const label = itemLabel(row);
  return (
    <li
      data-item={row.id}
      className="grid gap-3 rounded-card border border-line bg-surface p-4 shadow-card xl:grid-cols-[minmax(0,1.2fr)_12.5rem_minmax(0,1.2fr)_15rem] xl:items-center xl:gap-x-5 xl:rounded-none xl:border-0 xl:border-t xl:py-3 xl:shadow-none xl:first:border-t-0"
    >
      {/* formato + tema; cliente · designer */}
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2">
          <FormatBadge format={row.format} kind={row.contentKind} />
          <Link
            href={`/posts/${row.id}`}
            prefetch={false}
            className="inline-flex min-h-11 min-w-0 items-center font-semibold text-fg underline-offset-2 hover:text-link hover:underline xl:min-h-8"
          >
            <span className="line-clamp-2 wrap-break-word">{theme}</span>
          </Link>
        </div>
        <p className="text-sm text-fg-muted wrap-break-word">
          {row.client.name}
          <span aria-hidden="true"> · </span>
          <span className="sr-only">, </span>
          {row.designer ? `Designer: ${row.designer.name}` : "Sem designer"}
        </p>
      </div>

      {/* publicação + atraso */}
      <div className="text-sm">
        <p className="text-fg">
          <span className="sr-only">Publicação: </span>
          <abbr title={w.weekday} className="no-underline">
            {w.weekdayShort}
          </abbr>
          , {w.date} · {w.time}
        </p>
        {row.late && (
          <p className="mt-0.5 flex items-start gap-1 text-xs font-medium text-danger-fg">
            <span aria-hidden="true" className="mt-px inline-flex size-3.5 shrink-0 text-danger-solid [&>svg]:size-full">
              <Icon.alert />
            </span>
            {/* um só bloco de texto: se faltar espaço, quebra só depois de "Atrasada ·" */}
            <span>
              Atrasada&nbsp;· <span className="whitespace-nowrap">{lateText(row.scheduledAt, nowMs)}</span>
            </span>
          </p>
        )}
      </div>

      {/* etapa da redação + arquivo no Drive */}
      <div className="grid min-w-0 gap-2">
        <p>
          <span className="sr-only">Etapa da redação: </span>
          <StatusBadge kind="stage" status={row.stage} />
        </p>
        {row.drive ? (
          <DrivePath path={row.drive.path} compactFrom="xl" />
        ) : (
          <p className="text-xs text-fg-muted">Sem nome de arquivo no Drive</p>
        )}
      </div>

      {/* ação */}
      {row.artStatus === "a_fazer" ? (
        <div className="xl:flex xl:justify-end">
          <Button
            data-item-action={row.id}
            leadingIcon={<Icon.check />}
            aria-label={`Marcar como feita: ${label}`}
            onClick={() => onToggle(row, true)}
            className="w-full xl:w-auto"
          >
            Marcar como feita
          </Button>
        </div>
      ) : (
        <div className="grid gap-1 xl:justify-items-end xl:text-right">
          <p className="flex items-start gap-1.5 text-sm text-success-fg xl:justify-end">
            <span aria-hidden="true" className="mt-0.5 inline-flex size-4 shrink-0 text-success-solid [&>svg]:size-full">
              <Icon.check />
            </span>
            {doneText(row)}
          </p>
          {row.artSource === "marcada" && (
            <Button
              variant="ghost"
              data-item-action={row.id}
              aria-label={`Marcar como não feita: ${label}`}
              onClick={() => onToggle(row, false)}
              className="w-full justify-start px-2 sm:w-auto xl:justify-center"
            >
              Marcar como não feita
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ *
 * Avisos: resumo + atrasadas
 * ------------------------------------------------------------------ */

function Summary({
  counts,
  monthLabel,
  showingDone,
  onShowToDo,
}: {
  counts: DesignCounts;
  monthLabel: string;
  showingDone: boolean;
  onShowToDo: () => void;
}) {
  const chip = "inline-flex h-8 items-center gap-2 rounded-control border border-line bg-surface pl-2 pr-3";
  const icon = "inline-flex size-4 shrink-0 [&>svg]:size-full";
  return (
    <section aria-label="Avisos" className="mb-5 grid gap-3">
      <ul aria-label={`Resumo das artes de ${monthLabel}`} className="flex flex-wrap gap-2">
        <li className={chip}>
          <span aria-hidden="true" className={`${icon} text-fg-muted`}>
            <Icon.clock />
          </span>
          <span className="text-sm text-fg">
            A fazer<span className="sr-only">:</span>
          </span>
          <span className="text-sm font-semibold tabular-nums text-fg">{counts.aFazer}</span>
        </li>
        <li className={`${chip} ${counts.atrasadas > 0 ? "border-danger-line bg-danger-bg" : ""}`}>
          <span aria-hidden="true" className={`${icon} ${counts.atrasadas > 0 ? "text-danger-solid" : "text-fg-muted"}`}>
            <Icon.alert />
          </span>
          <span className={`text-sm ${counts.atrasadas > 0 ? "text-danger-fg" : "text-fg"}`}>
            Atrasadas<span className="sr-only">:</span>
          </span>
          <span
            className={`text-sm font-semibold tabular-nums ${counts.atrasadas > 0 ? "text-danger-fg" : "text-fg"}`}
          >
            {counts.atrasadas}
          </span>
        </li>
        <li className={chip}>
          <span aria-hidden="true" className={`${icon} text-success-solid`}>
            <Icon.check />
          </span>
          <span className="text-sm text-fg">
            Feitas<span className="sr-only">:</span>
          </span>
          <span className="text-sm font-semibold tabular-nums text-fg">{counts.feitas}</span>
        </li>
      </ul>
      {counts.atrasadas > 0 && (
        <Callout
          tone="warning"
          title={lateWarning(counts.atrasadas)}
          action={
            showingDone ? (
              <Button size="sm" onClick={onShowToDo}>
                Ver a fazer
              </Button>
            ) : undefined
          }
        >
          {showingDone
            ? "Elas estão na lista “A fazer”."
            : counts.atrasadas === 1
              ? "Ela está no topo da lista."
              : "Elas estão no topo da lista."}
        </Callout>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Tela
 * ------------------------------------------------------------------ */

/** Ação "Desfazer" do Toast: o Toast só aceita link; o clique é interceptado aqui (ver DesignQueue). */
const UNDO_HASH = "#desfazer";

type Undo = { row: DesignRow; done: boolean };

export default function DesignQueue({
  rows,
  counts,
  values,
  defaultDesigner,
  isDesigner,
  monthLabel,
  todayKey,
  nowMs,
  me,
}: {
  rows: DesignRow[];
  /** contagens do servidor sobre todo o filtro (independem de "mostrar") */
  counts: DesignCounts;
  values: DesignFilterValues;
  defaultDesigner: string;
  isDesigner: boolean;
  monthLabel: string;
  /** "AAAA-MM-DD" de hoje (SP), do servidor */
  todayKey: string;
  /** relógio do servidor no momento da leitura */
  nowMs: number;
  /** usuária da sessão (quem marca) */
  me: UserRef | null;
}) {
  const router = useRouter();
  const [, startRefresh] = useTransition();
  const refresh = () => startRefresh(() => router.refresh());
  const { go, filtersOpen } = useDesignNav();
  const listRef = useRef<HTMLDivElement>(null);

  // Mudanças otimistas por post. Com dados novos do servidor só ficam as que ainda
  // têm pedido em andamento (as concluídas já vêm certas do servidor).
  const [overrides, setOverrides] = useState<ReadonlyMap<string, ArtOverride>>(() => new Map());
  const [inflight, setInflight] = useState<ReadonlySet<string>>(() => new Set());
  const [seenRows, setSeenRows] = useState(rows);
  if (seenRows !== rows) {
    setSeenRows(rows);
    setOverrides(new Map([...overrides].filter(([id]) => inflight.has(id))));
  }

  const [toast, setToast] = useState<ToastState>(null);
  const [undo, setUndo] = useState<Undo | null>(null);

  const effective = rows.map((r) => applyOverride(r, overrides.get(r.id), nowMs));
  const liveCounts = adjustCounts(counts, rows, effective);
  const visible = effective.filter((r) => matchesShow(r, values.mostrar)).sort(compareRows);
  const groups = groupByDay(visible, todayKey);
  const ordered = groups.flatMap((g) => g.items);

  /** Foco depois da mudança: a ação do próprio item (se continua na lista) ou a do vizinho. */
  function restoreFocus(id: string, neighborId: string | null) {
    requestAnimationFrame(() => {
      const find = (target: string | null) =>
        target
          ? Array.from(document.querySelectorAll<HTMLElement>(`[data-item-action="${target}"]`)).find(
              (el) => el.getClientRects().length > 0,
            )
          : undefined;
      const target = find(id) ?? find(neighborId) ?? listRef.current;
      target?.focus();
    });
  }

  async function toggle(row: DesignRow, done: boolean, isUndo = false) {
    if (inflight.has(row.id)) return;
    const active = document.activeElement;
    const focusInside =
      isUndo || (active instanceof HTMLElement && !!active.closest(`[data-item="${row.id}"]`));
    const index = ordered.findIndex((r) => r.id === row.id);
    const neighbor = index >= 0 ? (ordered[index + 1] ?? ordered[index - 1] ?? null) : null;
    const previous = overrides.get(row.id);

    setOverrides((prev) =>
      new Map(prev).set(row.id, {
        done,
        artDoneAt: done ? new Date().toISOString() : null,
        artDoneBy: done ? me : null,
      }),
    );
    setInflight((prev) => new Set(prev).add(row.id));
    if (focusInside) restoreFocus(row.id, neighbor?.id ?? null);

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
      setUndo(null);
      setToast({
        kind: "error",
        text: `Não foi possível marcar a arte de «${theme}» como ${done ? "feita" : "não feita"}. ${result.message}`,
      });
      if (focusInside) restoreFocus(row.id, neighbor?.id ?? null);
      return;
    }
    setOverrides((prev) =>
      new Map(prev).set(row.id, { done, artDoneAt: result.artDoneAt, artDoneBy: result.artDoneBy }),
    );
    if (isUndo) {
      setUndo(null);
      setToast({ kind: "success", text: "Alteração desfeita." });
    } else {
      setUndo({ row, done: !done });
      setToast({
        kind: "success",
        text: done ? "Arte marcada como feita." : "Arte marcada como não feita.",
        action: { label: "Desfazer", href: `${designHref(values, defaultDesigner)}${UNDO_HASH}` },
      });
    }
    refresh();
  }

  /**
   * O Toast do design system só aceita ação com `href`. "Desfazer" é um link para
   * `#desfazer` cujo clique é interceptado na captura (o next/link não navega quando
   * o evento já vem com preventDefault).
   */
  function onToastClickCapture(e: React.MouseEvent) {
    const link = (e.target as Element).closest?.("a");
    if (!link || !link.getAttribute("href")?.endsWith(UNDO_HASH)) return;
    e.preventDefault();
    if (undo) void toggle(undo.row, undo.done, true);
  }

  const showingDone = values.mostrar === "feitas";
  const mineDefault = isDesigner && values.designer === defaultDesigner;
  const otherFilters = values.cliente !== "" || (values.designer !== defaultDesigner && values.designer !== DESIGNER_ALL);

  let empty: React.ReactNode = null;
  if (visible.length === 0) {
    if (liveCounts.total === 0) {
      empty = otherFilters ? (
        <EmptyState
          headingLevel={2}
          icon={<Icon.search />}
          title="Nenhum post com esses filtros"
          description={`Não há posts de clientes ativos com esses filtros em ${monthLabel}.`}
          action={
            <Button variant="secondary" onClick={() => go(designHref({ ...values, designer: defaultDesigner, cliente: "" }, defaultDesigner))}>
              Limpar filtros
            </Button>
          }
        />
      ) : mineDefault ? (
        <EmptyState
          headingLevel={2}
          icon={<Icon.calendar />}
          title={`Nenhum post dos seus clientes em ${monthLabel}`}
          description="Os posts dos clientes em que você é a designer aparecem aqui assim que entram no calendário."
          action={
            <Button variant="secondary" onClick={() => go(designHref({ ...values, designer: DESIGNER_ALL }, defaultDesigner))}>
              Ver todas as designers
            </Button>
          }
        />
      ) : (
        <EmptyState
          headingLevel={2}
          icon={<Icon.calendar />}
          title={`Nenhum post em ${monthLabel}`}
          description="Os posts dos clientes ativos aparecem aqui assim que entram no calendário."
        />
      );
    } else if (showingDone) {
      empty = (
        <EmptyState
          headingLevel={2}
          icon={<Icon.clock />}
          title={`Nenhuma arte feita ainda em ${monthLabel}`}
          description={`${plural(liveCounts.aFazer, "arte está", "artes estão")} na lista “A fazer”.`}
          action={
            <Button variant="secondary" onClick={() => go(designHref({ ...values, mostrar: "a_fazer" }, defaultDesigner))}>
              Ver a fazer
            </Button>
          }
        />
      );
    } else {
      empty = (
        <EmptyState
          headingLevel={2}
          icon={<Icon.check />}
          title={`Nenhuma arte a fazer em ${monthLabel}`}
          description={
            liveCounts.feitas === 1
              ? "A única arte deste filtro já está feita."
              : `As ${liveCounts.feitas} artes deste filtro já estão feitas.`
          }
          action={
            <Button variant="secondary" onClick={() => go(designHref({ ...values, mostrar: "feitas" }, defaultDesigner))}>
              Ver feitas
            </Button>
          }
        />
      );
    }
  }

  return (
    <>
      <DesignBusyArea>
        <Summary
          counts={liveCounts}
          monthLabel={monthLabel}
          showingDone={showingDone}
          onShowToDo={() => go(designHref({ ...values, mostrar: "a_fazer" }, defaultDesigner))}
        />

        <div ref={listRef} tabIndex={-1} aria-label="Lista de artes" className="outline-none">
          {empty ??
            groups.map((g) => (
              <section key={g.key} aria-labelledby={`grupo-${g.key}`} className="mb-6">
                <h2 id={`grupo-${g.key}`} className="mb-2 flex flex-wrap items-baseline gap-x-2 text-sm font-semibold text-fg">
                  {g.late && (
                    <span aria-hidden="true" className="inline-flex size-4 self-center text-danger-solid [&>svg]:size-full">
                      <Icon.alert />
                    </span>
                  )}
                  <span className={g.late ? "text-danger-fg" : undefined}>{g.title}</span>
                  {g.detail && <span className="font-normal text-fg-muted">{g.detail}</span>}
                  <span className="font-normal text-fg-muted">
                    <span aria-hidden="true">· </span>
                    <span className="sr-only">, </span>
                    {plural(g.items.length, "arte", "artes")}
                  </span>
                </h2>
                <ul className="grid gap-3 xl:gap-0 xl:overflow-hidden xl:rounded-card xl:border xl:border-line xl:bg-surface xl:shadow-card">
                  {g.items.map((row) => (
                    <DesignItem key={row.id} row={row} nowMs={nowMs} onToggle={(r, d) => void toggle(r, d)} />
                  ))}
                </ul>
              </section>
            ))}
        </div>
      </DesignBusyArea>

      {/* canal único: nada de Toast com o diálogo de filtros aberto */}
      <div onClickCapture={onToastClickCapture}>
        <Toast
          toast={filtersOpen ? null : toast}
          onClose={() => {
            setToast(null);
            setUndo(null);
          }}
        />
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Cartão "Arte" do detalhe do post (o invólucro de servidor é posts/[id]/ArtStatusCard.tsx)
 * ------------------------------------------------------------------ */

export type ArtPanelData = {
  postId: string;
  artStatus: "feita" | "a_fazer";
  artSource: ArtSource;
  artDoneAt: string | null;
  artDoneBy: UserRef | null;
  hasMedia: boolean;
  /** ISO da publicação */
  scheduledAt: string;
  late: boolean;
  /** post publicado (a arte não se marca mais) */
  published: boolean;
  drive: { file: string; path: string } | null;
  designer: UserRef | null;
  /** link para a fila /design no mês e cliente do post (null: o post não está na fila) */
  designHref: string | null;
};

export function ArtStatusPanel({ data, me, nowMs }: { data: ArtPanelData; me: UserRef | null; nowMs: number }) {
  const router = useRouter();
  const [, startRefresh] = useTransition();
  const [override, setOverride] = useState<ArtOverride | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  // dados novos do servidor (router.refresh) valem mais que a mudança otimista
  const [seen, setSeen] = useState(data);
  if (seen !== data) {
    setSeen(data);
    if (!busy) setOverride(null);
  }

  const base: DesignRow = {
    id: data.postId,
    theme: null,
    format: "feed",
    scheduledAt: data.scheduledAt,
    status: data.published ? "published" : "draft",
    client: { id: "", name: "" },
    designer: data.designer,
    mine: false,
    stage: "texto_ok",
    artStatus: data.artStatus,
    artSource: data.artSource,
    artDoneAt: data.artDoneAt,
    artDoneBy: data.artDoneBy,
    hasMedia: data.hasMedia,
    late: data.late,
    drive: data.drive,
  };
  const row = applyOverride(base, override ?? undefined, nowMs);

  /** A ação trocou de botão (feita ↔ não feita): o foco vai para o botão novo. */
  function focusAction() {
    requestAnimationFrame(() => {
      const el = actionsRef.current?.querySelector<HTMLElement>("[data-art-action]");
      el?.focus();
    });
  }

  async function toggle(done: boolean) {
    if (busy) return;
    const previous = override;
    const hadFocus = !!actionsRef.current?.contains(document.activeElement);
    setBusy(true);
    setOverride({ done, artDoneAt: done ? new Date().toISOString() : null, artDoneBy: done ? me : null });
    if (hadFocus) focusAction();
    const result = await patchArt(data.postId, done);
    setBusy(false);
    if (!result.ok) {
      setOverride(previous);
      setToast({ kind: "error", text: `Não foi possível atualizar a arte. ${result.message}` });
      if (hadFocus) focusAction();
      return;
    }
    setOverride({ done, artDoneAt: result.artDoneAt, artDoneBy: result.artDoneBy });
    setToast({ kind: "success", text: done ? "Arte marcada como feita." : "Arte marcada como não feita." });
    startRefresh(() => router.refresh());
  }

  const feita = row.artStatus === "feita";
  return (
    <>
      <div className="mt-3 grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {feita ? (
            <ToneBadge tone="success" icon={<Icon.check />}>
              Feita
            </ToneBadge>
          ) : (
            <ToneBadge tone="warning" icon={<Icon.clock />}>
              A fazer
            </ToneBadge>
          )}
          {row.late && (
            <ToneBadge tone="danger" icon={<Icon.alert />}>
              Atrasada · <span className="whitespace-nowrap">{lateText(row.scheduledAt, nowMs)}</span>
            </ToneBadge>
          )}
        </div>
        <p className="text-sm text-fg">
          {feita
            ? doneText(row)
            : data.designer
              ? `Designer: ${data.designer.name}`
              : "Este cliente ainda não tem designer."}
        </p>
        {row.drive && (
          <div className="grid gap-1">
            <p className="text-xs font-medium text-fg-muted">Arquivo esperado no Drive</p>
            <DrivePath path={row.drive.path} />
          </div>
        )}
        <div ref={actionsRef} className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {!data.published && row.artStatus === "a_fazer" && (
            <Button
              data-art-action=""
              aria-busy={busy || undefined}
              leadingIcon={<Icon.check />}
              onClick={() => void toggle(true)}
            >
              Marcar como feita
            </Button>
          )}
          {!data.published && row.artSource === "marcada" && (
            <Button data-art-action="" aria-busy={busy || undefined} variant="ghost" onClick={() => void toggle(false)}>
              Marcar como não feita
            </Button>
          )}
          {data.designHref && (
            <Link
              href={data.designHref}
              className="inline-flex min-h-11 items-center text-sm font-medium text-link underline-offset-2 hover:text-link-hover hover:underline sm:min-h-10"
            >
              Ver na fila de Design
            </Link>
          )}
        </div>
      </div>
      <Toast toast={toast} onClose={() => setToast(null)} />
    </>
  );
}
