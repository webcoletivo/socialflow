/**
 * Lógica pura da página /design (fila de artes): filtros da URL, agrupamento por
 * dia, textos de data e o estado otimista de "marcar como feita". Sem React, sem
 * Prisma: serve ao componente de servidor, ao de cliente e aos testes
 * (tests/unit/design-view.test.ts).
 */
import { addDaysToKey, spDateKey } from "../../../lib/deadlines.ts";
import type { ProductionStage } from "../../../lib/production.ts";

/* ------------------------------------------------------------------ *
 * Tipos
 * ------------------------------------------------------------------ */

export type UserRef = { id: string; name: string };

/** O que a lista mostra (`?mostrar=`). */
export type DesignShow = "a_fazer" | "feitas" | "todas";
export const DESIGN_SHOWS: readonly DesignShow[] = ["a_fazer", "feitas", "todas"];
export const DESIGN_SHOW_OPTIONS: readonly { value: DesignShow; label: string }[] = [
  { value: "a_fazer", label: "A fazer" },
  { value: "feitas", label: "Feitas" },
  { value: "todas", label: "Todas" },
];

/** Como a página mostra os posts (`?ver=`): fila agrupada por dia ou calendário cliente × dia. */
export type DesignView = "lista" | "calendario";
export const DESIGN_VIEWS: readonly DesignView[] = ["lista", "calendario"];
export const DESIGN_VIEW_OPTIONS: readonly { value: DesignView; label: string }[] = [
  { value: "lista", label: "Lista" },
  { value: "calendario", label: "Calendário" },
];

/** Filtro de designer: todas as designers. */
export const DESIGNER_ALL = "todos";
/** Filtro de designer: clientes sem designer. */
export const DESIGNER_NONE = "sem";

/** Filtros já validados ("" = sem filtro de cliente). `designer` = DESIGNER_ALL | DESIGNER_NONE | id. */
export type DesignFilterValues = {
  /** "AAAA-MM" */
  mes: string;
  designer: string;
  cliente: string;
  mostrar: DesignShow;
  /** no calendário, "mostrar" não se aplica (todos os posts do mês aparecem) */
  ver: DesignView;
};

export type ArtSource = "marcada" | "midia" | "publicado" | null;

/** Item da fila como chega ao componente de cliente (datas em ISO). */
export type DesignRow = {
  id: string;
  theme: string | null;
  format: string;
  /** tipo do conteúdo no pacote de gestão (posts.content_kind) */
  contentKind?: string;
  /** ISO */
  scheduledAt: string;
  status: string;
  client: { id: string; name: string };
  designer: UserRef | null;
  mine: boolean;
  stage: ProductionStage;
  artStatus: "feita" | "a_fazer";
  artSource: ArtSource;
  /** ISO */
  artDoneAt: string | null;
  artDoneBy: UserRef | null;
  /** ISO: marcado como postado à mão (calendário); null = não (ou publicado pelo sistema) */
  postedAt?: string | null;
  postedBy?: UserRef | null;
  hasMedia: boolean;
  late: boolean;
  drive: { file: string; path: string } | null;
};

export type DesignCounts = { aFazer: number; feitas: number; atrasadas: number; total: number };

/** Mudança otimista da arte de um item (enquanto o servidor não devolve a lista nova). */
export type ArtOverride = { done: boolean; artDoneAt: string | null; artDoneBy: UserRef | null };

/* ------------------------------------------------------------------ *
 * Filtros na URL
 * ------------------------------------------------------------------ */

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

type RawParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

/** Padrão do filtro de designer: "Minhas" (o id da usuária) se ela é designer de algum cliente ativo; senão todas. */
export function defaultDesignerFor(userId: string | null, designerIds: ReadonlySet<string>): string {
  return userId && designerIds.has(userId) ? userId : DESIGNER_ALL;
}

/**
 * Lê `mes`, `designer`, `cliente`, `mostrar` e `ver`. Valor inválido ou desconhecido é ignorado
 * (volta ao padrão), como no Quadro de Produção.
 */
