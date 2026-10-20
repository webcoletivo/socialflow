import type { Metadata } from "next";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import Link from "next/link";
import PostsFilters from "./PostsFilters";
import PostsPagination from "./PostsPagination";
import DeletePostButton from "./DeletePostButton";
import PostsSelection, { RowCheckbox, SelectPageCheckbox } from "./PostsSelection";
import { PageHeader, StatusBadge, PlatformChip, EmptyState, ToneBadge, FormatBadge } from "@/components/ui";
import { buttonClasses } from "@/components/Button";
import { Icon } from "@/components/Icons";
import { rangeLabel } from "@/lib/date-range";
import { formatDateTime } from "@/lib/format-date";
import {
  BULK_LIMIT,
  PAGE_SIZE,
  buildListQuery,
  countList,
  fetchListPage,
  isOverdue,
  listQueryString,
  parseListParams,
  type ListParams,
} from "./list-query";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Posts" };

/** Link solto (fora de frase) com alvo ≥ 40 px (DESIGN, A11y "Alvos"). */
const LOOSE_LINK = "inline-flex min-h-11 items-center sm:min-h-10";

/** Títulos dos grupos de "Próximos" (U-19). */
const GROUP_LABEL = { pinned: "Atrasados e com falha", main: "De hoje em diante" } as const;

/** /posts com os filtros atuais e o período trocado por `over` (volta à página 1). */
function listHref(p: ListParams, over: Partial<Record<"range" | "ref", string | undefined>>) {
  const params = new URLSearchParams();
  const merged: Record<string, string | undefined> = {
    clientId: p.clientId,
    status: p.status,
    q: p.q || undefined,
    scheduleId: p.scheduleId,
    noted: p.onlyNoted ? "1" : undefined,
    ...over,
  };
  for (const [k, v] of Object.entries(merged)) if (v) params.set(k, v);
  return `/posts${params.size ? `?${params}` : ""}`;
}

