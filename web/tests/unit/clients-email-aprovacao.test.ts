/**
 * F15-PACOTES (20/10): e-mail principal repetível em QUALQUER plano — POST /api/clients e
 * PATCH /api/clients/[id]. O índice parcial uq_clients_email_aprovacao foi removido
 * (system/migrations/2026-10-20-pacotes-gestao.sql): há clientes em que a aprovação vai para uma
 * única pessoa (ex.: Mania de Passar), então dois clientes COM aprovação podem ter o mesmo e-mail.
 *   - com aprovação + e-mail de outro cliente com aprovação (maiúsculas diferentes) → 201/200;
 *   - sem aprovação continua podendo repetir (ex.: o e-mail da agência) → 201/200;
 *   - trocar o plano sem → com aprovação com e-mail repetido → 200 (e "publica? → Não" ainda
 *     devolve os posts da fila para draft na mesma transação).
 * Também os campos do pacote de gestão no cadastro: tier novo (padrão gestao_1), frequência de
 * carrossel e dia dos reels coerente com o pacote (sem reels → null; com reels sem dia → quarta).
 *
 * Técnica do posts-art.test.ts: hooks de módulo trocam Prisma e a sessão (@/auth) por versões
 * falsas em memória. O banco falso NÃO tem unicidade em e-mail (como o banco depois da migração).
 */
import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// ------------------------------------------------------------ banco e sessão falsos

type ClientRow = {
  id: string;
  name: string;
  email: string;
  plan: string;
  tier: string;
  carouselFrequency: string;
  reelsWeekday: number | null;
  status: string;
  agencyPublishes: boolean;
  extraEmails: string[];
  credentialsEnc: string | null;
};
type PostRow = { id: string; clientId: string; status: string };
type Session = { user: { id?: string; email?: string | null; role?: string } } | null;

class PrismaClientKnownRequestError extends Error {
  code: string;
  constructor(message: string, opts: { code: string }) {
    super(message);
    this.name = "PrismaClientKnownRequestError";
    this.code = opts.code;
  }
}

const AGENCIA = "zzqa.agencia@example.com"; // fictício (o caso real é o e-mail @coletivoestudio.com.br)

const state = {
  session: { user: { id: uid(900), email: "zzqa.admin@example.com", role: "admin" } } as Session,
  clients: [] as ClientRow[],
  posts: [] as PostRow[],
  calls: [] as string[],
};

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
let nextId = 100;

function clientDelegate() {
  return {
    create: async (args: { data: Record<string, unknown> }) => {
      state.calls.push("client.create");
      const row: ClientRow = {
        id: uid(nextId++),
        name: String(args.data.name),
        email: String(args.data.email),
        plan: (args.data.plan as string | undefined) ?? "sem_aprovacao",
        tier: (args.data.tier as string | undefined) ?? "completa",
        carouselFrequency: (args.data.carouselFrequency as string | undefined) ?? "quinzenal",
        reelsWeekday: (args.data.reelsWeekday as number | null | undefined) ?? null,
        status: (args.data.status as string | undefined) ?? "ativo",
        agencyPublishes: (args.data.agencyPublishes as boolean | undefined) ?? true,
        extraEmails: (args.data.extraEmails as string[] | undefined) ?? [],
        credentialsEnc: null,
      };
      state.clients.push(row);
      return { ...row };
    },
    findUnique: async (args: { where: { id: string } }) => {
      state.calls.push("client.findUnique");
      const c = state.clients.find((x) => sameId(x.id, args.where.id));
      return c ? { ...c, extraEmails: [...c.extraEmails] } : null;
    },
    update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      state.calls.push("client.update");
      const i = state.clients.findIndex((x) => sameId(x.id, args.where.id));
      if (i < 0) throw new PrismaClientKnownRequestError("Record not found", { code: "P2025" });
      const next = { ...state.clients[i], ...args.data } as ClientRow;
      state.clients[i] = next;
      return { ...next };
    },
  };
}

const postDelegate = {
  updateMany: async (args: { where: { clientId: string; status: { in: string[] } }; data: { status: string } }) => {
    state.calls.push("post.updateMany");
    let count = 0;
    for (const p of state.posts) {
      if (sameId(p.clientId, args.where.clientId) && args.where.status.in.includes(p.status)) {
        p.status = args.data.status;
        count += 1;
      }
    }
    return { count };
  },
};

const fakePrisma = {
  client: clientDelegate(),
  post: postDelegate,
  user: { findUnique: async () => assert.fail("nenhum teste manda redatora/designer") },
  // transação de verdade: em erro, desfaz tudo o que o callback gravou
  $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    state.calls.push("$transaction");
    const snapshot = structuredClone({ clients: state.clients, posts: state.posts });
    try {
      return await fn({ client: fakePrisma.client, post: postDelegate });
    } catch (e) {
      state.clients = snapshot.clients;
      state.posts = snapshot.posts;
      throw e;
    }
  },
};

