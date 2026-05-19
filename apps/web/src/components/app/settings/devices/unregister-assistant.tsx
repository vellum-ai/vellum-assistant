
import { Loader2, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@vellum/design-library/components/button";
import { ConfirmDialog } from "@vellum/design-library/components/confirm-dialog";
import { toast } from "@vellum/design-library/components/toast";
import {
  assistantsListOptions,
  assistantsRetireDetailDestroyMutation,
} from "@/generated/api/@tanstack/react-query.gen.js";
import type { Assistant } from "@/generated/api/types.gen.js";
import { useMutation, useQueryClient } from "@tanstack/react-query";

const CURRENT_ASSISTANT_QUERY_KEY = ["currentAssistant"] as const;

export interface UnregisterAssistantProps {
  localAssistant: Assistant;
}

/**
 * Confirm-and-unregister action for a single self-hosted assistant
 * registration. Pairs an outline danger button with a confirm dialog.
 */
export function UnregisterAssistant({ localAssistant }: UnregisterAssistantProps) {
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const { mutate: unregister, isPending } = useMutation({
    ...assistantsRetireDetailDestroyMutation(),
    onSuccess: () => {
      toast.success("Self-hosted assistant unregistered.");
      void queryClient.invalidateQueries({ queryKey: CURRENT_ASSISTANT_QUERY_KEY });
      void queryClient.invalidateQueries({
        queryKey: assistantsListOptions({ query: { hosting: "local" } }).queryKey,
      });
      void queryClient.invalidateQueries({
        queryKey: assistantsListOptions({ query: { hosting: "all" } }).queryKey,
      });
    },
    onError: () => {
      toast.error("Failed to unregister assistant.");
    },
  });

  const handleUnregister = () => {
    setConfirmOpen(false);
    unregister({ path: { id: localAssistant.id } });
  };

  return (
    <>
      <Button
        variant="dangerOutline"
        size="compact"
        leftIcon={isPending ? <Loader2 className="animate-spin" /> : <Trash2 />}
        onClick={() => setConfirmOpen(true)}
        disabled={isPending}
        className="shrink-0"
      >
        Unregister
      </Button>

      <ConfirmDialog
        open={confirmOpen}
        title="Unregister Self-Hosted Assistant"
        message={`Are you sure you want to unregister "${localAssistant.name || "Unnamed"}"? This will remove the registration from your account. You can re-register the assistant later by bootstrapping it again.`}
        confirmLabel="Unregister"
        destructive
        onConfirm={handleUnregister}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
