import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { generateAiText } from "@/lib/ai-text";
import {
  buildCaptionBatchPrompt,
  parseCaptionBatch,
  type CaptionBatchClient,
  type CaptionBatchEntry,
} from "@/lib/caption-batch";

/**
 * Legendas (e slides de carrossel/reels) geradas JUNTO com o cronograma, em segundo plano
 * (pedido do usuário em 07/10: "gerar junto com o calendário porém … em segundo plano").
 *
 * - A revisão do cronograma (CalendarReviewModal) pede lotes pequenos em
 *   POST /api/ai/calendar/captions e preenche os campos conforme chegam.
 * - O que ainda estiver sem legenda ao salvar é gerado pelo servidor depois da resposta
 *   do commit (`after()`), gravando só onde a legenda continua vazia (`fillMissingCaptions`).
 *
 * Prompt e leitura do lote: lib/caption-batch (o mesmo do lote semanal) — briefing completo
 * do cliente no prompt (`briefingForPrompt`) e hashtags fixas do cliente no fim de toda
 * legenda (`withClientHashtags`; com bloco, a IA é instruída a não pôr hashtags próprias).
 * FB e IG usam a MESMA legenda.
 * Story: recebe legenda como os demais posts (regra do lote semanal), nunca slides; o story
 * que sai junto de um post (15 min depois, mesmo título) copia a legenda do post.
 */

/** Posts por chamada de IA na revisão (e no `after()` do commit). */
export const CAPTION_BATCH_SIZE = 4;
/** Máximo de posts aceito por POST /api/ai/calendar/captions. */
export const CAPTION_BATCH_MAX = 6;
/** Lotes simultâneos (revisão e servidor). */
export const CAPTION_CONCURRENCY = 3;
/** O story "junto" sai 15 min depois do post (CalendarReviewModal). */
export const STORY_DELAY_MS = 15 * 60_000;

export type CaptionClient = CaptionBatchClient;
export type CaptionItem = {
  /** id do post (no banco) ou da postagem na tela de revisão; vai no prompt para casar a resposta */
  id: string;
  theme: string;
  explanation?: string | null;
  format: string;
  /** tipo do conteúdo no pacote de gestão (ex.: reels_banco), quando houver */
  contentKind?: string | null;
  targets: string[];
};
/** Legenda por rede (só as redes do post) e, para carrossel/reels, o roteiro por tela. */
export type CaptionResult = { captions: Record<string, string>; slides?: string[] };

export const wantsSlides = (format: string) => format === "carrossel" || format === "reels";

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * Item do lote (lib/caption-batch, já com hashtags do cliente) → legenda por rede do post:
 * FB e IG recebem a mesma; LinkedIn usa a própria ou, sem ela, a mesma. null se não sobrar
 * legenda para nenhuma rede.
 */
export function toCaptionResult(
  entry: CaptionBatchEntry | null,
  item: Pick<CaptionItem, "format" | "targets">
): CaptionResult | null {
  if (!entry) return null;
  const captions: Record<string, string> = {};
  if (item.targets.includes("instagram")) captions.instagram = entry.shared;
  if (item.targets.includes("facebook")) captions.facebook = entry.shared;
  if (item.targets.includes("linkedin")) captions.linkedin = entry.linkedin || entry.shared;
  if (!Object.values(captions).some((c) => c.trim())) return null;
  const slides = wantsSlides(item.format) && entry.slides?.length ? entry.slides : null;
  return slides ? { captions, slides } : { captions };
}

/**
 * Uma chamada de IA para um lote de posts: prompt e leitura de lib/caption-batch (briefing
 * do cliente no prompt, hashtags fixas no fim), mesmo modelo do lote semanal. Um item por
 * post, na ordem de `items` (null quando a IA não devolveu legenda para ele).
 */
export async function generateCaptionBatch(
  client: CaptionClient,
  items: CaptionItem[],
  opts: { signal?: AbortSignal } = {}
): Promise<(CaptionResult | null)[]> {
  if (items.length === 0) return [];
  const batchItems = items.map((p) => ({
    id: p.id,
    theme: p.theme,
    explanation: text(p.explanation) || null,
    format: p.format,
    contentKind: p.contentKind ?? null,
  }));
  const { system, prompt } = buildCaptionBatchPrompt(client, batchItems);
  const raw = await generateAiText("calendar", {
    label: "legendas-lote",
    system,
    prompt,
    temperature: 0.9,
    json: true,
    maxOutputTokens: 16384,
    // 2 tentativas × 55s + 1.5s de pausa cabem no maxDuration de 120s da rota de lotes
    timeoutMs: 55_000,
    // a revisão cancelou o lote (salvou/fechou): a chamada à IA para também
    signal: opts.signal,
  });
  const entries = parseCaptionBatch(raw, batchItems, client.briefing);
  return items.map((item, i) => toCaptionResult(entries[i] ?? null, item));
}

// ------------------------------------------------------------ servidor: depois do commit

/** Legenda vazia: nenhuma rede com texto. */
export function captionsEmpty(captions: unknown): boolean {
  if (!captions || typeof captions !== "object" || Array.isArray(captions)) return true;
  return !Object.values(captions as Record<string, unknown>).some((v) => typeof v === "string" && v.trim());
}

/** Slides vazios: nenhuma tela com texto. */
export function slidesEmpty(slides: unknown): boolean {
  if (!Array.isArray(slides)) return true;
  return !slides.some((s) => {
    const t = s && typeof s === "object" ? (s as { text?: unknown }).text : s;
    return typeof t === "string" && !!t.trim();
  });
}

