import Link from "next/link";
import { Icon } from "./Icons";
import { BrandBadge, BRAND } from "./BrandIcons";
import {
  ACCOUNT_STATUS,
  CLIENT_STATUS,
  metaOf,
  PENDING_KIND,
  PLAN,
  POST_STATUS,
  SCHEDULE_STATUS,
  SEGMENT,
  TIER,
  type StatusMeta,
  type Tone,
} from "@/lib/status-meta";
import { STAGE_META, type ProductionStage } from "@/lib/production";
import { formatMeta, type PostFormat } from "@/lib/formats";
import { contentKindLabel } from "@/lib/content-packages";

/*
 * Peças de página compartilhadas por telas de servidor e de cliente (sem
 * "use client"). API só aditiva: as props antigas mantêm o significado.
 */

export function PageHeader({
  title,
  subtitle,
  action,
  back,
  backLabel = "Voltar",
  badges,
}: {
  title: string;
  subtitle?: React.ReactNode;
  /** grupo de botões; no máximo 1 primary */
  action?: React.ReactNode;
  back?: string;
  /** padrão "Voltar"; vira aria-label do link */
  backLabel?: string;
  /** linha sob o título (StatusBadge, "Só produção", redatora…) */
  badges?: React.ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      {/* A base do bloco do título é o h1 numa linha só (subtítulo e selos não contam:
          contain-inline-size). Se título + ações não cabem lado a lado, as ações descem
          para a linha de baixo em vez de espremer o título em várias linhas. */}
      <div className="flex min-w-0 flex-auto items-start gap-3">
        {back && (
          <Link
            href={back}
            aria-label={backLabel}
            title={backLabel}
            className="inline-grid size-11 shrink-0 place-items-center rounded-control border border-line-strong text-fg-muted transition-colors duration-(--sf-dur-fast) hover:bg-hover hover:text-fg sm:size-10"
          >
            <Icon.back className="size-4.5" />
          </Link>
        )}
        <div className="min-w-0 flex-auto">
          <h1 className="font-display text-2xl font-semibold tracking-display text-balance wrap-break-word text-fg sm:text-3xl">
            {title}
          </h1>
          {subtitle && <div className="mt-1 text-sm text-fg-muted contain-inline-size">{subtitle}</div>}
          {badges && <div className="mt-2 flex flex-wrap gap-2 contain-inline-size">{badges}</div>}
        </div>
      </div>
      {/* < sm: as ações descem para a linha de baixo em largura total (A-001) */}
      {action && <div className="flex basis-full flex-wrap gap-2 sm:basis-auto">{action}</div>}
    </header>
  );
}

/* ------------------------------------------------------------------ *
 * Badges (DESIGN e.8): rótulo e tom só dos mapas do lib/status-meta (A-015)
 * ------------------------------------------------------------------ */

export type StatusKind =
  | "post"
  | "schedule"
  | "client"
  | "segment"
  | "plan"
  | "tier"
  | "account"
  | "pending"
  | "agencyPublishes"
  | "stage";

/** Selo "Agendar posts?" (C3, local do S12): passe `client.agencyPublishes ? "sim" : "nao"`. */
export const AGENCY_PUBLISHES: Record<"sim" | "nao", StatusMeta> = {
  nao: { label: "Só produção", tone: "accent" },
  sim: { label: "Agenda posts", tone: "neutral" },
};

const STATUS_MAPS: Record<Exclude<StatusKind, "stage">, Record<string, StatusMeta>> = {
  post: POST_STATUS,
  schedule: SCHEDULE_STATUS,
  client: CLIENT_STATUS,
  segment: SEGMENT,
  plan: PLAN,
  tier: TIER,
  account: ACCOUNT_STATUS,
  pending: PENDING_KIND,
  agencyPublishes: AGENCY_PUBLISHES,
};

/** Valor fora do mapa: nunca o valor cru (A-045). */
const UNKNOWN_STATUS: StatusMeta = { label: "Status desconhecido", tone: "neutral" };

