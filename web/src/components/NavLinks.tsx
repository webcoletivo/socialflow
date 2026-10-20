"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Icon } from "./Icons";
import { BrandLockup } from "./Logo";

type NavItem = { href: string; label: string; icon: (p: { className?: string }) => ReactNode };

const MAIN_ITEMS: NavItem[] = [
  { href: "/", label: "Dashboard", icon: Icon.dashboard },
  { href: "/producao", label: "Produção", icon: Icon.board },
  { href: "/design", label: "Design", icon: Icon.edit },
  { href: "/clients", label: "Clientes", icon: Icon.users },
  { href: "/posts", label: "Posts", icon: Icon.list },
  { href: "/calendar", label: "Calendário", icon: Icon.grid },
  { href: "/aprovacoes", label: "Aprovações", icon: Icon.check },
  { href: "/pendencias", label: "Pendências", icon: Icon.inbox },
  { href: "/templates", label: "Artes-base", icon: Icon.folder },
];

const ADMIN_ITEMS: NavItem[] = [
  { href: "/meta", label: "Conexões Meta", icon: Icon.link },
  { href: "/users", label: "Usuários", icon: Icon.shield },
  { href: "/modelos-ia", label: "Modelos de IA", icon: Icon.zap },
  { href: "/auditoria", label: "Registro de ações", icon: Icon.clock },
];

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Itens da navegação principal. Na gaveta (< md) use `variant="drawer"`
 * (alvos de 44 px) e `onNavigate` para fechá-la ao seguir um link.
 * `designCount`: artes a fazer da fila /design (selo no item "Design"; 0/omitido = sem selo).
 */
export function NavLinks({
  isAdmin = false,
  onNavigate,
  variant = "sidebar",
  designCount = 0,
}: {
  isAdmin?: boolean;
  onNavigate?: () => void;
  variant?: "sidebar" | "drawer";
  designCount?: number;
}) {
  const pathname = usePathname();
  const adminLabelId = useId();

  const renderItem = (item: NavItem) => {
    const active = isActive(pathname, item.href);
    const ItemIcon = item.icon;
    const count = item.href === "/design" && designCount > 0 ? designCount : 0;
    return (
      <Link
        key={item.href}
        href={item.href}
        aria-current={active ? "page" : undefined}
        // nome acessível vem do conteúdo: "Design, 5 a fazer" (texto visível + complemento sr-only; WCAG 2.5.3)
        onClick={onNavigate}
        className={`flex items-center gap-3 rounded-control px-3 text-sm font-medium transition-colors duration-(--sf-dur-fast) ${
          variant === "drawer" ? "h-11" : "h-10"
        } ${active ? "bg-selected text-on-selected" : "text-fg-muted hover:bg-hover hover:text-fg"}`}
      >
        <ItemIcon className="size-4.5 shrink-0" />
        <span className="truncate">{item.label}</span>
        {count > 0 && <span className="sr-only">, </span>}
        {count > 0 && (
          <span
            className={`ml-auto inline-grid h-5 min-w-5 shrink-0 place-items-center rounded-full px-1.5 text-xs font-semibold tabular-nums leading-none ${
              active ? "bg-surface text-fg" : "bg-brand text-on-brand"
            }`}
          >
            {count > 99 ? "99+" : count}
            <span className="sr-only"> a fazer</span>
          </span>
        )}
      </Link>
    );
  };

  return (
    <nav aria-label="Principal" className="flex-1 overflow-y-auto px-3 py-4">
      <div className="space-y-1">{MAIN_ITEMS.map(renderItem)}</div>
      {isAdmin && (
        <div role="group" aria-labelledby={adminLabelId} className="mt-6 space-y-1">
          <p
            id={adminLabelId}
            className="px-3 pb-1 text-xs font-semibold uppercase tracking-overline text-fg-muted"
          >
            Administração
          </p>
          {ADMIN_ITEMS.map(renderItem)}
        </div>
      )}
    </nav>
  );
}

const ICON_BUTTON =
  "inline-grid size-11 shrink-0 place-items-center rounded-control text-fg-muted transition-colors duration-(--sf-dur-fast) hover:bg-hover hover:text-fg active:bg-press active:text-fg";

const FOCUSABLE =
  'a[href]:not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Menu do celular (< md): botão "Abrir menu" + gaveta em <dialog> modal
 * (top layer: fundo inerte). O <dialog> ocupa a tela toda (transparente) e o
 * painel fica à esquerda, para o clique no fundo ter o <dialog> como alvo.
 * Fecha com Esc, clique no fundo, clique em link,
 * mudança de rota ou ao alargar a tela até md. O foco volta ao botão.
 * `footer` = o mesmo rodapé da sidebar (tema, usuário, Sair).
 */
export function MobileNav({
  isAdmin = false,
  footer,
  designCount = 0,
}: {
  isAdmin?: boolean;
  footer?: ReactNode;
  /** ver `NavLinks` */
  designCount?: number;
}) {
  const pathname = usePathname();
  // aberta = aberta nesta rota; trocar de rota fecha sem precisar de efeito
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const close = () => setOpenOn(null);

  // Sincroniza o <dialog> nativo com o estado.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // Com a tela em md ou mais a barra some; não deixa uma gaveta modal invisível aberta.
  useEffect(() => {
    if (!open) return;
    const media = window.matchMedia("(min-width: 48rem)");
    const onChange = () => {
      if (media.matches) setOpenOn(null);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [open]);

  // Mantém o Tab dentro da gaveta (volta ao início/fim).
  function trapTab(e: KeyboardEvent<HTMLDialogElement>) {
    if (e.key !== "Tab" || !dialogRef.current) return;
    const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.getClientRects().length > 0,
    );
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const current = document.activeElement;
    if (e.shiftKey && (current === first || !dialogRef.current.contains(current))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (current === last || !dialogRef.current.contains(current))) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label="Abrir menu"
        aria-expanded={open}
        aria-controls="menu-principal"
        onClick={() => setOpenOn(pathname)}
        className={ICON_BUTTON}
      >
        <Icon.menu className="size-5" />
      </button>

      <dialog
        ref={dialogRef}
        id="menu-principal"
        aria-label="Menu principal"
        onClose={() => {
          close();
          buttonRef.current?.focus();
        }}
        onClick={(e) => {
          // o <dialog> cobre a tela e o painel fica à esquerda: alvo = <dialog> só no fundo
          if (e.target === e.currentTarget) close();
        }}
        onKeyDown={trapTab}
        className="sf-drawer m-0 h-dvh max-h-none w-dvw max-w-none border-0 bg-transparent p-0 text-fg backdrop:bg-scrim"
      >
        <div className="sf-drawer-panel flex h-full w-[min(320px,85vw)] flex-col bg-surface shadow-raised">
          <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-line pl-4 pr-2">
            <BrandLockup size="sm" />
            <button type="button" aria-label="Fechar menu" onClick={close} className={ICON_BUTTON}>
              <Icon.x className="size-5" />
            </button>
          </div>
          <NavLinks isAdmin={isAdmin} onNavigate={close} variant="drawer" designCount={designCount} />
          {footer}
        </div>
      </dialog>
    </>
  );
}
