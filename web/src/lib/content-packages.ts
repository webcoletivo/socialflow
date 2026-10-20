/**
 * Pacotes de gestão (puro) — pedido do usuário em 20/10. 1 ciclo = 1 mês.
 *
 *   Gestão 1            12 posts, sem reels; carrosséis pela frequência do cliente, o resto estático.
 *   Gestão 2            12 posts: 3 reels de banco de imagens (1 por semana no dia escolhido),
 *                       1 banner animado, carrosséis pela frequência, o resto estático.
 *   Gestão 3 (Stories)  feed: 4 estáticos + 4 reels (1 por semana no dia escolhido);
 *                       stories: 20 = 8 réplicas do feed (story junto) + 12 exclusivos em
 *                       09:00 / 14:00 / 19:00 (manhã, tarde e noite), em dias úteis.
 *   Gestão Reels        4 reels gravados + 3 reels de banco de imagens + 1 banner animado; os reels
 *                       vão no dia escolhido (1 por semana) e os excedentes em outros dias úteis.
 *
 * O SISTEMA monta os slots do mês (data, hora, formato, tipo); a IA só cria tema + explicação
 * para cada slot (POST /api/ai/calendar). Cliente "completa" (antigo, sem pacote) e "basica"
 * não usam este módulo: o comportamento deles não muda.
 */

// ------------------------------------------------------------ pacotes

export const PACKAGE_TIERS = ["gestao_1", "gestao_2", "gestao_3_stories", "gestao_reels"] as const;
export type PackageTier = (typeof PACKAGE_TIERS)[number];

export function isPackageTier(tier: string | null | undefined): tier is PackageTier {
  return (PACKAGE_TIERS as readonly string[]).includes(tier ?? "");
}

export type PackageMeta = {
  label: string;
  /** texto curto do cadastro */
  description: string;
  hasCarousel: boolean;
  hasReels: boolean;
};

export const PACKAGE: Record<PackageTier, PackageMeta> = {
  gestao_1: {
    label: "Gestão 1",
    description: "12 posts por mês, sem reels. Carrosséis conforme a frequência escolhida; o resto estático.",
    hasCarousel: true,
    hasReels: false,
  },
  gestao_2: {
    label: "Gestão 2",
    description:
      "12 posts por mês: 3 reels de banco de imagens (1 por semana), 1 banner animado, carrosséis e estáticos.",
    hasCarousel: true,
    hasReels: true,
  },
  gestao_3_stories: {
    label: "Gestão 3 (Stories)",
    description:
      "Feed: 4 estáticos e 4 reels por mês. Stories: 20 por mês (8 réplicas do feed e 12 exclusivos), de manhã, à tarde e à noite.",
    hasCarousel: false,
    hasReels: true,
  },
  gestao_reels: {
    label: "Gestão Reels",
    description: "Por mês: 4 reels gravados, 3 reels de banco de imagens e 1 banner animado.",
    hasCarousel: false,
    hasReels: true,
  },
};

export const CAROUSEL_FREQUENCIES = ["semanal", "quinzenal"] as const;
export type CarouselFrequency = (typeof CAROUSEL_FREQUENCIES)[number];
export const DEFAULT_CAROUSEL_FREQUENCY: CarouselFrequency = "quinzenal";
export const CAROUSEL_FREQUENCY_LABEL: Record<CarouselFrequency, string> = {
  semanal: "1 por semana",
  quinzenal: "1 a cada 15 dias",
};

/** 1–5 = segunda a sexta (o mesmo número de Date#getUTCDay). */
export const REELS_WEEKDAYS = [1, 2, 3, 4, 5] as const;
export type ReelsWeekday = (typeof REELS_WEEKDAYS)[number];
export const DEFAULT_REELS_WEEKDAY: ReelsWeekday = 3;
export const WEEKDAY_LABEL: Record<ReelsWeekday, string> = {
  1: "Segunda",
  2: "Terça",
  3: "Quarta",
  4: "Quinta",
  5: "Sexta",
};
const WEEKDAY_SHORT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

export function isReelsWeekday(n: unknown): n is ReelsWeekday {
  return typeof n === "number" && (REELS_WEEKDAYS as readonly number[]).includes(n);
}

/**
 * Campos do pacote coerentes com o tier: sem reels → reelsWeekday null; com reels e sem dia →
 * quarta. A frequência de carrossel fica gravada mesmo quando o pacote não tem carrossel.
 */
export function normalizePackageFields(
  tier: string,
  reelsWeekday: number | null | undefined
): { reelsWeekday: ReelsWeekday | null } {
  if (!isPackageTier(tier) || !PACKAGE[tier].hasReels) return { reelsWeekday: null };
  return { reelsWeekday: isReelsWeekday(reelsWeekday) ? reelsWeekday : DEFAULT_REELS_WEEKDAY };
}

