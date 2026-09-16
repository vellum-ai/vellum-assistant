import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

/** The assistant the voice queries were last handed. */
let voicesAskedFor: (string | null)[] = [];
let catalogAvailable = true;

mock.module("@/components/speech/use-managed-voice-selection", () => ({
  useManagedVoiceSelection: (assistantId: string | null) => {
    voicesAskedFor.push(assistantId);
    return {
      available: assistantId !== null && catalogAvailable,
      isByok: false,
      settled: true,
      voices: [],
      currentModel: "",
      defaultModel: "",
      selectModel: () => undefined,
      selecting: false,
    };
  },
}));

const { useCompanionPickers } =
  await import("@/domains/chat/hooks/use-companion-pickers");
const { useCompanionPopoverStore } =
  await import("@/domains/chat/companion-popover");
const { useLiveVoiceStore } =
  await import("@/domains/chat/voice/live-voice/live-voice-store");
const { useResolvedAssistantsStore } =
  await import("@/stores/resolved-assistants-store");

beforeEach(() => {
  voicesAskedFor = [];
  catalogAvailable = true;
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
  useLiveVoiceStore.setState({ state: "idle" });
  useCompanionPopoverStore.setState({
    openPicker: null,
    microphones: null,
    voices: null,
    voicesPickable: false,
  });
});

afterEach(() => {
  cleanup();
});

describe("useCompanionPickers", () => {
  /** Welcome and onboarding render the root layout with no assistant. */
  test("runs with no assistant selected", () => {
    expect(() => renderHook(() => useCompanionPickers())).not.toThrow();
    expect(voicesAskedFor.every((id) => id === null)).toBe(true);
  });

  test("asks for voices only during a call, and says whether there are any", () => {
    useResolvedAssistantsStore.setState({ activeAssistantId: "asst-1" });
    renderHook(() => useCompanionPickers());
    expect(voicesAskedFor.at(-1)).toBeNull();
    expect(useCompanionPopoverStore.getState().voicesPickable).toBe(false);

    act(() => {
      useLiveVoiceStore.setState({ state: "listening" });
    });
    expect(voicesAskedFor.at(-1)).toBe("asst-1");
    expect(useCompanionPopoverStore.getState().voicesPickable).toBe(true);
  });

  test("offers no voices for an assistant without a catalog", () => {
    catalogAvailable = false;
    useResolvedAssistantsStore.setState({ activeAssistantId: "asst-1" });
    useLiveVoiceStore.setState({ state: "listening" });

    renderHook(() => useCompanionPickers());

    expect(useCompanionPopoverStore.getState().voicesPickable).toBe(false);
  });

  test("closes an open picker when the call ends", () => {
    useLiveVoiceStore.setState({ state: "listening" });
    useCompanionPopoverStore.setState({ openPicker: "microphones" });
    renderHook(() => useCompanionPickers());

    act(() => {
      useLiveVoiceStore.setState({ state: "idle" });
    });

    expect(useCompanionPopoverStore.getState().openPicker).toBeNull();
  });
});
