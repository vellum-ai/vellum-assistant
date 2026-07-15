import { useEffect, useRef } from "react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { ConceptGraphView } from "@/domains/intelligence/components/concept-graph/concept-graph-view";
import { emitMemoryEvent } from "@/domains/intelligence/memory-telemetry";

interface MemoryPageProps {
  onOpenThread?: (message: string) => void;
}

/**
 * The Memory tab (`/assistant/memory`): a full-bleed home for the assistant's
 * memory concept graph. Gated into the nav by the `memory-concept-graph` flag
 * (see `intelligence-layout.tsx`); the graph view handles its own
 * loading / empty / unsupported states, so on a flag-on backend that doesn't
 * expose a graph it shows the graph's "not available" copy rather than a blank
 * tab. The skills constellation stays on the Identity tab.
 */
export function MemoryPage({ onOpenThread }: MemoryPageProps) {
  const assistantId = useActiveAssistantId();

  // Report the tab open exactly once per mount. The ref guard keeps React
  // strict-mode's double-invoke (dev) from emitting a duplicate.
  const openedEmitted = useRef(false);
  useEffect(() => {
    if (openedEmitted.current) {
      return;
    }
    openedEmitted.current = true;
    emitMemoryEvent("opened");
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ConceptGraphView
        assistantId={assistantId}
        className="h-full w-full"
        onOpenThread={onOpenThread}
      />
    </div>
  );
}
