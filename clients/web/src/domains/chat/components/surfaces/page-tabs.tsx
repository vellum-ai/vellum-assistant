import { Stepper } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

import type { FormPage } from "@vellumai/assistant-api";

interface PageTabsProps {
  current: number;
  pages: FormPage[];
  onNavigate: (index: number) => void;
  disabled?: boolean;
}

/**
 * Labeled step navigation for a multi-page form, built on the design library
 * `Stepper` primitive. Steps are numbered from their page title; completed
 * steps navigate back, and navigation is disabled while the form is submitting.
 */
export function PageTabs({
  current,
  pages,
  onNavigate,
  disabled = false,
}: PageTabsProps) {
  const { t } = useTranslation("chat");
  const steps = pages.map((page, i) => ({
    id: page.id,
    label: `${i + 1}. ${page.title}`,
  }));

  return (
    <Stepper
      aria-label={t("pageTabs.formStepsAria")}
      steps={steps}
      current={current}
      onStepSelect={onNavigate}
      disabled={disabled}
      className="mb-4"
    />
  );
}
