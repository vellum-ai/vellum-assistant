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

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { Lock } from "lucide-react";

import { Typography } from "@vellumai/design-library";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Modal } from "@vellumai/design-library/components/modal";
import { Radio, RadioGroup } from "@vellumai/design-library/components/radio";
import { SegmentControl } from "@vellumai/design-library/components/segment-control";
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
// Shared section pieces
// ---------------------------------------------------------------------------

/** Section heading above each option group — regular body text. */
function SectionHeading({
  children,
  className = "",
}: {
  children: string;
  className?: string;
}) {
  return (
    <Typography
      variant="body-medium-default"
      as="div"
      className={`text-[var(--content-default)] ${className}`}
    >
      {children}
    </Typography>
  );
}

/**
 * Overlay-toned card matching the tool detail drawer's section containers
 * (`--surface-overlay` on `--border-base`). Every section's content sits in
 * one; radio options get one each. `onClick` makes the whole card the radio's
 * hit target (the inner Radix item stays the accessible control).
 */
function OverlayCard({
  children,
  className = "",
  onClick,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <Card
      padding="sm"
      onClick={onClick}
      className={`bg-[var(--surface-overlay)] ${
        onClick ? "cursor-pointer transition-colors hover:bg-[var(--surface-active)]" : ""
      } ${className}`}
    >
      {children}
    </Card>
  );
}

/** Radio label — pattern strings are code, so they render in mono. */
function OptionLabel({ children, mono }: { children: string; mono?: boolean }) {
  return (
    <Typography
      variant="body-small-default"
      className={`min-w-0 [overflow-wrap:anywhere] text-[var(--content-default)] ${
        mono ? "font-mono" : ""
      }`}
    >
      {children}
    </Typography>
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
          <Modal.Description>
            Matching tool calls take this rule's risk level, so your approval
            tolerance can auto-approve them.
          </Modal.Description>
        </Modal.Header>

        <Modal.Body>
          {/* Neutral checked-radio colors (the library default is positive
              green, which reads as a status signal in this dark modal). */}
          <div className="flex flex-col gap-5 [--radio-checked-bg:var(--content-default)] [--radio-checked-dot:var(--surface-overlay)]">
            {/* The tool call this rule generalizes from */}
            {(context.commandText || context.commandDescription) && (
              <OverlayCard>
                <div className="flex flex-col gap-1">
                  {context.commandText && (
                    <Typography
                      variant="body-small-default"
                      className="line-clamp-2 font-mono [overflow-wrap:anywhere] text-[var(--content-default)]"
                    >
                      {context.commandText}
                    </Typography>
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
              </OverlayCard>
            )}

            {/* Apply to — pattern options */}
            <section className="flex flex-col gap-2">
              <SectionHeading>Apply to</SectionHeading>
              {isEditMode && existingRule ? (
                <>
                  {/* Edit mode: the existing rule pattern is locked */}
                  <OverlayCard>
                    <div className="flex items-center gap-2">
                      <Lock
                        aria-hidden="true"
                        className="h-3.5 w-3.5 shrink-0 text-[var(--content-tertiary)]"
                      />
                      <Typography
                        variant="body-small-default"
                        className="truncate font-mono text-[var(--content-secondary)]"
                      >
                        {existingRule.pattern}
                      </Typography>
                    </div>
                  </OverlayCard>
                  {/* Narrower scope options for Save As New */}
                  {showSaveAsNew && (
                    <>
                      <SectionHeading className="mt-1">
                        Or narrow the scope:
                      </SectionHeading>
                      <RadioGroup
                        aria-label="Narrower scope"
                        className="gap-2"
                        value={String(selectedPatternIndex)}
                        onValueChange={(next) =>
                          handleUserInteraction(() =>
                            setSelectedPatternIndex(Number(next)),
                          )
                        }
                      >
                        {narrowerOptions.map((option) => {
                          const scopeIdx = effectiveOptions.findIndex(
                            (o) => o.pattern === option.pattern,
                          );
                          if (scopeIdx < 0) {
                            return null;
                          }
                          return (
                            <OverlayCard
                              key={option.pattern}
                              onClick={() =>
                                handleUserInteraction(() =>
                                  setSelectedPatternIndex(scopeIdx),
                                )
                              }
                            >
                              <Radio
                                value={String(scopeIdx)}
                                label={<OptionLabel mono>{option.label}</OptionLabel>}
                              />
                            </OverlayCard>
                          );
                        })}
                      </RadioGroup>
                    </>
                  )}
                </>
              ) : pipelineCollapsed || generalizedOptions.length === 1 ? (
                <OverlayCard>
                  <Typography
                    variant="body-small-default"
                    className="block whitespace-pre-wrap break-words font-mono [overflow-wrap:anywhere] text-[var(--content-default)]"
                  >
                    {generalizedOptions[0]?.label ?? ""}
                  </Typography>
                </OverlayCard>
              ) : generalizedOptions.length > 1 ? (
                <RadioGroup
                  aria-label="Apply to"
                  className="gap-2"
                  value={String(selectedPatternIndex)}
                  onValueChange={(next) =>
                    handleUserInteraction(() =>
                      setSelectedPatternIndex(Number(next)),
                    )
                  }
                >
                  {generalizedOptions.map((option, i) => {
                    const targetIndex = i + generalizationOffset;
                    return (
                      <OverlayCard
                        key={option.pattern}
                        onClick={() =>
                          handleUserInteraction(() =>
                            setSelectedPatternIndex(targetIndex),
                          )
                        }
                      >
                        <Radio
                          value={String(targetIndex)}
                          label={<OptionLabel mono>{option.label}</OptionLabel>}
                        />
                      </OverlayCard>
                    );
                  })}
                </RadioGroup>
              ) : null}
            </section>

            {/* Where — directory scope, one card per option */}
            {directoryScopeFiltered.length > 0 && (
              <section className="flex flex-col gap-2">
                <SectionHeading>Where</SectionHeading>
                <RadioGroup
                  aria-label="Where"
                  className="gap-2"
                  value={String(selectedDirScopeIndex)}
                  onValueChange={(next) =>
                    handleUserInteraction(() =>
                      setSelectedDirScopeIndex(Number(next)),
                    )
                  }
                >
                  {directoryScopeFiltered.map((option, i) => (
                    <OverlayCard
                      key={option.scope}
                      onClick={() =>
                        handleUserInteraction(() => setSelectedDirScopeIndex(i))
                      }
                    >
                      <Radio
                        value={String(i)}
                        label={<OptionLabel>{option.label}</OptionLabel>}
                      />
                    </OverlayCard>
                  ))}
                  <OverlayCard
                    onClick={() =>
                      handleUserInteraction(() => setSelectedDirScopeIndex(-1))
                    }
                  >
                    <Radio
                      value="-1"
                      label={<OptionLabel>Everywhere</OptionLabel>}
                    />
                  </OverlayCard>
                </RadioGroup>
              </section>
            )}

            {/* Treat as — risk level picker */}
            <section className="flex flex-col gap-2">
              <SectionHeading>Treat as</SectionHeading>
              <SegmentControl<TrustRuleRisk>
                ariaLabel="Treat as"
                value={selectedRiskLevel}
                onChange={(next) =>
                  handleUserInteraction(() => setSelectedRiskLevel(next))
                }
                items={RISK_LEVELS.map((level) => ({
                  value: level.value,
                  label: level.label,
                  icon: (
                    <span
                      aria-hidden="true"
                      className={`h-2 w-2 shrink-0 rounded-full ${level.dotColor}`}
                    />
                  ),
                }))}
              />
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
            </section>
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
