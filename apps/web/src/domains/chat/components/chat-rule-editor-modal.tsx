/**
 * In-chat trust rule editor modal.
 *
 * Mirrors the macOS `RuleEditorModal` — a focused dialog for creating or
 * editing a trust rule directly from the chat transcript. Supports:
 * - Create mode: pattern selection, directory scope, risk level picker
 * - Edit mode: locked existing pattern, "Save As New" for narrower scope
 * - LLM suggestion pre-population with `hasUserInteracted` guard
 * - Suggestion annotation in edit mode ("Suggested: {risk}")
 *
 * Rendered by `ChatMainPanel` when `showRuleEditor` is `true`. Driven by
 * `RuleEditorContext` from `rule-editor-store`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Typography } from "@vellumai/design-library";
import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";
import type { TrustRulePayload } from "@/domains/chat/rule-editor-actions";
import { toRiskLevel } from "@/domains/chat/utils/risk";

import type { RuleEditorContext } from "@/domains/chat/rule-editor-store";
import type { AllowlistOption } from "@/types/interaction-ui-types";
import type { TrustRuleRisk } from "@/types/trust-rules";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds the "Apply to" option list.
 *
 * When the tool call shipped its own allowlist ladder (`handleOpenRuleEditor-
 * ForToolCall`'s 3-tier `riskAllowlistOptions → riskScopeOptions` resolution),
 * we use it verbatim — index 0 is the narrowest exact match, which the UI
 * skips. Otherwise a single tier-3 fallback is synthesized, mirroring macOS
 * `scopeOptions(from:)`: the raw command itself, collapsing to the
 * "Any {toolName} call" wildcard only when the input is natural language
 * (command text == reason) or empty.
 *
 * The LLM suggestion never contributes to this list (matching macOS); it only
 * pre-selects a matching option and sets the risk level (see the effect below).
 */
