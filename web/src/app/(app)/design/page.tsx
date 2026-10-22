import type { Metadata } from "next";
import Link from "next/link";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { loadDesignQueue, matchesDesignFilter, type DesignQueueResult } from "@/lib/design-queue";
import { EmptyState, PageHeader } from "@/components/ui";
import { buttonClasses } from "@/components/Button";
import { Icon } from "@/components/Icons";
import { spDateKey } from "@/lib/deadlines";
import { formatMonthLabel } from "@/lib/format-date";
import { uuidString } from "@/lib/validators";
import DesignFilters, { DesignMonthNav, DesignNavProvider } from "./DesignFilters";
import DesignQueue from "./DesignQueue";
import DesignCalendar from "./DesignCalendar";
import {
  defaultDesignerFor,
  DESIGNER_ALL,
  DESIGNER_NONE,
  designerIdOption,
  designHref,
  parseDesignParams,
  plural,
  type DesignRow,
  type UserRef,
} from "./design-view";

/*
 * Fila de artes da equipe de design: os posts (não publicados, clientes ativos)
 * cuja arte falta fazer, com avisos de atraso e "Marcar como feita". Filtros na
 * URL: mes, designer (padrão "Minhas" para quem é designer de algum cliente),
 * cliente, mostrar (a_fazer | feitas | todas) e ver (lista | calendario: grade
 * cliente × dia com todos os posts do mês, publicados inclusive). Dados de `loadDesignQueue`.
 */

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Design" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Usuária da sessão no banco ({ id, name }): pelo id do token; sem ele, pelo e-mail. */
async function sessionUser(): Promise<UserRef | null> {
  const session = await auth();
  const user = session?.user as { id?: string; email?: string | null } | undefined;
  if (user?.id && uuidString.safeParse(user.id).success) {
    const found = await prisma.user.findUnique({ where: { id: user.id }, select: { id: true, name: true } });
    if (found) return found;
  }
  if (user?.email) {
    return prisma.user.findUnique({ where: { email: user.email }, select: { id: true, name: true } });
  }
  return null;
}

function toRow(item: DesignQueueResult["items"][number]): DesignRow {
  return {
    id: item.id,
    theme: item.theme,
    format: item.format,
    ...(item.contentKind ? { contentKind: item.contentKind } : {}),
    scheduledAt: item.scheduledAt.toISOString(),
    status: item.status,
    client: item.client,
    designer: item.designer,
    mine: item.mine,
    stage: item.stage,
    artStatus: item.artStatus,
    artSource: item.artSource,
    artDoneAt: item.artDoneAt ? item.artDoneAt.toISOString() : null,
    artDoneBy: item.artDoneBy,
    postedAt: item.postedAt ? item.postedAt.toISOString() : null,
    postedBy: item.postedBy,
    hasMedia: item.hasMedia,
    late: item.late,
    drive: item.drive ? { file: item.drive.file, path: item.drive.path } : null,
  };
}

export default async function DesignPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const now = new Date();
  const todayKey = spDateKey(now);

  // Antes da fila: quem é a usuária e quais designers/clientes ativos existem (padrão e validação dos filtros).
  const [me, activeClients] = await Promise.all([
    sessionUser(),
    prisma.client.findMany({ where: { status: "ativo" }, select: { id: true, designerUserId: true } }),
  ]);
  const designerIds = new Set(activeClients.flatMap((c) => (c.designerUserId ? [c.designerUserId] : [])));
  const defaultDesigner = defaultDesignerFor(me?.id ?? null, designerIds);
  const isDesigner = defaultDesigner !== DESIGNER_ALL;
  const values = parseDesignParams(sp, {
    currentMonth: todayKey.slice(0, 7),
    defaultDesigner,
    designerIds,
    clientIds: new Set(activeClients.map((c) => c.id)),
  });
  const monthLabel = formatMonthLabel(values.mes);
  const calendar = values.ver === "calendario";

  let queue: DesignQueueResult | null = null;
  try {
    queue = await loadDesignQueue({
      userId: me?.id ?? null,
      designerId: designerIdOption(values.designer),
      clientId: values.cliente || null,
      month: values.mes,
      // o calendário mostra todos os posts do mês, como a planilha (arte e postagem)
      include: calendar ? "todas" : values.mostrar,
      includePublished: calendar,
      now,
    });
  } catch (e) {
    // detalhe técnico só no log do servidor (N-14)
    console.error("[design] fila de artes", e);
  }

  const designerLabel =
    values.designer === DESIGNER_ALL
      ? "Todas as designers"
      : values.designer === DESIGNER_NONE
        ? "Clientes sem designer"
        : values.designer === me?.id
          ? "Minhas artes"
          : (queue?.designers.find((d) => d.id === values.designer)?.name ?? "Designer");

  const header = (
    <PageHeader
      title="Design"
      subtitle={
        queue
          ? `${monthLabel} · ${designerLabel} · ${plural(queue.counts.total, "post", "posts")}`
          : `${monthLabel} · ${designerLabel}`
      }
      action={<DesignMonthNav values={values} defaultDesigner={defaultDesigner} />}
    />
  );

  return (
    <div className={`page animate-fade-up ${calendar ? "page--wide" : ""}`}>
      <DesignNavProvider>
        {header}
        {queue ? (
          <>
            <DesignFilters
              values={values}
              defaultDesigner={defaultDesigner}
              userId={me?.id ?? null}
              isDesigner={isDesigner}
              designers={queue.designers}
              clients={queue.clients}
            />
            {calendar ? (
              <DesignCalendar
                rows={queue.items.map(toRow)}
                clients={queue.clients.filter((c) =>
                  matchesDesignFilter(c, designerIdOption(values.designer), values.cliente || null),
                )}
                month={values.mes}
                monthLabel={monthLabel}
                todayKey={todayKey}
                nowMs={now.getTime()}
                me={me}
              />
            ) : (
              <DesignQueue
                rows={queue.items.map(toRow)}
                counts={queue.counts}
                values={values}
                defaultDesigner={defaultDesigner}
                isDesigner={isDesigner}
                monthLabel={monthLabel}
                todayKey={todayKey}
                nowMs={now.getTime()}
                me={me}
              />
            )}
          </>
        ) : (
          <EmptyState
            headingLevel={2}
            tone="error"
            icon={<Icon.alert />}
            title="Não foi possível carregar a fila de artes"
            description="Pode ser uma instabilidade momentânea. Tente de novo em instantes."
            action={
              <Link href={designHref(values, defaultDesigner)} className={buttonClasses({ variant: "secondary" })}>
                <Icon.refresh className="size-4.5" />
                Tentar de novo
              </Link>
            }
          />
        )}
      </DesignNavProvider>
    </div>
  );
}
