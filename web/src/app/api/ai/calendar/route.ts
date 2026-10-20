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
import {
  CONTENT_KIND,
  PACKAGE,
  buildPackageSlots,
  isPackageTier,
  packageSummary,
  slotDayLabel,
  spToday,
  type PackageSlot,
} from "@/lib/content-packages";
import { z } from "zod";

export const dynamic = "force-dynamic";
// 12 ideias (tema + explicação) numa só chamada; as legendas saem em lotes à parte
// (POST /api/ai/calendar/captions e o after() do commit)
export const maxDuration = 120;

const FALLBACK = "Não foi possível gerar o cronograma agora. Tente de novo em instantes.";

const schema = z.object({
  clientId: uuidString,
  // mês de referência no formato YYYY-MM
  month: z.string().regex(/^\d{4}-\d{2}$/),
  // horário padrão de publicação (HH:MM, fuso São Paulo)
  time: z.string().regex(/^\d{2}:\d{2}$/).default("18:00"),
  count: z.number().int().min(1).max(31).default(12),
  targets: z.array(z.enum(["instagram", "facebook", "linkedin"])).optional(),
});

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Mon/Wed/Fri datas do mês (3 por semana), em instantes UTC a partir do fuso -03:00.
 * Mês em andamento: só datas a partir de amanhã (nunca gera post para dia que já passou).
 */
function pickDates(year: number, month: number, count: number, time: string): Date[] {
  const targetWeekdays = [1, 3, 5]; // seg, qua, sex
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

  // dia de hoje no fuso SP; se o mês pedido é o corrente, começa em hoje+1
  const spNow = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date()); // "YYYY-MM-DD"
  const [curY, curM, curD] = spNow.split("-").map(Number);
  const firstDay = year === curY && month === curM ? curD + 1 : 1;

  const days: number[] = [];
  for (let d = firstDay; d <= lastDay; d++) {
    const wd = new Date(Date.UTC(year, month - 1, d)).getUTCDay();
    if (targetWeekdays.includes(wd)) days.push(d);
  }
  return days
    .slice(0, count)
    .map((d) => new Date(`${year}-${pad(month)}-${pad(d)}T${time}:00-03:00`));
}

type Idea = {
  theme: string;
  format?: string;
  explanation?: string;
  /** cliente com pacote: número do slot (1..n) */
  slot?: unknown;
};

/**
 * Prompt do cliente com pacote de gestão: o SISTEMA já montou os slots (data, hora, tipo) e a IA
 * só cria tema + explicação para cada um, respeitando o tipo do slot.
 */
function packagePrompt(slots: PackageSlot[]): string {
  const lines = slots.map((s, i) => `${i + 1}. ${slotDayLabel(s)} às ${s.time} — ${CONTENT_KIND[s.contentKind].prompt}`);
  return [
    `Gere EXATAMENTE ${slots.length} ideias, UMA PARA CADA slot abaixo, na mesma ordem. `,
    "O tipo de cada slot já está definido e NÃO pode mudar: a ideia tem de servir para aquele tipo ",
    "(ex.: reels gravado = algo que o cliente consegue gravar; reels de banco de imagens = montado com imagens de banco; ",
    "banner animado = mensagem curta e direta; story exclusivo = conteúdo rápido e interativo, diferente dos posts do feed). ",
    "Varie os assuntos (educativo, bastidores, prova social, promocional, engajamento, dica rápida, institucional) e evite repetir temas.\n",
    "Slots:\n",
    lines.join("\n"),
    "\nPara cada slot forneça: theme (título curto e forte, pronto para ser o título da postagem) ",
    "e explanation (1-2 frases, em pt-BR, explicando para o CLIENTE o que essa postagem vai abordar e por quê — sem jargão, sem legenda pronta). ",
    `Responda em JSON no formato: {"posts":[{"slot":1,"theme":"...","explanation":"..."}]} com ${slots.length} itens.`,
  ].join("");
}

/** Teto do corpo (cliente, mês, horário, quantidade, redes). */
const MAX_BODY_BYTES = 16 * 1024;

