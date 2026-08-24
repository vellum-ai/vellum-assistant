import { isElectron } from "@/runtime/is-electron";
import { isPointerCoarse } from "@/utils/pointer";

interface KeyboardActivationHostState {
  electron: boolean;
  pointerCoarse: boolean;
}

/**
 * Whether this host can plausibly reach a keyboard shortcut. A coarse primary
 * pointer means a touch device with no physical keyboard, where a shortcut
 * listener is only overhead. The desktop app keeps it regardless: its pointer
 * query can report coarse on a convertible that still has keys.
 */
export function supportsKeyboardActivation({
  electron = isElectron(),
  pointerCoarse = isPointerCoarse(),
}: Partial<KeyboardActivationHostState> = {}): boolean {
  return electron || !pointerCoarse;
}
