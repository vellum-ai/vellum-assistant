/**
 * The daemon's activation progress, read once per client and kept fresh by the
 * `activation:progress` sync tag.
 *
 * Progress is daemon-owned on purpose (see PLAN section 7): the live step
 * counts belong to background conversations the client's turn store knows
 * nothing about, and the same checklist has to converge across the desktop,
 * web and mobile clients.
 *
 * The read is gated three ways, so a client that cannot use the feature never
 * asks for it: the flag arm must select a list, the daemon must carry the
 * routes, and the org header must be ready (a platform-mode read without it is
 * rejected, and the rejection would be cached). The route gate is scoped to
 * the assistant being read, so a version still held for the assistant the user
 * just left cannot authorize a read against this one.
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { activationProgressGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import type { ActivationProgressGetResponse } from "@/generated/daemon/types.gen";
import {
  resolveActivationListId,
  useActivationChecklistArm,
} from "@/hooks/use-activation-checklist-flag";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { useSupportsActivationProgress } from "@/lib/backwards-compat/use-supports-activation-progress";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

export type ActivationProgress = ActivationProgressGetResponse;

export type ActivationTaskProgress = ActivationProgress["tasks"][string];

export function useActivationProgress(): UseQueryResult<ActivationProgress> {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const isOrgReady = useIsOrgReady();
  const supported = useSupportsActivationProgress(assistantId);
  const arm = useActivationChecklistArm();

  return useQuery({
    ...activationProgressGetOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled:
      assistantId != null &&
      isOrgReady &&
      supported &&
      resolveActivationListId(arm) !== null,
  });
}
