import { isElectron } from "@/runtime/is-electron";
import { isPointerCoarse } from "@/utils/pointer";

interface KeyboardActivationHostState {
  electron: boolean;
  pointerCoarse: boolean;
}

/** Whether this host can plausibly reach a keyboard shortcut. */
export function supportsKeyboardActivation({
  electron = isElectron(),
  pointerCoarse = isPointerCoarse(),
}: Partial<KeyboardActivationHostState> = {}): boolean {
  return electron || !pointerCoarse;
}
