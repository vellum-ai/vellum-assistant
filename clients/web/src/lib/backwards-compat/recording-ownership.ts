import { assistantScopedSupports } from "@/lib/backwards-compat/utils";

export const MIN_VERSION = "0.11.7";

export function supportsRecordingOwnership(assistantId: string): boolean {
  return assistantScopedSupports(MIN_VERSION, assistantId);
}
