"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/Avatar";
import { Button, Spinner } from "@/components/Button";
import { ConfirmDialog } from "@/components/Dialog";
import { Field, Input, Select } from "@/components/Field";
import { Icon } from "@/components/Icons";
import { Switch } from "@/components/Toggle";
import { Toast, type ToastState } from "@/components/Toast";
import { EmptyState, StatusBadge } from "@/components/ui";
import { clientColor } from "@/lib/client-color";
import { CLIENT_STATUS, CLIENT_STATUSES, PLAN, PLANS, SEGMENTS, TIER, TIERS, labelOf } from "@/lib/status-meta";
import {
  StopPublishingDialog,
  patchClient,
  stoppedPublishingMessage,
  type UserOption,
} from "./[id]/ClientInfoEditor";

/*
 * Carteira de clientes (DESIGN g.4): filtros + edição em linha de redatora,
 * designer, segmento, status e "Agendar posts?". Tabela a partir de xl; cartões abaixo.
 */

export type ClientRow = {
  id: string;
  name: string;
  email: string;
  extraEmails: string[];
  logoUrl: string | null;
  brandColor: string | null;
  plan: string;
  tier: string;
  agencyPublishes: boolean;
  status: string;
  segment: string | null;
  responsibleUserId: string | null;
  designerUserId: string | null;
};

type EditableField = "responsibleUserId" | "designerUserId" | "segment" | "status" | "agencyPublishes";
type CellValue = string | boolean;
type CellState = { state: "saving" } | { state: "saved" } | { state: "error"; message: string };
/** valor otimista; vale enquanto o servidor ainda mostra `base` (o valor de antes) */
type Override = { value: CellValue; base: CellValue };

const INLINE_ERROR = "Não foi possível salvar. Tente de novo.";

const SAVED_MESSAGE: Record<EditableField, (name: string) => string> = {
  responsibleUserId: (n) => `Redatora de ${n} salva.`,
  designerUserId: (n) => `Designer de ${n} salvo.`,
  segment: (n) => `Segmento de ${n} salvo.`,
  status: (n) => `Status de ${n} salvo.`,
  agencyPublishes: (n) => `“Agendar posts” de ${n} salvo.`,
};

function serverValue(c: ClientRow, field: EditableField): CellValue {
  if (field === "responsibleUserId") return c.responsibleUserId ?? "";
  if (field === "designerUserId") return c.designerUserId ?? "";
  if (field === "segment") return c.segment ?? "";
  if (field === "status") return c.status;
  return c.agencyPublishes;
}

function fold(s: string) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function plural(n: number, one: string, many: string) {
  return n === 1 ? one : many;
}

type Filters = {
  q: string;
  writer: string; // "todas" | "sem" | userId
  designer: string; // "todos" | "sem" | userId
  segment: string; // "todos" | "sem" | segmento
  status: string; // "todos" | status
  plan: string; // "todas" | plano
  tier: string; // "todos" | pacote de gestão
  publishes: string; // "todos" | "sim" | "nao"
};

const DEFAULT_FILTERS: Filters = {
  q: "",
  writer: "todas",
  designer: "todos",
  segment: "todos",
  status: "ativo",
  plan: "todas",
  tier: "todos",
  publishes: "todos",
};

function sameFilters(a: Filters, b: Filters) {
  return (Object.keys(a) as (keyof Filters)[]).every((k) => a[k] === b[k]);
}

function matches(c: ClientRow, f: Filters): boolean {
  if (f.q.trim()) {
    const q = fold(f.q.trim());
    const hay = fold([c.name, c.email, ...c.extraEmails].join(" "));
    if (!hay.includes(q)) return false;
  }
  if (f.writer === "sem" ? c.responsibleUserId : f.writer !== "todas" && c.responsibleUserId !== f.writer) return false;
  if (f.designer === "sem" ? c.designerUserId : f.designer !== "todos" && c.designerUserId !== f.designer) return false;
  if (f.segment === "sem" ? c.segment : f.segment !== "todos" && c.segment !== f.segment) return false;
  if (f.status !== "todos" && c.status !== f.status) return false;
  if (f.plan !== "todas" && c.plan !== f.plan) return false;
  if (f.tier !== "todos" && c.tier !== f.tier) return false;
  if (f.publishes !== "todos" && c.agencyPublishes !== (f.publishes === "sim")) return false;
  return true;
}

type StatusDialog = {
  client: ClientRow;
  next: string;
  queued: number | null; // null = contagem indisponível
  busy: boolean;
  error: string | null;
};

