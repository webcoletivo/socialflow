/**
 * F17: marcar/desmarcar um post como POSTADO à mão — PATCH /api/posts/[id]/posted
 * (calendário do /design, enquanto a equipe posta direto nas redes).
 *   - sem sessão → 401 pt-BR e nenhuma consulta ao banco;
 *   - id ou corpo inválido → 400 pt-BR, banco intocado;
 *   - posted=true: draft/scheduled/failed → published + posted_manually_at=agora + posted_by;
 *     já publicado → 409; publicando agora → 409; inexistente → 404;
 *   - posted=false: só desmarca marcação manual (volta a draft e limpa os campos);
 *     publicado pelo sistema → 409; não publicado → 409;
 *   - auditoria post.posted_manual / post.unposted_manual; falha do banco → 500 sem texto do Prisma.
 *
 * Técnica do posts-art.test.ts: hooks de módulo trocam Prisma, sessão e auditoria por falsos.
 */
import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type PostRow = { id: string; clientId: string; status: string; postedManuallyAt: Date | null; postedBy: string | null; lastError: string | null };
type UserRow = { id: string; name: string; email: string };
type Session = { user: { id?: string; email?: string | null; role?: string } } | null;
type Where = { id: string; status?: string | { in: string[] }; postedManuallyAt?: { not: null } };

const ANA: UserRow = { id: uid(501), name: "ZZ QA Social Ana", email: "zzqa.ana@example.com" };
const CLIENT = uid(900);

const state = {
  session: { user: { id: ANA.id, email: ANA.email, role: "staff" } } as Session,
  posts: [] as PostRow[],
  users: [ANA] as UserRow[],
  calls: [] as { op: string; args: unknown }[],
  audits: [] as { action: string; targetId?: string | null; clientId?: string | null }[],
  fail: null as Error | null,
};

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function matches(p: PostRow, w: Where): boolean {
  if (!sameId(p.id, w.id)) return false;
  if (typeof w.status === "string" && p.status !== w.status) return false;
  if (w.status && typeof w.status === "object" && !w.status.in.includes(p.status)) return false;
  if (w.postedManuallyAt && p.postedManuallyAt === null) return false;
  return true;
}

const fakePrisma = {
  post: {
    updateMany: async (args: { where: Where; data: Partial<PostRow> }) => {
      state.calls.push({ op: "post.updateMany", args });
      if (state.fail) throw state.fail;
      let count = 0;
      for (const p of state.posts) {
        if (!matches(p, args.where)) continue;
        Object.assign(p, args.data);
        count += 1;
      }
      return { count };
    },
    findUnique: async (args: { where: { id: string } }) => {
      state.calls.push({ op: "post.findUnique", args });
      const p = state.posts.find((x) => sameId(x.id, args.where.id));
      return p ? { status: p.status, postedManuallyAt: p.postedManuallyAt, clientId: p.clientId } : null;
    },
    update: async () => assert.fail("a rota usa updateMany condicionado ao estado"),
  },
  user: {
    findUnique: async (args: { where: { id: string } }) => {
      state.calls.push({ op: "user.findUnique", args });
      if (state.fail) throw state.fail;
      const u = state.users.find((x) => sameId(x.id, args.where.id));
      return u ? { id: u.id, name: u.name } : null;
    },
  },
};

const logs: string[] = [];
console.error = (...args: unknown[]) => {
  logs.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" "));
};

const FAKE_MODULES: Record<string, string> = {
  "next/server": "export class NextRequest extends Request {} export class NextResponse extends Response {}",
  "@/auth": "export const auth = async () => globalThis.__f17posted.state.session;",
  "@/lib/prisma": "export const prisma = globalThis.__f17posted.prisma;",
  "@/lib/audit": "export const audit = async (e) => { globalThis.__f17posted.state.audits.push(e); };",
};
type ResolveHook = (
  specifier: string,
  context: unknown,
  nextResolve: (specifier: string, context: unknown) => unknown
) => unknown;
const { registerHooks } = nodeModule as unknown as { registerHooks: (hooks: { resolve: ResolveHook }) => void };

(globalThis as unknown as { __f17posted: unknown }).__f17posted = { state, prisma: fakePrisma };
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

const { PATCH } = await import("../../src/app/api/posts/[id]/posted/route.ts");

