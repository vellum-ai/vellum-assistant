/**
 * Imperative handle (subset of `VoiceInputButtonHandle`) that dictation is
 * driven through from outside the button, today the Electron dictation
 * overlay's stop control. Declared here rather than beside the button to
 * avoid a cycle with the component.
 */
export interface PushToTalkTarget {
  start: () => void;
  stop: () => void;
}

let activeTarget: PushToTalkTarget | null = null;

export function getPushToTalkTarget(): PushToTalkTarget | null {
  return activeTarget;
}

export function registerPushToTalkTarget(target: PushToTalkTarget): () => void {
  activeTarget = target;
  return () => {
    if (activeTarget === target) {
      activeTarget = null;
    }
  };
}
