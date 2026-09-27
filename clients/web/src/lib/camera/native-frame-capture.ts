/** Two preview frames collected natively before JPEG encoding. */
export interface NativeFramePair {
  readonly value: string;
  readonly primer: string;
  /** Monotonic offsets from the start of the native capture request. */
  readonly firstCapturedAfterMs: number;
  readonly secondCapturedAfterMs: number;
}

/** Older shells provide one JPEG per bridge call. */
export type NativeFrameCapture = string | NativeFramePair;

export function isNativeFramePair(value: unknown): value is NativeFramePair {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const pair = value as Partial<NativeFramePair>;
  return (
    typeof pair.value === "string" &&
    pair.value.length > 0 &&
    typeof pair.primer === "string" &&
    pair.primer.length > 0 &&
    typeof pair.firstCapturedAfterMs === "number" &&
    Number.isFinite(pair.firstCapturedAfterMs) &&
    pair.firstCapturedAfterMs >= 0 &&
    typeof pair.secondCapturedAfterMs === "number" &&
    Number.isFinite(pair.secondCapturedAfterMs) &&
    pair.secondCapturedAfterMs > pair.firstCapturedAfterMs
  );
}
