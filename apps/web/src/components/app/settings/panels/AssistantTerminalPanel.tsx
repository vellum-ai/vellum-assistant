
import { Terminal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { TerminalPanel } from "@/components/shared/terminal/terminal-panel.js";
import { Card } from "@vellum/design-library/components/card";
import { Dropdown } from "@vellum/design-library/components/dropdown";
import type { MaintenanceMode } from "@/generated/api/types.gen.js";
import { getAssistant } from "@/lib/assistants/api.js";
import { reportError } from "@/lib/errors/report.js";

type TerminalService = "assistant" | "gateway" | "credential-executor";

const TERMINAL_SERVICE_OPTIONS: ReadonlyArray<{ value: TerminalService; label: string }> = [
  { value: "assistant", label: "assistant" },
  { value: "gateway", label: "gateway" },
  { value: "credential-executor", label: "credential-executor" },
];

/**
 * AssistantTerminalPanel is a settings panel that renders the SSH terminal
 * for the current assistant. It is rendered inside the Debug settings tab.
 *
 * When no assistant is found, a clear disabled state is shown instead of
 * the terminal. When maintenance mode is active, the TerminalPanel connects
 * to the debug pod — the toggle for entering/exiting Recovery Mode lives
 * in the Debug tab's Controls sub-tab.
 */
export function AssistantTerminalPanel() {
  const [assistantId, setAssistantId] = useState<string | null>(null);
  const [maintenanceMode, setMaintenanceMode] = useState<MaintenanceMode | null>(null);
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

  useEffect(() => {
    fetchAssistant();
  }, [fetchAssistant]);

  return (
    <div className="flex flex-1 flex-col min-h-0 gap-4">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
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

      {loading ? (
        <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--border-element)] border-t-[var(--content-secondary)]" />
          Loading terminal...
        </div>
      ) : !assistantId ? (
        <Card padding="sm" className="text-body-medium-lighter text-[var(--content-tertiary)]">
          <div className="flex items-center gap-2 px-1 py-0.5">
            <Terminal className="h-4 w-4 shrink-0" />
            <span>No assistant found. Hatch an assistant to use the terminal.</span>
          </div>
        </Card>
      ) : (
        <TerminalPanel
          key={service}
          assistantId={assistantId}
          maintenanceMode={maintenanceMode ?? undefined}
          service={service}
          className="flex-1 min-h-0"
        />
      )}
    </div>
  );
}
