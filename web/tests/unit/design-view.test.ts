/**
 * F6 DS-B: lógica pura da página /design (app/(app)/design/design-view.ts).
 *   - filtros da URL: padrão "Minhas" só para quem é designer; valores inválidos ignorados;
 *   - URL sem o que está no padrão; contagem de filtros ativos;
 *   - agrupamento por dia (atrasadas no topo; Hoje/Amanhã/Ontem; dia da semana);
 *   - estado otimista (marcar/desmarcar) e as contagens corrigidas;
 *   - textos de atraso e de "feita em".
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  activeFilterCount,
  adjustCounts,
  applyOverride,
  compareRows,
  defaultDesignerFor,
  DESIGNER_ALL,
  DESIGNER_NONE,
  designerIdOption,
  designHref,
  doneWhenText,
  groupByDay,
  lateText,
  lateWarning,
  matchesShow,
  parseDesignParams,
  relativeDayLabel,
  shiftMonth,
  whenParts,
  type DesignRow,
} from "../../src/app/(app)/design/design-view.ts";

const ME = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const CLIENT = "00000000-0000-4000-8000-0000000000c1";
const sp = (s: string) => new Date(`${s}-03:00`).toISOString();
const NOW = Date.parse("2026-10-06T15:00:00-03:00");

function row(over: Partial<DesignRow> & { id: string; scheduledAt: string }): DesignRow {
  return {
    theme: "Tema",
    format: "feed",
    status: "draft",
    client: { id: CLIENT, name: "Cliente" },
    designer: { id: ME, name: "Dev Local" },
    mine: true,
    stage: "texto_ok",
    artStatus: "a_fazer",
    artSource: null,
    artDoneAt: null,
    artDoneBy: null,
    hasMedia: false,
    late: false,
    drive: null,
    ...over,
  };
}

describe("filtros da URL", () => {
  const ctx = {
    currentMonth: "2026-10",
    defaultDesigner: ME,
    designerIds: new Set([ME, OTHER]),
    clientIds: new Set([CLIENT]),
  };

  test("padrão: 'Minhas' só quando a usuária é designer de algum cliente ativo", () => {
    assert.equal(defaultDesignerFor(ME, new Set([ME])), ME);
    assert.equal(defaultDesignerFor(ME, new Set([OTHER])), DESIGNER_ALL);
    assert.equal(defaultDesignerFor(null, new Set([ME])), DESIGNER_ALL);
  });

  test("sem parâmetros: mês atual, designer padrão, a fazer", () => {
    assert.deepEqual(parseDesignParams({}, ctx), {
      mes: "2026-10",
      designer: ME,
      cliente: "",
      mostrar: "a_fazer",
      ver: "lista",
    });
  });

  test("valores válidos passam; inválidos voltam ao padrão", () => {
    assert.deepEqual(
      parseDesignParams({ mes: "2026-11", designer: OTHER, cliente: CLIENT, mostrar: "feitas", ver: "calendario" }, ctx),
      { mes: "2026-11", designer: OTHER, cliente: CLIENT, mostrar: "feitas", ver: "calendario" },
    );
    assert.equal(parseDesignParams({ designer: DESIGNER_NONE }, ctx).designer, DESIGNER_NONE);
    assert.equal(parseDesignParams({ designer: DESIGNER_ALL }, ctx).designer, DESIGNER_ALL);
    assert.deepEqual(
      parseDesignParams({ mes: "2026-13", designer: "x", cliente: "nao-existe", mostrar: "tudo", ver: "grade" }, ctx),
      { mes: "2026-10", designer: ME, cliente: "", mostrar: "a_fazer", ver: "lista" },
    );
    assert.equal(parseDesignParams({ mostrar: ["todas", "feitas"] }, ctx).mostrar, "todas");
  });

  test("designerIdOption: todos = omitido; sem = null; id = id", () => {
    assert.equal(designerIdOption(DESIGNER_ALL), undefined);
    assert.equal(designerIdOption(DESIGNER_NONE), null);
    assert.equal(designerIdOption(OTHER), OTHER);
  });

  test("URL leva só o que está fora do padrão (mês sempre)", () => {
    const v = { mes: "2026-10", designer: ME, cliente: "", mostrar: "a_fazer" as const, ver: "lista" as const };
    assert.equal(designHref(v, ME), "/design?mes=2026-10");
    assert.equal(designHref({ ...v, designer: DESIGNER_ALL }, ME), "/design?mes=2026-10&designer=todos");
    assert.equal(
      designHref({ ...v, designer: DESIGNER_ALL, cliente: CLIENT, mostrar: "todas" }, DESIGNER_ALL),
      `/design?mes=2026-10&cliente=${CLIENT}&mostrar=todas`,
    );
    assert.equal(designHref({ ...v, ver: "calendario" }, ME), "/design?mes=2026-10&ver=calendario");
    assert.equal(activeFilterCount(v, ME), 0);
    assert.equal(activeFilterCount({ ...v, designer: DESIGNER_NONE, cliente: CLIENT }, ME), 2);
  });

  test("shiftMonth vira o ano", () => {
    assert.equal(shiftMonth("2026-12", 1), "2027-01");
    assert.equal(shiftMonth("2026-01", -1), "2025-12");
  });
});

describe("datas e agrupamento", () => {
  test("whenParts no fuso SP", () => {
    assert.deepEqual(whenParts(sp("2026-10-08T18:00:00")), {
      dayKey: "2026-10-08",
      date: "08/10",
      time: "18:00",
      weekday: "quinta",
      weekdayShort: "qui",
    });
    // 01:30 UTC do dia 9 ainda é dia 8 em SP
    assert.equal(whenParts("2026-10-09T01:30:00.000Z").dayKey, "2026-10-08");
    assert.equal(doneWhenText(sp("2026-10-06T15:40:00")), "06/10 às 15:40");
  });

  test("Hoje, Amanhã, Ontem", () => {
    assert.equal(relativeDayLabel("2026-10-06", "2026-10-06"), "Hoje");
    assert.equal(relativeDayLabel("2026-10-07", "2026-10-06"), "Amanhã");
    assert.equal(relativeDayLabel("2026-10-05", "2026-10-06"), "Ontem");
    assert.equal(relativeDayLabel("2026-10-09", "2026-10-06"), null);
  });

  test("atrasadas num grupo próprio no topo; o resto por dia na ordem", () => {
    const rows = [
      row({ id: "a", scheduledAt: sp("2026-10-03T10:00:00"), late: true }),
      row({ id: "b", scheduledAt: sp("2026-10-07T10:00:00"), late: true }),
      row({ id: "c", scheduledAt: sp("2026-10-06T18:00:00"), artStatus: "feita", artSource: "marcada" }),
      row({ id: "d", scheduledAt: sp("2026-10-09T09:00:00") }),
      row({ id: "e", scheduledAt: sp("2026-10-09T19:00:00") }),
    ];
    const groups = groupByDay(rows, "2026-10-06");
    assert.deepEqual(
      groups.map((g) => [g.key, g.title, g.detail, g.items.map((r) => r.id).join("")]),
      [
        ["atrasadas", "Atrasadas", null, "ab"],
        ["2026-10-06", "Hoje", "terça, 06/10", "c"],
        ["2026-10-09", "Sexta, 09/10", null, "de"],
      ],
    );
  });

  test("compareRows: atrasadas primeiro, depois data, depois id", () => {
    const list = [
      row({ id: "z", scheduledAt: sp("2026-10-20T10:00:00") }),
      row({ id: "b", scheduledAt: sp("2026-10-10T10:00:00") }),
      row({ id: "a", scheduledAt: sp("2026-10-10T10:00:00") }),
      row({ id: "l", scheduledAt: sp("2026-10-25T10:00:00"), late: true }),
    ];
    assert.deepEqual(list.sort(compareRows).map((r) => r.id), ["l", "a", "b", "z"]);
  });

  test("texto do atraso", () => {
    assert.equal(lateText(sp("2026-10-06T10:00:00"), NOW), "já passou");
    assert.equal(lateText(sp("2026-10-07T10:30:00"), NOW), "publica em 20 h");
    assert.equal(lateText(sp("2026-10-06T15:30:00"), NOW), "publica em menos de 1 h");
    assert.equal(lateWarning(1), "1 arte atrasada — publicação em menos de 48 h ou já passou");
    assert.equal(lateWarning(3), "3 artes atrasadas — publicação em menos de 48 h ou já passou");
  });
});

describe("estado otimista", () => {
  const by = { id: ME, name: "Dev Local" };

  test("marcar: vira feita/marcada e deixa de estar atrasada", () => {
    const r = row({ id: "a", scheduledAt: sp("2026-10-07T10:00:00"), late: true });
    const eff = applyOverride(r, { done: true, artDoneAt: "2026-10-06T18:00:00.000Z", artDoneBy: by }, NOW);
    assert.equal(eff.artStatus, "feita");
    assert.equal(eff.artSource, "marcada");
    assert.equal(eff.late, false);
    assert.deepEqual(eff.artDoneBy, by);
    assert.equal(applyOverride(r, undefined, NOW), r);
  });

  test("desmarcar: volta a fazer (e recalcula o atraso); com mídia continua feita", () => {
    const marcada = row({
      id: "a",
      scheduledAt: sp("2026-10-07T10:00:00"),
      artStatus: "feita",
      artSource: "marcada",
      artDoneAt: "2026-10-06T12:00:00.000Z",
      artDoneBy: by,
    });
    const off = { done: false, artDoneAt: null, artDoneBy: null };
    const eff = applyOverride(marcada, off, NOW);
    assert.equal(eff.artStatus, "a_fazer");
    assert.equal(eff.artSource, null);
    assert.equal(eff.late, true); // faltam menos de 48 h
    const longe = applyOverride({ ...marcada, scheduledAt: sp("2026-10-20T10:00:00") }, off, NOW);
    assert.equal(longe.late, false);
    const comMidia = applyOverride({ ...marcada, hasMedia: true }, off, NOW);
    assert.equal(comMidia.artStatus, "feita");
    assert.equal(comMidia.artSource, "midia");
  });

  test("contagens corrigidas e filtro 'mostrar'", () => {
    const rows = [
      row({ id: "a", scheduledAt: sp("2026-10-07T10:00:00"), late: true }),
      row({ id: "b", scheduledAt: sp("2026-10-20T10:00:00") }),
      row({ id: "c", scheduledAt: sp("2026-10-21T10:00:00"), artStatus: "feita", artSource: "marcada" }),
    ];
    const counts = { aFazer: 2, feitas: 1, atrasadas: 1, total: 3 };
    const effective = [
      applyOverride(rows[0], { done: true, artDoneAt: null, artDoneBy: null }, NOW),
      rows[1],
      applyOverride(rows[2], { done: false, artDoneAt: null, artDoneBy: null }, NOW),
    ];
    assert.deepEqual(adjustCounts(counts, rows, effective), { aFazer: 2, feitas: 1, atrasadas: 0, total: 3 });
    assert.deepEqual(adjustCounts(counts, rows, rows), counts);
    assert.deepEqual(effective.filter((r) => matchesShow(r, "a_fazer")).map((r) => r.id), ["b", "c"]);
    assert.deepEqual(effective.filter((r) => matchesShow(r, "feitas")).map((r) => r.id), ["a"]);
    assert.equal(effective.filter((r) => matchesShow(r, "todas")).length, 3);
  });
});
