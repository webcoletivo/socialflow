"use client";

import { Fragment, useEffect, useEffectEvent, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/Avatar";
import { Button, buttonClasses } from "@/components/Button";
import { Callout } from "@/components/Callout";
import { ConfirmDialog } from "@/components/Dialog";
import DriveFolderPicker from "@/components/DriveFolderPicker";
import { Field, Input, Select, Textarea } from "@/components/Field";
import { Icon } from "@/components/Icons";
import { MultiEmailInput } from "@/components/MultiEmailInput";
import { SegmentedControl } from "@/components/Toggle";
import { Toast, type ToastState } from "@/components/Toast";
import { StatusBadge } from "@/components/ui";
import { isValidEmail, normalizeEmail } from "@/lib/client-emails";
import { clientColor } from "@/lib/client-color";
import {
  CAROUSEL_FREQUENCIES,
  CAROUSEL_FREQUENCY_LABEL,
  DEFAULT_CAROUSEL_FREQUENCY,
  DEFAULT_REELS_WEEKDAY,
  PACKAGE,
  REELS_WEEKDAYS,
  WEEKDAY_LABEL,
  isPackageTier,
  isReelsWeekday,
} from "@/lib/content-packages";
import { CLIENT_STATUS, CLIENT_STATUSES, PLAN, PLANS, SEGMENTS, SELECTABLE_TIERS, TIER, labelOf } from "@/lib/status-meta";

/*
 * Formulário de cliente (DESIGN g.5): criação (`NewClientForm`, usado por
 * clients/new) e edição (`ClientInfoEditor`, no detalhe), com os mesmos
 * campos. Também exporta a confirmação "Agência publica: Sim → Não"
 * (`StopPublishingDialog`), usada aqui e na Carteira (ClientsTable).
 *
 * Gancho `#editar-<campo>` (U-17): um link com esse hash na página do cliente
 * abre a edição e foca o campo (ex.: #editar-toneOfVoice no checklist).
 */

export type UserOption = { id: string; name: string };

export type ClientInfo = {
  id: string;
  name: string;
  email: string;
  extraEmails: string[];
  plan: string;
  tier: string;
  /** pacote com carrossel: "semanal" | "quinzenal" */
  carouselFrequency: string;
  /** pacote com reels: 1–5 = seg–sex */
  reelsWeekday: number | null;
  agencyPublishes: boolean;
  status: string;
  segment: string | null;
  responsibleUserId: string | null;
  /** designer responsável (fila de artes em /design) */
  designerUserId: string | null;
  toneOfVoice: string | null;
  driveFolderId: string | null;
  logoUrl: string | null;
  brandColor: string | null;
  showContacts: boolean;
};

const DEFAULT_BRAND_COLOR = "#ee7228"; // cor-de-dado: sugestão inicial da cor da marca do cliente (arte por IA) = laranja Grupo Coletivo
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const GENERIC_SAVE_ERROR = "Não foi possível salvar. Tente de novo.";
const NETWORK_ERROR = "Sem conexão com o servidor. Verifique a internet e tente de novo.";

/* ------------------------------------------------------------------ *
 * Chamadas à API e leitura dos erros (nunca mostra `error` que não seja texto — N-14)
 * ------------------------------------------------------------------ */

type FieldKey =
  | "name"
  | "email"
  | "extraEmails"
  | "plan"
  | "tier"
  | "carouselFrequency"
  | "reelsWeekday"
  | "agencyPublishes"
  | "responsibleUserId"
  | "designerUserId"
  | "segment"
  | "status"
  | "toneOfVoice"
  | "driveFolderId"
  | "logoUrl"
  | "brandColor"
  | "showContacts"
  | "whatsapp"
  | "phone"
  | "website"
  | "instagramUrl"
  | "city";

type FormErrors = Partial<Record<FieldKey, string>>;

/** Ordem dos campos na tela (foco no 1º inválido). */
const FIELD_ORDER: FieldKey[] = [
  "name",
  "email",
  "extraEmails",
  "plan",
  "tier",
  "carouselFrequency",
  "reelsWeekday",
  "agencyPublishes",
  "responsibleUserId",
  "designerUserId",
  "segment",
  "status",
  "toneOfVoice",
  "driveFolderId",
  "logoUrl",
  "brandColor",
  "showContacts",
  "whatsapp",
  "phone",
  "website",
  "instagramUrl",
  "city",
];

/** Mensagem pt-BR para cada campo recusado pelo zod do servidor (o texto do zod pode vir em inglês). */
const SERVER_FIELD_MESSAGE: Record<FieldKey, string> = {
  name: "Informe o nome do cliente.",
  email: "Informe um e-mail válido, como nome@empresa.com.br.",
  extraEmails: "Confira os e-mails adicionais.",
  plan: "Escolha uma opção de aprovação da lista.",
  tier: "Escolha um pacote de gestão da lista.",
  carouselFrequency: "Escolha a frequência dos carrosséis da lista.",
  reelsWeekday: "Escolha o dia dos reels da lista.",
  agencyPublishes: "Escolha Sim ou Não.",
  responsibleUserId: "Escolha uma redatora da lista.",
  designerUserId: "Escolha um designer da lista.",
  segment: "Escolha um segmento da lista.",
  status: "Escolha um status da lista.",
  toneOfVoice: "Confira o tom de voz.",
  driveFolderId: "Escolha a pasta do Drive de novo.",
  logoUrl: "A logo não tem um endereço válido. Envie a imagem de novo.",
  brandColor: "Use uma cor no formato #RRGGBB.",
  showContacts: "Escolha Sim ou Não.",
  whatsapp: "Use no máximo 40 caracteres.",
  phone: "Use no máximo 40 caracteres.",
  website: "Use no máximo 200 caracteres.",
  instagramUrl: "Use no máximo 200 caracteres.",
  city: "Use no máximo 120 caracteres.",
};

function isFieldKey(key: string): key is FieldKey {
  return (FIELD_ORDER as string[]).includes(key);
}

type ApiFailure = { fields: FormErrors; itemErrors: Record<string, string>; message: string };

/** "E-mail inválido: x" / "E-mails inválidos: a, b" (S14) → erro em cada item da lista. */
function itemErrorsFrom(message: string): Record<string, string> {
  const match = /^E-mails? inválidos?: (.+)$/.exec(message);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const raw of match[1].split(", ")) out[normalizeEmail(raw)] = `“${raw}” não é um e-mail válido.`;
  return out;
}