export function parseDesignParams(
  sp: RawParams,
  ctx: {
    /** "AAAA-MM" do mês atual (SP) */
    currentMonth: string;
    defaultDesigner: string;
    designerIds: ReadonlySet<string>;
    clientIds: ReadonlySet<string>;
  },
): DesignFilterValues {
  const mes = first(sp.mes);
  const designer = first(sp.designer);
  const cliente = first(sp.cliente);
  const mostrar = first(sp.mostrar);
  const ver = first(sp.ver);
  return {
    mes: MONTH_RE.test(mes) ? mes : ctx.currentMonth,
    designer:
      designer === DESIGNER_ALL || designer === DESIGNER_NONE || ctx.designerIds.has(designer)
        ? designer
        : ctx.defaultDesigner,
    cliente: ctx.clientIds.has(cliente) ? cliente : "",
    mostrar: (DESIGN_SHOWS as readonly string[]).includes(mostrar) ? (mostrar as DesignShow) : "a_fazer",
    ver: (DESIGN_VIEWS as readonly string[]).includes(ver) ? (ver as DesignView) : "lista",
  };
}

/** Valor do filtro → opção `designerId` de `loadDesignQueue` (omitido = todas; null = sem designer). */
export function designerIdOption(designer: string): string | null | undefined {
  if (designer === DESIGNER_ALL) return undefined;
  if (designer === DESIGNER_NONE) return null;
  return designer;
}

/** URL da página com os filtros; o que está no padrão fica de fora (mês sempre vai). */
export function designHref(v: DesignFilterValues, defaultDesigner: string): string {
  const params = new URLSearchParams();
  params.set("mes", v.mes);
  if (v.designer !== defaultDesigner) params.set("designer", v.designer);
  if (v.cliente) params.set("cliente", v.cliente);
  if (v.mostrar !== "a_fazer") params.set("mostrar", v.mostrar);
  if (v.ver !== "lista") params.set("ver", v.ver);
  return `/design?${params}`;
}

/** Quantos filtros do diálogo (designer, cliente) estão fora do padrão. */
export function activeFilterCount(v: DesignFilterValues, defaultDesigner: string): number {
  return (v.designer !== defaultDesigner ? 1 : 0) + (v.cliente ? 1 : 0);
}

