import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSessionUser } from "@/lib/api-auth";
import { audit } from "@/lib/audit";
import { uuidString } from "@/lib/validators";

export const dynamic = "force-dynamic";

/** Textos do 400/401/404/409/500 (N-14: `error` é sempre uma frase pt-BR). */
const MSG = {
  session: "Sua sessão expirou. Entre de novo.",
  invalidId: "Post inválido.",
  body: "Informe se o post foi postado ou não.",
  notFound: "Post não encontrado.",
  alreadyPublished: "Este post já está publicado.",
  publishing: "Este post está sendo publicado pelo sistema agora. Aguarde e recarregue a página.",
  notManual: "Este post foi publicado pelo sistema e não pode ser desmarcado.",
  notPosted: "Este post não está marcado como postado.",
  failed: "Não foi possível atualizar a postagem agora. Tente de novo.",
} as const;

const bodySchema = z.object({ posted: z.boolean() });

/** Status que podem virar "postado à mão" (publishing = o sistema está publicando agora). */
const MARKABLE = ["draft", "scheduled", "failed"];

/**
 * Marca (ou desmarca) um post como POSTADO à mão — calendário da página /design, enquanto
 * a equipe posta direto nas redes.
 *
 * Corpo: `{ posted: boolean }`.
 *   - posted=true  → status "published", posted_manually_at = agora, posted_by = usuária;
 *                    só de draft/scheduled/failed (a fila de publicação nunca pega "published").
 *   - posted=false → status "draft" e limpa os dois campos; só se a marcação foi manual.
 * Resposta 200: `{ ok: true, status, postedAt: string | null (ISO), postedBy: { id, name } | null }`.
 * Erros: 401 sem sessão; 400 id ou corpo inválido; 404 post inexistente; 409 estado não permite;
 * 500 falha do banco — sempre `{ error: "<pt-BR>" }`. Cada mudança vai para o audit_log.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: MSG.session }, { status: 401 });

  const { id } = await params;
  if (!uuidString.safeParse(id).success) {
    return Response.json({ error: MSG.invalidId }, { status: 400 });
  }
  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: MSG.body }, { status: 400 });
  }
  const { posted } = parsed.data;

  try {
    const me = await prisma.user.findUnique({ where: { id: user.id }, select: { id: true, name: true } });
    const at = new Date();
    // updateMany com a condição de estado: duas marcações ao mesmo tempo não se atropelam
    const { count } = posted
      ? await prisma.post.updateMany({
          where: { id, status: { in: MARKABLE } },
          data: { status: "published", postedManuallyAt: at, postedBy: me?.id ?? null, lastError: null },
        })
      : await prisma.post.updateMany({
          where: { id, status: "published", postedManuallyAt: { not: null } },
          data: { status: "draft", postedManuallyAt: null, postedBy: null },
        });

    if (count === 0) {
      const current = await prisma.post.findUnique({ where: { id }, select: { status: true, postedManuallyAt: true } });
      if (!current) return Response.json({ error: MSG.notFound }, { status: 404 });
      const error = posted
        ? current.status === "publishing"
          ? MSG.publishing
          : MSG.alreadyPublished
        : current.status === "published"
          ? MSG.notManual
          : MSG.notPosted;
      return Response.json({ error }, { status: 409 });
    }

    const post = await prisma.post.findUnique({ where: { id }, select: { clientId: true } });
    await audit(
      {
        action: posted ? "post.posted_manual" : "post.unposted_manual",
        targetType: "post",
        targetId: id,
        clientId: post?.clientId ?? null,
      },
      { req, actor: { id: user.id, email: user.email } },
    );
    return Response.json({
      ok: true,
      status: posted ? "published" : "draft",
      postedAt: posted ? at.toISOString() : null,
      postedBy: posted ? me : null,
    });
  } catch (e) {
    // detalhe técnico só no log do servidor; a tela recebe uma frase pt-BR
    console.error("[posts/posted]", e);
    return Response.json({ error: MSG.failed }, { status: 500 });
  }
}