function buildApplyToOptions(
  allowlistOptions: AllowlistOption[],
  toolName: string,
  commandText: string,
  commandDescription: string,
): AllowlistOption[] {
  if (allowlistOptions.length > 0) {
    return allowlistOptions;
  }
  const raw = commandText.trim();
  const isNaturalLanguage = raw.length > 0 && raw === commandDescription.trim();
  const fallbackPattern = !raw || isNaturalLanguage ? "*" : raw;
  const fallbackLabel =
    fallbackPattern === "*" ? `Any ${toolName} call` : fallbackPattern;
  return [{ label: fallbackLabel, description: "", pattern: fallbackPattern }];
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
  onSave: (rule: TrustRulePayload) => void;
  onSaveAsNew?: (rule: TrustRulePayload) => void;
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
      className="flex w-full items-start gap-2 rounded-md px-3 py-2 text-left transition-colors hover:bg-[var(--surface-base)]"
      aria-pressed={selected}
    >
      <span
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
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
        variant="body-small-default"
        className="min-w-0 [overflow-wrap:anywhere] text-[var(--content-default)]"
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
  onSaveAsNew,
  onDismiss,
}: ChatRuleEditorModalProps) {
  const { existingRule, suggestion } = context;
  const isEditMode = !!existingRule;

  const optionsFromToolCall = context.allowlistOptions.length > 0;
  const effectiveOptions = useMemo(
    () =>
      buildApplyToOptions(
        context.allowlistOptions,
        context.toolName,
        context.commandText,
        context.commandDescription,
      ),
    [
      context.allowlistOptions,
      context.toolName,
      context.commandText,
      context.commandDescription,
    ],
  );

  // Index 0 is a skippable exact match only for tool-call ladders; the
  // synthesized single-option fallback has no exact match to skip. This offset
  // drives all the index math below so both shapes render the right rows.
  const generalizationOffset =
    optionsFromToolCall && effectiveOptions.length > 1 ? 1 : 0;

  // Skip the exact match (index 0) for tool-call ladders — show only
  // generalized patterns, matching the macOS RuleEditorModal behavior.
  const generalizedOptions =
    generalizationOffset > 0
      ? effectiveOptions.slice(generalizationOffset)
      : effectiveOptions;

  const isSingleOption = effectiveOptions.length === 1;
  const pipelineCollapsed = isPipelineDecomposition(generalizedOptions);

  // In edit mode, narrower options exclude the existing rule's own pattern.
  const narrowerOptions = existingRule
    ? generalizedOptions.filter((opt) => opt.pattern !== existingRule.pattern)
    : generalizedOptions;

  const showSaveAsNew = isEditMode && !!onSaveAsNew && narrowerOptions.length > 0;

  // In edit mode the default selection is the first narrower option (what
  // "Save As New" persists), so the button can't upsert the existing pattern
  // if clicked before the LLM suggestion arrives. The suggestion effect below
  // early-returns on mount (suggestionPattern is undefined), so this default
  // must be set here at init rather than relying on the effect. Create mode
  // keeps the exact-match index (`generalizationOffset`).
  const [selectedPatternIndex, setSelectedPatternIndex] = useState(() => {
    if (existingRule && narrowerOptions.length > 0) {
      const idx = effectiveOptions.findIndex(
        (o) => o.pattern === narrowerOptions[0].pattern,
      );
      if (idx >= 0) {
        return idx;
      }
    }
    return generalizationOffset;
  });

  const [selectedRiskLevel, setSelectedRiskLevel] = useState<TrustRuleRisk>(
    context.riskLevel,
  );

  const directoryScopeFiltered = context.directoryScopeOptions.filter(
    (opt) => opt.scope !== "everywhere",
  );
  const [selectedDirScopeIndex, setSelectedDirScopeIndex] = useState(-1);

  // Tracks whether user has manually interacted with the form.
  // Prevents a late-arriving LLM suggestion from overwriting user choices.
  const [hasUserInteracted, setHasUserInteracted] = useState(false);
  const prevSuggestionPattern = useRef<string | undefined>(undefined);

  // Apply suggestion or defaults when suggestion arrives.
  // Matches macOS `applySuggestionOrDefaults()`. The ref-based guard ensures
  // this only fires when the suggestion pattern actually changes, even though
  // all dependencies are listed.
  const suggestionPattern = suggestion?.pattern;
  useEffect(() => {
    if (suggestionPattern === prevSuggestionPattern.current) {
      return;
    }
    prevSuggestionPattern.current = suggestionPattern;

    if (hasUserInteracted) {
      return;
    }

    if (existingRule) {
      // Edit mode: pre-fill risk from existing rule.
      setSelectedRiskLevel(existingRule.risk);

      // Default to first narrower option.
      if (narrowerOptions.length > 0) {
        const firstNarrower = narrowerOptions[0];
        const idx = effectiveOptions.findIndex((o) => o.pattern === firstNarrower.pattern);
        if (idx >= 0) {
          setSelectedPatternIndex(idx);
        }
      } else if (isSingleOption) {
        setSelectedPatternIndex(0);
      }

      // If suggestion arrived, pre-select its pattern for Save As New.
      if (suggestion && suggestion.pattern && suggestion.pattern !== existingRule.pattern) {
        const matchIdx = effectiveOptions.findIndex((o) => o.pattern === suggestion.pattern);
        if (matchIdx >= generalizationOffset || (matchIdx >= 0 && isSingleOption)) {
          setSelectedPatternIndex(matchIdx);
        }
      }
      // Apply suggestion directory scope in edit mode.
      if (suggestion?.scope && suggestion.scope !== "everywhere") {
        const matchIdx = directoryScopeFiltered.findIndex((o) => o.scope === suggestion.scope);
        if (matchIdx >= 0) {
          setSelectedDirScopeIndex(matchIdx);
        }
      }
    } else if (suggestion) {
      // Create mode with suggestion.
      if (suggestion.risk) {
        setSelectedRiskLevel(toRiskLevel(suggestion.risk));
      }
      if (suggestion.pattern) {
        const matchIdx = effectiveOptions.findIndex((o) => o.pattern === suggestion.pattern);
        if (matchIdx >= generalizationOffset || (matchIdx >= 0 && isSingleOption)) {
          setSelectedPatternIndex(matchIdx);
        }
      }
      if (suggestion.scope && suggestion.scope !== "everywhere") {
        const matchIdx = directoryScopeFiltered.findIndex((o) => o.scope === suggestion.scope);
        if (matchIdx >= 0) {
          setSelectedDirScopeIndex(matchIdx);
        }
      }
    } else {
      // Create mode without suggestion — use risk from context.
      setSelectedRiskLevel(context.riskLevel);
      if (isSingleOption) {
        setSelectedPatternIndex(0);
      }
    }
  }, [suggestionPattern, hasUserInteracted, existingRule, suggestion, effectiveOptions, isSingleOption, narrowerOptions, directoryScopeFiltered, context.riskLevel, generalizationOffset]);

  const handleUserInteraction = useCallback((setter: () => void) => {
    setHasUserInteracted(true);
    setter();
  }, []);

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
    if (isEditMode && existingRule) {
      // Edit mode: save updates the existing rule (risk only, pattern is locked).
      onSave({
        toolName: context.toolName,
        pattern: existingRule.pattern,
        riskLevel: selectedRiskLevel,
        scope: "everywhere",
      });
    } else {
      const selectedOption = effectiveOptions[selectedPatternIndex];
      onSave({
        toolName: context.toolName,
        pattern: selectedOption.pattern,
        riskLevel: selectedRiskLevel,
        scope: resolvedScope(),
      });
    }
  }, [canSave, isEditMode, existingRule, effectiveOptions, context.toolName, selectedPatternIndex, selectedRiskLevel, resolvedScope, onSave]);

  const handleSaveAsNew = useCallback(() => {
    if (!onSaveAsNew || selectedPatternIndex >= effectiveOptions.length) {
      return;
    }
    const selectedOption = effectiveOptions[selectedPatternIndex];
    onSaveAsNew({
      toolName: context.toolName,
      pattern: selectedOption.pattern,
      riskLevel: selectedRiskLevel,
      scope: resolvedScope(),
    });
  }, [onSaveAsNew, effectiveOptions, selectedPatternIndex, context.toolName, selectedRiskLevel, resolvedScope]);

  const riskHint = RISK_LEVELS.find((r) => r.value === selectedRiskLevel)?.hint ?? "";

  // Suggestion annotation: show when in edit mode, suggestion exists,
  // and its risk differs from the existing rule's risk.
  const showSuggestionAnnotation =
    isEditMode &&
    existingRule &&
    suggestion &&
    suggestion.risk &&
    suggestion.risk.toLowerCase() !== existingRule.risk.toLowerCase();

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
          <Modal.Title>{isEditMode ? "Edit Trust Rule" : "Create Trust Rule"}</Modal.Title>
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
              {isEditMode && existingRule ? (
                <>
                  {/* Edit mode: show existing rule pattern as read-only */}
                  <div className="flex items-center gap-1.5 rounded-md border border-[var(--border-base)] bg-[var(--surface-base)] px-3 py-2">
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-2.5 w-2.5 shrink-0 text-[var(--content-tertiary)]"
                    >
                      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                    <Typography
                      variant="body-medium-default"
                      className="truncate font-mono text-[var(--content-secondary)]"
                    >
                      {existingRule.pattern}
                    </Typography>
                  </div>
                  {/* Narrower scope options for Save As New */}
                  {showSaveAsNew && (
                    <>
                      <Typography
                        variant="label-medium-default"
                        className="text-[var(--content-secondary)]"
                      >
                        Or narrow the scope:
                      </Typography>
                      <div className="space-y-1">
                        {narrowerOptions.map((option) => {
                          const scopeIdx = effectiveOptions.findIndex(
                            (o) => o.pattern === option.pattern,
                          );
                          if (scopeIdx < 0) {
                            return null;
                          }
                          return (
                            <RadioRow
                              key={option.pattern}
                              label={option.label}
                              selected={selectedPatternIndex === scopeIdx}
                              onSelect={() =>
                                handleUserInteraction(() => setSelectedPatternIndex(scopeIdx))
                              }
                            />
                          );
                        })}
                      </div>
                    </>
                  )}
                </>
              ) : pipelineCollapsed || generalizedOptions.length === 1 ? (
                <div className="rounded-md bg-[var(--surface-base)] px-3 py-2">
                  <Typography
                    variant="body-small-default"
                    className="block whitespace-pre-wrap break-words font-mono [overflow-wrap:anywhere] text-[var(--content-default)]"
                  >
                    {generalizedOptions[0]?.label ?? ""}
                  </Typography>
                </div>
              ) : generalizedOptions.length > 1 ? (
                <div className="space-y-1">
                  {generalizedOptions.map((option, i) => {
                    const targetIndex = i + generalizationOffset;
                    return (
                      <RadioRow
                        key={option.pattern}
                        label={option.label}
                        selected={selectedPatternIndex === targetIndex}
                        onSelect={() =>
                          handleUserInteraction(() => setSelectedPatternIndex(targetIndex))
                        }
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
                      onSelect={() =>
                        handleUserInteraction(() => setSelectedDirScopeIndex(i))
                      }
                    />
                  ))}
                  <RadioRow
                    label="Everywhere"
                    selected={selectedDirScopeIndex === -1}
                    onSelect={() =>
                      handleUserInteraction(() => setSelectedDirScopeIndex(-1))
                    }
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
                      onClick={() =>
                        handleUserInteraction(() => setSelectedRiskLevel(level.value))
                      }
                      className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 transition-colors ${
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
              {showSuggestionAnnotation && (
                <Typography
                  variant="label-medium-default"
                  className="capitalize text-[var(--content-tertiary)]"
                >
                  Suggested: {suggestion.risk}
                </Typography>
              )}
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
          {isEditMode ? (
            <>
              {showSaveAsNew && (
                <Button
                  variant="outlined"
                  onClick={handleSaveAsNew}
                  disabled={isSaving || selectedPatternIndex >= effectiveOptions.length}
                >
                  Save As New
                </Button>
              )}
              <div className="flex-1" />
              <Button variant="outlined" onClick={onDismiss}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleSave}
                disabled={isSaving}
              >
                {isSaving ? "Saving…" : "Save"}
              </Button>
            </>
          ) : (
            <>
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
            </>
          )}
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
