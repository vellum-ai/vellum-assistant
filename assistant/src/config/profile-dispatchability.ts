export type DispatchableProfileEntry = {
  provider?: unknown;
  model?: unknown;
  mix?: unknown;
};

export function isDispatchableProfile(
  entry: DispatchableProfileEntry,
): boolean {
  return entry.provider != null || entry.model != null || entry.mix != null;
}
