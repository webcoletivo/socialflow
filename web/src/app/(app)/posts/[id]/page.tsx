import type { Metadata } from "next";
import { cache } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { FormatBadge, PageHeader, PlatformChip, StatusBadge, ToneBadge } from "@/components/ui";
import { Avatar } from "@/components/Avatar";
import { buttonClasses } from "@/components/Button";
import { Callout } from "@/components/Callout";
import { Icon } from "@/components/Icons";
import { BrandBadge, BRAND } from "@/components/BrandIcons";
import { capitalizeFirst, formatDate, formatDateTime, TZ } from "@/lib/format-date";
import { PENDING_KIND, metaOf } from "@/lib/status-meta";
import { toUserMessage } from "@/lib/user-facing-error";
import { uuidString } from "@/lib/validators";
import RetryPostButton from "../../RetryPostButton";
import ApprovePostButton from "./ApprovePostButton";
import ArtStatusCard from "./ArtStatusCard";
import GenerateArtButton from "./GenerateArtButton";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

/** "qui, 07/10 às 18:00" no fuso SP (com o ano quando não é o atual): retorno do Novo post (U-02). */
function shortWhen(d: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("pt-BR", {
      timeZone: TZ,
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  const thisYear = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, year: "numeric" }).format(new Date());
  const year = parts.year !== thisYear ? `/${parts.year}` : "";
  return `${parts.weekday.replace(".", "")}, ${parts.day}/${parts.month}${year} às ${parts.hour}:${parts.minute}`;
}

/** Tema do post para o título da aba (memorizado no mesmo render da página). */
const loadPostTheme = cache(async (id: string) =>
  uuidString.safeParse(id).success
    ? prisma.post.findUnique({ where: { id }, select: { theme: true } })
    : null,
);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const post = await loadPostTheme(id);
  if (!post) return { title: "Post não encontrado" };
  const theme = post.theme?.trim();
  return { title: theme ? (theme.length > 70 ? `${theme.slice(0, 69)}…` : theme) : "Post sem título" };
}

/** Proporção da arte por formato (A-008): feed e carrossel 4:5; story e reels 9:16. */
const RATIO: Record<string, string> = {
  feed: "aspect-4/5",
  carrossel: "aspect-4/5",
  story: "aspect-9/16",
  reels: "aspect-9/16",
};

/** Ordem de exibição das legendas por rede (Facebook e Instagram costumam ter o mesmo texto). */
const CAPTION_ORDER = ["facebook", "instagram", "linkedin"];

/** Texto do WF-03 para post destravado — o antigo ("preso em publishing") e o atual. */
const STUCK_ERROR = /^destravado:\s*(preso em publishing|travado ao publicar) por 20\+ ?min\.?$/i;

const PUBLISH_ERROR_FALLBACK = "A publicação falhou por um erro técnico da rede social.";

/**
 * Erro de publicação legível (A-013, A-030): sem o jargão "publishing" do WF-03,
 * também nas linhas antigas, e sem detalhe técnico (URL, JSON, variável…).
 */
function humanizeError(raw: string | null | undefined): string | null {
  const text = raw?.trim();
  if (!text) return null;
  if (STUCK_ERROR.test(text)) return "Ficou travado ao publicar por mais de 20 minutos.";
  const plain = text.replace(/preso em publishing/gi, "travado ao publicar");
  return capitalizeFirst(toUserMessage(plain, PUBLISH_ERROR_FALLBACK));
}

function plural(n: number, one: string, many: string) {
  return n === 1 ? one : many;
}

const platformLabel = (p: string) => BRAND[p]?.label ?? p;

