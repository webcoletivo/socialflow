/**
 * F16: calendário do /design (app/(app)/design/design-calendar.ts), no modelo da planilha
 * "Controle de Gestão":
 *   - metade da arte: feita / a fazer / captação (reels gravado sem arte);
 *   - metade da postagem: publicado, falhou, agendado, aguardando aprovação, a postar;
 *   - seções: com aprovação ("fazer primeiro") no topo; clientes sem post também viram linha;
 *   - dias do mês (hoje, fim de semana, âncora de rolagem) e contagens.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  artCellOf,
  buildCalendar,
  monthDays,
  postStateOf,
  type CalendarClient,
} from "../../src/app/(app)/design/design-calendar.ts";
import type { DesignRow } from "../../src/app/(app)/design/design-view.ts";

const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b1";
const C = "00000000-0000-4000-8000-0000000000c1";
const sp = (s: string) => new Date(`${s}-03:00`).toISOString();

const clients: CalendarClient[] = [
  { id: B, name: "ZZ QA Beta", designer: null, withApproval: false, agencyPublishes: true },
  { id: A, name: "ZZ QA Alfa", designer: { id: "d1", name: "Ryan" }, withApproval: true, agencyPublishes: true },
  { id: C, name: "ZZ QA Caixa", designer: null, withApproval: false, agencyPublishes: false },
];

function row(over: Partial<DesignRow> & { id: string; scheduledAt: string; clientId?: string }): DesignRow {
  const { clientId = A, ...rest } = over;
  const client = clients.find((c) => c.id === clientId)!;
  return {
    theme: "Tema",
    format: "feed",
    status: "draft",
    client: { id: client.id, name: client.name },
    designer: client.designer,
    mine: false,
    stage: "texto_ok",
    artStatus: "a_fazer",
    artSource: null,
    artDoneAt: null,
    artDoneBy: null,
    hasMedia: false,
    late: false,
    drive: null,
    ...rest,
  };
}

describe("design-calendar: metades do marcador", () => {
  test("arte: feita, a fazer e captação (reels gravado sem arte)", () => {
    assert.equal(artCellOf({ artStatus: "feita" }), "feita");
    assert.equal(artCellOf({ artStatus: "feita", contentKind: "reels_gravado" }), "feita");
    assert.equal(artCellOf({ artStatus: "a_fazer" }), "a_fazer");
    assert.equal(artCellOf({ artStatus: "a_fazer", contentKind: "reels_gravado" }), "captacao");
    assert.equal(artCellOf({ artStatus: "a_fazer", contentKind: "reels_banco" }), "a_fazer");
  });

  test("postagem: status do post vale mais; depois aprovação do cliente", () => {
    assert.equal(postStateOf({ status: "published", stage: "texto_ok" }, true), "publicado");
    assert.equal(postStateOf({ status: "failed", stage: "texto_ok" }, false), "falhou");
    assert.equal(postStateOf({ status: "scheduled", stage: "em_aprovacao" }, true), "agendado");
    assert.equal(postStateOf({ status: "publishing", stage: "texto_ok" }, false), "agendado");
    assert.equal(postStateOf({ status: "draft", stage: "em_aprovacao" }, true), "aguardando");
    assert.equal(postStateOf({ status: "draft", stage: "tema_aprovado" }, true), "aguardando");
    assert.equal(postStateOf({ status: "draft", stage: "post_aprovado" }, true), "a_postar");
    assert.equal(postStateOf({ status: "draft", stage: "texto_ok" }, false), "a_postar");
  });
});

describe("design-calendar: dias do mês", () => {
  test("outubro/2026: 31 dias, hoje e âncora em hoje − 2", () => {
    const days = monthDays("2026-10", "2026-10-21");
    assert.equal(days.length, 31);
    assert.deepEqual(days[0], {
      day: 1,
      weekday: "qui",
      weekdayFull: "quinta-feira",
      weekend: false,
      today: false,
      scrollAnchor: false,
    });
    assert.equal(days.filter((d) => d.today).map((d) => d.day).join(), "21");
    assert.equal(days.filter((d) => d.scrollAnchor).map((d) => d.day).join(), "19");
    assert.equal(days[2].weekend, true); // 03/10 sábado
  });

  test("outro mês: sem hoje nem âncora; fevereiro de 2028 tem 29 dias", () => {
    const days = monthDays("2026-11", "2026-10-21");
    assert.equal(days.some((d) => d.today || d.scrollAnchor), false);
    assert.equal(monthDays("2028-02", "2026-10-21").length, 29);
    assert.equal(monthDays("2026-10", "2026-10-01").find((d) => d.scrollAnchor)?.day, 1);
  });
});

describe("design-calendar: buildCalendar", () => {
  const rows = [
    row({ id: "p3", scheduledAt: sp("2026-10-09T18:00:00"), artStatus: "feita", artSource: "marcada", stage: "em_aprovacao" }),
    row({ id: "p1", scheduledAt: sp("2026-10-09T09:00:00"), format: "story", late: true }),
    row({ id: "p2", clientId: B, scheduledAt: sp("2026-10-14T10:00:00"), status: "published", artStatus: "feita", artSource: "publicado" }),
    row({ id: "p4", clientId: B, scheduledAt: sp("2026-10-20T10:00:00"), format: "reels", contentKind: "reels_gravado" }),
    // 01/11 00:30 em SP = 31/10 03:30 UTC: fica de fora (outro mês em SP)
    row({ id: "fora", scheduledAt: sp("2026-11-01T00:30:00") }),
    // cliente fora da lista (filtro)
    { ...row({ id: "outro", scheduledAt: sp("2026-10-10T10:00:00") }), client: { id: "x", name: "Outro" } },
  ];
  const model = buildCalendar({ month: "2026-10", todayKey: "2026-10-21", clients, rows });

  test("seções: com aprovação primeiro; nomes em ordem; cliente sem post também aparece", () => {
    assert.deepEqual(
      model.sections.map((s) => [s.key, s.rows.map((r) => r.client.name)]),
      [
        ["aprovacao", ["ZZ QA Alfa"]],
        ["sem_aprovacao", ["ZZ QA Beta", "ZZ QA Caixa"]],
      ],
    );
    assert.equal(model.sections[0].title, "Com aprovação · fazer primeiro");
    assert.equal(model.sections[1].rows[1].total, 0);
  });

  test("marcadores no dia (SP), em ordem de horário, com as duas metades", () => {
    const alfa = model.sections[0].rows[0];
    assert.deepEqual(
      alfa.days.get(9)?.map((m) => [m.row.id, m.art, m.post]),
      [
        ["p1", "a_fazer", "aguardando"],
        ["p3", "feita", "aguardando"],
      ],
    );
    assert.equal(alfa.total, 2);
    assert.equal(alfa.artDone, 1);
    const beta = model.sections[1].rows[0];
    assert.deepEqual(
      [...beta.days.entries()].map(([d, list]) => [d, list.map((m) => [m.art, m.post])]),
      [
        [14, [["feita", "publicado"]]],
        [20, [["captacao", "a_postar"]]],
      ],
    );
  });

  test("rótulo acessível diz cliente, data, tipo, tema, arte (atraso) e postagem", () => {
    const p1 = model.sections[0].rows[0].days.get(9)![0];
    assert.equal(p1.ariaLabel, "ZZ QA Alfa, 09/10 às 09:00, Story, Tema, Arte a fazer, arte atrasada, Aguardando aprovação");
    const p4 = model.sections[1].rows[0].days.get(20)![0];
    assert.equal(p4.ariaLabel, "ZZ QA Beta, 20/10 às 10:00, Reels gravado, Tema, Captação, A postar");
  });

  test("contagens só dos posts do mês dos clientes da lista", () => {
    assert.deepEqual(model.counts, { total: 4, artFeita: 2, artAFazer: 2, atrasadas: 1, postados: 1, aguardando: 2 });
  });

  test("sem cliente com aprovação: a seção some", () => {
    const m = buildCalendar({ month: "2026-10", todayKey: "2026-10-21", clients: clients.filter((c) => !c.withApproval), rows: [] });
    assert.deepEqual(m.sections.map((s) => s.key), ["sem_aprovacao"]);
    assert.equal(m.counts.total, 0);
  });
});
