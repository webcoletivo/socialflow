/**
 * F15-PACOTES (20/10) — pacotes de gestão: o SISTEMA monta os slots do mês e a IA só cria
 * tema + explicação de cada slot.
 *   1. lib/content-packages (puro): contagem exata por tipo em cada pacote, dia dos reels,
 *      frequência de carrossel, stories exclusivos 09/14/19 em dias úteis, Gestão Reels com
 *      excedentes em outro dia útil, mês já começado (só os slots restantes) e mês passado.
 *   2. POST /api/ai/calendar: cliente com pacote → slots do sistema com contentKind e o tipo de
 *      cada slot no prompt; cliente "completa" (antigo) → comportamento de antes, sem `package`.
 *   3. POST /api/ai/calendar/commit grava posts.content_kind (inclui a réplica do story);
 *      POST /api/ai/calendar/regenerate com contentKind mantém o formato do slot.
 *
 * IA falsa (fetch do Gemini interceptado — nenhuma rede real), Prisma/sessão/Drive falsos.
 */
import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const CLIENT_ID = "99999999-9999-4999-8999-99999999f15a";
const USER_ID = "00000000-0000-4000-8000-0000000f15a1";

process.env.GEMINI_API_KEY = "chave-falsa-do-teste";

type ClientFake = {
  id: string;
  name: string;
  toneOfVoice: string | null;
  briefing: null;
  driveFolderId: null;
  tier: string;
  carouselFrequency: string;
  reelsWeekday: number | null;
  socialAccounts: { platform: string }[];
};

const state = {
  session: { user: { id: USER_ID, role: "staff" } } as { user: { id: string; role: string } } | null,
  client: null as ClientFake | null,
  prompts: [] as string[],
  aiAnswer: null as unknown,
  created: [] as Record<string, unknown>[],
};

const fakePrisma = {
  client: {
    findUnique: async ({ where }: { where: { id: string } }) => (where.id === CLIENT_ID ? state.client : null),
  },
  appSetting: { findUnique: async () => null },
  schedule: { findFirst: async () => null },
  post: { findMany: async () => [] },
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      schedule: { create: async () => ({ id: "sched-f15", status: "rascunho" }) },
      post: {
        findMany: async () => [],
        createManyAndReturn: async ({ data }: { data: Record<string, unknown>[] }) => {
          state.created.push(...data);
          return data.map((d, i) => ({
            id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
            theme: d.theme,
            format: d.format,
            captions: d.captions ?? null,
            slides: d.slides ?? null,
          }));
        },
      },
    }),
};

/** IA falsa: guarda o prompt e devolve `state.aiAnswer` (ou uma ideia por slot numerado do prompt). */
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  assert.match(url, /^https:\/\/generativelanguage\.googleapis\.com\//, `rede real bloqueada no teste: ${url}`);
  const body = JSON.parse(String(init?.body ?? "{}"));
  const prompt: string =
    body.contents?.map((c: { parts: { text: string }[] }) => c.parts.map((p) => p.text).join("")).join("\n") ?? "";
  state.prompts.push(prompt);
  const slots = [...prompt.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
  const answer =
    state.aiAnswer ??
    {
      posts: slots.map((n) => ({ slot: n, theme: `Tema do slot ${n}`, explanation: `Explicação ${n}`, format: "carrossel" })),
    };
  return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] });
}) as typeof fetch;

