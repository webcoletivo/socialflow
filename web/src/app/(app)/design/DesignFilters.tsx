"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useId, useMemo, useState, useTransition } from "react";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { Field, Select } from "@/components/Field";
import { MonthPicker } from "@/components/DatePickers";
import { Icon } from "@/components/Icons";
import { SegmentedControl } from "@/components/Toggle";
import {
  activeFilterCount,
  DESIGN_SHOW_OPTIONS,
  DESIGN_VIEW_OPTIONS,
  DESIGNER_ALL,
  DESIGNER_NONE,
  designHref,
  shiftMonth,
  type DesignFilterValues,
  type DesignShow,
  type DesignView,
  type UserRef,
} from "./design-view";

/*
 * Filtros e navegação de mês da fila de artes (/design), no padrão do Quadro de
 * Produção: "Ver" (lista | calendário), estado na URL, uma só transição para cabeçalho, filtros e lista
 * (aria-busy + opacidade + barra), diálogo "Filtros" no celular.
 */

type Nav = {
  pending: boolean;
  go: (href: string) => void;
  /** diálogo de filtros (< md) aberto: a lista segura o Toast até ele fechar */
  filtersOpen: boolean;
  setFiltersOpen: (open: boolean) => void;
};
const NavContext = createContext<Nav | null>(null);

export function useDesignNav(): Nav {
  const nav = useContext(NavContext);
  if (!nav) throw new Error("Use os filtros do Design dentro de <DesignNavProvider>.");
  return nav;
}

/** Envolve cabeçalho, filtros e lista: uma só transição de navegação para todos. */
export function DesignNavProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const go = useCallback(
    (href: string) => startTransition(() => router.push(href, { scroll: false })),
    [router],
  );
  const value = useMemo(() => ({ pending, go, filtersOpen, setFiltersOpen }), [pending, go, filtersOpen]);
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}

/** ‹ Mês anterior · MonthPicker · Próximo mês › (ações do PageHeader). */
export function DesignMonthNav({ values, defaultDesigner }: { values: DesignFilterValues; defaultDesigner: string }) {
  const { go } = useDesignNav();
  const to = (mes: string) => go(designHref({ ...values, mes }, defaultDesigner));
  return (
    <div role="group" aria-label="Mês da fila de artes" className="flex w-full items-center gap-2 sm:w-auto">
      <Button iconOnly aria-label="Mês anterior" onClick={() => to(shiftMonth(values.mes, -1))}>
        <Icon.chevronLeft />
      </Button>
      <div className="min-w-0 flex-1 sm:w-52 sm:flex-none">
        <MonthPicker value={values.mes} onChange={(mes) => mes && to(mes)} />
      </div>
      <Button iconOnly aria-label="Próximo mês" onClick={() => to(shiftMonth(values.mes, 1))}>
        <Icon.chevronRight />
      </Button>
    </div>
  );
}

export type DesignerFilterOption = UserRef;
export type ClientFilterOption = { id: string; name: string; designer: UserRef | null };

