/**
 * Always-mounted consumer for conversationless `open_url` directives.
 *
 * CLI commands (`assistant mcp auth`, `assistant oauth connect`) emit
 * `open_url` via the workspace `signals/emit-event` bridge, which has no
 * conversation binding — the wire payload carries no `conversationId`.
 * The chat stream consumer cannot own these: it only mounts with an
 * active persisted conversation, and its conversation gate drops
 * conversationless scoped events, so an OAuth browser hand-off arriving
 * while the user is on Settings/Logs (or a draft conversation) would be
 * a silent no-op. This hook subscribes at the root instead, so the
 * hand-off opens from any route.
 *
 * Conversation-bound `open_url` events (daemon tool emits) are ignored
 * here — the chat stream consumer routes them with active-conversation
 * filtering, so a background turn cannot open a window over an unrelated
 * conversation, and events for the active conversation are not opened
 * twice.
 */
import { useNavigate } from "react-router";

import { toast } from "@vellumai/design-library/components/toast";

import {
  dispatchOpenUrl,
  openUrlInPopupOrTab,
} from "@/domains/chat/utils/oauth-popup-links";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { useIsNativePlatform } from "@/runtime/native-auth";
import type { AssistantEventEnvelope } from "@vellumai/assistant-api";

/** Keep the retry visible long enough to notice and click. */
const BLOCKED_OPEN_TOAST_DURATION_MS = 15_000;

export function handleOpenUrlDirectiveEnvelope(
  envelope: AssistantEventEnvelope,
  deps: { isNative: boolean; push: (path: string) => void },
): void {
  const event = envelope.message;
  if (event.type !== "open_url") {
    return;
  }
  if (envelope.conversationId !== undefined || event.conversationId) {
    return;
  }

  const outcome = dispatchOpenUrl(event.url, deps);
  if (outcome.kind === "blocked") {
    // The toast action runs from a real click, which browsers never block.
    toast.warning("Your browser blocked a page the assistant tried to open.", {
      duration: BLOCKED_OPEN_TOAST_DURATION_MS,
      action: {
        label: "Open page",
        onClick: () => {
          openUrlInPopupOrTab(outcome.url);
        },
      },
    });
  }
}

export function useOpenUrlDirectives(): void {
  const navigate = useNavigate();
  const isNative = useIsNativePlatform();

  useBusSubscription("sse.event", (envelope) => {
    handleOpenUrlDirectiveEnvelope(envelope, {
      isNative,
      push: (path) => {
        void navigate(path);
      },
    });
  });
}
