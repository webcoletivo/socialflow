/**
 * F6 DS-A: fila de artes (lib/design-queue.ts) e a regra única da arte (artStatus/hasArt).
 *   - artStatus: "feita" com art_done_at, com mídia (mediaUrl ou mediaItems) ou publicado;
 *   - isArtLate: só arte a fazer, data passada ou a menos de 48 h;
 *   - loadDesignQueue: só clientes ativos, sem publicados, story incluído; filtros (designer, sem
 *     designer, cliente, mês, include); contagens; estágio; nome esperado no Drive; ordem
 *     (atrasados primeiro, depois data); no máximo 3 consultas (sem N+1).
 *
 * Técnica do posts-bulk-delete.test.ts: hooks de módulo trocam o Prisma por um falso em memória.
 */
import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sp = (s: string) => new Date(`${s}-03:00`);

// ------------------------------------------------------------ banco falso

type UserRef = { id: string; name: string };
type ClientRow = { id: string; name: string; plan: string; status: string; designer: UserRef | null };
type PostRow = {
  id: string;
  clientId: string;
  theme: string | null;
  format: string;
  scheduledAt: Date;
  createdAt: Date;
  status: string;
  caption: string | null;
  captions: unknown;
  slides: unknown;
  mediaUrl: string | null;
  mediaItems: unknown;
  clientApproval: string | null;
  weeklyReviewId: string | null;
  artDoneAt: Date | null;
  artDoneByUser: UserRef | null;
  schedule: { status: string } | null;
};
type PostWhere = {
  clientId?: { in: string[] };
  status?: { not: string };
  scheduledAt?: { gte: Date; lt: Date };
};

const state = {
  clients: [] as ClientRow[],
  posts: [] as PostRow[],
  calls: [] as { op: string; args: { where?: unknown; select?: Record<string, unknown> } }[],
};

function matchPost(p: PostRow, where: PostWhere): boolean {
  for (const k of Object.keys(where)) assert.ok(["clientId", "status", "scheduledAt"].includes(k), `where inesperado: ${k}`);
  if (where.clientId && !where.clientId.in.includes(p.clientId)) return false;
  if (where.status && p.status === where.status.not) return false;
  if (where.scheduledAt) {
    if (p.scheduledAt < where.scheduledAt.gte || p.scheduledAt >= where.scheduledAt.lt) return false;
  }
  return true;
}

type OrderBy = Record<string, "asc" | "desc">[];
function sortBy<T extends Record<string, unknown>>(rows: T[], orderBy: OrderBy): T[] {
  return [...rows].sort((a, b) => {
    for (const o of orderBy) {
      const [k, dir] = Object.entries(o)[0];
      const av = a[k] as Date | string;
      const bv = b[k] as Date | string;
      const cmp = av instanceof Date ? av.getTime() - (bv as Date).getTime() : av < bv ? -1 : av > bv ? 1 : 0;
      if (cmp !== 0) return dir === "asc" ? cmp : -cmp;
    }
    return 0;
  });
}

const fakePrisma = {
  client: {
    findMany: async (args: { where: { status: string }; select: Record<string, unknown> }) => {
      state.calls.push({ op: "client.findMany", args });
      assert.deepEqual(args.where, { status: "ativo" });
      return state.clients
        .filter((c) => c.status === args.where.status)
        .map((c) => ({ id: c.id, name: c.name, plan: c.plan, designer: c.designer }));
    },
  },
  post: {
    findMany: async (args: { where: PostWhere; orderBy: OrderBy; select: Record<string, unknown> }) => {
      state.calls.push({ op: "post.findMany", args });
      const rows = sortBy(
        state.posts.filter((p) => matchPost(p, args.where)) as unknown as Record<string, unknown>[],
        args.orderBy
      );
      // devolve só os campos pedidos (o select de verdade)
      return rows.map((r) => Object.fromEntries(Object.keys(args.select).map((k) => [k, r[k]])));
    },
  },
};

// ------------------------------------------------------------ hooks de módulo

const FAKE_MODULES: Record<string, string> = {
  "@/lib/prisma": "export const prisma = globalThis.__f6dq.prisma;",
};
type ResolveHook = (
  specifier: string,
  context: unknown,
  nextResolve: (specifier: string, context: unknown) => unknown
) => unknown;
const { registerHooks } = nodeModule as unknown as { registerHooks: (hooks: { resolve: ResolveHook }) => void };

(globalThis as unknown as { __f6dq: unknown }).__f6dq = { state, prisma: fakePrisma };
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

