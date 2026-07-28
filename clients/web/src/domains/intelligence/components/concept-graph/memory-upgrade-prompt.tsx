/**
 * The Memory tab's unavailable-graph surface: it names why there is no concept
 * graph and offers the way out, instead of stating a bare "not available" and
 * leaving the user at a dead end. The copy decision itself lives in
 * `memory-unavailable-copy.ts`; this renders it and wires the two exits.
 *
 * The v3 migration is a real reform of memory the assistant can't regenerate —
 * it inspects the corpus, stages the rewrite and verifies it before cutover —
 * so the CTA hands the job to the assistant in chat rather than flipping
 * `memory.v3.live` from a button.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Settings, Sparkles } from "lucide-react";
import { useEffect } from "react";
import { useNavigate } from "react-router";

import { memoryStatsOptions } from "@/domains/intelligence/memory-graph/get-memory-stats";
import { invalidateMemoryQueries } from "@/domains/intelligence/memory-graph/invalidate-memory-queries";
import { emitMemoryEvent } from "@/domains/intelligence/memory-telemetry";
import { useAssistantCapability } from "@/hooks/use-assistant-capability";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library";

import { CenteredMessage } from "./centered-message";
import {
  describeMemoryUnavailable,
  MEMORY_ENABLE_PROMPT,
  MEMORY_STATUS_ERROR_COPY,
  MEMORY_V3_UPGRADE_PROMPT,
} from "./memory-unavailable-copy";

export interface MemoryUpgradePromptProps {
  assistantId: string;
  /** Opens a fresh chat seeded with a message. Without it, the upgrade CTA is
   * hidden — the surface still explains the situation, it just can't hand the
   * job off. */
  onOpenThread?: (message: string) => void;
}

export function MemoryUpgradePrompt({
  assistantId,
  onOpenThread,
}: MemoryUpgradePromptProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Deduped with the Memory page's own stats query by React Query, so this
  // costs no extra request.
  const stats = useQuery(memoryStatsOptions(assistantId));

  // Re-check on arrival. Both memory reads hold a 5-minute `staleTime`, and
  // every fix this surface offers happens elsewhere: the assistant flips
  // `memory.enabled` in a chat, or the user toggles it in Settings. Coming
  // straight back would otherwise replay the cached pre-fix answer and read as
  // "the thing I just did didn't work". The `assistantConfig` sync tag covers
  // the writes that publish one, but not every path does, so this surface does
  // not depend on that. Cheap by construction: `GET /memory-graph`
  // short-circuits before building whenever the graph is unsupported, which is
  // the only state this component renders in.
  useEffect(() => {
    invalidateMemoryQueries(queryClient, assistantId);
  }, [queryClient, assistantId]);
  // The Memory toggle lives on the Memory tab of the flag-gated Developer
  // page, which redirects to General Settings when the flag is off — so link
  // there only when the destination is actually reachable, gated exactly as
  // the schedules surface gates the same link. Without it the CTA would look
  // like a way out and land somewhere that can't turn memory on.
  const hasMemoryOptOut = useAssistantCapability("memoryOptOut");
  const settingsDeveloperNav =
    useAssistantFeatureFlagStore.use.settingsDeveloperNav();
  const canOpenMemorySettings =
    hasMemoryOptOut && settingsDeveloperNav === true;

  // Say nothing until the tier is known: the fallback copy would otherwise
  // flash "isn't available" for a beat before resolving into "upgrade".
  if (stats.isLoading) {
    return null;
  }

  const tier = stats.data?.kind === "ready" ? stats.data.tier : undefined;
  // A failed stats read leaves `tier` undefined exactly as an older daemon
  // does, but the two mean opposite things: one is "this assistant can't tell
  // us", the other is "we couldn't ask". Only the first justifies telling
  // someone to update their assistant.
  const copy = stats.isError
    ? MEMORY_STATUS_ERROR_COPY
    : describeMemoryUnavailable(tier);

  let action: React.ReactNode = null;
  if (copy.action === "upgrade" && onOpenThread) {
    action = (
      <Button
        variant="primary"
        size="compact"
        leftIcon={<Sparkles />}
        onClick={() => {
          // The route's `onOpenThread` reports its own `chat_from_node`; this
          // is the narrower signal that says which chat, and why.
          emitMemoryEvent("upgrade_v3_clicked");
          onOpenThread(MEMORY_V3_UPGRADE_PROMPT);
        }}
      >
        Upgrade memory
      </Button>
    );
  } else if (copy.action === "retry") {
    action = (
      <Button
        variant="outlined"
        size="compact"
        leftIcon={<RefreshCw />}
        onClick={() => {
          void stats.refetch();
        }}
      >
        Try again
      </Button>
    );
  } else if (copy.action === "settings" && canOpenMemorySettings) {
    action = (
      <Button
        variant="outlined"
        size="compact"
        leftIcon={<Settings />}
        onClick={() => navigate(`${routes.settings.developer}?tab=memory`)}
      >
        Memory settings
      </Button>
    );
  } else if (copy.action === "settings" && onOpenThread) {
    // No reachable toggle, so hand it to the assistant — which can set
    // `memory.enabled` regardless of which settings pages this user can see.
    action = (
      <Button
        variant="primary"
        size="compact"
        leftIcon={<Sparkles />}
        onClick={() => {
          emitMemoryEvent("enable_memory_clicked");
          onOpenThread(MEMORY_ENABLE_PROMPT);
        }}
      >
        Turn memory on
      </Button>
    );
  }

  return (
    <CenteredMessage title={copy.title} detail={copy.detail} action={action} />
  );
}
