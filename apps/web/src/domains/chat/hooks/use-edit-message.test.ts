import { describe, expect, test } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { useEditMessage } from "./use-edit-message";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { textBody } from "@/domains/chat/utils/message-test-helpers";

function makeMsg(overrides: Partial<DisplayMessage> & { id: string; role: DisplayMessage["role"]; content: string }): DisplayMessage {
  const { content, ...rest } = overrides;
  return { ...rest, ...textBody(content) };
}

describe("useEditMessage", () => {
  test("startEditing returns content of last confirmed user message", () => {
    const messages: DisplayMessage[] = [
      makeMsg({ id: "1", role: "user", content: "first" }),
      makeMsg({ id: "2", role: "assistant", content: "reply" }),
      makeMsg({ id: "3", role: "user", content: "second" }),
      makeMsg({ id: "4", role: "assistant", content: "reply2" }),
    ];
    const { result } = renderHook(() => useEditMessage(messages));

    let content: string | null | undefined;
    act(() => {
      content = result.current.startEditing();
    });

    expect(content).toBe("second");
    expect(result.current.isEditing).toBe(true);
    expect(result.current.editingMessageId).toBe("3");
  });

  test("startEditing skips queued and optimistic messages", () => {
    const messages: DisplayMessage[] = [
      makeMsg({ id: "1", role: "user", content: "confirmed" }),
      makeMsg({ id: "2", role: "assistant", content: "reply" }),
      makeMsg({ id: "3", role: "user", content: "queued", queueStatus: "queued" }),
      makeMsg({ id: "4", role: "user", content: "optimistic", isOptimistic: true }),
    ];
    const { result } = renderHook(() => useEditMessage(messages));

    let content: string | null | undefined;
    act(() => {
      content = result.current.startEditing();
    });

    expect(content).toBe("confirmed");
    expect(result.current.editingMessageId).toBe("1");
  });

  test("startEditing returns null when no user messages exist", () => {
    const messages: DisplayMessage[] = [
      makeMsg({ id: "1", role: "assistant", content: "hello" }),
    ];
    const { result } = renderHook(() => useEditMessage(messages));

    let content: string | null | undefined;
    act(() => {
      content = result.current.startEditing();
    });

    expect(content).toBeNull();
    expect(result.current.isEditing).toBe(false);
  });

  test("cancelEditing clears edit state", () => {
    const messages: DisplayMessage[] = [
      makeMsg({ id: "1", role: "user", content: "hello" }),
    ];
    const { result } = renderHook(() => useEditMessage(messages));

    act(() => {
      result.current.startEditing();
    });
    expect(result.current.isEditing).toBe(true);

    act(() => {
      result.current.cancelEditing();
    });
    expect(result.current.isEditing).toBe(false);
    expect(result.current.editingMessageId).toBeNull();
  });
});
