
import { X } from "lucide-react";
import { useState } from "react";

import type { AllowlistOption, DirectoryScopeOption, ScopeOption } from "@/domains/chat/lib/api.js";

export interface RuleEditorModalProps {
  toolName: string;
  commandText: string;
  commandDescription: string;
  riskLevel: string;
  allowlistOptions: AllowlistOption[];
  scopeOptions: ScopeOption[];
  directoryScopeOptions: DirectoryScopeOption[];
  onSave: (rule: { toolName: string; pattern: string; riskLevel: string; scope: string }) => void | Promise<void>;
  onDismiss: () => void;
}

type RiskLevelValue = "low" | "medium" | "high";

interface RiskPillConfig {
  value: RiskLevelValue;
  label: string;
  dotColor: string;
  activeClasses: string;
  inactiveClasses: string;
  hint: string;
}

const RISK_PILLS: RiskPillConfig[] = [
  {
    value: "low",
    label: "Low",
    dotColor: "bg-green-500",
    activeClasses: "bg-green-100 text-green-800 ring-green-400 dark:bg-green-900/40 dark:text-green-300 dark:ring-green-600",
    inactiveClasses: "bg-[var(--surface-base)] text-[var(--content-secondary)] ring-[var(--border-base)] hover:bg-[var(--surface-active)]",
    hint: "Auto-approved at Conservative tolerance or higher",
  },
  {
    value: "medium",
    label: "Medium",
    dotColor: "bg-yellow-400",
    activeClasses: "bg-yellow-100 text-yellow-800 ring-yellow-400 dark:bg-yellow-900/40 dark:text-yellow-300 dark:ring-yellow-500",
    inactiveClasses: "bg-[var(--surface-base)] text-[var(--content-secondary)] ring-[var(--border-base)] hover:bg-[var(--surface-active)]",
    hint: "Auto-approved at Relaxed tolerance or higher",
  },
  {
    value: "high",
    label: "High",
    dotColor: "bg-red-500",
    activeClasses: "bg-red-100 text-red-800 ring-red-400 dark:bg-red-900/40 dark:text-red-300 dark:ring-red-500",
    inactiveClasses: "bg-[var(--surface-base)] text-[var(--content-secondary)] ring-[var(--border-base)] hover:bg-[var(--surface-active)]",
    hint: "Auto-approved only at Full Access tolerance",
  },
];

/**
 * Resolve the default pattern index from the allowlist options.
 * Matches macOS: skip exact match (index 0) when multiple options exist,
 * otherwise use index 0.
 * When isPipelineDecomposed is true, always use index 0 (only one logical
 * pattern is shown as a static label).
 */
function resolveDefaultPatternIndex(allowlistOptions: AllowlistOption[], isPipelineDecomposed: boolean): number {
  if (isPipelineDecomposed) return 0;
  if (allowlistOptions.length <= 1) return 0;
  // Skip the exact-match (index 0) when there are more options
  return 1;
}

/**
 * Synthesize a single allowlist option when the upstream provided none.
 *
 * Mirrors the macOS fallback in `AssistantProgressView.scopeOptions(from:)`.
 * Without this, the modal renders an empty "Apply to" section — most often
 * for tool calls loaded from history (the daemon's
 * `annotatePersistedAssistantMessage` only persists `_riskLevel` /
 * `_riskReason` etc. on tool_use blocks, not the scope/allowlist arrays),
 * and for tools without a risk classifier (e.g. some MCP tools) where
 * `cachedAssessment` is undefined so the SSE `tool_result` event omits
 * `riskScopeOptions` entirely.
 *
 * Heuristic — when commandText is empty or matches commandDescription
 * verbatim, treat it as the natural-language activity string (tools without
 * a priority key like `command`/`path`/`url` fall back to that), and use
 * a tool-wide `*` pattern. Otherwise, use the raw commandText so the rule
 * matches at least the exact command the user just saw.
 */
function synthesizeFallbackOption(
  toolName: string,
  commandText: string,
  commandDescription: string,
): AllowlistOption {
  const trimmed = commandText.trim();
  const isNaturalLanguage =
    trimmed.length === 0 ||
    (commandDescription.length > 0 && trimmed === commandDescription.trim());
  if (isNaturalLanguage) {
    return { pattern: "*", label: `Any ${toolName} call` };
  }
  return { pattern: trimmed, label: trimmed };
}

/**
 * Normalise the incoming riskLevel string to a known pill value.
 * Falls back to "medium" when the value is unrecognised.
 */
function normalizeRiskLevel(raw: string): RiskLevelValue {
  const lower = raw.toLowerCase();
  if (lower === "low" || lower === "medium" || lower === "high") return lower;
  return "medium";
}

/**
 * Check whether all allowlist patterns are "program *" glob patterns
 * (pipeline decomposition). When true we show only the first as a static label.
 */
function allProgramWildcard(options: AllowlistOption[]): boolean {
  return options.length > 0 && options.every((o) => o.pattern.endsWith(" *") || o.pattern === "*");
}

