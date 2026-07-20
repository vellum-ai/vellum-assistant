import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { ConceptGraphView } from "@/domains/intelligence/components/concept-graph/concept-graph-view";
import { CreateMemoryModal } from "@/domains/intelligence/components/concept-graph/create-memory-modal";
import { emitMemoryEvent } from "@/domains/intelligence/memory-telemetry";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { Button } from "@vellumai/design-library";

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
  const [createOpen, setCreateOpen] = useState(false);

  // The button lets a user seed a memory by hand. Gate it on the same
  // `memory-concept-graph` flag as the tab, and wait for `hasHydrated` before
  // trusting a `false`: the store starts on registry defaults until the first
  // `/feature-flags` response, so gating on the raw flag would flash the button
  // then hide it (or vice-versa) on load. See the store's `hasHydrated` docs.
  const flagsHydrated = useAssistantFeatureFlagStore.use.hasHydrated();
  const memoryFlag = useAssistantFeatureFlagStore.use.memoryConceptGraph();
  const showCreate = flagsHydrated && memoryFlag;

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