type StopDialog = { client: ClientRow; busy: boolean; error: string | null };

/* ---------- peças de célula (fora do componente: identidade estável) ---------- */

function Feedback({ cell }: { cell?: CellState }) {
  return (
    <span className="inline-flex w-4 shrink-0 justify-center">
      {cell?.state === "saving" && <Spinner size={16} />}
      {cell?.state === "saved" && (
        <span aria-hidden="true" className="inline-flex size-4 text-success-solid [&>svg]:size-full">
          <Icon.check />
        </span>
      )}
    </span>
  );
}

/** `short`: na tabela o vazio vira "—" (como o Segmento) para o nome da pessoa caber na coluna. */
function UserOptions({ users, empty, short = false }: { users: UserOption[]; empty: string; short?: boolean }) {
  return (
    <>
      <option value="" aria-label={empty}>
        {short ? "—" : empty}
      </option>
      {users.map((u) => (
        <option key={u.id} value={u.id}>
          {u.name}
        </option>
      ))}
    </>
  );
}

function SegmentOptions({ short }: { short: boolean }) {
  return (
    <>
      <option value="" aria-label="Sem segmento">
        {short ? "—" : "Sem segmento"}
      </option>
      {SEGMENTS.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </>
  );
}

function StatusOptions() {
  return (
    <>
      {CLIENT_STATUSES.map((s) => (
        <option key={s} value={s}>
          {labelOf(CLIENT_STATUS, s)}
        </option>
      ))}
    </>
  );
}

function ClientIdentity({ c, compact }: { c: ClientRow; compact: boolean }) {
  const extras = c.extraEmails.length;
  return (
    <div className="flex min-w-0 items-start gap-3">
      <span className="mt-1.5">
        <Avatar
          name={c.name}
          src={c.logoUrl}
          size="sm"
          shape="square"
          color={clientColor(c.id, c.brandColor)} // cor-de-dado: anel com a cor do cliente
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2">
          {/* U-01: max-w-full + span min-w-0 deixam o truncate agir (nome longo não alarga a página);
              min-w-11/min-h-11 mantêm o alvo de toque mínimo para nomes curtos */}
          <Link
            href={`/clients/${c.id}`}
            className="inline-flex min-h-11 min-w-11 max-w-full items-center text-sm font-semibold text-fg hover:text-link hover:underline sm:min-h-10 sm:min-w-10"
          >
            <span className="min-w-0 truncate" title={c.name}>
              {c.name}
            </span>
          </Link>
          {!c.agencyPublishes && (
            <span title="A agência produz o conteúdo, mas o sistema não agenda nem publica.">
              <StatusBadge kind="agencyPublishes" status="nao" />
            </span>
          )}
          {compact && <StatusBadge kind="client" status={c.status} />}
        </div>
        <p className="truncate text-xs text-fg-muted" title={c.email}>
          {c.email}
          {extras > 0 && (
            <span title={c.extraEmails.join(", ")}>
              {" "}
              · +{extras} {plural(extras, "e-mail", "e-mails")}
            </span>
          )}
        </p>
      </div>
    </div>
  );
}

export default function ClientsTable({ clients, users }: { clients: ClientRow[]; users: UserOption[] }) {
  const router = useRouter();
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [cells, setCells] = useState<Record<string, CellState>>({});
  const [live, setLive] = useState("");
  const [toast, setToast] = useState<ToastState>(null);
  const [stopDialog, setStopDialog] = useState<StopDialog | null>(null);
  const [statusDialog, setStatusDialog] = useState<StatusDialog | null>(null);

  const visible = clients.filter((c) => matches(c, filters));
  const filtersChanged = !sameFilters(filters, DEFAULT_FILTERS);

  function setFilter(patch: Partial<Filters>) {
    setFilters((f) => ({ ...f, ...patch }));
  }

  const keyOf = (c: ClientRow, field: EditableField) => `${c.id}:${field}`;

  function shown(c: ClientRow, field: EditableField): CellValue {
    const o = overrides[keyOf(c, field)];
    const server = serverValue(c, field);
    return o && o.base === server ? o.value : server;
  }

  function setCell(key: string, state: CellState | null) {
    setCells((s) => {
      const next = { ...s };
      if (state) next[key] = state;
      else delete next[key];
      return next;
    });
  }

  function clearOverride(key: string) {
    setOverrides((o) => {
      const next = { ...o };
      delete next[key];
      return next;
    });
  }

  /** Marca o valor como salvo: mantém o otimista até o refresh trazer o novo valor do servidor. */
  function markSaved(c: ClientRow, field: EditableField, value: CellValue) {
    const key = keyOf(c, field);
    setOverrides((o) => ({ ...o, [key]: { value, base: serverValue(c, field) } }));
    setCell(key, { state: "saved" });
    setLive(SAVED_MESSAGE[field](c.name));
    router.refresh();
    setTimeout(() => {
      setCells((s) => {
        if (s[key]?.state !== "saved") return s;
        const next = { ...s };
        delete next[key];
        return next;
      });
    }, 1500);
  }

  async function saveInline(c: ClientRow, field: EditableField, value: CellValue) {
    const key = keyOf(c, field);
    setOverrides((o) => ({ ...o, [key]: { value, base: serverValue(c, field) } }));
    setCell(key, { state: "saving" });
    const body: Record<string, unknown> =
      field === "responsibleUserId" || field === "designerUserId" || field === "segment"
        ? { [field]: value || null }
        : { [field]: value };
    const result = await patchClient(c.id, body);
    if (!result.ok) {
      clearOverride(key);
      setCell(key, { state: "error", message: INLINE_ERROR });
      setLive(`Não foi possível salvar. ${c.name} continua com o valor anterior.`);
      return;
    }
    markSaved(c, field, value);
  }

  async function changeStatus(c: ClientRow, next: string) {
    if (next === "ativo" || !c.agencyPublishes) {
      void saveInline(c, "status", next);
      return;
    }
    // pausar/encerrar com posts na fila: avisa antes (A10)
    const key = keyOf(c, "status");
    setCell(key, { state: "saving" });
    let queued: number | null = null;
    try {
      const res = await fetch(`/api/clients/${c.id}`, { cache: "no-store" });
      const data: unknown = await res.json().catch(() => null);
      const n = (data as { queuedPostsCount?: unknown } | null)?.queuedPostsCount;
      if (res.ok && typeof n === "number") queued = n;
    } catch {
      queued = null;
    }
    setCell(key, null);
    if (queued === 0) {
      void saveInline(c, "status", next);
      return;
    }
    setStatusDialog({ client: c, next, queued, busy: false, error: null });
  }

  async function confirmStatus() {
    if (!statusDialog) return;
    const { client: c, next } = statusDialog;
    setStatusDialog({ ...statusDialog, busy: true, error: null });
    const result = await patchClient(c.id, { status: next });
    if (!result.ok) {
      setStatusDialog((d) => (d ? { ...d, busy: false, error: result.failure.message } : d));
      return;
    }
    setStatusDialog(null);
    markSaved(c, "status", next);
  }

  function changePublishes(c: ClientRow, checked: boolean) {
    if (checked) {
      // Não → Sim: sem diálogo; nada é agendado sozinho (A4)
      void saveInline(c, "agencyPublishes", true);
      return;
    }
    setCell(keyOf(c, "agencyPublishes"), null);
    setStopDialog({ client: c, busy: false, error: null });
  }

  async function confirmStop() {
    if (!stopDialog) return;
    const c = stopDialog.client;
    setStopDialog({ ...stopDialog, busy: true, error: null });
    const result = await patchClient(c.id, { agencyPublishes: false });
    if (!result.ok) {
      setStopDialog((d) => (d ? { ...d, busy: false, error: result.failure.message } : d));
      return;
    }
    const reverted = typeof result.data.revertedToDraft === "number" ? result.data.revertedToDraft : 0;
    setStopDialog(null);
    markSaved(c, "agencyPublishes", false);
    setToast({ kind: "success", text: stoppedPublishingMessage(c.name, reverted) });
  }

  /* ---------- estado de cada célula ---------- */

  function cellOf(c: ClientRow, field: EditableField) {
    const cell = cells[keyOf(c, field)];
    return {
      cell,
      saving: cell?.state === "saving",
      error: cell?.state === "error" ? cell.message : null,
      errorId: `erro-${c.id}-${field}`,
    };
  }

  const subtitleCount = `${visible.length} ${plural(visible.length, "cliente", "clientes")}`;

  return (
    <div className="grid gap-4">
      {/* ---------- filtros ---------- */}
      <div className="card grid gap-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-8">
          <div className="self-end sm:col-span-2 lg:col-span-4 2xl:col-span-1">
            <Input
              type="search"
              size="sm"
              aria-label="Buscar clientes"
              placeholder="Buscar por nome ou e-mail"
              leadingIcon={<Icon.search />}
              value={filters.q}
              onChange={(e) => setFilter({ q: e.target.value })}
            />
          </div>
          <Field label="Redatora">
            <Select size="sm" value={filters.writer} onChange={(e) => setFilter({ writer: e.target.value })}>
              <option value="todas">Todas</option>
              <option value="sem">Sem redatora</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Designer">
            <Select size="sm" value={filters.designer} onChange={(e) => setFilter({ designer: e.target.value })}>
              <option value="todos">Todos</option>
              <option value="sem">Sem designer</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Segmento">
            <Select size="sm" value={filters.segment} onChange={(e) => setFilter({ segment: e.target.value })}>
              <option value="todos">Todos</option>
              <option value="sem">Sem segmento</option>
              {SEGMENTS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status">
            <Select size="sm" value={filters.status} onChange={(e) => setFilter({ status: e.target.value })}>
              <option value="todos">Todos</option>
              <StatusOptions />
            </Select>
          </Field>
          <Field label="Aprovação">
            <Select size="sm" value={filters.plan} onChange={(e) => setFilter({ plan: e.target.value })}>
              <option value="todas">Todas</option>
              {PLANS.map((p) => (
                <option key={p} value={p}>
                  {labelOf(PLAN, p)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Pacote">
            <Select size="sm" value={filters.tier} onChange={(e) => setFilter({ tier: e.target.value })}>
              <option value="todos">Todos</option>
              {TIERS.map((t) => (
                <option key={t} value={t}>
                  {t === "completa" ? "Completa (antigo)" : labelOf(TIER, t)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Publicação">
            <Select size="sm" value={filters.publishes} onChange={(e) => setFilter({ publishes: e.target.value })}>
              <option value="todos">Todos</option>
              <option value="sim">Agenda posts</option>
              <option value="nao">Só produção</option>
            </Select>
          </Field>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p aria-live="polite" className="text-sm text-fg-muted">
            {subtitleCount}
          </p>
          {filtersChanged && (
            <Button variant="ghost" size="sm" onClick={() => setFilters(DEFAULT_FILTERS)}>
              Limpar filtros
            </Button>
          )}
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          title="Nenhum cliente com esses filtros"
          description={
            filtersChanged
              ? "Mude ou limpe os filtros para ver mais clientes."
              : "Nenhum cliente está ativo. Veja os pausados e encerrados."
          }
          action={
            filtersChanged ? (
              <Button variant="secondary" onClick={() => setFilters(DEFAULT_FILTERS)}>
                Limpar filtros
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => setFilter({ status: "todos" })}>
                Mostrar todos os status
              </Button>
            )
          }
          headingLevel={2}
        />
      ) : (
        <>
          {/* ---------- tabela (≥ xl; entre 1280 e ~1440 rola na horizontal dentro do card) ---------- */}
          <div className="card hidden overflow-x-auto xl:block">
            <table className="w-full min-w-266 table-fixed border-collapse text-left">
              <caption className="sr-only">Carteira de clientes</caption>
              <thead>
                <tr className="border-b border-line text-xs font-semibold uppercase tracking-overline text-fg-muted">
                  <th scope="col" className="px-4 py-3 font-semibold">
                    Cliente
                  </th>
                  <th scope="col" className="w-44 px-2 py-3 font-semibold">
                    Redatora
                  </th>
                  <th scope="col" className="w-44 px-2 py-3 font-semibold">
                    Designer
                  </th>
                  <th scope="col" className="w-36 px-2 py-3 font-semibold">
                    Segmento
                  </th>
                  <th scope="col" className="w-33 px-2 py-3 font-semibold">
                    Aprovação
                  </th>
                  <th scope="col" className="w-28 px-2 py-3 font-semibold">
                    Agendar posts?
                  </th>
                  <th scope="col" className="w-36 px-2 py-3 pr-4 font-semibold">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((c) => {
                  const w = cellOf(c, "responsibleUserId");
                  const d = cellOf(c, "designerUserId");
                  const s = cellOf(c, "segment");
                  const p = cellOf(c, "agencyPublishes");
                  const st = cellOf(c, "status");
                  return (
                    <tr key={c.id} className="border-b border-line align-top last:border-b-0 hover:bg-hover">
                      <td className="px-4 py-2.5">
                        <ClientIdentity c={c} compact={false} />
                      </td>
                      <td className="px-2 py-3" aria-busy={w.saving || undefined}>
                        <div className="flex items-center gap-1.5">
                          <Select
                            size="sm"
                            aria-label={`Redatora de ${c.name}`}
                            value={shown(c, "responsibleUserId") as string}
                            disabled={w.saving}
                            invalid={!!w.error}
                            aria-describedby={w.error ? w.errorId : undefined}
                            onChange={(e) => void saveInline(c, "responsibleUserId", e.target.value)}
                            className="min-w-0 flex-1"
                          >
                            <UserOptions users={users} empty="Sem redatora" short />
                          </Select>
                          <Feedback cell={w.cell} />
                        </div>
                        {w.error && (
                          <p id={w.errorId} className="mt-1 text-xs text-danger-fg">
                            {w.error}
                          </p>
                        )}
                      </td>
                      <td className="px-2 py-3" aria-busy={d.saving || undefined}>
                        <div className="flex items-center gap-1.5">
                          <Select
                            size="sm"
                            aria-label={`Designer de ${c.name}`}
                            value={shown(c, "designerUserId") as string}
                            disabled={d.saving}
                            invalid={!!d.error}
                            aria-describedby={d.error ? d.errorId : undefined}
                            onChange={(e) => void saveInline(c, "designerUserId", e.target.value)}
                            className="min-w-0 flex-1"
                          >
                            <UserOptions users={users} empty="Sem designer" short />
                          </Select>
                          <Feedback cell={d.cell} />
                        </div>
                        {d.error && (
                          <p id={d.errorId} className="mt-1 text-xs text-danger-fg">
                            {d.error}
                          </p>
                        )}
                      </td>
                      <td className="px-2 py-3" aria-busy={s.saving || undefined}>
                        <div className="flex items-center gap-1.5">
                          <Select
                            size="sm"
                            aria-label={`Segmento de ${c.name}`}
                            value={shown(c, "segment") as string}
                            disabled={s.saving}
                            invalid={!!s.error}
                            aria-describedby={s.error ? s.errorId : undefined}
                            onChange={(e) => void saveInline(c, "segment", e.target.value)}
                            className="min-w-0 flex-1"
                          >
                            <SegmentOptions short />
                          </Select>
                          <Feedback cell={s.cell} />
                        </div>
                        {s.error && (
                          <p id={s.errorId} className="mt-1 text-xs text-danger-fg">
                            {s.error}
                          </p>
                        )}
                      </td>
                      <td className="px-2 py-4">
                        <StatusBadge kind="plan" status={c.plan} />
                        {/* a antiga coluna Gestão virou 2ª linha aqui: assim a coluna Designer cabe a 1440 */}
                        <p className="mt-1.5 text-xs text-fg-muted">{labelOf(TIER, c.tier)}</p>
                      </td>
                      <td className="px-2 py-2" aria-busy={p.saving || undefined}>
                        <div className="flex items-center gap-1.5">
                          <Switch
                            size="sm"
                            aria-label={`Agendar os posts de ${c.name}`}
                            checked={shown(c, "agencyPublishes") as boolean}
                            stateLabels={{ on: "Sim", off: "Não" }}
                            loading={p.saving}
                            invalid={!!p.error}
                            aria-describedby={p.error ? p.errorId : undefined}
                            onCheckedChange={(checked) => changePublishes(c, checked)}
                          />
                          {p.cell?.state === "saved" && <Feedback cell={p.cell} />}
                        </div>
                        {p.error && (
                          <p id={p.errorId} className="mt-1 text-xs text-danger-fg">
                            {p.error}
                          </p>
                        )}
                      </td>
                      <td className="px-2 py-3 pr-4" aria-busy={st.saving || undefined}>
                        <div className="flex items-center gap-1.5">
                          <Select
                            size="sm"
                            aria-label={`Status de ${c.name}`}
                            value={shown(c, "status") as string}
                            disabled={st.saving}
                            invalid={!!st.error}
                            aria-describedby={st.error ? st.errorId : undefined}
                            onChange={(e) => void changeStatus(c, e.target.value)}
                            className="min-w-0 flex-1"
                          >
                            <StatusOptions />
                          </Select>
                          <Feedback cell={st.cell} />
                        </div>
                        {st.error && (
                          <p id={st.errorId} className="mt-1 text-xs text-danger-fg">
                            {st.error}
                          </p>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* ---------- cartões (< xl) ---------- */}
          <ul className="grid gap-3 xl:hidden" aria-label="Clientes">
            {visible.map((c) => {
              const w = cellOf(c, "responsibleUserId");
              const d = cellOf(c, "designerUserId");
              const s = cellOf(c, "segment");
              const p = cellOf(c, "agencyPublishes");
              const st = cellOf(c, "status");
              return (
                <li key={c.id} className="card min-w-0 p-4">
                  <ClientIdentity c={c} compact />
                  <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <Field label="Redatora" error={w.error}>
                      <div className="flex items-center gap-1.5" aria-busy={w.saving || undefined}>
                        <Select
                          size="sm"
                          value={shown(c, "responsibleUserId") as string}
                          disabled={w.saving}
                          onChange={(e) => void saveInline(c, "responsibleUserId", e.target.value)}
                          className="min-w-0 flex-1"
                        >
                          <UserOptions users={users} empty="Sem redatora" />
                        </Select>
                        <Feedback cell={w.cell} />
                      </div>
                    </Field>
                    <Field label="Designer" error={d.error}>
                      <div className="flex items-center gap-1.5" aria-busy={d.saving || undefined}>
                        <Select
                          size="sm"
                          value={shown(c, "designerUserId") as string}
                          disabled={d.saving}
                          onChange={(e) => void saveInline(c, "designerUserId", e.target.value)}
                          className="min-w-0 flex-1"
                        >
                          <UserOptions users={users} empty="Sem designer" />
                        </Select>
                        <Feedback cell={d.cell} />
                      </div>
                    </Field>
                    <Field label="Segmento" error={s.error}>
                      <div className="flex items-center gap-1.5" aria-busy={s.saving || undefined}>
                        <Select
                          size="sm"
                          value={shown(c, "segment") as string}
                          disabled={s.saving}
                          onChange={(e) => void saveInline(c, "segment", e.target.value)}
                          className="min-w-0 flex-1"
                        >
                          <SegmentOptions short={false} />
                        </Select>
                        <Feedback cell={s.cell} />
                      </div>
                    </Field>
                    <Field label="Status" error={st.error}>
                      <div className="flex items-center gap-1.5" aria-busy={st.saving || undefined}>
                        <Select
                          size="sm"
                          value={shown(c, "status") as string}
                          disabled={st.saving}
                          onChange={(e) => void changeStatus(c, e.target.value)}
                          className="min-w-0 flex-1"
                        >
                          <StatusOptions />
                        </Select>
                        <Feedback cell={st.cell} />
                      </div>
                    </Field>
                    <Field label="Agendar posts?" error={p.error}>
                      <div className="flex items-center gap-1.5">
                        <Switch
                          size="sm"
                          aria-label={`Agendar os posts de ${c.name}`}
                          checked={shown(c, "agencyPublishes") as boolean}
                          stateLabels={{ on: "Sim", off: "Não" }}
                          loading={p.saving}
                          onCheckedChange={(checked) => changePublishes(c, checked)}
                        />
                        {p.cell?.state === "saved" && <Feedback cell={p.cell} />}
                      </div>
                    </Field>
                  </div>
                  <p className="mt-3 text-xs text-fg-muted">
                    {labelOf(PLAN, c.plan)} · {labelOf(TIER, c.tier)}
                  </p>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <p role="status" className="sr-only">
        {live}
      </p>

      {stopDialog && (
        <StopPublishingDialog
          clientId={stopDialog.client.id}
          clientName={stopDialog.client.name}
          busy={stopDialog.busy}
          error={stopDialog.error}
          onConfirm={() => void confirmStop()}
          onCancel={() => setStopDialog(null)}
        />
      )}

      {statusDialog && (
        <ConfirmDialog
          open
          title={`${statusDialog.next === "encerrado" ? "Encerrar" : "Pausar"} ${statusDialog.client.name}?`}
          consequences={[
            "O cliente sai das listas e do Quadro filtrados por Ativo.",
            statusDialog.queued === null
              ? "Os posts agendados continuam na fila. Para não publicar, desligue “Agendar posts”."
              : `${statusDialog.queued} ${plural(
                  statusDialog.queued,
                  "post agendado ou com falha continua",
                  "posts agendados ou com falha continuam",
                )} na fila. Para não publicar, desligue “Agendar posts”.`,
          ]}
          confirmLabel={statusDialog.next === "encerrado" ? "Encerrar cliente" : "Pausar cliente"}
          busy={statusDialog.busy}
          busyLabel="Salvando…"
          error={statusDialog.error}
          onConfirm={() => void confirmStatus()}
          onCancel={() => setStatusDialog(null)}
        />
      )}

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
