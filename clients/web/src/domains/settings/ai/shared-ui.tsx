import type { PropsWithChildren, ReactNode } from "react";

import {
  AlertCircle,
  Check,
  Clock,
  ExternalLink,
  Info,
  Loader2,
} from "lucide-react";

import { DetailCard } from "@/components/detail-card";
import { Trans, useTranslation } from "@/i18n";
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

interface ByoServiceCardProps {
  id?: string;
  title: string;
  subtitle: string;
  children: ReactNode;
}

export function ModeToggle({ mode, onChange }: ModeToggleProps) {
  const { t } = useTranslation("settings");

  return (
    <div className="max-w-[280px]">
      <SegmentControl<ServiceMode>
        ariaLabel={t("sharedUi.modeToggleAriaLabel")}
        value={mode}
        onChange={onChange}
        items={[
          { value: "managed", label: t("sharedUi.managedLabel") },
          { value: "your-own", label: t("sharedUi.yourOwnLabel") },
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

export function ByoServiceCard({
  id,
  title,
  subtitle,
  children,
}: ByoServiceCardProps) {
  return (
    <DetailCard id={id} title={title} subtitle={subtitle}>
      <div className="h-px bg-[var(--surface-active)]" />
      <div className="mt-4">{children}</div>
    </DetailCard>
  );
}

function ManagedServicesPricingLink({ children }: PropsWithChildren) {
  return (
    <a
      href="https://www.vellum.ai/docs/pricing"
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-[var(--primary-base)] hover:underline"
    >
      {children}
      <ExternalLink className="h-3.5 w-3.5" />
    </a>
  );
}

export function ManagedServicesBanner() {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)] px-4 py-2.5">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--content-tertiary)]" />
      <p className="text-body-medium-lighter text-[var(--content-secondary)]">
        <Trans
          i18nKey="sharedUi.managedServicesBanner"
          ns="settings"
          components={{ link: <ManagedServicesPricingLink /> }}
        />
      </p>
    </div>
  );
}

export function DomainVerificationChip({
  status,
  message: _message,
  isLoading,
}: {
  status: string | undefined;
  message: string | undefined;
  isLoading: boolean;
}) {
  const { t } = useTranslation("settings");

  if (isLoading) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--tag-bg-neutral)] px-2.5 py-0.5 text-body-small-default text-[var(--content-quiet)]">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t("sharedUi.checkingDomain")}
      </span>
    );
  }

  if (!status) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-[var(--tag-bg-neutral)] px-2.5 py-0.5 text-body-small-default text-[var(--content-quiet)]"
        title={t("sharedUi.unknownStatusTitle")}
      >
        {t("sharedUi.unknownStatus")}
      </span>
    );
  }

  if (status === "verified") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-[var(--system-positive-weak)] px-2.5 py-0.5 text-body-small-default text-[var(--system-positive-strong)]"
        title={t("sharedUi.verifiedTitle")}
      >
        <Check className="h-3 w-3" />
        {t("sharedUi.domainVerified")}
      </span>
    );
  }

  if (status === "pending" || status === "not_started") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-[var(--system-mid-weak)] px-2.5 py-0.5 text-body-small-default text-[var(--system-mid-strong)]"
        title={t("sharedUi.verifyingTitle")}
      >
        <Clock className="h-3 w-3" />
        {t("sharedUi.verifyingDomain")}
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-[var(--system-negative-weak)] px-2.5 py-0.5 text-body-small-default text-[var(--system-negative-strong)]"
      title={t("sharedUi.failedTitle")}
    >
      <AlertCircle className="h-3 w-3" />
      {t("sharedUi.verificationFailed")}
    </span>
  );
}
