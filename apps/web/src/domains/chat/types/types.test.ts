import { describe, expect, test } from "bun:test";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { toolCallStatusWireFields } from "@/domains/chat/utils/message-test-helpers";
import {
  isSurfaceInteractive,
  isSurfaceToolCallComplete,
  type Surface,
} from "@/domains/chat/types/types";

function makeSurface(overrides: Partial<Surface> = {}): Surface {
  return {
    surfaceId: "test-surface",
    surfaceType: "card",
    data: {},
    ...overrides,
  };
}

function makeToolCall(
  overrides: Partial<ChatMessageToolCall> & {
    status?: "running" | "completed" | "error";
  } = {},
): ChatMessageToolCall {
  const { status = "completed", ...rest } = overrides;
  return {
    id: "tc-1",
    name: "ui_show",
    input: {},
    ...toolCallStatusWireFields(status),
    ...rest,
  };
}

describe("isSurfaceInteractive", () => {
  test("card without actions is not interactive", () => {
    expect(isSurfaceInteractive(makeSurface({ surfaceType: "card" }))).toBe(
      false,
    );
  });

  test("card with actions is interactive", () => {
    expect(
      isSurfaceInteractive(
        makeSurface({
          surfaceType: "card",
          actions: [{ id: "ok", label: "OK" }],
        }),
      ),
    ).toBe(true);
  });

  test("table without actions is not interactive", () => {
    expect(isSurfaceInteractive(makeSurface({ surfaceType: "table" }))).toBe(
      false,
    );
  });

  test("table with actions is interactive", () => {
    expect(
      isSurfaceInteractive(
        makeSurface({
          surfaceType: "table",
          actions: [{ id: "select", label: "Select" }],
        }),
      ),
    ).toBe(true);
  });

  test("list without actions is not interactive", () => {
    expect(isSurfaceInteractive(makeSurface({ surfaceType: "list" }))).toBe(
      false,
    );
  });

  test("list with actions is interactive", () => {
    expect(
      isSurfaceInteractive(
        makeSurface({
          surfaceType: "list",
          actions: [{ id: "pick", label: "Pick" }],
        }),
      ),
    ).toBe(true);
  });

  test("form is always interactive", () => {
    expect(isSurfaceInteractive(makeSurface({ surfaceType: "form" }))).toBe(
      true,
    );
  });

  test("confirmation is always interactive", () => {
    expect(
      isSurfaceInteractive(makeSurface({ surfaceType: "confirmation" })),
    ).toBe(true);
  });

  test("file_upload is always interactive", () => {
    expect(
      isSurfaceInteractive(makeSurface({ surfaceType: "file_upload" })),
    ).toBe(true);
  });

  test("choice is always interactive", () => {
    expect(isSurfaceInteractive(makeSurface({ surfaceType: "choice" }))).toBe(
      true,
    );
  });

  test("copy_block is display-only without actions", () => {
    expect(
      isSurfaceInteractive(makeSurface({ surfaceType: "copy_block" })),
    ).toBe(false);
  });

  test("work_result without actions is not interactive", () => {
    expect(
      isSurfaceInteractive(makeSurface({ surfaceType: "work_result" })),
    ).toBe(false);
  });

  test("work_result with actions is interactive", () => {
    expect(
      isSurfaceInteractive(
        makeSurface({
          surfaceType: "work_result",
          actions: [{ id: "review", label: "Review" }],
        }),
      ),
    ).toBe(true);
  });

  test("dynamic_page without actions is not interactive", () => {
    expect(
      isSurfaceInteractive(makeSurface({ surfaceType: "dynamic_page" })),
    ).toBe(false);
  });

  test("dynamic_page with actions is interactive", () => {
    expect(
      isSurfaceInteractive(
        makeSurface({
          surfaceType: "dynamic_page",
          actions: [{ id: "close", label: "Close" }],
        }),
      ),
    ).toBe(true);
  });

  test("card with empty actions array is not interactive", () => {
    expect(
      isSurfaceInteractive(makeSurface({ surfaceType: "card", actions: [] })),
    ).toBe(false);
  });
});

describe("isSurfaceToolCallComplete", () => {
  test("surface without a linked tool call is complete", () => {
    expect(isSurfaceToolCallComplete(makeSurface(), [makeToolCall()])).toBe(
      true,
    );
  });

  test("complete when the linked tool call has completed", () => {
    expect(
      isSurfaceToolCallComplete(makeSurface({ toolCallId: "tc-1" }), [
        makeToolCall({ id: "tc-1", status: "completed" }),
      ]),
    ).toBe(true);
  });

  test("incomplete while the linked tool call is still running", () => {
    expect(
      isSurfaceToolCallComplete(makeSurface({ toolCallId: "tc-1" }), [
        makeToolCall({ id: "tc-1", status: "running" }),
      ]),
    ).toBe(false);
  });

  test("incomplete when the linked tool call errored", () => {
    expect(
      isSurfaceToolCallComplete(makeSurface({ toolCallId: "tc-1" }), [
        makeToolCall({ id: "tc-1", status: "error" }),
      ]),
    ).toBe(false);
  });

  test("complete when the linked tool call is not present in the message", () => {
    expect(
      isSurfaceToolCallComplete(makeSurface({ toolCallId: "tc-missing" }), [
        makeToolCall({ id: "tc-1", status: "running" }),
      ]),
    ).toBe(true);
  });

  test("complete when the message has no tool calls", () => {
    expect(
      isSurfaceToolCallComplete(makeSurface({ toolCallId: "tc-1" }), undefined),
    ).toBe(true);
  });

  test("falls back to the latest surface tool call when the surface has no link", () => {
    expect(
      isSurfaceToolCallComplete(makeSurface(), [
        makeToolCall({ id: "tc-1", name: "app_create", status: "running" }),
      ]),
    ).toBe(false);
  });

  test("fallback picks the latest surface tool call, not an earlier completed one", () => {
    expect(
      isSurfaceToolCallComplete(makeSurface(), [
        makeToolCall({ id: "tc-1", name: "ui_show", status: "completed" }),
        makeToolCall({ id: "tc-2", name: "app_create", status: "running" }),
      ]),
    ).toBe(false);
  });

  test("fallback ignores non-surface tool calls", () => {
    expect(
      isSurfaceToolCallComplete(makeSurface(), [
        makeToolCall({ id: "tc-1", name: "bash", status: "running" }),
      ]),
    ).toBe(true);
  });
});
