import type { ComponentType, CSSProperties, ReactNode } from "react";

import { DetailCard } from "@/components/detail-card";
import { Button } from "@vellumai/design-library/components/button";

export interface NudgeBenefit {
  icon: ComponentType<{
    size?: number;
    style?: CSSProperties;
    "aria-hidden"?: boolean;
  }>;
  text: string;
}

export interface NudgeSettingsCardProps {
  title: string;
  subtitle: string;
  benefits: ReadonlyArray<NudgeBenefit>;
  ctaLabel: string;
  ctaLeftIcon: ReactNode;
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
    <DetailCard title={title} subtitle={subtitle}>
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
          className="self-start"
        >
          {ctaLabel}
        </Button>
      </div>
    </DetailCard>
  );
}
