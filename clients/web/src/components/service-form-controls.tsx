/**
 * Form controls shared by every provider-configuration form: the Save and
 * Reset actions, and the "where do I get a key" guide that sits above them.
 *
 * Domain-agnostic on purpose — the settings AI page and the live-voice
 * first-run card both render provider forms built from these.
 */

import { ExternalLink, Info } from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";

import type { ProviderCredentialsGuide } from "@/lib/provider-catalogs";

/**
 * A provider form's save state, published to a parent that renders the Save
 * action itself. Lets one Save commit several forms — the live-voice first-run
 * card drives its speech-to-text and text-to-speech forms from a single button.
 *
 * `save` resolves `true` when the write succeeded, so the parent can decide
 * what to do next (navigate away only on success, keeping a rejected key on
 * screen). Forms report their own failures.
 */
export interface ProviderFormSaveHandle {
  hasChanges: boolean;
  saving: boolean;
  save: () => Promise<boolean>;
}

interface SaveButtonProps {
  onClick: () => void;
  disabled?: boolean;
}

interface ResetButtonProps {
  onClick: () => void;
  filled?: boolean;
}

interface CredentialsGuideProps {
  guide: ProviderCredentialsGuide;
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
