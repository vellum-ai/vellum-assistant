import { AlertTriangle, CheckCircle, Globe, Info, Loader2, Lock, Wrench, type LucideIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";

import { Button, Card, Input } from "@vellumai/design-library";

/**
 * Mechanically humanize a structured identifier like `slack_channel` or
 * `app_token` into "Slack channel" / "App token" — split on underscores and
 * capitalize the first letter of the first word. Intentionally generic: no
 * per-service or per-field lookup table. Credential-specific naming is the
 * model/skill's job, not this shared component's.
 */
function humanizeIdentifier(raw: string): string {
  const words = raw.split("_").filter(Boolean);
  if (words.length === 0) {
    return "";
  }
  const joined = words.join(" ");
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

export interface SecretPromptCardProps {
  secret: {
    requestId: string;
    label?: string;
    service?: string;
    field?: string;
    description?: string;
    placeholder?: string;
    allowOneTimeSend?: boolean;
    allowedTools?: string[];
    allowedDomains?: string[];
    purpose?: string;
  };
  isSubmitting: boolean;
  saved: boolean;
  onSave: (value: string) => void;
  onSendOnce: (value: string) => void;
  onCancel: () => void;
}

function ContextChip({ icon: IconGlyph, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 rounded-lg bg-[var(--surface-base)] px-2 py-1.5">
      <IconGlyph className="h-3.5 w-3.5 shrink-0 text-[var(--content-tertiary)]" />
      <span className="text-body-small-default text-[var(--content-tertiary)]">{children}</span>
    </div>
  );
}

export function SecretPromptCard({
  secret,
  isSubmitting,
  saved,
  onSave,
  onSendOnce,
  onCancel,
}: SecretPromptCardProps) {
  const [value, setValue] = useState("");

  const trimmedValue = value.trim();
  const canSubmit = trimmedValue.length > 0 && !isSubmitting && !saved;

  const credentialIdentity = [secret.service, secret.field]
    .filter((part): part is string => !!part)
    .map(humanizeIdentifier)
    .filter(Boolean)
    .join(" · ");

  const inputLabel = secret.label || credentialIdentity || "Secret value";

  const handleSave = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) {
      return;
    }
    onSave(trimmedValue);
  };

  return (
    <Card.Root padding="md" className="flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <div className="rounded-md bg-[var(--surface-active)] p-1.5">
          <Lock className="h-3 w-3 text-[var(--content-emphasised)]" />
        </div>
        <span className="text-title-small text-[var(--content-emphasised)]">
          Secure Credential
        </span>
      </div>

      <div className="h-px w-full bg-[var(--border-base)]" />

      {/* Usage context */}
      {!!(secret.purpose || secret.allowedTools?.length || secret.allowedDomains?.length) && (
        <div className="flex flex-col items-start gap-1">
          {secret.purpose && <ContextChip icon={Info}>{secret.purpose}</ContextChip>}
          {secret.allowedTools?.length ? (
            <ContextChip icon={Wrench}>Tools: {secret.allowedTools.join(", ")}</ContextChip>
          ) : null}
          {secret.allowedDomains?.length ? (
            <ContextChip icon={Globe}>Domains: {secret.allowedDomains.join(", ")}</ContextChip>
          ) : null}
        </div>
      )}

      <form onSubmit={handleSave} className="flex flex-col gap-3">
        {/* Credential entry */}
        <div className="flex flex-col gap-4 rounded-lg border border-[var(--border-base)] bg-[var(--surface-overlay)] p-4">
          {secret.description && (
            <p className="text-body-medium-default text-[var(--content-default)]">
              {secret.description}
            </p>
          )}
          <Input
            label={inputLabel}
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={secret.placeholder || "Enter secret value..."}
            disabled={isSubmitting || saved}
            fullWidth
          />
          <p className="text-body-small-default text-[var(--content-disabled)]">
            This information is stored securely on your device and not sent to any server. AI
            never sees this value.
          </p>
        </div>

        {saved ? (
          <div className="flex items-center gap-1.5">
            <CheckCircle className="h-3.5 w-3.5 text-[var(--system-positive-strong)]" />
            <span className="text-body-small-default text-[var(--system-positive-strong)]">
              Saved securely
            </span>
          </div>
        ) : (
          <>
            {/* Buttons */}
            <div className="flex items-center justify-between">
              <Button variant="danger" onClick={onCancel} disabled={isSubmitting}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={!canSubmit}
                leftIcon={isSubmitting ? <Loader2 className="animate-spin" /> : undefined}
              >
                {isSubmitting ? "Saving..." : "Save"}
              </Button>
            </div>

            {/* Send Once option */}
            {secret.allowOneTimeSend && (
              <div className="flex items-center justify-end gap-1.5">
                <AlertTriangle className="h-3 w-3 text-[var(--system-mid-strong)]" />
                <button
                  type="button"
                  onClick={() => {
                    if (!canSubmit) {
                      return;
                    }
                    onSendOnce(trimmedValue);
                  }}
                  disabled={!canSubmit}
                  className="text-body-small-default text-[var(--content-tertiary)] underline transition-colors hover:text-[var(--content-default)] disabled:opacity-50 dark:text-[var(--content-disabled)] dark:hover:text-[var(--content-default)]"
                >
                  {isSubmitting ? "Sending..." : "Send Once (not saved)"}
                </button>
              </div>
            )}
          </>
        )}
      </form>
    </Card.Root>
  );
}
