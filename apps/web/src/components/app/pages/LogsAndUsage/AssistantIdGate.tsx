
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import { useResolvedAssistantId } from "@/lib/logs/useResolvedAssistantId.js";

interface AssistantIdGateProps {
  /** Render the tab content once an assistant id is resolved. */
  children: (assistantId: string) => ReactNode;
}

/**
 * Shared shell used by every Logs & Usage sub-page. Centralizes the
 * loading spinner / error placeholder / "no assistant" empty state so
 * each page just declares what it renders for a known assistantId.
 */
export function AssistantIdGate({ children }: AssistantIdGateProps) {
  const { assistantId, isLoading, isError } = useResolvedAssistantId();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2
          className="h-8 w-8 animate-spin"
          style={{ color: "var(--content-tertiary)" }}
        />
      </div>
    );
  }

  if (isError || !assistantId) {
    return (
      <div
        className="text-body-medium-lighter rounded-md border px-4 py-3"
        style={{
          background: "var(--surface-lift)",
          borderColor: "var(--border-base)",
          color: "var(--content-default)",
        }}
      >
        Could not resolve an assistant. Hatch an assistant to view logs and
        usage.
      </div>
    );
  }

  return <>{children(assistantId)}</>;
}