const FAKE_MODULES: Record<string, string> = {
  "next/server":
    "export class NextRequest extends Request {} export class NextResponse extends Response {}" +
    " export const after = () => {};",
  "@/auth": "export const auth = async () => globalThis.__f15pac.state.session;",
  "@/lib/prisma": "export const prisma = globalThis.__f15pac.prisma;",
  "@/generated/prisma/client":
    "export const Prisma = { AnyNull: { __anyNull: true }, DbNull: { __dbNull: true }, JsonNull: { __jsonNull: true } };",
  "@/lib/drive-sync":
    "export const prepareClientDriveFolders = async () => ({}); export const spMonthKey = (d) => d.toISOString().slice(0, 7);",
};
type ResolveHook = (
  specifier: string,
  context: unknown,
  nextResolve: (specifier: string, context: unknown) => unknown
) => unknown;
const { registerHooks } = nodeModule as unknown as { registerHooks: (hooks: { resolve: ResolveHook }) => void };
(globalThis as unknown as { __f15pac: unknown }).__f15pac = { state, prisma: fakePrisma };
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in FAKE_MODULES) {
      return { url: `data:text/javascript,${encodeURIComponent(FAKE_MODULES[specifier])}`, shortCircuit: true };
    }
    if (specifier.startsWith("@/")) {
      return { url: pathToFileURL(path.join(SRC, `${specifier.slice(2)}.ts`)).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const pk = await import("../../src/lib/content-packages.ts");
const { resetRateLimitsForTests } = await import("../../src/lib/rate-limit.ts");
const calendar = await import("../../src/app/api/ai/calendar/route.ts");
const commit = await import("../../src/app/api/ai/calendar/commit/route.ts");
const regenerate = await import("../../src/app/api/ai/calendar/regenerate/route.ts");

console.error = () => {};
console.warn = () => {};
console.info = () => {};
console.log = () => {};

// ------------------------------------------------------------ helpers

type Slot = (typeof pk)["buildPackageSlots"] extends (...a: never[]) => { slots: (infer S)[] } ? S : never;

const BEFORE = { year: 2026, month: 10, day: 20 }; // "hoje" antes do mês testado
const wdOf = (s: { date: string }) => {
  const [y, m, d] = s.date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};
const dayOf = (s: { date: string }) => Number(s.date.slice(8, 10));
function countKinds(slots: Slot[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of slots) out[s.contentKind] = (out[s.contentKind] ?? 0) + 1;
  return out;
}
function plan(
  tier: "gestao_1" | "gestao_2" | "gestao_3_stories" | "gestao_reels",
  extra: { year?: number; month?: number; carouselFrequency?: string; reelsWeekday?: number | null; today?: typeof BEFORE } = {}
) {
  return pk.buildPackageSlots({
    tier,
    year: extra.year ?? 2026,
    month: extra.month ?? 11,
    carouselFrequency: extra.carouselFrequency ?? "quinzenal",
    reelsWeekday: extra.reelsWeekday === undefined ? 3 : extra.reelsWeekday,
    time: "18:00",
    today: extra.today ?? BEFORE,
  });
}
/** Slots com tipo de feed (não story). */
const feedOf = (slots: Slot[]) => slots.filter((s) => s.format !== "story");

function assertCommon(slots: Slot[]) {
  for (const s of slots) {
    assert.ok(wdOf(s) >= 1 && wdOf(s) <= 5, `${s.date} é dia útil`);
    assert.equal(pk.CONTENT_KIND[s.contentKind].format, s.format, `formato coerente com o tipo (${s.contentKind})`);
  }
  const feedDays = feedOf(slots).map((s) => s.date);
  assert.equal(new Set(feedDays).size, feedDays.length, "no máximo 1 post de feed por dia");
  const sorted = [...slots].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  assert.deepEqual(slots, sorted, "em ordem de data");
}

// ------------------------------------------------------------ 1. gerador de slots

describe("lib/content-packages — slots do mês por pacote", () => {
  test("Gestão 1 quinzenal: 12 posts = 2 carrosséis + 10 estáticos, sem reels, story junto em todos, ~15 dias entre carrosséis", () => {
    const p = plan("gestao_1");
    assertCommon(p.slots);
    assert.equal(p.planned, 12);
    assert.equal(p.slots.length, 12);
    assert.deepEqual(countKinds(p.slots), { carrossel: 2, estatico: 10 });
    assert.ok(p.slots.every((s) => s.withStory && s.time === "18:00"));
    const [c1, c2] = p.slots.filter((s) => s.contentKind === "carrossel").map(dayOf);
    assert.ok(c2 - c1 >= 12 && c2 - c1 <= 18, `carrosséis a ~15 dias (${c1} e ${c2})`);
  });

  test("Gestão 1 semanal: 4 carrosséis + 8 estáticos, 1 carrossel por semana (6 a 9 dias entre eles)", () => {
    const p = plan("gestao_1", { carouselFrequency: "semanal" });
    assertCommon(p.slots);
    assert.deepEqual(countKinds(p.slots), { carrossel: 4, estatico: 8 });
    const days = p.slots.filter((s) => s.contentKind === "carrossel").map(dayOf);
    for (let i = 1; i < days.length; i++) {
      assert.ok(days[i] - days[i - 1] >= 5 && days[i] - days[i - 1] <= 9, `semanal: ${days.join(", ")}`);
    }
  });

  test("Gestão 2: 3 reels de banco no dia escolhido (1 por semana), 1 banner, 2 carrosséis, 6 estáticos", () => {
    const p = plan("gestao_2", { reelsWeekday: 2 });
    assertCommon(p.slots);
    assert.equal(p.slots.length, 12);
    assert.deepEqual(countKinds(p.slots), { reels_banco: 3, banner_animado: 1, carrossel: 2, estatico: 6 });
    const reels = p.slots.filter((s) => s.contentKind === "reels_banco");
    assert.ok(reels.every((s) => wdOf(s) === 2 && s.format === "reels"), "reels às terças");
    const days = reels.map(dayOf);
    for (let i = 1; i < days.length; i++) assert.ok(days[i] - days[i - 1] >= 7, "no máximo 1 reels por semana");
    assert.equal(pk.packageSummary("gestao_2", "quinzenal"), "Gestão 2 · 12 posts: 3 reels, 1 banner, 2 carrosséis, 6 estáticos");
    assert.equal(pk.packageSummary("gestao_2", "semanal"), "Gestão 2 · 12 posts: 3 reels, 1 banner, 4 carrosséis, 4 estáticos");
  });

  test("Gestão 3 (Stories): feed 4 estáticos + 4 reels (1/semana no dia), 8 réplicas, 12 stories exclusivos 09/14/19", () => {
    const p = plan("gestao_3_stories", { reelsWeekday: 4 });
    assertCommon(p.slots);
    assert.equal(p.planned, 20);
    assert.deepEqual(countKinds(p.slots), { estatico: 4, reels: 4, story_exclusivo: 12 });
    const feed = feedOf(p.slots);
    assert.equal(feed.filter((s) => s.withStory).length, 8, "8 réplicas = story junto dos 8 posts de feed");
    assert.ok(feed.filter((s) => s.contentKind === "reels").every((s) => wdOf(s) === 4), "reels às quintas");
    const stories = p.slots.filter((s) => s.contentKind === "story_exclusivo");
    assert.ok(stories.every((s) => s.format === "story" && !s.withStory));
    const byTime = countKinds(stories.map((s) => ({ ...s, contentKind: s.time as never })));
    assert.deepEqual(byTime, { "09:00": 4, "14:00": 4, "19:00": 4 }, "manhã, tarde e noite");
    assert.ok(stories.every((s) => !feed.some((f) => f.date === s.date)), "story exclusivo em dia sem post de feed");
    assert.equal(
      pk.packageSummary("gestao_3_stories", null),
      "Gestão 3 (Stories) · 8 posts: 4 reels, 4 estáticos + 20 stories (8 réplicas, 12 exclusivos)"
    );
  });

  test("Gestão Reels: 4 gravados no dia escolhido, 3 de banco espaçados em outro dia útil, 1 banner", () => {
    const p = plan("gestao_reels", { reelsWeekday: 3 }); // nov/2026: 4 quartas
    assertCommon(p.slots);
    assert.deepEqual(countKinds(p.slots), { reels_gravado: 4, reels_banco: 3, banner_animado: 1 });
    assert.ok(p.slots.filter((s) => s.contentKind === "reels_gravado").every((s) => wdOf(s) === 3));
    const banco = p.slots.filter((s) => s.contentKind === "reels_banco");
    assert.ok(banco.every((s) => wdOf(s) !== 3), "excedentes em outro dia útil");
    const days = banco.map(dayOf);
    for (let i = 1; i < days.length; i++) assert.ok(days[i] - days[i - 1] >= 7, `espaçados: ${days.join(", ")}`);
  });

  test("Gestão Reels num mês com 5 ocorrências do dia: 5 reels no dia (4 gravados + 1 banco) e 2 de banco fora", () => {
    const p = plan("gestao_reels", { year: 2026, month: 12, reelsWeekday: 2 }); // dez/2026: 5 terças
    assertCommon(p.slots);
    const onDay = p.slots.filter((s) => wdOf(s) === 2 && s.format === "reels");
    assert.equal(onDay.length, 5);
    assert.deepEqual(countKinds(onDay), { reels_gravado: 4, reels_banco: 1 });
    assert.equal(p.slots.filter((s) => s.contentKind === "reels_banco" && wdOf(s) !== 2).length, 2);
  });

  test("dia dos reels ausente → quarta (padrão)", () => {
    const p = plan("gestao_2", { reelsWeekday: null });
    assert.ok(p.slots.filter((s) => s.format === "reels" && s.contentKind === "reels_banco").every((s) => wdOf(s) === 3));
  });

  test("mês já começado: só os slots de amanhã em diante, proporcionais; planned = mês inteiro", () => {
    const full = plan("gestao_2", { carouselFrequency: "semanal", reelsWeekday: 2 });
    const partial = plan("gestao_2", { carouselFrequency: "semanal", reelsWeekday: 2, today: { year: 2026, month: 11, day: 15 } });
    assert.equal(partial.planned, 12);
    assert.ok(partial.slots.length > 0 && partial.slots.length < 12);
    assert.ok(partial.slots.every((s) => dayOf(s) >= 16), "nada antes de amanhã");
    assert.deepEqual(
      partial.slots,
      full.slots.filter((s) => dayOf(s) >= 16),
      "os mesmos slots que o mês inteiro teria nesses dias"
    );
    // hoje é o último dia do mês → nada; mês passado → nada
    assert.equal(plan("gestao_1", { today: { year: 2026, month: 11, day: 30 } }).slots.length, 0);
    assert.equal(plan("gestao_1", { today: { year: 2026, month: 12, day: 1 } }).slots.length, 0);
  });

  test("todos os pacotes em 24 meses: contagens exatas sempre (meses de 28 a 31 dias)", () => {
    const expected: Record<string, Record<string, number>> = {
      gestao_1: { carrossel: 2, estatico: 10 },
      gestao_2: { reels_banco: 3, banner_animado: 1, carrossel: 2, estatico: 6 },
      gestao_3_stories: { estatico: 4, reels: 4, story_exclusivo: 12 },
      gestao_reels: { reels_gravado: 4, reels_banco: 3, banner_animado: 1 },
    };
    for (let i = 0; i < 24; i++) {
      const year = 2027 + Math.floor(i / 12);
      const month = (i % 12) + 1;
      for (const tier of pk.PACKAGE_TIERS) {
        for (const reelsWeekday of [1, 2, 3, 4, 5]) {
          const p = plan(tier, { year, month, reelsWeekday, today: BEFORE });
          assertCommon(p.slots);
          assert.deepEqual(countKinds(p.slots), expected[tier], `${tier} ${year}-${month} dia ${reelsWeekday}`);
        }
      }
    }
  });

  test("kindForFormat: troca de formato na revisão mantém um tipo coerente", () => {
    assert.equal(pk.kindForFormat("reels_banco", "reels"), "reels_banco");
    assert.equal(pk.kindForFormat("reels_banco", "feed"), "estatico");
    assert.equal(pk.kindForFormat("estatico", "carrossel"), "carrossel");
    assert.equal(pk.kindForFormat("carrossel", "story"), "story_exclusivo");
    assert.equal(pk.kindForFormat("estatico", "reels"), "reels");
    assert.equal(pk.contentKindLabel("banner_animado"), "Banner animado");
    assert.equal(pk.contentKindLabel("x"), null);
  });

  test("normalizePackageFields: sem reels → null; com reels sem dia → quarta", () => {
    assert.deepEqual(pk.normalizePackageFields("gestao_1", 2), { reelsWeekday: null });
    assert.deepEqual(pk.normalizePackageFields("basica", 2), { reelsWeekday: null });
    assert.deepEqual(pk.normalizePackageFields("completa", 2), { reelsWeekday: null });
    assert.deepEqual(pk.normalizePackageFields("gestao_2", null), { reelsWeekday: 3 });
    assert.deepEqual(pk.normalizePackageFields("gestao_reels", 5), { reelsWeekday: 5 });
  });
});

// ------------------------------------------------------------ 2/3. rotas

let ip = 0;
function req(url: string, body: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.77.0.${(++ip % 250) + 1}` },
    body: JSON.stringify(body),
  });
}
function client(tier: string, extra: Partial<ClientFake> = {}): ClientFake {
  return {
    id: CLIENT_ID,
    name: "ZZ QA F15 Pacotes",
    toneOfVoice: null,
    briefing: null,
    driveFolderId: null,
    tier,
    carouselFrequency: "quinzenal",
    reelsWeekday: 3,
    socialAccounts: [{ platform: "instagram" }],
    ...extra,
  };
}

beforeEach(() => {
  resetRateLimitsForTests();
  state.prompts = [];
  state.aiAnswer = null;
  state.created = [];
});

describe("POST /api/ai/calendar — slots do pacote", () => {
  for (const [tier, total, kinds] of [
    ["gestao_1", 12, { carrossel: 2, estatico: 10 }],
    ["gestao_2", 12, { reels_banco: 3, banner_animado: 1, carrossel: 2, estatico: 6 }],
    ["gestao_3_stories", 20, { estatico: 4, reels: 4, story_exclusivo: 12 }],
    ["gestao_reels", 8, { reels_gravado: 4, reels_banco: 3, banner_animado: 1 }],
  ] as const) {
    test(`${tier}: ${total} slots com tipo, formato do slot (não o da IA) e o tipo no prompt`, async () => {
      state.client = client(tier);
      const res = await calendar.POST(req("/api/ai/calendar", { clientId: CLIENT_ID, month: "2099-03", time: "17:30" }) as never);
      assert.equal(res.status, 200);
      const data = (await res.json()) as {
        posts: { theme: string; format: string; contentKind: string; withStory: boolean; scheduledAt: string }[];
        package: { label: string; planned: number; generated: number; summary: string };
      };
      assert.equal(data.posts.length, total);
      const counts: Record<string, number> = {};
      for (const p of data.posts) counts[p.contentKind] = (counts[p.contentKind] ?? 0) + 1;
      assert.deepEqual(counts, kinds);
      for (const p of data.posts) {
        assert.equal(p.format, pk.CONTENT_KIND[p.contentKind as keyof typeof pk.CONTENT_KIND].format, "formato do slot");
        assert.match(p.theme, /^Tema do slot \d+$/);
        if (p.format !== "story") assert.match(p.scheduledAt, /T20:30:00\.000Z$/, "17:30 em São Paulo");
      }
      assert.equal(data.package.planned, total);
      assert.equal(data.package.generated, total);
      assert.equal(state.prompts.length, 1);
      assert.match(state.prompts[0], new RegExp(`EXATAMENTE ${total} ideias, UMA PARA CADA slot`));
      if (tier === "gestao_2") assert.match(state.prompts[0], /REELS DE BANCO DE IMAGENS/);
      if (tier === "gestao_reels") assert.match(state.prompts[0], /REELS GRAVADO/);
      if (tier === "gestao_3_stories") {
        assert.match(state.prompts[0], /STORY EXCLUSIVO/);
        assert.ok(data.posts.filter((p) => p.format === "story").every((p) => !p.withStory));
      }
    });
  }

  test("a IA devolve menos ideias: os slots continuam todos, os sem ideia ficam sem título", async () => {
    state.client = client("gestao_1");
    state.aiAnswer = { posts: [{ slot: 2, theme: "Só o segundo", explanation: "x" }] };
    const res = await calendar.POST(req("/api/ai/calendar", { clientId: CLIENT_ID, month: "2099-03" }) as never);
    assert.equal(res.status, 200);
    const data = (await res.json()) as { posts: { theme: string }[] };
    assert.equal(data.posts.length, 12);
    assert.equal(data.posts[1].theme, "Só o segundo");
    assert.equal(data.posts.filter((p) => p.theme === "").length, 11);
  });

  test("cliente 'completa' (antigo): comportamento de antes — formato da IA, sem tipo e sem `package`", async () => {
    state.client = client("completa", { reelsWeekday: null });
    state.aiAnswer = { posts: [{ theme: "A", format: "carrossel", explanation: "e" }, { theme: "B", format: "reels", explanation: "e" }] };
    const res = await calendar.POST(req("/api/ai/calendar", { clientId: CLIENT_ID, month: "2099-03", count: 2 }) as never);
    assert.equal(res.status, 200);
    const data = (await res.json()) as { posts: Record<string, unknown>[]; package?: unknown };
    assert.equal(data.package, undefined);
    assert.deepEqual(
      data.posts.map((p) => [p.format, "contentKind" in p]),
      [
        ["carrossel", false],
        ["reels", false],
      ]
    );
    assert.doesNotMatch(state.prompts[0], /slot/);
  });

  test("mês passado com pacote → 400 pt-BR, sem chamar a IA", async () => {
    state.client = client("gestao_2");
    const res = await calendar.POST(req("/api/ai/calendar", { clientId: CLIENT_ID, month: "2020-01" }) as never);
    assert.equal(res.status, 400);
    assert.match(String(((await res.json()) as { error: string }).error), /não tem mais datas futuras/);
    assert.equal(state.prompts.length, 0);
  });
});

describe("POST /api/ai/calendar/commit e /regenerate — tipo do slot", () => {
  test("commit grava content_kind (post e réplica do story); sem tipo → null", async () => {
    state.client = client("gestao_2");
    const base = { theme: "Tema", targets: ["instagram"], captions: { instagram: "Legenda" } };
    const res = await commit.POST(
      req("/api/ai/calendar/commit", {
        clientId: CLIENT_ID,
        month: "2099-03",
        posts: [
          { ...base, format: "reels", contentKind: "reels_banco", scheduledAt: "2099-03-04T21:00:00.000Z" },
          { ...base, format: "story", contentKind: "story_replica", scheduledAt: "2099-03-04T21:15:00.000Z" },
          { ...base, format: "feed", scheduledAt: "2099-03-06T21:00:00.000Z" },
        ],
      }) as never
    );
    assert.equal(res.status, 201);
    assert.deepEqual(
      state.created.map((p) => [p.format, p.contentKind]),
      [
        ["reels", "reels_banco"],
        ["story", "story_replica"],
        ["feed", null],
      ]
    );
  });

  test("commit com tipo desconhecido → 400, nada gravado", async () => {
    state.client = client("gestao_2");
    const res = await commit.POST(
      req("/api/ai/calendar/commit", {
        clientId: CLIENT_ID,
        month: "2099-03",
        posts: [{ theme: "T", targets: ["instagram"], format: "feed", contentKind: "video_longo", scheduledAt: "2099-03-04T21:00:00.000Z" }],
      }) as never
    );
    assert.equal(res.status, 400);
    assert.equal(state.created.length, 0);
  });

  test("regenerate com contentKind: o tipo vai no prompt e o formato é o do slot (não o da IA)", async () => {
    state.client = client("gestao_reels");
    state.aiAnswer = { theme: "Ideia nova", format: "carrossel", explanation: "e" };
    const res = await regenerate.POST(
      req("/api/ai/calendar/regenerate", { clientId: CLIENT_ID, targets: ["instagram"], contentKind: "banner_animado" }) as never
    );
    assert.equal(res.status, 200);
    const data = (await res.json()) as { format: string; theme: string };
    assert.equal(data.format, "reels");
    assert.equal(data.theme, "Ideia nova");
    assert.match(state.prompts[0], /BANNER ANIMADO/);
  });
});
