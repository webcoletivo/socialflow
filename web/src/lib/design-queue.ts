/**
 * Fila de artes da equipe de design (página /design) — SÓ SERVIDOR (usa o Prisma).
 *
 * Quem entra: posts NÃO publicados (qualquer formato, story inclusive: a designer
 * também faz a arte do story) de clientes com status "ativo". "Arte feita" segue a
 * regra única de `hasArt` (lib/production.ts): marcada pela designer
 * (Post.artDoneAt), com mídia ou publicada.
 *
 * Atraso: arte a fazer com a data do post já passada ou a menos de 48 h.
 * Ordem: atrasados primeiro; depois data do post crescente (empate: id).
 *
 * Consultas: no máximo 3, qualquer que seja o tamanho da fila (sem N+1):
 *   1) clientes ativos (opções de filtro + designer + plano);
 *   2) posts candidatos dos clientes filtrados;
 *   3) numeração do mês no Drive (todos os posts dos clientes/meses da fila, qualquer status).
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { buildMonthFileNames, drivePathLabel, type MonthFileName } from "@/lib/drive-layout";
import { spDateFromKey, spDateKey } from "@/lib/deadlines";
import {
  artStatus,
  effectiveCaption,
  productionStage,
  type ArtStatus,
  type ProductionStage,
} from "@/lib/production";

// a regra da arte é pura e mora em lib/production.ts (componentes de cliente importam de lá)
export { artStatus, hasArt } from "@/lib/production";
export type { ArtStatus } from "@/lib/production";

/** Arte a fazer a menos disto do horário do post = atrasada. */
export const DESIGN_LATE_MS = 48 * 60 * 60 * 1000;

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export type DesignQueueInclude = "a_fazer" | "feitas" | "todas";

export type DesignQueueOptions = {
  /** usuária da sessão: marca `mine` nos posts dos clientes em que ela é a designer */
  userId?: string | null;
  /** designer do cliente: id = só os clientes dela; null = só clientes SEM designer; omitido = todos */
  designerId?: string | null;
  /** só este cliente */
  clientId?: string | null;
  /** "AAAA-MM": mês civil (São Paulo) da data do post; omitido = todos os meses. Formato inválido → RangeError */
  month?: string | null;
  /** quais artes devolver em `items` (padrão "a_fazer"); `counts` sempre considera todas */
  include?: DesignQueueInclude;
  /** relógio (testes) */
  now?: Date;
};

export type UserRef = { id: string; name: string };

/** Por que a arte conta como feita (null = a fazer). "marcada" é a única que a designer pode desmarcar. */
export type ArtSource = "marcada" | "midia" | "publicado" | null;

export type DesignQueueItem = {
  id: string;
  theme: string | null;
  /** feed | story | carrossel | reels */
  format: string;
  /** tipo do conteúdo no pacote de gestão (posts.content_kind); ausente = sem tipo */
  contentKind?: string;
  scheduledAt: Date;
  /** status do post: draft | scheduled | publishing | failed (published nunca entra) */
  status: string;
  client: { id: string; name: string };
  /** designer efetiva = designer do cliente */
  designer: UserRef | null;
  /** o cliente é da usuária `userId` */
  mine: boolean;
  /** estágio de produção (texto), o mesmo do Quadro */
  stage: ProductionStage;
  artStatus: ArtStatus;
  artSource: ArtSource;
  /** marcado pela designer (Post.artDoneAt); pode existir junto com mídia */
  artDoneAt: Date | null;
  artDoneBy: UserRef | null;
  /** tem mediaUrl ou mediaItems */
  hasMedia: boolean;
  /** a fazer e a data já passou ou falta menos de 48 h */
  late: boolean;
  /** arte esperada no Drive (convenção de docs/08): null se o post não tiver numeração */
  drive: {
    /** "4.jpg", "4story2.jpg", "5.mp4" ou "3/" (pasta do carrossel) */
    file: string;
    /** "Cliente/2026/10 - Outubro/4story2.jpg" */
    path: string;
    /** N do post no mês */
    index: number;
    /** 1, 2, 3… para story; null para post principal */
    storyOrdinal: number | null;
  } | null;
};