// ------------------------------------------------------------ tipos de conteúdo (posts.content_kind)

export const CONTENT_KINDS = [
  "estatico",
  "carrossel",
  "reels",
  "reels_gravado",
  "reels_banco",
  "banner_animado",
  "story_exclusivo",
  "story_replica",
] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

export function isContentKind(v: unknown): v is ContentKind {
  return typeof v === "string" && (CONTENT_KINDS as readonly string[]).includes(v);
}

type KindFormat = "feed" | "carrossel" | "reels" | "story";

export const CONTENT_KIND: Record<ContentKind, { label: string; format: KindFormat; prompt: string }> = {
  estatico: {
    label: "Estático",
    format: "feed",
    prompt: "post ESTÁTICO de feed (uma arte única)",
  },
  carrossel: {
    label: "Carrossel",
    format: "carrossel",
    prompt: "CARROSSEL de feed (várias telas contando uma história ou um passo a passo)",
  },
  reels: {
    label: "Reels",
    format: "reels",
    prompt: "REELS (vídeo curto vertical)",
  },
  reels_gravado: {
    label: "Reels gravado",
    format: "reels",
    prompt:
      "REELS GRAVADO pelo cliente (vídeo com pessoas e o espaço reais do negócio: bastidores, depoimento, demonstração) — a ideia precisa ser fácil de gravar",
  },
  reels_banco: {
    label: "Reels banco",
    format: "reels",
    prompt: "REELS DE BANCO DE IMAGENS (montado com vídeos/imagens de banco, sem gravação própria, com texto na tela)",
  },
  banner_animado: {
    label: "Banner animado",
    format: "reels",
    prompt: "BANNER ANIMADO (arte com animação curta, mensagem institucional ou promocional direta)",
  },
  story_exclusivo: {
    label: "Story exclusivo",
    format: "story",
    prompt: "STORY EXCLUSIVO (conteúdo só dos stories, rápido e interativo: enquete, pergunta, bastidor, dica)",
  },
  story_replica: {
    label: "Story réplica",
    format: "story",
    prompt: "story que replica o post do feed",
  },
};

/** Rótulo do tipo (selo); null quando não há tipo ou é desconhecido. */
export function contentKindLabel(kind: string | null | undefined): string | null {
  return isContentKind(kind) ? CONTENT_KIND[kind].label : null;
}

/**
 * Tipo que continua valendo depois de trocar o formato na revisão: o mesmo se combina com o
 * formato novo; senão o tipo "padrão" do formato (feed → estático, carrossel → carrossel,
 * story → story exclusivo, reels → reels).
 */
export function kindForFormat(kind: string | null | undefined, format: string): ContentKind | null {
  if (isContentKind(kind) && CONTENT_KIND[kind].format === format) return kind;
  if (format === "feed") return "estatico";
  if (format === "carrossel") return "carrossel";
  if (format === "story") return "story_exclusivo";
  if (format === "reels") return "reels";
  return null;
}

// ------------------------------------------------------------ composição do mês

export type PackageComposition = {
  /** posts de feed por tipo (mês inteiro) */
  feed: Partial<Record<ContentKind, number>>;
  /** stories exclusivos (só Gestão 3) */
  storyExclusive: number;
};

export function carouselsPerMonth(freq: string | null | undefined): number {
  return freq === "semanal" ? 4 : 2;
}

export function packageComposition(tier: PackageTier, carouselFrequency: string | null | undefined): PackageComposition {
  const c = carouselsPerMonth(carouselFrequency);
  switch (tier) {
    case "gestao_1":
      return { feed: { carrossel: c, estatico: 12 - c }, storyExclusive: 0 };
    case "gestao_2":
      return { feed: { reels_banco: 3, banner_animado: 1, carrossel: c, estatico: 8 - c }, storyExclusive: 0 };
    case "gestao_3_stories":
      return { feed: { estatico: 4, reels: 4 }, storyExclusive: 12 };
    case "gestao_reels":
      return { feed: { reels_gravado: 4, reels_banco: 3, banner_animado: 1 }, storyExclusive: 0 };
  }
}

const REELS_KINDS: ContentKind[] = ["reels_gravado", "reels_banco", "reels"];