export async function POST(req: NextRequest) {
  const { user, denied } = await requireAuthUser();
  if (denied) return denied;

  // geração de calendário é cara: 10 por 5 min por IP
  const limited = enforceRateLimit(`ai-calendar:${clientIp(req)}`, 10, 5 * 60_000);
  if (limited) return limited;

  const read = await readJsonLimited(req, MAX_BODY_BYTES);
  if (!read.ok) return read.response;
  const parsed = schema.safeParse(read.value);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { clientId, month, time, count } = parsed.data;
  const [year, mon] = month.split("-").map(Number);

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      name: true,
      toneOfVoice: true,
      tier: true,
      carouselFrequency: true,
      reelsWeekday: true,
      socialAccounts: { where: { status: "active" }, select: { platform: true } },
    },
  });
  if (!client) return Response.json({ error: "Cliente não encontrado" }, { status: 404 });

  const activePlatforms = Array.from(new Set(client.socialAccounts.map((a) => a.platform)));
  const targets =
    parsed.data.targets && parsed.data.targets.length
      ? parsed.data.targets
      : activePlatforms.length
        ? activePlatforms
        : ["instagram", "facebook"];

  // pacote de gestão: o sistema monta os slots do mês (só os dias que ainda não passaram);
  // cliente "completa" (antigo) ou "basica": comportamento de antes (12 posts seg/qua/sex)
  const tier = client.tier;
  const plan = isPackageTier(tier)
    ? buildPackageSlots({
        tier,
        year,
        month: mon,
        carouselFrequency: client.carouselFrequency,
        reelsWeekday: client.reelsWeekday,
        time,
        today: spToday(),
      })
    : null;
  const dates = plan ? plan.slots.map((s) => new Date(s.scheduledAt)) : pickDates(year, mon, count, time);
  if (dates.length === 0) {
    return Response.json(
      { error: "Este mês não tem mais datas futuras disponíveis. Gere o calendário do próximo mês." },
      { status: 400 }
    );
  }
  const n = plan ? plan.slots.length : Math.min(count, dates.length);

  const monthName = new Intl.DateTimeFormat("pt-BR", {
    month: "long",
    year: "numeric",
    timeZone: "America/Sao_Paulo",
  }).format(new Date(Date.UTC(year, mon - 1, 15)));

  // FASE CRONOGRAMA: o cliente aprova só TÍTULO + breve explicação do tema (link mensal).
  // Esta chamada não gera legenda: legendas/slides saem em segundo plano durante a revisão
  // (lib/calendar-captions) e o cliente só as vê no link semanal.
  const system =
    "Você é um estrategista de conteúdo de social media de uma agência brasileira. " +
    "Cria cronogramas editoriais mensais variados e coerentes com o tom de voz do cliente. " +
    "Responda SOMENTE com JSON válido, sem texto fora do JSON.";

  const header = [
    `Cliente: ${client.name}.`,
    client.toneOfVoice ? `Tom de voz: ${client.toneOfVoice}.` : "Tom de voz: não informado, use um tom profissional e próximo.",
    `Mês de referência: ${monthName}.`,
  ];
  const prompt = plan
    ? [...header, packagePrompt(plan.slots)].join("")
    : [
        ...header,
        `Gere EXATAMENTE ${n} ideias de post para o mês, variando os tipos de conteúdo `,
        "(educativo, bastidores, prova social/depoimento, promocional, engajamento/pergunta, dica rápida, institucional). ",
        "Evite repetir temas. Para cada post forneça: ",
        "theme (título curto e forte, pronto para ser o título da postagem), ",
        "format (um de: 'feed', 'carrossel', 'reels' — todo post ganha um story de apoio automaticamente, não gere posts só de story) ",
        "e explanation (1-2 frases, em pt-BR, explicando para o CLIENTE o que essa postagem vai abordar e por quê — sem jargão, sem legenda pronta). ",
        `Responda em JSON no formato: {"posts":[{"theme":"...","format":"...","explanation":"..."}]} com ${n} itens.`,
      ].join("");

  // teto de gerações por IA da usuária e do sistema (CF-12)
  const quota = enforceAiQuota(user.id, 1, "calendario");
  if (quota) return quota;

  const textModel = await getTextModel("calendar");
  const { model } = textModel;
  let ideas: Idea[];
  try {
    const raw = await generateAiText(textModel, {
      label: "calendario",
      system,
      prompt,
      temperature: 0.95,
      json: true,
      // 2 tentativas × 55s + 1.5s de pausa cabem no maxDuration de 120s
      maxOutputTokens: 32768,
      timeoutMs: 55_000,
    });
    const data = parseModelJson<{ posts?: Idea[] } | Idea[]>(raw);
    ideas = Array.isArray(data) ? data : (data.posts as Idea[]);
    if (!Array.isArray(ideas)) throw new Error("Gemini não retornou a lista de posts (formato inesperado)");
  } catch (e) {
    console.error("[ai/calendar]", e);
    return Response.json({ error: toUserMessage(e, FALLBACK) }, { status: 502 });
  }

  const items = ideas.slice(0, n);
  if (items.length === 0) {
    return Response.json({ error: "A IA não retornou ideias." }, { status: 502 });
  }

  if (plan && isPackageTier(tier)) {
    // um item por slot, na ordem; "slot" (1..n) da IA tem prioridade sobre a posição.
    // Slot sem ideia fica sem título: a equipe escreve ou usa "Substituir".
    const bySlot = new Map<number, Idea>();
    ideas.forEach((idea, i) => {
      const k = typeof idea?.slot === "number" ? idea.slot - 1 : i;
      if (k >= 0 && k < plan.slots.length && !bySlot.has(k)) bySlot.set(k, idea);
    });
    const posts = plan.slots.map((s, i) => {
      const idea = bySlot.get(i);
      return {
        theme: typeof idea?.theme === "string" ? idea.theme.trim().slice(0, 200) : "",
        format: s.format,
        contentKind: s.contentKind,
        withStory: s.withStory,
        explanation: typeof idea?.explanation === "string" ? idea.explanation.trim().slice(0, 600) : "",
        captions: {} as Record<string, string>,
        scheduledAt: s.scheduledAt,
        targets,
        mediaUrl: "",
      };
    });
    return Response.json(
      {
        month,
        clientName: client.name,
        targets,
        activePlatforms,
        model,
        posts,
        package: {
          tier,
          label: PACKAGE[tier].label,
          summary: packageSummary(tier, client.carouselFrequency),
          planned: plan.planned,
          generated: plan.slots.length,
        },
      },
      { status: 200 }
    );
  }

  // Preview: NÃO salva nada. Devolve os rascunhos gerados para o usuário
  // revisar/ajustar e só então aprovar (POST /api/ai/calendar/commit).
  const previewPosts = items.map((idea, i) => ({
    theme: (idea.theme ?? `Post ${i + 1}`).slice(0, 200),
    format: idea.format ?? "feed",
    explanation:
      typeof idea.explanation === "string" ? idea.explanation.trim().slice(0, 600) : "",
    captions: {} as Record<string, string>,
    scheduledAt: dates[i].toISOString(),
    targets,
    mediaUrl: "",
  }));

  return Response.json(
    {
      month,
      clientName: client.name,
      targets,
      activePlatforms,
      model,
      posts: previewPosts,
    },
    { status: 200 }
  );
}
