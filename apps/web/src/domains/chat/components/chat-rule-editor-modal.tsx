/**
 * In-chat trust rule editor modal.
 *
 * Mirrors the macOS `RuleEditorModal` — a focused dialog for creating a trust
 * rule directly from the chat transcript. Shows the command context,
 * generalized pattern options, directory scope, and a risk level picker.
 *
 * Rendered by `ChatRouteContent` when `showRuleEditor` is `true`. Driven by
 * `RuleEditorContext` from `useInteractionActions`.
 */

import { useCallback, useState } from "react";

import { Button } from "@vellum/design-library/components/button";
import { Modal } from "@vellum/design-library/components/modal";
import { Typography } from "@vellum/design-library";

import type { AllowlistOption } from "@/types/interaction-ui-types";
import type { RuleEditorContext } from "@/domains/chat/hooks/use-interaction-actions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Ensures there is always at least one scope option for the "Apply to"
 * section. Matches the macOS `AssistantProgressView.scopeOptions(from:)`
 * fallback: when the daemon provides no allowlist options, synthesize a
 * wildcard "Any {toolName} call" entry.
 */
function ensureAllowlistOptions(
  options: AllowlistOption[],
  toolName: string,
): AllowlistOption[] {
  if (options.length > 0) {
    return options;
  }
  return [{ label: `Any ${toolName} call`, description: "", pattern: "*" }];
}

/**
 * Detects pipeline decompositions where all generalized options follow the
 * "program *" pattern. Pipeline commands produce per-program wildcards that
 * aren't useful as individual radio choices — collapse to a single static
 * display instead. Matches macOS `isPipelineDecomposition`.
 */
function isPipelineDecomposition(options: AllowlistOption[]): boolean {
  if (options.length <= 3) {
    return false;
  }
  return options.every((opt) => {
    const parts = opt.label.split(" ");
    return parts.length === 2 && parts[1] === "*";
  });
}

// ---------------------------------------------------------------------------
// Risk level config
// ---------------------------------------------------------------------------

const RISK_LEVELS = [
  { value: "low", label: "Low", hint: "Auto-approved at Conservative tolerance or higher", dotColor: "bg-[var(--system-positive-strong)]" },
  { value: "medium", label: "Medium", hint: "Auto-approved at Relaxed tolerance or higher", dotColor: "bg-[var(--system-mid-strong)]" },
  { value: "high", label: "High", hint: "Auto-approved only at Full Access tolerance", dotColor: "bg-[var(--system-negative-strong)]" },
] as const;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ChatRuleEditorModalProps {
  context: RuleEditorContext;
  isSaving: boolean;
  onSave: (rule: { toolName: string; pattern: string; riskLevel: string; scope: string }) => void;
  onDismiss: () => void;
}

// ---------------------------------------------------------------------------
// Radio option row — reused for pattern and directory scope sections
// ---------------------------------------------------------------------------

