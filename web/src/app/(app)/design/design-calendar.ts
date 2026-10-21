/**
 * Calendário da página /design (`?ver=calendario`): grade cliente × dia no espírito da
 * planilha "Controle de Gestão". Cada post é um marcador de duas metades, como as duas
 * subcolunas de cada dia da planilha:
 *   - ARTE: feita ("Arte ok", roxo), a fazer ou captação (reels gravado ainda sem arte);
 *   - POSTAGEM: postada, agendada, aguardando aprovação, a postar ou falhou.
 * Clientes com aprovação ficam numa seção no topo ("fazer primeiro"), como na planilha.
 * Lógica pura (sem React, sem Prisma): serve ao componente e aos testes
 * (tests/unit/design-calendar.test.ts).
 */
import { contentKindLabel } from "../../../lib/content-packages.ts";
import { formatMeta } from "../../../lib/formats.ts";
import { whenParts, type DesignRow, type UserRef } from "./design-view.ts";

export type CalendarClient = {
  id: string;
  name: string;
  designer: UserRef | null;
  withApproval: boolean;
  agencyPublishes: boolean;
};

export type ArtCell = "feita" | "a_fazer" | "captacao";
export type PostState = "publicado" | "agendado" | "aguardando" | "a_postar" | "falhou";

export const ART_LABEL: Record<ArtCell, string> = {
  feita: "Arte ok",
  a_fazer: "Arte a fazer",
  captacao: "Captação",
};

export const POST_LABEL: Record<PostState, string> = {
  publicado: "Postado",
  agendado: "Agendado",
  aguardando: "Aguardando aprovação",
  a_postar: "A postar",
  falhou: "Falhou ao publicar",
};

/** Metade da arte: feita pela regra única; a fazer de reels gravado = captação. */
export function artCellOf(row: Pick<DesignRow, "artStatus" | "contentKind">): ArtCell {
  if (row.artStatus === "feita") return "feita";
  return row.contentKind === "reels_gravado" ? "captacao" : "a_fazer";
}

/**
 * Metade da postagem: publicado / falhou / agendado pelo status do post; sem isso, cliente
 * com aprovação cujo post ainda não foi aprovado = aguardando aprovação; o resto = a postar.
 */
export function postStateOf(row: Pick<DesignRow, "status" | "stage">, withApproval: boolean): PostState {
  if (row.status === "published") return "publicado";
  if (row.status === "failed") return "falhou";
  if (row.status === "scheduled" || row.status === "publishing") return "agendado";
  if (withApproval && row.stage !== "post_aprovado") return "aguardando";
  return "a_postar";
}

export type CalendarMarker = {
  row: DesignRow;
  day: number;
  art: ArtCell;
  post: PostState;
  ariaLabel: string;
};

export type CalendarRow = {
  client: CalendarClient;
  /** dia do mês → marcadores na ordem de scheduledAt */
  days: Map<number, CalendarMarker[]>;
  total: number;
  artDone: number;
};

export type CalendarSection = {
  key: "aprovacao" | "sem_aprovacao";
  title: string;
  rows: CalendarRow[];
};

export type CalendarCounts = {
  total: number;
  artFeita: number;
  artAFazer: number;
  atrasadas: number;
  postados: number;
  aguardando: number;
};

export type CalendarDay = {
  day: number;
  /** "seg", "ter"… */
  weekday: string;
  /** "segunda-feira"… */
  weekdayFull: string;
  weekend: boolean;
  today: boolean;
  /** coluna até onde a grade rola ao abrir o mês atual ("hoje" − 2) */
  scrollAnchor: boolean;
};

export type CalendarModel = {
  days: CalendarDay[];
  sections: CalendarSection[];
  counts: CalendarCounts;
};

const WEEKDAY = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const WEEKDAY_FULL = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];

/** Colunas do mês "AAAA-MM"; `todayKey` ("AAAA-MM-DD", SP) marca hoje e a âncora de rolagem. */
export function monthDays(month: string, todayKey: string): CalendarDay[] {
  const [year, m] = month.split("-").map(Number);
  const todayDay = todayKey.slice(0, 7) === month ? Number(todayKey.slice(8, 10)) : null;
  const count = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => {
    const day = i + 1;
    const wd = new Date(Date.UTC(year, m - 1, day)).getUTCDay();
    return {
      day,
      weekday: WEEKDAY[wd],
      weekdayFull: WEEKDAY_FULL[wd],
      weekend: wd === 0 || wd === 6,
      today: day === todayDay,
      scrollAnchor: todayDay !== null && day === Math.max(1, todayDay - 2),
    };
  });
}

/** Tipo do conteúdo (pacote) ou formato: "Reels gravado", "Feed"… */
export function kindLabel(row: Pick<DesignRow, "format" | "contentKind">): string {
  return contentKindLabel(row.contentKind) ?? formatMeta(row.format).label;
}

function markerLabel(row: DesignRow, art: ArtCell, post: PostState): string {
  const w = whenParts(row.scheduledAt);
  const parts = [
    row.client.name,
    `${w.date} às ${w.time}`,
    kindLabel(row),
    row.theme?.trim() || "Post sem tema",
    ART_LABEL[art],
  ];
  if (row.late) parts.push("arte atrasada");
  parts.push(POST_LABEL[post]);
  return parts.join(", ");
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" });

/**
 * Monta as seções do calendário. Todos os `clients` viram linha (mesmo sem post no mês);
 * posts de outro mês ou de cliente fora da lista ficam de fora. Seção vazia não aparece.
 */
export function buildCalendar(input: {
  /** "AAAA-MM" */
  month: string;
  todayKey: string;
  clients: CalendarClient[];
  rows: DesignRow[];
}): CalendarModel {
  const counts: CalendarCounts = { total: 0, artFeita: 0, artAFazer: 0, atrasadas: 0, postados: 0, aguardando: 0 };
  const byClient = new Map<string, CalendarRow>(
    [...input.clients].sort(byName).map((c) => [c.id, { client: c, days: new Map(), total: 0, artDone: 0 }]),
  );

  const ordered = [...input.rows].sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  for (const row of ordered) {
    const line = byClient.get(row.client.id);
    if (!line) continue;
    const { dayKey } = whenParts(row.scheduledAt);
    if (dayKey.slice(0, 7) !== input.month) continue;
    const day = Number(dayKey.slice(8, 10));
    const art = artCellOf(row);
    const post = postStateOf(row, line.client.withApproval);
    const marker: CalendarMarker = { row, day, art, post, ariaLabel: markerLabel(row, art, post) };
    line.days.set(day, [...(line.days.get(day) ?? []), marker]);
    line.total += 1;
    counts.total += 1;
    if (art === "feita") {
      line.artDone += 1;
      counts.artFeita += 1;
    } else counts.artAFazer += 1;
    if (row.late) counts.atrasadas += 1;
    if (post === "publicado") counts.postados += 1;
    if (post === "aguardando") counts.aguardando += 1;
  }

  const lines = [...byClient.values()];
  const sections: CalendarSection[] = [
    { key: "aprovacao" as const, title: "Com aprovação · fazer primeiro", rows: lines.filter((l) => l.client.withApproval) },
    { key: "sem_aprovacao" as const, title: "Sem aprovação", rows: lines.filter((l) => !l.client.withApproval) },
  ].filter((s) => s.rows.length > 0);

  return { days: monthDays(input.month, input.todayKey), sections, counts };
}
