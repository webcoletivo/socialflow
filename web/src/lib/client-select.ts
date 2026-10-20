import type { Prisma } from "@/generated/prisma/client";

/**
 * Campos do cliente que as APIs devolvem ao navegador (OWASP AC-02/CR-03): `select` explícito,
 * para que nenhuma coluna cifrada (`credentialsEnc`) nem coluna nova sensível saia por padrão.
 * `hasCredentials` é calculado no servidor (`withoutSecrets`).
 */

/** Lista (GET /api/clients): o que uma lista/seletor de clientes usa; sem briefing nem telefones. */
export const CLIENT_LIST_SELECT = {
  id: true,
  name: true,
  tradeName: true,
  email: true,
  plan: true,
  tier: true,
  carouselFrequency: true,
  reelsWeekday: true,
  status: true,
  segment: true,
  agencyPublishes: true,
  logoUrl: true,
  brandColor: true,
  responsibleUserId: true,
  designerUserId: true,
  createdAt: true,
  credentialsEnc: true, // só para `hasCredentials`; removido por withoutSecrets
  _count: { select: { socialAccounts: true, posts: true } },
} satisfies Prisma.ClientSelect;

/** Cadastro completo (GET/PATCH /api/clients/[id], POST /api/clients) — todas as colunas não secretas. */
export const CLIENT_DETAIL_FIELDS = {
  id: true,
  name: true,
  email: true,
  plan: true,
  toneOfVoice: true,
  driveFolderId: true,
  tradeName: true,
  website: true,
  city: true,
  phone: true,
  whatsapp: true,
  facebookUrl: true,
  instagramUrl: true,
  briefing: true,
  logoUrl: true,
  brandColor: true,
  tier: true,
  carouselFrequency: true,
  reelsWeekday: true,
  showContacts: true,
  agencyPublishes: true,
  extraEmails: true,
  status: true,
  statusChangedAt: true,
  segment: true,
  responsibleUserId: true,
  designerUserId: true,
  createdAt: true,
  credentialsEnc: true, // só para `hasCredentials`; removido por withoutSecrets
} satisfies Prisma.ClientSelect;

/**
 * Remove o cofre cifrado e põe `hasCredentials` no lugar. Defesa em profundidade: vale mesmo
 * que um `select` antigo ou um mock devolva a coluna.
 */
export function withoutSecrets<T extends object>(row: T): Omit<T, "credentialsEnc"> & { hasCredentials: boolean } {
  const { credentialsEnc, ...safe } = row as T & { credentialsEnc?: unknown };
  return { ...(safe as Omit<T, "credentialsEnc">), hasCredentials: typeof credentialsEnc === "string" && credentialsEnc.length > 0 };
}