async function call(id: string, body: unknown, raw = false): Promise<{ status: number; json: Record<string, unknown> }> {
  const req = new Request(`http://localhost/api/posts/${id}/posted`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: raw ? (body as string) : JSON.stringify(body),
  });
  const res = await PATCH(req as unknown as Parameters<typeof PATCH>[0], { params: Promise.resolve({ id }) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function assertFriendly(json: Record<string, unknown>, expected: string) {
  assert.equal(json.error, expected);
  assert.doesNotMatch(json.error as string, /Invalid|Expected|Required|received|Prisma|P20\d\d/i);
}

const post = (n: number, status: string, manual: Date | null = null): PostRow => ({
  id: uid(n),
  clientId: CLIENT,
  status,
  postedManuallyAt: manual,
  postedBy: manual ? ANA.id : null,
  lastError: status === "failed" ? "erro antigo" : null,
});

beforeEach(() => {
  state.session = { user: { id: ANA.id, email: ANA.email, role: "staff" } };
  state.posts = [
    post(1, "draft"),
    post(2, "scheduled"),
    post(3, "failed"),
    post(4, "publishing"),
    post(5, "published"), // pelo sistema
    post(6, "published", new Date("2026-10-20T12:00:00Z")), // à mão
  ];
  state.users = [ANA];
  state.calls = [];
  state.audits = [];
  state.fail = null;
  logs.length = 0;
});

describe("PATCH /api/posts/[id]/posted — sessão e validação", () => {
  test("sem sessão → 401 pt-BR e nenhuma consulta ao banco", async () => {
    state.session = null;
    const r = await call(uid(1), { posted: true });
    assert.equal(r.status, 401);
    assertFriendly(r.json, "Sua sessão expirou. Entre de novo.");
    assert.equal(state.calls.length, 0);
  });

  test("id inválido e corpo inválido → 400 pt-BR, banco intocado", async () => {
    assertFriendly((await call("nao-e-uuid", { posted: true })).json, "Post inválido.");
    for (const body of [{}, { posted: "sim" }, null]) {
      const r = await call(uid(1), body);
      assert.equal(r.status, 400);
      assertFriendly(r.json, "Informe se o post foi postado ou não.");
    }
    const raw = await call(uid(1), "{quebrado", true);
    assert.equal(raw.status, 400);
    assert.equal(state.calls.filter((c) => c.op === "post.updateMany").length, 0);
  });
});

describe("PATCH /api/posts/[id]/posted — marcar", () => {
  test("draft, scheduled e failed viram published com quem e quando; auditado", async () => {
    for (const n of [1, 2, 3]) {
      const before = Date.now();
      const r = await call(uid(n), { posted: true });
      assert.equal(r.status, 200);
      assert.equal(r.json.ok, true);
      assert.equal(r.json.status, "published");
      assert.deepEqual(r.json.postedBy, { id: ANA.id, name: ANA.name });
      const at = Date.parse(r.json.postedAt as string);
      assert.ok(at >= before - 5 && at <= Date.now() + 5);
      const p = state.posts.find((x) => x.id === uid(n))!;
      assert.equal(p.status, "published");
      assert.equal(p.postedBy, ANA.id);
      assert.equal(p.postedManuallyAt?.getTime(), at);
      assert.equal(p.lastError, null);
    }
    assert.deepEqual(
      state.audits.map((a) => [a.action, a.targetId, a.clientId]),
      [1, 2, 3].map((n) => ["post.posted_manual", uid(n), CLIENT]),
    );
  });

  test("a condição de estado vai no próprio updateMany (sem corrida)", async () => {
    await call(uid(1), { posted: true });
    const where = (state.calls.find((c) => c.op === "post.updateMany")!.args as { where: Where }).where;
    assert.deepEqual(where.status, { in: ["draft", "scheduled", "failed"] });
  });

  test("já publicado → 409; publicando agora → 409; inexistente → 404; nada muda", async () => {
    const pub = await call(uid(5), { posted: true });
    assert.equal(pub.status, 409);
    assertFriendly(pub.json, "Este post já está publicado.");
    const busy = await call(uid(4), { posted: true });
    assert.equal(busy.status, 409);
    assertFriendly(busy.json, "Este post está sendo publicado pelo sistema agora. Aguarde e recarregue a página.");
    const none = await call(uid(77), { posted: true });
    assert.equal(none.status, 404);
    assertFriendly(none.json, "Post não encontrado.");
    assert.equal(state.posts.find((x) => x.id === uid(4))!.status, "publishing");
    assert.equal(state.audits.length, 0);
  });
});

describe("PATCH /api/posts/[id]/posted — desmarcar", () => {
  test("marcação manual volta para draft e limpa os campos; auditado", async () => {
    const r = await call(uid(6), { posted: false });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, status: "draft", postedAt: null, postedBy: null });
    const p = state.posts.find((x) => x.id === uid(6))!;
    assert.deepEqual([p.status, p.postedManuallyAt, p.postedBy], ["draft", null, null]);
    assert.deepEqual(state.audits.map((a) => a.action), ["post.unposted_manual"]);
  });

  test("publicado pelo sistema não se desmarca; não publicado → 409", async () => {
    const sys = await call(uid(5), { posted: false });
    assert.equal(sys.status, 409);
    assertFriendly(sys.json, "Este post foi publicado pelo sistema e não pode ser desmarcado.");
    assert.equal(state.posts.find((x) => x.id === uid(5))!.status, "published");
    const draft = await call(uid(1), { posted: false });
    assert.equal(draft.status, 409);
    assertFriendly(draft.json, "Este post não está marcado como postado.");
    assert.equal(state.audits.length, 0);
  });
});

describe("PATCH /api/posts/[id]/posted — falha do banco", () => {
  test("500 pt-BR sem o texto do Prisma; detalhe só no log", async () => {
    state.fail = new Error("P2024 Timed out fetching a new connection");
    const r = await call(uid(1), { posted: true });
    assert.equal(r.status, 500);
    assertFriendly(r.json, "Não foi possível atualizar a postagem agora. Tente de novo.");
    assert.ok(logs.some((l) => l.includes("[posts/posted]")));
  });
});
