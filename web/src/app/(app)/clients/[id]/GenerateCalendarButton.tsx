"use client";

import { useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { Callout } from "@/components/Callout";
import { MonthPicker, TimePicker } from "@/components/DatePickers";
import { Dialog } from "@/components/Dialog";
import { Field } from "@/components/Field";
import { Popover } from "@/components/Popover";
import { isPackageTier, packageSummary } from "@/lib/content-packages";
import { toUserMessage } from "@/lib/user-facing-error";
import CalendarReviewModal, { type PreviewPackage, type PreviewPost } from "./CalendarReviewModal";

type Preview = {
  month: string;
  clientName: string;
  activePlatforms: string[];
  posts: PreviewPost[];
  packageInfo: PreviewPackage | null;
};

/** `package` da resposta de POST /api/ai/calendar (cliente com pacote de gestão). */
function readPackage(data: unknown): PreviewPackage | null {
  const p = (data as { package?: unknown } | null)?.package as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object") return null;
  const { label, planned, generated } = p;
  if (typeof label !== "string" || typeof planned !== "number" || typeof generated !== "number") return null;
  return { label, planned, generated };
}

const GENERATE_ERROR = "Não foi possível gerar o cronograma agora. Tente de novo em instantes.";

/** Abaixo de sm o painel abre como folha inferior (Dialog do P2-A), como os seletores de data. */
const NARROW_QUERY = "(max-width: 639px)";
/** Altura natural do painel a partir de sm (px; medida a 1440 e a 768: 358) + folga de fonte/zoom. */
const PANEL_HEIGHT = 358 + 12;
/** offset (8) + distância mínima da borda (8) do Popover. */
const POPOVER_GAP = 16;

type PanelMode = "popover" | "sheet";

function SparkleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l1.6 4.6L18 9l-4.4 1.4L12 15l-1.6-4.6L6 9l4.4-1.4L12 3Z" />
      <path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14Z" />
    </svg>
  );
}

function nextMonth() {
  // mês corrente no fuso SP (evita o overflow de setMonth no dia 31)
  const sp = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
  }).format(new Date()); // "YYYY-MM"
  const [y, m] = sp.split("-").map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

