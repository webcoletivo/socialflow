import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/api-auth";
import { scheduleAllBasicMonths } from "@/lib/basic-plan";
import { normalizeExtraEmails } from "@/lib/client-emails";
import { CLIENT_DETAIL_FIELDS, CLIENT_LIST_SELECT, withoutSecrets } from "@/lib/client-select";
import { normalizeClientUrlFields } from "@/lib/client-urls";
import { NO_STORE } from "@/lib/permissions";
import { CLIENT_STATUSES, SEGMENTS, TIERS } from "@/lib/status-meta";
import { CAROUSEL_FREQUENCIES, normalizePackageFields } from "@/lib/content-packages";
import { uuidString } from "@/lib/validators";
import { z } from "zod";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  plan: z.enum(["sem_aprovacao", "aprovacao_cliente"]).default("sem_aprovacao"),
  // pacote de gestão (lib/content-packages); "completa" = antigo, ainda aceito
  tier: z.enum(TIERS, { error: "Pacote de gestão inválido." }).default("gestao_1"),
  // pacote com carrossel: 1 por semana ou 1 a cada 15 dias
  carouselFrequency: z.enum(CAROUSEL_FREQUENCIES, { error: "Frequência de carrossel inválida." }).optional(),
  // pacote com reels: 1–5 = seg–sex (sem reels → gravado como null)
  reelsWeekday: z.number().int().min(1).max(5).nullable().optional(),
  toneOfVoice: z.string().optional(),
  driveFolderId: z.string().optional(),
  // campos da gestão básica (marca + contatos usados na arte gerada por IA)
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  showContacts: z.boolean().optional(),
  whatsapp: z.string().max(40).optional(),
  phone: z.string().max(40).optional(),
  // só https: (lib/client-urls normaliza "www.x.com"/http e recusa javascript:/data:)
  website: z.string().max(200).optional(),
  instagramUrl: z.string().max(200).optional(),
  city: z.string().max(120).optional(),
  // a agência agenda e publica? false = só produção (os posts ficam em draft)
  agencyPublishes: z.boolean({ error: "Informe se os posts deste cliente devem ser agendados (sim ou não)." }).default(true),
  // e-mails adicionais — normalizados por normalizeExtraEmails (máx. 10)
  extraEmails: z
    .array(z.string({ error: "Cada e-mail adicional deve ser um texto." }), {
      error: "Envie os e-mails adicionais como uma lista.",
    })
    .max(100, "Lista de e-mails adicionais longa demais.")
    .optional(),
  status: z.enum(CLIENT_STATUSES, { error: "Status inválido: use ativo, pausado ou encerrado." }).default("ativo"),
  segment: z.enum(SEGMENTS, { error: "Segmento inválido: use CORR, CARE ou COLETIVO." }).nullable().optional(),
  // redatora responsável (users.id)
  responsibleUserId: uuidString.nullable().optional(),
  // designer responsável (users.id) — fila de artes em /design
  designerUserId: uuidString.nullable().optional(),
});

export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  // select explícito (AC-02/CR-03): nunca o cofre cifrado `credentialsEnc` nem briefing/telefones
  const clients = await prisma.client.findMany({
    orderBy: { createdAt: "desc" },
    select: CLIENT_LIST_SELECT,
  });

  return Response.json(clients.map(withoutSecrets), { headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  const denied = await requireAuth();
  if (denied) return denied;

  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { extraEmails, responsibleUserId, designerUserId, reelsWeekday, ...rest } = parsed.data;

  const badUrl = normalizeClientUrlFields(rest);
  if (badUrl) return Response.json({ error: badUrl.error, field: badUrl.field }, { status: 400 });

  let extras: string[] = [];
  if (extraEmails) {
    const normalized = normalizeExtraEmails(rest.email, extraEmails);
    if (!normalized.ok) {
      return Response.json({ error: normalized.error, field: "extraEmails" }, { status: 400 });
    }
    extras = normalized.emails;
  }

  if (responsibleUserId && !(await prisma.user.findUnique({ where: { id: responsibleUserId }, select: { id: true } }))) {
    return Response.json({ error: "Usuário responsável não encontrado.", field: "responsibleUserId" }, { status: 400 });
  }
  if (designerUserId && !(await prisma.user.findUnique({ where: { id: designerUserId }, select: { id: true } }))) {
    return Response.json({ error: "Designer não encontrado.", field: "designerUserId" }, { status: 400 });
  }

  const client = await prisma.client.create({
    data: {
      ...rest,
      // dia dos reels coerente com o pacote (sem reels → null; com reels e sem dia → quarta)
      ...normalizePackageFields(rest.tier, reelsWeekday),
      extraEmails: extras,
      ...(responsibleUserId !== undefined ? { responsibleUserId } : {}),
      ...(designerUserId !== undefined ? { designerUserId } : {}),
      // nasce com status diferente do padrão: a mudança é registrada agora
      ...(rest.status !== "ativo" ? { statusChangedAt: new Date() } : {}),
    },
    select: CLIENT_DETAIL_FIELDS,
  });

  // cliente básico: agenda na hora o calendário de artes básicas de todos os
  // meses disponíveis (posts draft sem arte — as imagens ficam pendentes)
  let basicPlan: { scheduled: number } | null = null;
  if (client.tier === "basica") {
    try {
      const r = await scheduleAllBasicMonths(client.id);
      basicPlan = { scheduled: r.scheduled };
    } catch {
      basicPlan = null; // não bloqueia o cadastro; dá pra agendar depois na página do cliente
    }
  }

  return Response.json({ ...withoutSecrets(client), basicPlan }, { status: 201, headers: NO_STORE });
}
