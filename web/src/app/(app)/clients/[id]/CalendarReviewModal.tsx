"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AssistantPanel } from "@/components/AssistantPanel";
import { BrandBadge, BRAND } from "@/components/BrandIcons";
import { Button, Spinner } from "@/components/Button";
import { Callout } from "@/components/Callout";
import { DateTimePicker } from "@/components/DatePickers";
import { ConfirmDialog, Dialog } from "@/components/Dialog";
import { Field, Input, Select, Textarea } from "@/components/Field";
import { Icon } from "@/components/Icons";
import { MediaField } from "@/components/MediaField";
import { SlidesEditor } from "@/components/SlidesEditor";
import { FormatBadge, ToneBadge } from "@/components/ui";
import { createCaptionDispatcher, type CaptionDispatcher } from "@/lib/caption-dispatcher";
import { describeFeedCounts, isContentKind, kindForFormat } from "@/lib/content-packages";
import { buildMonthFileNames, canonicalMonthFolderName, parseMonthKey, type MonthFileName } from "@/lib/drive-layout";
import { FORMAT_OPTIONS } from "@/lib/formats";
import { formatMonthLabel, spLocalInputFromISO, spLocalInputToISO } from "@/lib/format-date";
import { toUserMessage } from "@/lib/user-facing-error";

export type PreviewPost = {
  theme: string;
  format: string;
  explanation?: string;
  captions: Record<string, string>;
  scheduledAt: string; // ISO
  targets: string[];
  mediaUrl: string;
  /** slot do pacote de gestão (lib/content-packages): tipo do conteúdo */
  contentKind?: string | null;
  /** slot do pacote: story junto? (story exclusivo não tem) — sem isso, todo post não-story tem */
  withStory?: boolean;
};

/** Pacote de gestão do cronograma gerado (POST /api/ai/calendar → `package`). */
export type PreviewPackage = {
  label: string;
  /** postagens que o mês inteiro teria */
  planned: number;
  /** postagens geradas (mês já começado: só as dos dias que faltam) */
  generated: number;
};

type ReviewPost = {
  uid: string;
  theme: string;
  format: string;
  // breve explicação do tema — é o que o cliente aprova na fase cronograma
  explanation: string;
  captions: Record<string, string>;
  slides: string[];
  scheduledLocal: string; // "YYYY-MM-DDTHH:MM"
  targets: string[];
  mediaUrl: string;
  // story sai junto do post (15 min depois, arte própria "Nstory.*")
  withStory: boolean;
  // tipo do conteúdo no pacote de gestão (posts.content_kind); null = sem tipo
  contentKind: string | null;
};

/** Post já salvo do cliente: entra na numeração das artes do mês, como no sync. */
type SavedPost = { id: string; format: string; at: number };

/** O commit gravou, mas o Drive falhou: a equipe precisa ver o aviso antes de sair. */
type Saved = { created: number; duplicates: number; driveWarning: string; captionsPending: number };

/**
 * Legenda gerada em segundo plano (POST /api/ai/calendar/captions): "pending" = na fila ou
 * em andamento; "failed" = o lote falhou (botão "Tentar de novo"). Sem entrada = pronta ou
 * fora da geração (sem título, sem rede, editada à mão…).
 */
type CaptionStatus = "pending" | "failed";

/** Campos que a pessoa editou à mão: a geração em segundo plano nunca os sobrescreve. */
type ManualEdits = { shared?: boolean; linkedin?: boolean; slides?: boolean };

/** Post enviado num lote: versão e texto de entrada no envio (para descartar resposta velha). */
type SentPost = { uid: string; version: number; key: string };

/** Posts por chamada e chamadas simultâneas (lib/calendar-captions: CAPTION_BATCH_SIZE/CONCURRENCY). */
const CAPTION_BATCH = 4;
const CAPTION_PARALLEL = 3;
const CAPTION_ERROR = "Não foi possível gerar as legendas agora. Tente de novo em instantes.";
const CAPTION_CONNECTION_ERROR = "Falha de conexão ao gerar as legendas. Verifique a internet e tente de novo.";
/** Título/explicação/formato editado há menos disso: espera a pessoa parar de digitar antes de gerar. */
const CAPTION_IDLE_MS = 1200;
/** Salvar espera no máximo isso pelos lotes que já estão na IA; o resto o servidor completa (after). */
const SAVE_WAIT_MS = 6000;

const STORY_DELAY_MS = 15 * 60_000;
const SAVE_ERROR = "Não foi possível salvar o cronograma. Tente de novo em instantes.";
const CONNECTION_ERROR = "Falha de conexão ao salvar. Verifique a internet e tente de novo.";

let uidSeq = 0;

const wantsSlides = (format: string) => format === "carrossel" || format === "reels";
const hasCaption = (p: ReviewPost) => ["instagram", "facebook", "linkedin"].some((k) => !!p.captions[k]?.trim());
const hasSlides = (p: ReviewPost) => p.slides.some((s) => s.trim());

/** Entra na geração em segundo plano: tem título e rede, e falta legenda (ou slides de carrossel/reels). */
const needsCaption = (p: ReviewPost) =>
  !!p.theme.trim() && p.targets.length > 0 && (!hasCaption(p) || (wantsSlides(p.format) && !hasSlides(p)));

/** O que a legenda gerada usou: se mudar enquanto o lote está na IA, a resposta é refeita. */
const captionInputKey = (p: ReviewPost) => JSON.stringify([p.theme.trim(), p.explanation.trim(), p.format]);

const pad2 = (n: number) => String(n).padStart(2, "0");
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * Resumo do pacote pelas postagens da revisão (muda com as edições):
 * "Gestão 2 · 12 posts: 3 reels, 1 banner, 2 carrosséis, 6 estáticos" (+ stories na Gestão 3).
 */