function FilterSelects({
  values,
  userId,
  isDesigner,
  designers,
  clients,
  onChange,
  size,
  fieldClassName = "",
}: {
  values: DesignFilterValues;
  userId: string | null;
  isDesigner: boolean;
  designers: DesignerFilterOption[];
  clients: ClientFilterOption[];
  onChange: (next: DesignFilterValues) => void;
  size: "sm" | "md";
  fieldClassName?: string;
}) {
  return (
    <>
      <Field label="Designer" className={fieldClassName}>
        <Select size={size} value={values.designer} onChange={(e) => onChange({ ...values, designer: e.target.value })}>
          {isDesigner && userId && <option value={userId}>Minhas artes</option>}
          <option value={DESIGNER_ALL}>Todas as designers</option>
          <option value={DESIGNER_NONE}>Sem designer</option>
          {designers
            .filter((d) => !(isDesigner && d.id === userId))
            .map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
        </Select>
      </Field>
      <Field label="Cliente" className={fieldClassName}>
        <Select size={size} value={values.cliente} onChange={(e) => onChange({ ...values, cliente: e.target.value })}>
          <option value="">Todos os clientes</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
    </>
  );
}

/**
 * ≥ md: Designer, Cliente e Mostrar em linha (aplicam na hora) + "Limpar filtros".
 * < md: Mostrar visível + botão "Filtros (n)" que abre um diálogo com Aplicar/Limpar.
 */
export default function DesignFilters({
  values,
  defaultDesigner,
  userId,
  isDesigner,
  designers,
  clients,
}: {
  values: DesignFilterValues;
  defaultDesigner: string;
  userId: string | null;
  isDesigner: boolean;
  designers: DesignerFilterOption[];
  clients: ClientFilterOption[];
}) {
  const { go, filtersOpen: open, setFiltersOpen: setOpen } = useDesignNav();
  // valor otimista enquanto a página nova carrega; volta a refletir a URL quando ela muda
  const [local, setLocal] = useState(values);
  const urlKey = designHref(values, defaultDesigner);
  const [prevUrlKey, setPrevUrlKey] = useState(urlKey);
  if (urlKey !== prevUrlKey) {
    setPrevUrlKey(urlKey);
    setLocal(values);
  }
  const [draft, setDraft] = useState(values);
  const showId = useId();
  const showMobileId = useId();
  const viewId = useId();
  const viewMobileId = useId();
  const calendar = local.ver === "calendario";

  const apply = (next: DesignFilterValues) => {
    setLocal(next);
    go(designHref(next, defaultDesigner));
  };
  const cleared = (v: DesignFilterValues): DesignFilterValues => ({ ...v, designer: defaultDesigner, cliente: "" });
  const count = activeFilterCount(values, defaultDesigner);
  const selectProps = { userId, isDesigner, designers, clients };

  return (
    <>
      <div className="mb-5 hidden flex-wrap items-end gap-3 md:flex">
        <Field id={viewId} kind="group" label="Ver">
          <SegmentedControl
            aria-labelledby={`${viewId}-label`}
            size="sm"
            value={local.ver}
            options={DESIGN_VIEW_OPTIONS}
            onChange={(ver: DesignView) => apply({ ...local, ver })}
          />
        </Field>
        <FilterSelects {...selectProps} values={local} onChange={apply} size="sm" fieldClassName="w-52" />
        {!calendar && (
          <Field id={showId} kind="group" label="Mostrar">
            <SegmentedControl
              aria-labelledby={`${showId}-label`}
              size="sm"
              value={local.mostrar}
              options={DESIGN_SHOW_OPTIONS}
              onChange={(mostrar: DesignShow) => apply({ ...local, mostrar })}
            />
          </Field>
        )}
        {activeFilterCount(local, defaultDesigner) > 0 && (
          <Button variant="ghost" size="sm" onClick={() => apply(cleared(local))}>
            Limpar filtros
          </Button>
        )}
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3 md:hidden">
        <Field id={viewMobileId} kind="group" label="Ver" labelHidden>
          <SegmentedControl
            aria-labelledby={`${viewMobileId}-label`}
            value={local.ver}
            options={DESIGN_VIEW_OPTIONS}
            onChange={(ver: DesignView) => apply({ ...local, ver })}
          />
        </Field>
        {!calendar && (
          <Field id={showMobileId} kind="group" label="Mostrar" labelHidden>
            <SegmentedControl
              aria-labelledby={`${showMobileId}-label`}
              value={local.mostrar}
              options={DESIGN_SHOW_OPTIONS}
              onChange={(mostrar: DesignShow) => apply({ ...local, mostrar })}
            />
          </Field>
        )}
        <Button
          variant="secondary"
          aria-haspopup="dialog"
          leadingIcon={<Icon.search />}
          onClick={() => {
            setDraft(values);
            setOpen(true);
          }}
        >
          {count > 0 ? `Filtros (${count})` : "Filtros"}
        </Button>
        {open && (
          <Dialog
            open
            onClose={() => setOpen(false)}
            title="Filtros"
            size="sm"
            footer={
              <>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setOpen(false);
                    apply(cleared(values));
                  }}
                >
                  Limpar
                </Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    setOpen(false);
                    apply(draft);
                  }}
                >
                  Aplicar
                </Button>
              </>
            }
          >
            <div className="grid gap-4">
              <FilterSelects {...selectProps} values={draft} onChange={setDraft} size="md" />
            </div>
          </Dialog>
        )}
      </div>
    </>
  );
}

/** Área do resumo e da lista: "ocupada" durante a troca de filtro/mês. */
export function DesignBusyArea({ children }: { children: React.ReactNode }) {
  const { pending } = useDesignNav();
  return (
    <div aria-busy={pending || undefined} className="relative">
      {pending && <div aria-hidden="true" className="absolute inset-x-0 -top-2 z-10 h-0.5 rounded-full bg-brand" />}
      <div className={`transition-opacity duration-(--sf-dur-fast) ${pending ? "opacity-60" : ""}`}>{children}</div>
    </div>
  );
}
