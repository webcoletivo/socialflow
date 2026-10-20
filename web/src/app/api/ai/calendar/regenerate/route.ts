import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuthUser } from "@/lib/api-auth";
import { uuidString } from "@/lib/validators";
import { parseModelJson } from "@/lib/gemini";
import { generateAiText } from "@/lib/ai-text";
import { getTextModel } from "@/lib/ai-models";
import { enforceRateLimit, clientIp } from "@/lib/rate-limit";
import { enforceAiQuota } from "@/lib/ai-quota";
import { readJsonLimited } from "@/lib/read-json";
import { toUserMessage } from "@/lib/user-facing-error";
import { CONTENT_KIND, CONTENT_KINDS } from "@/lib/content-packages";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const FALLBACK = "Não foi possível gerar uma nova ideia agora. Tente de novo em instantes.";

const schema = z.object({
  clientId: uuidString,
  targets: z.array(z.enum(["instagram", "facebook", "linkedin"])).min(1),
  // temas já presentes no calendário, para a IA não repetir
  avoid: z.array(z.string().max(400)).max(200).optional(),
  // slot do pacote de gestão: a ideia nova é para este tipo (o formato não muda)
  contentKind: z.enum(CONTENT_KINDS).nullable().optional(),
});

type Idea = {
  theme?: string;
  format?: string;
  explanation?: string;
};

/** Teto do corpo (redes + temas a evitar). */
const MAX_BODY_BYTES = 128 * 1024;

/** Gera UMA nova ideia de post para substituir um item do calendário em revisão. */
export async function POST(req: NextRequest) {
  const { user, denied } = await requireAuthUser();
  if (denied) return denied;

  const limited = enforceRateLimit(`ai-regen:${clientIp(req)}`, 30, 5 * 60_000);
  if (limited) return limited;

  const read = await readJsonLimited(req, MAX_BODY_BYTES);
  if (!read.ok) return read.response;
  const parsed = schema.safeParse(read.value);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { clientId, avoid = [], contentKind } = parsed.data;
  const kind = contentKind ? CONTENT_KIND[contentKind] : null;

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { name: true, toneOfVoice: true },
  });
  if (!client) return Response.json({ error: "Cliente não encontrado" }, { status: 404 });

  const system =
    "Você é um estrategista de conteúdo de social media de uma agência brasileira. " +
    "Cria ideias de post coerentes com o tom de voz do cliente. " +
    "Responda SOMENTE com JSON válido, sem texto fora do JSON.";

  const avoidLine = avoid.length
    ? `NÃO repita nem se aproxime destes temas já usados: ${avoid.slice(0, 30).join("; ")}.`
    : "";

  const prompt = [
    `Cliente: ${client.name}.`,
    client.toneOfVoice
      ? `Tom de voz: ${client.toneOfVoice}.`
      : "Tom de voz: não informado, use um tom profissional e próximo.",
    `Plataformas: ${parsed.data.targets.join(", ")}.`,
    "Gere EXATAMENTE 1 nova ideia de post, com um ângulo diferente e criativo. ",
    avoidLine,
    "Forneça: theme (título curto e forte, pronto para ser o título da postagem), ",
    kind
      ? `O post é um ${kind.prompt}: a ideia precisa servir para esse tipo. `
      : "format (um de: 'feed', 'carrossel', 'reels') ",
    "e explanation (1-2 frases explicando ao CLIENTE o que a postagem vai abordar e por quê). ",
    "Tudo em pt-BR, no tom do cliente. ",
    'Responda em JSON no formato: {"theme":"...","format":"...","explanation":"..."}.',
  ].join("");

  // teto de gerações por IA da usuária e do sistema (CF-12)
  const quota = enforceAiQuota(user.id, 1, "calendario-regenerar");
  if (quota) return quota;

  const textModel = await getTextModel("calendar");
  const { model } = textModel;
  let idea: Idea;
  try {
    const raw = await generateAiText(textModel, {
      label: "calendario-regenerar",
      system,
      prompt,
      temperature: 0.95,
      json: true,
      maxOutputTokens: 8192,
    });
    const data = parseModelJson<Record<string, unknown>>(raw);
    // aceita tanto {theme,...} quanto {posts:[{...}]}
    const cand = Array.isArray(data) ? data[0] : (data.posts as Idea[] | undefined)?.[0] ?? data;
    idea = cand as Idea;
    if (!idea || typeof idea !== "object") throw new Error("Gemini não retornou a ideia (formato inesperado)");
  } catch (e) {
    console.error("[ai/calendar/regenerate]", e);
    return Response.json({ error: toUserMessage(e, FALLBACK) }, { status: 502 });
  }

  return Response.json(
    {
      theme: (idea.theme ?? "Novo post").slice(0, 200),
      // slot de pacote: o formato é o do tipo, nunca o que a IA sugerir
      format: kind ? kind.format : (idea.format ?? "feed"),
      explanation:
        typeof idea.explanation === "string" ? idea.explanation.trim().slice(0, 600) : "",
      captions: {},
      model,
    },
    { status: 200 }
  );
}
