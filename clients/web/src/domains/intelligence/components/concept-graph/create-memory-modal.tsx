import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useCallback, useState } from "react";

import { createMemory } from "@/domains/intelligence/memory-graph/create-memory";
import { memoryGraphOptions } from "@/domains/intelligence/memory-graph/get-memory-graph";
import { memoryStatsOptions } from "@/domains/intelligence/memory-graph/get-memory-stats";
import { Button, Modal, toast, Typography } from "@vellumai/design-library";
import { Textarea } from "@vellumai/design-library/components/input";

export interface CreateMemoryModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assistantId: string;
  /** Fired after a successful save, with the created entry's pending graph
   * node id when the daemon provides one — the page uses it to fly the map
   * to the new memory. */
  onCreated?: (pendingNodeId: string | undefined) => void;
}

/**
 * "New memory" modal on the Memory tab: a user types a fact and we POST it to
 * the daemon `memory/remember` route. The saved fact surfaces on the map right
 * away as a dash-ringed `pending` node (the graph renders buffer entries), and
 * the route nudges a consolidation run that files it into a concept page — on
 * success we invalidate the `memory-graph` query so the pending node appears
 * on the refetch. Mirrors the controlled `open`/`onOpenChange` + local
 * `isSaving` pattern of `vercel-token-dialog.tsx`.
 */
export function CreateMemoryModal({
  open,
  onOpenChange,
  assistantId,
  onCreated,
}: CreateMemoryModalProps) {
  const queryClient = useQueryClient();
  const [content, setContent] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const handleCreate = useCallback(async () => {
    const trimmed = content.trim();
    if (!trimmed) return;

    setIsSaving(true);
    try {
      // The route returns HTTP 200 with `{ success: false }` for business
      // failures (e.g. memory disabled, empty fact), so `throwOnError` won't
      // reject — honor the flag before claiming success. Keep the modal open on
      // failure so the fact isn't lost and the user can retry.
      const result = await createMemory(assistantId, trimmed);
      if (!result.success) {
        toast.error(result.message || "Couldn't save that memory.");
        return;
      }
      // When the daemon returns the pending node id the map flies to it, so
      // the toast just confirms; otherwise it sets the "look for it" tone.
      toast.success(
        result.pendingNodeId
          ? "Got it — taking you to it."
          : "Got it — it's on your map while I file it away.",
      );
      setContent("");
      onOpenChange(false);
      // Hand the id to the page before the refetch: the graph view parks the
      // fly-to request until a layout containing the node lands.
      onCreated?.(result.pendingNodeId);
      // Invalidate the graph so the refetch shows the fact as a pending node
      // immediately (it becomes a concept node once consolidation files it),
      // and the stats query so the identity Memory card's count refreshes too
      // (a separate query with a 5-min staleTime that wouldn't otherwise refire).
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: memoryGraphOptions(assistantId).queryKey,
        }),
        queryClient.invalidateQueries({
          queryKey: memoryStatsOptions(assistantId).queryKey,
        }),
      ]);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to create memory.";
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  }, [assistantId, content, onOpenChange, onCreated, queryClient]);

  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content size="sm">
        <Modal.Header>
          <Modal.Title>New memory</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <div className="flex flex-col gap-4">
            <Textarea
              label="What should I remember?"
              placeholder="e.g. I prefer concise, bulleted summaries."
              value={content}
              onChange={(e) => setContent(e.target.value)}
              disabled={isSaving}
              rows={3}
              fullWidth
            />
            <Typography
              as="p"
              variant="body-medium-lighter"
              className="text-(--content-secondary)"
            >
              It lands on the map right away, then settles into a concept as
              it's filed.
            </Typography>
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Modal.Close asChild>
            <Button variant="outlined" disabled={isSaving}>
              Cancel
            </Button>
          </Modal.Close>
          <Button
            variant="primary"
            onClick={handleCreate}
            disabled={isSaving || !content.trim()}
            leftIcon={isSaving ? <Loader2 className="animate-spin" /> : undefined}
          >
            {isSaving ? "Creating…" : "Create memory"}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