function packageSummaryOf(label: string, posts: ReviewPost[]): string {
  const counts: Record<string, number> = {};
  let feed = 0;
  let replicas = 0;
  let exclusive = 0;
  let other = 0;
  for (const p of posts) {
    if (p.format === "story") {
      if (p.contentKind === "story_exclusivo") exclusive++;
      else other++;
      continue;
    }
    feed++;
    if (p.withStory) replicas++;
    if (p.contentKind) counts[p.contentKind] = (counts[p.contentKind] ?? 0) + 1;
  }
  const kinds = describeFeedCounts(counts);
  let text = `${label} · ${feed} ${plural(feed, "post", "posts")}${kinds ? `: ${kinds}` : ""}`;
  if (exclusive > 0) {
    const stories = replicas + exclusive + other;
    text += ` + ${stories} ${plural(stories, "story", "stories")} (${replicas} ${plural(replicas, "réplica", "réplicas")}, ${exclusive} ${plural(exclusive, "exclusivo", "exclusivos")})`;
  }
  return text;
}

/** Instante (ms) de um "YYYY-MM-DDTHH:MM" lido como horário de São Paulo; null se inválido. */
function spLocalToMs(local: string): number | null {
  try {
    const ms = Date.parse(spLocalInputToISO(local));
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

/** Mês civil de SP ("2026-11") de um instante. */
const spMonthOf = (ms: number) => spLocalInputFromISO(new Date(ms)).slice(0, 7);

/** "2026-11" → "2026/11 - Novembro" (pasta do mês dentro da pasta do cliente). */
function monthFolderPath(monthKey: string): string | null {
  try {
    const { year, month } = parseMonthKey(monthKey);
    return `${year}/${canonicalMonthFolderName(month)}`;
  } catch {
    return null;
  }
}

/** Nome da arte do post no Drive, por formato (docs/08-DRIVE-ESTRUTURA.md): story "Nstory.jpg", "Nstory2.jpg"… */
function artName(format: string, name: MonthFileName): string {
  const n = name.index;
  if (format === "story") return `${name.fileStem}.jpg`;
  if (format === "carrossel") return `${n}/ (pasta com os slides)`;
  if (format === "reels") return `${n}.mp4`;
  return `${n}.jpg`;
}

/**
 * Caminho das artes de cada post da revisão, com os mesmos nomes do sync
 * (`buildMonthFileNames`): todos os posts do cliente no mês, em ordem de data,
 * com o story junto 15 min depois do post. Posts já salvos com o mesmo
 * horário e formato contam uma vez só (o commit não os duplica).
 */
function artPaths(posts: ReviewPost[], saved: SavedPost[]) {
  type Entry = { id: string; format: string; at: number; rank: number };
  const fresh: Entry[] = [];
  posts.forEach((p, i) => {
    const at = spLocalToMs(p.scheduledLocal);
    if (at === null) return;
    fresh.push({ id: p.uid, format: p.format, at, rank: 1 + i * 2 });
    if (p.withStory && p.format !== "story") {
      fresh.push({ id: `${p.uid}:story`, format: "story", at: at + STORY_DELAY_MS, rank: 2 + i * 2 });
    }
  });
  const taken = new Set(fresh.map((e) => `${e.at}:${e.format}`));
  const entries = [
    ...saved.filter((s) => !taken.has(`${s.at}:${s.format}`)).map((s) => ({ ...s, rank: 0 })),
    ...fresh,
  ].sort((a, b) => a.at - b.at || a.rank - b.rank);

  const byMonth = new Map<string, Entry[]>();
  for (const e of entries) {
    const key = spMonthOf(e.at);
    byMonth.set(key, [...(byMonth.get(key) ?? []), e]);
  }
  const paths = new Map<string, string>();
  for (const [key, list] of byMonth) {
    const folder = monthFolderPath(key);
    if (!folder) continue;
    const names = buildMonthFileNames(list);
    for (const e of list) {
      const name = names.get(e.id);
      if (name) paths.set(e.id, `${folder}/${artName(e.format, name)}`);
    }
  }
  return paths;
}

export default function CalendarReviewModal({
  clientId,
  clientName,
  month,
  availablePlatforms,
  initialPosts,
  packageInfo = null,
  onClose,
  onCommitted,
}: {
  clientId: string;
  clientName: string;
  month: string; // YYYY-MM
  availablePlatforms: string[];
  initialPosts: PreviewPost[];
  /** cliente com pacote de gestão: resumo e aviso de mês já começado */
  packageInfo?: PreviewPackage | null;
  /** descartar a revisão (nada foi salvo) */
  onClose: () => void;
  /** o cronograma foi salvo; `openCalendar` = ir para o calendário do mês */
  onCommitted: (opts: { openCalendar: boolean }) => void;
}) {
  const [posts, setPosts] = useState<ReviewPost[]>(() =>
    initialPosts.map((p) => {
      // legado "feed_story" vira feed + story junto; todo post não-story
      // nasce com story junto (regra da redação)
      const isLegacyFeedStory = p.format === "feed_story";
      const format = isLegacyFeedStory ? "feed" : p.format;
      return {
        uid: `r${uidSeq++}`,
        theme: p.theme,
        format,
        explanation: p.explanation ?? "",
        captions: p.captions ?? {},
        slides: [],
        scheduledLocal: spLocalInputFromISO(p.scheduledAt),
        targets: p.targets,
        mediaUrl: p.mediaUrl ?? "",
        withStory: format !== "story" && p.withStory !== false,
        contentKind: isContentKind(p.contentKind) ? p.contentKind : null,
      };
    })
  );
  // legendas geradas em segundo plano enquanto a equipe revisa (pedido do usuário em 07/10)
  const [captionStatus, setCaptionStatus] = useState<Record<string, CaptionStatus>>(() =>
    Object.fromEntries(posts.filter(needsCaption).map((p) => [p.uid, "pending" as const]))
  );
  const [captionError, setCaptionError] = useState("");
  // fontes da verdade do despacho, atualizadas na hora (o estado só muda no próximo render)
  const postsRef = useRef(posts);
  const statusRef = useRef(captionStatus);
  const dispatcherRef = useRef<CaptionDispatcher | null>(null);
  const substituteTasksRef = useRef(new Set<Promise<void>>());
  const [finishingCaptions, setFinishingCaptions] = useState(false);
  // versão por post: Substituir/nova ideia/exclusão invalidam a resposta de um lote já enviado
  const versionRef = useRef<Record<string, number>>({});
  const manualRef = useRef<Record<string, ManualEdits>>({});
  const captionSummaryRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [regenerating, setRegenerating] = useState<Record<string, boolean>>({});
  // LinkedIn editado manualmente (deixa de espelhar a legenda FB+IG)
  const [liDirty, setLiDirty] = useState<Record<string, boolean>>({});
  const [assistantUid, setAssistantUid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // alguma edição feita pela equipe (muda o texto da confirmação de descarte)
  const [edited, setEdited] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [savedPosts, setSavedPosts] = useState<SavedPost[]>([]);
  const calendarButtonRef = useRef<HTMLButtonElement>(null);
  const listId = useId();

  // posts que o cliente já tem: a numeração das artes (N.jpg, Nstory.jpg) conta todos
  // os posts do mês. Sem eles (falha de rede), numera só os desta revisão.
  useEffect(() => {
    let alive = true;
    fetch(`/api/posts?clientId=${encodeURIComponent(clientId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: unknown) => {
        if (!alive || !Array.isArray(data)) return;
        const list: SavedPost[] = [];
        for (const p of data as { id?: unknown; format?: unknown; scheduledAt?: unknown }[]) {
          const at = typeof p.scheduledAt === "string" ? Date.parse(p.scheduledAt) : NaN;
          if (typeof p.id === "string" && typeof p.format === "string" && !Number.isNaN(at)) {
            list.push({ id: p.id, format: p.format, at });
          }
        }
        setSavedPosts(list);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [clientId]);

  // salvo com aviso do Drive: o foco vai para a próxima ação
  useEffect(() => {
    if (saved) calendarButtonRef.current?.focus();
  }, [saved]);

  const platforms = availablePlatforms.length ? availablePlatforms : ["instagram", "facebook"];
  const withArt = posts.filter((p) => p.mediaUrl.trim()).length;
  const monthLabel = formatMonthLabel(month);
  const paths = useMemo(() => artPaths(posts, savedPosts), [posts, savedPosts]);

  /** Estado mostrado: "pending"/"failed" só enquanto o post ainda precisa de legenda. */
  function captionStateOf(p: ReviewPost): CaptionStatus | undefined {
    const status = captionStatus[p.uid];
    return status && needsCaption(p) ? status : undefined;
  }

  function setCaptionStatusOf(uids: string[], status: CaptionStatus | null) {
    const next = { ...statusRef.current };
    for (const uid of uids) {
      if (status) next[uid] = status;
      else delete next[uid];
    }
    statusRef.current = next;
    setCaptionStatus(next);
  }

  /** Muda os posts já no ref (o despacho e o salvar leem dele) e no estado (a tela). */
  function changePosts(fn: (prev: ReviewPost[]) => ReviewPost[]) {
    postsRef.current = fn(postsRef.current);
    setPosts(postsRef.current);
    dispatcherRef.current?.pump();
  }

  /** Nova versão do post: a resposta de um lote enviado antes disso é descartada. */
  function bumpCaptionVersion(uid: string) {
    versionRef.current[uid] = (versionRef.current[uid] ?? 0) + 1;
  }

  /** Cancela a geração em segundo plano (salvou ou descartou a revisão). */
  function stopCaptions() {
    dispatcherRef.current?.stop();
  }

  /** Um lote na rota de legendas; aplica a resposta antes de resolver (lib/caption-dispatcher). */
  async function sendCaptionBatch(batch: ReviewPost[], signal: AbortSignal) {
    const sent: SentPost[] = batch.map((p) => ({
      uid: p.uid,
      version: versionRef.current[p.uid] ?? 0,
      key: captionInputKey(p),
    }));
    try {
      const res = await fetch("/api/ai/calendar/captions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId,
          posts: batch.map((p) => ({
            id: p.uid,
            theme: p.theme.trim().slice(0, 200),
            explanation: p.explanation.trim().slice(0, 600) || undefined,
            format: p.format,
            ...(p.contentKind ? { contentKind: p.contentKind } : {}),
            targets: p.targets,
          })),
        }),
        signal,
      });
      const data = await res.json().catch(() => null);
      // cancelado (salvou/fechou): não aplica nada
      if (signal.aborted) return;
      if (!res.ok) {
        failCaptions(sent, toUserMessage(data, CAPTION_ERROR));
        return;
      }
      const results: unknown[] = Array.isArray(data?.posts) ? data.posts : [];
      const missing = sent.filter((s) => {
        const result = results.find((r) => !!r && typeof r === "object" && (r as { id?: unknown }).id === s.uid);
        return applyCaption(s, result) === "missing";
      });
      if (missing.length > 0) failCaptions(missing, CAPTION_ERROR);
    } catch {
      // cancelado (fechou/salvou) não é falha: o post continua "pending"
      if (!signal.aborted) failCaptions(sent, CAPTION_CONNECTION_ERROR);
    }
  }

  /** Lote falhou: marca os posts (ainda na mesma versão) para o "Tentar de novo". */
  function failCaptions(sent: SentPost[], message: string) {
    const uids = sent
      .filter((s) => (versionRef.current[s.uid] ?? 0) === s.version && postsRef.current.some((p) => p.uid === s.uid))
      .map((s) => s.uid);
    if (uids.length === 0) return;
    setCaptionStatusOf(uids, "failed");
    setCaptionError(message);
  }

  /**
   * Preenche a legenda (e os slides) de um post com a resposta do lote, sem sobrescrever o que
   * a pessoa editou à mão. Resposta velha (Substituir/exclusão depois do envio) é descartada;
   * se o título, a explicação ou o formato mudaram, o post continua "pending" e vai de novo.
   */
  function applyCaption(sent: SentPost, result: unknown): "applied" | "stale" | "missing" {
    if ((versionRef.current[sent.uid] ?? 0) !== sent.version) return "stale";
    const current = postsRef.current.find((p) => p.uid === sent.uid);
    if (!current || captionInputKey(current) !== sent.key) return "stale";
    const r = (result ?? {}) as { captions?: unknown; slides?: unknown };
    const caps = r.captions && typeof r.captions === "object" ? (r.captions as Record<string, unknown>) : {};
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const shared = str(caps.instagram) || str(caps.facebook);
    const li = str(caps.linkedin);
    if (!shared && !li) return "missing";
    const slides = Array.isArray(r.slides)
      ? r.slides.filter((x): x is string => typeof x === "string" && !!x.trim())
      : [];

    const manual = manualRef.current[sent.uid] ?? {};
    const keepShared = (p: ReviewPost) =>
      !!manual.shared && !!(p.captions.instagram ?? p.captions.facebook ?? "").trim();
    // LinkedIn espelha a legenda FB+IG: se ela foi escrita à mão, o espelho também fica
    const keepLinkedin = (p: ReviewPost) => keepShared(p) || (!!manual.linkedin && !!p.captions.linkedin?.trim());
    changePosts((prev) =>
      prev.map((p) => {
        if (p.uid !== sent.uid) return p;
        const captions = { ...p.captions };
        if (!keepShared(p) && shared) {
          captions.instagram = shared;
          captions.facebook = shared;
        }
        if (!keepLinkedin(p) && (li || shared)) captions.linkedin = li || shared;
        const fillSlides = wantsSlides(p.format) && slides.length > 0 && !hasSlides(p);
        return { ...p, captions, slides: fillSlides ? slides : p.slides };
      })
    );
    if (!keepLinkedin(current)) setLiDirty((d) => ({ ...d, [sent.uid]: !!li && li !== shared }));
    setCaptionStatusOf([sent.uid], null);
    return "applied";
  }

  function retryCaptions() {
    const uids = posts.filter((p) => captionStateOf(p) === "failed").map((p) => p.uid);
    if (uids.length === 0) return;
    setCaptionStatusOf(uids, "pending");
    setCaptionError("");
    dispatcherRef.current?.pump();
    // o aviso some: o foco vai para o resumo, que anuncia o andamento
    captionSummaryRef.current?.focus();
  }

  // abrir a revisão começa a gerar as legendas; fechar (desmontar) cancela os lotes em andamento.
  // O 1º despacho vai no próximo tique: a montagem dupla do StrictMode (dev) o cancela antes do fetch.
  useEffect(() => {
    const dispatcher = createCaptionDispatcher<ReviewPost>({
      getPosts: () => postsRef.current,
      getStatus: () => statusRef.current,
      needs: needsCaption,
      send: (batch, signal) => sendCaptionBatch(batch, signal),
      batchSize: CAPTION_BATCH,
      parallel: CAPTION_PARALLEL,
      idleMs: CAPTION_IDLE_MS,
    });
    dispatcherRef.current = dispatcher;
    const timer = setTimeout(() => dispatcher.pump(), 0);
    return () => {
      clearTimeout(timer);
      dispatcher.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- um despacho por abertura; `send` só lê refs
  }, []);

  /** Pedido de fechar (Esc, X, fundo, Cancelar): nunca descarta posts gerados sem confirmar. */
  function requestClose() {
    if (busy) return;
    if (saved) {
      onCommitted({ openCalendar: false });
      return;
    }
    if (posts.length === 0) {
      onClose();
      return;
    }
    setConfirmingDiscard(true);
  }

  function update(uid: string, patch: Partial<ReviewPost>) {
    setEdited(true);
    // mudou o que a IA usa: a geração deste post espera a pessoa parar de digitar
    if ("theme" in patch || "explanation" in patch || "format" in patch) dispatcherRef.current?.touch(uid);
    changePosts((prev) => prev.map((p) => (p.uid === uid ? { ...p, ...patch } : p)));
  }
  // legenda única FB+IG (LinkedIn espelha até ser editado)
  function updateShared(uid: string, text: string) {
    setEdited(true);
    manualRef.current[uid] = { ...manualRef.current[uid], shared: true };
    changePosts((prev) =>
      prev.map((p) =>
        p.uid === uid
          ? {
              ...p,
              captions: {
                ...p.captions,
                instagram: text,
                facebook: text,
                ...(liDirty[uid] ? {} : { linkedin: text }),
              },
            }
          : p
      )
    );
  }
  function updateLinkedin(uid: string, text: string) {
    setEdited(true);
    manualRef.current[uid] = { ...manualRef.current[uid], linkedin: true };
    setLiDirty((d) => ({ ...d, [uid]: true }));
    changePosts((prev) =>
      prev.map((p) => (p.uid === uid ? { ...p, captions: { ...p.captions, linkedin: text } } : p))
    );
  }
  function updateSlides(uid: string, slides: string[]) {
    manualRef.current[uid] = { ...manualRef.current[uid], slides: true };
    update(uid, { slides });
  }
  function toggleTarget(uid: string, platform: string) {
    setEdited(true);
    changePosts((prev) =>
      prev.map((p) => {
        if (p.uid !== uid) return p;
        const has = p.targets.includes(platform);
        return {
          ...p,
          targets: has ? p.targets.filter((t) => t !== platform) : [...p.targets, platform],
        };
      })
    );
  }
  /**
   * Regenera a postagem a partir do TÍTULO atual (mesmo fluxo da criação
   * individual): legendas, hashtags e conteúdo refeitos para o novo título.
   * Sem título, sorteia um tema novo (comportamento antigo).
   */
  function substitute(uid: string) {
    const task = runSubstitute(uid);
    substituteTasksRef.current.add(task);
    void task.finally(() => substituteTasksRef.current.delete(task));
  }

  async function runSubstitute(uid: string) {
    const post = posts.find((p) => p.uid === uid);
    if (!post || post.targets.length === 0) {
      setError("Selecione ao menos uma rede antes de substituir.");
      return;
    }
    // o Substituir manda: a geração em segundo plano deste post para e a resposta antiga é descartada
    bumpCaptionVersion(uid);
    setCaptionStatusOf([uid], null);
    setRegenerating((r) => ({ ...r, [uid]: true }));
    setError("");
    let captionsReady = false;

    try {
      if (post.theme.trim()) {
        // título definido pelo usuário → regenera legenda (e slides, se
        // carrossel/reels) a partir dele
        const res = await fetch("/api/ai/caption", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clientId,
            theme: post.theme.trim(),
            targets: post.targets,
            format: post.format,
          }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          setError(toUserMessage(data, "Não foi possível refazer a postagem agora. Tente de novo em instantes."));
          return;
        }
        const g: Record<string, string> = data?.captions ?? {};
        const shared = g.instagram ?? g.facebook ?? "";
        captionsReady = !!(shared || g.linkedin);
        manualRef.current[uid] = {};
        setLiDirty((d) => ({ ...d, [uid]: !!g.linkedin && g.linkedin !== shared }));
        update(uid, {
          captions: { instagram: shared, facebook: shared, linkedin: g.linkedin ?? shared },
          ...(Array.isArray(data?.slides) && data.slides.length ? { slides: data.slides } : {}),
        });
        return;
      }

      // sem título → sorteia tema novo (evitando os existentes)
      const avoid = posts.filter((p) => p.uid !== uid).map((p) => p.theme).filter(Boolean);
      const res = await fetch("/api/ai/calendar/regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId,
          targets: post.targets,
          avoid,
          ...(post.contentKind ? { contentKind: post.contentKind } : {}),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(toUserMessage(data, "Não foi possível gerar uma nova ideia agora. Tente de novo em instantes."));
        return;
      }
      const theme = typeof data?.theme === "string" ? data.theme : post.theme;
      manualRef.current[uid] = {};
      setLiDirty((d) => ({ ...d, [uid]: false }));
      update(uid, {
        theme,
        // slot do pacote: o formato e o tipo continuam os do slot
        format: post.contentKind ? post.format : typeof data?.format === "string" ? data.format : post.format,
        explanation: typeof data?.explanation === "string" ? data.explanation : "",
        captions: {},
        slides: [],
        mediaUrl: "",
      });
      // a nova ideia ganha legenda em segundo plano, como as demais (sem esperar digitação)
      if (theme.trim()) {
        captionsReady = true;
        dispatcherRef.current?.untouch(uid);
        setCaptionStatusOf([uid], "pending");
        dispatcherRef.current?.pump();
      }
    } catch {
      setError("Falha de conexão com a IA. Verifique a internet e tente de novo.");
    } finally {
      setRegenerating((r) => ({ ...r, [uid]: false }));
      // falhou e o post ficou sem legenda: entra no "Tentar de novo"
      if (!captionsReady && post.theme.trim() && !hasCaption(post)) setCaptionStatusOf([uid], "failed");
    }
  }

  function removePost(uid: string) {
    setEdited(true);
    bumpCaptionVersion(uid);
    changePosts((prev) => prev.filter((p) => p.uid !== uid));
    if (assistantUid === uid) setAssistantUid(null);
  }

  /** nova postagem em branco: 2 dias após a última, 18h (dentro do mês) */
  function addPost() {
    const last = posts[posts.length - 1];
    let scheduledLocal: string;
    if (last?.scheduledLocal) {
      const d = new Date(`${last.scheduledLocal}:00`);
      d.setDate(d.getDate() + 2);
      scheduledLocal = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T18:00`;
    } else {
      scheduledLocal = `${month}-05T18:00`;
    }
    const fresh: ReviewPost = {
      uid: `r${uidSeq++}`,
      theme: "",
      format: "feed",
      explanation: "",
      captions: {},
      slides: [],
      scheduledLocal,
      targets: platforms,
      mediaUrl: "",
      withStory: true,
      contentKind: null,
    };
    setEdited(true);
    changePosts((prev) => [...prev, fresh]);
    // entra na geração em segundo plano quando ganhar título (depois de a pessoa parar de digitar)
    setCaptionStatusOf([fresh.uid], "pending");
    setExpanded((e) => ({ ...e, [fresh.uid]: true }));
  }

  async function approve() {
    if (posts.length === 0) {
      setError("Adicione ou mantenha ao menos um post.");
      return;
    }
    if (posts.some((p) => p.targets.length === 0)) {
      setError("Cada post precisa de ao menos uma rede social.");
      return;
    }
    setBusy(true);
    setError("");
    // salvando: nenhum lote novo; os que já estão na IA têm até SAVE_WAIT_MS para entrar no
    // commit; o que não chegar é cancelado (também na IA) ANTES do commit e o servidor completa
    const dispatcher = dispatcherRef.current;
    const substitutes = [...substituteTasksRef.current];
    const waiting = (dispatcher?.inFlight() ?? 0) > 0 || substitutes.length > 0;
    if (waiting) setFinishingCaptions(true);
    await dispatcher?.settle(SAVE_WAIT_MS, substitutes);
    if (waiting) setFinishingCaptions(false);
    // estado no instante do envio, com as legendas que acabaram de chegar
    const current = postsRef.current;
    let committed = false;
    try {
      const payload = {
        clientId,
        month,
        // "Story junto" vira um segundo post (story, 15 min depois) — cada um
        // com seu formato, casando com a convenção de mídia (N.* e Nstory.*)
        posts: current.flatMap((p) => {
          const captions: Record<string, string> = {};
          for (const t of p.targets) {
            const c = p.captions[t];
            if (c && c.trim()) captions[t] = c.trim();
          }
          const baseIso = spLocalInputToISO(p.scheduledLocal);
          const base = {
            theme: p.theme,
            explanation: p.explanation.trim() || undefined,
            captions,
            mediaUrl: p.mediaUrl.trim(),
            targets: p.targets,
          };
          const slides = p.slides.filter((s) => s.trim()).map((text) => ({ text }));
          const out: Record<string, unknown>[] = [
            {
              ...base,
              format: p.format,
              ...(p.contentKind ? { contentKind: p.contentKind } : {}),
              scheduledAt: baseIso,
              ...(slides.length && (p.format === "carrossel" || p.format === "reels") ? { slides } : {}),
            },
          ];
          if (p.withStory && p.format !== "story") {
            const storyIso = new Date(new Date(baseIso).getTime() + STORY_DELAY_MS).toISOString();
            out.push({
              ...base,
              format: "story",
              // pacote de gestão: o story junto é a réplica do post do feed
              ...(p.contentKind ? { contentKind: "story_replica" } : {}),
              mediaUrl: "",
              scheduledAt: storyIso,
            });
          }
          return out;
        }),
      };
      const res = await fetch("/api/ai/calendar/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(toUserMessage(data, SAVE_ERROR));
        return;
      }
      // salvo: o servidor completa as legendas que faltaram (after); a revisão para de gerar
      committed = true;
      stopCaptions();
      // Drive falhou (S16): o cronograma está salvo, mas a pasta do mês não foi preparada
      const warning = typeof data?.driveWarning === "string" ? data.driveWarning.trim() : "";
      if (warning) {
        setSaved({
          created: typeof data?.created === "number" ? data.created : 0,
          duplicates: typeof data?.duplicates === "number" ? data.duplicates : 0,
          driveWarning: warning,
          captionsPending: typeof data?.captionsPending === "number" ? data.captionsPending : 0,
        });
        return;
      }
      onCommitted({ openCalendar: true });
    } catch {
      setError(CONNECTION_ERROR);
    } finally {
      setBusy(false);
      // não salvou: a geração em segundo plano continua de onde parou
      if (!committed) dispatcher?.resume();
    }
  }

  const assistantPost = assistantUid ? posts.find((p) => p.uid === assistantUid) : undefined;
  const captionsReady = posts.filter(hasCaption).length;
  const captionsPending = posts.filter((p) => captionStateOf(p) === "pending").length;
  const captionsFailed = posts.filter((p) => captionStateOf(p) === "failed").length;

  if (saved) {
    return (
      <Dialog
        open
        onClose={requestClose}
        size="md"
        title="Cronograma salvo"
        description={`${clientName} · ${monthLabel}`}
        footer={
          <>
            <Button variant="secondary" onClick={() => onCommitted({ openCalendar: false })}>
              Fechar
            </Button>
            <Button ref={calendarButtonRef} variant="primary" onClick={() => onCommitted({ openCalendar: true })}>
              Ver no calendário
            </Button>
          </>
        }
      >
        <div className="grid gap-3 pb-2">
          <Callout tone="success">
            {saved.created} {plural(saved.created, "post salvo", "posts salvos")} como rascunho.
            {saved.duplicates > 0 &&
              ` ${saved.duplicates} já ${plural(saved.duplicates, "estava salvo e não foi duplicado", "estavam salvos e não foram duplicados")}.`}
          </Callout>
          {saved.captionsPending > 0 && (
            <Callout tone="info">
              {saved.captionsPending}{" "}
              {plural(
                saved.captionsPending,
                "post ainda está ganhando legenda da IA; ela aparece no post em instantes.",
                "posts ainda estão ganhando legenda da IA; elas aparecem nos posts em instantes."
              )}
            </Callout>
          )}
          <Callout tone="warning" title="Pastas do Google Drive não preparadas" live="polite">
            {saved.driveWarning}
          </Callout>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={requestClose}
      size="lg"
      busy={busy}
      error={error}
      title="Revisar cronograma"
      description={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>
            {clientName} · {monthLabel} · {posts.length} {plural(posts.length, "post", "posts")}
          </span>
          <ToneBadge tone={withArt === posts.length && posts.length > 0 ? "success" : "warning"}>
            {withArt}/{posts.length} com arte
          </ToneBadge>
        </span>
      }
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={requestClose}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            leadingIcon={<Icon.check />}
            loading={busy}
            loadingText={finishingCaptions ? "Concluindo legendas…" : "Salvando…"}
            disabled={posts.length === 0}
            onClick={approve}
          >
            Aprovar e salvar ({posts.length})
          </Button>
        </>
      }
    >
      <div className="grid gap-3 pb-3">
        <Callout tone="info">
          O cliente aprova <strong>título + explicação</strong> de cada postagem. As legendas (e os slides de
          carrossel e reels) são geradas pela IA em segundo plano enquanto você revisa: o que você editar à mão não é
          substituído, e o que faltar ao salvar é concluído depois. As artes no Drive seguem a ordem das datas de todos
          os posts do mês.
        </Callout>

        {packageInfo && (
          <div className="grid gap-1 rounded-card border border-line bg-sunken p-3 text-sm">
            <p className="font-semibold text-fg">{packageSummaryOf(packageInfo.label, posts)}</p>
            <p className="text-fg-muted">
              Datas, horários e tipos seguem o pacote do cliente; a IA criou só o título e a explicação de cada um.
              {packageInfo.generated < packageInfo.planned &&
                ` O mês já começou: ${packageInfo.generated} de ${packageInfo.planned} postagens do pacote (os dias que já passaram ficaram de fora).`}
            </p>
          </div>
        )}

        {posts.length > 0 && (
          <p
            ref={captionSummaryRef}
            tabIndex={-1}
            role="status"
            className="flex items-start gap-2 rounded-control text-sm text-fg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {captionsPending > 0 ? (
              <span className="mt-0.5 inline-flex shrink-0">
                <Spinner />
              </span>
            ) : captionsReady === posts.length ? (
              <span aria-hidden="true" className="mt-0.5 inline-flex size-4 shrink-0 text-success-solid [&>svg]:size-full">
                <Icon.check />
              </span>
            ) : null}
            <span className="min-w-0">
              <strong className="font-semibold text-fg">
                Legendas: {captionsReady} de {posts.length} {plural(posts.length, "pronta", "prontas")}
              </strong>
              {/* a espera ao salvar (até ~6 s) também é anunciada na região de status */}
              {finishingCaptions
                ? " · concluindo legendas antes de salvar…"
                : captionsPending > 0 && " · gerando as demais em segundo plano…"}
            </span>
          </p>
        )}

        {captionsFailed > 0 && (
          <Callout
            tone="warning"
            live="polite"
            title={`Não foi possível gerar a legenda de ${captionsFailed} ${plural(captionsFailed, "post", "posts")}`}
            action={
              <Button leadingIcon={<Icon.refresh />} disabled={busy} onClick={retryCaptions}>
                Tentar de novo
              </Button>
            }
          >
            {captionError || CAPTION_ERROR}
          </Callout>
        )}

        {posts.length === 0 && (
          <p className="py-8 text-center text-sm text-fg-muted">
            Nenhuma postagem. Adicione uma abaixo ou cancele e gere de novo.
          </p>
        )}

        <ol id={listId} aria-label="Postagens do cronograma" className="grid gap-3">
          {posts.map((p, i) => {
            const hasArt = !!p.mediaUrl.trim();
            const open = !!expanded[p.uid];
            const number = String(i + 1).padStart(2, "0");
            const titleLabel = p.theme.trim() || `postagem ${number}`;
            const artPath = paths.get(p.uid);
            const storyPath = paths.get(`${p.uid}:story`);
            const captionsId = `${listId}-${p.uid}-legendas`;
            const storyHelpId = `${listId}-${p.uid}-story`;
            const status = captionStateOf(p);
            return (
              <li key={p.uid} className="grid gap-3 rounded-card border border-line bg-surface p-3 sm:p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-semibold text-fg-muted">
                    <span className="sr-only">Postagem </span>
                    {number}
                  </span>
                  <FormatBadge format={p.format} kind={p.contentKind} />
                  <ToneBadge tone={hasArt ? "success" : "warning"}>{hasArt ? "Com arte" : "Sem arte"}</ToneBadge>
                  {status === "pending" ? (
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-fg-muted">
                      <Spinner />
                      Gerando legenda…
                    </span>
                  ) : status === "failed" ? (
                    <ToneBadge tone="warning">Legenda não gerada</ToneBadge>
                  ) : hasCaption(p) ? (
                    <ToneBadge tone="success">Com legenda</ToneBadge>
                  ) : (
                    <ToneBadge tone="neutral">Sem legenda</ToneBadge>
                  )}
                  <div className="ml-auto flex flex-wrap gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      leadingIcon={<Icon.refresh />}
                      loading={!!regenerating[p.uid]}
                      loadingText="Gerando…"
                      disabled={busy}
                      title="Substituir por um novo post gerado pela IA"
                      onClick={() => substitute(p.uid)}
                    >
                      Substituir
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      leadingIcon={<Icon.zap />}
                      disabled={busy}
                      title="Abrir o assistente de IA para este post"
                      aria-expanded={assistantUid === p.uid}
                      onClick={() => setAssistantUid(p.uid)}
                    >
                      Assistente
                    </Button>
                    <Button
                      iconOnly
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      aria-label={`Excluir ${titleLabel}`}
                      title="Remover este post do cronograma"
                      onClick={() => removePost(p.uid)}
                    >
                      <Icon.trash />
                    </Button>
                  </div>
                </div>

                <Field label="Título da postagem">
                  <Input
                    value={p.theme}
                    onChange={(e) => update(p.uid, { theme: e.target.value })}
                    placeholder="Ex.: 3 dicas para começar o mês"
                    className="font-medium"
                  />
                </Field>

                <Field label="Explicação para o cliente" help="Aparece no link de aprovação.">
                  <Textarea
                    value={p.explanation}
                    onChange={(e) => update(p.uid, { explanation: e.target.value })}
                    rows={2}
                    placeholder="Breve explicação do tema…"
                  />
                </Field>

                <div className="grid items-start gap-3 sm:grid-cols-2">
                  <Field label="Data da postagem">
                    <DateTimePicker
                      defaultValue={p.scheduledLocal}
                      onChange={(v) => update(p.uid, { scheduledLocal: v })}
                    />
                  </Field>
                  <div className="grid content-start gap-2">
                    <Field label="Tipo de postagem">
                      <Select
                        value={p.format}
                        onChange={(e) =>
                          update(p.uid, {
                            format: e.target.value,
                            ...(e.target.value === "story" ? { withStory: false } : {}),
                            // slot do pacote: o tipo acompanha o formato novo
                            ...(p.contentKind ? { contentKind: kindForFormat(p.contentKind, e.target.value) } : {}),
                          })
                        }
                      >
                        {FORMAT_OPTIONS.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    {p.format !== "story" && (
                      <div>
                        <label className="flex min-h-10 cursor-pointer select-none items-center gap-2 text-sm text-fg sm:min-h-8">
                          <input
                            type="checkbox"
                            checked={p.withStory}
                            onChange={(e) => update(p.uid, { withStory: e.target.checked })}
                            aria-describedby={p.withStory && storyPath ? storyHelpId : undefined}
                            className="size-4 shrink-0 accent-primary"
                          />
                          Story junto (sai 15 min depois)
                        </label>
                        {p.withStory && storyPath && (
                          <p id={storyHelpId} className="text-xs text-fg-muted">
                            Arte do story no Drive: <span className="font-mono">{storyPath}</span>
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                <Field
                  label="Arte (URL da mídia)"
                  help={
                    artPath ? (
                      <>
                        No Drive: <span className="font-mono">{artPath}</span>
                      </>
                    ) : undefined
                  }
                >
                  <MediaField
                    value={p.mediaUrl}
                    onChange={(url) => update(p.uid, { mediaUrl: url })}
                    clientId={clientId}
                    compact
                  />
                </Field>

                <div className="flex flex-wrap items-center gap-2">
                  <div role="group" aria-label={`Redes de ${titleLabel}`} className="flex flex-wrap gap-2">
                    {platforms.map((pl) => {
                      const on = p.targets.includes(pl);
                      return (
                        <button
                          key={pl}
                          type="button"
                          aria-pressed={on}
                          onClick={() => toggleTarget(p.uid, pl)}
                          className={`inline-flex min-h-10 items-center gap-1.5 rounded-control border pl-1.5 pr-3 text-sm font-medium transition-colors duration-(--sf-dur-fast) sm:min-h-8 ${
                            on
                              ? "border-selected bg-selected text-on-selected"
                              : "border-line-strong bg-surface text-fg-muted hover:bg-hover hover:text-fg"
                          }`}
                        >
                          <BrandBadge platform={pl} size={20} />
                          {BRAND[pl]?.label ?? pl}
                        </button>
                      );
                    })}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    aria-expanded={open}
                    aria-controls={open ? captionsId : undefined}
                    onClick={() => setExpanded((e) => ({ ...e, [p.uid]: !open }))}
                  >
                    {open ? "Ocultar legendas" : "Editar legendas"}
                  </Button>
                </div>

                {open && (
                  <div id={captionsId} className="grid gap-3" aria-busy={status === "pending" || undefined}>
                    {(p.format === "carrossel" || p.format === "reels") && (
                      <SlidesEditor format={p.format} slides={p.slides} onChange={(slides) => updateSlides(p.uid, slides)} />
                    )}
                    {p.targets.length === 0 && (
                      <p className="text-sm text-warning-fg">Selecione uma rede para editar a legenda.</p>
                    )}
                    {(p.targets.includes("instagram") || p.targets.includes("facebook")) && (
                      <Field
                        label={
                          <span className="inline-flex items-center gap-1.5">
                            <span aria-hidden="true" className="inline-flex items-center gap-1">
                              <BrandBadge platform="facebook" size={16} />
                              <BrandBadge platform="instagram" size={16} />
                            </span>
                            Facebook + Instagram (legenda única)
                          </span>
                        }
                      >
                        <Textarea
                          value={p.captions.instagram ?? p.captions.facebook ?? ""}
                          onChange={(e) => updateShared(p.uid, e.target.value)}
                          rows={7}
                          className="leading-relaxed"
                          placeholder={
                            status === "pending" ? "Gerando legenda com a IA…" : "Legenda para Facebook e Instagram"
                          }
                        />
                      </Field>
                    )}
                    {p.targets.includes("linkedin") && (
                      <Field
                        label={
                          <span className="inline-flex flex-wrap items-center gap-1.5">
                            <span aria-hidden="true" className="inline-flex">
                              <BrandBadge platform="linkedin" size={16} />
                            </span>
                            LinkedIn
                            {!liDirty[p.uid] && <span className="font-normal text-fg-muted">· espelhando FB+IG</span>}
                          </span>
                        }
                      >
                        <Textarea
                          value={p.captions.linkedin ?? p.captions.instagram ?? p.captions.facebook ?? ""}
                          onChange={(e) => updateLinkedin(p.uid, e.target.value)}
                          rows={5}
                          className="leading-relaxed"
                          placeholder={
                            status === "pending"
                              ? "Gerando legenda com a IA…"
                              : "Legenda para LinkedIn (por padrão igual à de FB+IG)"
                          }
                        />
                      </Field>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>

        {/* nova postagem manual no cronograma */}
        <Button fullWidth leadingIcon={<Icon.plus />} disabled={busy} onClick={addPost} className="border-dashed">
          Adicionar postagem
        </Button>
      </div>

      {/* assistente de IA do post escolhido: painel lateral dentro do diálogo (Esc fecha só ele) */}
      {assistantPost && (
        <div className="pointer-events-none fixed inset-y-0 right-0 z-10 flex w-full max-w-md flex-col justify-center p-4">
          <AssistantPanel
            key={assistantPost.uid}
            className="pointer-events-auto max-h-full shadow-raised"
            clientId={clientId}
            subtitle={assistantPost.theme.trim() || "Post sem título"}
            onClose={() => setAssistantUid(null)}
            getPost={() => {
              const p = posts.find((x) => x.uid === assistantPost.uid);
              return {
                theme: p?.theme,
                format: p?.format,
                targets: p?.targets,
                caption: p?.captions.instagram ?? p?.captions.facebook ?? "",
                scheduledAt: p?.scheduledLocal,
                slides: p?.slides.filter((s) => s.trim()),
              };
            }}
            onApplyCaption={(text) => updateShared(assistantPost.uid, text)}
            onApplyTitle={(title) => update(assistantPost.uid, { theme: title })}
          />
        </div>
      )}

      <ConfirmDialog
        open={confirmingDiscard}
        tone="danger"
        title={edited ? "Descartar o cronograma e as suas edições?" : "Descartar o cronograma gerado?"}
        consequences={[
          `${posts.length} ${plural(posts.length, "postagem não é salva", "postagens não são salvas")}${edited ? ", com as edições feitas aqui" : ""}.`,
          "Para ter o cronograma de novo, será preciso gerar outra vez com a IA.",
        ]}
        cancelLabel="Continuar revisando"
        confirmLabel="Descartar cronograma"
        onCancel={() => setConfirmingDiscard(false)}
        onConfirm={() => {
          setConfirmingDiscard(false);
          stopCaptions();
          onClose();
        }}
      />
    </Dialog>
  );
}
