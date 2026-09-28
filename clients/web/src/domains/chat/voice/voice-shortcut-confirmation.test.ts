import { afterEach, describe, expect, test } from "bun:test";
import { COMPANION_VOICE_START_CONFIRMATION } from "@vellumai/ipc-contract";

import {
  currentCompanionPopover,
  useCompanionPopoverStore,
} from "@/domains/chat/companion-popover";
import { answerCompanionPopover } from "@/domains/chat/companion-popover-actions";
import { getDeviceBool, setDeviceBool } from "@/utils/device-settings";

import {
  confirmVoiceShortcutStart,
  withdrawVoiceShortcutConfirmation,
} from "./voice-shortcut-confirmation";

const COPY = {
  title: "Start a voice chat?",
  detail: "Your microphone stays on until you end the call.",
  cancel: "Cancel",
  always: "Always start",
  confirm: "Start voice chat",
};

/** Ask, and wait until the card is on the companion. */
async function ask(): Promise<{ pending: Promise<boolean> }> {
  const pending = confirmVoiceShortcutStart(COPY);
  while (useCompanionPopoverStore.getState().voiceStartConfirmation === null) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return { pending };
}

const press = (actionId: string) =>
  answerCompanionPopover(COMPANION_VOICE_START_CONFIRMATION, {
    kind: "action",
    actionId,
  });

afterEach(() => {
  withdrawVoiceShortcutConfirmation();
  localStorage.clear();
});

describe("the voice key's start confirmation", () => {
  test("asks on the companion with Always start as the main action", async () => {
    const { pending } = await ask();
    const popover = currentCompanionPopover();
    expect(popover?.id).toBe(COMPANION_VOICE_START_CONFIRMATION);
    expect(
      popover?.kind === "card" &&
        popover.actions.map(({ id, style }) => [id, style]),
    ).toEqual([
      ["cancel", "tertiary"],
      ["start", "secondary"],
      ["always", "primary"],
    ]);
    await press("start");
    expect(await pending).toBe(true);
    expect(getDeviceBool("voiceStartConfirmationSkipped", false)).toBe(false);
  });

  test("an answered card stays published until withdrawn", async () => {
    const { pending } = await ask();
    await press("start");
    await pending;
    expect(currentCompanionPopover()?.id).toBe(
      COMPANION_VOICE_START_CONFIRMATION,
    );
    withdrawVoiceShortcutConfirmation();
    expect(useCompanionPopoverStore.getState().voiceStartConfirmation).toBe(
      null,
    );
  });

  test.each(["cancel", null])("%s never starts or remembers", async (id) => {
    const { pending } = await ask();
    if (id === null) {
      await answerCompanionPopover(COMPANION_VOICE_START_CONFIRMATION, {
        kind: "dismiss",
      });
    } else {
      await press(id);
    }
    expect(await pending).toBe(false);
    expect(getDeviceBool("voiceStartConfirmationSkipped", false)).toBe(false);
  });

  test("Always start starts and stops asking", async () => {
    const { pending } = await ask();
    await press("always");
    expect(await pending).toBe(true);
    expect(getDeviceBool("voiceStartConfirmationSkipped", false)).toBe(true);
  });

  test("an opted-out user is not asked", async () => {
    setDeviceBool("voiceStartConfirmationSkipped", true);
    expect(await confirmVoiceShortcutStart(COPY)).toBe(true);
    expect(useCompanionPopoverStore.getState().voiceStartConfirmation).toBe(
      null,
    );
  });

  test("withdrawing an unanswered card declines it", async () => {
    const { pending } = await ask();
    withdrawVoiceShortcutConfirmation();
    expect(await pending).toBe(false);
    expect(currentCompanionPopover()).toBeUndefined();
  });
});
