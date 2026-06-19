import { X } from "lucide-react";
import {
    type FormEvent,
    type KeyboardEvent,
    type MouseEvent,
    useCallback,
    useRef,
    useState,
} from "react";
import { createPortal } from "react-dom";

import { updateTrustRule } from "@/lib/trust-rules-api";
import type { TrustRuleItem, TrustRuleRisk } from "@/types/trust-rules";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { Input } from "@vellumai/design-library/components/input";
import { Notice } from "@vellumai/design-library/components/notice";

const TOOL_OPTIONS = [
  "bash",
  "file_read",
  "file_write",
  "file_edit",
  "web_fetch",
  "skill_load",
];

const RISK_OPTIONS: { value: TrustRuleRisk; label: string; description: string }[] = [
  { value: "low", label: "Low", description: "Auto-approve without prompting" },
  { value: "medium", label: "Medium", description: "Prompt before executing" },
  { value: "high", label: "High", description: "Always require explicit approval" },
];

export interface TrustRuleFormModalProps {
  assistantId: string;
  existingRule: TrustRuleItem;
  onClose: () => void;
  onSaved: () => void;
}

export function TrustRuleFormModal({
  assistantId,
  existingRule,
  onClose,
  onSaved,
}: TrustRuleFormModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [tool, setTool] = useState(existingRule.tool);
  const [pattern, setPattern] = useState(existingRule.pattern);
  const [risk, setRisk] = useState<TrustRuleRisk>(existingRule.risk);
  const [description, setDescription] = useState(existingRule.description ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const trimmedPattern = pattern.trim();
  const canSave = trimmedPattern.length > 0 && !submitting;

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!canSave) return;
      const resolvedDescription =
        description.trim() || `${tool} — ${trimmedPattern}`;
      setSubmitting(true);
      setErrorMessage(null);
      try {
        await updateTrustRule(assistantId, existingRule.id, {
          risk,
          description: resolvedDescription,
        });
        onSaved();
      } catch (err) {
        setErrorMessage(
          err instanceof Error ? err.message : "Failed to save trust rule.",
        );
      } finally {
        setSubmitting(false);
      }
    },
    [assistantId, canSave, description, existingRule, onSaved, risk, tool, trimmedPattern],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );

  const handleBackdropClick = useCallback(
    (e: MouseEvent) => {
      if (e.target === dialogRef.current) onClose();
    },
    [onClose],
  );

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="trust-rule-form-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onKeyDown={handleKeyDown}
      onClick={handleBackdropClick}
    >
      <div className="mx-4 flex max-h-[calc(100vh-2rem)] w-full max-w-md flex-col rounded-xl border border-[var(--border-base)] bg-[var(--surface-lift)] shadow-xl">
        <div className="flex items-center justify-between gap-3 border-b border-[var(--border-base)] px-6 py-4">
          <h2
            id="trust-rule-form-title"
            className="text-title-medium text-[var(--content-default)]"
          >
            Edit Trust Rule
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-base)] hover:text-[var(--content-default)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
          {errorMessage && <Notice tone="error">{errorMessage}</Notice>}

          <div>
            <label
              htmlFor="trust-rule-tool"
              className="block text-body-medium-default text-[var(--content-default)]"
            >
              Tool
            </label>
            <div className="mt-1">
              <Dropdown
                value={tool}
                onChange={setTool}
                disabled
                options={TOOL_OPTIONS.map((option) => ({
                  value: option,
                  label: option,
                }))}
              />
            </div>
          </div>

          <Input
            label="Pattern"
            type="text"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder="e.g., git *"
            disabled
          />

          <div>
            <span className="block text-body-medium-default text-[var(--content-default)]">
              Risk Level
            </span>
            <div className="mt-2 flex gap-2">
              {RISK_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setRisk(option.value)}
                  className={`flex-1 rounded-lg border px-3 py-2 text-left text-body-small-default transition-colors ${
                    risk === option.value
                      ? option.value === "low"
                        ? "border-[var(--system-positive-strong)] bg-[var(--system-positive-weak)] text-[var(--system-positive-strong)]"
                        : option.value === "medium"
                          ? "border-[var(--system-warning-strong)] bg-[var(--system-warning-weak)] text-[var(--system-warning-strong)]"
                          : "border-[var(--system-negative-strong)] bg-[var(--system-negative-weak)] text-[var(--system-negative-strong)]"
                      : "border-[var(--border-element)] text-[var(--content-default)] hover:bg-[var(--surface-base)]"
                  }`}
                >
                  <div>{option.label}</div>
                  <div className="mt-0.5 text-label-medium-default leading-tight opacity-70">
                    {option.description}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <Input
            label="Description (optional)"
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={`${tool} — ${trimmedPattern || "pattern"}`}
          />

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-[var(--border-element)] bg-white px-4 py-2 text-body-medium-default text-[var(--content-default)] transition-colors hover:bg-[var(--surface-base)] dark:border-[var(--border-base)] dark:bg-[var(--surface-lift)] dark:hover:bg-[var(--ghost-hover)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSave}
              className="rounded-lg bg-[var(--system-positive-strong)] px-4 py-2 text-body-medium-default text-white transition-colors hover:bg-[var(--system-positive-strong)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
