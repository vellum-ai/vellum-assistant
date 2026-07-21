import { createPortal } from "react-dom";

import { Button } from "@vellumai/design-library";

import { useInChatOnboardingStore } from "@/stores/in-chat-onboarding-store";

/**
 * Dev-only controls for the in-chat onboarding prototype: jump straight to
 * either stage (no need to actually earn the reveal) or leave the prototype.
 * Portaled above everything so it stays reachable in every stage.
 */
export function PrototypeStagePanel() {
  const stage = useInChatOnboardingStore.use.stage();
  const showFocusedChat = useInChatOnboardingStore.use.showFocusedChat();
  const startTourStage = useInChatOnboardingStore.use.startTourStage();
  const exitPrototype = useInChatOnboardingStore.use.exitPrototype();

  return createPortal(
    <div
      className="fixed right-4 bottom-4 z-[90] flex flex-col gap-1.5 rounded-xl border p-3"
      style={{
        background: "var(--surface-lift)",
        borderColor: "var(--border-base)",
        boxShadow: "var(--shadow-lg)",
      }}
    >
      <div
        className="text-label-small-default"
        style={{ color: "var(--content-tertiary)" }}
      >
        Onboarding prototype
      </div>
      <Button
        variant={stage === "chat" ? "primary" : "ghost"}
        size="compact"
        onClick={showFocusedChat}
      >
        1 · Focused chat
      </Button>
      <Button
        variant={stage === "chat" ? "ghost" : "primary"}
        size="compact"
        onClick={startTourStage}
      >
        2 · Reveal + tour
      </Button>
      <Button variant="ghost" size="compact" onClick={exitPrototype}>
        Exit prototype
      </Button>
    </div>,
    document.body,
  );
}
