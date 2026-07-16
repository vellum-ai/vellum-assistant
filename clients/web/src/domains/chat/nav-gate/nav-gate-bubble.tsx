/**
 * The avatar bubble for gated sidenav items.
 *
 * A single layout-scope popover anchored (via virtual ref) to whichever
 * gated region took the click — one instance serves both side-menu mounts
 * (desktop rail and mobile drawer). The assistant avatar "hops" to the item:
 * a snappy pop-in, no staged animation, per the experiment design.
 *
 * Every button drops the user back into chat: `send` stages a message the
 * active chat view sends on the user's behalf (tagged `nav_redirect`),
 * `prefill` half-composes the input so the user finishes the sentence, and
 * `dismiss` just closes. All three re-focus the composer.
 */

import { motion, useReducedMotion } from "motion/react";

import { Button, Popover } from "@vellumai/design-library";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { requestComposerFocus } from "@/domains/chat/composer-focus";
import { useComposerStore } from "@/domains/chat/composer-store";
import {
  navGateBubbleCopy,
  type NavGateButtonAction,
} from "@/domains/chat/nav-gate/nav-gate-copy";
import {
  useNavGateStore,
  type NavGateItemId,
} from "@/domains/chat/nav-gate/nav-gate-store";

/** Sidenav items open to the right; composer bottom-bar items open upward. */
const BUBBLE_SIDE: Partial<Record<NavGateItemId, "top">> = {
  "assistant-access": "top",
  "model-profile": "top",
};

export function NavGateBubble({
  assistantId,
  onAfterAction,
}: {
  assistantId: string | null;
  /** Layout hook to close the mobile drawer when an action returns to chat. */
  onAfterAction?: () => void;
}) {
  const reduce = useReducedMotion();
  const bubbleItem = useNavGateStore.use.bubbleItem();
  const bubbleAnchor = useNavGateStore.use.bubbleAnchor();
  const attempts = useNavGateStore.use.attempts();
  const avatar = useAssistantAvatar(assistantId);

  if (!bubbleItem || !bubbleAnchor) {
    return null;
  }

  const copy = navGateBubbleCopy(bubbleItem, attempts[bubbleItem] ?? 1);

  const handleAction = (action: NavGateButtonAction) => {
    const store = useNavGateStore.getState();
    switch (action.kind) {
      case "send":
        store.requestSend(action.text);
        break;
      case "prefill":
        useComposerStore.getState().setInput(action.text);
        store.dismissBubble();
        break;
      case "dismiss":
        store.dismissBubble();
        break;
    }
    requestComposerFocus();
    onAfterAction?.();
  };

  return (
    <Popover.Root
      open
      onOpenChange={(open) => {
        if (!open) {
          useNavGateStore.getState().dismissBubble();
        }
      }}
    >
      <Popover.Anchor virtualRef={{ current: bubbleAnchor }} />
      <Popover.Content
        side={BUBBLE_SIDE[bubbleItem] ?? "right"}
        align="start"
        sideOffset={10}
        className="w-72 p-3"
      >
        <div className="flex items-start gap-2.5">
          <motion.div
            className="shrink-0"
            initial={reduce ? false : { scale: 0.4, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={
              reduce
                ? { duration: 0 }
                : { type: "spring", stiffness: 500, damping: 24 }
            }
          >
            <ChatAvatar
              components={avatar.components}
              traits={avatar.traits}
              customImageUrl={avatar.customImageUrl}
              size={28}
            />
          </motion.div>
          <p className="text-[13px] leading-snug text-[color:var(--content-default)]">
            {copy.message}
          </p>
        </div>
        <div className="mt-3 flex flex-col gap-1.5">
          {copy.buttons.map((button) => (
            <Button
              key={button.label}
              variant="outlined"
              size="compact"
              className="w-full justify-center"
              onClick={() => handleAction(button.action)}
            >
              {button.label}
            </Button>
          ))}
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}
