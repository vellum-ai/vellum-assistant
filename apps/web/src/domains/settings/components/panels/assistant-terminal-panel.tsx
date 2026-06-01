import { Terminal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Dropdown } from "@vellum/design-library/components/dropdown";
import { Notice } from "@vellum/design-library/components/notice";
import { TerminalPanel } from "@/components/terminal-panel";
import type { MaintenanceMode } from "@/generated/api/types.gen";
import { getAssistant } from "@/assistant/api";
import {
  useActiveAssistantIsPlatformHosted,
  usePlatformGate,
} from "@/hooks/use-platform-gate";
import { reportError } from "@/utils/error-report";

type TerminalService = "assistant" | "gateway" | "credential-executor";

const TERMINAL_SERVICE_OPTIONS: ReadonlyArray<{
  value: TerminalService;
  label: string;
}> = [
  { value: "assistant", label: "assistant" },
  { value: "gateway", label: "gateway" },
  { value: "credential-executor", label: "credential-executor" },
];

export function AssistantTerminalPanel() {
  // The terminal session is a platform-routed exec channel — `platformHostedOnly`
  // flips "gated" when the active assistant is self-hosted, even on a
  // platform-mode app where the standard gate would still resolve to "full".
  const platformGate = usePlatformGate({ platformHostedOnly: true });
  // Settings routes are NOT mounted under `<ActiveAssistantGate>`, so the
  // gate intentionally returns "full" during the lifecycle `loading`
  // window on a deep-link / hard refresh. Pair with the strict hosting
  // signal so we don't kick off the platform-routed terminal connection
  // before lifecycle resolves positively as platform-hosted.
  const isPlatformHosted = useActiveAssistantIsPlatformHosted();
  const [assistantId, setAssistantId] = useState<string | null>(null);
  const [maintenanceMode, setMaintenanceMode] =
    useState<MaintenanceMode | null>(null);
  const [loading, setLoading] = useState(true);
  const [service, setService] = useState<TerminalService>("assistant");
  const fetchedRef = useRef(false);

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
      reportError(error, {
        context: "fetch_assistant_for_terminal",
        userMessage: "Failed to load assistant info",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  // The terminal session is a platform-routed exec channel, so only fetch
  // assistant detail (and let TerminalPanel attempt a connection) when the
  // gate is fully open AND the assistant is positively resolved as
  // platform-hosted. When disabled we render the panel chrome plus a
  // Notice without firing the platform fetch; during the resolution race
  // we hold in the loading branch until `isPlatformHosted` flips true.
  useEffect(() => {
    if (platformGate !== "full" || !isPlatformHosted) return;
    fetchAssistant();
  }, [fetchAssistant, platformGate, isPlatformHosted]);

  if (platformGate === "gated") return null;

  // Treat the resolution race as still-loading. `loading` only reflects
  // the daemon `getAssistant` call — without `isResolving`, the panel
  // would fall through to "No assistant found" (when `loading` is false
  // and `assistantId` is null) during the window before the gate fires
  // the fetch.
  const isResolving = platformGate === "full" && !isPlatformHosted;
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
              Terminal
            </h2>
            <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
              Interactive shell session on your assistant machine
            </p>
          </div>
        </div>
        {assistantId && (
          <Dropdown
            options={TERMINAL_SERVICE_OPTIONS}
            value={service}
            onChange={setService}
            aria-label="Target container"
          />
        )}
      </div>

      {platformGate === "disabled" ? (
        <Notice tone="info">
          Log in to the Vellum platform to open a terminal session.
        </Notice>
      ) : showLoading ? (
        <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--border-element)] border-t-[var(--content-secondary)]" />
          Loading terminal...
        </div>
      ) : !assistantId ? (
        <div className="rounded-lg border border-[var(--border-default)] px-4 py-3 text-body-medium-lighter text-[var(--content-tertiary)]">
          <div className="flex items-center gap-2 px-1 py-0.5">
            <Terminal className="h-4 w-4 shrink-0" />
            <span>
              No assistant found. Hatch an assistant to use the terminal.
            </span>
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