export type DesignQueueResult = {
  items: DesignQueueItem[];
  /** sobre TODOS os posts filtrados (independe de `include`) */
  counts: { aFazer: number; feitas: number; atrasadas: number; total: number };
  /** designers dos clientes ativos (para o filtro), em ordem alfabética */
  designers: UserRef[];
  /** clientes ativos (para o filtro), em ordem alfabética */
  clients: { id: string; name: string; designer: UserRef | null }[];
};

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" });

function nextMonthKey(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

function hasMediaOf(p: { mediaUrl: string | null; mediaItems: unknown }): boolean {
  return (
    (typeof p.mediaUrl === "string" && p.mediaUrl.trim() !== "") ||
    (Array.isArray(p.mediaItems) && p.mediaItems.length > 0)
  );
}

/** Nome do arquivo esperado no Drive para o formato (mesma convenção da revisão do calendário). */
function driveFileName(format: string, name: MonthFileName): string {
  if (format === "story") return `${name.fileStem}.jpg`;
  if (format === "carrossel") return `${name.index}/`;
  if (format === "reels") return `${name.index}.mp4`;
  return `${name.index}.jpg`;
}

/**
 * O post está atrasado na fila de artes? Só arte A FAZER: data já passada ou a
 * menos de 48 h de `now`.
 */
export function isArtLate(status: ArtStatus, scheduledAt: Date | string, now: Date): boolean {
  if (status !== "a_fazer") return false;
  const at = typeof scheduledAt === "string" ? new Date(scheduledAt) : scheduledAt;
  return at.getTime() - now.getTime() < DESIGN_LATE_MS;
}

/** Ordem da fila: atrasados primeiro; depois data crescente; empate pelo id. */
export function compareDesignItems(
  a: Pick<DesignQueueItem, "late" | "scheduledAt" | "id">,
  b: Pick<DesignQueueItem, "late" | "scheduledAt" | "id">
): number {
  if (a.late !== b.late) return a.late ? -1 : 1;
  const diff = a.scheduledAt.getTime() - b.scheduledAt.getTime();
  if (diff !== 0) return diff;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Fila de artes. Ver `DesignQueueOptions` e `DesignQueueResult`. */
export async function loadDesignQueue(options: DesignQueueOptions = {}): Promise<DesignQueueResult> {
  const { userId = null, designerId, clientId, month, include = "a_fazer" } = options;
  const now = options.now ?? new Date();
  if (month != null && !MONTH_RE.test(month)) {
    throw new RangeError(`month inválido (esperado AAAA-MM): ${month}`);
  }

  // ---- Consulta 1/3: clientes ativos (também alimentam os filtros)
  const activeClients = await prisma.client.findMany({
    where: { status: "ativo" },
    select: { id: true, name: true, plan: true, designer: { select: { id: true, name: true } } },
  });
  activeClients.sort(byName);

  const designerMap = new Map<string, UserRef>();
  for (const c of activeClients) if (c.designer) designerMap.set(c.designer.id, c.designer);

  const result: DesignQueueResult = {
    items: [],
    counts: { aFazer: 0, feitas: 0, atrasadas: 0, total: 0 },
    designers: [...designerMap.values()].sort(byName),
    clients: activeClients.map((c) => ({ id: c.id, name: c.name, designer: c.designer })),
  };

  const clients = activeClients.filter(
    (c) =>
      (!clientId || c.id.toLowerCase() === clientId.toLowerCase()) &&
      (designerId === undefined || (designerId === null ? !c.designer : c.designer?.id === designerId))
  );
  if (clients.length === 0) return result;
  const clientById = new Map(clients.map((c) => [c.id, c]));

  // ---- Consulta 2/3: posts candidatos (não publicados) dos clientes filtrados
  const where: Prisma.PostWhereInput = {
    clientId: { in: clients.map((c) => c.id) },
    status: { not: "published" },
  };
  if (month) where.scheduledAt = { gte: spDateFromKey(`${month}-01`), lt: spDateFromKey(`${nextMonthKey(month)}-01`) };
  const posts = await prisma.post.findMany({
    where,
    orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      clientId: true,
      theme: true,
      format: true,
      contentKind: true,
      scheduledAt: true,
      status: true,
      caption: true,
      captions: true,
      slides: true,
      mediaUrl: true,
      mediaItems: true,
      clientApproval: true,
      weeklyReviewId: true,
      artDoneAt: true,
      artDoneByUser: { select: { id: true, name: true } },
      schedule: { select: { status: true } },
    },
  });

  const items: DesignQueueItem[] = [];
  for (const p of posts) {
    const client = clientById.get(p.clientId);
    if (!client) continue;
    const hasMedia = hasMediaOf(p);
    const status = artStatus(p);
    const artSource: ArtSource = p.artDoneAt ? "marcada" : hasMedia ? "midia" : status === "feita" ? "publicado" : null;
    const late = isArtLate(status, p.scheduledAt, now);

    result.counts.total += 1;
    if (status === "feita") result.counts.feitas += 1;
    else result.counts.aFazer += 1;
    if (late) result.counts.atrasadas += 1;

    if (include === "a_fazer" && status !== "a_fazer") continue;
    if (include === "feitas" && status !== "feita") continue;

    items.push({
      id: p.id,
      theme: p.theme,
      format: p.format,
      ...(p.contentKind ? { contentKind: p.contentKind } : {}),
      scheduledAt: p.scheduledAt,
      status: p.status,
      client: { id: client.id, name: client.name },
      designer: client.designer,
      mine: !!userId && client.designer?.id === userId,
      stage: productionStage({
        caption: effectiveCaption(p),
        slides: p.slides,
        schedule: p.schedule,
        plan: client.plan,
        weeklyReviewId: p.weeklyReviewId,
        clientApproval: p.clientApproval,
      }),
      artStatus: status,
      artSource,
      artDoneAt: p.artDoneAt,
      artDoneBy: p.artDoneByUser,
      hasMedia,
      late,
      drive: null,
    });
  }

  if (items.length > 0) await attachDriveNames(items);

  items.sort(compareDesignItems);
  result.items = items;
  return result;
}

/**
 * ---- Consulta 3/3: numeração do mês (regra de `buildMonthFileNames`: TODOS os posts do
 * cliente no mês, de qualquer status, em ordem de data; empate: createdAt, depois id).
 */
async function attachDriveNames(items: DesignQueueItem[]): Promise<void> {
  const monthOf = (d: Date) => spDateKey(d).slice(0, 7);
  const groupsNeeded = new Set(items.map((i) => `${i.client.id}|${monthOf(i.scheduledAt)}`));
  const months = [...new Set(items.map((i) => monthOf(i.scheduledAt)))].sort();
  const clientIds = [...new Set(items.map((i) => i.client.id))];

  const monthPosts = await prisma.post.findMany({
    where: {
      clientId: { in: clientIds },
      scheduledAt: {
        gte: spDateFromKey(`${months[0]}-01`),
        lt: spDateFromKey(`${nextMonthKey(months[months.length - 1])}-01`),
      },
    },
    orderBy: [{ scheduledAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true, clientId: true, format: true, scheduledAt: true },
  });

  const groups = new Map<string, { id: string; format: string }[]>();
  for (const p of monthPosts) {
    const key = `${p.clientId}|${monthOf(p.scheduledAt)}`;
    if (!groupsNeeded.has(key)) continue;
    const list = groups.get(key);
    if (list) list.push(p);
    else groups.set(key, [p]);
  }
  const names = new Map<string, MonthFileName>();
  for (const list of groups.values()) {
    for (const [id, name] of buildMonthFileNames(list)) names.set(id, name);
  }

  for (const item of items) {
    const name = names.get(item.id);
    if (!name) continue;
    const [y, m] = monthOf(item.scheduledAt).split("-").map(Number);
    const file = driveFileName(item.format, name);
    item.drive = {
      file,
      path: drivePathLabel(item.client.name, y, m, file, null),
      index: name.index,
      storyOrdinal: name.storyOrdinal,
    };
  }
}
