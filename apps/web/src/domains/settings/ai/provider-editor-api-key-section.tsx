import { useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { Input } from "@vellumai/design-library/components/input";
import { Typography } from "@vellumai/design-library/components/typography";
import { ChevronRight, Loader2 } from "lucide-react";

import type { ConnectionProvider } from "@/generated/daemon/types.gen";
import type { CredentialEntry } from "@/domains/settings/ai/use-provider-credentials-list";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ProviderEditorApiKeySectionProps {
  apiKeyValue: string;
  onApiKeyChange: (value: string) => void;
  credential: string;
  onCredentialChange: (value: string) => void;
  isAuthLocked: boolean;
  isLoadingCredential: boolean;
  apiKeyPlaceholder: string;
  provider: ConnectionProvider;
  providerCredentials: CredentialEntry[];
  /** Whether the Advanced disclosure should be visible at all. */
  showAdvancedSection: boolean;
  onError: (msg: string | null) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * API Key field + Advanced credential-reference disclosure.
 *
 * Owns the disclosure expand/collapse state and the "New Credential"
 * inline form. The parent owns the actual `apiKeyValue` and `credential`
 * because those feed into the save handler.
 */
export function ProviderEditorApiKeySection({
  apiKeyValue,
  onApiKeyChange,
  credential,
  onCredentialChange,
  isAuthLocked,
  isLoadingCredential,
  apiKeyPlaceholder,
  provider,
  providerCredentials,
  showAdvancedSection,
  onError,
}: ProviderEditorApiKeySectionProps) {
  const [isAdvancedExpanded, setIsAdvancedExpanded] = useState(false);
  const [isCreatingNewCredential, setIsCreatingNewCredential] = useState(false);
  const [newCredentialName, setNewCredentialName] = useState("");

  return (
    <>
      {/* Primary: saved-state API Key field */}
      <div className="space-y-1">
        <label className="block text-body-small-default text-[var(--content-tertiary)]">
          API Key
        </label>
        {isLoadingCredential ? (
          <div className="flex items-center gap-2 h-8">
            <Loader2 className="h-4 w-4 animate-spin text-[var(--content-tertiary)]" />
            <Typography
              variant="body-small-default"
              className="text-[var(--content-tertiary)]"
            >
              Loading…
            </Typography>
          </div>
        ) : (
          <Input
            type="password"
            value={apiKeyValue}
            onChange={(e) => {
              onApiKeyChange(e.target.value);
              onError(null);
            }}
            placeholder={apiKeyPlaceholder}
            disabled={isAuthLocked}
            fullWidth
          />
        )}
      </div>

      {/* Advanced credential-reference disclosure. Visibility is
          controlled by the parent via `showAdvancedSection`. */}
      {showAdvancedSection && (
        <div>
          <button
            type="button"
            aria-expanded={isAdvancedExpanded}
            onClick={() => setIsAdvancedExpanded((v) => !v)}
            className="flex items-center gap-1 text-body-small-default text-[var(--content-secondary)] w-full text-left"
          >
            <ChevronRight
              className={`h-4 w-4 transition-transform ${isAdvancedExpanded ? "rotate-90" : ""}`}
            />
            <span>Advanced</span>
            <span className="text-[var(--content-tertiary)] ml-1">
              · Credential reference
            </span>
          </button>

          {isAdvancedExpanded && (
            <div className="mt-2 space-y-3">
              {/* Credential reference dropdown */}
              {(() => {
                const baseOptions = providerCredentials.map((c) => {
                  const ref = `credential/${c.service}/${c.field}`;
                  return { label: ref, value: ref };
                });
                const hasCurrent = baseOptions.some(
                  (o) => o.value === credential,
                );
                const dropdownOptions =
                  credential && !hasCurrent
                    ? [{ label: credential, value: credential }, ...baseOptions]
                    : baseOptions;
                if (dropdownOptions.length === 0) return null;
                return (
                  <div className="space-y-1">
                    <label className="block text-body-small-default text-[var(--content-tertiary)]">
                      Credential Reference
                    </label>
                    <Dropdown
                      aria-label="Credential reference"
                      value={credential}
                      onChange={(v) => {
                        onCredentialChange(v);
                      }}
                      disabled={isAuthLocked}
                      options={dropdownOptions}
                    />
                  </div>
                );
              })()}

              {/* New Credential inline form */}
              {isCreatingNewCredential && (
                <div className="space-y-1">
                  <label className="block text-body-small-default text-[var(--content-tertiary)]">
                    New Credential Name
                  </label>
                  <div className="flex gap-2">
                    <Input
                      value={newCredentialName}
                      onChange={(e) => setNewCredentialName(e.target.value)}
                      placeholder="e.g. team-key"
                      disabled={isAuthLocked}
                      fullWidth
                    />
                    <Button
                      variant="primary"
                      size="compact"
                      disabled={isAuthLocked || !newCredentialName.trim()}
                      onClick={() => {
                        const trimmed = newCredentialName.trim();
                        if (!trimmed) return;
                        const ref = `credential/${provider}/${trimmed}`;
                        onCredentialChange(ref);
                        setIsCreatingNewCredential(false);
                        setNewCredentialName("");
                      }}
                    >
                      Use
                    </Button>
                  </div>
                </div>
              )}

              <div className="flex justify-end">
                <Button
                  variant="ghost"
                  size="compact"
                  disabled={isAuthLocked}
                  onClick={() => {
                    if (isCreatingNewCredential) {
                      setIsCreatingNewCredential(false);
                      setNewCredentialName("");
                    } else {
                      setIsCreatingNewCredential(true);
                    }
                  }}
                >
                  {isCreatingNewCredential
                    ? "Cancel"
                    : "+ New Credential"}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