/* Mapas estáticos de classes (H-03): o Tailwind só gera classes escritas por inteiro. */
const TONE_BADGE: Record<Tone, string> = {
  neutral: "bg-neutral-bg text-neutral-fg border-neutral-line",
  info: "bg-info-bg text-info-fg border-info-line",
  success: "bg-success-bg text-success-fg border-success-line",
  warning: "bg-warning-bg text-warning-fg border-warning-line",
  danger: "bg-danger-bg text-danger-fg border-danger-line",
  accent: "bg-brand-bg text-brand-fg border-brand-line", // tom "accent" do S05 → família brand-*
};
const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-neutral-solid",
  info: "bg-info-solid",
  success: "bg-success-solid",
  warning: "bg-warning-solid",
  danger: "bg-danger-solid",
  accent: "bg-brand-solid",
};
const STAGE_FILLED: Record<ProductionStage, string> = {
  sem_texto: "bg-stage-sem-texto-fill text-stage-sem-texto-on border-stage-sem-texto-solid",
  texto_ok: "bg-stage-texto-ok-fill text-stage-texto-ok-on border-stage-texto-ok-solid",
  em_aprovacao: "bg-stage-em-aprovacao-fill text-stage-em-aprovacao-on border-stage-em-aprovacao-solid",
  tema_aprovado: "bg-stage-tema-aprovado-fill text-stage-tema-aprovado-on border-stage-tema-aprovado-solid",
  post_aprovado: "bg-stage-post-aprovado-fill text-stage-post-aprovado-on border-stage-post-aprovado-solid",
};
const FORMAT_BADGE: Record<PostFormat, { badge: string; swatch: string }> = {
  feed: { badge: "bg-format-feed-bg text-format-feed-fg", swatch: "bg-format-feed" },
  carrossel: { badge: "bg-format-carrossel-bg text-format-carrossel-fg", swatch: "bg-format-carrossel" },
  reels: { badge: "bg-format-reels-bg text-format-reels-fg", swatch: "bg-format-reels" },
  story: { badge: "bg-format-story-bg text-format-story-fg", swatch: "bg-format-story" },
};

const BADGE_BASE = "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border font-medium";
const BADGE_SIZE = { sm: "h-6 px-2 text-xs", md: "h-7 px-2.5 text-sm" } as const;

function hasKey(map: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, key);
}

/** Só em dev, e uma vez por (kind, valor), para não repetir a cada render. */
const warnedUnknown = new Set<string>();

function warnUnknown(kind: StatusKind, status: string) {
  if (process.env.NODE_ENV === "production") return;
  const key = `${kind}:${status}`;
  if (warnedUnknown.has(key)) return;
  warnedUnknown.add(key);
  console.warn(`StatusBadge: valor desconhecido para kind="${kind}": ${JSON.stringify(status)}`);
}

/**
 * Badge de status com rótulo pt-BR e tom do lib/status-meta.
 * `kind` padrão "post"; sem `kind`, "active"/"inactive" continuam como status de
 * conta (compatível com os usos atuais). Valor desconhecido → "Status desconhecido".
 */
export function StatusBadge({
  status,
  kind,
  size = "sm",
  className = "",
}: {
  status: string;
  kind?: StatusKind;
  size?: "sm" | "md";
  className?: string;
}) {
  const resolved: StatusKind =
    kind ?? (!hasKey(POST_STATUS, status) && hasKey(ACCOUNT_STATUS, status) ? "account" : "post");

  if (resolved === "stage") {
    if (!hasKey(STAGE_META, status)) {
      warnUnknown(resolved, status);
      return <ToneBadge tone="neutral" size={size}>{UNKNOWN_STATUS.label}</ToneBadge>;
    }
    const stage = status as ProductionStage;
    const meta = STAGE_META[stage];
    return (
      <span className={`${BADGE_BASE} ${BADGE_SIZE[size]} ${TONE_BADGE.neutral} ${className}`}>
        <span
          aria-hidden="true"
          className={`inline-grid size-4 shrink-0 place-items-center rounded-chip border text-xs font-bold leading-none ${STAGE_FILLED[stage]}`}
        >
          {meta.letter}
        </span>
        {meta.label}
      </span>
    );
  }

  const map = STATUS_MAPS[resolved];
  const known = hasKey(map, status);
  if (!known) warnUnknown(resolved, status);
  const meta = known ? metaOf(map, status) : UNKNOWN_STATUS;
  return (
    <span className={`${BADGE_BASE} ${BADGE_SIZE[size]} ${TONE_BADGE[meta.tone]} ${className}`}>
      <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${TONE_DOT[meta.tone]}`} />
      {meta.label}
    </span>
  );
}

/** Badge com tom livre (ex.: "Só produção", contadores). O texto é sempre visível. */
export function ToneBadge({
  tone,
  children,
  icon,
  size = "sm",
  title,
}: {
  tone: Tone;
  children: React.ReactNode;
  icon?: React.ReactNode;
  size?: "sm" | "md";
  title?: string;
}) {
  return (
    <span title={title} className={`${BADGE_BASE} ${BADGE_SIZE[size]} ${TONE_BADGE[tone]}`}>
      {icon ? (
        <span aria-hidden="true" className="inline-flex size-3.5 shrink-0 [&>svg]:size-full">
          {icon}
        </span>
      ) : (
        <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${TONE_DOT[tone]}`} />
      )}
      {children}
    </span>
  );
}

