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

import { useQuery } from "@tanstack/react-query";
import { Settings, Sparkles } from "lucide-react";
import { useNavigate } from "react-router";

import { memoryStatsOptions } from "@/domains/intelligence/memory-graph/get-memory-stats";
import { emitMemoryEvent } from "@/domains/intelligence/memory-telemetry";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library";

import { CenteredMessage } from "./centered-message";
import {
  describeMemoryUnavailable,
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
  // Deduped with the Memory page's own stats query by React Query, so this
  // costs no extra request.
  const stats = useQuery(memoryStatsOptions(assistantId));

  // Say nothing until the tier is known: the fallback copy would otherwise
  // flash "isn't available" for a beat before resolving into "upgrade".
  if (stats.isLoading) {
    return null;
  }

  const tier = stats.data?.kind === "ready" ? stats.data.tier : undefined;
  const copy = describeMemoryUnavailable(tier);

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
  } else if (copy.action === "settings") {
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
  }

  return (
    <CenteredMessage title={copy.title} detail={copy.detail} action={action} />
  );
}