export default function GenerateCalendarButton({
  clientId,
  tier = "",
  carouselFrequency = null,
}: {
  clientId: string;
  /** pacote de gestão do cliente: com pacote, o sistema monta os slots e a IA só cria os temas */
  tier?: string;
  carouselFrequency?: string | null;
}) {
  const summary = isPackageTier(tier) ? packageSummary(tier, carouselFrequency) : null;
  const router = useRouter();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<PanelMode>("popover");
  const [month, setMonth] = useState(nextMonth());
  const [time, setTime] = useState("18:00");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);

  // Rede de segurança: o Popover abriu com rolagem interna (estimativa curta) → folha.
  useEffect(() => {
    if (!open || mode !== "popover") return;
    const frame = requestAnimationFrame(() => {
      const panel = document.getElementById(panelId);
      if (panel && panel.scrollHeight > panel.clientHeight + 1) setMode("sheet");
    });
    return () => cancelAnimationFrame(frame);
  }, [open, mode, panelId]);

  /** ≥ sm e o painel inteiro cabe acima ou abaixo do gatilho? (só no navegador, ao abrir) */
  function fitsAsPopover() {
    if (window.matchMedia?.(NARROW_QUERY).matches) return false;
    const trigger = triggerRef.current;
    if (!trigger) return true;
    const rect = trigger.getBoundingClientRect();
    const viewportH = document.documentElement.clientHeight;
    return viewportH - rect.bottom - POPOVER_GAP >= PANEL_HEIGHT || rect.top - POPOVER_GAP >= PANEL_HEIGHT;
  }

  /**
   * Abre/fecha o painel. Ao abrir, decide o modo: Popover se o painel couber inteiro (≥ sm),
   * senão folha inferior com "Gerar 12 posts" no rodapé fixo. Enquanto gera, não fecha (a
   * geração leva até 1 min). Com o seletor de mês ou de horário aberto aqui dentro, o pedido
   * de fechar este painel (ex.: clique dentro da folha do seletor) é ignorado enquanto houver
   * um gatilho interno com aria-expanded="true": só o seletor fecha.
   */
  function changeOpen(next: boolean) {
    if (!next) {
      if (busy) return;
      const inner = bodyRef.current?.querySelector<HTMLElement>('[aria-expanded="true"]');
      if (inner) {
        // Se o foco já foi para o gatilho "Cronograma com IA", volta ao seletor interno
        // depois que ele fechar.
        if (document.activeElement === triggerRef.current) {
          setTimeout(() => {
            if (inner.isConnected) inner.focus({ preventScroll: true });
          }, 0);
        }
        return;
      }
      setError("");
    } else {
      setMode(fitsAsPopover() ? "popover" : "sheet");
    }
    setOpen(next);
  }

  async function generate() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/ai/calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, month, time, count: 12 }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(toUserMessage(data, GENERATE_ERROR));
        return;
      }
      // Fecha o painel antes de abrir a revisão: o gatilho deixa de ser inerte (a folha é
      // modal), recebe o foco e a revisão o devolve a ele quando fechar.
      flushSync(() => setOpen(false));
      triggerRef.current?.focus({ preventScroll: true });
      setPreview({
        month: typeof data?.month === "string" ? data.month : month,
        clientName: typeof data?.clientName === "string" ? data.clientName : "",
        activePlatforms: Array.isArray(data?.activePlatforms) ? data.activePlatforms : [],
        posts: Array.isArray(data?.posts) ? data.posts : [],
        packageInfo: readPackage(data),
      });
    } catch {
      setError("Falha de conexão ao gerar o cronograma. Verifique a internet e tente de novo.");
    } finally {
      setBusy(false);
    }
  }

  const intro = summary ? (
    <>
      Pacote <strong className="font-semibold text-fg">{summary}</strong>. O sistema monta as datas e os tipos do
      mês; a IA cria o título e a explicação de cada postagem. As legendas são geradas em segundo plano enquanto
      você revisa.
    </>
  ) : (
    <>
      A IA cria <strong className="font-semibold text-fg">12 postagens</strong> (título + explicação do tema) no tom
      de voz do cliente. O cliente aprova os temas no link mensal; as legendas são geradas em segundo plano
      enquanto você revisa, e o cliente as vê no link semanal.
    </>
  );

  const fields = (
    <div className="grid gap-3">
      <Field label="Mês de referência">
        <MonthPicker value={month} onChange={setMonth} disabled={busy} />
      </Field>
      <Field label="Horário padrão">
        <TimePicker value={time} onChange={setTime} disabled={busy} />
      </Field>
    </div>
  );

  const status = busy && (
    <p role="status" className="text-sm text-fg-muted">
      {summary ? "Gerando o cronograma do pacote com a IA." : "Gerando os 12 posts com a IA."} Isso leva de 30 s a 1
      minuto…
    </p>
  );

  const cancelButton = (className?: string) => (
    <Button className={className} disabled={busy} onClick={() => changeOpen(false)}>
      Cancelar
    </Button>
  );

  const generateButton = (className?: string) => (
    <Button className={className} variant="primary" loading={busy} loadingText="Gerando…" onClick={generate}>
      {summary ? "Gerar cronograma" : "Gerar 12 posts"}
    </Button>
  );

  return (
    <>
      <Button
        ref={triggerRef}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open && mode === "popover" ? panelId : undefined}
        leadingIcon={<SparkleIcon />}
        onClick={() => changeOpen(!open)}
      >
        Cronograma com IA
      </Button>

      <Popover
        open={open && mode === "popover"}
        onOpenChange={changeOpen}
        anchorRef={triggerRef}
        id={panelId}
        aria-labelledby={titleId}
        placement="bottom-end"
        className="w-80 p-4"
      >
        <div ref={bodyRef} className="grid gap-4" aria-busy={busy || undefined}>
          <div>
            <h2 id={titleId} className="flex items-center gap-2 text-base font-semibold text-fg">
              <span aria-hidden="true" className="inline-flex size-4 text-link [&>svg]:size-full">
                <SparkleIcon />
              </span>
              Gerar cronograma do mês
            </h2>
            <p className="mt-1 text-sm text-fg-muted">{intro}</p>
          </div>

          {fields}

          {error && (
            <Callout tone="danger" live="assertive">
              {error}
            </Callout>
          )}

          {status}

          <div className="flex gap-2">
            {cancelButton("flex-1")}
            {generateButton("flex-1")}
          </div>
        </div>
      </Popover>

      {/* Celular, ou sem espaço para o painel inteiro: folha inferior (rodapé fixo; o conteúdo rola dentro) */}
      {open && mode === "sheet" && (
        <Dialog
          open
          onClose={() => changeOpen(false)}
          title="Gerar cronograma do mês"
          size="sm"
          busy={busy}
          error={error || null}
          footer={
            <>
              {cancelButton()}
              {generateButton()}
            </>
          }
        >
          <div ref={bodyRef} className="grid gap-4 pb-2" aria-busy={busy || undefined}>
            <p className="text-sm text-fg-muted">{intro}</p>
            {fields}
            {status}
          </div>
        </Dialog>
      )}

      {preview && (
        <CalendarReviewModal
          clientId={clientId}
          clientName={preview.clientName}
          month={preview.month}
          availablePlatforms={preview.activePlatforms}
          initialPosts={preview.posts}
          packageInfo={preview.packageInfo}
          onClose={() => setPreview(null)}
          onCommitted={({ openCalendar }) => {
            const ref = preview.month;
            setPreview(null);
            if (openCalendar) router.push(`/calendar?view=month&ref=${ref}-01`);
            router.refresh();
          }}
        />
      )}
    </>
  );
}