async function readFailure(res: Response, fallback: string): Promise<ApiFailure> {
  const body: unknown = await res.json().catch(() => null);
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  const field = body && typeof body === "object" ? (body as { field?: unknown }).field : undefined;

  if (res.status === 401) return { fields: {}, itemErrors: {}, message: "Sua sessão expirou. Entre de novo para salvar." };
  if (res.status === 404) return { fields: {}, itemErrors: {}, message: "Cliente não encontrado. Ele pode ter sido excluído." };
  if (res.status === 409) {
    // conflito com texto e campo vindos do servidor (o e-mail principal pode repetir desde 20/10)
    const message = typeof error === "string" ? error : fallback;
    const key: FieldKey = typeof field === "string" && isFieldKey(field) ? field : "email";
    return { fields: { [key]: message }, itemErrors: {}, message };
  }
  if (res.status === 400 && typeof error === "string") {
    const fields: FormErrors = typeof field === "string" && isFieldKey(field) ? { [field]: error } : {};
    return { fields, itemErrors: field === "extraEmails" ? itemErrorsFrom(error) : {}, message: error };
  }
  if (res.status === 400 && error && typeof error === "object") {
    const fieldErrors = (error as { fieldErrors?: unknown }).fieldErrors;
    const fields: FormErrors = {};
    if (fieldErrors && typeof fieldErrors === "object") {
      for (const key of Object.keys(fieldErrors)) {
        if (isFieldKey(key)) fields[key] = SERVER_FIELD_MESSAGE[key];
      }
    }
    return { fields, itemErrors: {}, message: "Confira os campos destacados." };
  }
  return { fields: {}, itemErrors: {}, message: fallback };
}

export type PatchResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; failure: ApiFailure };

/** PATCH /api/clients/[id] com tratamento de rede e de erro. */
export async function patchClient(
  id: string,
  body: Record<string, unknown>,
  fallback: string = GENERIC_SAVE_ERROR,
): Promise<PatchResult> {
  let res: Response;
  try {
    res = await fetch(`/api/clients/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, failure: { fields: {}, itemErrors: {}, message: NETWORK_ERROR } };
  }
  if (!res.ok) return { ok: false, failure: await readFailure(res, fallback) };
  const data: unknown = await res.json().catch(() => null);
  return { ok: true, data: data && typeof data === "object" ? (data as Record<string, unknown>) : {} };
}

function plural(n: number, one: string, many: string) {
  return n === 1 ? one : many;
}

/** Toast depois de "Sim → Não" confirmado (DESIGN g.4). */
export function stoppedPublishingMessage(clientName: string, revertedToDraft: number): string {
  if (revertedToDraft === 0) return `${clientName} agora é só produção. Nenhum post estava na fila.`;
  return `${clientName} agora é só produção. ${revertedToDraft} ${plural(
    revertedToDraft,
    "post voltou",
    "posts voltaram",
  )} para rascunho.`;
}

/* ------------------------------------------------------------------ *
 * Confirmação "Agência publica: Sim → Não" (DESIGN g.4; A4)
 * Monte só enquanto aberto: cada abertura busca a contagem exata do servidor.
 * ------------------------------------------------------------------ */

type QueueCount = { attempt: number } & ({ ok: true; queued: number; publishing: number } | { ok: false });

export function StopPublishingDialog({
  clientId,
  clientName,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  clientId: string;
  clientName: string;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [count, setCount] = useState<QueueCount | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/clients/${clientId}`, { signal: ctrl.signal, cache: "no-store" })
      .then(async (res) => {
        const data: unknown = await res.json().catch(() => null);
        const d = (data ?? {}) as { queuedPostsCount?: unknown; publishingNow?: unknown };
        if (!res.ok || typeof d.queuedPostsCount !== "number") throw new Error("contagem indisponível");
        setCount({
          attempt,
          ok: true,
          queued: d.queuedPostsCount,
          publishing: typeof d.publishingNow === "number" ? d.publishingNow : 0,
        });
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setCount({ attempt, ok: false });
      });
    return () => ctrl.abort();
  }, [clientId, attempt]);

  const current = count && count.attempt === attempt ? count : null;
  const loaded = current?.ok ? current : null;

  const consequences = loaded
    ? [
        loaded.queued > 0
          ? `${loaded.queued} ${plural(
              loaded.queued,
              "post agendado ou com falha volta",
              "posts agendados ou com falha voltam",
            )} para rascunho.`
          : "Nenhum post está agendado ou com falha agora: nada volta para rascunho.",
        "Novos posts deste cliente não entram na fila de publicação.",
        "A produção continua: cronograma, aprovações e artes funcionam normalmente.",
        ...(loaded.publishing > 0
          ? [
              `${loaded.publishing} ${plural(
                loaded.publishing,
                "post está sendo publicado neste momento; essa publicação pode concluir.",
                "posts estão sendo publicados neste momento; essas publicações podem concluir.",
              )}`,
            ]
          : []),
      ]
    : undefined;

  return (
    <ConfirmDialog
      open
      tone="danger"
      title={`Parar de agendar os posts de ${clientName}?`}
      consequences={consequences}
      confirmLabel="Sim, só produção"
      busy={busy}
      busyLabel="Salvando…"
      error={error}
      confirmDisabled={!loaded}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {!current && (
        <div className="grid gap-2">
          <div aria-hidden="true" className="skeleton h-4 w-56 max-w-full" />
          <p role="status" className="text-sm text-fg-muted">
            Contando posts agendados…
          </p>
        </div>
      )}
      {current && !current.ok && (
        <Callout
          tone="danger"
          live="assertive"
          action={
            <Button size="sm" variant="secondary" leadingIcon={<Icon.refresh />} onClick={() => setAttempt((a) => a + 1)}>
              Tentar de novo
            </Button>
          }
        >
          Não foi possível contar os posts agendados.
        </Callout>
      )}
    </ConfirmDialog>
  );
}

