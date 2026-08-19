import { afterEach, expect, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

import { useNativePushToTalkRegistration } from "@/domains/chat/voice/use-native-push-to-talk-registration";
import {
  CTRL_PTT_ACTIVATOR,
  LS_PTT_ACTIVATION_KEY,
  serializeActivator,
} from "@/utils/ptt-activator";
import { setLocalSetting } from "@/utils/local-settings";

afterEach(() => {
  cleanup();
  delete window.vellum;
  localStorage.clear();
});

test("retries a prior chord after a failed binding change", async () => {
  const registrations: unknown[] = [];
  window.vellum = {
    platform: "electron",
    helper: {
      hotkey: {
        setPushToTalk: async (activator) => {
          registrations.push(activator);
          if (
            activator?.kind === "modifierOnly" &&
            activator.modifiers.includes("option")
          ) {
            return { ok: false, reason: "unavailable" };
          }
          return { ok: true, enabled: activator !== null };
        },
        onEvent: () => () => undefined,
      },
    },
  } as unknown as typeof window.vellum;
  localStorage.setItem(
    LS_PTT_ACTIVATION_KEY,
    serializeActivator(CTRL_PTT_ACTIVATOR),
  );
  renderHook(() => useNativePushToTalkRegistration());
  await waitFor(() => expect(registrations).toHaveLength(1));

  setLocalSetting(
    LS_PTT_ACTIVATION_KEY,
    serializeActivator({ kind: "modifierOnly", modifiers: ["option"] }),
  );
  await waitFor(() => expect(registrations).toHaveLength(2));

  setLocalSetting(
    LS_PTT_ACTIVATION_KEY,
    serializeActivator(CTRL_PTT_ACTIVATOR),
  );
  await waitFor(() => expect(registrations).toHaveLength(3));
  expect(registrations[2]).toEqual(CTRL_PTT_ACTIVATOR);
});
