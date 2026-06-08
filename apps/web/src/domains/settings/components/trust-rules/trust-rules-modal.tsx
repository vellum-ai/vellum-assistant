import { Pencil, ShieldCheck, Trash2 } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { deleteTrustRule, fetchTrustRules } from "@/lib/trust-rules-api";
import type { TrustRuleItem, TrustRuleRisk } from "@/types/trust-rules";
import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { Notice } from "@vellumai/design-library/components/notice";
import { Tag, type TagTone } from "@vellumai/design-library/components/tag";
import { Toggle } from "@vellumai/design-library/components/toggle";

import { TrustRuleFormModal } from "@/domains/settings/components/trust-rules/trust-rule-form-modal";

function isDefaultRule(rule: TrustRuleItem): boolean {
  return rule.origin === "default" && !rule.userModified;
}

function mergeRulesForAllDefaults(
  userRelevant: TrustRuleItem[],
  allDefaults: TrustRuleItem[],
): TrustRuleItem[] {
  const seen = new Set<string>();
  const merged: TrustRuleItem[] = [];
  for (const rule of userRelevant) {
    if (!seen.has(rule.id)) {
      seen.add(rule.id);
      merged.push(rule);
    }
  }
  for (const rule of allDefaults) {
    if (!seen.has(rule.id)) {
      seen.add(rule.id);
      merged.push(rule);
    }
  }
  return merged.sort((a, b) => {
    if (a.tool !== b.tool) return a.tool.localeCompare(b.tool);
    return a.description.localeCompare(b.description);
  });
}

function riskBadgeTone(risk: TrustRuleRisk): TagTone {
  switch (risk) {
    case "low":
      return "positive";
    case "medium":
      return "warning";
    case "high":
      return "negative";
  }
}

function riskLabel(risk: TrustRuleRisk): string {
  return risk.charAt(0).toUpperCase() + risk.slice(1);
}

export interface TrustRulesModalProps {
  assistantId: string;
  onClose: () => void;
}

