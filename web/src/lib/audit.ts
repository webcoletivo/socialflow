import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { auth } from "@/auth";
import { clientIp } from "@/lib/rate-limit";

/**
 * Trilha de auditoria (tabela audit_log): registra ações sensíveis — quem, quando,
 * o quê e em qual cliente. Somente inserção; nunca grava segredos (senhas, tokens,
 * chaves) em `meta`.
 *
 * Ações usadas (prefixo = área):
 * - credential.reveal, credential.update
 * - user.create, user.role_change, user.password_change, user.delete
 * - client.delete, client.account_change, client.meta_link
 * - posts.bulk_delete, schedule.approve_internal, post.posted_manual, post.unposted_manual
 * - settings.ai_model, settings.openai_key
 * - tokens.refresh (só contagens), auth.login_blocked
 */
export type AuditEvent = {
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  clientId?: string | null;
  /** detalhes não sensíveis (ids, contagens, papel antigo/novo) */
  meta?: Record<string, unknown> | null;
};

type Actor = { id: string | null; email: string | null };

async function currentActor(): Promise<Actor> {
  try {
    const session = await auth();
    const user = session?.user as { id?: string; email?: string | null } | undefined;
    return { id: user?.id ?? null, email: user?.email ?? null };
  } catch {
    return { id: null, email: null };
  }
}

/**
 * Grava um evento de auditoria. Nunca lança: falha de auditoria vai só para o log
 * (a ação principal não deve quebrar por isso).
 * `req` (opcional) fornece o IP; `actor` (opcional) evita reler a sessão.
 */
export async function audit(event: AuditEvent, opts: { req?: Request; actor?: Actor } = {}): Promise<void> {
  try {
    const actor = opts.actor ?? (await currentActor());
    await prisma.auditLog.create({
      data: {
        actorId: actor.id,
        actorEmail: actor.email,
        action: event.action,
        targetType: event.targetType ?? null,
        targetId: event.targetId ?? null,
        clientId: event.clientId ?? null,
        meta: event.meta ? (event.meta as Prisma.InputJsonValue) : Prisma.JsonNull,
        ip: opts.req ? clientIp(opts.req) : null,
      },
    });
  } catch (e) {
    console.error("[auditoria] falha ao registrar", event.action, e instanceof Error ? e.message : e);
  }
}
