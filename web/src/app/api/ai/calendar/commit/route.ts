// namespace (e não `import { after }`): os testes antigos trocam "next/server" por um módulo
// falso sem `after`, e um import nomeado quebraria o carregamento da rota neles
import * as server from "next/server";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAuthUser } from "@/lib/api-auth";
import { uuidString } from "@/lib/validators";
import { enforceRateLimit, clientIp } from "@/lib/rate-limit";
import { consumeAiQuota } from "@/lib/ai-quota";
import { readJsonLimited } from "@/lib/read-json";
import { mediaUrlProblem } from "@/lib/media-url";
import { prepareClientDriveFolders, spMonthKey } from "@/lib/drive-sync";
import { fillMissingCaptions, needsContent } from "@/lib/calendar-captions";
import { CONTENT_KINDS } from "@/lib/content-packages";
import { z } from "zod";

export const dynamic = "force-dynamic";
// as legendas que faltarem são geradas DEPOIS da resposta (after), dentro deste limite
export const maxDuration = 300;
/** Não começa lote de IA novo depois disso (folga para o lote em andamento terminar). */
const FILL_BUDGET_MS = 180_000;
/**
 * Posts por chamada de IA no `after()` (= CAPTION_BATCH_SIZE de lib/calendar-captions; repetido
 * aqui porque os testes antigos trocam aquele módulo por um falso só com as funções).
 */
const FILL_BATCH_SIZE = 4;
/** Teto do corpo: até 62 posts com legendas e roteiros (o proxy já recusa acima de 2 MB). */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const captionsSchema = z
  .object({
    instagram: z.string().optional(),
    facebook: z.string().optional(),
    linkedin: z.string().optional(),
  })
  .optional();

const postSchema = z.object({
  theme: z.string().max(200).optional(),
  explanation: z.string().max(600).optional(),
  captions: captionsSchema,
  mediaUrl: z.string().url().optional().or(z.literal("")),
  format: z.enum(["feed", "story", "carrossel", "reels"]).default("feed"),
  // tipo do conteúdo no pacote de gestão (posts.content_kind); ausente/null = sem tipo
  contentKind: z.enum(CONTENT_KINDS).nullable().optional(),
  scheduledAt: z.string().datetime(),
  targets: z.array(z.enum(["instagram", "facebook", "linkedin"])).min(1),
  slides: z.array(z.object({ text: z.string().max(2000) })).max(20).optional(),
});

const schema = z.object({
  clientId: uuidString,
  // mês de referência YYYY-MM (cria o cronograma)
  month: z.string().regex(/^\d{4}-\d{2}$/),
  // até 31 posts principais + os stories que saem junto de cada um
  posts: z.array(postSchema).min(1).max(62),
});

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Falha ao gravar (a transação desfaz tudo). Texto fixo: a mensagem do Prisma é técnica e em
 * inglês, e as curtas (ex.: "Transaction already closed…") passariam intactas pelo toUserMessage.
 */
const SAVE_FAILED = "Não foi possível salvar o cronograma agora. Nada foi gravado; tente de novo em instantes.";

/**
 * Salva os posts revisados como rascunhos (draft), num cronograma. Legendas e slides que a
 * revisão já gerou vêm em `captions`/`slides`; os posts que chegarem sem legenda (com título)
 * ganham legenda no servidor depois da resposta — `after()` + fillMissingCaptions, que só
 * grava onde a legenda continua vazia.
 */