export default async function PostDetailPage({ params, searchParams }: Props) {
  const { id } = await params;
  // ?criado=1: veio do Novo post (U-02) → aviso de sucesso no topo
  const justCreated = (await searchParams).criado === "1";
  // id que não é uuid faria o Prisma lançar: vira 404
  if (!uuidString.safeParse(id).success) notFound();

  const post = await prisma.post.findUnique({
    where: { id },
    include: {
      client: { select: { id: true, name: true, tier: true, plan: true, agencyPublishes: true } },
      publications: { orderBy: { publishedAt: "desc" } },
      writer: { select: { id: true, name: true } },
      pendingItems: {
        where: { resolvedAt: null },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        include: { responsible: { select: { name: true } } },
      },
    },
  });

  if (!post) notFound();

  const publishes = post.client.agencyPublishes;
  const editable = post.status === "scheduled" || post.status === "failed" || post.status === "draft";
  const isDraft = post.status === "draft";
  const isFailed = post.status === "failed";

  // Legenda por rede: captions[rede] ?? caption (o legado; N-18). Redes com o
  // mesmo texto viram um bloco só ("Facebook + Instagram").
  const capMap = (post.captions as Record<string, string> | null) ?? {};
  const legacyCaption = (post.caption ?? "").trim();
  const orderedTargets = [
    ...CAPTION_ORDER.filter((p) => post.targets.includes(p)),
    ...post.targets.filter((p) => !CAPTION_ORDER.includes(p)),
  ];
  const captionGroups: { platforms: string[]; text: string }[] = [];
  for (const p of orderedTargets) {
    const text = (capMap[p] ?? "").trim() || legacyCaption;
    if (!text) continue;
    const same = captionGroups.find((g) => g.text === text);
    if (same) same.platforms.push(p);
    else captionGroups.push({ platforms: [p], text });
  }

  const slides = Array.isArray(post.slides)
    ? (post.slides as { text?: string }[]).map((s) => s?.text ?? "").filter(Boolean)
    : [];

  // mídia: carrossel (mediaItems) ou single (mediaUrl)
  const rawItems = Array.isArray(post.mediaItems) ? (post.mediaItems as { url: string; type?: string }[]) : [];
  const mediaList = rawItems.length
    ? rawItems
    : post.mediaUrl
      ? [{ url: post.mediaUrl, type: undefined as string | undefined }]
      : [];
  const isVideo = (it: { url: string; type?: string }) =>
    it.type === "video" || /\.(mp4|mov|webm|m4v)$/i.test(it.url);
  const ratio = RATIO[post.format] ?? "aspect-4/5";
  const frameWidth = ratio === "aspect-9/16" ? "max-w-xs" : "max-w-md";
  const mediaAlt = post.theme ? `Arte do post: ${post.theme}` : "Arte do post";

  // "sexta-feira, 4 de setembro de 2026 às 12:45": só a 1ª letra maiúscula (A-019)
  const whenText = new Intl.DateTimeFormat("pt-BR", {
    timeZone: TZ,
    dateStyle: "full",
    timeStyle: "short",
  }).format(post.scheduledAt);

  const lastError = humanizeError(post.lastError);
  const showFailure = isFailed || (post.retryCount > 0 && !!lastError);
  // reenvio só para cliente que publica (A-013): o servidor também pula os de só produção
  const canRetry = isFailed && publishes;

  return (
    <div className="page animate-fade-up">
      <PageHeader
        title={post.theme?.trim() || "Post sem título"}
        subtitle={mediaList.length > 1 ? `${mediaList.length} mídias` : undefined}
        back="/posts"
        backLabel="Voltar para Posts"
        badges={
          <>
            <StatusBadge status={post.status} size="md" />
            <FormatBadge format={post.format} kind={post.contentKind} size="md" />
          </>
        }
        action={
          editable && (
            <>
              <Link href={`/posts/${post.id}/edit`} className={buttonClasses({ variant: "secondary" })}>
                <Icon.edit className="size-4.5" />
                Editar
              </Link>
              {post.client.tier === "basica" && <GenerateArtButton postId={post.id} />}
              {isDraft && publishes && (
                <ApprovePostButton
                  postId={post.id}
                  hasMedia={mediaList.length > 0}
                  needsClientApproval={post.client.plan === "aprovacao_cliente"}
                  clientName={post.client.name}
                  scheduleId={post.scheduleId}
                  scheduledAt={post.scheduledAt.toISOString()}
                  whenText={whenText}
                  targets={post.targets}
                />
              )}
            </>
          )
        }
      />

      {/* retorno do Novo post (U-02); a data vem do banco, não da URL */}
      {justCreated && (
        <Callout
          tone="success"
          live="polite"
          className="mb-6"
          title={
            post.status === "scheduled"
              ? `Post agendado para ${shortWhen(post.scheduledAt)}`
              : isDraft
                ? publishes
                  ? "Rascunho salvo"
                  : "Post salvo"
                : "Post criado"
          }
        >
          {isDraft && `${publishes ? "Fica fora da fila até alguém agendar. " : ""}Data prevista: ${shortWhen(post.scheduledAt)}. `}
          <Link href={`/posts/new?clientId=${post.client.id}`}>Criar outro post</Link>
        </Callout>
      )}

      {!publishes && (
        <Callout tone="info" title="Os posts deste cliente não são agendados pelo sistema." className="mb-6">
          A equipe produz o conteúdo, mas o post fica como rascunho: não é agendado nem publicado por aqui.
        </Callout>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        {/* Arte + legenda */}
        <section aria-label="Arte e legenda" className="lg:col-span-3">
          <div className="card overflow-hidden">
            <div className="bg-sunken p-3 sm:p-6">
              {mediaList.length === 0 ? (
                <div className={`relative mx-auto w-full ${frameWidth} ${ratio} overflow-hidden rounded-control`}>
                  {post.status === "published" && post.mediaThumb ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={post.mediaThumb}
                        alt={`Lembrança da publicação: ${post.theme ?? "post"}`}
                        className="h-full w-full object-contain"
                      />
                      <span className="absolute bottom-3 left-3 right-3 w-fit rounded-full border border-line bg-raised px-2.5 py-1 text-xs font-medium text-fg shadow-card">
                        Lembrança: o arquivo original foi removido após 30 dias
                      </span>
                    </>
                  ) : (
                    <div className="grid h-full place-items-center rounded-control border border-dashed border-line-strong bg-surface p-6 text-center">
                      <div>
                        <span aria-hidden="true" className="mx-auto mb-2 inline-flex size-8 text-fg-muted [&>svg]:size-full">
                          {post.status === "published" ? <Icon.check /> : <Icon.alert />}
                        </span>
                        <p className="text-sm font-medium text-fg">
                          {post.status === "published" ? "Publicado" : "Sem arte"}
                        </p>
                        <p className="mt-1 text-sm text-fg-muted">
                          {post.status === "published"
                            ? "O arquivo foi removido após 30 dias."
                            : publishes
                              ? "Sem mídia, a publicação falha no Instagram e no Facebook."
                              : "Adicione a arte quando ela ficar pronta."}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              ) : mediaList.length === 1 ? (
                <div className={`relative mx-auto w-full ${frameWidth} ${ratio} overflow-hidden rounded-control`}>
                  {isVideo(mediaList[0]) ? (
                    <video
                      src={mediaList[0].url}
                      controls
                      aria-label={mediaAlt}
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={mediaList[0].url} alt={mediaAlt} className="h-full w-full object-contain" />
                  )}
                </div>
              ) : (
                <ol aria-label="Mídias do carrossel" className="grid grid-cols-2 gap-2">
                  {mediaList.map((it, i) => (
                    <li key={i} className={`relative ${ratio} overflow-hidden rounded-control bg-surface`}>
                      <span className="absolute left-2 top-2 z-10 rounded-chip border border-line bg-raised px-1.5 text-xs font-semibold text-fg shadow-card">
                        {i + 1}
                      </span>
                      {isVideo(it) ? (
                        <video src={it.url} controls aria-label={`Mídia ${i + 1}`} className="h-full w-full object-contain" />
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={it.url} alt={`Mídia ${i + 1}`} className="h-full w-full object-contain" />
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </div>

            <div className="space-y-4 border-t border-line p-4 sm:p-5">
              {captionGroups.length === 0 ? (
                <p className="text-sm text-fg-muted">Sem legenda ainda.</p>
              ) : (
                captionGroups.map((g) => (
                  <div key={g.platforms.join("+")}>
                    <div className="mb-1.5 flex items-center gap-2">
                      <span aria-hidden="true" className="flex items-center gap-1">
                        {g.platforms.map((p) => (
                          <BrandBadge key={p} platform={p} size={20} />
                        ))}
                      </span>
                      <h2 className="text-xs font-semibold uppercase tracking-overline text-fg-muted">
                        Legenda · {g.platforms.map(platformLabel).join(" + ")}
                      </h2>
                    </div>
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-fg">{g.text}</p>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>

        {/* Dados do post */}
        <div className="space-y-4 lg:col-span-2">
          <section aria-label="Dados do post" className="card p-4 sm:p-5">
            <dl className="grid gap-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-fg-muted">Status</dt>
                <dd>
                  <StatusBadge status={post.status} />
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-fg-muted">Cliente</dt>
                <dd className="min-w-0 text-right">
                  <Link
                    href={`/clients/${post.client.id}`}
                    className="-my-3 inline-flex min-h-11 min-w-11 items-center justify-end py-3 font-medium text-link underline-offset-2 hover:text-link-hover hover:underline sm:-my-2.5 sm:min-h-10 sm:min-w-10 sm:py-2.5"
                  >
                    {post.client.name}
                  </Link>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-fg-muted">Redatora</dt>
                <dd className="flex min-w-0 items-center gap-2">
                  {post.writer ? (
                    <>
                      <Avatar name={post.writer.name} size="xs" />
                      <span className="truncate font-medium text-fg">{post.writer.name}</span>
                    </>
                  ) : (
                    <span className="text-fg-muted">Sem redatora</span>
                  )}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-fg-muted">Redes</dt>
                <dd className="flex flex-wrap justify-end gap-1.5">
                  {post.targets.map((t) => (
                    <PlatformChip key={t} platform={t} decorative={false} />
                  ))}
                </dd>
              </div>
              <div className="border-t border-line pt-3">
                <dt className="flex items-center gap-2 text-fg-muted">
                  <Icon.clock className="size-4" />
                  {publishes ? "Agendado para" : "Data prevista"}
                </dt>
                <dd className="mt-1 font-medium text-fg">{capitalizeFirst(whenText)}</dd>
              </div>
            </dl>

            {showFailure && (
              <Callout
                tone={isFailed ? "danger" : "warning"}
                title={isFailed ? "A publicação falhou" : undefined}
                className="mt-4"
                action={canRetry ? <RetryPostButton postId={post.id} /> : undefined}
              >
                {lastError && <p>Último erro: {lastError}</p>}
                {post.retryCount > 0 && (
                  <p className={lastError ? "mt-1 text-fg-muted" : "text-fg-muted"}>
                    {post.retryCount} {plural(post.retryCount, "tentativa", "tentativas")} de reenvio automático.
                  </p>
                )}
                {canRetry && (
                  <p className="mt-1 text-fg-muted">“Reenviar” coloca o post de novo na fila de publicação.</p>
                )}
              </Callout>
            )}
          </section>

          {/* arte: feita/a fazer, quem marcou, arquivo no Drive (fila /design) */}
          <ArtStatusCard postId={post.id} />

          {/* ajuste pedido pelo cliente no link de aprovação */}
          {post.clientNote && (
            <section
              aria-labelledby="ajuste-cliente"
              className="rounded-card border border-brand-line bg-brand-bg p-4 sm:p-5"
            >
              <h2 id="ajuste-cliente" className="flex items-center gap-1.5 text-sm font-semibold text-brand-fg">
                <Icon.edit className="size-4" />
                Ajuste pedido por {post.client.name}
              </h2>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-fg">{post.clientNote}</p>
            </section>
          )}

          {/* nota da equipe: só nas telas internas, nunca nos links públicos */}
          {post.internalNote && (
            <section aria-labelledby="nota-interna" className="card p-4 sm:p-5">
              <h2 id="nota-interna" className="flex items-center gap-1.5 text-sm font-semibold text-fg">
                <Icon.fileText className="size-4 text-fg-muted" />
                Nota interna
              </h2>
              <p className="mt-0.5 text-xs text-fg-muted">Só a equipe vê. Não aparece no link do cliente.</p>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-fg">{post.internalNote}</p>
            </section>
          )}

          {/* pendências abertas vinculadas a este post */}
          {post.pendingItems.length > 0 && (
            <section aria-labelledby="pendencias-post" className="card overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3 sm:px-5">
                <h2 id="pendencias-post" className="text-sm font-semibold text-fg">
                  {post.pendingItems.length}{" "}
                  {plural(post.pendingItems.length, "pendência aberta", "pendências abertas")}
                </h2>
                <Link
                  href={`/pendencias?cliente=${post.client.id}`}
                  className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-link underline-offset-2 hover:text-link-hover hover:underline sm:min-h-10"
                >
                  Ver pendências do cliente
                  <Icon.arrowRight className="size-4" />
                </Link>
              </div>
              <ul className="divide-y divide-line">
                {post.pendingItems.map((item) => {
                  const kind = metaOf(PENDING_KIND, item.kind);
                  return (
                    <li key={item.id} className="px-4 py-3 sm:px-5">
                      <div className="flex flex-wrap items-center gap-2">
                        <ToneBadge tone={kind.tone}>{kind.label}</ToneBadge>
                        <p className="min-w-0 flex-1 text-sm font-medium text-fg">{item.title}</p>
                      </div>
                      {item.details && (
                        <p title={item.details} className="mt-1 line-clamp-2 text-sm text-fg-muted">
                          {item.details}
                        </p>
                      )}
                      <p className="mt-1 text-xs text-fg-muted">
                        Aberta em {formatDate(item.createdAt)}
                        {item.responsible ? ` · Responsável: ${item.responsible.name}` : ""}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {/* Roteiro por tela (carrossel/reels) */}
          {slides.length > 0 && (
            <section aria-labelledby="roteiro-post" className="card overflow-hidden">
              <div className="border-b border-line px-4 py-3 sm:px-5">
                <h2 id="roteiro-post" className="text-sm font-semibold text-fg">
                  {post.format === "reels" ? "Telas do reels" : "Páginas do carrossel"}
                  <span className="ml-2 text-xs font-normal text-fg-muted">
                    {slides.length} {plural(slides.length, "tela", "telas")}
                  </span>
                </h2>
              </div>
              <ol className="divide-y divide-line">
                {slides.map((text, i) => (
                  <li key={i} className="flex gap-3 px-4 py-3 sm:px-5">
                    <span className="mt-0.5 shrink-0 text-xs font-semibold text-fg-muted">Arte {i + 1}</span>
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-fg">{text}</p>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {/* Histórico de publicação */}
          <section aria-labelledby="historico-post" className="card overflow-hidden">
            <div className="border-b border-line px-4 py-3 sm:px-5">
              <h2 id="historico-post" className="text-sm font-semibold text-fg">
                Histórico de publicação
              </h2>
            </div>
            {post.publications.length === 0 ? (
              <p className="px-5 py-6 text-center text-sm text-fg-muted">
                {publishes ? "Ainda não publicado." : "Sem publicações: o sistema não agenda nem publica os posts deste cliente."}
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {post.publications.map((pub) => {
                  const pubError = humanizeError(pub.error);
                  return (
                    <li key={pub.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
                      <span aria-hidden="true">
                        <BrandBadge platform={pub.platform} size={28} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-fg">{platformLabel(pub.platform)}</p>
                        {pub.publishedAt && (
                          <p className="text-xs text-fg-muted">{formatDateTime(pub.publishedAt)}</p>
                        )}
                        {pubError && (
                          <p title={pubError} className="truncate text-xs text-danger-fg">
                            {pubError}
                          </p>
                        )}
                      </div>
                      <StatusBadge
                        status={pub.status === "success" ? "published" : pub.status === "publishing" ? "publishing" : "failed"}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
