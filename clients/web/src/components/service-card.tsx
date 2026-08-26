import type { ReactNode } from "react";

import { DetailCard } from "@/components/detail-card";
import { useTranslation } from "@/i18n";
import { SegmentControl } from "@vellumai/design-library/components/segment-control";

import type { ServiceMode } from "@/generated/daemon/types.gen";

interface ModeToggleProps {
  mode: ServiceMode;
  onChange: (mode: ServiceMode) => void;
}

interface ServiceCardProps {
  id?: string;
  title: string;
  subtitle: string;
  mode: ServiceMode;
  onModeChange: (mode: ServiceMode) => void;
  children: ReactNode;
}

function ModeToggle({ mode, onChange }: ModeToggleProps) {
  const { t } = useTranslation("common");

  return (
    <div className="max-w-[280px]">
      <SegmentControl<ServiceMode>
        ariaLabel={t("serviceCard.modeToggleAriaLabel")}
        value={mode}
        onChange={onChange}
        items={[
          { value: "managed", label: t("serviceCard.managedLabel") },
          { value: "your-own", label: t("serviceCard.yourOwnLabel") },
        ]}
      />
    </div>
  );
}

export function ServiceCard({
  id,
  title,
  subtitle,
  mode,
  onModeChange,
  children,
}: ServiceCardProps) {
  return (
    <DetailCard
      id={id}
      title={title}
      subtitle={subtitle}
      accessory={<ModeToggle mode={mode} onChange={onModeChange} />}
    >
      <div className="h-px bg-[var(--surface-active)]" />
      <div className="mt-4">{children}</div>
    </DetailCard>
  );
}
