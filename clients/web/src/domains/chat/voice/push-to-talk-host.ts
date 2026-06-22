import { isElectron } from "@/runtime/is-electron";
import { isPointerCoarse } from "@/utils/pointer";

interface PushToTalkHostState {
  electron: boolean;
  pointerCoarse: boolean;
}

export function shouldEnablePushToTalk({
  electron = isElectron(),
  pointerCoarse = isPointerCoarse(),
}: Partial<PushToTalkHostState> = {}): boolean {
  return electron || !pointerCoarse;
}