export default async function PostsPage({
  searchParams,
}: {
  searchParams: Promise<{
    clientId?: string;
    status?: string;
    q?: string;
    range?: string;
    ref?: string;
    page?: string;
    scheduleId?: string;
    noted?: string;
  }>;
}) {
  const sp = await searchParams;
  // excluir post PUBLICADO é só da admin (AC-07): a seleção da staff deixa os publicados de fora
  const session = await auth();
  const isAdmin = (session?.user as { role?: string } | undefined)?.role === "admin";
  // Sem `range` na URL: "Próximos" (de hoje em diante, com atrasados/falhas no topo; U-19)
  const params = parseListParams(sp);
  const { clientId, status, q, range, ref, scheduleId, onlyNoted } = params;

  const now = new Date();
  const query = buildListQuery(params, now);
  const [counts, clients] = await Promise.all([
    countList(query),
    prisma.client.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const total = counts.pinned + counts.main;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Página além da última (ex.: depois de excluir todos os posts da última página): mostra a
  // última em vez de "Nenhum post com esses filtros".
  const page = Math.min(Math.max(1, Number(sp.page) || 1), totalPages);
  const listed = await fetchListPage(query, counts.pinned, page);
  const posts = listed.map((r) => r.post);

  // A seleção zera ao trocar filtro ou página: a key nova remonta o PostsSelection.
  const datedRange = range !== "all" && range !== "upcoming";
  const selectionKey = JSON.stringify([clientId, status, q, range, datedRange ? ref : "", sp.page, scheduleId, onlyNoted]);

  // posts that haven't gone out yet can be safely edited/removed
  const deletable = (s: string) => s === "scheduled" || s === "failed" || s === "draft";

  const otherFilters = !!(clientId || status || q || scheduleId || onlyNoted);

  const subtitle =
    `${total} post${total !== 1 ? "s" : ""}` +
    (range === "upcoming" ? " · de hoje em diante" : datedRange ? ` · ${rangeLabel(range, ref)}` : "") +
    (counts.pinned > 0
      ? ` · ${counts.pinned} ${counts.pinned === 1 ? "atrasado ou com falha" : "atrasados ou com falha"} no topo`
      : "") +
    (onlyNoted ? " · com ajuste pedido pelo cliente" : "") +
    (scheduleId && !onlyNoted ? " · de um cronograma" : "");

  const newPostLink = (
    <Link href="/posts/new" className={buttonClasses({ variant: "primary" })}>
      <Icon.plus className="size-4.5 shrink-0" />
      Novo post
    </Link>
  );
  const allDatesLink = (
    <Link href={listHref(params, { range: "all" })} className={buttonClasses({ variant: "secondary" })}>
      Ver todas as datas
    </Link>
  );

  const rows = listed.map(({ post, pinned }) => {
    const label = post.theme?.trim() || `post de ${post.client.name} em ${formatDateTime(post.scheduledAt)}`;
    const hasMedia = !!post.mediaUrl || (Array.isArray(post.mediaItems) && post.mediaItems.length > 0);
    const overdue = isOverdue(post, now);
    const noArt = !hasMedia && post.status !== "published";
    const flags = (
      <>
        {overdue && (
          <ToneBadge tone="danger" icon={<Icon.clock />}>
            Atrasado
          </ToneBadge>
        )}
        {post.clientNote && (
          <ToneBadge tone="accent" icon={<Icon.edit />} title={post.clientNote}>
            Ajuste pedido
          </ToneBadge>
        )}
        {noArt && (
          <ToneBadge tone="warning" icon={<Icon.alert />}>
            Sem arte
          </ToneBadge>
        )}
      </>
    );
    return { post, pinned, label, flags, hasFlags: overdue || !!post.clientNote || noArt };
  });
  type Row = (typeof rows)[number];
  type Segment = { key: "pinned" | "main"; title: string | null; count: number; rows: Row[] };

  // "Próximos" com atrasados/falhas: dois grupos com título (o fixo no topo e o resto).
  const segments: Segment[] =
    counts.pinned > 0
      ? ([
          { key: "pinned", title: GROUP_LABEL.pinned, count: counts.pinned, rows: rows.filter((r) => r.pinned) },
          { key: "main", title: GROUP_LABEL.main, count: counts.main, rows: rows.filter((r) => !r.pinned) },
        ] satisfies Segment[]).filter((g) => g.rows.length > 0)
      : [{ key: "main", title: null, count: total, rows }];

  const groupTitle = (seg: Segment) => (
    <>
      <span
        aria-hidden="true"
        className={`inline-flex size-4 shrink-0 [&>svg]:size-full ${seg.key === "pinned" ? "text-danger-solid" : "text-fg-muted"}`}
      >
        {seg.key === "pinned" ? <Icon.alert /> : <Icon.calendar />}
      </span>
      {seg.title}
      <span className="font-normal tabular-nums text-fg-muted">· {seg.count}</span>
    </>
  );

  let empty: React.ReactNode = null;
  if (posts.length === 0) {
    if (!otherFilters && range === "all") {
      empty = (
        <EmptyState
          headingLevel={2}
          title="Nenhum post ainda"
          description="Crie um post aqui ou gere o cronograma do mês na página do cliente."
          action={newPostLink}
        />
      );
    } else if (!otherFilters && range === "upcoming") {
      empty = (
        <EmptyState
          headingLevel={2}
          icon={<Icon.calendar />}
          title="Nada de hoje em diante"
          description="Nenhum post agendado a partir de hoje e nenhum atrasado ou com falha. Os posts antigos estão em todas as datas."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {allDatesLink}
              {newPostLink}
            </div>
          }
        />
      );
    } else {
      const where = range === "upcoming" ? " de hoje em diante" : datedRange ? " neste período" : "";
      const seeAll = range !== "all" ? ", veja todas as datas" : "";
      empty = (
        <EmptyState
          headingLevel={2}
          title="Nenhum post com esses filtros"
          description={
            q
              ? `Nada encontrado para “${q}”${where}. Confira a grafia${seeAll} ou limpe os filtros.`
              : `Nenhum post${where} com esses filtros. Mude os filtros${seeAll} ou limpe todos.`
          }
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {range !== "all" && allDatesLink}
              <Link href="/posts" className={buttonClasses({ variant: "ghost" })}>
                Limpar filtros
              </Link>
            </div>
          }
        />
      );
    }
  }

  return (
    <div className="page animate-fade-up">
      <PageHeader title="Posts" subtitle={subtitle} action={newPostLink} />

      <PostsFilters
        clients={clients}
        currentStatus={status}
        currentClientId={clientId}
        currentRange={range}
        currentRef={ref}
        currentQuery={q}
      />

      {/* Sempre montado (também no estado vazio): o Toast da exclusão em massa sobrevive ao refresh
          que esvazia a lista. */}
      <PostsSelection
        key={selectionKey}
        pageItems={posts.map((p) => ({ id: p.id, status: p.status }))}
        total={total}
        filterQuery={listQueryString(params)}
        canExpandFilter={(page - 1) * PAGE_SIZE + posts.length <= BULK_LIMIT}
        canDeletePublished={isAdmin}
      >
        {posts.length === 0 ? (
          empty
        ) : (
          <>
            {/* < lg: "Selecionar todos desta página" com texto, acima dos cartões */}
            <div className="mb-2 lg:hidden">
              <SelectPageCheckbox withLabel />
            </div>

            {/* ≥ lg: tabela (um tbody por grupo em "Próximos") */}
            <div className="card hidden overflow-hidden lg:block">
              <table className="w-full text-sm">
                <thead className="bg-sunken">
                  <tr>
                    <th scope="col" className="w-12 py-1 pl-2">
                      <SelectPageCheckbox />
                    </th>
                    {["Cliente", "Tema", "Redes", "Data", "Status"].map((h) => (
                      <th
                        key={h}
                        scope="col"
                        className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-overline text-fg-muted"
                      >
                        {h}
                      </th>
                    ))}
                    <th scope="col" className="w-28 px-4 py-3">
                      <span className="sr-only">Ações</span>
                    </th>
                  </tr>
                </thead>
                {segments.map((seg) => (
                  <tbody key={seg.key}>
                    {seg.title && (
                      <tr className="border-t border-line">
                        <th colSpan={7} scope="rowgroup" className="px-4 py-2.5 text-left text-sm font-semibold text-fg">
                          <span className="flex items-center gap-2">{groupTitle(seg)}</span>
                        </th>
                      </tr>
                    )}
                    {seg.rows.map(({ post, label, flags, hasFlags }) => (
                      <tr
                        key={post.id}
                        className="group border-t border-line transition-colors duration-(--sf-dur-fast) hover:bg-hover has-checked:bg-brand-bg"
                      >
                        <td className="py-1 pl-2 align-middle">
                          <RowCheckbox id={post.id} label={label} />
                        </td>
                        <td className="px-4 py-2 align-middle">
                          <Link
                            href={`/clients/${post.clientId}`}
                            className={`${LOOSE_LINK} min-w-11 font-medium text-fg hover:text-link sm:min-w-10`}
                          >
                            {post.client.name}
                          </Link>
                        </td>
                        <td className="max-w-xs px-4 py-2 align-middle">
                          {/* formato ao lado do tema: feed e story do mesmo tema não parecem duplicados (U-03) */}
                          <div className="flex items-center gap-2">
                            <FormatBadge format={post.format} kind={post.contentKind} />
                            <Link
                              href={`/posts/${post.id}`}
                              title={post.theme ?? undefined}
                              className={`${LOOSE_LINK} min-w-0 text-fg-muted hover:text-fg`}
                            >
                              <span className="line-clamp-2">{post.theme?.trim() || "Sem título"}</span>
                            </Link>
                          </div>
                          {hasFlags && <div className="mb-1 flex flex-wrap items-center gap-1.5">{flags}</div>}
                        </td>
                        <td className="px-4 py-2 align-middle">
                          <div className="flex gap-1">
                            {post.targets.map((t) => (
                              <PlatformChip key={t} platform={t} decorative={false} />
                            ))}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 align-middle tabular-nums text-fg-muted">
                          {formatDateTime(post.scheduledAt)}
                        </td>
                        <td className="px-4 py-2 align-middle">
                          <StatusBadge kind="post" status={post.status} />
                        </td>
                        <td className="px-4 py-2 text-right align-middle">
                          {deletable(post.status) && (
                            <div className="flex items-center justify-end gap-1">
                              <Link
                                href={`/posts/${post.id}/edit`}
                                aria-label={`Editar post: ${label}`}
                                title="Editar post"
                                className={`${buttonClasses({ variant: "ghost", size: "sm", iconOnly: true })} opacity-0 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100`}
                              >
                                <Icon.edit className="size-4" />
                              </Link>
                              <DeletePostButton postId={post.id} postLabel={label} status={post.status} />
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                ))}
              </table>
            </div>

            {/* < lg: cartões (com título por grupo em "Próximos") */}
            <div className="grid gap-5 lg:hidden">
              {segments.map((seg) => (
                <section key={seg.key} aria-labelledby={seg.title ? `grupo-${seg.key}` : undefined}>
                  {seg.title && (
                    <h2 id={`grupo-${seg.key}`} className="mb-2 flex items-center gap-2 text-sm font-semibold text-fg">
                      {groupTitle(seg)}
                    </h2>
                  )}
                  <ul className="grid gap-3">
                    {seg.rows.map(({ post, label, flags, hasFlags }) => (
                      <li key={post.id} className="card grid gap-2 p-4 has-checked:border-brand-line has-checked:bg-brand-bg">
                        <div className="flex items-center gap-1">
                          {/* -ml-3: a caixa alinha com o texto do cartão; o alvo de 44 px avança no padding */}
                          <RowCheckbox id={post.id} label={label} className="-ml-3" />
                          <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-3 gap-y-1">
                            <Link
                              href={`/clients/${post.clientId}`}
                              className={`${LOOSE_LINK} min-w-11 text-sm font-medium text-fg-muted hover:text-link sm:min-w-10`}
                            >
                              <span className="min-w-0 truncate">{post.client.name}</span>
                            </Link>
                            <StatusBadge kind="post" status={post.status} />
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <FormatBadge format={post.format} kind={post.contentKind} />
                          <Link
                            href={`/posts/${post.id}`}
                            title={post.theme ?? undefined}
                            className={`${LOOSE_LINK} min-w-0 text-base font-semibold text-fg hover:text-link`}
                          >
                            <span className="line-clamp-2 wrap-break-word">{post.theme?.trim() || "Sem título"}</span>
                          </Link>
                        </div>
                        {hasFlags && <div className="flex flex-wrap items-center gap-1.5">{flags}</div>}
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-fg-muted">
                          <span className="tabular-nums">{formatDateTime(post.scheduledAt)}</span>
                          <span className="flex gap-1">
                            {post.targets.map((t) => (
                              <PlatformChip key={t} platform={t} decorative={false} />
                            ))}
                          </span>
                        </div>
                        {deletable(post.status) && (
                          <div className="flex flex-wrap gap-2 border-t border-line pt-3">
                            <Link
                              href={`/posts/${post.id}/edit`}
                              aria-label={`Editar post: ${label}`}
                              className={buttonClasses({ variant: "secondary", size: "sm" })}
                            >
                              <Icon.edit className="size-4 shrink-0" />
                              Editar
                            </Link>
                            <DeletePostButton postId={post.id} postLabel={label} status={post.status} variant="text" />
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </>
        )}
      </PostsSelection>

      {totalPages > 1 && (
        <PostsPagination page={page} totalPages={totalPages} total={total} pageSize={PAGE_SIZE} />
      )}
    </div>
  );
}
