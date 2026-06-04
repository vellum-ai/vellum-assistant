
import { AlertTriangle, CheckCircle, EyeOff, Globe, Info, KeyRound, Loader2, Shield, Wrench } from "lucide-react";
import { type FormEvent, useState } from "react";

import { Card, Input } from "@vellumai/design-library";

export interface SecretPromptCardProps {
  secret: {
    requestId: string;
    label?: string;
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

  const handleSave = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) {
      return;
    }
    onSave(trimmedValue);
  };

  return (
    <Card padding="lg">
      {/* Header */}
      <div className="mb-4 flex items-center gap-3">
        <Shield className="h-5 w-5 text-[var(--primary-base)] dark:text-[var(--content-secondary)]" />
        <div className="flex flex-col">
          <span className="text-body-medium-default text-[var(--content-default)]">
            Secure Credential
          </span>
          <span className="text-body-small-default text-[var(--content-tertiary)]">
            {secret.label || "Secret required"}
          </span>
        </div>
      </div>

      {/* Description */}
      {secret.description && (
        <p className="mb-4 text-body-small-default text-[var(--content-tertiary)]">
          {secret.description}
        </p>
      )}

      {/* Usage context */}
      {!!(secret.purpose || secret.allowedTools?.length || secret.allowedDomains?.length) && (
        <div className="mb-4 rounded-lg bg-[var(--surface-base)] p-3 flex flex-col gap-2">
          {secret.purpose && (
            <div className="flex items-start gap-2">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--content-tertiary)]" />
              <span className="text-body-small-default text-[var(--content-tertiary)]">{secret.purpose}</span>
            </div>
          )}
          {secret.allowedTools?.length ? (
            <div className="flex items-start gap-2">
              <Wrench className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--content-tertiary)]" />
              <span className="text-body-small-default text-[var(--content-tertiary)]">
                <span className="text-[var(--content-secondary)]">Tools:</span> {secret.allowedTools.join(", ")}
              </span>
            </div>
          ) : null}
          {secret.allowedDomains?.length ? (
            <div className="flex items-start gap-2">
              <Globe className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--content-tertiary)]" />
              <span className="text-body-small-default text-[var(--content-tertiary)]">
                <span className="text-[var(--content-secondary)]">Domains:</span> {secret.allowedDomains.join(", ")}
              </span>
            </div>
          ) : null}
        </div>
      )}

      {/* Secure input */}
      <form onSubmit={handleSave}>
        <Input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={secret.placeholder || "Enter secret value..."}
          disabled={isSubmitting || saved}
          fullWidth
          wrapperClassName="mb-4"
        />

        {/* Safety explainer */}
        <div className="mb-4 flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <KeyRound className="h-3 w-3 shrink-0 text-[var(--system-positive-strong)]" />
            <span className="text-body-small-default text-[var(--content-tertiary)]">
              Stored securely on your device, not sent to any server
            </span>
          </div>
          <div className="flex items-center gap-2">
            <EyeOff className="h-3 w-3 shrink-0 text-[var(--system-positive-strong)]" />
            <span className="text-body-small-default text-[var(--content-tertiary)]">
              The AI never sees this value — only your device can read it
            </span>
          </div>
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
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onCancel}
                disabled={isSubmitting}
                className="rounded-md border border-[var(--border-base)] bg-white px-3 py-1.5 text-body-small-default text-[var(--content-default)] transition-colors hover:bg-[var(--surface-base)] disabled:opacity-50 dark:border-[var(--border-base)] dark:bg-[var(--surface-lift)] dark:text-[var(--content-default)] dark:hover:bg-[var(--ghost-hover)]"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!canSubmit}
                className="flex items-center gap-1.5 rounded-md bg-[var(--primary-base)] px-3 py-1.5 text-body-small-default text-[var(--content-inset)] transition-colors hover:bg-[var(--primary-hover)] disabled:opacity-50"
              >
                {isSubmitting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : null}
                {isSubmitting ? "Saving..." : "Save"}
              </button>
            </div>

            {/* Send Once option */}
            {secret.allowOneTimeSend && (
              <div className="mt-2 flex items-center justify-end gap-1.5">
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
    </Card>
  );
}