/* ------------------------------------------------------------------ *
 * Tom de voz: só negrito (**texto**) e quebra de linha, como nós React (A-027)
 * ------------------------------------------------------------------ */

function renderBold(line: string): React.ReactNode[] {
  // índices ímpares = trecho entre ** **; asterisco duplo que sobrar é removido
  return line.split(/\*\*(.+?)\*\*/g).map((part, i) => {
    const text = part.replace(/\*\*/g, "");
    return i % 2 === 1 ? (
      <strong key={i} className="font-semibold text-fg">
        {text}
      </strong>
    ) : (
      <Fragment key={i}>{text}</Fragment>
    );
  });
}

export function ToneOfVoiceText({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return (
    <>
      {lines.map((line, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          {renderBold(line)}
        </Fragment>
      ))}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Campos do formulário (criação e edição)
 * ------------------------------------------------------------------ */

type FormValues = {
  name: string;
  email: string;
  extraEmails: string[];
  plan: string;
  tier: string;
  carouselFrequency: string;
  /** "1".."5" (seg–sex) */
  reelsWeekday: string;
  agencyPublishes: boolean;
  responsibleUserId: string;
  designerUserId: string;
  segment: string;
  status: string;
  toneOfVoice: string;
  driveFolderId: string;
  logoUrl: string;
  brandColor: string;
  showContacts: boolean;
  whatsapp: string;
  phone: string;
  website: string;
  instagramUrl: string;
  city: string;
};

const EMPTY_VALUES: FormValues = {
  name: "",
  email: "",
  extraEmails: [],
  plan: "sem_aprovacao",
  tier: "gestao_1",
  carouselFrequency: DEFAULT_CAROUSEL_FREQUENCY,
  reelsWeekday: String(DEFAULT_REELS_WEEKDAY),
  agencyPublishes: true,
  responsibleUserId: "",
  designerUserId: "",
  segment: "",
  status: "ativo",
  toneOfVoice: "",
  driveFolderId: "",
  logoUrl: "",
  brandColor: DEFAULT_BRAND_COLOR,
  showContacts: false,
  whatsapp: "",
  phone: "",
  website: "",
  instagramUrl: "",
  city: "",
};

function valuesFromClient(c: ClientInfo): FormValues {
  return {
    ...EMPTY_VALUES,
    name: c.name,
    email: c.email,
    extraEmails: c.extraEmails,
    plan: c.plan,
    tier: c.tier,
    carouselFrequency: c.carouselFrequency === "semanal" ? "semanal" : DEFAULT_CAROUSEL_FREQUENCY,
    reelsWeekday: String(isReelsWeekday(c.reelsWeekday) ? c.reelsWeekday : DEFAULT_REELS_WEEKDAY),
    agencyPublishes: c.agencyPublishes,
    responsibleUserId: c.responsibleUserId ?? "",
    designerUserId: c.designerUserId ?? "",
    segment: c.segment ?? "",
    status: c.status,
    toneOfVoice: c.toneOfVoice ?? "",
    driveFolderId: c.driveFolderId ?? "",
    logoUrl: c.logoUrl ?? "",
    brandColor: c.brandColor && HEX_COLOR.test(c.brandColor) ? c.brandColor : DEFAULT_BRAND_COLOR,
    showContacts: c.showContacts,
  };
}

function validate(v: FormValues): FormErrors {
  const e: FormErrors = {};
  if (!v.name.trim()) e.name = "Informe o nome do cliente.";
  const email = normalizeEmail(v.email);
  if (!email) e.email = "Informe o e-mail principal.";
  else if (!isValidEmail(email)) e.email = "Informe um e-mail válido, como nome@empresa.com.br.";
  if (email && v.extraEmails.includes(email)) e.extraEmails = "Remova dos adicionais o e-mail igual ao principal.";
  if (v.tier === "basica" && !HEX_COLOR.test(v.brandColor)) e.brandColor = SERVER_FIELD_MESSAGE.brandColor;
  return e;
}

/**
 * Foca o 1º campo inválido (ids `${prefix}-${campo}`). Depois de salvar, o campo pode continuar
 * `disabled` (saving) por alguns quadros até o React aplicar o estado: tenta de novo até ~30 quadros.
 */
function focusFirstInvalid(prefix: string, errors: FormErrors) {
  const key = FIELD_ORDER.find((k) => errors[k]);
  if (!key) return;
  let tries = 0;
  const step = () => {
    const el = document.getElementById(`${prefix}-${key}`);
    if (el && !(el as HTMLInputElement).disabled) {
      el.focus();
      return;
    }
    if (++tries < 30) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

const FOCUSABLE =
  "input:not([disabled]):not([type=hidden]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])";

/**
 * Foca o campo `${prefix}-${campo}` assim que ele existir (o formulário pode montar no próximo quadro).
 * Campo em grupo (Field kind="group", sem id no controle): foca o 1º controle do fieldset da legenda.
 */
function focusFieldWhenReady(prefix: string, key: FieldKey) {
  let tries = 0;
  const step = () => {
    const id = `${prefix}-${key}`;
    const direct = document.getElementById(id);
    const el = direct?.matches(FOCUSABLE)
      ? direct
      : document.getElementById(`${id}-label`)?.closest("fieldset")?.querySelector<HTMLElement>(FOCUSABLE);
    if (el) {
      el.focus({ preventScroll: true });
      // só rola se o campo não está inteiro à vista (abaixo do cabeçalho fixo do celular, 56 px)
      const r = el.getBoundingClientRect();
      if (r.top < 64 || r.bottom > window.innerHeight) el.scrollIntoView({ block: "center" });
      return;
    }
    if (++tries < 30) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Lista única das mensagens para o Callout do topo. */
function errorList(errors: FormErrors): string[] {
  return [...new Set(FIELD_ORDER.flatMap((k) => (errors[k] ? [errors[k] as string] : [])))];
}

/** Campos do pacote para o corpo de POST/PATCH: frequência sempre; dia dos reels só se o pacote tem reels. */
function packageBody(v: FormValues): { carouselFrequency: string; reelsWeekday: number | null } {
  const hasReels = isPackageTier(v.tier) && PACKAGE[v.tier].hasReels;
  return { carouselFrequency: v.carouselFrequency, reelsWeekday: hasReels ? Number(v.reelsWeekday) : null };
}

/** Texto curto do pacote escolhido (ajuda do select). */
function tierHelp(tier: string): string {
  if (isPackageTier(tier)) return PACKAGE[tier].description;
  if (tier === "basica") return "As artes do calendário padrão são geradas por IA.";
  return "Tipo antigo, sem pacote: o cronograma com IA continua livre (12 posts) até você escolher um pacote.";
}

/** Detalhes do pacote na leitura: "Carrossel: 1 a cada 15 dias · Reels: Quarta". */
function packageDetails(c: Pick<ClientInfo, "tier" | "carouselFrequency" | "reelsWeekday">): string | null {
  if (!isPackageTier(c.tier)) return null;
  const parts: string[] = [];
  if (PACKAGE[c.tier].hasCarousel) {
    const f = c.carouselFrequency === "semanal" ? "semanal" : "quinzenal";
    parts.push(`Carrossel: ${CAROUSEL_FREQUENCY_LABEL[f]}`);
  }
  if (PACKAGE[c.tier].hasReels && isReelsWeekday(c.reelsWeekday)) parts.push(`Reels: ${WEEKDAY_LABEL[c.reelsWeekday]}`);
  return parts.length ? parts.join(" · ") : null;
}

const GROUP = "m-0 grid min-w-0 gap-4 border-0 p-0";
const LEGEND = "mb-3 p-0 font-display text-base font-semibold text-fg";

function ClientFormFields({
  mode,
  prefix,
  values,
  set,
  errors,
  itemErrors,
  users,
  disabled,
  clientId,
  originalStatus,
  queuedPostsCount = 0,
}: {
  mode: "create" | "edit";
  prefix: string;
  values: FormValues;
  set: (patch: Partial<FormValues>) => void;
  errors: FormErrors;
  itemErrors: Record<string, string>;
  users: UserOption[];
  disabled: boolean;
  clientId?: string;
  originalStatus?: string;
  queuedPostsCount?: number;
}) {
  const isBasica = values.tier === "basica";
  const pkg = isPackageTier(values.tier) ? PACKAGE[values.tier] : null;
  const logoInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  async function uploadLogo(file: File) {
    if (!clientId) return;
    setUploading(true);
    setUploadError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("kind", "logo");
      fd.append("clientId", clientId);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const data: unknown = await res.json().catch(() => null);
      const d = (data ?? {}) as { url?: unknown; error?: unknown };
      if (!res.ok || typeof d.url !== "string") {
        setUploadError(typeof d.error === "string" ? d.error : "Não foi possível enviar a logo. Tente de novo.");
        return;
      }
      set({ logoUrl: d.url });
    } catch {
      setUploadError("Sem conexão com o servidor. Verifique a internet e tente de novo.");
    } finally {
      setUploading(false);
      if (logoInputRef.current) logoInputRef.current.value = "";
    }
  }

  const showStatusWarning =
    mode === "edit" &&
    values.status !== "ativo" &&
    values.status !== originalStatus &&
    values.agencyPublishes &&
    queuedPostsCount > 0;

  return (
    <div className="grid gap-8">
      <fieldset className={GROUP}>
        <legend className={LEGEND}>Identificação</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={`${prefix}-name`} label="Nome" required error={errors.name}>
            <Input
              value={values.name}
              onChange={(e) => set({ name: e.target.value })}
              disabled={disabled}
              autoComplete="off"
              placeholder="Nome do cliente ou empresa"
            />
          </Field>
          <Field
            id={`${prefix}-email`}
            label="E-mail principal"
            required
            help={
              <>
                Recebe os links de aprovação e os avisos. Pode ser o mesmo e-mail de outro cliente.
              </>
            }
            error={errors.email}
          >
            <Input
              type="email"
              inputMode="email"
              autoComplete="off"
              value={values.email}
              onChange={(e) => set({ email: e.target.value })}
              disabled={disabled}
              placeholder="contato@cliente.com.br"
            />
          </Field>
        </div>
        <Field
          id={`${prefix}-extraEmails`}
          label="E-mails adicionais"
          optional
          help="Recebem os mesmos links e avisos. Até 10."
          error={errors.extraEmails}
        >
          <MultiEmailInput
            value={values.extraEmails}
            onChange={(extraEmails) => set({ extraEmails })}
            primaryEmail={values.email}
            busy={disabled}
            errors={itemErrors}
          />
        </Field>
      </fieldset>

      <fieldset className={GROUP}>
        <legend className={LEGEND}>Contrato e publicação</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id={`${prefix}-plan`}
            label="Plano"
            help="Com aprovação: o cliente aprova o cronograma e os posts pelo link."
            error={errors.plan}
          >
            <Select value={values.plan} onChange={(e) => set({ plan: e.target.value })} disabled={disabled}>
              {PLANS.map((p) => (
                <option key={p} value={p}>
                  {labelOf(PLAN, p)}
                </option>
              ))}
            </Select>
          </Field>
          <Field id={`${prefix}-tier`} label="Pacote de gestão" help={tierHelp(values.tier)} error={errors.tier}>
            <Select value={values.tier} onChange={(e) => set({ tier: e.target.value })} disabled={disabled}>
              {/* "completa" (antigo) só aparece para quem ainda está nele, até escolher um pacote */}
              {values.tier === "completa" && <option value="completa">{labelOf(TIER, "completa")}</option>}
              {SELECTABLE_TIERS.map((t) => (
                <option key={t} value={t}>
                  {labelOf(TIER, t)}
                </option>
              ))}
            </Select>
          </Field>
          {pkg?.hasCarousel && (
            <Field
              id={`${prefix}-carouselFrequency`}
              label="Carrossel"
              help="Quantos carrosséis entram no cronograma do mês."
              error={errors.carouselFrequency}
            >
              <Select
                value={values.carouselFrequency}
                onChange={(e) => set({ carouselFrequency: e.target.value })}
                disabled={disabled}
              >
                {CAROUSEL_FREQUENCIES.map((f) => (
                  <option key={f} value={f}>
                    {CAROUSEL_FREQUENCY_LABEL[f]}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {pkg?.hasReels && (
            <Field id={`${prefix}-reelsWeekday`} label="Dia dos reels" help="1 reels por semana neste dia." error={errors.reelsWeekday}>
              <Select value={values.reelsWeekday} onChange={(e) => set({ reelsWeekday: e.target.value })} disabled={disabled}>
                {REELS_WEEKDAYS.map((d) => (
                  <option key={d} value={String(d)}>
                    {WEEKDAY_LABEL[d]}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        <Field
          id={`${prefix}-agencyPublishes`}
          kind="group"
          label="Agendar os posts deste cliente?"
          help="Sim: os posts são agendados e publicados automaticamente pelo sistema nas redes do cliente. Não: só produção — os posts nunca entram na fila de publicação."
          error={errors.agencyPublishes}
        >
          <SegmentedControl
            aria-labelledby={`${prefix}-agencyPublishes-label`}
            value={values.agencyPublishes ? "sim" : "nao"}
            onChange={(v) => set({ agencyPublishes: v === "sim" })}
            disabled={disabled}
            options={[
              { value: "sim", label: "Sim" },
              { value: "nao", label: "Não" },
            ]}
          />
        </Field>
        {!values.agencyPublishes && (
          <Callout tone="info" title="Só produção">
            O sistema cria cronogramas, aprovações e artes, mas nenhum post é agendado ou publicado pelo sistema.
          </Callout>
        )}
      </fieldset>

      <fieldset className={GROUP}>
        <legend className={LEGEND}>Carteira</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={`${prefix}-responsibleUserId`} label="Redatora responsável" optional error={errors.responsibleUserId}>
            <Select
              value={values.responsibleUserId}
              onChange={(e) => set({ responsibleUserId: e.target.value })}
              disabled={disabled}
            >
              <option value="">Sem redatora</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            id={`${prefix}-designerUserId`}
            label="Designer"
            optional
            help="Recebe as artes deste cliente na página Design."
            error={errors.designerUserId}
          >
            <Select
              value={values.designerUserId}
              onChange={(e) => set({ designerUserId: e.target.value })}
              disabled={disabled}
            >
              <option value="">Sem designer</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field id={`${prefix}-segment`} label="Segmento" optional error={errors.segment}>
            <Select value={values.segment} onChange={(e) => set({ segment: e.target.value })} disabled={disabled}>
              <option value="">Sem segmento</option>
              {SEGMENTS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          {mode === "edit" && (
            <Field
              id={`${prefix}-status`}
              label="Status"
              help="Pausado e encerrado saem das listas padrão. Não bloqueia a publicação."
              error={errors.status}
            >
              <Select value={values.status} onChange={(e) => set({ status: e.target.value })} disabled={disabled}>
                {CLIENT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {labelOf(CLIENT_STATUS, s)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        {showStatusWarning && (
          <Callout tone="warning">
            {queuedPostsCount} {plural(queuedPostsCount, "post agendado ou com falha continua", "posts agendados ou com falha continuam")}{" "}
            na fila. Para não publicar, marque “Não” em “Agendar os posts deste cliente?”.
          </Callout>
        )}
      </fieldset>

      <fieldset className={GROUP}>
        <legend className={LEGEND}>Conteúdo e Drive</legend>
        <Field
          id={`${prefix}-toneOfVoice`}
          label="Tom de voz"
          optional
          help="A IA escreve as legendas a partir dele. Use **texto** para negrito."
          error={errors.toneOfVoice}
        >
          <Textarea
            rows={mode === "edit" ? 8 : 4}
            value={values.toneOfVoice}
            onChange={(e) => set({ toneOfVoice: e.target.value })}
            disabled={disabled}
            placeholder="Ex.: tom profissional e próximo, foco em seguros…"
          />
        </Field>
        <Field
          id={`${prefix}-driveFolderId`}
          kind="group"
          label="Pasta do cliente no Drive"
          optional
          help={
            <>
              Escolha a pasta do cliente. Dentro dela: <span className="font-mono">AAAA/MM - Mês/1.jpg</span>,{" "}
              <span className="font-mono">1story.jpg</span>, <span className="font-mono">2/</span> (carrossel). Vazio = o
              sistema procura uma pasta com o nome do cliente.
            </>
          }
          error={errors.driveFolderId}
        >
          <DriveFolderPicker value={values.driveFolderId} onChange={(id) => set({ driveFolderId: id })} />
        </Field>
      </fieldset>

      {(mode === "edit" || isBasica) && (
        <fieldset className={GROUP}>
          <legend className={LEGEND}>{isBasica ? "Marca e contato" : "Marca"}</legend>

          {mode === "edit" ? (
            <Field
              id={`${prefix}-logoUrl`}
              kind="group"
              label="Logo"
              help={`PNG, JPG ou WebP, até 8 MB. Aparece no link de aprovação${isBasica ? " e na arte gerada por IA" : ""}.`}
              error={uploadError ?? errors.logoUrl}
            >
              <div className="flex flex-wrap items-center gap-3">
                <Avatar name={values.name || "Cliente"} src={values.logoUrl || null} size="lg" shape="square" />
                <Button
                  variant="secondary"
                  size="sm"
                  leadingIcon={<Icon.upload />}
                  loading={uploading}
                  loadingText="Enviando…"
                  disabled={disabled}
                  onClick={() => logoInputRef.current?.click()}
                >
                  {values.logoUrl ? "Trocar logo" : "Enviar logo"}
                </Button>
                {values.logoUrl && (
                  <Button variant="ghost" size="sm" disabled={disabled || uploading} onClick={() => set({ logoUrl: "" })}>
                    Remover logo
                  </Button>
                )}
                <input
                  ref={logoInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  tabIndex={-1}
                  aria-hidden="true"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void uploadLogo(file);
                  }}
                />
              </div>
            </Field>
          ) : (
            <p className="text-sm text-fg-muted">A logo é enviada depois, na página do cliente.</p>
          )}

          {isBasica && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  id={`${prefix}-brandColor`}
                  label="Cor da marca"
                  help="Usada na arte gerada por IA. Formato #RRGGBB."
                  error={errors.brandColor}
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      aria-label="Escolher a cor da marca"
                      value={HEX_COLOR.test(values.brandColor) ? values.brandColor : DEFAULT_BRAND_COLOR}
                      onChange={(e) => set({ brandColor: e.target.value })}
                      disabled={disabled}
                      className="h-11 w-12 shrink-0 cursor-pointer rounded-control border border-line-strong bg-surface p-1 disabled:cursor-not-allowed sm:h-10"
                    />
                    <Input
                      value={values.brandColor}
                      onChange={(e) => set({ brandColor: e.target.value.trim() })}
                      disabled={disabled}
                      maxLength={7}
                      autoComplete="off"
                      className="font-mono"
                      placeholder="#RRGGBB"
                    />
                  </div>
                </Field>
                <Field id={`${prefix}-showContacts`} label="Exibir dados de contato na arte?" error={errors.showContacts}>
                  <Select
                    value={values.showContacts ? "sim" : "nao"}
                    onChange={(e) => set({ showContacts: e.target.value === "sim" })}
                    disabled={disabled}
                  >
                    <option value="nao">Não — arte sem bloco de contato</option>
                    <option value="sim">Sim — usa os contatos do cliente</option>
                  </Select>
                </Field>
              </div>

              {values.showContacts && mode === "edit" && (
                <p className="text-sm text-fg-muted">
                  Os contatos (telefone, WhatsApp, site, Instagram e cidade) ficam em “Briefing do cliente”, mais abaixo.
                </p>
              )}

              {values.showContacts && mode === "create" && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field id={`${prefix}-whatsapp`} label="WhatsApp" optional error={errors.whatsapp}>
                    <Input
                      value={values.whatsapp}
                      onChange={(e) => set({ whatsapp: e.target.value })}
                      disabled={disabled}
                      maxLength={40}
                      inputMode="tel"
                      placeholder="(11) 99999-9999"
                    />
                  </Field>
                  <Field id={`${prefix}-phone`} label="Telefone" optional error={errors.phone}>
                    <Input
                      value={values.phone}
                      onChange={(e) => set({ phone: e.target.value })}
                      disabled={disabled}
                      maxLength={40}
                      inputMode="tel"
                      placeholder="(11) 3333-3333"
                    />
                  </Field>
                  <Field id={`${prefix}-website`} label="Site" optional error={errors.website}>
                    <Input
                      value={values.website}
                      onChange={(e) => set({ website: e.target.value })}
                      disabled={disabled}
                      maxLength={200}
                      placeholder="www.cliente.com.br"
                    />
                  </Field>
                  <Field id={`${prefix}-instagramUrl`} label="Instagram" optional error={errors.instagramUrl}>
                    <Input
                      value={values.instagramUrl}
                      onChange={(e) => set({ instagramUrl: e.target.value })}
                      disabled={disabled}
                      maxLength={200}
                      placeholder="instagram.com/cliente"
                    />
                  </Field>
                  <Field id={`${prefix}-city`} label="Cidade - UF" optional error={errors.city} className="sm:col-span-2">
                    <Input
                      value={values.city}
                      onChange={(e) => set({ city: e.target.value })}
                      disabled={disabled}
                      maxLength={120}
                      placeholder="São Paulo - SP"
                    />
                  </Field>
                </div>
              )}
            </>
          )}
        </fieldset>
      )}
    </div>
  );
}

function ErrorSummary({ title, items }: { title: string; items: string[] }) {
  return (
    <Callout tone="danger" live="assertive" title={title}>
      {items.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5">
          {items.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
    </Callout>
  );
}

type Summary = { title: string; items: string[] } | null;

/* ------------------------------------------------------------------ *
 * Criação (clients/new)
 * ------------------------------------------------------------------ */

const NEW_PREFIX = "novo-cliente";

export function NewClientForm({ users }: { users: UserOption[] }) {
  const router = useRouter();
  const [values, setValues] = useState<FormValues>(EMPTY_VALUES);
  const [errors, setErrors] = useState<FormErrors>({});
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState<Summary>(null);
  const [saving, setSaving] = useState(false);

  function set(patch: Partial<FormValues>) {
    setValues((v) => ({ ...v, ...patch }));
  }

  function fail(title: string, fields: FormErrors, extra?: string) {
    setErrors(fields);
    const items = errorList(fields);
    setSummary({ title, items: items.length > 0 ? items : extra ? [extra] : [] });
    focusFirstInvalid(NEW_PREFIX, fields);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const local = validate(values);
    setItemErrors({});
    if (Object.keys(local).length > 0) {
      fail("Confira os campos destacados.", local);
      return;
    }

    const v = values;
    const basica = v.tier === "basica";
    const contacts: Record<string, string> = {};
    if (basica && v.showContacts) {
      for (const k of ["whatsapp", "phone", "website", "instagramUrl", "city"] as const) {
        if (v[k].trim()) contacts[k] = v[k].trim();
      }
    }
    const body = {
      name: v.name.trim(),
      email: v.email.trim(),
      plan: v.plan,
      tier: v.tier,
      ...packageBody(v),
      agencyPublishes: v.agencyPublishes,
      ...(v.extraEmails.length > 0 ? { extraEmails: v.extraEmails } : {}),
      ...(v.responsibleUserId ? { responsibleUserId: v.responsibleUserId } : {}),
      ...(v.designerUserId ? { designerUserId: v.designerUserId } : {}),
      ...(v.segment ? { segment: v.segment } : {}),
      ...(v.toneOfVoice.trim() ? { toneOfVoice: v.toneOfVoice } : {}),
      ...(v.driveFolderId.trim() ? { driveFolderId: v.driveFolderId.trim() } : {}),
      ...(basica ? { brandColor: v.brandColor, showContacts: v.showContacts, ...contacts } : {}),
    };

    setSaving(true);
    setSummary(null);
    setErrors({});
    let res: Response;
    try {
      res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      setSaving(false);
      fail("Não foi possível criar o cliente.", {}, NETWORK_ERROR);
      return;
    }
    if (!res.ok) {
      const failure = await readFailure(res, "Tente de novo em instantes.");
      setSaving(false);
      setItemErrors(failure.itemErrors);
      fail("Não foi possível criar o cliente.", failure.fields, failure.message);
      return;
    }
    const created: unknown = await res.json().catch(() => null);
    const id = created && typeof created === "object" ? (created as { id?: unknown }).id : undefined;
    if (typeof id !== "string") {
      router.push("/clients");
      return;
    }
    // continua "Criando…" até a navegação terminar (evita envio duplo)
    router.push(`/clients/${id}`);
    router.refresh();
  }

  return (
    <form noValidate onSubmit={onSubmit} aria-busy={saving || undefined} className="card grid gap-8 p-5 sm:p-6">
      {summary && <ErrorSummary title={summary.title} items={summary.items} />}
      <ClientFormFields
        mode="create"
        prefix={NEW_PREFIX}
        values={values}
        set={set}
        errors={errors}
        itemErrors={itemErrors}
        users={users}
        disabled={saving}
      />
      <div className="flex flex-col-reverse gap-3 border-t border-line pt-5 sm:flex-row sm:justify-end">
        <Link href="/clients" className={buttonClasses({ variant: "secondary" })}>
          Cancelar
        </Link>
        <Button type="submit" variant="primary" loading={saving} loadingText="Criando…">
          Criar cliente
        </Button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ *
 * Detalhe: leitura + edição
 * ------------------------------------------------------------------ */

const EDIT_PREFIX = "editar-cliente";

function InfoItem({ label, children, wide = false }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={`min-w-0 ${wide ? "sm:col-span-2 lg:col-span-3" : ""}`}>
      <dt className="text-xs font-semibold uppercase tracking-overline text-fg-muted">{label}</dt>
      <dd className="mt-1 text-sm text-fg">{children}</dd>
    </div>
  );
}

export default function ClientInfoEditor({
  client,
  users,
  queuedPostsCount = 0,
}: {
  client: ClientInfo;
  users: UserOption[];
  /** posts scheduled + failed agora (aviso ao pausar/encerrar, A10) */
  queuedPostsCount?: number;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<FormValues>(() => valuesFromClient(client));
  const [errors, setErrors] = useState<FormErrors>({});
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState<Summary>(null);
  const [saving, setSaving] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState>(null);
  const [toneExpanded, setToneExpanded] = useState(false);
  const editButtonRef = useRef<HTMLButtonElement>(null);

  const writer = users.find((u) => u.id === client.responsibleUserId);
  const designer = users.find((u) => u.id === client.designerUserId);
  const tone = client.toneOfVoice?.trim() ?? "";
  const toneIsLong = tone.length > 400 || tone.split("\n").length > 6;

  function set(patch: Partial<FormValues>) {
    setValues((v) => ({ ...v, ...patch }));
  }

  function startEditing(focusKey: FieldKey = "name") {
    if (!editing) {
      setValues(valuesFromClient(client));
      setErrors({});
      setItemErrors({});
      setSummary(null);
      setEditing(true);
    }
    focusFieldWhenReady(EDIT_PREFIX, focusKey);
  }

  // Gancho #editar-<campo>: abre a edição no campo pedido e tira o hash da URL (o mesmo link funciona de novo).
  const onEditHash = useEffectEvent(() => {
    const match = /^#editar-([A-Za-z]+)$/.exec(window.location.hash);
    if (!match || !isFieldKey(match[1])) return;
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    startEditing(match[1]);
  });

  useEffect(() => {
    const onHashChange = () => onEditHash();
    // hash já na URL ao abrir a página (link de outra tela): trata depois do 1º quadro
    const raf = requestAnimationFrame(onHashChange);
    window.addEventListener("hashchange", onHashChange);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  function stopEditing() {
    setEditing(false);
    setSummary(null);
    requestAnimationFrame(() => editButtonRef.current?.focus());
  }

  async function save(fromDialog: boolean) {
    const v = values;
    const body = {
      name: v.name.trim(),
      email: v.email.trim(),
      extraEmails: v.extraEmails,
      plan: v.plan,
      tier: v.tier,
      ...packageBody(v),
      agencyPublishes: v.agencyPublishes,
      responsibleUserId: v.responsibleUserId || null,
      designerUserId: v.designerUserId || null,
      segment: v.segment || null,
      status: v.status,
      toneOfVoice: v.toneOfVoice,
      driveFolderId: v.driveFolderId,
      logoUrl: v.logoUrl,
      ...(v.tier === "basica" ? { brandColor: v.brandColor, showContacts: v.showContacts } : {}),
    };
    setSaving(true);
    setDialogError(null);
    const result = await patchClient(client.id, body);
    setSaving(false);
    if (!result.ok) {
      const { fields, itemErrors: items, message } = result.failure;
      setErrors(fields);
      setItemErrors(items);
      if (fromDialog) {
        setDialogError(message);
      } else {
        const list = errorList(fields);
        setSummary({ title: "Não foi possível salvar.", items: list.length > 0 ? list : [message] });
        focusFirstInvalid(EDIT_PREFIX, fields);
      }
      return;
    }
    const reverted = typeof result.data.revertedToDraft === "number" ? result.data.revertedToDraft : 0;
    const stopped = client.agencyPublishes && !v.agencyPublishes;
    setConfirmStop(false);
    stopEditing();
    setToast({
      kind: "success",
      text: stopped ? stoppedPublishingMessage(v.name.trim() || client.name, reverted) : "Alterações salvas.",
    });
    router.refresh();
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const local = validate(values);
    setItemErrors({});
    if (Object.keys(local).length > 0) {
      setErrors(local);
      setSummary({ title: "Confira os campos destacados.", items: errorList(local) });
      focusFirstInvalid(EDIT_PREFIX, local);
      return;
    }
    setErrors({});
    setSummary(null);
    // Sim → Não: confirma com a contagem exata antes de salvar (A4)
    if (client.agencyPublishes && !values.agencyPublishes) {
      setDialogError(null);
      setConfirmStop(true);
      return;
    }
    void save(false);
  }

  return (
    <section aria-labelledby="cadastro-titulo" className="card p-5 sm:p-6">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar
            name={client.name}
            src={client.logoUrl}
            size="lg"
            shape="square"
            color={clientColor(client.id, client.brandColor)} // cor-de-dado: anel com a cor do cliente
          />
          {/* rótulo da seção em cima, nome do cliente em destaque: "Cadastro" não pode parecer o nome da empresa */}
          <div className="min-w-0">
            <h2 id="cadastro-titulo" className="text-xs font-semibold uppercase tracking-overline text-fg-muted">
              {editing ? "Editar cadastro" : "Cadastro do cliente"}
            </h2>
            <p className="truncate font-display text-lg font-semibold tracking-title text-fg" title={client.name}>
              {client.name}
            </p>
            <p className="truncate text-sm text-fg-muted" title={client.email}>
              {client.email}
            </p>
          </div>
        </div>
        {!editing && (
          <Button ref={editButtonRef} size="sm" leadingIcon={<Icon.edit />} onClick={() => startEditing()}>
            Editar
          </Button>
        )}
      </div>

      {!editing ? (
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
          <InfoItem label="E-mails adicionais">
            {client.extraEmails.length === 0 ? (
              <span className="text-fg-muted">Nenhum</span>
            ) : (
              <ul className="grid gap-0.5">
                {client.extraEmails.map((e) => (
                  <li key={e} className="truncate" title={e}>
                    {e}
                  </li>
                ))}
              </ul>
            )}
          </InfoItem>
          <InfoItem label="Plano">{labelOf(PLAN, client.plan)}</InfoItem>
          <InfoItem label="Pacote de gestão">
            {client.tier === "completa" ? <StatusBadge kind="tier" status="completa" /> : labelOf(TIER, client.tier)}
            {packageDetails(client) && <span className="mt-0.5 block text-fg-muted">{packageDetails(client)}</span>}
          </InfoItem>
          <InfoItem label="Agendar posts?">
            {client.agencyPublishes ? (
              "Sim — o sistema agenda e publica"
            ) : (
              <span title="A agência produz o conteúdo, mas o sistema não agenda nem publica.">
                <StatusBadge kind="agencyPublishes" status="nao" />
              </span>
            )}
          </InfoItem>
          <InfoItem label="Redatora">{writer?.name ?? <span className="text-fg-muted">Sem redatora</span>}</InfoItem>
          <InfoItem label="Designer">{designer?.name ?? <span className="text-fg-muted">Sem designer</span>}</InfoItem>
          <InfoItem label="Segmento">
            {client.segment ? (
              <StatusBadge kind="segment" status={client.segment} />
            ) : (
              <span className="text-fg-muted">Sem segmento</span>
            )}
          </InfoItem>
          <InfoItem label="Status">
            <StatusBadge kind="client" status={client.status} />
          </InfoItem>
          {client.tier === "basica" && (
            <InfoItem label="Cor da marca">
              {client.brandColor ? (
                <span className="inline-flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="size-4 rounded-full border border-line-strong"
                    style={{ background: client.brandColor }} // cor-de-dado: amostra da cor da marca
                  />
                  <span className="font-mono">{client.brandColor}</span>
                </span>
              ) : (
                <span className="text-fg-muted">Não definida</span>
              )}
            </InfoItem>
          )}
          <InfoItem label="Tom de voz" wide>
            {tone ? (
              <>
                <p id="tom-de-voz" className={`max-w-prose text-fg-muted ${toneExpanded ? "" : "line-clamp-6"}`}>
                  <ToneOfVoiceText text={tone} />
                </p>
                {toneIsLong && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-expanded={toneExpanded}
                    aria-controls="tom-de-voz"
                    onClick={() => setToneExpanded((x) => !x)}
                    className="-ml-3 mt-1"
                  >
                    {toneExpanded ? "Mostrar menos" : "Ver tom de voz completo"}
                  </Button>
                )}
              </>
            ) : (
              <span className="text-fg-muted">Não definido</span>
            )}
          </InfoItem>
        </dl>
      ) : (
        <form noValidate onSubmit={onSubmit} aria-busy={saving || undefined} className="grid gap-8">
          {summary && <ErrorSummary title={summary.title} items={summary.items} />}
          <ClientFormFields
            mode="edit"
            prefix={EDIT_PREFIX}
            values={values}
            set={set}
            errors={errors}
            itemErrors={itemErrors}
            users={users}
            disabled={saving}
            clientId={client.id}
            originalStatus={client.status}
            queuedPostsCount={queuedPostsCount}
          />
          <div className="flex flex-col-reverse gap-3 border-t border-line pt-5 sm:flex-row sm:justify-end">
            <Button variant="secondary" disabled={saving} onClick={stopEditing}>
              Cancelar
            </Button>
            <Button type="submit" variant="primary" loading={saving && !confirmStop} loadingText="Salvando…">
              Salvar alterações
            </Button>
          </div>
        </form>
      )}

      {confirmStop && (
        <StopPublishingDialog
          clientId={client.id}
          clientName={client.name}
          busy={saving}
          error={dialogError}
          onConfirm={() => void save(true)}
          onCancel={() => {
            setConfirmStop(false);
            setDialogError(null);
          }}
        />
      )}

      <Toast toast={toast} onClose={() => setToast(null)} />
    </section>
  );
}
