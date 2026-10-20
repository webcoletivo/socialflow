import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuthUser } from "@/lib/api-auth";
import { uuidString } from "@/lib/validators";
import { enforceRateLimit, clientIp } from "@/lib/rate-limit";
import { enforceAiQuota } from "@/lib/ai-quota";
import { readJsonLimited } from "@/lib/read-json";
import { toUserMessage } from "@/lib/user-facing-error";
import { CAPTION_BATCH_MAX, generateCaptionBatch } from "@/lib/calendar-captions";
import { CONTENT_KINDS } from "@/lib/content-packages";
import { z } from "zod";

export const dynamic = "force-dynamic";
// 2 tentativas × 55s + 1.5s de pausa (generateCaptionBatch) cabem em 120s
export const maxDuration = 120;

const FALLBACK = "Não foi possível gerar as legendas agora. Tente de novo em instantes.";
const INVALID = "Não foi possível ler as postagens enviadas. Recarregue a página e tente de novo.";
const TOO_MANY = `Envie no máximo ${CAPTION_BATCH_MAX} postagens por vez.`;
const NO_THEME = "Cada postagem precisa de um título para gerar a legenda.";
const NO_TARGET = "Cada postagem precisa de ao menos uma rede social.";
const NOTHING_BACK = "A inteligência artificial não devolveu as legendas. Tente de novo.";

const postSchema = z.object({
  // identificador da postagem na tela de revisão (devolvido junto com a legenda)
  id: z.string().regex(/^[A-Za-z0-9_:-]{1,64}$/),
  theme: z.string().trim().min(1).max(200),
  explanation: z.string().max(600).optional(),
  format: z.enum(["feed", "story", "carrossel", "reels"]).default("feed"),
  // tipo do slot do pacote de gestão (vai no prompt: reels gravado, banner animado…)
  contentKind: z.enum(CONTENT_KINDS).nullable().optional(),
  targets: z.array(z.enum(["instagram", "facebook", "linkedin"])).min(1).max(3),
});

const schema = z.object({
  clientId: uuidString,
  posts: z.array(postSchema).min(1).max(CAPTION_BATCH_MAX),
});

/** Texto pt-BR do 400 conforme o primeiro problema do corpo (N-14: nunca o objeto do zod). */
function invalidMessage(error: z.ZodError): string {
  for (const issue of error.issues) {
    const [first, , field] = issue.path;
    if (first === "posts" && issue.path.length === 1 && issue.code === "too_big") return TOO_MANY;
    if (first === "posts" && field === "theme") return NO_THEME;
    if (first === "posts" && field === "targets") return NO_TARGET;
  }
  return INVALID;
}

/**
 * Legendas (e slides de carrossel/reels) de um LOTE de postagens da revisão do cronograma,
 * geradas em segundo plano enquanto a equipe revisa. Não grava nada: devolve o texto para a
 * tela preencher os campos. Briefing do cliente no prompt e hashtags fixas no fim
 * (lib/calendar-captions.ts).
 */
/** Teto do corpo: até 6 postagens (título 200 + explicação 600 + redes). */
const MAX_BODY_BYTES = 64 * 1024;

export async function POST(req: NextRequest) {
  const { user, denied } = await requireAuthUser();
  if (denied) return denied;

  // a revisão de um cronograma de 12 posts faz 3–4 chamadas (+ "Tentar de novo")
  const limited = enforceRateLimit(`ai-calendar-captions:${clientIp(req)}`, 60, 5 * 60_000);
  if (limited) return limited;

  const read = await readJsonLimited(req, MAX_BODY_BYTES);
  if (!read.ok) return read.response;
  const parsed = schema.safeParse(read.value);
  if (!parsed.success) {
    return Response.json({ error: invalidMessage(parsed.error) }, { status: 400 });
  }
  const { clientId, posts } = parsed.data;
  if (new Set(posts.map((p) => p.id)).size !== posts.length) {
    return Response.json({ error: INVALID }, { status: 400 });
  }

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { name: true, toneOfVoice: true, briefing: true },
  });
  if (!client) return Response.json({ error: "Cliente não encontrado" }, { status: 404 });

  // teto de gerações por IA (CF-12): cada LOTE (até 6 postagens) conta 1 geração
  const quota = enforceAiQuota(user.id, 1, "calendario-legendas");
  if (quota) return quota;

  try {
    // o navegador cancelou (salvou/fechou a revisão) → a chamada ao Gemini é cancelada junto
    const results = await generateCaptionBatch(client, posts, { signal: req.signal });
    const done: { id: string; captions: Record<string, string>; slides?: string[] }[] = [];
    const missing: string[] = [];
    posts.forEach((p, i) => {
      const r = results[i];
      if (r) done.push({ id: p.id, ...r });
      else missing.push(p.id);
    });
    if (done.length === 0) {
      console.error("[ai/calendar/captions] a IA não devolveu nenhuma legenda do lote", clientId);
      return Response.json({ error: NOTHING_BACK }, { status: 502 });
    }
    return Response.json({ posts: done, missing }, { status: 200 });
  } catch (e) {
    // pedido cancelado por quem chamou: ninguém espera a resposta, nada a registrar
    if (req.signal.aborted) return Response.json({ error: "Geração cancelada." }, { status: 499 });
    console.error("[ai/calendar/captions]", e);
    return Response.json({ error: toUserMessage(e, FALLBACK) }, { status: 502 });
  }
}
