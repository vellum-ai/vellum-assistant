import type { PushToTalkTarget } from "@/domains/chat/voice/use-push-to-talk";

let activeTarget: PushToTalkTarget | null = null;

export function getPushToTalkTarget(): PushToTalkTarget | null {
  return activeTarget;
}

export function registerPushToTalkTarget(
  target: PushToTalkTarget,
): () => void {
  activeTarget = target;
  return () => {
    if (activeTarget === target) {
      activeTarget = null;
    }
  };
}