const logs: string[] = [];
console.error = (...args: unknown[]) => {
  logs.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" "));
};

// ------------------------------------------------------------ hooks de módulo

const FAKE_MODULES: Record<string, string> = {
  "next/server": "export class NextRequest extends Request {} export class NextResponse extends Response {}",
  "@/auth": "export const auth = async () => globalThis.__f15email.state.session;",
  "@/lib/prisma": "export const prisma = globalThis.__f15email.prisma;",
  "@/generated/prisma/client": "export const Prisma = globalThis.__f15email.Prisma;",
  "@/lib/basic-plan": "export const scheduleAllBasicMonths = async () => ({ scheduled: 0 });",
};
type ResolveHook = (
  specifier: string,
  context: unknown,
  nextResolve: (specifier: string, context: unknown) => unknown
) => unknown;
const { registerHooks } = nodeModule as unknown as { registerHooks: (hooks: { resolve: ResolveHook }) => void };

(globalThis as unknown as { __f15email: unknown }).__f15email = {
  state,
  prisma: fakePrisma,
  Prisma: { PrismaClientKnownRequestError },
};
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

const { POST } = await import("../../src/app/api/clients/route.ts");
const { PATCH } = await import("../../src/app/api/clients/[id]/route.ts");
const clientEmails = await import("../../src/lib/client-emails.ts");

// ------------------------------------------------------------ helpers

type Result = { status: number; json: Record<string, unknown> };

