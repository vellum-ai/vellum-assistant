import { describe, expect, test } from "bun:test";

import { createToolProgressEmitter } from "./tool-progress-events.js";
import type { ProviderEvent } from "./types.js";

describe("createToolProgressEmitter", () => {
  test("flushes the latest throttled argument progress after activity pauses", async () => {
    const events: ProviderEvent[] = [];
    const progress = createToolProgressEmitter((event) => events.push(event));

    progress.emitInputJsonDelta("call-1", "app_create", '{"a":1}');
    progress.emitInputJsonDelta("call-1", "app_create", '{"a":12}');

    expect(events).toEqual([
      {
        type: "tool_use_preview_start",
        toolUseId: "call-1",
        toolName: "app_create",
      },
      {
        type: "input_json_delta",
        toolUseId: "call-1",
        toolName: "app_create",
        accumulatedJson: '{"a":1}',
      },
    ]);

    await Bun.sleep(180);

    expect(events).toEqual([
      {
        type: "tool_use_preview_start",
        toolUseId: "call-1",
        toolName: "app_create",
      },
      {
        type: "input_json_delta",
        toolUseId: "call-1",
        toolName: "app_create",
        accumulatedJson: '{"a":1}',
      },
      {
        type: "input_json_delta",
        toolUseId: "call-1",
        toolName: "app_create",
        accumulatedJson: '{"a":12}',
      },
    ]);
  });
});
