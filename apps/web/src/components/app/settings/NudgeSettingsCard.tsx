
import type { ComponentType, ReactNode } from "react";

import { Button } from "@vellum/design-library/components/button";

import { SettingsCard } from "@/components/app/settings/SettingsCard.js";

/**
 * Shared settings-page card used by the iOS, macOS, and GitHub nudges.
 * Each consumer supplies the title/subtitle, a list of icon+text
 * benefits, and a CTA. The chrome — surface tokens, benefit-row layout,
 * 28px icon swatch — is identical across nudges so it lives here.
 */

export interface NudgeBenefit {
  /** lucide-react icon component (or any component with the same props). */
  icon: ComponentType<{ size?: number; style?: React.CSSProperties; "aria-hidden"?: boolean }>;
  /** Benefit description text. */
  text: string;
}

export interface NudgeSettingsCardProps {
  /** Card title (rendered by `SettingsCard`). */
  title: string;
  /** Card subtitle / one-liner pitch. */
  subtitle: string;
  /**
   * Three or four benefit rows. Order is preserved; each row gets a
   * leading icon swatch and a body sentence.
   */
  benefits: ReadonlyArray<NudgeBenefit>;
  /** CTA button label. */
  ctaLabel: string;
  /** CTA button leading icon — required so each card is recognisable. */
  ctaLeftIcon: ReactNode;
  /** Fired when the user clicks the CTA. */
  onAction: () => void;
}

export function NudgeSettingsCard({
  title,
  subtitle,
  benefits,
  ctaLabel,
  ctaLeftIcon,
  onAction,
}: NudgeSettingsCardProps) {
  return (
    <SettingsCard title={title} subtitle={subtitle}>
      <div className="flex flex-col gap-4">
        <ul className="space-y-3">
          {benefits.map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-center gap-3">
              <span
                className="flex size-7 shrink-0 items-center justify-center rounded-md"
                style={{ background: "var(--surface-base)" }}
              >
                <Icon
                  size={14}
                  style={{ color: "var(--content-secondary)" }}
                  aria-hidden
                />
              </span>
              <span className="text-body-medium-lighter text-[color:var(--content-secondary)]">
                {text}
              </span>
            </li>
          ))}
        </ul>
        <Button
          variant="primary"
          size="regular"
          leftIcon={ctaLeftIcon}
          onClick={onAction}
          // The card body is `flex flex-col` (children stretch by default),
          // so without `self-start` the button would inherit full width.
          className="self-start"
        >
          {ctaLabel}
        </Button>
      </div>
    </SettingsCard>
  );
}
