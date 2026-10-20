import { parseModelJson } from "@/lib/gemini";
import { CONTENT_KIND, isContentKind } from "@/lib/content-packages";
import { briefingForPrompt } from "@/lib/client-briefing-prompt";
import { clientHashtagBlock, hashtagPromptRule, withClientHashtags } from "@/lib/client-hashtags";

/**
 * Legendas em LOTE (uma chamada de IA para vários posts): montagem do prompt e leitura
 * da resposta, sem Prisma nem rede. Usado por `generateWeekContent` (lib/weekly.ts) e
 * reaproveitável por outros lotes (ex.: legendas do calendário).
 *
 * Regras do cliente: o briefing inteiro entra no prompt (`briefingForPrompt`) e as
 * hashtags fixas são anexadas pelo código no fim de cada legenda (`withClientHashtags`).
 */

export type CaptionBatchClient = {
  name: string;
  toneOfVoice: string | null;
  /** Client.briefing (Json) — pode ser null */
  briefing?: unknown;
};

export type CaptionBatchItem = {
  id: string;
  theme: string | null;
  explanation: string | null;
  /** feed | story | carrossel | reels — carrossel/reels também pedem slides */
  format: string;
  /** tipo do conteúdo no pacote de gestão (lib/content-packages), quando houver */
  contentKind?: string | null;
};

export type CaptionBatchEntry = {
  /** legenda única FB+IG, já com as hashtags fixas do cliente no fim */
  shared: string;
  /** legenda do LinkedIn (já com as hashtags); "" quando a IA não mandou → use `shared` */
  linkedin: string;
  /** telas do carrossel/reels (aparadas, até 20, até 2000 caracteres); null se o formato não pede ou a IA não mandou */
  slides: string[] | null;
};

const wantsSlides = (format: string) => format === "carrossel" || format === "reels";

export const CAPTION_BATCH_SYSTEM =
  "Você é redator de social media de uma agência brasileira. Produz conteúdo final " +
  "pronto para publicação, em pt-BR, no tom de voz do cliente. Facebook e Instagram " +
  "usam SEMPRE a mesma legenda. Responda SOMENTE com JSON válido.";

/** Prompt do lote: um item por post, na ordem recebida. */
export function buildCaptionBatchPrompt(
  client: CaptionBatchClient,
  items: CaptionBatchItem[]
): { system: string; prompt: string } {
  const briefing = briefingForPrompt(client.briefing);
  const hashtagRule = hashtagPromptRule(clientHashtagBlock(client.briefing));

  const itemsDesc = items
    .map((p, i) => {
      const kind = isContentKind(p.contentKind) ? ` tipo="${CONTENT_KIND[p.contentKind].prompt}"` : "";
      return `${i + 1}. id="${p.id}" formato=${p.format}${kind} título="${p.theme ?? ""}"${
        p.explanation ? ` briefing="${p.explanation}"` : ""
      }${wantsSlides(p.format) ? " (gerar slides)" : ""}`;
    })
    .join("\n");

  const prompt = [
    `Cliente: ${client.name}.`,
    client.toneOfVoice ? `Tom de voz: ${client.toneOfVoice}.` : "Tom de voz: profissional e próximo.",
    ...(briefing ? [briefing] : []),
    "Para CADA post abaixo, gere:",
    hashtagRule
      ? '- "shared": legenda única FB+IG (envolvente, call-to-action, SEM hashtags, emojis moderados);'
      : '- "shared": legenda única FB+IG (envolvente, call-to-action, 3-6 hashtags, emojis moderados);',
    '- "linkedin": versão profissional (somente se fizer sentido; opcional);',
    '- "slides": SOMENTE para carrossel/reels — array de 5 a 8 textos curtos, um por tela, contando a história do post (primeiro = capa com gancho, último = call-to-action). Sem slides para formato feed/story.',
    ...(hashtagRule ? [hashtagRule] : []),
    "Posts:",
    itemsDesc,
    'Responda em JSON: {"posts":[{"id":"<id>","shared":"...","linkedin":"...","slides":["..."]}]} — um item por post, na mesma ordem.',
  ].join("\n");

  return { system: CAPTION_BATCH_SYSTEM, prompt };
}

type RawIdea = { id?: unknown; shared?: unknown; linkedin?: unknown; slides?: unknown };

/**
 * Lê a resposta do lote. Devolve um item por post de `items` (mesma ordem): null quando
 * a IA não mandou legenda "shared" para ele. Se a resposta traz ids, casa SÓ por id (um
 * post omitido nunca recebe a legenda do vizinho); a posição só vale quando NENHUM item
 * tem id e a IA mandou exatamente um item por post.
 * Lança se a resposta não for JSON (quem chama decide o que fazer).
 */
export function parseCaptionBatch(
  raw: string,
  items: Pick<CaptionBatchItem, "id" | "format">[],
  briefing: unknown
): (CaptionBatchEntry | null)[] {
  const data = parseModelJson<{ posts?: RawIdea[] }>(raw);
  const ideas = (Array.isArray(data?.posts) ? data.posts : []).filter(
    (x): x is RawIdea => !!x && typeof x === "object"
  );
  const block = clientHashtagBlock(briefing);
  const idOf = (x: RawIdea) =>
    typeof x.id === "string" || typeof x.id === "number" ? String(x.id).trim() : "";
  const withIds = ideas.some((x) => idOf(x) !== "");
  const byPosition = !withIds && ideas.length === items.length;

  return items.map((item, i) => {
    const idea = withIds
      ? ideas.find((x) => idOf(x) === item.id)
      : byPosition
        ? ideas[i]
        : undefined;
    if (!idea) return null;
    const shared = typeof idea.shared === "string" ? idea.shared.trim() : "";
    if (!shared) return null;
    const li = typeof idea.linkedin === "string" ? idea.linkedin.trim() : "";
    const slides =
      wantsSlides(item.format) && Array.isArray(idea.slides)
        ? idea.slides
            .filter((s): s is string => typeof s === "string" && !!s.trim())
            .slice(0, 20)
            .map((text) => text.trim().slice(0, 2000))
        : null;
    return {
      shared: withClientHashtags(shared, block),
      linkedin: li ? withClientHashtags(li, block) : "",
      slides,
    };
  });
}
