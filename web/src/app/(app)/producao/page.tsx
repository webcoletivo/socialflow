import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { EmptyState, PageHeader } from "@/components/ui";
import { buttonClasses } from "@/components/Button";
import { Icon } from "@/components/Icons";
import {
  approvalDeadline,
  effectiveCaption,
  hasArt as hasArtRule,
  isLate,
  productionStage,
  STAGE_META,
  STAGES,
  type ProductionStage,
} from "@/lib/production";
import { formatMeta } from "@/lib/formats";
import { contentKindLabel } from "@/lib/content-packages";
import { CLIENT_STATUSES, SEGMENTS } from "@/lib/status-meta";
import { spDateFromKey, spDateKey } from "@/lib/deadlines";
import { formatMonthLabel } from "@/lib/format-date";
import ProductionGrid, {
  ProductionLegend,
  ProductionSummary,
  type BoardModel,
  type DayColumn,
  type MarkerModel,
  type RowModel,
} from "./ProductionGrid";
import ProductionFilters, {
  MonthNav,
  ProductionBusyArea,
  ProductionNavProvider,
  type ProductionFilterValues,
  type ProductionStatusFilter,
  type WriterOption,
} from "./ProductionFilters";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const WEEKDAY = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const WEEKDAY_FULL = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

/** `mes=AAAA-MM` válido ou o mês atual em São Paulo. */
function monthParam(sp: Record<string, string | string[] | undefined>, now: Date): string {
  const raw = first(sp.mes);
  return MONTH_RE.test(raw) ? raw : spDateKey(now).slice(0, 7);
}

