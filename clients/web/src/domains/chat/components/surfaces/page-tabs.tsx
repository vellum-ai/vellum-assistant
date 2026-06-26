import { Stepper } from "@vellumai/design-library";

import type { FormPage } from "@/domains/chat/components/surfaces/form-surface";

interface PageTabsProps {
  current: number;
  pages: FormPage[];
  onNavigate: (index: number) => void;
  disabled?: boolean;
}

/**
 * Labeled step navigation for a multi-page form, built on the design library
 * `Stepper` primitive. Steps are numbered from their page title; completed
 * steps navigate back, and future steps (plus any step while the form is
 * submitting) are disabled.
 */
export function PageTabs({
  current,
  pages,
  onNavigate,
  disabled = false,
}: PageTabsProps) {
  const steps = pages.map((page, i) => ({
    id: page.id,
    label: `${i + 1}. ${page.title}`,
    disabled: disabled || i > current,
  }));

  return (
    <Stepper
      aria-label="Form steps"
      steps={steps}
      current={current}
      onStepSelect={onNavigate}
      className="mb-4"
    />
  );
}
