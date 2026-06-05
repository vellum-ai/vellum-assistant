
import { ChevronDown, ChevronRight, Loader2, Shield } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { getRiskBadgeStyle } from "@/domains/chat/utils/risk";
import type { ConfirmationDecision } from "@/types/event-types";
import type { AllowlistOption, DirectoryScopeOption, ScopeOption } from "@/types/interaction-ui-types";
import { Card } from "@vellumai/design-library";

export interface ConfirmationPromptCardProps {
  confirmation: {
    requestId: string;
    title?: string;
    description?: string;
    confirmLabel?: string;
    denyLabel?: string;
    toolName?: string;
    riskLevel?: string;
    riskReason?: string;
    allowlistOptions?: AllowlistOption[];
    scopeOptions?: ScopeOption[];
    directoryScopeOptions?: DirectoryScopeOption[];
    persistentDecisionsAllowed?: boolean;
    input?: Record<string, unknown>;
  };
  isSubmitting: boolean;
  onSubmit: (decision: ConfirmationDecision) => void;
  onAllowAndCreateRule?: () => void;
}

export function ConfirmationPromptCard({
  confirmation,
  isSubmitting,
  onSubmit,
  onAllowAndCreateRule,
}: ConfirmationPromptCardProps) {
  const [showDetails, setShowDetails] = useState(false);
  const [showSplitMenu, setShowSplitMenu] = useState(false);
  const splitMenuRef = useRef<HTMLDivElement>(null);

  // Close split menu when clicking outside
  useEffect(() => {
    if (!showSplitMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (splitMenuRef.current && !splitMenuRef.current.contains(e.target as Node)) {
        setShowSplitMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showSplitMenu]);

  const hasDetails = !!confirmation.toolName || !!confirmation.description || !!confirmation.input;
  const riskBadge = confirmation.riskLevel ? getRiskBadgeStyle(confirmation.riskLevel) : null;
  const hasAllowlistOptions = (confirmation.allowlistOptions?.length ?? 0) > 0;

  return (
    <Card>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-start gap-2">
            <Shield className="mt-0.5 h-4 w-4 shrink-0 text-[var(--content-disabled)]" />
            <span className="text-body-medium-default text-[var(--content-default)]">
              {confirmation.title || "Confirmation required"}
            </span>
            {riskBadge && (
              <span
                // typography: off-scale — compact risk badge pill
                 
                className={`ml-1 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium leading-tight ${riskBadge.bg} ${riskBadge.text}`}
              >
                {riskBadge.label}
              </span>
            )}
          </div>
          {confirmation.riskReason && (
            <p className="pl-6 text-body-small-default text-[var(--content-tertiary)] dark:text-[var(--content-disabled)]">
              {confirmation.riskReason}
            </p>
          )}
        </div>

        <div className="flex shrink-0 gap-2">
          {/* Allow button — split when allowlistOptions present */}
          {hasAllowlistOptions && onAllowAndCreateRule ? (
            <div ref={splitMenuRef} className="relative flex">
              {/* Primary: plain Allow */}
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => onSubmit("allow")}
                className="flex items-center gap-1.5 rounded-l-md bg-[var(--primary-base)] px-3 py-1.5 text-body-small-default text-[var(--content-inset)] transition-colors hover:opacity-90 disabled:opacity-50"
              >
                {isSubmitting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : null}
                {confirmation.confirmLabel || "Allow"}
              </button>
              {/* Chevron toggle */}
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => setShowSplitMenu((v) => !v)}
                className="flex items-center rounded-r-md border-l border-[var(--content-inset)]/30 bg-[var(--primary-base)] px-1.5 py-1.5 text-[var(--content-inset)] transition-colors hover:opacity-90 disabled:opacity-50"
                aria-label="More allow options"
                aria-haspopup="menu"
                aria-expanded={showSplitMenu}
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
              {/* Dropdown */}
              {showSplitMenu && (
                <div className="absolute right-0 top-full z-10 mt-1 min-w-[180px] rounded-md border border-[var(--border-base)] bg-[var(--surface-lift)] py-1 shadow-lg">
                  <button
                    type="button"
                    onClick={() => {
                      setShowSplitMenu(false);
                      onAllowAndCreateRule();
                    }}
                    className="flex w-full items-center px-3 py-2 text-body-small-default text-[var(--content-default)] transition-colors hover:bg-[var(--ghost-hover)]"
                  >
                    Allow &amp; Create Rule
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button
              type="button"
              disabled={isSubmitting}
              onClick={() => onSubmit("allow")}
              className="flex items-center gap-1.5 rounded-md bg-[var(--primary-base)] px-3 py-1.5 text-body-small-default text-[var(--content-inset)] transition-colors hover:opacity-90 disabled:opacity-50"
            >
              {isSubmitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              {confirmation.confirmLabel || "Allow"}
            </button>
          )}
          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => onSubmit("deny")}
            className="flex items-center gap-1.5 rounded-md bg-[var(--system-negative-strong)] px-3 py-1.5 text-body-small-default text-white transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {confirmation.denyLabel || "Deny"}
          </button>
        </div>
      </div>

      {hasDetails && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className="flex items-center gap-1 text-body-small-default text-[var(--content-tertiary)] transition-colors hover:text-[var(--content-default)] dark:text-[var(--content-disabled)] dark:hover:text-[var(--content-default)]"
          >
            <ChevronRight
              className={`h-3 w-3 transition-transform ${showDetails ? "rotate-90" : ""}`}
            />
            {showDetails ? "Hide details" : "Show details"}
          </button>
          {showDetails && (
            <div className="mt-2 space-y-1.5">
              {confirmation.toolName && (
                <div className="flex items-center gap-1.5 text-body-small-default text-[var(--content-tertiary)]">
                  <span>Tool:</span>
                  <code className="rounded bg-[var(--surface-base)] px-1.5 py-0.5 font-mono text-[var(--content-secondary)] dark:bg-[var(--surface-lift)] dark:text-[var(--content-default)]">
                    {confirmation.toolName}
                  </code>
                </div>
              )}
              {confirmation.description && (
                <p className="text-body-small-default text-[var(--content-tertiary)]">
                  {confirmation.description}
                </p>
              )}
              {confirmation.input && (
                <pre className="overflow-x-auto rounded bg-[var(--surface-base)] p-2 font-mono text-[11px] text-[var(--content-secondary)] dark:bg-[var(--surface-lift)] dark:text-[var(--content-default)]">
                  {JSON.stringify(confirmation.input, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