export function shiftMonth(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ *
 * Datas (fuso SP)
 * ------------------------------------------------------------------ */

const TZ = "America/Sao_Paulo";
const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const WEEKDAYS_SHORT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const HOUR_MINUTE = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function weekdayOfKey(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** "08/10" de uma chave "AAAA-MM-DD". */
export function dayMonthOfKey(key: string): string {
  return `${key.slice(8, 10)}/${key.slice(5, 7)}`;
}

/** "quarta, 08/10" de uma chave "AAAA-MM-DD". */
export function weekdayDateOfKey(key: string): string {
  return `${WEEKDAYS[weekdayOfKey(key)]}, ${dayMonthOfKey(key)}`;
}

/** Partes de um instante no fuso SP: chave do dia, "08/10", "18:00", "quinta" e "qui". */
export function whenParts(iso: string): {
  dayKey: string;
  date: string;
  time: string;
  weekday: string;
  weekdayShort: string;
} {
  const d = new Date(iso);
  const dayKey = spDateKey(d);
  const parts = Object.fromEntries(HOUR_MINUTE.formatToParts(d).map((p) => [p.type, p.value]));
  const hour = parts.hour === "24" ? "00" : parts.hour;
  const wd = weekdayOfKey(dayKey);
  return {
    dayKey,
    date: dayMonthOfKey(dayKey),
    time: `${hour}:${parts.minute}`,
    weekday: WEEKDAYS[wd],
    weekdayShort: WEEKDAYS_SHORT[wd],
  };
}

/** "Hoje", "Amanhã", "Ontem" ou null (outro dia). */
export function relativeDayLabel(dayKey: string, todayKey: string): string | null {
  if (dayKey === todayKey) return "Hoje";
  if (dayKey === addDaysToKey(todayKey, 1)) return "Amanhã";
  if (dayKey === addDaysToKey(todayKey, -1)) return "Ontem";
  return null;
}

/** Arte a fazer a menos disto do horário do post = atrasada (mesma regra de lib/design-queue). */
export const LATE_MS = 48 * 60 * 60 * 1000;

export function isLateAt(scheduledAtIso: string, nowMs: number): boolean {
  return Date.parse(scheduledAtIso) - nowMs < LATE_MS;
}

/** Texto do atraso (depois de "Atrasada · "): "já passou", "publica em 20 h" ou "publica em menos de 1 h". */
export function lateText(scheduledAtIso: string, nowMs: number): string {
  const diff = Date.parse(scheduledAtIso) - nowMs;
  if (diff <= 0) return "já passou";
  const hours = Math.ceil(diff / 3_600_000);
  return hours <= 1 ? "publica em menos de 1 h" : `publica em ${hours} h`;
}

/** "06/10 às 15:40" no fuso SP (quem marcou e quando). */
export function doneWhenText(iso: string): string {
  const w = whenParts(iso);
  return `${w.date} às ${w.time}`;
}

/* ------------------------------------------------------------------ *
 * Estado otimista e agrupamento
 * ------------------------------------------------------------------ */

/** O item com a mudança otimista aplicada (status, origem, quem/quando e atraso). */
export function applyOverride(row: DesignRow, o: ArtOverride | undefined, nowMs: number): DesignRow {
  if (!o) return row;
  if (o.done) {
    return { ...row, artStatus: "feita", artSource: "marcada", artDoneAt: o.artDoneAt, artDoneBy: o.artDoneBy, late: false };
  }
  // desmarcada: continua feita se o post tem mídia; senão volta para "a fazer"
  if (row.hasMedia) return { ...row, artStatus: "feita", artSource: "midia", artDoneAt: null, artDoneBy: null, late: false };
  return {
    ...row,
    artStatus: "a_fazer",
    artSource: null,
    artDoneAt: null,
    artDoneBy: null,
    late: isLateAt(row.scheduledAt, nowMs),
  };
}

/** Contagens do servidor corrigidas pelas mudanças otimistas (`effective[i]` corresponde a `rows[i]`). */
export function adjustCounts(counts: DesignCounts, rows: DesignRow[], effective: DesignRow[]): DesignCounts {
  const next = { ...counts };
  rows.forEach((row, i) => {
    const eff = effective[i];
    if (eff === row) return;
    const was = row.artStatus === "a_fazer" ? 1 : 0;
    const is = eff.artStatus === "a_fazer" ? 1 : 0;
    next.aFazer += is - was;
    next.feitas += was - is;
    next.atrasadas += (eff.late ? 1 : 0) - (row.late ? 1 : 0);
  });
  return next;
}

/** Entra na lista com o filtro "mostrar"? */
export function matchesShow(row: DesignRow, show: DesignShow): boolean {
  if (show === "a_fazer") return row.artStatus === "a_fazer";
  if (show === "feitas") return row.artStatus === "feita";
  return true;
}

/** Ordem da fila: atrasadas primeiro; depois data crescente; empate pelo id (igual a lib/design-queue). */
export function compareRows(a: DesignRow, b: DesignRow): number {
  if (a.late !== b.late) return a.late ? -1 : 1;
  const diff = Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt);
  if (diff !== 0) return diff;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export type DayGroup = {
  /** "atrasadas" ou "AAAA-MM-DD" */
  key: string;
  /** "Atrasadas", "Hoje", "Amanhã", "Ontem" ou "Quarta, 08/10" */
  title: string;
  /** "terça, 06/10" ao lado de Hoje/Amanhã/Ontem; null nos demais */
  detail: string | null;
  late: boolean;
  items: DesignRow[];
};

function upperFirst(s: string): string {
  return s ? s.charAt(0).toLocaleUpperCase("pt-BR") + s.slice(1) : s;
}

/** Agrupa a lista já ordenada: atrasadas num grupo próprio no topo; o resto por dia (SP), na ordem de chegada. */
export function groupByDay(rows: DesignRow[], todayKey: string): DayGroup[] {
  const groups: DayGroup[] = [];
  const byKey = new Map<string, DayGroup>();
  for (const row of rows) {
    const key = row.late ? "atrasadas" : spDateKey(new Date(row.scheduledAt));
    let group = byKey.get(key);
    if (!group) {
      const relative = row.late ? null : relativeDayLabel(key, todayKey);
      group = row.late
        ? { key, title: "Atrasadas", detail: null, late: true, items: [] }
        : {
            key,
            title: relative ?? upperFirst(weekdayDateOfKey(key)),
            detail: relative ? weekdayDateOfKey(key) : null,
            late: false,
            items: [],
          };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push(row);
  }
  // o grupo de atrasadas sempre no topo, mesmo que a ordem de chegada mude
  return groups.sort((a, b) => Number(b.late) - Number(a.late));
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "3 artes atrasadas — publicação em menos de 48 h ou já passou" */
export function lateWarning(n: number): string {
  return `${plural(n, "arte atrasada", "artes atrasadas")} — publicação em menos de 48 h ou já passou`;
}