const dq = await import("../../src/lib/design-queue.ts");
const { artStatus, hasArt, isArtLate, compareDesignItems, loadDesignQueue, DESIGN_LATE_MS } = dq;

// ------------------------------------------------------------ fixtures

const ANA: UserRef = { id: uid(901), name: "ZZ QA Ana" };
const BIA: UserRef = { id: uid(902), name: "ZZ QA Bia" };
const NOW = sp("2026-10-06T12:00:00");

let seq = 0;
function post(clientId: string, at: string, over: Partial<PostRow> = {}): PostRow {
  seq += 1;
  return {
    id: uid(seq),
    clientId,
    theme: `Tema ${seq}`,
    format: "feed",
    scheduledAt: sp(at),
    createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, seq)),
    status: "scheduled",
    caption: null,
    captions: { instagram: "Legenda" },
    slides: null,
    mediaUrl: null,
    mediaItems: null,
    clientApproval: null,
    weeklyReviewId: null,
    artDoneAt: null,
    artDoneByUser: null,
    schedule: null,
    ...over,
  };
}

const C_ALFA = uid(801); // designer Ana, com aprovação
const C_BETA = uid(802); // designer Bia
const C_SEM = uid(803); // sem designer
const C_PAUSADO = uid(804); // pausado: fora da fila

beforeEach(() => {
  seq = 0;
  state.calls = [];
  state.clients = [
    { id: C_BETA, name: "ZZ QA Beta", plan: "sem_aprovacao", status: "ativo", designer: BIA },
    { id: C_ALFA, name: "ZZ QA Alfa", plan: "aprovacao_cliente", status: "ativo", designer: ANA },
    { id: C_SEM, name: "ZZ QA Sem designer", plan: "sem_aprovacao", status: "ativo", designer: null },
    { id: C_PAUSADO, name: "ZZ QA Pausado", plan: "sem_aprovacao", status: "pausado", designer: ANA },
  ];
  state.posts = [];
});

// ------------------------------------------------------------ regra da arte

describe("artStatus / hasArt — regra única", () => {
  test("a fazer: sem marca, sem mídia, não publicado", () => {
    assert.equal(artStatus({ artDoneAt: null, mediaUrl: null, mediaItems: null, status: "scheduled" }), "a_fazer");
    assert.equal(artStatus({}), "a_fazer");
    assert.equal(artStatus({ mediaUrl: "   ", mediaItems: [], status: "draft" }), "a_fazer");
    assert.equal(artStatus({ mediaItems: {}, status: "failed" }), "a_fazer");
  });
  test("feita: marcada pela designer (art_done_at)", () => {
    assert.equal(artStatus({ artDoneAt: new Date(), status: "draft" }), "feita");
    assert.equal(artStatus({ artDoneAt: "2026-10-06T12:00:00.000Z" }), "feita");
  });
  test("feita: com mídia (mediaUrl ou mediaItems não vazio)", () => {
    assert.equal(artStatus({ mediaUrl: "https://r2.example.com/a.jpg" }), "feita");
    assert.equal(artStatus({ mediaItems: [{ url: "x" }] }), "feita");
  });
  test("feita: publicado (a mídia sai do R2 depois de 30 dias)", () => {
    assert.equal(artStatus({ status: "published" }), "feita");
  });
  test("hasArt é o mesmo critério", () => {
    assert.equal(hasArt({ artDoneAt: new Date() }), true);
    assert.equal(hasArt({ status: "scheduled" }), false);
  });
});

describe("isArtLate — 48 h", () => {
  test("a fazer com data passada ou a menos de 48 h → atrasado", () => {
    assert.equal(isArtLate("a_fazer", sp("2026-10-01T09:00:00"), NOW), true);
    assert.equal(isArtLate("a_fazer", new Date(NOW.getTime() + DESIGN_LATE_MS - 60_000), NOW), true);
    assert.equal(isArtLate("a_fazer", new Date(NOW.getTime() + DESIGN_LATE_MS), NOW), false);
    assert.equal(isArtLate("a_fazer", "2026-10-20T12:00:00.000Z", NOW), false);
  });
  test("arte feita nunca atrasa", () => {
    assert.equal(isArtLate("feita", sp("2026-10-01T09:00:00"), NOW), false);
  });
  test("ordem: atrasados primeiro, depois data, empate pelo id", () => {
    const a = { id: "b", late: false, scheduledAt: sp("2026-10-07T09:00:00") };
    const b = { id: "a", late: true, scheduledAt: sp("2026-10-09T09:00:00") };
    const c = { id: "c", late: true, scheduledAt: sp("2026-10-01T09:00:00") };
    const d = { id: "a", late: false, scheduledAt: sp("2026-10-07T09:00:00") };
    assert.deepEqual([a, b, c, d].sort(compareDesignItems), [c, b, d, a]);
  });
});

