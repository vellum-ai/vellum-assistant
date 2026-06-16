/**
 * `ConversationAdmissionFloorSection` — per-conversation trust-floor picker
 * container. Renders `AdmissionFloorPicker` wired to TanStack Query for
 * fetch + optimistic mutation.
 *
 * Only mounted for channel conversations that are NOT internal channels
 * (§8.1). The parent is responsible for the guard; this component renders
 * unconditionally once mounted.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import {
  fetchConversationOverride,
  setConversationOverride,
} from "@/lib/channel-admission-policy/api";
import {
  ADMISSION_POLICY_DEFAULT,
  type AdmissionPolicy,
} from "@/lib/channel-admission-policy/types";
import { AdmissionFloorPicker } from "./admission-floor-picker";

function humaniseChannel(channelType: string): string {
  const LABELS: Record<string, string> = {
    telegram: "Telegram",
    phone: "Phone / SMS",
    whatsapp: "WhatsApp",
    slack: "Slack",
    email: "Email",
  };
  return (
    LABELS[channelType] ??
    channelType.charAt(0).toUpperCase() + channelType.slice(1)
  );
}

export interface ConversationAdmissionFloorSectionProps {
  conversationId: string;
  /** Channel type for this conversation — drives the "inherit" label + §8.1 guard. */
  originChannel: string;
}

export function ConversationAdmissionFloorSection({
  conversationId,
  originChannel,
}: ConversationAdmissionFloorSectionProps) {
  const assistantId = useActiveAssistantId();
  const queryClient = useQueryClient();

  const queryKey = [
    "conversationAdmissionOverride",
    assistantId,
    conversationId,
  ];

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () => fetchConversationOverride(assistantId, conversationId),
    staleTime: 30_000,
    // §8.2: silent failure — no error toasts; the picker just stays in
    // the "inherit" state if the fetch fails.
  });

  const mutation = useMutation({
    mutationFn: (floor: AdmissionPolicy | null) =>
      setConversationOverride(assistantId, conversationId, floor, originChannel),
    onMutate: async (floor) => {
      await queryClient.cancelQueries({ queryKey });
      const prev = queryClient.getQueryData(queryKey);
      // Optimistic update.
      queryClient.setQueryData(queryKey, (old: typeof data) =>
        old
          ? {
              ...old,
              override: floor,
            }
          : old,
      );
      return { prev };
    },
    onError: (_err, _floor, context) => {
      // §8.2: silent failure on error — just roll back.
      if (context?.prev !== undefined) {
        queryClient.setQueryData(queryKey, context.prev);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const handleChange = useCallback(
    (floor: AdmissionPolicy | null) => {
      mutation.mutate(floor);
    },
    [mutation],
  );

  const override = data?.override ?? null;
  const typeFloor = data?.typeFloor ?? ADMISSION_POLICY_DEFAULT;

  return (
    <div
      className="mt-2 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3 py-2"
      data-testid="conversation-admission-floor-section"
    >
      <p className="mb-2 text-body-small-default text-[var(--content-tertiary)]">
        Trust floor for this conversation
      </p>
      <AdmissionFloorPicker
        override={override}
        typeFloor={typeFloor}
        channelLabel={humaniseChannel(originChannel)}
        onChange={handleChange}
        disabled={isLoading || mutation.isPending}
      />
    </div>
  );
}
