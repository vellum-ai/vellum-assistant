import type { ProviderEvent } from "./types.js";

const INPUT_JSON_DELTA_EMIT_INTERVAL_MS = 150;

export function createToolProgressEmitter(
  onEvent: ((event: ProviderEvent) => void) | undefined,
): {
  emitPreviewStart: (toolUseId: string, toolName: string) => void;
  emitInputJsonDelta: (
    toolUseId: string,
    toolName: string,
    accumulatedJson: string,
    opts?: { force?: boolean },
  ) => void;
} {
  const previewedToolUseIds = new Set<string>();
  const lastInputEmitByToolUseId = new Map<
    string,
    { emittedAt: number; accumulatedJson: string }
  >();

  const emitPreviewStart = (toolUseId: string, toolName: string): void => {
    if (!onEvent || !toolUseId || !toolName) return;
    if (previewedToolUseIds.has(toolUseId)) return;
    previewedToolUseIds.add(toolUseId);
    onEvent({ type: "tool_use_preview_start", toolUseId, toolName });
  };

  const emitInputJsonDelta = (
    toolUseId: string,
    toolName: string,
    accumulatedJson: string,
    opts?: { force?: boolean },
  ): void => {
    if (!onEvent || !toolUseId || !toolName || !accumulatedJson) return;
    emitPreviewStart(toolUseId, toolName);

    const last = lastInputEmitByToolUseId.get(toolUseId);
    if (last?.accumulatedJson === accumulatedJson) return;

    const now = Date.now();
    if (
      !opts?.force &&
      last &&
      now - last.emittedAt < INPUT_JSON_DELTA_EMIT_INTERVAL_MS
    ) {
      return;
    }

    lastInputEmitByToolUseId.set(toolUseId, {
      emittedAt: now,
      accumulatedJson,
    });
    onEvent({ type: "input_json_delta", toolName, toolUseId, accumulatedJson });
  };

  return { emitPreviewStart, emitInputJsonDelta };
}
