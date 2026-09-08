/**
 * The agents control in the floating status cluster: the whole conversation's
 * subagents and ACP runs.
 *
 * The same {@link AgentsControl} the transcript renders inline, handed the
 * conversation's rows instead of one message's. Its job is reach: the agents
 * are still working long after the turn that spawned them has scrolled away.
 *
 * **It is not standing chrome**, and it defers twice over:
 *
 *  - Only while agents are actually WORKING. It slides in when the first one
 *    spawns and out once they have all finished, so its presence is the signal
 *    (see {@link SideControlPresence}). Finished sessions stay listed inside
 *    while it is up, but do not hold it open on their own the way a finished
 *    plan does: a plan is one thing with an outcome to report, whereas agents
 *    come and go all turn, and a control that lingered after each would never
 *    leave.
 *
 *    And only the CURRENT run's sessions are listed (see
 *    {@link useCurrentRunActivity}). Every session the conversation ever
 *    produced turned this into a transcript of its own, with the live work
 *    buried under runs that ended minutes ago.
 *  - Only while the inline copy is off screen. If the user can already see the
 *    control in the thread, this one is a duplicate of it, so it stands down
 *    until that one scrolls away. See {@link useAnyInlineAgentsVisible}.
 */

import { AnimatePresence } from "motion/react";

import { AgentsControl } from "@/domains/chat/components/agents-control";
import { SideControlPresence } from "@/domains/chat/components/side-control-presence";
import { useCurrentRunActivity } from "@/domains/chat/hooks/use-conversation-activity";
import { useAnyInlineAgentsVisible } from "@/domains/chat/inline-agents-visibility-store";

export function ProgressAgentsCard({
  conversationId,
}: {
  conversationId: string;
}) {
  const activity = useCurrentRunActivity(conversationId);
  const inlineVisible = useAnyInlineAgentsVisible();

  // Present only while something is working AND the thread isn't already
  // showing the same control. `running` and not `total`: a conversation whose
  // agents have all finished has nothing live to report.
  const visible = activity.running.length > 0 && !inlineVisible;

  return (
    // The presence wrapper is INSIDE this component's own `AnimatePresence`, so
    // both reasons to leave (the last agent finishing, and the inline copy
    // scrolling into view) play the exit rather than the control vanishing
    // between frames.
    <AnimatePresence>
      {visible ? (
        <SideControlPresence>
          <AgentsControl
            activity={activity}
            data-testid="progress-agents-toggle"
          />
        </SideControlPresence>
      ) : null}
    </AnimatePresence>
  );
}