function RadioRow({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left transition-colors hover:bg-[var(--surface-base)]"
      aria-pressed={selected}
    >
      <span
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
          selected
            ? "border-[var(--primary-base)]"
            : "border-[var(--content-tertiary)]"
        }`}
      >
        {selected && (
          <span className="h-2 w-2 rounded-full bg-[var(--primary-base)]" />
        )}
      </span>
      <Typography
        variant="body-medium-default"
        className="text-[var(--content-default)]"
      >
        {label}
      </Typography>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ChatRuleEditorModal({
  context,
  isSaving,
  onSave,
  onDismiss,
}: ChatRuleEditorModalProps) {
  const effectiveOptions = ensureAllowlistOptions(
    context.allowlistOptions,
    context.toolName,
  );

  // Skip exact match (index 0) when multiple options exist — show only
  // generalized patterns, matching the macOS RuleEditorModal behavior.
  const generalizedOptions =
    effectiveOptions.length > 1
      ? effectiveOptions.slice(1)
      : effectiveOptions;

  const pipelineCollapsed = isPipelineDecomposition(generalizedOptions);

  const [selectedPatternIndex, setSelectedPatternIndex] = useState(() => {
    return effectiveOptions.length > 1 ? 1 : 0;
  });

  const [selectedRiskLevel, setSelectedRiskLevel] = useState(
    context.riskLevel || "medium",
  );

  const directoryScopeFiltered = context.directoryScopeOptions.filter(
    (opt) => opt.scope !== "everywhere",
  );
  const [selectedDirScopeIndex, setSelectedDirScopeIndex] = useState(-1);

  const resolvedScope = useCallback(() => {
    if (
      selectedDirScopeIndex >= 0 &&
      selectedDirScopeIndex < directoryScopeFiltered.length
    ) {
      return directoryScopeFiltered[selectedDirScopeIndex].scope;
    }
    return "everywhere";
  }, [selectedDirScopeIndex, directoryScopeFiltered]);

  const canSave =
    !isSaving &&
    effectiveOptions.length > 0 &&
    selectedPatternIndex < effectiveOptions.length;

  const handleSave = useCallback(() => {
    if (!canSave) {
      return;
    }
    const selectedOption = effectiveOptions[selectedPatternIndex];
    onSave({
      toolName: context.toolName,
      pattern: selectedOption.pattern,
      riskLevel: selectedRiskLevel,
      scope: resolvedScope(),
    });
  }, [canSave, effectiveOptions, context.toolName, selectedPatternIndex, selectedRiskLevel, resolvedScope, onSave]);

  const riskHint = RISK_LEVELS.find((r) => r.value === selectedRiskLevel)?.hint ?? "";

  return (
    <Modal.Root
      open
      onOpenChange={(next) => {
        if (!next) {
          onDismiss();
        }
      }}
    >
      <Modal.Content size="sm" hideCloseButton>
        <Modal.Header>
          <Modal.Title>Create Trust Rule</Modal.Title>
        </Modal.Header>

        <Modal.Body>
          <div className="space-y-5">
            {/* Context header — command text + description */}
            <div className="space-y-1">
              {context.commandText && (
                <div className="rounded-md bg-[var(--surface-base)] px-3 py-2">
                  <Typography
                    variant="body-small-default"
                    className="line-clamp-2 font-mono text-[var(--content-default)]"
                  >
                    {context.commandText}
                  </Typography>
                </div>
              )}
              {context.commandDescription && (
                <Typography
                  variant="label-medium-default"
                  className="text-[var(--content-tertiary)]"
                >
                  {context.commandDescription}
                </Typography>
              )}
            </div>

            {/* Apply to — pattern options */}
            <div className="space-y-2">
              <Typography
                variant="label-medium-default"
                className="text-[var(--content-secondary)]"
              >
                Apply to
              </Typography>
              {pipelineCollapsed || generalizedOptions.length === 1 ? (
                <div className="rounded-md bg-[var(--surface-base)] px-3 py-2">
                  <Typography
                    variant="body-medium-default"
                    className="text-[var(--content-default)]"
                  >
                    {generalizedOptions[0]?.label}
                  </Typography>
                </div>
              ) : generalizedOptions.length > 1 ? (
                <div className="space-y-1">
                  {generalizedOptions.map((option, i) => {
                    const targetIndex =
                      effectiveOptions.length > 1 ? i + 1 : i;
                    return (
                      <RadioRow
                        key={option.pattern}
                        label={option.label}
                        selected={selectedPatternIndex === targetIndex}
                        onSelect={() => setSelectedPatternIndex(targetIndex)}
                      />
                    );
                  })}
                </div>
              ) : null}
            </div>

            {/* Where — directory scope */}
            {directoryScopeFiltered.length > 0 && (
              <div className="space-y-2">
                <Typography
                  variant="label-medium-default"
                  className="text-[var(--content-secondary)]"
                >
                  Where
                </Typography>
                <div className="space-y-1">
                  {directoryScopeFiltered.map((option, i) => (
                    <RadioRow
                      key={option.scope}
                      label={option.label}
                      selected={selectedDirScopeIndex === i}
                      onSelect={() => setSelectedDirScopeIndex(i)}
                    />
                  ))}
                  <RadioRow
                    label="Everywhere"
                    selected={selectedDirScopeIndex === -1}
                    onSelect={() => setSelectedDirScopeIndex(-1)}
                  />
                </div>
              </div>
            )}

            {/* Treat as — risk level picker */}
            <div className="space-y-2">
              <Typography
                variant="label-medium-default"
                className="text-[var(--content-secondary)]"
              >
                Treat as
              </Typography>
              <div className="flex gap-2">
                {RISK_LEVELS.map((level) => {
                  const isSelected = selectedRiskLevel === level.value;
                  return (
                    <button
                      key={level.value}
                      type="button"
                      onClick={() => setSelectedRiskLevel(level.value)}
                      className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 transition-colors ${
                        isSelected
                          ? "border-[var(--primary-base)] bg-[var(--surface-active)]"
                          : "border-[var(--border-base)] bg-transparent hover:bg-[var(--surface-base)]"
                      }`}
                      aria-pressed={isSelected}
                    >
                      <span className={`h-2 w-2 shrink-0 rounded-full ${level.dotColor}`} />
                      <Typography
                        variant="body-medium-default"
                        className="text-[var(--content-default)]"
                      >
                        {level.label}
                      </Typography>
                    </button>
                  );
                })}
              </div>
              {riskHint && (
                <Typography
                  variant="label-medium-default"
                  className="text-[var(--content-tertiary)]"
                >
                  {riskHint}
                </Typography>
              )}
            </div>
          </div>
        </Modal.Body>

        <Modal.Footer>
          <Button variant="outlined" onClick={onDismiss}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={!canSave}
          >
            {isSaving ? "Saving…" : "Save Rule"}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