// ------------------------------------------------------------ loadDesignQueue

describe("loadDesignQueue", () => {
  function seedMonth() {
    state.posts = [
      // Alfa, outubro: 1 (feed) · 1story · 1story2 (avulso) · 2 (carrossel) · 3 (reels)
      post(C_ALFA, "2026-10-02T09:00:00", { format: "feed", status: "published", mediaUrl: "https://x/1.jpg" }),
      post(C_ALFA, "2026-10-02T09:15:00", { format: "story", status: "draft" }),
      post(C_ALFA, "2026-10-05T18:00:00", { format: "story", status: "failed" }),
      post(C_ALFA, "2026-10-07T09:00:00", {
        format: "carrossel",
        caption: null,
        captions: null,
        schedule: { status: "aprovado_cliente" },
      }),
      post(C_ALFA, "2026-10-20T09:00:00", {
        format: "reels",
        artDoneAt: sp("2026-10-05T10:00:00"),
        artDoneByUser: ANA,
        schedule: { status: "aprovado_cliente" },
      }),
      // Beta: com mídia (feita) e a fazer longe
      post(C_BETA, "2026-10-08T09:00:00", { mediaItems: [{ url: "x" }] }),
      post(C_BETA, "2026-10-25T09:00:00"),
      // Sem designer
      post(C_SEM, "2026-10-09T09:00:00"),
      // Pausado: fora
      post(C_PAUSADO, "2026-10-03T09:00:00"),
      // Alfa em novembro (fora do filtro de mês)
      post(C_ALFA, "2026-11-03T09:00:00"),
    ];
  }

  test("padrão (a fazer): só ativos, sem publicados, story incluído; ordem atrasados → data", async () => {
    seedMonth();
    const r = await loadDesignQueue({ now: NOW });
    assert.deepEqual(
      r.items.map((i) => [i.theme, i.late]),
      [
        ["Tema 2", true], // story 02/10 (passado)
        ["Tema 3", true], // story 05/10 (passado)
        ["Tema 4", true], // carrossel 07/10 09:00 (< 48 h)
        ["Tema 8", false], // sem designer 09/10
        ["Tema 7", false], // Beta 25/10
        ["Tema 10", false], // Alfa novembro
      ]
    );
    assert.ok(r.items.every((i) => i.artStatus === "a_fazer" && i.artSource === null));
    assert.ok(!r.items.some((i) => i.client.id === C_PAUSADO), "cliente pausado fica fora");
    // contagens sobre tudo (inclui as feitas, sem os publicados)
    assert.deepEqual(r.counts, { aFazer: 6, feitas: 2, atrasadas: 3, total: 8 });
  });

  test("no máximo 3 consultas, qualquer que seja o tamanho da fila (sem N+1)", async () => {
    seedMonth();
    for (let i = 0; i < 40; i++) state.posts.push(post(C_BETA, `2026-10-${String(10 + (i % 15)).padStart(2, "0")}T10:00:00`));
    await loadDesignQueue({ now: NOW, include: "todas" });
    assert.equal(state.calls.length, 3);
    assert.deepEqual(state.calls.map((c) => c.op), ["client.findMany", "post.findMany", "post.findMany"]);
    // candidatos: nunca publicados
    assert.deepEqual((state.calls[1].args.where as PostWhere).status, { not: "published" });
    // numeração: TODOS os status
    assert.equal((state.calls[2].args.where as PostWhere).status, undefined);
  });

  test("includePublished (calendário): candidatos de qualquer status", async () => {
    seedMonth();
    await loadDesignQueue({ now: NOW, include: "todas", includePublished: true });
    assert.equal((state.calls[1].args.where as PostWhere).status, undefined);
  });

  test("include feitas / todas; artSource e artDoneBy", async () => {
    seedMonth();
    const feitas = await loadDesignQueue({ now: NOW, include: "feitas" });
    assert.deepEqual(
      feitas.items.map((i) => [i.theme, i.artSource, i.artDoneBy?.name ?? null]),
      [
        ["Tema 6", "midia", null],
        ["Tema 5", "marcada", "ZZ QA Ana"],
      ]
    );
    assert.equal(feitas.items[1].artDoneAt?.toISOString(), sp("2026-10-05T10:00:00").toISOString());
    assert.ok(feitas.items.every((i) => !i.late));
    const todas = await loadDesignQueue({ now: NOW, include: "todas" });
    assert.equal(todas.items.length, 8);
    assert.equal(todas.items[0].late, true);
  });

  test("filtro de designer, sem designer, cliente e mês; `mine` pela usuária", async () => {
    seedMonth();
    const ana = await loadDesignQueue({ now: NOW, designerId: ANA.id, userId: ANA.id, month: "2026-10" });
    assert.deepEqual(ana.items.map((i) => i.theme), ["Tema 2", "Tema 3", "Tema 4"]);
    assert.ok(ana.items.every((i) => i.mine && i.designer?.id === ANA.id));
    assert.deepEqual(ana.counts, { aFazer: 3, feitas: 1, atrasadas: 3, total: 4 });

    const sem = await loadDesignQueue({ now: NOW, designerId: null });
    assert.deepEqual(sem.items.map((i) => [i.theme, i.designer, i.mine]), [["Tema 8", null, false]]);

    const beta = await loadDesignQueue({ now: NOW, clientId: C_BETA, userId: ANA.id });
    assert.deepEqual(beta.items.map((i) => [i.theme, i.client.name, i.mine]), [["Tema 7", "ZZ QA Beta", false]]);

    const nov = await loadDesignQueue({ now: NOW, month: "2026-11" });
    assert.deepEqual(nov.items.map((i) => i.theme), ["Tema 10"]);
  });

  test("listas para os filtros: designers e clientes ativos em ordem alfabética", async () => {
    seedMonth();
    const r = await loadDesignQueue({ now: NOW, clientId: C_SEM });
    assert.deepEqual(r.designers, [ANA, BIA]);
    assert.deepEqual(
      r.clients.map((c) => c.name),
      ["ZZ QA Alfa", "ZZ QA Beta", "ZZ QA Sem designer"]
    );
  });

  test("nome esperado no Drive: numeração do mês com TODOS os posts (publicado conta)", async () => {
    seedMonth();
    const r = await loadDesignQueue({ now: NOW, include: "todas", clientId: C_ALFA });
    const byTheme = Object.fromEntries(r.items.map((i) => [i.theme, i.drive]));
    assert.deepEqual(byTheme["Tema 2"], {
      file: "1story.jpg",
      path: "ZZ QA Alfa/2026/10 - Outubro/1story.jpg",
      index: 1,
      storyOrdinal: 1,
    });
    assert.equal(byTheme["Tema 3"]?.file, "1story2.jpg"); // story avulso herda o N=1 → 2º story
    assert.equal(byTheme["Tema 4"]?.path, "ZZ QA Alfa/2026/10 - Outubro/2/"); // carrossel = pasta
    assert.equal(byTheme["Tema 5"]?.file, "3.mp4"); // reels
    assert.deepEqual(byTheme["Tema 10"], {
      file: "1.jpg",
      path: "ZZ QA Alfa/2026/11 - Novembro/1.jpg",
      index: 1,
      storyOrdinal: null,
    });
  });

  test("estágio de produção com a legenda efetiva (N-18)", async () => {
    seedMonth();
    const r = await loadDesignQueue({ now: NOW, include: "todas", clientId: C_ALFA });
    const stage = Object.fromEntries(r.items.map((i) => [i.theme, i.stage]));
    assert.equal(stage["Tema 4"], "sem_texto"); // sem caption nem captions
    assert.equal(stage["Tema 5"], "tema_aprovado"); // captions.instagram + cronograma aprovado (plano com aprovação)
    assert.equal(stage["Tema 2"], "texto_ok");
  });

  test("sem cliente no filtro → 1 consulta só e fila vazia", async () => {
    seedMonth();
    const r = await loadDesignQueue({ now: NOW, designerId: uid(999) });
    assert.equal(r.items.length, 0);
    assert.deepEqual(r.counts, { aFazer: 0, feitas: 0, atrasadas: 0, total: 0 });
    assert.equal(state.calls.length, 1);
  });

  test("mês em formato inválido → RangeError", async () => {
    await assert.rejects(loadDesignQueue({ month: "2026-13" }), RangeError);
    await assert.rejects(loadDesignQueue({ month: "10/2026" }), RangeError);
  });
});