function nextMonth(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

function emptyTotals(): Record<ProductionStage, number> {
  return { sem_texto: 0, texto_ok: 0, em_aprovacao: 0, tema_aprovado: 0, post_aprovado: 0 };
}

export async function generateMetadata({ searchParams }: { searchParams: SearchParams }): Promise<Metadata> {
  const mes = monthParam(await searchParams, new Date());
  return { title: `Produção · ${formatMonthLabel(mes)}` };
}

export default async function ProducaoPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const now = new Date();
  const mes = monthParam(sp, now);
  const [year, month] = mes.split("-").map(Number);
  const monthLabel = formatMonthLabel(mes);

  // ---- Consulta 1/4: clientes (todos; os filtros são aplicados abaixo, e a lista de redatoras sai daqui)
  const allClients = await prisma.client.findMany({
    select: {
      id: true,
      name: true,
      plan: true,
      segment: true,
      status: true,
      agencyPublishes: true,
      responsible: { select: { id: true, name: true } },
      designer: { select: { id: true, name: true } },
    },
  });

  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" });

  const writerMap = new Map<string, WriterOption>();
  for (const c of allClients) if (c.responsible) writerMap.set(c.responsible.id, c.responsible);
  const writers = [...writerMap.values()].sort(byName);
  const designerMap = new Map<string, WriterOption>();
  for (const c of allClients) if (c.designer) designerMap.set(c.designer.id, c.designer);
  const designers = [...designerMap.values()].sort(byName);

  // Filtros: listas fechadas; valor fora da lista é ignorado (DESIGN, fluxo do Quadro).
  const rawStatus = first(sp.status);
  const rawAprovacao = first(sp.aprovacao);
  const rawPublica = first(sp.publica);
  const values: ProductionFilterValues = {
    mes,
    redatora: writerMap.has(first(sp.redatora)) ? first(sp.redatora) : "",
    designer: designerMap.has(first(sp.designer)) ? first(sp.designer) : "",
    segmento: (SEGMENTS as readonly string[]).includes(first(sp.segmento)) ? first(sp.segmento) : "",
    aprovacao: rawAprovacao === "com" || rawAprovacao === "sem" ? rawAprovacao : "",
    status: ([...CLIENT_STATUSES, "todos"] as string[]).includes(rawStatus)
      ? (rawStatus as ProductionStatusFilter)
      : "ativo",
    publica: rawPublica === "sim" || rawPublica === "nao" ? rawPublica : "",
  };

  const clients = allClients
    .filter(
      (c) =>
        (values.status === "todos" || c.status === values.status) &&
        (!values.redatora || c.responsible?.id === values.redatora) &&
        (!values.designer || c.designer?.id === values.designer) &&
        (!values.segmento || c.segment === values.segmento) &&
        (!values.aprovacao || (c.plan === "aprovacao_cliente") === (values.aprovacao === "com")) &&
        (!values.publica || c.agencyPublishes === (values.publica === "sim")),
    )
    .sort(byName);
  const clientIds = clients.map((c) => c.id);

  // Posts do mês (dia civil em SP) dos clientes filtrados.
  const postWhere: Prisma.PostWhereInput = {
    clientId: { in: clientIds },
    scheduledAt: { gte: spDateFromKey(`${mes}-01`), lt: spDateFromKey(`${nextMonth(mes)}-01`) },
  };

  const [posts, adjustmentCounts, openPending] = await Promise.all([
    // ---- Consulta 2/4: posts do mês com o cronograma
    prisma.post.findMany({
      where: postWhere,
      orderBy: [{ scheduledAt: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        clientId: true,
        scheduledAt: true,
        format: true,
        contentKind: true,
        status: true,
        caption: true,
        captions: true,
        slides: true,
        mediaUrl: true,
        mediaItems: true,
        clientApproval: true,
        weeklyReviewId: true,
        artDoneAt: true,
        artDoneByUser: { select: { name: true } },
        schedule: { select: { status: true, monthRef: true } },
      },
    }),
    // ---- Consulta 3/4: contagem de ajustes pendentes por post
    prisma.postAdjustment.groupBy({
      by: ["postId"],
      where: { status: "pendente", post: postWhere },
      _count: { _all: true },
    }),
    // ---- Consulta 4/4: pendências abertas vinculadas a esses posts
    prisma.pendingItem.findMany({
      where: { resolvedAt: null, post: postWhere },
      select: { postId: true, kind: true },
    }),
  ]);

  // ---- Modelo da grade (H-13)
  const adjustmentsByPost = new Map(adjustmentCounts.map((a) => [a.postId, a._count._all]));
  const pendingKindsByPost = new Map<string, string[]>();
  for (const item of openPending) {
    if (!item.postId) continue;
    pendingKindsByPost.set(item.postId, [...(pendingKindsByPost.get(item.postId) ?? []), item.kind]);
  }

  const todayKey = spDateKey(now);
  const todayDay = todayKey.slice(0, 7) === mes ? Number(todayKey.slice(8, 10)) : null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const days: DayColumn[] = Array.from({ length: daysInMonth }, (_, i) => {
    const day = i + 1;
    const wd = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    return {
      day,
      weekday: WEEKDAY[wd],
      weekdayFull: WEEKDAY_FULL[wd],
      weekend: wd === 0 || wd === 6,
      today: day === todayDay,
      scrollAnchor: todayDay !== null && day === Math.max(1, todayDay - 2),
    };
  });

  const rows = new Map<string, RowModel>(
    clients.map((c) => [
      c.id,
      {
        client: {
          id: c.id,
          name: c.name,
          writerName: c.responsible?.name ?? null,
          segment: c.segment,
          withApproval: c.plan === "aprovacao_cliente",
          agencyPublishes: c.agencyPublishes,
          status: c.status,
        },
        days: new Map(),
        totals: emptyTotals(),
        total: 0,
      },
    ]),
  );
  const planOf = new Map(clients.map((c) => [c.id, c.plan]));
  const totals = emptyTotals();
  let lateCount = 0;
  const mm = String(month).padStart(2, "0");

  for (const p of posts) {
    const row = rows.get(p.clientId);
    if (!row) continue;
    const day = Number(spDateKey(p.scheduledAt).slice(8, 10));
    const format = formatMeta(p.format);
    const stage = productionStage({
      caption: effectiveCaption(p),
      slides: p.slides,
      schedule: p.schedule,
      plan: planOf.get(p.clientId) ?? "",
      weeklyReviewId: p.weeklyReviewId,
      clientApproval: p.clientApproval,
    });
    const late = isLate(
      stage,
      p.scheduledAt,
      now,
      approvalDeadline({ scheduledAt: p.scheduledAt, weeklyReviewId: p.weeklyReviewId, schedule: p.schedule }),
    );
    // regra única da arte (marcada no Design, com mídia ou publicada): a mesma da fila /design
    const hasArt = hasArtRule(p);
    const adjustments = adjustmentsByPost.get(p.id) ?? 0;
    const pendingKinds = pendingKindsByPost.get(p.id) ?? [];
    const publication: MarkerModel["publication"] =
      p.status === "published" ? "published" : p.status === "scheduled" || p.status === "publishing" ? "scheduled" : null;
    const issue: MarkerModel["issue"] =
      p.status === "failed" ? "failed" : adjustments > 0 ? "adjustment" : pendingKinds.length > 0 ? "waitingMaterial" : null;

    const label = [
      row.client.name,
      `${String(day).padStart(2, "0")}/${mm}`,
      contentKindLabel(p.contentKind) ?? format.label,
      STAGE_META[stage].label,
    ];
    if (p.artDoneAt) label.push(p.artDoneByUser ? `arte feita por ${p.artDoneByUser.name}` : "arte feita");
    else if (!hasArt) label.push("arte a fazer");
    if (adjustments > 0) label.push(adjustments === 1 ? "ajuste pendente" : `${adjustments} ajustes pendentes`);
    if (pendingKinds.length > 0)
      label.push(pendingKinds.includes("aguardando_material") ? "aguardando material" : "pendência aberta");
    if (publication) label.push(publication === "published" ? "publicado" : "agendado");
    if (p.status === "failed") label.push("falhou ao publicar");
    if (late) label.push("atrasado");

    const marker: MarkerModel = {
      postId: p.id,
      day,
      format: format.id,
      stage,
      hasArt,
      late,
      issue,
      publication,
      ariaLabel: label.join(", "),
    };
    row.days.set(day, [...(row.days.get(day) ?? []), marker]);
    row.totals[stage] += 1;
    row.total += 1;
    totals[stage] += 1;
    if (late) lateCount += 1;
  }

  const board: BoardModel = {
    monthLabel,
    days,
    rows: [...rows.values()],
    totals,
    late: lateCount,
    total: STAGES.reduce((sum, s) => sum + totals[s.id], 0),
  };

  return (
    <div className="page page--wide">
      <ProductionNavProvider>
        <PageHeader
          title="Produção"
          subtitle={`${monthLabel} · ${plural(board.rows.length, "cliente", "clientes")} · ${plural(board.total, "post", "posts")}`}
          action={
            <>
              <MonthNav values={values} />
              <Link
                href={`/design?${new URLSearchParams({ mes, designer: values.designer || "todos" })}`}
                className={buttonClasses({ variant: "secondary" })}
              >
                <Icon.edit className="size-4.5" />
                Ver no Design
              </Link>
            </>
          }
        />
        <ProductionFilters values={values} writers={writers} designers={designers} />
        <ProductionBusyArea scrollKey={mes}>
          {board.rows.length === 0 ? (
            <EmptyState
              headingLevel={2}
              icon={<Icon.board />}
              title="Nenhum cliente com esses filtros"
              description="Mude ou limpe os filtros para ver outros clientes neste mês."
              action={
                <Link href={`/producao?mes=${mes}`} className={buttonClasses({ variant: "secondary" })}>
                  Limpar filtros
                </Link>
              }
            />
          ) : (
            <>
              <ProductionSummary board={board} />
              <ProductionLegend />
              <ProductionGrid board={board} />
            </>
          )}
        </ProductionBusyArea>
      </ProductionNavProvider>
    </div>
  );
}