type FillPost = {
  id: string;
  clientId: string;
  theme: string | null;
  explanation: string | null;
  format: string;
  contentKind: string | null;
  targets: string[];
  captions: unknown;
  slides: unknown;
  scheduledAt: Date;
};

/** Precisa de conteúdo: tem título e está sem legenda (ou é carrossel/reels sem slides). */
export function needsContent(p: Pick<FillPost, "theme" | "format" | "captions" | "slides">): boolean {
  if (!text(p.theme)) return false;
  return captionsEmpty(p.captions) || (wantsSlides(p.format) && slidesEmpty(p.slides));
}

/**
 * Story "junto" → post de origem: story com o mesmo título, 15 min depois de um post
 * que não é story. Esses stories copiam a legenda do post (como no commit).
 */
export function pairStoryCompanions(
  posts: Pick<FillPost, "id" | "theme" | "format" | "scheduledAt">[]
): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const s of posts) {
    if (s.format !== "story" || !text(s.theme)) continue;
    const parent = posts.find(
      (p) =>
        p.format !== "story" &&
        text(p.theme) === text(s.theme) &&
        p.scheduledAt.getTime() + STORY_DELAY_MS === s.scheduledAt.getTime()
    );
    if (parent) pairs.set(s.id, parent.id);
  }
  return pairs;
}

/** Ainda sem legenda no banco (ninguém preencheu enquanto a IA trabalhava). */
const STILL_EMPTY_CAPTION = {
  captions: { equals: Prisma.AnyNull },
  OR: [{ caption: null }, { caption: "" }],
};

/** Grava só o que continua vazio no banco; true se gravou algo. */
async function writeIfEmpty(id: string, result: CaptionResult): Promise<boolean> {
  let wrote = false;
  const c = await prisma.post.updateMany({
    where: { id, ...STILL_EMPTY_CAPTION },
    data: { captions: result.captions as Prisma.InputJsonValue },
  });
  if (c.count > 0) wrote = true;
  if (result.slides?.length) {
    const s = await prisma.post.updateMany({
      where: { id, slides: { equals: Prisma.AnyNull } },
      data: { slides: result.slides.map((t) => ({ text: t })) as unknown as Prisma.InputJsonValue },
    });
    if (s.count > 0) wrote = true;
  }
  return wrote;
}

/** Executa as tarefas com no máximo `limit` ao mesmo tempo. */
async function runPool(tasks: (() => Promise<void>)[], limit: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      await task();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

export type FillResult = { updated: number; failed: number };

/**
 * Gera e grava legenda/slides dos posts que ficaram sem conteúdo ao salvar o cronograma
 * (roda no `after()` do commit). Nunca sobrescreve: grava só onde a legenda (ou os slides)
 * continua vazia no banco. Falha de um lote vai para o log e não interrompe os outros;
 * o que sobrar vazio ainda é coberto pelo lote semanal (`generateWeekContent`).
 * `deadlineAt` (ms): não começa lote novo depois disso (limite de duração da função).
 */
export async function fillMissingCaptions(
  postIds: string[],
  opts: { deadlineAt?: number } = {}
): Promise<FillResult> {
  const out: FillResult = { updated: 0, failed: 0 };
  if (postIds.length === 0) return out;

  const posts: FillPost[] = await prisma.post.findMany({
    where: { id: { in: postIds } },
    select: {
      id: true, clientId: true, theme: true, explanation: true, format: true, contentKind: true, targets: true,
      captions: true, slides: true, scheduledAt: true,
    },
    orderBy: { scheduledAt: "asc" },
  });
  if (posts.length === 0) return out;

  const client = await prisma.client.findUnique({
    where: { id: posts[0].clientId },
    select: { name: true, toneOfVoice: true, briefing: true },
  });
  if (!client) return out;

  const companionOf = pairStoryCompanions(posts);
  const companionsByParent = new Map<string, string[]>();
  for (const [story, parent] of companionOf) {
    companionsByParent.set(parent, [...(companionsByParent.get(parent) ?? []), story]);
  }

  const todo = posts.filter((p) => !companionOf.has(p.id) && needsContent(p));
  const batches: FillPost[][] = [];
  for (let i = 0; i < todo.length; i += CAPTION_BATCH_SIZE) batches.push(todo.slice(i, i + CAPTION_BATCH_SIZE));

  const tasks = batches.map((batch) => async () => {
    if (opts.deadlineAt !== undefined && Date.now() > opts.deadlineAt) {
      out.failed += batch.length;
      console.error("[calendar-captions] sem tempo para o lote; fica para o lote semanal", batch.map((p) => p.id));
      return;
    }
    let results: (CaptionResult | null)[];
    try {
      results = await generateCaptionBatch(
        client,
        batch.map((p) => ({
          id: p.id,
          theme: text(p.theme),
          explanation: p.explanation,
          format: p.format,
          contentKind: p.contentKind,
          targets: p.targets,
        }))
      );
    } catch (e) {
      out.failed += batch.length;
      console.error("[calendar-captions] falha ao gerar o lote", batch.map((p) => p.id), e);
      return;
    }
    for (let i = 0; i < batch.length; i++) {
      const post = batch[i];
      const result = results[i];
      if (!result) {
        out.failed++;
        console.error("[calendar-captions] a IA não devolveu legenda", post.id);
        continue;
      }
      try {
        if (await writeIfEmpty(post.id, result)) out.updated++;
        for (const story of companionsByParent.get(post.id) ?? []) {
          if (await writeIfEmpty(story, { captions: result.captions })) out.updated++;
        }
      } catch (e) {
        out.failed++;
        console.error("[calendar-captions] falha ao gravar a legenda", post.id, e);
      }
    }
  });

  await runPool(tasks, CAPTION_CONCURRENCY);
  return out;
}