async function create(body: Record<string, unknown>): Promise<Result> {
  const req = new Request("http://localhost/api/clients", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await POST(req as unknown as Parameters<typeof POST>[0]);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function patch(id: string, body: Record<string, unknown>): Promise<Result> {
  const req = new Request(`http://localhost/api/clients/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await PATCH(req as unknown as Parameters<typeof PATCH>[0], { params: Promise.resolve({ id }) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function row(id: string): ClientRow {
  const c = state.clients.find((x) => sameId(x.id, id));
  assert.ok(c, `cliente ${id} existe`);
  return c;
}

const COM_APROVACAO = uid(1); // ZZ QA F15 Com — com aprovação, e-mail próprio
const SEM_AGENCIA = uid(2); // ZZ QA F15 Sem — sem aprovação, e-mail da agência
const SEM_OUTRO = uid(3); // ZZ QA F15 Sem 2 — sem aprovação, e-mail do cliente "Com"

beforeEach(() => {
  state.session = { user: { id: uid(900), email: "zzqa.admin@example.com", role: "admin" } };
  const base = {
    tier: "completa",
    carouselFrequency: "quinzenal",
    reelsWeekday: null,
    status: "ativo",
    agencyPublishes: true,
    extraEmails: [],
    credentialsEnc: null,
  };
  state.clients = [
    { ...base, id: COM_APROVACAO, name: "ZZ QA F15 Com", email: "zzqa.com@example.com", plan: "aprovacao_cliente" },
    { ...base, id: SEM_AGENCIA, name: "ZZ QA F15 Sem", email: AGENCIA, plan: "sem_aprovacao" },
    { ...base, id: SEM_OUTRO, name: "ZZ QA F15 Sem 2", email: "zzqa.com@example.com", plan: "sem_aprovacao" },
  ];
  state.posts = [
    { id: uid(51), clientId: SEM_OUTRO, status: "scheduled" },
    { id: uid(52), clientId: SEM_OUTRO, status: "failed" },
  ];
  state.calls = [];
  logs.length = 0;
});

// ------------------------------------------------------------ e-mail repetido

describe("POST /api/clients — e-mail principal repetível em qualquer plano", () => {
  test("com aprovação e e-mail de outro cliente com aprovação (maiúsculas diferentes) → 201", async () => {
    const r = await create({ name: "ZZ QA F15 Mania", email: "ZZQA.Com@Example.com", plan: "aprovacao_cliente" });
    assert.equal(r.status, 201);
    assert.equal(r.json.plan, "aprovacao_cliente");
    assert.equal(state.clients.length, 4);
    assert.equal(
      state.clients.filter((c) => c.plan === "aprovacao_cliente" && c.email.toLowerCase() === "zzqa.com@example.com").length,
      2,
      "dois clientes com aprovação com o mesmo e-mail"
    );
  });

  test("sem aprovação com e-mail já usado por outro cliente (o da agência) → 201", async () => {
    const r = await create({ name: "ZZ QA F15 Novo", email: AGENCIA, plan: "sem_aprovacao" });
    assert.equal(r.status, 201);
    assert.equal(r.json.email, AGENCIA);
    assert.equal(state.clients.filter((c) => c.email === AGENCIA).length, 2);
  });

  test("a mensagem antiga de e-mail repetido não existe mais", () => {
    assert.equal("APPROVAL_EMAIL_TAKEN" in clientEmails, false);
  });
});

describe("PATCH /api/clients/[id] — e-mail principal repetível em qualquer plano", () => {
  test("trocar o plano sem → com aprovação com e-mail de outro com aprovação → 200, e 'publica? → Não' reverte a fila", async () => {
    const r = await patch(SEM_OUTRO, { plan: "aprovacao_cliente", agencyPublishes: false });
    assert.equal(r.status, 200);
    assert.equal(row(SEM_OUTRO).plan, "aprovacao_cliente");
    assert.equal(r.json.revertedToDraft, 2);
    assert.deepEqual(
      state.posts.map((p) => p.status),
      ["draft", "draft"]
    );
  });

  test("com aprovação trocando para o e-mail de outro com aprovação → 200 e grava", async () => {
    const r1 = await create({ name: "ZZ QA F15 Com 3", email: "zzqa.com3@example.com", plan: "aprovacao_cliente" });
    assert.equal(r1.status, 201);
    const r = await patch(String(r1.json.id), { email: "zzqa.com@example.com" });
    assert.equal(r.status, 200);
    assert.equal(row(String(r1.json.id)).email, "zzqa.com@example.com");
  });
});

// ------------------------------------------------------------ pacote de gestão no cadastro

describe("POST /api/clients — pacote de gestão", () => {
  test("sem tier → Gestão 1, carrossel quinzenal, sem dia de reels", async () => {
    const r = await create({ name: "ZZ QA F15 G1", email: "zzqa.g1@example.com" });
    assert.equal(r.status, 201);
    assert.equal(r.json.tier, "gestao_1");
    assert.equal(r.json.carouselFrequency, "quinzenal");
    assert.equal(r.json.reelsWeekday, null);
  });

  test("Gestão 1 com dia de reels → gravado como null (pacote sem reels)", async () => {
    const r = await create({ name: "ZZ QA F15 G1b", email: "zzqa.g1@example.com", tier: "gestao_1", reelsWeekday: 2, carouselFrequency: "semanal" });
    assert.equal(r.status, 201);
    assert.equal(r.json.reelsWeekday, null);
    assert.equal(r.json.carouselFrequency, "semanal");
  });

  test("Gestão 2 sem dia → quarta (3); Gestão Reels com sexta → 5", async () => {
    const a = await create({ name: "ZZ QA F15 G2", email: "zzqa.g2@example.com", tier: "gestao_2" });
    assert.equal(a.status, 201);
    assert.equal(a.json.reelsWeekday, 3);
    const b = await create({ name: "ZZ QA F15 GR", email: "zzqa.gr@example.com", tier: "gestao_reels", reelsWeekday: 5 });
    assert.equal(b.status, 201);
    assert.equal(b.json.reelsWeekday, 5);
  });

  test("tier, frequência ou dia inválidos → 400, nada criado", async () => {
    for (const extra of [{ tier: "premium" }, { carouselFrequency: "mensal" }, { tier: "gestao_2", reelsWeekday: 6 }]) {
      const r = await create({ name: "ZZ QA F15 X", email: "zzqa.x@example.com", ...extra });
      assert.equal(r.status, 400, JSON.stringify(extra));
    }
    assert.equal(state.clients.length, 3);
  });
});

describe("PATCH /api/clients/[id] — pacote de gestão", () => {
  test("completa (antigo) → Gestão 3 (Stories) com terça: grava tier e dia", async () => {
    const r = await patch(COM_APROVACAO, { tier: "gestao_3_stories", reelsWeekday: 2 });
    assert.equal(r.status, 200);
    assert.equal(row(COM_APROVACAO).tier, "gestao_3_stories");
    assert.equal(row(COM_APROVACAO).reelsWeekday, 2);
  });

  test("trocar para Básica limpa o dia dos reels; mandar só o dia num pacote sem reels também fica null", async () => {
    await patch(COM_APROVACAO, { tier: "gestao_reels", reelsWeekday: 4 });
    assert.equal(row(COM_APROVACAO).reelsWeekday, 4);
    const r = await patch(COM_APROVACAO, { tier: "basica" });
    assert.equal(r.status, 200);
    assert.equal(row(COM_APROVACAO).reelsWeekday, null);
    await patch(COM_APROVACAO, { tier: "gestao_1" });
    const r2 = await patch(COM_APROVACAO, { reelsWeekday: 1 });
    assert.equal(r2.status, 200);
    assert.equal(row(COM_APROVACAO).reelsWeekday, null);
  });

  test("salvar um cliente 'completa' sem mudar o tier continua aceito (cadastro antigo)", async () => {
    const r = await patch(SEM_AGENCIA, { tier: "completa", name: "ZZ QA F15 Sem (renomeado)" });
    assert.equal(r.status, 200);
    assert.equal(row(SEM_AGENCIA).tier, "completa");
    assert.equal(row(SEM_AGENCIA).reelsWeekday, null);
  });
});
