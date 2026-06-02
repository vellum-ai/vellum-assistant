import type { ReactNode } from "react";
import { ExternalLink, Info } from "lucide-react";

import { Button } from "@vellum/design-library/components/button";
import { SegmentControl } from "@vellum/design-library/components/segment-control";
import { DetailCard } from "@/components/detail-card";

import type { ServiceMode } from "@/domains/settings/ai/ai-types";

// ---------------------------------------------------------------------------
// Mode toggle (managed / your-own)
// ---------------------------------------------------------------------------

interface ModeToggleProps {
  mode: ServiceMode;
  onChange: (mode: ServiceMode) => void;
}

function ModeToggle({ mode, onChange }: ModeToggleProps) {
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

// ---------------------------------------------------------------------------
// Card shells
// ---------------------------------------------------------------------------

interface ServiceCardProps {
  id?: string;
  title: string;
  subtitle: string;
  mode: ServiceMode;
  onModeChange: (mode: ServiceMode) => void;
  children: ReactNode;
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

interface ByoServiceCardProps {
  id?: string;
  title: string;
  subtitle: string;
  children: ReactNode;
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

// ---------------------------------------------------------------------------
// Action buttons
// ---------------------------------------------------------------------------

interface SaveButtonProps {
  onClick: () => void;
  disabled?: boolean;
}

export function SaveButton({ onClick, disabled }: SaveButtonProps) {
  return (
    <Button onClick={onClick} disabled={disabled}>
      Save
    </Button>
  );
}

interface ResetButtonProps {
  onClick: () => void;
  filled?: boolean;
}

export function ResetButton({ onClick, filled = false }: ResetButtonProps) {
  return (
    <Button variant={filled ? "danger" : "dangerGhost"} onClick={onClick}>
      Reset
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Credentials guide
// ---------------------------------------------------------------------------

export interface ProviderCredentialsGuide {
  description: string;
  url: string;
  linkLabel: string;
}

export function CredentialsGuide({
  guide,
}: {
  guide: ProviderCredentialsGuide;
}) {
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
