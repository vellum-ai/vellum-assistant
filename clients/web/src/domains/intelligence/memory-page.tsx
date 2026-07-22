import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { ConceptGraphView } from "@/domains/intelligence/components/concept-graph/concept-graph-view";
import { CreateMemoryModal } from "@/domains/intelligence/components/concept-graph/create-memory-modal";
import { memoryGraphOptions } from "@/domains/intelligence/memory-graph/get-memory-graph";
import { memoryStatsOptions } from "@/domains/intelligence/memory-graph/get-memory-stats";
import { emitMemoryEvent } from "@/domains/intelligence/memory-telemetry";
import { Button } from "@vellumai/design-library";

interface MemoryPageProps {
  onOpenThread?: (message: string) => void;
}

/**
 * The Memory tab (`/assistant/memory`): a full-bleed home for the assistant's
 * memory concept graph. A native surface — no feature flag — whose entry point
 * on the identity overview is gated on graph availability (memory v3 live), so
 * it is only offered where the graph can build. The graph view handles its own
 * loading / empty / unsupported states, so a direct visit against a backend
 * that doesn't expose a graph shows the graph's "not available" copy rather
 * than a blank tab. The skills constellation stays on the Identity tab.
 */
export function MemoryPage({ onOpenThread }: MemoryPageProps) {
  const assistantId = useActiveAssistantId();
  const [createOpen, setCreateOpen] = useState(false);

  // Two backend conditions must hold before revealing the hand-authoring CTA:
  //  1. The graph backend is actually supported. `GET /memory/stats` reads
  //     `ready` even off a graph-supporting backend (it only counts page-index
  //     entries), so it can't stand in for graph readiness. Gate on the graph
  //     query's own `ready` state (React Query dedupes it with the view's
  //     query) so the CTA never sits over an unsupported page promising a map
  //     that can't update.
  //  2. The write route exists. `POST /memory/remember` and `GET /memory/stats`
  //     shipped together, so stats-route availability is a reliable capability
  //     proxy for the write route on daemons that support the graph but predate
  //     the create route.
  const memoryGraph = useQuery(memoryGraphOptions(assistantId));
  const memoryStats = useQuery(memoryStatsOptions(assistantId));
  const showCreate =
    memoryGraph.data?.kind === "ready" &&
    memoryStats.data?.kind === "ready";

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
    <div className="relative flex h-full min-h-0 flex-col">
      <ConceptGraphView
        assistantId={assistantId}
        className="h-full w-full"
        onOpenThread={onOpenThread}
      />

      {showCreate ? (
        <>
          {/* Overlay CTA. It lives on the page wrapper (a sibling of the graph
              view, not a child) so it stays off the shared view file and its
              pointer events never reach the canvas orbit-drag handlers. Offset
              from the view's top-right zoom cluster (right-4). */}
          <Button
            variant="primary"
            size="compact"
            leftIcon={<Plus />}
            onClick={() => setCreateOpen(true)}
            className="absolute right-16 top-4 z-10"
          >
            Create memory
          </Button>
          <CreateMemoryModal
            open={createOpen}
            onOpenChange={setCreateOpen}
            assistantId={assistantId}
          />
        </>
      ) : null}
    </div>
  );
}
