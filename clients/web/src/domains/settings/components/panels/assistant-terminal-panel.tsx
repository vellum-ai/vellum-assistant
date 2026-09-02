import { Terminal } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getAssistant } from "@/assistant/api";
import { PlatformLoginNotice } from "@/components/platform-login-notice";
import { TerminalPanel } from "@/components/terminal-panel";
import type { MaintenanceMode } from "@/generated/api/types.gen";
import {
  useActiveAssistantLifecycleIsLoading,
  usePlatformGate,
} from "@/hooks/use-platform-gate";
import { useTranslation } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";
import { toast } from "@vellumai/design-library";
import { Select } from "@vellumai/design-library/components/select";

type TerminalService = "assistant" | "gateway" | "credential-executor";

export function AssistantTerminalPanel() {
  const { t } = useTranslation("settings");
  // The terminal session is a platform-routed exec channel — `platformHostedOnly`
  // flips "gated" when the active assistant is self-hosted, even on a
  // platform-mode app where the standard gate would still resolve to "full".
  const platformGate = usePlatformGate({ platformHostedOnly: true });
  // Settings routes are NOT mounted under `<ActiveAssistantGate>`, so the
  // gate intentionally returns "full" during the lifecycle `loading`
  // window on a deep-link / hard refresh. Pair with the lifecycle-loading
  // signal so we hold in the loading branch during the race; once the
  // lifecycle resolves to `self_hosted` the gate flips to `gated` and we
  // early-return null, structurally blocking TerminalPanel from mounting
  // a platform-routed exec connection against a self-hosted target.
  const isLifecycleLoading = useActiveAssistantLifecycleIsLoading();
  const [assistantId, setAssistantId] = useState<string | null>(null);
  const [maintenanceMode, setMaintenanceMode] =
    useState<MaintenanceMode | null>(null);
  const [loading, setLoading] = useState(true);
  const [service, setService] = useState<TerminalService>("assistant");
  const fetchedRef = useRef(false);

  const terminalServiceOptions = useMemo(
    () =>
      [
        { value: "assistant" as const, label: "assistant" },
        { value: "gateway" as const, label: "gateway" },
        {
          value: "credential-executor" as const,
          label: "credential-executor",
        },
      ] as const,
    [],
  );

  const fetchAssistant = useCallback(async (force?: boolean) => {
    if (!force && fetchedRef.current) {
      return;
    }
    if (!force) {
      setLoading(true);
    }
    try {
      const result = await getAssistant();
      if (result.ok) {
        fetchedRef.current = true;
        setAssistantId(result.data.id);
        setMaintenanceMode(result.data.maintenance_mode);
      }
    } catch (error) {
      captureError(error, { context: "fetch_assistant_for_terminal" });
      toast.error(t("assistantTerminalPanel.loadErrorToast"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  // `getAssistant` is a daemon-side call (safe in every lifecycle state
  // where we have a daemon connection), so fire it eagerly whenever the
  // gate is open. The platform-routed exec connection — the actual
  // Trap-5 concern — lives inside `<TerminalPanel>` and is structurally
  // blocked from mounting in two ways: the gate flips to `"gated"` and
  // returns null when the lifecycle resolves to self-hosted, and the
  // `showLoading` branch below covers the lifecycle-loading race window.
  // When disabled we render the panel chrome plus a Notice without
  // firing the fetch.
  useEffect(() => {
    if (platformGate !== "full") {
      return;
    }
    void fetchAssistant();
  }, [fetchAssistant, platformGate]);

  if (platformGate === "gated") {
    return null;
  }

  // Treat ONLY the genuine lifecycle-loading window as still-resolving.
  // Already-resolved non-hosted kinds (`retired`, `error`) must
  // fall through to the existing
  // "No assistant found" empty state — gating those on `!isPlatformHosted`
  // would stick the panel on the spinner forever because `fetchAssistant`
  // never clears `loading` for an assistant that doesn't exist.
  const isResolving = platformGate === "full" && isLifecycleLoading;
  const showLoading = loading || isResolving;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-base)]">
            <Terminal className="h-5 w-5 text-[var(--content-secondary)]" />
          </div>
          <div className="min-w-0">
            <h2 className="text-title-small text-[var(--content-default)]">
              {t("assistantTerminalPanel.title")}
            </h2>
            <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
              {t("assistantTerminalPanel.subtitle")}
            </p>
          </div>
        </div>
        {assistantId && (
          <Select
            options={[...terminalServiceOptions]}
            value={service}
            onChange={setService}
            aria-label={t("assistantTerminalPanel.targetContainer")}
          />
        )}
      </div>

      {platformGate === "disabled" ? (
        <PlatformLoginNotice>
          {t("assistantTerminalPanel.loginNotice")}
        </PlatformLoginNotice>
      ) : showLoading ? (
        <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--border-element)] border-t-[var(--content-secondary)]" />
          {t("assistantTerminalPanel.loading")}
        </div>
      ) : !assistantId ? (
        <div className="rounded-lg border border-[var(--border-base)] px-4 py-3 text-body-medium-lighter text-[var(--content-tertiary)]">
          <div className="flex items-center gap-2 px-1 py-0.5">
            <Terminal className="h-4 w-4 shrink-0" />
            <span>{t("assistantTerminalPanel.noAssistant")}</span>
          </div>
        </div>
      ) : (
        <TerminalPanel
          key={service}
          assistantId={assistantId}
          maintenanceMode={maintenanceMode ?? undefined}
          service={service}
          className="min-h-0 flex-1"
        />
      )}
    </div>
  );
}