/** "3 reels, 1 banner, 2 carrosséis, 6 estáticos" (contagem por tipo, na ordem fixa). */
export function describeFeedCounts(counts: Partial<Record<string, number>>): string {
  const n = (k: string) => counts[k] ?? 0;
  const reelsKinds = REELS_KINDS.filter((k) => n(k) > 0);
  const parts: string[] = [];
  if (reelsKinds.length === 1) {
    const k = reelsKinds[0];
    parts.push(`${n(k)} reels`);
  } else {
    if (n("reels_gravado")) parts.push(`${n("reels_gravado")} ${n("reels_gravado") === 1 ? "reels gravado" : "reels gravados"}`);
    if (n("reels_banco")) parts.push(`${n("reels_banco")} reels de banco`);
    if (n("reels")) parts.push(`${n("reels")} reels`);
  }
  if (n("banner_animado")) parts.push(`${n("banner_animado")} ${n("banner_animado") === 1 ? "banner" : "banners"}`);
  if (n("carrossel")) parts.push(`${n("carrossel")} ${n("carrossel") === 1 ? "carrossel" : "carrosséis"}`);
  if (n("estatico")) parts.push(`${n("estatico")} ${n("estatico") === 1 ? "estático" : "estáticos"}`);
  return parts.join(", ");
}

/** Resumo do pacote para um mês inteiro: "Gestão 2 · 12 posts: 3 reels, 1 banner, 2 carrosséis, 6 estáticos". */
export function packageSummary(tier: PackageTier, carouselFrequency: string | null | undefined): string {
  const comp = packageComposition(tier, carouselFrequency);
  const feedTotal = Object.values(comp.feed).reduce((a, b) => a + (b ?? 0), 0);
  const base = `${PACKAGE[tier].label} · ${feedTotal} posts: ${describeFeedCounts(comp.feed)}`;
  if (tier !== "gestao_3_stories") return base;
  const stories = feedTotal + comp.storyExclusive;
  return `${base} + ${stories} stories (${feedTotal} réplicas, ${comp.storyExclusive} exclusivos)`;
}

// ------------------------------------------------------------ slots do mês

/** Horários dos stories exclusivos: manhã, tarde e noite. */
export const STORY_TIMES = ["09:00", "14:00", "19:00"] as const;

export type PackageSlot = {
  /** "YYYY-MM-DD" (dia em São Paulo) */
  date: string;
  /** "HH:MM" (São Paulo) */
  time: string;
  /** ISO UTC do instante (fuso -03:00) */
  scheduledAt: string;
  format: KindFormat;
  contentKind: ContentKind;
  /** post de feed com story junto (a réplica): sim; story exclusivo: não */
  withStory: boolean;
};

export type PackagePlan = {
  /** slots a partir de amanhã, em ordem de data/hora */
  slots: PackageSlot[];
  /** quantos slots o mês inteiro teria */
  planned: number;
};

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Para cada alvo (dia fracionário), o candidato livre mais próximo (empate: o mais cedo).
 * Devolve os dias escolhidos em ordem crescente.
 */
function pickNearest(candidates: number[], targets: number[]): number[] {
  const free = [...candidates];
  const out: number[] = [];
  for (const t of targets) {
    if (free.length === 0) break;
    let best = 0;
    for (let i = 1; i < free.length; i++) {
      if (Math.abs(free[i] - t) < Math.abs(free[best] - t)) best = i;
    }
    out.push(free[best]);
    free.splice(best, 1);
  }
  return out.sort((a, b) => a - b);
}

/** n alvos no meio de n fatias iguais do mês (ex.: 2 → dias ~8 e ~23 num mês de 30). */
function targets(n: number, lastDay: number): number[] {
  return Array.from({ length: n }, (_, i) => ((i + 0.5) * lastDay) / n + 0.5);
}

/** Dia alternativo para reels excedentes: 2 dias depois (seg→qua, ter→qui, qua→sex) ou antes (qui→ter, sex→qua). */
function altWeekday(wd: number): number {
  return wd <= 3 ? wd + 2 : wd - 2;
}

/**
 * Monta os slots do mês do pacote. `today` = data de hoje em São Paulo; do mês corrente só entram
 * dias a partir de amanhã (o mês já começado gera só os slots restantes); mês passado → nenhum.
 */
