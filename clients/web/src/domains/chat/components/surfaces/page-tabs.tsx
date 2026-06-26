import type { FormPage } from "@/domains/chat/components/surfaces/form-surface";

interface PageTabsProps {
  current: number;
  pages: FormPage[];
  onNavigate: (index: number) => void;
  disabled?: boolean;
}

/**
 * Labeled step navigation for a multi-page form. A gated, ordered wizard is a
 * step pattern rather than a tabs/tabpanel widget, so the current step is
 * marked with `aria-current="step"`: completed steps are buttons that navigate
 * back, future steps are disabled, and forward navigation goes through the Next
 * button. While the form is submitting, navigation is disabled so the visible
 * step can't drift from the already-submitted values. The visual style matches
 * the design system's underline tabs.
 */
export function PageTabs({
  current,
  pages,
  onNavigate,
  disabled = false,
}: PageTabsProps) {
  return (
    <nav
      aria-label="Form steps"
      className="mb-4 flex items-center gap-4 overflow-x-auto border-b border-[var(--border-subtle)]"
    >
      {pages.map((page, i) => {
        const isActive = i === current;
        const isCompleted = i < current;
        const canNavigate = isCompleted && !disabled;
        const textClass = isActive
          ? "text-[var(--content-strong)]"
          : isCompleted
            ? "text-[var(--content-default)]"
            : "text-[var(--content-faint)]";
        return (
          <button
            key={page.id}
            type="button"
            onClick={canNavigate ? () => onNavigate(i) : undefined}
            disabled={!canNavigate}
            aria-current={isActive ? "step" : undefined}
            className={`-mb-px whitespace-nowrap border-b-2 pb-2 text-body-medium-default transition-colors ${
              isActive ? "border-[var(--primary-base)]" : "border-transparent"
            } ${textClass} ${canNavigate ? "cursor-pointer" : "cursor-default"}`}
          >
            {i + 1}. {page.title}
          </button>
        );
      })}
    </nav>
  );
}
