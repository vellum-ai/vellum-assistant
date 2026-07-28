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
  const pendingInputEmitByToolUseId = new Map<
    string,
    {
      timeout: ReturnType<typeof setTimeout>;
      toolName: string;
      accumulatedJson: string;
    }
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
      const pending = pendingInputEmitByToolUseId.get(toolUseId);
      if (pending) {
        pending.toolName = toolName;
        pending.accumulatedJson = accumulatedJson;
        return;
      }
      const delay = INPUT_JSON_DELTA_EMIT_INTERVAL_MS - (now - last.emittedAt);
      const timeout = setTimeout(() => {
        const latest = pendingInputEmitByToolUseId.get(toolUseId);
        if (!latest) return;
        pendingInputEmitByToolUseId.delete(toolUseId);
        lastInputEmitByToolUseId.set(toolUseId, {
          emittedAt: Date.now(),
          accumulatedJson: latest.accumulatedJson,
        });
        onEvent({
          type: "input_json_delta",
          toolName: latest.toolName,
          toolUseId,
          accumulatedJson: latest.accumulatedJson,
        });
      }, delay);
      timeout.unref?.();
      pendingInputEmitByToolUseId.set(toolUseId, {
        timeout,
        toolName,
        accumulatedJson,
      });
      return;
    }

    const pending = pendingInputEmitByToolUseId.get(toolUseId);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingInputEmitByToolUseId.delete(toolUseId);
    }
    lastInputEmitByToolUseId.set(toolUseId, {
      emittedAt: now,
      accumulatedJson,
    });
    onEvent({ type: "input_json_delta", toolName, toolUseId, accumulatedJson });
  };

  return { emitPreviewStart, emitInputJsonDelta };
}