export function buildPackageSlots(opts: {
  tier: PackageTier;
  year: number;
  month: number; // 1–12
  carouselFrequency?: string | null;
  reelsWeekday?: number | null;
  /** horário dos posts de feed (HH:MM) */
  time: string;
  today: { year: number; month: number; day: number };
}): PackagePlan {
  const { tier, year, month, time, today } = opts;
  const comp = packageComposition(tier, opts.carouselFrequency);
  const reelsDay = isReelsWeekday(opts.reelsWeekday) ? opts.reelsWeekday : DEFAULT_REELS_WEEKDAY;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const wd = (d: number) => new Date(Date.UTC(year, month - 1, d)).getUTCDay();
  const days = Array.from({ length: lastDay }, (_, i) => i + 1);
  const weekdays = days.filter((d) => wd(d) >= 1 && wd(d) <= 5);

  const used = new Set<number>();
  const feed: { day: number; kind: ContentKind }[] = [];
  const add = (day: number, kind: ContentKind) => {
    used.add(day);
    feed.push({ day, kind });
  };

  // 1) reels: 1 por semana no dia escolhido; o que passar disso, no dia alternativo, espaçado
  const reelsKinds: ContentKind[] = [];
  for (const k of REELS_KINDS) for (let i = 0; i < (comp.feed[k] ?? 0); i++) reelsKinds.push(k);
  if (reelsKinds.length > 0) {
    const onDay = weekdays.filter((d) => wd(d) === reelsDay);
    const dayCount = Math.min(reelsKinds.length, onDay.length);
    const chosen = pickNearest(onDay, targets(dayCount, lastDay));
    const excess = reelsKinds.length - chosen.length;
    const altDays = weekdays.filter((d) => wd(d) === altWeekday(reelsDay));
    const extra = excess > 0 ? pickNearest(altDays, targets(excess, lastDay)) : [];
    // no dia escolhido vão primeiro os gravados; os excedentes são os últimos da lista (banco)
    chosen.forEach((d, i) => add(d, reelsKinds[i]));
    extra.forEach((d, i) => add(d, reelsKinds[chosen.length + i]));
  }

  // 2) demais posts de feed: seg/qua/sex livres (se faltar, ter/qui livres)
  const otherKinds = (["carrossel", "banner_animado", "estatico"] as ContentKind[]).filter((k) => (comp.feed[k] ?? 0) > 0);
  const otherCount = otherKinds.reduce((a, k) => a + (comp.feed[k] ?? 0), 0);
  if (otherCount > 0) {
    const primary = weekdays.filter((d) => [1, 3, 5].includes(wd(d)) && !used.has(d));
    const secondary = weekdays.filter((d) => [2, 4].includes(wd(d)) && !used.has(d));
    const picked =
      primary.length >= otherCount
        ? pickNearest(primary, targets(otherCount, lastDay))
        : [...primary, ...pickNearest(secondary, targets(otherCount - primary.length, lastDay))].sort((a, b) => a - b);
    let free = picked;
    const take = (kind: ContentKind, wanted: number[]) => {
      const chosen = pickNearest(free, wanted);
      free = free.filter((d) => !chosen.includes(d));
      chosen.forEach((d) => add(d, kind));
    };
    // carrosséis espaçados pela frequência (quinzenal ~15 dias; semanal ~7), banner no meio do mês
    take("carrossel", targets(comp.feed.carrossel ?? 0, lastDay));
    take("banner_animado", targets(comp.feed.banner_animado ?? 0, lastDay));
    for (const d of free) add(d, "estatico");
  }

  const iso = (day: number, hhmm: string) =>
    new Date(`${year}-${pad(month)}-${pad(day)}T${hhmm}:00-03:00`).toISOString();
  const all: PackageSlot[] = feed.map(({ day, kind }) => ({
    date: `${year}-${pad(month)}-${pad(day)}`,
    time,
    scheduledAt: iso(day, time),
    format: CONTENT_KIND[kind].format,
    contentKind: kind,
    withStory: true,
  }));

  // 3) stories exclusivos (Gestão 3): dias úteis sem feed, manhã/tarde/noite em rodízio
  if (comp.storyExclusive > 0) {
    const free = weekdays.filter((d) => !used.has(d));
    const pool =
      free.length >= comp.storyExclusive
        ? pickNearest(free, targets(comp.storyExclusive, lastDay))
        : [...free, ...pickNearest(weekdays.filter((d) => used.has(d)), targets(comp.storyExclusive - free.length, lastDay))].sort(
            (a, b) => a - b
          );
    pool.forEach((day, i) => {
      const t = STORY_TIMES[i % STORY_TIMES.length];
      all.push({
        date: `${year}-${pad(month)}-${pad(day)}`,
        time: t,
        scheduledAt: iso(day, t),
        format: "story",
        contentKind: "story_exclusivo",
        withStory: false,
      });
    });
  }

  all.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));

  // só dias futuros: mês corrente a partir de amanhã; mês passado → nada
  const monthKey = year * 12 + month;
  const todayKey = today.year * 12 + today.month;
  const firstDay = monthKey < todayKey ? lastDay + 1 : monthKey === todayKey ? today.day + 1 : 1;
  const slots = all.filter((s) => Number(s.date.slice(8, 10)) >= firstDay);
  return { slots, planned: all.length };
}

/** "qua 05/11" — rótulo curto do dia do slot (para o prompt da IA). */
export function slotDayLabel(slot: Pick<PackageSlot, "date">): string {
  const [y, m, d] = slot.date.split("-").map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WEEKDAY_SHORT[w]} ${pad(d)}/${pad(m)}`;
}

/** Hoje (ano, mês, dia) no fuso de São Paulo. */
export function spToday(now: Date = new Date()): { year: number; month: number; day: number } {
  const s = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const [year, month, day] = s.split("-").map(Number);
  return { year, month, day };
}
