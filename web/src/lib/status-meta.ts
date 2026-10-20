/**
 * Rótulos pt-BR e tom semântico dos status do sistema (puro). Fonte única
 * para badges e selects — substitui os mapas espalhados (ui.tsx,
 * SchedulesManager, calendar) e o `planLabel` duplicado.
 *
 * O tom é semântico; a cor de cada tom vem dos tokens do design system.
 */

export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "accent";

export type StatusMeta = { label: string; tone: Tone };

export const POST_STATUSES = ["draft", "scheduled", "publishing", "published", "failed"] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export const POST_STATUS: Record<PostStatus, StatusMeta> = {
  draft: { label: "Rascunho", tone: "neutral" },
  scheduled: { label: "Agendado", tone: "info" },
  publishing: { label: "Publicando", tone: "warning" },
  published: { label: "Publicado", tone: "success" },
  failed: { label: "Falhou", tone: "danger" },
};

export const SCHEDULE_STATUSES = [
  "rascunho",
  "aprovado_interno",
  "enviado_cliente",
  "em_revisao",
  "aprovado_cliente",
] as const;
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];

export const SCHEDULE_STATUS: Record<ScheduleStatus, StatusMeta> = {
  rascunho: { label: "Rascunho", tone: "neutral" },
  aprovado_interno: { label: "Aprovado (interno)", tone: "info" },
  enviado_cliente: { label: "Enviado ao cliente", tone: "warning" },
  em_revisao: { label: "Em revisão", tone: "accent" },
  aprovado_cliente: { label: "Aprovado", tone: "success" },
};

export const CLIENT_STATUSES = ["ativo", "pausado", "encerrado"] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export const CLIENT_STATUS: Record<ClientStatus, StatusMeta> = {
  ativo: { label: "Ativo", tone: "success" },
  pausado: { label: "Pausado", tone: "warning" },
  encerrado: { label: "Encerrado", tone: "neutral" },
};

/** Segmentos da carteira, como na legenda da planilha (significado a confirmar com a equipe). */
export const SEGMENTS = ["CORR", "CARE", "COLETIVO"] as const;
export type Segment = (typeof SEGMENTS)[number];

export const SEGMENT: Record<Segment, StatusMeta> = {
  CORR: { label: "CORR", tone: "info" },
  CARE: { label: "CARE", tone: "success" },
  COLETIVO: { label: "COLETIVO", tone: "accent" },
};

/** Client.plan: o cliente aprova o cronograma e os posts? */
export const PLANS = ["sem_aprovacao", "aprovacao_cliente"] as const;
export type Plan = (typeof PLANS)[number];

export const PLAN: Record<Plan, StatusMeta> = {
  sem_aprovacao: { label: "Sem aprovação", tone: "neutral" },
  aprovacao_cliente: { label: "Com aprovação", tone: "info" },
};

/**
 * Client.tier: pacote de gestão (lib/content-packages). "completa" é o valor antigo (sem pacote):
 * continua aceito e exibido, mas não é oferecido no cadastro (SELECTABLE_TIERS).
 */
export const SELECTABLE_TIERS = ["gestao_1", "gestao_2", "gestao_3_stories", "gestao_reels", "basica"] as const;
export const TIERS = [...SELECTABLE_TIERS, "completa"] as const;
export type Tier = (typeof TIERS)[number];

export const TIER: Record<Tier, StatusMeta> = {
  gestao_1: { label: "Gestão 1", tone: "neutral" },
  gestao_2: { label: "Gestão 2", tone: "neutral" },
  gestao_3_stories: { label: "Gestão 3 (Stories)", tone: "neutral" },
  gestao_reels: { label: "Gestão Reels", tone: "neutral" },
  basica: { label: "Básica (artes-base por IA)", tone: "accent" },
  completa: { label: "Completa (antigo) — escolha um pacote", tone: "warning" },
};

/** SocialAccount.status. */
export const ACCOUNT_STATUSES = ["active", "inactive"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const ACCOUNT_STATUS: Record<AccountStatus, StatusMeta> = {
  active: { label: "Ativa", tone: "success" },
  inactive: { label: "Inativa", tone: "neutral" },
};

/** PendingItem.kind. */
export const PENDING_KINDS = ["stand_by", "aguardando_material", "avulso", "outro"] as const;
export type PendingKind = (typeof PENDING_KINDS)[number];

export const PENDING_KIND: Record<PendingKind, StatusMeta> = {
  stand_by: { label: "Stand-by", tone: "warning" },
  aguardando_material: { label: "Aguardando material", tone: "info" },
  avulso: { label: "Post avulso", tone: "accent" },
  outro: { label: "Outro", tone: "neutral" },
};

/**
 * Busca segura num dos mapas acima. Valor desconhecido (dado antigo ou fora
 * do enum) → o próprio valor como rótulo, tom neutro.
 */
export function metaOf<K extends string>(
  map: Record<K, StatusMeta>,
  value: string | null | undefined
): StatusMeta {
  const v = value ?? "";
  return Object.prototype.hasOwnProperty.call(map, v) ? map[v as K] : { label: v, tone: "neutral" };
}

/** Atalho para o rótulo: `labelOf(PLAN, client.plan)`. */
export function labelOf<K extends string>(map: Record<K, StatusMeta>, value: string | null | undefined): string {
  return metaOf(map, value).label;
}
