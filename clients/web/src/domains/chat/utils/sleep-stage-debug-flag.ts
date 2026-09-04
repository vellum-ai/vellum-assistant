/**
 * Dev flag: pin the conversation page's sleep stage to one scene.
 *
 * The stage only plays for an assistant that is actually asleep and only on
 * an arrival, which is the right behavior and an awkward thing to sit and
 * wait for while working on the animation. This forces it, in place, with no
 * reload: the override lives in the same store the stage reads, so flipping it
 * is a render.
 *
 * Surface (exposed under `window._vellumDebug.flags`):
 *
 *   forceSleepStage("sleeping")  - lids down, drifting
 *   forceSleepStage("waking")    - lids further open
 *   forceSleepStage("woke")      - eyes open, then the stage fades out
 *   forceSleepStage(null)        - clear, back to the real status
 *   forceSleepStage()            - log + return the current value
 *
 * Held in memory only: a reload hands the page back, so a forgotten override
 * cannot follow anyone into a real session.
 */

import {
  useAssistantSleepStageStore,
  type SleepStageScene,
} from "@/stores/assistant-sleep-stage-store";

const SCENES: readonly SleepStageScene[] = ["sleeping", "waking", "woke"];

function isScene(value: unknown): value is SleepStageScene {
  return SCENES.includes(value as SleepStageScene);
}

export function forceSleepStage(
  value?: SleepStageScene | null,
): SleepStageScene | null {
  const store = useAssistantSleepStageStore.getState();

  if (value === undefined) {
    console.info("[vellum] forceSleepStage:", store.forcedScene);
    return store.forcedScene;
  }

  if (value !== null && !isScene(value)) {
    console.warn(
      `[vellum] forceSleepStage: expected one of ${SCENES.join(", ")} or null`,
    );
    return store.forcedScene;
  }

  store.setForcedScene(value);
  return value;
}