export function RuleEditorModal({
  toolName,
  commandText,
  commandDescription,
  riskLevel,
  allowlistOptions,
  scopeOptions,
  directoryScopeOptions,
  onSave,
  onDismiss,
}: RuleEditorModalProps) {
  // Defense in depth: when upstream supplies no allowlist options, synthesize
  // a single fallback so the "Apply to" section is never silently empty.
  // See `synthesizeFallbackOption()` for context on when this kicks in.
  const effectiveAllowlistOptions: AllowlistOption[] =
    allowlistOptions.length > 0
      ? allowlistOptions
      : [synthesizeFallbackOption(toolName, commandText, commandDescription)];

  const isPipelineDecomposed = allProgramWildcard(effectiveAllowlistOptions);
  const defaultPatternIndex = resolveDefaultPatternIndex(effectiveAllowlistOptions, isPipelineDecomposed);
  const [selectedPatternIndex, setSelectedPatternIndex] = useState(defaultPatternIndex);
  // -1 = Everywhere (default — rendered as a static radio at the bottom of
  // the "Where" section). Non-negative indices refer to entries in the
  // narrower-scope lists below, which exclude the "everywhere" sentinel
  // upstream callers always emit.
  const [selectedDirectoryScopeIndex, setSelectedDirectoryScopeIndex] = useState(-1);
  const [selectedRisk, setSelectedRisk] = useState<RiskLevelValue>(normalizeRiskLevel(riskLevel));
  const [isSaving, setIsSaving] = useState(false);

  // The gateway's `generateDirectoryScopeOptions` and the daemon-side
  // `generateScopeOptions` both unconditionally append an `"everywhere"`
  // sentinel. We render our own static "Everywhere" radio below, so strip
  // the upstream sentinel here to avoid a duplicate row. Mirrors the macOS
  // RuleEditorModal which filters identically before iterating.
  const narrowerDirectoryScopeOptions = directoryScopeOptions.filter(
    (o) => o.scope !== "everywhere",
  );
  const narrowerScopeOptions = scopeOptions.filter((o) => o.scope !== "everywhere");

  const hasScopeOptions = directoryScopeOptions.length > 0 || scopeOptions.length > 0;

  const selectedPill = RISK_PILLS.find((p) => p.value === selectedRisk) ?? RISK_PILLS[1]!;

  const handleSave = async () => {
    if (isSaving) return;
    const patternOption =
      effectiveAllowlistOptions[selectedPatternIndex] ?? effectiveAllowlistOptions[0];
    if (!patternOption) return;

    let scope: string;
    if (selectedDirectoryScopeIndex === -1) {
      scope = "everywhere";
    } else if (narrowerDirectoryScopeOptions.length > 0) {
      scope = narrowerDirectoryScopeOptions[selectedDirectoryScopeIndex]?.scope ?? "everywhere";
    } else {
      // Using scopeOptions as fallback when no directoryScopeOptions
      scope = narrowerScopeOptions[selectedDirectoryScopeIndex]?.scope ?? "everywhere";
    }

    setIsSaving(true);
    try {
      await onSave({
        toolName,
        pattern: patternOption.pattern,
        riskLevel: selectedRisk,
        scope,
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    /* Overlay */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
    >
      {/* Modal panel */}
      <div className="relative flex max-h-[calc(100vh-2rem)] w-full max-w-[480px] flex-col rounded-xl border border-[var(--border-base)] bg-[var(--surface-lift)] shadow-xl">

        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--border-base)] px-4 py-3">
          {/* typography: off-scale — modal title needs semibold weight at body-medium size */}
          { }
          <span className="text-body-medium-default font-semibold text-[var(--content-default)]">
            Create Trust Rule
          </span>
          <button
            type="button"
            onClick={onDismiss}
            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--content-tertiary)] transition-colors hover:bg-[var(--ghost-hover)] hover:text-[var(--content-default)]"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">

          {/* Context header: command text + description */}
          <div className="flex flex-col gap-1.5">
            {/*
             * Cap the command box at ~8 lines so very long commands (multi-line
             * curl/jq/here-doc invocations) don't push every other section off
             * screen. Scrolls vertically when content exceeds the cap; uses
             * `whitespace-pre-wrap` so newlines from the original command are
             * preserved while long unbroken tokens still wrap via `break-all`.
             */}
            <code className="block max-h-48 overflow-y-auto whitespace-pre-wrap rounded bg-[var(--surface-base)] px-3 py-2 font-mono text-[13px] text-[var(--content-secondary)] break-all dark:bg-[var(--surface-active)] dark:text-[var(--content-default)]">
              {commandText}
            </code>
            {commandDescription && (
              <p className="text-body-small-default text-[var(--content-tertiary)] dark:text-[var(--content-disabled)]">
                {commandDescription}
              </p>
            )}
          </div>

          {/* "Apply to" section */}
          <div className="flex flex-col gap-2">
            {/* typography: off-scale — section label uses font-medium at body-small size */}
            { }
            <span className="text-body-small-default font-medium text-[var(--content-secondary)]">
              Apply to
            </span>
            {isPipelineDecomposed ? (
              /* All pipeline-decomposed patterns → show first as static label */
              <p className="text-body-small-default text-[var(--content-default)]">
                {effectiveAllowlistOptions[0]?.label ?? effectiveAllowlistOptions[0]?.pattern}
              </p>
            ) : effectiveAllowlistOptions.length === 1 ? (
              /* Single option → static label */
              <p className="text-body-small-default break-all text-[var(--content-default)]">
                {effectiveAllowlistOptions[0]!.label ?? effectiveAllowlistOptions[0]!.pattern}
              </p>
            ) : (
              /* Multiple options → radio list, skip index 0 (exact match) */
              <div className="flex flex-col gap-1.5">
                {effectiveAllowlistOptions.slice(1).map((option, relIdx) => {
                  const absIdx = relIdx + 1;
                  return (
                    <label
                      key={option.pattern}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-body-small-default text-[var(--content-default)] transition-colors hover:bg-[var(--ghost-hover)]"
                    >
                      <input
                        type="radio"
                        name="pattern"
                        checked={selectedPatternIndex === absIdx}
                        onChange={() => setSelectedPatternIndex(absIdx)}
                        className="accent-[var(--primary-base)]"
                      />
                      {option.label ?? option.pattern}
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          {/* "Where" section — shown when directoryScopeOptions or scopeOptions is non-empty */}
          {hasScopeOptions && (
            <div className="flex flex-col gap-2">
              {/* typography: off-scale — section label uses font-medium at body-small size */}
              { }
              <span className="text-body-small-default font-medium text-[var(--content-secondary)]">
                Where
              </span>
              <div className="flex flex-col gap-1.5">
                {/* Directory-specific options take priority; fall back to scopeOptions.
                    Both lists are pre-filtered to exclude the upstream "everywhere"
                    sentinel so it doesn't duplicate the static row below. */}
                {narrowerDirectoryScopeOptions.length > 0
                  ? narrowerDirectoryScopeOptions.map((opt, idx) => (
                      <label
                        key={opt.scope}
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-body-small-default text-[var(--content-default)] transition-colors hover:bg-[var(--ghost-hover)]"
                      >
                        <input
                          type="radio"
                          name="scope"
                          checked={selectedDirectoryScopeIndex === idx}
                          onChange={() => setSelectedDirectoryScopeIndex(idx)}
                          className="accent-[var(--primary-base)]"
                        />
                        {opt.label ?? opt.scope}
                      </label>
                    ))
                  : narrowerScopeOptions.map((opt, idx) => (
                      <label
                        key={opt.scope}
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-body-small-default text-[var(--content-default)] transition-colors hover:bg-[var(--ghost-hover)]"
                      >
                        <input
                          type="radio"
                          name="scope"
                          checked={selectedDirectoryScopeIndex === idx}
                          onChange={() => setSelectedDirectoryScopeIndex(idx)}
                          className="accent-[var(--primary-base)]"
                        />
                        {opt.label ?? opt.scope}
                      </label>
                    ))}
                {/* "Everywhere" default */}
                <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-body-small-default text-[var(--content-default)] transition-colors hover:bg-[var(--ghost-hover)]">
                  <input
                    type="radio"
                    name="scope"
                    checked={selectedDirectoryScopeIndex === -1}
                    onChange={() => setSelectedDirectoryScopeIndex(-1)}
                    className="accent-[var(--primary-base)]"
                  />
                  Everywhere
                </label>
              </div>
            </div>
          )}

          {/* "Treat as" section */}
          <div className="flex flex-col gap-2">
            {/* typography: off-scale — section label uses font-medium at body-small size */}
            { }
            <span className="text-body-small-default font-medium text-[var(--content-secondary)]">
              Treat as
            </span>
            <div className="flex items-center gap-2">
              {RISK_PILLS.map((pill) => (
                <button
                  key={pill.value}
                  type="button"
                  onClick={() => setSelectedRisk(pill.value)}
                  className={[
                    // typography: off-scale — risk pill uses font-medium at body-small size
                     
                    "flex items-center gap-1.5 rounded-full px-3 py-1 text-body-small-default font-medium ring-1 transition-colors",
                    selectedRisk === pill.value ? pill.activeClasses : pill.inactiveClasses,
                  ].join(" ")}
                >
                  <span className={`h-2 w-2 rounded-full ${pill.dotColor}`} />
                  {pill.label}
                </button>
              ))}
            </div>
            {/* Contextual hint */}
            <p className="text-body-small-default text-[var(--content-tertiary)] dark:text-[var(--content-disabled)]">
              {selectedPill.hint}
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end border-t border-[var(--border-base)] px-4 py-3">
          {/* typography: off-scale — save button uses font-medium at body-small size */}
          { }
          <button type="button" onClick={handleSave} disabled={isSaving} className="rounded-md bg-[var(--primary-base)] px-4 py-1.5 text-body-small-default font-medium text-[var(--content-inset)] transition-colors hover:bg-[var(--primary-hover)] disabled:opacity-50 disabled:cursor-not-allowed">
            {isSaving ? "Saving…" : "Save Rule"}
          </button>
        </div>
      </div>
    </div>
  );
}
