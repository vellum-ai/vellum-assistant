import type { ReactNode } from "react";

import {
    AlertCircle,
    Check,
    Clock,
    ExternalLink,
    Info,
    Loader2,
} from "lucide-react";

import { DetailCard } from "@/components/detail-card";
import { Button } from "@vellumai/design-library/components/button";
import { SegmentControl } from "@vellumai/design-library/components/segment-control";

import type { ProviderCredentialsGuide } from "@/domains/settings/ai/provider-catalogs";
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

interface SaveButtonProps {
  onClick: () => void;
  disabled?: boolean;
}

interface ResetButtonProps {
  onClick: () => void;
  filled?: boolean;
}

interface ByoServiceCardProps {
  id?: string;
  title: string;
  subtitle: string;
  children: ReactNode;
}

interface CredentialsGuideProps {
  guide: ProviderCredentialsGuide;
}

export function ModeToggle({ mode, onChange }: ModeToggleProps) {
  return (
    <div className="max-w-[280px]">
      <SegmentControl<ServiceMode>
        ariaLabel="Service mode"
        value={mode}
        onChange={onChange}
        items={[
          { value: "managed", label: "Managed" },
          { value: "your-own", label: "Your Own" },
        ]}
      />
    </div>
  );
}

export function ServiceCard({ id, title, subtitle, mode, onModeChange, children }: ServiceCardProps) {
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

export function SaveButton({ onClick, disabled }: SaveButtonProps) {
  return (
    <Button onClick={onClick} disabled={disabled}>
      Save
    </Button>
  );
}

export function ResetButton({ onClick, filled = false }: ResetButtonProps) {
  return (
    <Button variant={filled ? "danger" : "dangerGhost"} onClick={onClick}>
      Reset
    </Button>
  );
}

export function ByoServiceCard({ id, title, subtitle, children }: ByoServiceCardProps) {
  return (
    <DetailCard id={id} title={title} subtitle={subtitle}>
      <div className="h-px bg-[var(--surface-active)]" />
      <div className="mt-4">{children}</div>
    </DetailCard>
  );
}

export function CredentialsGuide({ guide }: CredentialsGuideProps) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-3 text-body-small-default text-[var(--content-tertiary)]">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--system-positive-strong)]" />
      <div className="flex flex-col gap-1">
        <span>{guide.description}</span>
        <a
          href={guide.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[var(--system-positive-strong)] underline hover:opacity-80"
        >
          {guide.linkLabel}
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
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
  if (isLoading) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--tag-bg-neutral)] px-2.5 py-0.5 text-body-small-default text-[var(--content-quiet)]">
        <Loader2 className="h-3 w-3 animate-spin" />
        Checking domain…
      </span>
    );
  }

  if (!status) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-[var(--tag-bg-neutral)] px-2.5 py-0.5 text-body-small-default text-[var(--content-quiet)]"
        title="Unable to retrieve domain verification status."
      >
        Unknown status
      </span>
    );
  }

  if (status === "verified") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-[var(--system-positive-weak)] px-2.5 py-0.5 text-body-small-default text-[var(--system-positive-strong)]"
        title="DNS records have been verified. Your domain is ready to send and receive email."
      >
        <Check className="h-3 w-3" />
        Domain verified
      </span>
    );
  }

  if (status === "pending" || status === "not_started") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-[var(--system-mid-weak)] px-2.5 py-0.5 text-body-small-default text-[var(--system-mid-strong)]"
        title="DNS records have been provisioned. Waiting for the email provider to verify them — this usually takes a few minutes."
      >
        <Clock className="h-3 w-3" />
        Verifying domain…
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-[var(--system-negative-weak)] px-2.5 py-0.5 text-body-small-default text-[var(--system-negative-strong)]"
      title="Domain verification failed. DNS records may not have propagated correctly. You could try releasing and re-registering the domain."
    >
      <AlertCircle className="h-3 w-3" />
      Verification failed
    </span>
  );
}