export async function POST(req: server.NextRequest) {
  const { user, denied } = await requireAuthUser();
  if (denied) return denied;

  const limited = enforceRateLimit(`calendar-commit:${clientIp(req)}`, 20, 5 * 60_000);
  if (limited) return limited;

  const read = await readJsonLimited(req, MAX_BODY_BYTES);
  if (!read.ok) return read.response;
  // OWASP AUD2-04 (lib/media-url): mídia de cada post só por https público — 400 pt-BR com o campo
  const rawPosts = (read.value as { posts?: unknown } | null)?.posts;
  if (Array.isArray(rawPosts)) {
    for (const [i, p] of rawPosts.entries()) {
      const media = (p as { mediaUrl?: unknown } | null)?.mediaUrl;
      const problem = typeof media === "string" && media.trim() !== "" ? mediaUrlProblem(media) : null;
      if (problem) return Response.json({ error: problem, field: `posts.${i}.mediaUrl` }, { status: 400 });
    }
  }
  const parsed = schema.safeParse(read.value);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { clientId, month, posts } = parsed.data;
  const [year, mon] = month.split("-").map(Number);
  const monthRef = new Date(`${year}-${pad(mon)}-01T00:00:00-03:00`);

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, name: true, driveFolderId: true },
  });
  if (!client) return Response.json({ error: "Cliente não encontrado" }, { status: 404 });

  // cronograma do mês: reaproveita apenas se ainda estiver editável; um mês já
  // enviado/aprovado não pode receber posts por engano
  const existing = await prisma.schedule.findFirst({
    where: { clientId, monthRef },
    select: { id: true, status: true },
  });
  if (existing && !["rascunho", "em_revisao"].includes(existing.status)) {
    return Response.json(
      {
        error:
          "Este mês já tem um cronograma " +
          (existing.status === "aprovado_cliente" ? "aprovado" : `(${existing.status})`) +
          ". Reverta a aprovação em /aprovacoes antes de gerar de novo.",
      },
      { status: 409 }
    );
  }

  let result: { scheduleId: string; created: number; duplicates: number; pendingIds: string[] };
  try {
    result = await prisma.$transaction(async (tx) => {
      const schedule =
        existing ??
        (await tx.schedule.create({
          data: { clientId, monthRef, status: "rascunho" },
          select: { id: true, status: true },
        }));

      // idempotência: retry/segunda aba não pode duplicar o mês — pula posts
      // idênticos (mesmo horário + mesmo formato) já salvos neste cronograma
      const already = await tx.post.findMany({
        where: { scheduleId: schedule.id },
        select: { scheduledAt: true, format: true },
      });
      const seen = new Set(already.map((p) => `${p.scheduledAt.getTime()}:${p.format}`));
      const fresh = posts.filter(
        (p) => !seen.has(`${new Date(p.scheduledAt).getTime()}:${p.format}`)
      );

      let pendingIds: string[] = [];
      if (fresh.length > 0) {
        const created = await tx.post.createManyAndReturn({
          data: fresh.map((p, i) => {
            const captions: Record<string, string> = {};
            if (p.captions) {
              for (const [k, v] of Object.entries(p.captions)) {
                if (typeof v === "string" && v.trim()) captions[k] = v.trim();
              }
            }
            return {
              scheduleId: schedule.id,
              clientId,
              theme: (p.theme ?? `Post ${i + 1}`).slice(0, 200),
              explanation: p.explanation?.trim() || null,
              captions: Object.keys(captions).length
                ? (captions as Prisma.InputJsonValue)
                : undefined,
              slides: p.slides?.length
                ? (p.slides as unknown as Prisma.InputJsonValue)
                : undefined,
              mediaUrl: p.mediaUrl || null,
              format: p.format,
              contentKind: p.contentKind ?? null,
              scheduledAt: new Date(p.scheduledAt),
              targets: p.targets,
              status: "draft",
            };
          }),
          select: { id: true, theme: true, format: true, captions: true, slides: true },
        });
        // sem legenda (ou carrossel/reels sem slides) e com título: a IA completa depois
        pendingIds = created.filter(needsContent).map((p) => p.id);
      }

      return {
        scheduleId: schedule.id,
        created: fresh.length,
        duplicates: posts.length - fresh.length,
        pendingIds,
      };
    });
  } catch (e) {
    // detalhe do banco só no log do servidor
    console.error("[ai/calendar/commit] falha ao gravar o cronograma", clientId, month, e);
    return Response.json({ error: SAVE_FAILED }, { status: 500 });
  }

  // Drive (best-effort, depois de gravar): pasta do cliente e Cliente/AAAA/MM - Mês
  // de cada mês tocado. Nunca derruba o commit: falha vira `driveWarning`.
  const { pendingIds, ...saved } = result;
  // teto de gerações por IA (CF-12): as legendas que faltam saem em lotes de 4 posts, e cada
  // lote conta 1 geração. Sem cota, o cronograma fica salvo e o lote semanal completa depois.
  let captionsPending = pendingIds.length;
  if (pendingIds.length > 0) {
    const quota = consumeAiQuota(user.id, Math.ceil(pendingIds.length / FILL_BATCH_SIZE));
    if (!quota.ok) {
      console.warn(
        `[ai/calendar/commit] limite de IA (${quota.scope}): ${pendingIds.length} post(s) ficam sem legenda por agora`,
        clientId,
        month
      );
      captionsPending = 0;
    }
  }
  if (captionsPending > 0) {
    server.after(async () => {
      try {
        const fill = await fillMissingCaptions(pendingIds, { deadlineAt: Date.now() + FILL_BUDGET_MS });
        if (fill.failed > 0) {
          console.error(
            `[ai/calendar/commit] legendas em segundo plano: ${fill.failed} de ${pendingIds.length} post(s) ficaram sem legenda`,
            clientId,
            month
          );
        }
      } catch (e) {
        // só log: o cronograma já foi salvo; o lote semanal ainda completa o que faltar
        console.error("[ai/calendar/commit] falha ao gerar legendas em segundo plano", clientId, month, e);
      }
    });
  }

  const months = posts.map((p) => spMonthKey(new Date(p.scheduledAt)));
  const driveInfo = await prepareClientDriveFolders(client, months);

  return Response.json({ ...saved, captionsPending, month, ...driveInfo }, { status: 201 });
}