export function TrustRulesModal({ assistantId, onClose }: TrustRulesModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [rules, setRules] = useState<TrustRuleItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [editingRule, setEditingRule] = useState<TrustRuleItem | null>(null);
  const [ruleToDelete, setRuleToDelete] = useState<TrustRuleItem | null>(null);
  const [showAllDefaults, setShowAllDefaults] = useState(false);

  const fetchRulesForState = useCallback(
    async (showAll: boolean): Promise<TrustRuleItem[]> => {
      if (showAll) {
        const [userRelevant, allDefaults] = await Promise.all([
          fetchTrustRules(assistantId),
          fetchTrustRules(assistantId, { origin: "default" }),
        ]);
        return mergeRulesForAllDefaults(userRelevant, allDefaults);
      }
      return fetchTrustRules(assistantId);
    },
    [assistantId],
  );

  const loadRules = useCallback(async () => {
    setIsLoading(true);
    try {
      const fetched = await fetchRulesForState(showAllDefaults);
      setRules(fetched);
      setErrorMessage(null);
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to load trust rules.",
      );
    } finally {
      setIsLoading(false);
    }
  }, [fetchRulesForState, showAllDefaults]);

  useEffect(() => {
    let stale = false;
    (async () => {
      setIsLoading(true);
      try {
        const fetched = await fetchRulesForState(showAllDefaults);
        if (!stale) {
          setRules(fetched);
          setErrorMessage(null);
        }
      } catch (err) {
        if (!stale) {
          setErrorMessage(
            err instanceof Error ? err.message : "Failed to load trust rules.",
          );
        }
      } finally {
        if (!stale) setIsLoading(false);
      }
    })();
    return () => {
      stale = true;
    };
  }, [fetchRulesForState, showAllDefaults]);

  const handleDelete = useCallback(async () => {
    if (!ruleToDelete) return;
    try {
      await deleteTrustRule(assistantId, ruleToDelete.id);
      void loadRules();
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to delete trust rule.",
      );
    } finally {
      setRuleToDelete(null);
    }
  }, [assistantId, ruleToDelete, loadRules]);

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
    <>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="trust-rules-title"
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
        onKeyDown={handleKeyDown}
        onClick={handleBackdropClick}
      >
        <div className="mx-4 flex max-h-[80vh] w-full max-w-2xl flex-col rounded-xl border border-[var(--border-base)] bg-[var(--surface-lift)] shadow-xl">
          <div className="flex items-center justify-between gap-3 border-b border-[var(--border-base)] px-6 py-4">
            <h2
              id="trust-rules-title"
              className="text-title-medium text-[var(--content-default)]"
            >
              Trust Rules
            </h2>
            <div className="flex items-center gap-3">
              <Toggle
                checked={showAllDefaults}
                onChange={setShowAllDefaults}
                label="Show all defaults"
              />
              <Button variant="outlined" onClick={onClose}>Done</Button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-4">
            {errorMessage && (
              <div className="mb-3">
                <Notice tone="error">{errorMessage}</Notice>
              </div>
            )}
            {isLoading ? (
              <div className="flex h-48 items-center justify-center text-body-medium-lighter text-[var(--content-tertiary)]">
                Loading…
              </div>
            ) : rules.length === 0 ? (
              <div className="flex h-48 flex-col items-center justify-center gap-2 px-6 text-[var(--content-tertiary)]">
                <ShieldCheck className="h-8 w-8" />
                <p className="max-w-xs text-center text-body-medium-lighter">
                  No trust rules yet. Rules are created when you classify
                  actions from permission prompts.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-[var(--border-base)]">
                {rules.map((rule) => {
                  const isDefault = isDefaultRule(rule);
                  return (
                    <li
                      key={rule.id}
                      className="flex items-start gap-3 py-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-body-medium-default text-[var(--content-default)]">
                            {rule.tool}
                          </span>
                          <Tag tone={riskBadgeTone(rule.risk)}>
                            {riskLabel(rule.risk)}
                          </Tag>
                          {rule.origin === "default" && (
                            <Tag tone="neutral">Default</Tag>
                          )}
                          {rule.userModified && (
                            <Tag tone="warning">Modified</Tag>
                          )}
                        </div>
                        <div className="mt-1 truncate font-mono text-body-small-default text-[var(--content-secondary)]">
                          {rule.pattern}
                        </div>
                        {rule.description && (
                          <div className="mt-0.5 truncate text-body-small-default text-[var(--content-tertiary)]">
                            {rule.description}
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          aria-label={`Edit ${rule.tool} rule`}
                          onClick={() => setEditingRule(rule)}
                          className="rounded-lg p-1.5 text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-base)] hover:text-[var(--content-default)]"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        {(!isDefault || rule.userModified) && (
                          <button
                            type="button"
                            aria-label={`Delete ${rule.tool} rule`}
                            onClick={() => setRuleToDelete(rule)}
                            className="rounded-lg p-1.5 text-[var(--system-negative-strong)] transition-colors hover:bg-[var(--system-negative-weak)]"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>

      {editingRule && (
        <TrustRuleFormModal
          assistantId={assistantId}
          existingRule={editingRule}
          onClose={() => setEditingRule(null)}
          onSaved={() => {
            setEditingRule(null);
            void loadRules();
          }}
        />
      )}

      <ConfirmDialog
        open={ruleToDelete !== null}
        title="Delete Trust Rule?"
        message={
          ruleToDelete
            ? `Remove the ${riskLabel(ruleToDelete.risk).toLowerCase()}-risk rule for ${ruleToDelete.tool} matching "${ruleToDelete.pattern}"?`
            : ""
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        destructive
        onConfirm={() => void handleDelete()}
        onCancel={() => setRuleToDelete(null)}
      />
    </>,
    document.body,
  );
}