/**
 * Formato do post com a cor do lib/formats (A-029). Com `kind` (posts.content_kind do pacote de
 * gestão) o rótulo vira o tipo — "Reels banco", "Banner animado", "Story exclusivo"… — na cor do formato.
 */
export function FormatBadge({
  format,
  kind,
  size = "sm",
}: {
  format: string;
  kind?: string | null;
  size?: "sm" | "md";
}) {
  const meta = formatMeta(format);
  const c = FORMAT_BADGE[meta.id];
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full font-medium ${BADGE_SIZE[size]} ${c.badge}`}>
      <span aria-hidden="true" className={`size-2 shrink-0 rounded-xs ${c.swatch}`} />
      {contentKindLabel(kind) ?? meta.label}
    </span>
  );
}

/** Estado vazio: o que está vazio + por quê + próxima ação (DESIGN e.9). */
export function EmptyState({
  title,
  description,
  action,
  icon,
  tone = "neutral",
  size = "page",
  headingLevel,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  /** padrão: ícone neutro (Icon.list) */
  icon?: React.ReactNode;
  /** padrão "neutral" */
  tone?: "neutral" | "error";
  /** padrão "page" (dentro de .card); "inline" = sem card */
  size?: "page" | "inline";
  /** sem ele: <p> (compatível); use 2 quando for o conteúdo principal */
  headingLevel?: 2 | 3;
}) {
  const Title = headingLevel === 2 ? "h2" : headingLevel === 3 ? "h3" : "p";
  return (
    <div className={size === "page" ? "card px-6 py-12 text-center" : "py-8 text-center"}>
      <div
        aria-hidden="true"
        className={`mx-auto mb-4 grid size-12 place-items-center rounded-card ${
          tone === "error" ? "bg-danger-bg text-danger-solid" : "bg-neutral-bg text-fg-muted"
        }`}
      >
        <span className="inline-flex size-6 [&>svg]:size-full">{icon ?? <Icon.list />}</span>
      </div>
      <Title className="text-base font-semibold text-fg">{title}</Title>
      {description && <p className="mx-auto mt-1 max-w-prose text-sm text-fg-muted">{description}</p>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}

/**
 * Selo da rede social (cores oficiais vêm do BrandIcons). Decorativo por padrão,
 * pois quase sempre acompanha o nome; `decorative={false}` dá nome acessível.
 */
export function PlatformChip({ platform, decorative = true }: { platform: string; decorative?: boolean }) {
  const label = BRAND[platform]?.label ?? platform;
  const a11y = decorative ? { "aria-hidden": true as const } : { role: "img", "aria-label": label };
  if (!BRAND[platform]) {
    return (
      <span
        {...a11y}
        title={label}
        className="inline-grid h-5.5 min-w-5.5 shrink-0 place-items-center rounded-chip bg-neutral-bg px-1 text-xs font-semibold leading-none text-neutral-fg"
      >
        {platform.slice(0, 2).toUpperCase()}
      </span>
    );
  }
  return (
    <span {...a11y} title={label} className="inline-flex shrink-0 overflow-hidden rounded-chip">
      <BrandBadge platform={platform} size={22} />
    </span>
  );
}
