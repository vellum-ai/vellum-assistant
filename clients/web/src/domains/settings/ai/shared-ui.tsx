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



export function ByoServiceCard({ id, title, subtitle, children }: ByoServiceCardProps) {
  return (
    <DetailCard id={id} title={title} subtitle={subtitle}>
      <div className="h-px bg-[var(--surface-active)]" />
      <div className="mt-4">{children}</div>
    </DetailCard>
  );
}

export function ManagedServicesBanner() {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)] px-4 py-2.5">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--content-tertiary)]" />
      <p className="text-body-medium-lighter text-[var(--content-secondary)]">
        Managed services are metered and deducted from your Vellum account
        balance.{" "}
        <a
          href="https://www.vellum.ai/docs/pricing"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[var(--primary-base)] hover:underline"
        >
          View pricing
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
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
